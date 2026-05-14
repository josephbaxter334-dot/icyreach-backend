/**
 * IcyReach Cloud Backend v3
 * Deploy to Railway — runs 24/7 free
 * Handles: scraping, AI research, email sending, queue
 */

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// In-memory queue (Railway has persistent disk on paid, but free tier restarts occasionally)
// For resilience we keep a simple array and process every 60s
let emailQueue = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok', version: '3.0.0', name: 'IcyReach Cloud Backend',
  endpoints: ['/scrape', '/research', '/send', '/queue', '/test', '/logs']
}));

// ─── Direct HTML Scraper ──────────────────────────────────────────────────────
function fetchUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Connection': 'close'
        }
      };
      const req = lib.request(options, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const redirect = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${u.protocol}//${u.hostname}${res.headers.location}`;
          fetchUrl(redirect, timeout).then(resolve).catch(reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 600000) req.destroy(); });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

// ─── /scrape ──────────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  let { url, firecrawlKeys = [] } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url required' });
  if (!url.startsWith('http')) url = 'https://' + url;
  log(`SCRAPE url=${url} keys=${firecrawlKeys.length}`);

  // Try each Firecrawl key
  for (const key of firecrawlKeys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (data.success && data.data?.markdown) {
        log(`SCRAPE OK via=firecrawl url=${url}`);
        return res.json({ success: true, text: data.data.markdown.slice(0,4000), source: 'firecrawl' });
      }
      if (resp.status === 429 || (data.error||'').toLowerCase().includes('credit') || (data.error||'').toLowerCase().includes('limit')) {
        log(`SCRAPE key exhausted, next...`); continue;
      }
    } catch(e) { log(`SCRAPE firecrawl error: ${e.message}`); continue; }
  }

  // Fallback: direct fetch
  try {
    log(`SCRAPE fallback direct-fetch url=${url}`);
    const html = await fetchUrl(url);
    const text = htmlToText(html);
    if (text.length > 50) {
      log(`SCRAPE OK via=direct url=${url} chars=${text.length}`);
      return res.json({ success: true, text, source: 'direct' });
    }
  } catch(e) { log(`SCRAPE direct failed: ${e.message}`); }

  res.json({ success: false, text: `Could not scrape ${url}`, source: 'failed' });
});

// ─── /research ────────────────────────────────────────────────────────────────
app.post('/research', async (req, res) => {
  const { prospect, firecrawlKeys = [], groqKeys = [], templateBody = '', templateSubject = '' } = req.body;
  if (!prospect) return res.status(400).json({ success: false, error: 'prospect required' });
  if (!groqKeys.length) return res.status(400).json({ success: false, error: 'At least one Groq key required. Add free keys at console.groq.com' });

  const url = prospect.website || prospect.gbp_url || '';
  log(`RESEARCH START company=${prospect.company} url=${url}`);

  // Step 1: Scrape
  let siteText = '';
  if (url) {
    try {
      const cleanUrl = url.startsWith('http') ? url : 'https://' + url;
      // Try Firecrawl keys
      for (const key of firecrawlKeys) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ url: cleanUrl, formats: ['markdown'], onlyMainContent: true }),
            signal: controller.signal
          });
          clearTimeout(timer);
          const data = await resp.json();
          if (data.success && data.data?.markdown) { siteText = data.data.markdown.slice(0,4000); break; }
          if (resp.status === 429 || (data.error||'').toLowerCase().includes('credit')) continue;
        } catch(e) { continue; }
      }
      // Direct fallback
      if (!siteText) {
        try {
          const html = await fetchUrl(cleanUrl, 10000);
          siteText = htmlToText(html);
        } catch(e) { log(`Direct fetch failed: ${e.message}`); }
      }
    } catch(e) { log(`Scrape step failed: ${e.message}`); }
  }

  log(`RESEARCH scraped=${siteText.length} chars company=${prospect.company}`);

  // Step 2: Groq AI
  const prompt = `You are a B2B sales research expert. Analyze this prospect and return ONLY a valid JSON object. No markdown, no code blocks, no text before or after the JSON.

Prospect details:
- Name: ${prospect.first_name} ${prospect.last_name}
- Company: ${prospect.company}
- Website: ${url || 'unknown'}
- Industry: ${prospect.industry || 'unknown'}
- Location: ${prospect.location || 'unknown'}

Website content (use this for specificity):
${siteText || 'No content scraped — infer from company name, domain, and industry.'}

Return exactly this JSON:
{
  "summary": "2-3 sentences describing precisely what this business does based on the website",
  "services": "their specific products or services",
  "targetCustomers": "who they serve, be specific",
  "brandTone": "one of: professional / casual / technical / friendly",
  "painPoints": "2-3 specific pain points relevant to cold outreach",
  "recentNews": "any achievement, launch, or news from their site, or 'None found'",
  "companySize": "estimated size or 'Unknown'",
  "personalizedLine": "1-2 sentence cold email opener. Reference something SPECIFIC from their site. Never say 'I came across your website'. Start with something like 'Your work helping X...' or 'The way you Y...' or 'Loved how you Z...'",
  "suggestedSubject": "Short catchy subject line under 8 words, not clickbait"
}`;

  for (const key of groqKeys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 900, temperature: 0.7
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();

      if (data.choices?.[0]?.message?.content) {
        const raw = data.choices[0].message.content.trim();
        let research = {};
        try { research = JSON.parse(raw); }
        catch {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) try { research = JSON.parse(m[0]); } catch { research = { personalizedLine: raw.slice(0,200), summary: 'Parse error' }; }
          else research = { personalizedLine: raw.slice(0,200), summary: raw.slice(0,300) };
        }

        let draftEmail = '';
        let draftSubject = research.suggestedSubject || '';
        if (templateBody) {
          draftEmail = templateBody
            .replace(/\{\{first_name\}\}/g, prospect.first_name||'')
            .replace(/\{\{last_name\}\}/g, prospect.last_name||'')
            .replace(/\{\{company\}\}/g, prospect.company||'')
            .replace(/\{\{personalized_line\}\}/g, research.personalizedLine||'')
            .replace(/\{\{sender_name\}\}/g, '[Your Name]')
            .replace(/\{\{unsubscribe_link\}\}/g, '[Unsubscribe]');
        }
        if (templateSubject && !draftSubject) {
          draftSubject = templateSubject
            .replace(/\{\{company\}\}/g, prospect.company||'')
            .replace(/\{\{first_name\}\}/g, prospect.first_name||'');
        }

        log(`RESEARCH OK company=${prospect.company}`);
        return res.json({ success: true, research, draftEmail, draftSubject, scraped: !!siteText });
      }

      if (resp.status === 429 || data.error?.code === 'rate_limit_exceeded') {
        log(`RESEARCH Groq rate limit, trying next key`); continue;
      }
      log(`RESEARCH Groq error: ${JSON.stringify(data.error)}`);
    } catch(e) { log(`RESEARCH Groq error: ${e.message}`); continue; }
  }

  log(`RESEARCH FAILED all Groq keys exhausted company=${prospect.company}`);
  res.status(500).json({ success: false, error: 'All Groq keys exhausted. Add more free keys at console.groq.com' });
});

// ─── /send ────────────────────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { fromEmail, appPassword, displayName, toEmail, subject, body, replyTo } = req.body;
  if (!fromEmail || !appPassword || !toEmail || !subject || !body)
    return res.status(400).json({ success: false, error: 'Missing required fields: fromEmail, appPassword, toEmail, subject, body' });
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: fromEmail, pass: appPassword.replace(/\s/g,'') }
    });
    const info = await transporter.sendMail({
      from: displayName ? `"${displayName}" <${fromEmail}>` : fromEmail,
      to: toEmail, subject,
      text: body, html: body.replace(/\n/g,'<br>'),
      ...(replyTo && { replyTo })
    });
    log(`SENT to=${toEmail} from=${fromEmail} msgId=${info.messageId}`);
    res.json({ success: true, messageId: info.messageId });
  } catch(err) {
    log(`SEND FAILED to=${toEmail} error=${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── /queue ───────────────────────────────────────────────────────────────────
app.post('/queue', (req, res) => {
  const job = {
    id: Math.random().toString(36).slice(2,10),
    ...req.body,
    status: 'pending', attempts: 0, maxAttempts: 3,
    queuedAt: new Date().toISOString(),
    nextAttemptAt: new Date().toISOString()
  };
  emailQueue.push(job);
  log(`QUEUED id=${job.id} to=${job.toEmail}`);
  res.json({ success: true, jobId: job.id });
});

app.get('/queue', (req, res) => res.json({
  total: emailQueue.length,
  pending: emailQueue.filter(j=>j.status==='pending').length,
  sent: emailQueue.filter(j=>j.status==='sent').length,
  failed: emailQueue.filter(j=>j.status==='failed').length,
  jobs: emailQueue.slice(-50)
}));

app.delete('/queue/:id', (req, res) => {
  emailQueue = emailQueue.filter(j=>j.id!==req.params.id);
  res.json({ success: true });
});

// ─── /test ────────────────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { fromEmail, appPassword } = req.body;
  if (!fromEmail||!appPassword) return res.status(400).json({ success:false, error:'fromEmail and appPassword required' });
  try {
    const t = nodemailer.createTransport({ service:'gmail', auth:{ user:fromEmail, pass:appPassword.replace(/\s/g,'') } });
    await t.verify();
    log(`VERIFIED account=${fromEmail}`);
    res.json({ success:true, message:'Gmail credentials verified ✅' });
  } catch(err) {
    log(`VERIFY FAILED account=${fromEmail} error=${err.message}`);
    res.status(400).json({ success:false, error:err.message });
  }
});

// ─── /logs ────────────────────────────────────────────────────────────────────
const recentLogs = [];
const origLog = log;
app.get('/logs', (req, res) => res.json({ logs: recentLogs.slice(-100) }));

// ─── Queue Worker ─────────────────────────────────────────────────────────────
async function processQueue() {
  const now = new Date();
  for (const job of emailQueue) {
    if (job.status !== 'pending' || new Date(job.nextAttemptAt) > now) continue;
    job.attempts++;
    try {
      const t = nodemailer.createTransport({ service:'gmail', auth:{ user:job.fromEmail, pass:(job.appPassword||'').replace(/\s/g,'') } });
      await t.sendMail({ from: job.displayName?`"${job.displayName}" <${job.fromEmail}>`:job.fromEmail, to:job.toEmail, subject:job.subject, text:job.body, html:job.body.replace(/\n/g,'<br>'), ...(job.replyTo&&{replyTo:job.replyTo}) });
      job.status = 'sent'; job.sentAt = new Date().toISOString();
      log(`QUEUE_SENT id=${job.id} to=${job.toEmail}`);
    } catch(err) {
      log(`QUEUE_FAIL id=${job.id} attempt=${job.attempts} error=${err.message}`);
      if (job.attempts >= job.maxAttempts) { job.status='failed'; job.failReason=err.message; }
      else { job.nextAttemptAt = new Date(Date.now()+60*60*1000).toISOString(); }
    }
  }
}

setInterval(processQueue, 60*1000);
processQueue();

app.listen(PORT, () => {
  console.log(`\n🧊 IcyReach Cloud Backend v3`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   POST /scrape    — Firecrawl + HTML fallback`);
  console.log(`   POST /research  — Full AI pipeline`);
  console.log(`   POST /send      — Gmail SMTP`);
  console.log(`   POST /test      — Test credentials\n`);
});
