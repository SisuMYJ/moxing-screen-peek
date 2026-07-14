import express from 'express';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

const PEEK_TOKEN = process.env.PEEK_TOKEN || process.env.TOKEN || '';
const VIEW_TOKEN = process.env.VIEW_TOKEN || PEEK_TOKEN;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true') === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const TRIGGER_TO_EMAIL = process.env.TRIGGER_TO_EMAIL || '';
const TRIGGER_SUBJECT = process.env.TRIGGER_SUBJECT || 'MOXING_PEEK';
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 10_000);
const FRESH_MS = Number(process.env.FRESH_MS || 60_000);
const WAIT_MS = Number(process.env.WAIT_MS || 45_000);
const PEEK_DIR = process.env.PEEK_DIR || '/tmp/moxing-peeks';
const MAX_KEEP = Number(process.env.MAX_KEEP || 10);

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getRequestToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.query.key || req.query.token || '').trim();
}

function canUpload(req) {
  return timingSafeEqual(getRequestToken(req), PEEK_TOKEN);
}

function canView(req) {
  const token = getRequestToken(req);
  return timingSafeEqual(token, VIEW_TOKEN) || timingSafeEqual(token, PEEK_TOKEN);
}

function requireUpload(req, res, next) {
  if (!PEEK_TOKEN) return res.status(500).json({ ok: false, error: 'PEEK_TOKEN is not configured' });
  if (!canUpload(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

function requireView(req, res, next) {
  if (!VIEW_TOKEN && !PEEK_TOKEN) return res.status(500).json({ ok: false, error: 'VIEW_TOKEN/PEEK_TOKEN is not configured' });
  if (!canView(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

async function ensureDir() {
  await fs.mkdir(PEEK_DIR, { recursive: true });
}

async function metaPath() {
  await ensureDir();
  return path.join(PEEK_DIR, 'meta.json');
}

async function loadMeta() {
  try {
    const raw = await fs.readFile(await metaPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveMeta(list) {
  await fs.writeFile(await metaPath(), JSON.stringify(list, null, 2));
}

async function savePeek(buffer, appName = '') {
  await ensureDir();
  const id = crypto.randomUUID();
  const file = `${id}.png`;
  const now = Date.now();
  await fs.writeFile(path.join(PEEK_DIR, file), buffer);

  const list = await loadMeta();
  list.push({ id, ts: now, app: appName || '', file, bytes: buffer.length });
  list.sort((a, b) => a.ts - b.ts);

  while (list.length > MAX_KEEP) {
    const old = list.shift();
    if (old?.file) {
      try { await fs.unlink(path.join(PEEK_DIR, old.file)); } catch {}
    }
  }
  await saveMeta(list);
  return { id, ts: now, app: appName || '', file, bytes: buffer.length };
}

async function latestPeek() {
  const list = await loadMeta();
  return list.sort((a, b) => b.ts - a.ts)[0] || null;
}

async function latestPeekAfter(ts) {
  const list = await loadMeta();
  return list.filter(x => x.ts > ts).sort((a, b) => b.ts - a.ts)[0] || null;
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms + 1000)),
  ]);
}

async function sendTriggerMail() {
  if (!SMTP_USER || !SMTP_PASS || !TRIGGER_TO_EMAIL) {
    throw new Error('SMTP_USER, SMTP_PASS, and TRIGGER_TO_EMAIL must be configured');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  await withTimeout(transporter.sendMail({
    from: SMTP_USER,
    to: TRIGGER_TO_EMAIL,
    subject: TRIGGER_SUBJECT,
    text: `peek ${Date.now()}`,
  }), SMTP_TIMEOUT_MS, 'SMTP sendMail');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendImage(res, item) {
  if (!item?.file) return res.status(404).json({ ok: false, error: 'no screenshot yet' });
  const filePath = path.join(PEEK_DIR, item.file);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(await fs.readFile(filePath));
}

app.get('/', async (req, res) => {
  const missing = [];
  if (!PEEK_TOKEN) missing.push('PEEK_TOKEN');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  if (!TRIGGER_TO_EMAIL) missing.push('TRIGGER_TO_EMAIL');

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Moxing Screen Peek</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.55;padding:32px;max-width:760px;margin:auto;">
<h1>🛰️ Moxing Screen Peek</h1>
<p>Status: ${missing.length ? `missing env: <b>${missing.join(', ')}</b>` : '<b>ready</b>'}</p>
<p>Upload endpoint: <code>POST /api/peek?key=&lt;PEEK_TOKEN&gt;</code></p>
<p>Trigger endpoint: <code>GET /api/trigger?key=&lt;VIEW_TOKEN&gt;</code></p>
<p>Latest image: <code>GET /api/latest.png?key=&lt;VIEW_TOKEN&gt;</code></p>
<p>See current screen: <code>GET /api/see?key=&lt;VIEW_TOKEN&gt;</code></p>
</body></html>`);
});

app.get('/api/health', async (req, res) => {
  const latest = await latestPeek();
  res.json({
    ok: true,
    configured: {
      PEEK_TOKEN: Boolean(PEEK_TOKEN),
      VIEW_TOKEN: Boolean(VIEW_TOKEN),
      SMTP_USER: Boolean(SMTP_USER),
      SMTP_PASS: Boolean(SMTP_PASS),
      TRIGGER_TO_EMAIL: Boolean(TRIGGER_TO_EMAIL),
      SMTP_TIMEOUT_MS,
    },
    latest: latest ? { id: latest.id, ts: latest.ts, app: latest.app, bytes: latest.bytes } : null,
  });
});

app.post('/api/peek', requireUpload, express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!buffer.length) return res.status(400).json({ ok: false, error: 'empty body' });

  const item = await savePeek(buffer, String(req.query.app || ''));
  res.json({ ok: true, id: item.id, ts: item.ts, bytes: item.bytes });
});

app.get('/api/trigger', requireView, async (req, res, next) => {
  try {
    await sendTriggerMail();
    res.json({ ok: true, sent: true, subject: TRIGGER_SUBJECT, to: TRIGGER_TO_EMAIL });
  } catch (err) {
    console.error('trigger mail failed:', err);
    res.status(500).json({ ok: false, error: err.message || 'trigger mail failed' });
  }
});

app.get('/api/trigger-async', requireView, async (req, res) => {
  sendTriggerMail().catch(err => console.error('async trigger mail failed:', err));
  res.json({ ok: true, queued: true, subject: TRIGGER_SUBJECT, to: TRIGGER_TO_EMAIL });
});

app.get('/api/latest', requireView, async (req, res) => {
  const latest = await latestPeek();
  if (!latest) return res.status(404).json({ ok: false, error: 'no screenshot yet' });
  res.json({ ok: true, latest: { id: latest.id, ts: latest.ts, app: latest.app, bytes: latest.bytes } });
});

app.get('/api/latest.png', requireView, async (req, res) => {
  const latest = await latestPeek();
  return sendImage(res, latest);
});

app.get('/api/see', requireView, async (req, res) => {
  const latest = await latestPeek();
  if (latest && Date.now() - latest.ts < FRESH_MS) {
    return sendImage(res, latest);
  }

  const started = Date.now();
  try {
    await sendTriggerMail();
  } catch (err) {
    console.error('see trigger mail failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'trigger mail failed' });
  }

  while (Date.now() < started + WAIT_MS) {
    await sleep(1500);
    const fresh = await latestPeekAfter(started);
    if (fresh) return sendImage(res, fresh);
  }

  res.status(504).json({ ok: false, error: 'screenshot did not arrive in time; try again later' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(`Moxing Screen Peek listening on ${PORT}`);
});
