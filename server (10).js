/**
 * IcyReach Cloud Backend v4
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

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

let emailQueue = [];
const sb = SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

app.get('/', (req, res) => res.json({ status: 'ok', version: '5.0.0', name: 'IcyReach Cloud Backend' }));

// ── /send ─────────────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { fromEmail, appPassword, displayName, toEmail, subject, body, replyTo, accountId } = req.body;
  if (!fromEmail || !toEmail || !subject || !body) return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    if (!appPassword) return res.status(400).json({ success: false, error: 'App password required' });
    const isGmail = fromEmail.toLowerCase().includes('@gmail.com') || fromEmail.toLowerCase().includes('@googlemail.com');
    // For non-Gmail accounts, try Brevo first
    if (!isGmail && accountId && sb) {
      const { data: acctData } = await sb.from('email_accounts').select('user_id').eq('id', accountId).maybeSingle();
      if (acctData?.user_id) {
        const { data: brevoKeys } = await sb.from('api_keys').select('key_value,id,usage_count').eq('user_id', acctData.user_id).eq('service', 'brevo').eq('is_active', true).order('usage_count', { ascending: true });
        if (brevoKeys?.length) {
          for (const k of brevoKeys) {
            try {
              await sendViaBrevo(k.key_value, fromEmail, displayName, toEmail, subject, body, replyTo);
              await sb.from('api_keys').update({ usage_count: (k.usage_count || 0) + 1, last_used_at: new Date().toISOString() }).eq('id', k.id);
              log('SENT_BREVO to=' + toEmail + ' from=' + fromEmail);
              return res.json({ success: true, method: 'brevo' });
            } catch(e) {
              if (e.message.includes('429') || e.message.includes('limit')) continue;
              return res.status(500).json({ success: false, error: 'Brevo error: ' + e.message + '. Add a Brevo API key in API Keys for non-Gmail accounts.' });
            }
          }
        } else {
          return res.status(500).json({ success: false, error: 'No Brevo API key found. Yahoo/Outlook accounts require a Brevo key — add one in API Keys.' });
        }
      }
    }
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
    if (!fromEmail || !appPassword) return res.status(400).json({ success: false, error: 'Credentials required' });
    const isGmailTest = fromEmail.toLowerCase().includes('@gmail.com') || fromEmail.toLowerCase().includes('@googlemail.com');
    if (!isGmailTest && accountId && sb) {
      const { data: acctData } = await sb.from('email_accounts').select('user_id').eq('id', accountId).maybeSingle();
      if (acctData?.user_id) {
        const { data: brevoKeys } = await sb.from('api_keys').select('key_value').eq('user_id', acctData.user_id).eq('service', 'brevo').eq('is_active', true).limit(1);
        if (brevoKeys?.length) {
          // Test Brevo key by calling their account info endpoint
          try {
            const r = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': brevoKeys[0].key_value } });
            if (r.ok) return res.json({ success: true, message: '✅ Brevo key verified for ' + fromEmail });
            else return res.status(400).json({ success: false, error: 'Brevo key invalid — check your key in API Keys' });
          } catch(e) {
            return res.status(400).json({ success: false, error: 'Brevo test failed: ' + e.message });
          }
        } else {
          return res.status(400).json({ success: false, error: 'No Brevo API key found. Add one in API Keys for Yahoo/Outlook accounts.' });
        }
      }
    }
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
  const { prospect, firecrawlKeys=[], groqKeys=[], templateBody='', templateSubject='', userId='' } = req.body;
  if (!prospect) return res.status(400).json({success:false,error:'prospect required'});
  if (!groqKeys.length) return res.status(400).json({success:false,error:'At least one Groq key required'});
  // Plan check — AI research requires Cold plan or higher
  if (userId) {
    const plan = await getUserPlanServer(userId);
    if (plan === 'free') {
      return res.status(403).json({ success: false, error: 'AI research requires the Cold plan or higher. Upgrade at icyreach.netlify.app', upgrade: true });
    }
  }
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
        // OAuth removed — app passwords only
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


// ── Brevo Email Sending ───────────────────────────────────────────────────────
async function sendViaBrevo(brevoKey, fromEmail, fromName, toEmail, subject, body, replyTo) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': brevoKey
    },
    body: JSON.stringify({
      sender: { name: fromName || fromEmail, email: fromEmail },
      to: [{ email: toEmail }],
      subject,
      textContent: body.replace(/<[^>]+>/g, ''),
      htmlContent: body.replace(/\n/g, '<br>'),
      ...(replyTo && { replyTo: { email: replyTo } })
    })
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error('Brevo error: ' + JSON.stringify(err));
  }
  return await resp.json();
}

// ── Warmup Pool ───────────────────────────────────────────────────────────────
const WARMUP_SUBJECTS = [
  'Quick question', 'Following up', 'Thoughts?', 'Re: our conversation',
  'Checking in', 'Quick note', 'Hey', 'Just wanted to share this'
];
const WARMUP_BODIES = [
  'Hi,\n\nHope you are doing well. Just wanted to reach out and see how things are going.\n\nLet me know if you have a moment to chat.\n\nBest regards',
  'Hello,\n\nI came across something interesting and thought of you. Would love to get your thoughts when you have a chance.\n\nThanks',
  'Hi there,\n\nJust following up on my previous message. Let me know if you had a chance to look into this.\n\nBest',
  'Hello,\n\nHope this finds you well. I wanted to touch base and see if you had any updates.\n\nLooking forward to hearing from you.',
  'Hi,\n\nQuick note — I think we should connect sometime this week. Let me know your availability.\n\nThanks so much'
];
const WARMUP_REPLIES = [
  'Thanks for reaching out! Will get back to you shortly.',
  'Got it, thanks! Will follow up soon.',
  'Appreciate you getting in touch. Will respond properly later today.',
  'Thanks for this! Really useful. Will reply in full shortly.',
  'Hi, thanks for the message. Noted — will get back to you.',
  'Received, thanks! Chat soon.',
  'Perfect timing — will respond properly later. Thanks!'
];

async function readAndReplyWarmupEmails(account, warmupEmailSet) {
  if (!account.app_password) return;
  const email = account.email.toLowerCase();
  // Only Gmail accounts support IMAP read/reply in this build
  if (!email.includes('@gmail.com') && !email.includes('@googlemail.com')) return;
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');
  try {
    await new Promise((resolve) => {
      const imap = new Imap({
        user: account.email,
        password: account.app_password.replace(/\s/g, ''),
        host: 'imap.gmail.com', port: 993, tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 15000, authTimeout: 8000
      });
      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { imap.end(); resolve(); return; }
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          imap.search(['UNSEEN', ['SINCE', since]], (err, results) => {
            if (err || !results?.length) { imap.end(); resolve(); return; }
            const toProcess = results.slice(-10);
            const f = imap.fetch(toProcess, { bodies: '', markSeen: true });
            const pending = [];
            f.on('message', (msg) => {
              pending.push(new Promise(async (res2) => {
                let buffer = '';
                msg.on('body', stream => { stream.on('data', c => buffer += c); });
                msg.once('end', async () => {
                  try {
                    const parsed = await simpleParser(buffer);
                    const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
                    const subject = parsed.subject || '';
                    const msgId = parsed.messageId || '';
                    if (fromAddr && fromAddr !== email && warmupEmailSet.has(fromAddr)) {
                      const replySubject = subject.startsWith('Re:') ? subject : 'Re: ' + subject;
                      const replyBody = WARMUP_REPLIES[Math.floor(Math.random() * WARMUP_REPLIES.length)];
                      const transporter = require('nodemailer').createTransport({
                        service: 'gmail',
                        auth: { user: account.email, pass: account.app_password.replace(/\s/g, '') }
                      });
                      await transporter.sendMail({
                        from: account.email, to: fromAddr, subject: replySubject,
                        text: replyBody, inReplyTo: msgId, references: msgId
                      });
                      log('WARMUP_REPLY from=' + account.email + ' to=' + fromAddr);
                    }
                  } catch(e) { log('WARMUP_READ_ERR: ' + e.message); }
                  res2();
                });
              }));
            });
            f.once('end', async () => { await Promise.all(pending); imap.end(); resolve(); });
            f.once('error', () => { imap.end(); resolve(); });
          });
        });
      });
      imap.once('error', () => resolve());
      imap.once('end', resolve);
      imap.connect();
    });
  } catch(e) { log('WARMUP_IMAP_ERR account=' + account.email + ': ' + e.message); }
}

async function runWarmupPool() {
  if (!sb) return;
  try {
    const { data: accounts } = await sb.from('email_accounts')
      .select('*').eq('warmup_enabled', true).eq('status', 'active');
    if (!accounts || accounts.length < 2) return;
    log('WARMUP_POOL running with ' + accounts.length + ' accounts');

    const warmupEmailSet = new Set(accounts.map(a => a.email.toLowerCase()));

    // Phase 1 — Read + reply to received warmup emails (always reply)
    for (const account of accounts) {
      await readAndReplyWarmupEmails(account, warmupEmailSet);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Phase 2 — Send new warmup emails
    for (const sender of accounts) {
      if (!sender.app_password) continue;
      const days = sender.warmup_start_date
        ? Math.floor((Date.now() - new Date(sender.warmup_start_date)) / 86400000) : 0;
      const week = Math.floor(days / 7) + 1;
      const warmupCount = Math.min(week * 2, 8);
      const recipients = accounts
        .filter(a => a.id !== sender.id && a.app_password)
        .sort(() => Math.random() - 0.5)
        .slice(0, warmupCount);
      for (const recipient of recipients) {
        try {
          const subject = WARMUP_SUBJECTS[Math.floor(Math.random() * WARMUP_SUBJECTS.length)];
          const body = WARMUP_BODIES[Math.floor(Math.random() * WARMUP_BODIES.length)];
          const transporter = require('nodemailer').createTransport({
            service: 'gmail',
            auth: { user: sender.email, pass: (sender.app_password || '').replace(/\s/g, '') }
          });
          await transporter.sendMail({
            from: sender.display_name ? `"${sender.display_name}" <${sender.email}>` : sender.email,
            to: recipient.email, subject, text: body
          });
          log('WARMUP_SENT from=' + sender.email + ' to=' + recipient.email);
          await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
        } catch(e) { log('WARMUP_SEND_FAIL from=' + sender.email + ': ' + e.message); }
      }
    }
  } catch(e) { log('WARMUP_POOL ERROR: ' + e.message); }
}

// Run warmup pool every hour
setInterval(runWarmupPool, 60 * 60 * 1000);
runWarmupPool();
log('WARMUP_POOL started — running every hour');

app.listen(PORT,()=>{
  console.log('\n🧊 IcyReach Cloud Backend v4');
  console.log('   OAuth2: Gmail ✅ Outlook ✅');
  console.log('   Running on port '+PORT+'\n');
});



// ── Stripe Webhook ────────────────────────────────────────────────────────────
// Must be raw body for Stripe signature verification
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  // Map Stripe price IDs to plan names
  const PRICE_TO_PLAN = {
    'price_1TY9xy9vvAtp87yJQA5vHuOC': 'cold',
    'price_1TYA059vvAtp87yJi3A8OEgB': 'cold',
    'price_1TYA6L9vvAtp87yJRWozLzNJ': 'blizzard',
    'price_1TYA7X9vvAtp87yJ6BfyEVrA': 'blizzard',
    'price_1TYA9h9vvAtp87yJYd54Qjit': 'arctic',
    'price_1TYAAb9vvAtp87yJAlYpTSIM': 'arctic',
  };

  // Plan limits
  const PLAN_LIMITS = {
    free: { accounts: 1, emails_per_month: 500, campaigns: 1, ai: false, scout: false, ab_testing: false, team_seats: 1 },
    cold: { accounts: 5, emails_per_month: 10000, campaigns: -1, ai: true, scout: true, ab_testing: false, team_seats: 1 },
    blizzard: { accounts: -1, emails_per_month: -1, campaigns: -1, ai: true, scout: true, ab_testing: true, team_seats: 3 },
    arctic: { accounts: -1, emails_per_month: -1, campaigns: -1, ai: true, scout: true, ab_testing: true, team_seats: 10 }
  };

  let event;
  try {
    if (webhookSecret && sig) {
      // In production with webhook secret
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Development fallback - parse raw body
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    log('WEBHOOK ERROR: ' + err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  try {
    if (!sb) { res.json({ received: true }); return; }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const customerEmail = session.customer_details?.email || session.customer_email || '';
        if (subscriptionId && sb) {
          try {
            const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId = sub.items?.data?.[0]?.price?.id || '';
            const plan = PRICE_TO_PLAN[priceId] || 'cold';
            // Try to find user by email in profiles table
            if (customerEmail) {
              const { data: profile } = await sb.from('profiles').select('id').eq('email', customerEmail).maybeSingle();
              if (profile?.id) {
                await sb.from('user_plans').upsert({
                  id: profile.id, plan, stripe_customer_id: customerId,
                  stripe_subscription_id: subscriptionId,
                  plan_started_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
                log('CHECKOUT_COMPLETE email=' + customerEmail + ' plan=' + plan);
              } else {
                // User hasn't signed up yet — store pending plan by customer ID
                // Will be matched when they sign up and call /check-email-plan
                log('CHECKOUT_PENDING email=' + customerEmail + ' plan=' + plan + ' — awaiting signup');
              }
            }
          } catch(e) { log('CHECKOUT ERROR: ' + e.message); }
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const priceId = subscription.items?.data?.[0]?.price?.id || '';
        const plan = PRICE_TO_PLAN[priceId] || 'cold';
        const status = subscription.status;
        // Try to find user by customer ID
        if (sb && (status === 'active' || status === 'trialing')) {
          try {
            const { data: existingPlan } = await sb.from('user_plans')
              .select('id').eq('stripe_customer_id', customerId).maybeSingle();
            if (existingPlan?.id) {
              await sb.from('user_plans').update({
                plan, stripe_subscription_id: subscription.id,
                updated_at: new Date().toISOString()
              }).eq('id', existingPlan.id);
              log('SUB_UPDATED userId=' + existingPlan.id + ' plan=' + plan);
            }
          } catch(e) { log('SUB_UPDATE ERROR: ' + e.message); }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        if (sb) {
          try {
            const { data: existingPlan } = await sb.from('user_plans')
              .select('id').eq('stripe_customer_id', customerId).maybeSingle();
            if (existingPlan?.id) {
              await sb.from('user_plans').update({
                plan: 'free', stripe_subscription_id: null,
                updated_at: new Date().toISOString()
              }).eq('id', existingPlan.id);
              log('PLAN_CANCELLED userId=' + existingPlan.id);
            }
          } catch(e) { log('CANCEL ERROR: ' + e.message); }
        }
        break;
      }
    }
  } catch (err) {
    log('WEBHOOK PROCESS ERROR: ' + err.message);
  }

  res.json({ received: true });
});

// ── /get-plan — Returns user plan and limits ──────────────────────────────────
app.post('/get-plan', async (req, res) => {
  const { userId } = req.body;
  if (!userId || !sb) return res.json({ plan: 'free', limits: PLAN_LIMITS_PUBLIC.free });

  const PLAN_LIMITS_PUBLIC = {
    free: { accounts: 1, emails_per_month: 500, campaigns: 1, ai: false, scout: false, ab_testing: false, team_seats: 1 },
    cold: { accounts: 5, emails_per_month: 10000, campaigns: -1, ai: true, scout: true, ab_testing: false, team_seats: 1 },
    blizzard: { accounts: -1, emails_per_month: -1, campaigns: -1, ai: true, scout: true, ab_testing: true, team_seats: 3 },
    arctic: { accounts: -1, emails_per_month: -1, campaigns: -1, ai: true, scout: true, ab_testing: true, team_seats: 10 }
  };

  try {
    const { data } = await sb.from('user_plans').select('plan').eq('id', userId).single();
    const plan = data?.plan || 'free';
    res.json({ plan, limits: PLAN_LIMITS_PUBLIC[plan] || PLAN_LIMITS_PUBLIC.free });
  } catch (e) {
    res.json({ plan: 'free', limits: PLAN_LIMITS_PUBLIC.free });
  }
});


// ── /check-email-plan — checks Stripe for active subscription by email ────────
app.post('/check-email-plan', async (req, res) => {
  const { email, userId } = req.body;
  if (!email || !userId) return res.json({ plan: 'free' });

  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (!stripeKey) return res.json({ plan: 'free' });

  const PRICE_TO_PLAN = {
    'price_1TY9xy9vvAtp87yJQA5vHuOC': 'cold',
    'price_1TYA059vvAtp87yJi3A8OEgB': 'cold',
    'price_1TYA6L9vvAtp87yJRWozLzNJ': 'blizzard',
    'price_1TYA7X9vvAtp87yJ6BfyEVrA': 'blizzard',
    'price_1TYA9h9vvAtp87yJYd54Qjit': 'arctic',
    'price_1TYAAb9vvAtp87yJAlYpTSIM': 'arctic',
  };

  try {
    const stripe = require('stripe')(stripeKey);

    // Search for customers with this email
    const customers = await stripe.customers.list({ email, limit: 5 });
    if (!customers.data.length) return res.json({ plan: 'free' });

    // Check subscriptions for each customer
    for (const customer of customers.data) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 5
      });

      for (const sub of subscriptions.data) {
        const priceId = sub.items.data[0]?.price?.id;
        const plan = PRICE_TO_PLAN[priceId];
        if (plan) {
          // Update plan in Supabase
          if (sb) {
            await sb.from('user_plans').upsert({
              id: userId,
              plan,
              stripe_customer_id: customer.id,
              stripe_subscription_id: sub.id,
              plan_started_at: new Date(sub.start_date * 1000).toISOString(),
              updated_at: new Date().toISOString()
            }, { onConflict: 'id' });
          }
          log('EMAIL_PLAN_MATCH email=' + email + ' plan=' + plan);
          return res.json({ plan, matched: true });
        }
      }
    }

    return res.json({ plan: 'free', matched: false });
  } catch (err) {
    log('CHECK_EMAIL_PLAN ERROR: ' + err.message);
    return res.json({ plan: 'free', error: err.message });
  }
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


// ── Public API (for API Access keys) ──────────────────────────────────────────
// Authenticate via x-api-key header
async function authApiKey(req) {
  const key = req.headers['x-api-key'] || '';
  if (!key || !sb) return null;
  const { data } = await sb.from('api_access_keys').select('*').eq('api_key', key).eq('is_active', true).maybeSingle();
  if (!data) return null;
  // Update usage
  await sb.from('api_access_keys').update({
    request_count: (data.request_count || 0) + 1,
    last_used_at: new Date().toISOString()
  }).eq('id', data.id);
  return data;
}

// POST /api/prospects — add a prospect externally
app.post('/api/prospects', async (req, res) => {
  const apiKey = await authApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Invalid or missing API key' });
  const { first_name, last_name, email, company, website, phone, campaign_id } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  try {
    const { data, error } = await sb.from('prospects').insert({
      user_id: apiKey.user_id,
      workspace_id: apiKey.workspace_id || null,
      campaign_id: campaign_id || null,
      first_name: first_name || '',
      last_name: last_name || '',
      email,
      company: company || '',
      website: website || '',
      phone: phone || '',
      status: 'not started',
      research_status: 'pending'
    }).select().single();
    if (error) throw error;
    log('API_PROSPECT_ADDED user=' + apiKey.user_id + ' email=' + email);
    res.json({ success: true, prospect: { id: data.id, email: data.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/campaigns — list campaigns
app.get('/api/campaigns', async (req, res) => {
  const apiKey = await authApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Invalid or missing API key' });
  try {
    let q = sb.from('campaigns').select('id,name,status,created_at').eq('user_id', apiKey.user_id);
    if (apiKey.workspace_id) q = q.eq('workspace_id', apiKey.workspace_id);
    const { data } = await q.order('created_at', { ascending: false });
    res.json({ success: true, campaigns: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats — prospect + email stats
app.get('/api/stats', async (req, res) => {
  const apiKey = await authApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Invalid or missing API key' });
  try {
    const { data: prospects } = await sb.from('prospects').select('status,emails_sent').eq('user_id', apiKey.user_id);
    const { count: emailsSent } = await sb.from('email_history').select('*', { count: 'exact', head: true }).eq('user_id', apiKey.user_id);
    const total = prospects?.length || 0;
    const replied = (prospects || []).filter(p => p.status === 'replied').length;
    res.json({
      success: true,
      stats: {
        total_prospects: total,
        replied,
        reply_rate: total ? Math.round(replied / total * 100) : 0,
        emails_sent: emailsSent || 0
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// Plan limits (server-side source of truth)
const SERVER_PLAN_LIMITS = {
  free: { accounts: 1, emails_per_month: 500, ai: false, scout: false, ab_testing: false },
  cold: { accounts: 5, emails_per_month: 10000, ai: true, scout: true, ab_testing: false },
  blizzard: { accounts: -1, emails_per_month: -1, ai: true, scout: true, ab_testing: true },
  arctic: { accounts: -1, emails_per_month: -1, ai: true, scout: true, ab_testing: true }
};
const OWNER_EMAILS_SERVER = ['josephbaxter334@gmail.com', 'josephbaxter334@googlemail.com'];

async function getUserPlanServer(userId) {
  if (!sb) return 'free';
  try {
    // Check if owner
    const { data: profile } = await sb.from('profiles').select('email').eq('id', userId).maybeSingle();
    if (profile?.email && OWNER_EMAILS_SERVER.includes(profile.email.toLowerCase())) return 'owner';
    const { data } = await sb.from('user_plans').select('plan').eq('id', userId).maybeSingle();
    return data?.plan || 'free';
  } catch(e) { return 'free'; }
}

async function getMonthlyEmailCount(userId) {
  if (!sb) return 0;
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const { count } = await sb.from('email_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('sent_at', startOfMonth.toISOString());
    return count || 0;
  } catch(e) { return 0; }
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

    // ── PLAN ENFORCEMENT: Check monthly email cap ──
    const plan = await getUserPlanServer(campaign.user_id);
    if (plan !== 'owner') {
      const limits = SERVER_PLAN_LIMITS[plan] || SERVER_PLAN_LIMITS.free;
      if (limits.emails_per_month !== -1) {
        const sentThisMonth = await getMonthlyEmailCount(campaign.user_id);
        if (sentThisMonth >= limits.emails_per_month) {
          log('SEQUENCE BLOCKED — monthly cap reached user=' + campaign.user_id + ' plan=' + plan + ' sent=' + sentThisMonth + '/' + limits.emails_per_month);
          return;
        }
      }
    }

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
  const email = account.email.toLowerCase();
  const isGmail = email.includes('@gmail.com') || email.includes('@googlemail.com') || (account.smtp_host || '') === '';

  // For non-Gmail accounts, try Brevo first
  if (!isGmail && sb) {
    const { data: brevoKeys } = await sb.from('api_keys')
      .select('key_value').eq('user_id', account.user_id)
      .eq('service', 'brevo').eq('is_active', true)
      .order('usage_count', { ascending: true });

    if (brevoKeys?.length) {
      for (const k of brevoKeys) {
        try {
          await sendViaBrevo(k.key_value, account.email, account.display_name, toEmail, subject, body, replyTo);
          await sb.from('api_keys').update({ usage_count: (k.usage_count || 0) + 1, last_used_at: new Date().toISOString() }).eq('key_value', k.key_value);
          log('SENT_BREVO from=' + account.email + ' to=' + toEmail);
          return;
        } catch(e) {
          if (e.message.includes('429') || e.message.includes('limit')) continue;
          throw e;
        }
      }
    }
  }

  // Gmail app password SMTP (default)
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
