/**
 * IcyReach Cloud Backend v4
 * Full OAuth2 for Gmail + Outlook
 * SMTP for Gmail app passwords (fallback)
 */

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3456;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fbmsfqzazwvsqndnzler.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://icyreach.netlify.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://icyreach-backend.onrender.com';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '706431056488-v8oaqs1k3jusc5mdklopnknv6fvvlmcl.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
const GOOGLE_REDIRECT = BACKEND_URL + '/auth/gmail/callback';

const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '9d687567-0413-4ecc-a68b-db29dd416d4f';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '2MV8Q~fi-NagSJ12Spg45wEyGETL1HoznIjzGb9y';
const MS_REDIRECT = BACKEND_URL + '/auth/outlook/callback';
const MS_SCOPES = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

let emailQueue = [];
const sb = SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

app.get('/', (req, res) => res.json({ status: 'ok', version: '4.0.0', name: 'IcyReach Cloud Backend', oauth: { gmail: true, outlook: true } }));

// ── Gmail OAuth2 ──────────────────────────────────────────────────────────────
app.get('/auth/gmail', (req, res) => {
  const { userId, displayName, dailyLimit } = req.query;
  const state = Buffer.from(JSON.stringify({ userId, displayName, dailyLimit: dailyLimit || 500 })).toString('base64');
  const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT, response_type: 'code', scope: 'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email', access_type: 'offline', prompt: 'consent', state });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '?oauth_error=gmail_' + (error || 'no_code'));
  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' }) });
    const tokens = await tokenResp.json();
    if (!tokens.access_token) throw new Error('No access token');
    const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const user = await userResp.json();
    const email = user.email;
    if (sb) {
      const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      const { data: existing } = await sb.from('email_accounts').select('id,oauth_refresh_token').eq('user_id', stateData.userId).eq('email', email).maybeSingle();
      if (existing) {
        await sb.from('email_accounts').update({ oauth_provider: 'gmail', oauth_access_token: tokens.access_token, oauth_refresh_token: tokens.refresh_token || existing.oauth_refresh_token, oauth_token_expiry: expiry, status: 'active' }).eq('id', existing.id);
      } else {
        await sb.from('email_accounts').insert({ user_id: stateData.userId, email, oauth_provider: 'gmail', oauth_access_token: tokens.access_token, oauth_refresh_token: tokens.refresh_token || '', oauth_token_expiry: expiry, oauth_email: email, display_name: stateData.displayName || email.split('@')[0], daily_limit: parseInt(stateData.dailyLimit) || 500, app_password: '', status: 'active', sent_today: 0, total_sent: 0 });
      }
    }
    log('GMAIL_OAUTH email=' + email);
    res.redirect(FRONTEND_URL + '?oauth_success=gmail&email=' + encodeURIComponent(email));
  } catch (err) {
    log('GMAIL_OAUTH_ERROR: ' + err.message);
    res.redirect(FRONTEND_URL + '?oauth_error=gmail_callback_failed');
  }
});

// ── Outlook OAuth2 ────────────────────────────────────────────────────────────
app.get('/auth/outlook', (req, res) => {
  const { userId, displayName, dailyLimit } = req.query;
  const state = Buffer.from(JSON.stringify({ userId, displayName, dailyLimit: dailyLimit || 500 })).toString('base64');
  const params = new URLSearchParams({ client_id: MS_CLIENT_ID, redirect_uri: MS_REDIRECT, response_type: 'code', scope: MS_SCOPES, state, prompt: 'select_account' });
  res.redirect('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + params);
});

app.get('/auth/outlook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '?oauth_error=outlook_' + (error || 'no_code'));
  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, redirect_uri: MS_REDIRECT, grant_type: 'authorization_code', scope: MS_SCOPES }) });
    const tokens = await tokenResp.json();
    if (!tokens.access_token) throw new Error('No access token: ' + JSON.stringify(tokens));
    const userResp = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const user = await userResp.json();
    const email = user.mail || user.userPrincipalName;
    if (sb) {
      const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      const { data: existing } = await sb.from('email_accounts').select('id').eq('user_id', stateData.userId).eq('email', email).maybeSingle();
      if (existing) {
        await sb.from('email_accounts').update({ oauth_provider: 'outlook', oauth_access_token: tokens.access_token, oauth_refresh_token: tokens.refresh_token || '', oauth_token_expiry: expiry, status: 'active' }).eq('id', existing.id);
      } else {
        await sb.from('email_accounts').insert({ user_id: stateData.userId, email, oauth_provider: 'outlook', oauth_access_token: tokens.access_token, oauth_refresh_token: tokens.refresh_token || '', oauth_token_expiry: expiry, oauth_email: email, display_name: stateData.displayName || (user.displayName || email.split('@')[0]), daily_limit: parseInt(stateData.dailyLimit) || 500, app_password: '', status: 'active', sent_today: 0, total_sent: 0 });
      }
    }
    log('OUTLOOK_OAUTH email=' + email);
    res.redirect(FRONTEND_URL + '?oauth_success=outlook&email=' + encodeURIComponent(email));
  } catch (err) {
    log('OUTLOOK_OAUTH_ERROR: ' + err.message);
    res.redirect(FRONTEND_URL + '?oauth_error=outlook_callback_failed');
  }
});

// ── Token Refresh ─────────────────────────────────────────────────────────────
async function getValidToken(account) {
  if (!account.oauth_access_token) throw new Error('No OAuth token');
  const expiry = account.oauth_token_expiry ? new Date(account.oauth_token_expiry) : new Date(0);
  if (expiry > new Date(Date.now() + 5 * 60 * 1000)) return account.oauth_access_token;
  if (account.oauth_provider === 'gmail') {
    const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: account.oauth_refresh_token, grant_type: 'refresh_token' }) });
    const data = await resp.json();
    if (!data.access_token) throw new Error('Gmail refresh failed');
    const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    if (sb) await sb.from('email_accounts').update({ oauth_access_token: data.access_token, oauth_token_expiry: newExpiry }).eq('id', account.id);
    return data.access_token;
  }
  if (account.oauth_provider === 'outlook') {
    const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, refresh_token: account.oauth_refresh_token, grant_type: 'refresh_token', scope: MS_SCOPES }) });
    const data = await resp.json();
    if (!data.access_token) throw new Error('Outlook refresh failed');
    const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    if (sb) await sb.from('email_accounts').update({ oauth_access_token: data.access_token, oauth_refresh_token: data.refresh_token || account.oauth_refresh_token, oauth_token_expiry: newExpiry }).eq('id', account.id);
    return data.access_token;
  }
  throw new Error('Unknown provider');
}

async function sendViaGmail(account, to, subject, body, replyTo) {
  const token = await getValidToken(account);
  const from = account.display_name ? '"' + account.display_name + '" <' + account.email + '>' : account.email;
  const lines = ['From: ' + from, 'To: ' + to, 'Subject: ' + subject, replyTo ? 'Reply-To: ' + replyTo : '', 'Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0', '', body].filter(Boolean);
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Gmail API: ' + JSON.stringify(data));
  return data.id;
}

async function sendViaOutlook(account, to, subject, body, replyTo) {
  const token = await getValidToken(account);
  const message = { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }], from: { emailAddress: { address: account.email, name: account.display_name || account.email } } };
  if (replyTo) message.replyTo = [{ emailAddress: { address: replyTo } }];
  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) });
  if (!resp.ok) { const err = await resp.json(); throw new Error('Outlook API: ' + JSON.stringify(err)); }
}

// ── /send ─────────────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { fromEmail, appPassword, displayName, toEmail, subject, body, replyTo, accountId } = req.body;
  if (!fromEmail || !toEmail || !subject || !body) return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    if (accountId && sb) {
      const { data: account } = await sb.from('email_accounts').select('*').eq('id', accountId).maybeSingle();
      if (account?.oauth_provider === 'gmail') {
        const msgId = await sendViaGmail(account, toEmail, subject, body, replyTo);
        log('SENT_GMAIL_OAUTH to=' + toEmail);
        return res.json({ success: true, messageId: msgId, method: 'gmail_oauth' });
      }
      if (account?.oauth_provider === 'outlook') {
        await sendViaOutlook(account, toEmail, subject, body, replyTo);
        log('SENT_OUTLOOK_OAUTH to=' + toEmail);
        return res.json({ success: true, messageId: 'outlook_sent', method: 'outlook_oauth' });
      }
    }
    if (!appPassword) return res.status(400).json({ success: false, error: 'No OAuth token and no app password' });
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: fromEmail, pass: appPassword.replace(/\s/g,'') } });
    const info = await transporter.sendMail({ from: displayName ? '"' + displayName + '" <' + fromEmail + '>' : fromEmail, to: toEmail, subject, text: body, html: body.replace(/\n/g,'<br>'), ...(replyTo && { replyTo }) });
    log('SENT_SMTP to=' + toEmail);
    res.json({ success: true, messageId: info.messageId, method: 'smtp' });
  } catch (err) {
    log('SEND FAILED to=' + toEmail + ' error=' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /test ─────────────────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { fromEmail, appPassword, accountId } = req.body;
  try {
    if (accountId && sb) {
      const { data: account } = await sb.from('email_accounts').select('*').eq('id', accountId).maybeSingle();
      if (account?.oauth_provider === 'gmail') {
        const token = await getValidToken(account);
        const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
        const u = await r.json();
        return res.json({ success: true, message: 'Gmail OAuth verified for ' + u.email });
      }
      if (account?.oauth_provider === 'outlook') {
        const token = await getValidToken(account);
        const r = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer ' + token } });
        const u = await r.json();
        return res.json({ success: true, message: 'Outlook OAuth verified for ' + (u.mail || u.userPrincipalName) });
      }
    }
    if (!fromEmail || !appPassword) return res.status(400).json({ success: false, error: 'Credentials required' });
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: fromEmail, pass: appPassword.replace(/\s/g,'') } });
    await t.verify();
    res.json({ success: true, message: 'SMTP verified for ' + fromEmail });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── /queue ────────────────────────────────────────────────────────────────────
app.post('/queue', (req, res) => {
  const job = { id: Math.random().toString(36).slice(2,10), ...req.body, status: 'pending', attempts: 0, maxAttempts: 3, queuedAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() };
  emailQueue.push(job);
  res.json({ success: true, jobId: job.id });
});
app.get('/queue', (req, res) => res.json({ total: emailQueue.length, pending: emailQueue.filter(j=>j.status==='pending').length, sent: emailQueue.filter(j=>j.status==='sent').length, failed: emailQueue.filter(j=>j.status==='failed').length, jobs: emailQueue.slice(-50) }));
app.delete('/queue/:id', (req, res) => { emailQueue = emailQueue.filter(j=>j.id!==req.params.id); res.json({ success: true }); });

// ── /scrape ───────────────────────────────────────────────────────────────────
function fetchUrl(url, timeout=12000) {
  return new Promise((resolve,reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol==='https:' ? https : http;
      const req = lib.request({ hostname:u.hostname, path:u.pathname+u.search, method:'GET', timeout, headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept':'text/html,*/*', 'Accept-Encoding':'identity', 'Connection':'close' } }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) { const r = res.headers.location.startsWith('http') ? res.headers.location : u.protocol+'//'+u.hostname+res.headers.location; fetchUrl(r,timeout).then(resolve).catch(reject); return; }
        let data=''; res.setEncoding('utf8');
        res.on('data',chunk=>{data+=chunk;if(data.length>600000)req.destroy();});
        res.on('end',()=>resolve(data)); res.on('error',reject);
      });
      req.on('error',reject); req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));}); req.end();
    } catch(e){reject(e);}
  });
}
function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<footer[\s\S]*?<\/footer>/gi,'').replace(/<header[\s\S]*?<\/header>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/\s{3,}/g,'\n\n').trim().slice(0,4000);
}
app.post('/scrape', async (req, res) => {
  let { url, firecrawlKeys=[] } = req.body;
  if (!url) return res.status(400).json({ success:false, error:'url required' });
  if (!url.startsWith('http')) url='https://'+url;
  for (const key of firecrawlKeys) {
    try {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
      const resp=await fetch('https://api.firecrawl.dev/v1/scrape',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({url,formats:['markdown'],onlyMainContent:true}),signal:controller.signal});
      clearTimeout(timer); const data=await resp.json();
      if(data.success&&data.data?.markdown) return res.json({success:true,text:data.data.markdown.slice(0,4000),source:'firecrawl'});
      if(resp.status===429||(data.error||'').toLowerCase().includes('credit')) continue;
    } catch(e){continue;}
  }
  try { const html=await fetchUrl(url); const text=htmlToText(html); if(text.length>50) return res.json({success:true,text,source:'direct'}); } catch(e){}
  res.json({success:false,text:'Could not scrape '+url,source:'failed'});
});

// ── /research ─────────────────────────────────────────────────────────────────
app.post('/research', async (req, res) => {
  const { prospect, firecrawlKeys=[], groqKeys=[], templateBody='', templateSubject='' } = req.body;
  if (!prospect) return res.status(400).json({success:false,error:'prospect required'});
  if (!groqKeys.length) return res.status(400).json({success:false,error:'At least one Groq key required'});
  const url = prospect.website||prospect.gbp_url||'';
  let siteText='';
  if (url) {
    const cleanUrl=url.startsWith('http')?url:'https://'+url;
    for (const key of firecrawlKeys) {
      try {
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
        const resp=await fetch('https://api.firecrawl.dev/v1/scrape',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({url:cleanUrl,formats:['markdown'],onlyMainContent:true}),signal:controller.signal});
        clearTimeout(timer); const data=await resp.json();
        if(data.success&&data.data?.markdown){siteText=data.data.markdown.slice(0,4000);break;}
        if(resp.status===429||(data.error||'').toLowerCase().includes('credit')) continue;
      } catch(e){continue;}
    }
    if(!siteText){try{const html=await fetchUrl(cleanUrl,10000);siteText=htmlToText(html);}catch(e){}}
  }
  const prompt='You are a B2B sales research expert. Return ONLY valid JSON, no markdown.\n\nProspect: '+prospect.first_name+' '+prospect.last_name+' at '+prospect.company+' ('+url+')\nIndustry: '+(prospect.industry||'unknown')+' | Location: '+(prospect.location||'unknown')+'\nWebsite: '+(siteText||'No content')+'\n\nReturn: {"summary":"...","services":"...","targetCustomers":"...","brandTone":"...","painPoints":"...","recentNews":"...","companySize":"...","personalizedLine":"1-2 sentence opener referencing something SPECIFIC. Never say I came across your website.","suggestedSubject":"Short subject under 8 words"}';
  for (const key of groqKeys) {
    try {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),30000);
      const resp=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'llama-3.1-8b-instant',messages:[{role:'user',content:prompt}],max_tokens:900,temperature:0.7}),signal:controller.signal});
      clearTimeout(timer); const data=await resp.json();
      if(data.choices?.[0]?.message?.content){
        const raw=data.choices[0].message.content.trim();
        let research={};
        try{research=JSON.parse(raw);}catch{const m=raw.match(/\{[\s\S]*\}/);if(m)try{research=JSON.parse(m[0]);}catch{research={personalizedLine:raw.slice(0,200),summary:raw.slice(0,300)};}}
        let draftEmail='',draftSubject=research.suggestedSubject||'';
        if(templateBody){draftEmail=templateBody.replace(/\{\{first_name\}\}/g,prospect.first_name||'').replace(/\{\{last_name\}\}/g,prospect.last_name||'').replace(/\{\{company\}\}/g,prospect.company||'').replace(/\{\{personalized_line\}\}/g,research.personalizedLine||'').replace(/\{\{sender_name\}\}/g,'[Your Name]').replace(/\{\{unsubscribe_link\}\}/g,'[Unsubscribe]');}
        if(templateSubject&&!draftSubject){draftSubject=templateSubject.replace(/\{\{company\}\}/g,prospect.company||'').replace(/\{\{first_name\}\}/g,prospect.first_name||'');}
        return res.json({success:true,research,draftEmail,draftSubject,scraped:!!siteText});
      }
      if(resp.status===429) continue;
    } catch(e){continue;}
  }
  res.status(500).json({success:false,error:'All Groq keys exhausted'});
});

app.get('/logs', (req, res) => res.json({ logs: [] }));

// ── Queue Worker ──────────────────────────────────────────────────────────────
async function processQueue() {
  const now = new Date();
  for (const job of emailQueue) {
    if (job.status!=='pending'||new Date(job.nextAttemptAt)>now) continue;
    job.attempts++;
    try {
      let sent=false;
      if(job.accountId&&sb){
        const{data:account}=await sb.from('email_accounts').select('*').eq('id',job.accountId).maybeSingle();
        if(account?.oauth_provider==='gmail'){await sendViaGmail(account,job.toEmail,job.subject,job.body,job.replyTo);sent=true;}
        else if(account?.oauth_provider==='outlook'){await sendViaOutlook(account,job.toEmail,job.subject,job.body,job.replyTo);sent=true;}
      }
      if(!sent){const t=nodemailer.createTransport({service:'gmail',auth:{user:job.fromEmail,pass:(job.appPassword||'').replace(/\s/g,'')}});await t.sendMail({from:job.displayName?'"'+job.displayName+'" <'+job.fromEmail+'>':job.fromEmail,to:job.toEmail,subject:job.subject,text:job.body,html:job.body.replace(/\n/g,'<br>'),...(job.replyTo&&{replyTo:job.replyTo})});}
      job.status='sent';job.sentAt=new Date().toISOString();log('QUEUE_SENT id='+job.id);
    } catch(err){
      log('QUEUE_FAIL id='+job.id+' error='+err.message);
      if(job.attempts>=job.maxAttempts){job.status='failed';job.failReason=err.message;}
      else{job.nextAttemptAt=new Date(Date.now()+60*60*1000).toISOString();}
    }
  }
}
setInterval(processQueue,60*1000);processQueue();

function msUntilMidnight(){const now=new Date();const mid=new Date(now);mid.setHours(24,0,0,0);return mid-now;}
async function resetDailyCounts(){if(!sb)return;try{await sb.from('email_accounts').update({sent_today:0,last_reset_at:new Date().toISOString()}).gt('sent_today',0);log('DAILY_RESET done');}catch(e){log('DAILY_RESET ERROR: '+e.message);}}
setTimeout(()=>{resetDailyCounts();setInterval(resetDailyCounts,24*60*60*1000);},msUntilMidnight());

app.listen(PORT,()=>{
  console.log('\n🧊 IcyReach Cloud Backend v4');
  console.log('   OAuth2: Gmail ✅ Outlook ✅');
  console.log('   Running on port '+PORT+'\n');
});
