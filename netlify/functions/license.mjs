// Ignore Me Not license checker (Netlify Function).
// Keys are made from the buyer's Paddle subscription ID plus a signature, so no database is needed.
// Needs one environment variable in Netlify: PADDLE_API_KEY (read access to transactions, subscriptions, customers).
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.paddle.com';
const PRICE_IDS = [
  'pri_01m7rzrqxpe61ax1w7ht359qx9', // Monthly $1.99
  'pri_01m7rzskm537q1w1mcr2m4x84e'  // Yearly $14.99
];
const ACTIVE = ['active', 'trialing', 'past_due'];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function paddle(path) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'Paddle-Version': '1' },
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paddle ${res.status}`);
  return (await res.json()).data;
}

function sign(subId) {
  return createHmac('sha256', 'imn-license-v1:' + process.env.PADDLE_API_KEY)
    .update(subId).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
}

function makeKey(subId) {
  return `IMN-${subId.replace(/^sub_/, '').toUpperCase()}-${sign(subId)}`;
}

function readKey(key) {
  const m = /^IMN-([0-9A-Z]{20,40})-([0-9A-Z]{10})$/.exec(String(key || '').trim().toUpperCase());
  if (!m) return null;
  const subId = 'sub_' + m[1].toLowerCase();
  const a = Buffer.from(sign(subId)), b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b) ? subId : null;
}

const ours = (items) => (items || []).some((it) => PRICE_IDS.includes(it.price && it.price.id));

async function keyFromTransaction(txnId) {
  if (!/^txn_[0-9a-z]{10,40}$/.test(String(txnId || ''))) return { error: 'invalid' };
  const t = await paddle(`/transactions/${txnId}`);
  if (!t || !ours(t.items)) return { error: 'invalid' };
  if (!['completed', 'paid'].includes(t.status) || !t.subscription_id) return { pending: true };
  return { key: makeKey(t.subscription_id), customerId: t.customer_id };
}

export default async (req) => {
  if (!process.env.PADDLE_API_KEY) return json({ error: 'not_configured' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body = {};
  try { body = await req.json(); } catch { /* empty */ }
  const route = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop();
  try {
    if (route === 'claim') {
      // After checkout: turn the Paddle transaction into a license key
      const r = await keyFromTransaction(body.transaction_id);
      if (r.error) return json({ error: r.error }, 400);
      if (r.pending) return json({ pending: true }, 202);
      return json({ key: r.key });
    }
    if (route === 'recover') {
      // Lost key: the email used at checkout + the transaction ID from the Paddle receipt
      const r = await keyFromTransaction(String(body.transaction_id || '').trim());
      if (r.error || r.pending) return json({ error: 'not_found' }, 404);
      const c = await paddle(`/customers/${r.customerId}`);
      const email = String(body.email || '').trim().toLowerCase();
      if (!c || !email || String(c.email).toLowerCase() !== email) return json({ error: 'not_found' }, 404);
      return json({ key: r.key });
    }
    if (route === 'validate') {
      // The app checks its key about once a day
      const subId = readKey(body.key);
      if (!subId) return json({ status: 'invalid' });
      const s = await paddle(`/subscriptions/${subId}`);
      if (!s || !ours(s.items)) return json({ status: 'invalid' });
      return json({
        status: ACTIVE.includes(s.status) ? 'active' : 'inactive',
        renews: s.next_billed_at || null,
        cancelAt: s.scheduled_change && s.scheduled_change.action === 'cancel' ? s.scheduled_change.effective_at : null
      });
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'unavailable' }, 502);
  }
};

export const config = { path: ['/api/claim', '/api/recover', '/api/validate'] };
