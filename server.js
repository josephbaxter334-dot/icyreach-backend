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
    // Log to history if prospectId provided
    if (req.body.prospectId && sb) {
      try {
        await sb.from('email_history').insert({
          user_id: req.body.userId || null,
          prospect_id: req.body.prospectId,
          campaign_id: req.body.campaignId || null,
          account_id: req.body.accountId || null,
          subject: subject || req.body.subject,
          body: body || req.body.body,
          step_index: req.body.stepIndex || 0,
          sent_at: new Date().toISOString(),
          opened: false
        });
      } catch(e) {}
    }
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
        if(templateBody){draftEmail=templateBody.replace(/\{\{first_name\}\}/g,prospect.first_name||'').replace(/\{\{last_name\}\}/g,prospect.last_name||'').replace(/\{\{company\}\}/g,prospect.company||'').replace(/\{\{personalized_line\}\}/g,research.personalizedLine||'').replace(/\{\{sender_name\}\}/g,'[Your Name]').replace(/\{\{unsubscribe_link\}\}/g,'');}
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


// ── Warmup Ramp — updates daily limits weekly ─────────────────────────────────
async function runWarmupRamp() {
  if (!sb) return;
  try {
    const { data: accounts } = await sb.from('email_accounts')
      .select('id,warmup_enabled,warmup_start_date,daily_limit')
      .eq('warmup_enabled', true);
    if (!accounts?.length) return;
    for (const acc of accounts) {
      if (!acc.warmup_start_date) continue;
      const days = Math.floor((Date.now() - new Date(acc.warmup_start_date)) / 86400000);
      const week = Math.floor(days / 7) + 1;
      const limits = { 1: 20, 2: 40, 3: 60, 4: 80, 5: 100 };
      const newLimit = limits[Math.min(week, 5)] || 100;
      if (newLimit !== acc.daily_limit) {
        await sb.from('email_accounts').update({ daily_limit: newLimit }).eq('id', acc.id);
        log('WARMUP_RAMP id=' + acc.id + ' week=' + week + ' limit=' + newLimit);
      }
    }
  } catch (e) { log('WARMUP_RAMP ERROR: ' + e.message); }
}

// Run warmup ramp every 24 hours
setInterval(runWarmupRamp, 24 * 60 * 60 * 1000);
runWarmupRamp();

app.listen(PORT,()=>{
  console.log('\n🧊 IcyReach Cloud Backend v4');
  console.log('   OAuth2: Gmail ✅ Outlook ✅');
  console.log('   Running on port '+PORT+'\n');
});


// ── /check-replies — IMAP reply checker ──────────────────────────────────────
app.post('/check-replies', async (req, res) => {
  const { fromEmail, appPassword, prospectEmails = [] } = req.body;
  if (!fromEmail || !appPassword) return res.status(400).json({ success: false, error: 'fromEmail and appPassword required' });

  const prospectSet = new Set(prospectEmails.map(e => e.toLowerCase()));
  const replies = [];

  try {
    const Imap = require('imap');
    const { simpleParser } = require('mailparser');

    await new Promise((resolve, reject) => {
      const imap = new Imap({
        user: fromEmail,
        password: appPassword.replace(/\s/g, ''),
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 20000,
        authTimeout: 10000
      });

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) { imap.end(); reject(err); return; }
          const since = new Date();
          since.setDate(since.getDate() - 30);
          imap.search(['ALL', ['SINCE', since]], (err, results) => {
            if (err || !results?.length) { imap.end(); resolve(); return; }
            const toFetch = results.slice(-200);
            const f = imap.fetch(toFetch, { bodies: '' });
            const pending = [];
            f.on('message', (msg) => {
              pending.push(new Promise((res2) => {
                let buffer = '';
                msg.on('body', stream => { stream.on('data', c => buffer += c); });
                msg.once('end', async () => {
                  try {
                    const parsed = await simpleParser(buffer);
                    const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
                    if (prospectSet.has(fromAddr)) {
                      replies.push({
                        from: fromAddr,
                        fromName: parsed.from?.value?.[0]?.name || '',
                        subject: parsed.subject || '',
                        body: parsed.text?.slice(0, 2000) || '',
                        preview: parsed.text?.slice(0, 120) || '',
                        date: parsed.date?.toISOString() || new Date().toISOString()
                      });
                    }
                  } catch(e) {}
                  res2();
                });
              }));
            });
            f.once('end', async () => { await Promise.all(pending); imap.end(); });
            f.once('error', () => { imap.end(); resolve(); });
          });
        });
      });
      imap.once('error', reject);
      imap.once('end', resolve);
      imap.connect();
    });

    log('CHECK_REPLIES account=' + fromEmail + ' found=' + replies.length);
    res.json({ success: true, replies, account: fromEmail });
  } catch (err) {
    log('CHECK_REPLIES FAILED account=' + fromEmail + ' error=' + err.message);
    // Return success with empty replies so frontend doesn't show error for accounts where IMAP fails
    res.json({ success: true, replies: [], account: fromEmail, error: err.message });
  }
});

// ── Sequence Runner ───────────────────────────────────────────────────────────
// Runs every 5 minutes, processes all active campaigns
async function runSequences() {
  if (!sb) { log('SEQUENCE skipped — no Supabase connection'); return; }
  try {
    // Get all active campaigns
    const { data: campaigns } = await sb.from('campaigns')
      .select('*').eq('status', 'active');
    if (!campaigns?.length) return;

    for (const campaign of campaigns) {
      await processCampaign(campaign);
    }
  } catch (e) { log('SEQUENCE ERROR: ' + e.message); }
}

async function processCampaign(campaign) {
  try {
    // Get workflow
    const { data: workflow } = await sb.from('workflows')
      .select('*').eq('id', campaign.workflow_id).single();
    if (!workflow?.steps?.length) return;

    // Get settings for this campaign's owner
    const { data: settings } = await sb.from('settings')
      .select('*').eq('id', campaign.user_id).single();

    // Check if we're in send window
    if (!isInSendWindow(campaign)) return;

    // Get prospects due for next email in this campaign
    const now = new Date().toISOString();
    const { data: prospects } = await sb.from('prospects')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('user_id', campaign.user_id)
      .eq('approved', true)
      .neq('status', 'replied')
      .neq('status', 'unsubscribed')
      .neq('status', 'completed')
      .or(`next_send_at.is.null,next_send_at.lte.${now}`);

    if (!prospects?.length) return;
    log('SEQUENCE campaign=' + campaign.name + ' prospects_due=' + prospects.length);

    for (const prospect of prospects) {
      await processProspect(prospect, campaign, workflow, settings);
    }
  } catch (e) { log('CAMPAIGN ERROR campaign=' + campaign.id + ': ' + e.message); }
}

function isInSendWindow(campaign) {
  const tz = campaign.send_tz || 'Europe/London';
  const now = new Date();
  // Get current time in campaign timezone
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const hour = localTime.getHours();
  const minute = localTime.getMinutes();
  const dayOfWeek = localTime.getDay(); // 0=Sun, 1=Mon...6=Sat

  // Check send days
  const sendDays = campaign.send_days || 'weekdays';
  if (sendDays === 'weekdays' && (dayOfWeek === 0 || dayOfWeek === 6)) return false;
  const customDays = sendDays.split(',');
  if (customDays.length > 1) {
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    if (!customDays.includes(dayNames[dayOfWeek])) return false;
  }

  // Check send window
  const winStart = campaign.send_window_start || '09:00';
  const winEnd = campaign.send_window_end || '17:00';
  const [startH, startM] = winStart.split(':').map(Number);
  const [endH, endM] = winEnd.split(':').map(Number);
  const currentMins = hour * 60 + minute;
  const startMins = startH * 60 + startM;
  const endMins = endH * 60 + endM;

  return currentMins >= startMins && currentMins <= endMins;
}

async function processProspect(prospect, campaign, workflow, settings) {
  const steps = workflow.steps || [];
  let stepIndex = prospect.current_step || 0;

  // If we've completed all steps, mark as completed
  if (stepIndex >= steps.length) {
    await sb.from('prospects').update({ status: 'completed' }).eq('id', prospect.id);
    return;
  }

  const step = steps[stepIndex];

  try {
    // Handle each step type
    if (step.type === 'condition_reply') {
      if (prospect.status === 'replied') {
        await sb.from('prospects').update({ status: 'completed', current_step: steps.length }).eq('id', prospect.id);
        return;
      }
      // Skip this condition step, move to next
      await sb.from('prospects').update({ current_step: stepIndex + 1, next_send_at: new Date().toISOString() }).eq('id', prospect.id);
      return;
    }

    if (step.type === 'condition_unsub') {
      if (prospect.status === 'unsubscribed') {
        await sb.from('prospects').update({ status: 'completed', current_step: steps.length }).eq('id', prospect.id);
        return;
      }
      await sb.from('prospects').update({ current_step: stepIndex + 1, next_send_at: new Date().toISOString() }).eq('id', prospect.id);
      return;
    }

    if (step.type === 'stop') {
      await sb.from('prospects').update({ status: 'completed', current_step: steps.length }).eq('id', prospect.id);
      return;
    }

    if (step.type === 'tag') {
      const currentTags = prospect.tags || [];
      if (step.tag && !currentTags.includes(step.tag)) {
        await sb.from('prospects').update({ tags: [...currentTags, step.tag], current_step: stepIndex + 1, next_send_at: new Date().toISOString() }).eq('id', prospect.id);
      } else {
        await sb.from('prospects').update({ current_step: stepIndex + 1, next_send_at: new Date().toISOString() }).eq('id', prospect.id);
      }
      return;
    }

    if (step.type === 'wait') {
      const days = step.days || 1;
      const nextSend = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('prospects').update({ current_step: stepIndex + 1, next_send_at: nextSend }).eq('id', prospect.id);
      return;
    }

    if (step.type === 'email' || step.type === 'scout_email') {
      // Get sending account
      const { data: account } = await sb.from('email_accounts')
        .select('*').eq('id', prospect.assigned_account_id).single();

      if (!account || account.status !== 'active') {
        log('SEQUENCE skip — no active account for prospect=' + prospect.email);
        return;
      }

      // Check daily limit
      if ((account.sent_today || 0) >= account.daily_limit) {
        log('SEQUENCE skip — daily limit reached account=' + account.email);
        return;
      }

      // Build email content
      let subject = '';
      let body = '';

      if (step.type === 'scout_email') {
        // Get all API keys
        const { data: keys } = await sb.from('api_keys')
          .select('key_value,service').eq('user_id', campaign.user_id)
          .eq('is_active', true).order('usage_count', { ascending: true });
        const groqKeys = (keys || []).filter(k => k.service === 'groq').map(k => k.key_value);
        const fcKeys = (keys || []).filter(k => k.service === 'firecrawl').map(k => k.key_value);
        // Get previous emails to this prospect for context
        const { data: prevEmails } = await sb.from('email_history')
          .select('subject,body').eq('prospect_id', prospect.id)
          .order('sent_at', { ascending: true });
        if (groqKeys.length) {
          const generated = await generateScoutEmail(prospect, settings, groqKeys, fcKeys, stepIndex, prevEmails || []);
          subject = generated.subject;
          body = generated.body;
        }
      } else {
        // Use template — handle A/B testing
        let templateId = step.templateId;

        if (step.abEnabled && step.templateIdB) {
          // Determine A or B based on prospect id (consistent per prospect)
          const charCode = (prospect.id || '').charCodeAt(0) || 0;
          const useB = charCode % 2 === 1;
          if (useB) templateId = step.templateIdB;
          log('AB_TEST prospect=' + prospect.email + ' variant=' + (useB ? 'B' : 'A') + ' templateId=' + templateId);
        }

        const { data: template } = await sb.from('templates')
          .select('*').eq('id', templateId).single();
        if (!template) {
          log('SEQUENCE skip — template not found templateId=' + templateId);
          await sb.from('prospects').update({ current_step: stepIndex + 1, next_send_at: new Date().toISOString() }).eq('id', prospect.id);
          return;
        }
        subject = mergeVarsServer(template.subject, prospect, account, settings);
        body = mergeVarsServer(template.body, prospect, account, settings);
        if (step.includePersonalizedLine && prospect.personalized_line) {
          body = body.replace(/\[personalized line\]/g, prospect.personalized_line)
                     .replace(/\{\{personalized_line\}\}/g, prospect.personalized_line);
        }
      }

      if (!subject || !body) {
        log('SEQUENCE skip — empty email subject/body prospect=' + prospect.email);
        return;
      }

      // Add open tracking pixel
      const trackPixel = `\n\n<img src="${BACKEND_URL}/track/${prospect.id}/${stepIndex}" width="1" height="1" style="display:none"/>`;

      // Send the email
      try {
        await sendEmailForAccount(account, prospect.email, subject, body + trackPixel, settings?.reply_to || '');
        log('SEQUENCE SENT to=' + prospect.email + ' step=' + stepIndex + ' account=' + account.email);

        // Update prospect and account
        const nextStep = stepIndex + 1;
        const isLastStep = nextStep >= steps.length;
        await sb.from('prospects').update({
          emails_sent: (prospect.emails_sent || 0) + 1,
          last_sent_at: new Date().toISOString(),
          status: isLastStep ? 'completed' : 'in sequence',
          current_step: nextStep,
          next_send_at: isLastStep ? null : new Date().toISOString()
        }).eq('id', prospect.id);

        await sb.from('email_accounts').update({
          sent_today: (account.sent_today || 0) + 1,
          total_sent: (account.total_sent || 0) + 1
        }).eq('id', account.id);

        // Log to email history
        try {
          const abVariant = step.abEnabled && step.templateIdB
            ? ((prospect.id || '').charCodeAt(0) % 2 === 1 ? 'B' : 'A')
            : null;
          await sb.from('email_history').insert({
            user_id: campaign.user_id,
            prospect_id: prospect.id,
            campaign_id: campaign.id,
            account_id: account.id,
            subject: subject,
            body: body,
            step_index: stepIndex,
            sent_at: new Date().toISOString(),
            opened: false,
            ab_variant: abVariant
          });
        } catch(histErr) { log('HISTORY LOG ERROR: ' + histErr.message); }

      } catch (sendErr) {
        log('SEQUENCE SEND FAILED to=' + prospect.email + ' error=' + sendErr.message);
      }
    }

  } catch (e) {
    log('PROSPECT ERROR prospect=' + prospect.email + ': ' + e.message);
  }
}

function mergeVarsServer(text, prospect, account, settings) {
  return (text || '')
    .replace(/\{\{first_name\}\}/g, prospect.first_name || '')
    .replace(/\{\{last_name\}\}/g, prospect.last_name || '')
    .replace(/\{\{company\}\}/g, prospect.company || '')
    .replace(/\{\{email\}\}/g, prospect.email || '')
    .replace(/\{\{personalized_line\}\}/g, prospect.personalized_line || '')
    .replace(/\{\{sender_name\}\}/g, account?.display_name || settings?.sender_name || '')
    .replace(/\{\{sender_email\}\}/g, account?.email || '')
    .replace(/\{\{unsubscribe_link\}\}/g, '');  // Unsubscribe links removed
}

async function sendEmailForAccount(account, toEmail, subject, body, replyTo) {
  // Gmail app password SMTP
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: account.email, pass: (account.app_password || '').replace(/\s/g, '') }
  });
  await transporter.sendMail({
    from: account.display_name ? `"${account.display_name}" <${account.email}>` : account.email,
    to: toEmail,
    subject,
    text: body.replace(/<[^>]+>/g, ''),
    html: body.replace(/\n/g, '<br>'),
    ...(replyTo && { replyTo })
  });
}

async function generateScoutEmail(prospect, settings, groqKeys, firecrawlKeys, stepIndex, previousEmails) {
  const biz = {
    product: settings?.biz_product || '',
    icp: settings?.biz_icp || '',
    problem: settings?.biz_problem || '',
    value: settings?.biz_value || '',
    offer: settings?.biz_offer || '',
    proof: settings?.biz_proof || '',
    website: settings?.biz_website || ''
  };

  // Re-scrape prospect website for fresh context
  let prospectSiteText = '';
  const prospectUrl = prospect.website || prospect.gbp_url || '';
  if (prospectUrl) {
    try {
      const cleanUrl = prospectUrl.startsWith('http') ? prospectUrl : 'https://' + prospectUrl;
      for (const key of (firecrawlKeys || [])) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
            body: JSON.stringify({ url: cleanUrl, formats: ['markdown'], onlyMainContent: true }),
            signal: controller.signal
          });
          clearTimeout(timer);
          const data = await resp.json();
          if (data.success && data.data?.markdown) { prospectSiteText = data.data.markdown.slice(0, 2000); break; }
          if (resp.status === 429) continue;
        } catch(e) { continue; }
      }
      if (!prospectSiteText) {
        try { const html = await fetchUrl(cleanUrl, 8000); prospectSiteText = htmlToText(html).slice(0, 2000); } catch(e) {}
      }
    } catch(e) {}
  }

  // Build previous email history context
  const prevContext = previousEmails && previousEmails.length > 0
    ? 'PREVIOUS EMAILS SENT (do not repeat the same angle or CTA):\n' + previousEmails.map((e, i) =>
        `Email ${i+1} (subject: "${e.subject}"):\n${(e.body||'').replace(/<[^>]+>/g,'').slice(0, 300)}`
      ).join('\n---\n')
    : 'This is the first email.';

  const emailType = stepIndex === 0 ? 'first cold email' : stepIndex === 1 ? 'follow-up email' : 'final follow-up email';

  const prompt = `You are Scout, a cold email expert trained in Hormozi frameworks and direct response copywriting.

Write a ${emailType} for this prospect. Return ONLY a JSON object: {"subject":"...","body":"..."}

PROSPECT:
- Name: ${prospect.first_name} ${prospect.last_name}
- Company: ${prospect.company}
- Research: ${prospect.research_data?.summary || prospect.personalized_line || 'None'}
- Website content: ${prospectSiteText || 'Not available'}

SENDER'S BUSINESS:
- What they sell: ${biz.product}
- Ideal customer: ${biz.icp}
- Problem solved: ${biz.problem}
- Result/value: ${biz.value}
- Offer/CTA: ${biz.offer}
- Proof: ${biz.proof}

${prevContext}

RULES:
- Under 150 words total
- ${stepIndex === 0 ? 'Start with personalized line referencing their specific business' : stepIndex === 1 ? 'Different angle from email 1 — add new value or insight' : 'Short break-up style — give them an easy out, create FOMO'}
- Lead with THEIR pain point, not your product
- One clear CTA — make it low commitment
- Professional, direct, no fluff
- Never lie or fabricate facts about their business
- Do NOT mention unsubscribing`;

  for (const key of groqKeys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0.7 }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (data.choices?.[0]?.message?.content) {
        const raw = data.choices[0].message.content.trim();
        try { return JSON.parse(raw); } catch {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) try { return JSON.parse(m[0]); } catch {}
        }
      }
      if (resp.status === 429) continue;
    } catch (e) { continue; }
  }
  return { subject: stepIndex === 0 ? 'Quick question' : stepIndex === 1 ? 'Following up' : 'Closing the loop', body: 'Hi ' + prospect.first_name + ',\n\n' + (prospect.personalized_line || '') + '\n\nWould you be open to a quick call?\n\nBest' };
}

// ── Open Tracking ─────────────────────────────────────────────────────────────
app.get('/track/:prospectId/:step', async (req, res) => {
  const { prospectId, step } = req.params;
  // Return 1x1 transparent pixel
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-store' });
  res.send(pixel);
  // Log open asynchronously
  if (sb) {
    try {
      const openedAt = new Date().toISOString();
      await sb.from('prospects').update({ last_opened_at: openedAt }).eq('id', prospectId);
      // Mark the specific email as opened
      await sb.from('email_history').update({ opened: true, opened_at: openedAt })
        .eq('prospect_id', prospectId)
        .eq('step_index', parseInt(step) || 0)
        .eq('opened', false);
      log('OPEN_TRACKED prospect=' + prospectId + ' step=' + step);
    } catch (e) { log('OPEN_TRACK ERROR: ' + e.message); }
  }
});

// ── Unsubscribe Handler ───────────────────────────────────────────────────────
app.get('/unsub/:prospectId', async (req, res) => {
  const { prospectId } = req.params;
  if (sb) {
    try {
      await sb.from('prospects').update({ status: 'unsubscribed' }).eq('id', prospectId);
      log('UNSUBSCRIBED prospect=' + prospectId);
    } catch (e) {}
  }
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5"><h2>You've been unsubscribed</h2><p>You will not receive any more emails from this sender.</p></body></html>`);
});

// Start sequence runner — every 5 minutes
setInterval(runSequences, 5 * 60 * 1000);
runSequences(); // run immediately on start
log('SEQUENCE RUNNER started — checking every 5 minutes');
