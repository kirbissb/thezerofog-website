// Friends lane - the monthly share report.
//
//   STRIPE_SECRET_KEY=... node scripts/friends-report.mjs            # what is DUE now
//   STRIPE_SECRET_KEY=... node scripts/friends-report.mjs --all      # every lane sale, any state
//   STRIPE_SECRET_KEY=... node scripts/friends-report.mjs --month 2026-10   # due in that month
//
// The key is read from the environment, then from .env (gitignored). It is NOT in .env today -
// the production value lives in Netlify: `netlify env:get STRIPE_SECRET_KEY --context production`.
//
// What it does, and the arithmetic the share rests on (memory zerofog-friends-lane-lena):
//   - lists every completed, paid Checkout Session whose metadata.source is "friends" (written
//     server-side by create-checkout.js for a checkout opened from /start/ - the lane's only
//     tracker is that address);
//   - for each, reads the charge and its balance transaction: the SETTLED amount, Stripe's fee
//     (processing + currency conversion, both are fee_details rows) and the net, in the
//     account's settlement currency (EUR);
//   - a sale is DUE 30 days after the purchase (the refund window), unless refunded in full;
//     a partial refund reduces the net by the refunded share;
//   - the share is 50 percent of that net.
//
// Read-only against Stripe. Nothing is written anywhere; the output is a markdown table to paste
// into the month's message and the payout row.

import fs from 'node:fs';

if (!process.env.STRIPE_SECRET_KEY) {
  try {
    for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  } catch { /* no .env - the environment has to carry the key */ }
}
const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Production value: netlify env:get STRIPE_SECRET_KEY --context production');
  process.exit(2);
}

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const monthArg = args[args.indexOf('--month') + 1];
const MONTH = args.includes('--month') && /^\d{4}-\d{2}$/.test(monthArg || '') ? monthArg : null;
const SHARE = 0.5;
const WINDOW_DAYS = 30;

async function stripe(path, params = {}) {
  const url = new URL('https://api.stripe.com/v1/' + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k + '[]', x));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + KEY } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error?.message || ''}`);
  return body;
}

// Checkout Sessions cannot be searched by metadata, so the list is walked to the beginning.
// The lane opened on 2026-09-07; nothing before that can carry the marker, and the walk stops
// there rather than at the account's first session in July.
const LANE_OPENED = Math.floor(Date.parse('2026-09-07T00:00:00Z') / 1000);
async function laneSessions() {
  const out = [];
  let starting_after = null;
  for (;;) {
    const page = await stripe('checkout/sessions', {
      limit: 100,
      'created[gte]': LANE_OPENED,
      ...(starting_after ? { starting_after } : {}),
    });
    for (const s of page.data) {
      if (s.metadata?.source === 'friends' && s.status === 'complete' && s.payment_status === 'paid') out.push(s);
    }
    if (!page.has_more || !page.data.length) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

function money(n, cur) {
  return `${(n / 100).toFixed(2)} ${String(cur).toUpperCase()}`;
}
function day(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

const sessions = await laneSessions();
const rows = [];
for (const s of sessions) {
  const pi = await stripe('payment_intents/' + s.payment_intent, { expand: ['latest_charge.balance_transaction'] });
  const ch = pi.latest_charge;
  const bt = ch?.balance_transaction;
  if (!ch || !bt) { console.error('no charge/balance transaction on', s.id); continue; }

  const refundedShare = ch.amount ? (ch.amount_refunded || 0) / ch.amount : 0;

  // VAT is not ours and must never enter her half. Stripe reports it on the session
  // (total_details.amount_tax, in the CHARGE currency), while the balance transaction reports the
  // settled amount and fees in the account currency, so the tax is removed in proportion rather
  // than subtracted across currencies.
  const taxCents = Number(s.total_details?.amount_tax || 0);
  const taxShare = s.amount_total ? taxCents / Number(s.amount_total) : 0;
  const netSettled = Math.round(bt.net * (1 - taxShare)); // after fees, and after VAT
  const netAfterRefund = Math.round(netSettled * (1 - refundedShare));
  const dueAt = s.created + WINDOW_DAYS * 86400;
  const now = Math.floor(Date.now() / 1000);
  let state;
  if (ch.refunded) state = 'REFUNDED - nothing owed';
  else if (refundedShare > 0) state = `partly refunded (${Math.round(refundedShare * 100)} percent)` + (now >= dueAt ? ' - DUE' : ` - due ${day(dueAt)}`);
  else state = now >= dueAt ? 'DUE' : `waiting - due ${day(dueAt)}`;

  const share = ch.refunded ? 0 : Math.round(netAfterRefund * SHARE);
  rows.push({
    date: day(s.created), email: s.customer_details?.email || '?', session: s.id,
    charged: money(s.amount_total, s.currency),
    settled: money(bt.amount, bt.currency),
    fee: money(bt.fee, bt.currency) + ' (' + (bt.fee_details || []).map((f) => `${f.type} ${(f.amount / 100).toFixed(2)}`).join(' + ') + ')',
    tax: taxCents ? money(taxCents, s.currency) : '-',
    net: money(netAfterRefund, bt.currency),
    state, dueAt, due: now >= dueAt && !ch.refunded,
    share, shareCur: bt.currency,
  });
}

const selected = rows.filter((r) => ALL || (MONTH ? day(r.dueAt).startsWith(MONTH) && !r.state.startsWith('REFUNDED') : r.due));
console.log(`# Friends lane - ${ALL ? 'all sales' : MONTH ? 'share due in ' + MONTH : 'share due now'} (generated ${new Date().toISOString().slice(0, 16)}Z)\n`);
console.log(`Sales with metadata.source=friends since ${day(LANE_OPENED)}: ${rows.length}. Rule: ${SHARE * 100} percent of the net settled amount (after Stripe processing and conversion fees, and after VAT, which is not ours), ${WINDOW_DAYS} days after purchase, full refunds excluded, partial refunds pro rata.\n`);
if (!selected.length) {
  console.log('Nothing to pay in this selection.');
} else {
  console.log('| Bought | Buyer | Charged | VAT | Settled | Stripe fees | Net | State | Share |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of selected) {
    console.log(`| ${r.date} | ${r.email} | ${r.charged} | ${r.tax} | ${r.settled} | ${r.fee} | ${r.net} | ${r.state} | ${money(r.share, r.shareCur)} |`);
  }
  const total = selected.reduce((a, r) => a + r.share, 0);
  const cur = selected[0].shareCur;
  console.log(`\n**Total share in this selection: ${money(total, cur)}**`);
}
