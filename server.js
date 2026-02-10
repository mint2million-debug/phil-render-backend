const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'unlocks.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ instagram:{}, lemonsqueezy:{}, manualRequests: [] }, null, 2));

function readData(){ try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){ return { instagram:{}, lemonsqueezy:{}, manualRequests: [] }; } }
function writeData(d){ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function markInstagramUnlocked(handle, meta){
  const d = readData();
  d.instagram = d.instagram || {};
  d.instagram[handle.toLowerCase()] = { unlocked:true, meta, at: Date.now() };
  writeData(d);
}
function markLemonSubscribed(email, details){
  const d = readData();
  d.lemonsqueezy = d.lemonsqueezy || {};
  d.lemonsqueezy[email.toLowerCase()] = { subscribed:true, details, at: Date.now() };
  writeData(d);
}
function isInstagramUnlocked(handle){
  const d = readData();
  return !!(d.instagram && d.instagram[handle.toLowerCase()] && d.instagram[handle.toLowerCase()].unlocked);
}
function isEmailSubscribed(email){
  const d = readData();
  return !!(d.lemonsqueezy && d.lemonsqueezy[email.toLowerCase()] && d.lemonsqueezy[email.toLowerCase()].subscribed);
}

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Chat -> OpenAI
app.post('/api/chat', async (req, res) => {
  try {
    const question = (req.body.question || req.body.message || '').toString();
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are Phil, a friendly professional golf coach. Give concise, actionable advice.' },
          { role: 'user', content: question }
        ],
        temperature: 0.7,
        max_tokens: 700
      })
    });

    const j = await r.json();

if (!r.ok) {
  console.error('OpenAI error status:', r.status, j);
  return res.status(500).json({
    error: 'OpenAI request failed',
    status: r.status,
    details: j
  });
}

const answer = j?.choices?.[0]?.message?.content || 'No answer';
res.json({ answer });

  } catch (err) {
    console.error('Chat error', err);
    res.status(500).json({ error: String(err) });
  }
});

// Avatar -> D-ID
app.post('/api/avatar', async (req, res) => {
  try {
    const text = (req.body.text || '').toString();
    const DID_KEY = process.env.DID_API_KEY;
    if (!DID_KEY) return res.status(500).json({ error: 'DID_API_KEY not configured' });

    const resp = await fetch('https://api.d-id.com/talks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(DID_KEY + ':').toString('base64')
      },
      body: JSON.stringify({
        script: { type: 'text', input: text },
        source_url: process.env.AVATAR_SOURCE_URL || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL + '/avatar-styleB.png' : 'https://example.com/avatar-styleB.png')
      })
    });

    const j = await resp.json();
    // D-ID may return job info. Return raw until job completes.
    res.json({ raw: j, url: j.result_url || j.url || null });
  } catch (err) {
    console.error('Avatar error', err);
    res.status(500).json({ error: String(err) });
  }
});

// LemonSqueezy checkout (returns hosted checkout URL)
app.post('/api/checkout', (req, res) => {
  const checkoutUrl = process.env.LEMON_CHECKOUT_URL || null;
  if (!checkoutUrl) return res.status(500).json({ error: 'LEMON_CHECKOUT_URL not configured' });
  res.json({ url: checkoutUrl });
});

// LemonSqueezy webhook (simple receiver)
app.post('/webhook/lemonsqueezy', (req, res) => {
  try {
    const event = req.body;
    const email = event && event.data && event.data.attributes && event.data.attributes.customer_email;
    if (email) {
      markLemonSubscribed(email, event);
      console.log('Marked lemon purchase for', email);
    }
  } catch (e) {
    console.error('Lemon webhook error', e);
  }
  res.status(200).send('ok');
});

// Manual unlock request
app.post('/api/manual-unlock-request', (req, res) => {
  const handle = (req.body.instagram_handle || '').trim().toLowerCase();
  const proof = (req.body.proof || '').trim();
  if (!handle) return res.status(400).json({ error: 'instagram_handle required' });
  const d = readData();
  d.manualRequests = d.manualRequests || [];
  d.manualRequests.push({ handle, proof, at: Date.now(), processed: false });
  writeData(d);
  res.json({ ok: true, message: 'Request submitted' });
});

// Admin list manual requests (protected)
app.get('/api/manual-unlock-requests', (req, res) => {
  const secret = req.query.secret || req.headers['x-manual-secret'] || '';
  if (secret !== process.env.MANUAL_UNLOCK_SECRET) return res.status(403).json({ error: 'forbidden' });
  const d = readData();
  res.json({ requests: d.manualRequests || [] });
});

// Admin unlock (protected)
app.post('/api/manual-unlock', (req, res) => {
  const secret = req.body.secret || req.headers['x-manual-secret'] || '';
  if (secret !== process.env.MANUAL_UNLOCK_SECRET) return res.status(403).json({ error: 'forbidden' });
  const handle = (req.body.instagram_handle || '').trim().toLowerCase();
  if (!handle) return res.status(400).json({ error: 'instagram_handle required' });
  markInstagramUnlocked(handle, { method: 'manual' });
  const d = readData();
  if (d.manualRequests) {
    d.manualRequests = d.manualRequests.map(r => r.handle === handle ? ({ ...r, processed: true, processed_at: Date.now() }) : r);
    writeData(d);
  }
  res.json({ ok: true, message: `Unlocked ${handle}` });
});

// Check manual unlock
app.post('/api/check-manual-unlock', (req, res) => {
  const handle = (req.body.instagram_handle || '').trim().toLowerCase();
  if (!handle) return res.json({ unlocked: false });
  res.json({ unlocked: isInstagramUnlocked(handle) });
});

// Check subscription
app.post('/api/check-subscription', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.json({ subscribed: false });
  res.json({ subscribed: isEmailSubscribed(email) });
});

// ManyChat webhook placeholder
app.post('/webhook/manychat', (req, res) => {
  console.log('ManyChat event:', req.body);
  res.status(200).send('ok');
});

// Simple admin UI
app.get('/admin/manual-requests', (req, res) => {
  const secret = req.query.secret || '';
  if (secret !== process.env.MANUAL_UNLOCK_SECRET) return res.status(403).send('forbidden');
  const d = readData();
  let html = '<h2>Manual Unlock Requests</h2><ul>';
  (d.manualRequests || []).forEach(r => html += `<li>${r.handle} - ${r.proof || ''} - processed:${r.processed} <button onclick="fetch('/api/manual-unlock', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({instagram_handle:'${r.handle}', secret: '${process.env.MANUAL_UNLOCK_SECRET}'})}).then(()=>location.reload())">Unlock</button></li>`);
  html += '</ul>';
  res.send(html);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server listening on port', PORT));
