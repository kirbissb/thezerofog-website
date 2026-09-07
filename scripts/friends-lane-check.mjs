// Friends lane - the two decisions that cannot be probed from outside, proven offline.
//
//   node scripts/friends-lane-check.mjs
//
// 1. create-checkout.js: which lane a checkout gets, where it lands, what its metadata says.
// 2. stripe-webhook.js: whether a completed session is reported to Meta as a Purchase.
//
// Neither needs a key, a network or a signed event: both are pure functions exported for
// exactly this file. Run it after any change to either function. Exits 1 on the first miss.

const B = '/Users/Cyrill/AI SANDBOX/thezerofog-website/netlify/functions/';
const { buildSessionParams } = await import(B + 'create-checkout.js');
const { shouldSendMetaPurchase } = await import(B + 'stripe-webhook.js');

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name} -> ${JSON.stringify(got)}`);
};

const base = 'https://thezerofog.com';
const pick = (params) => ({
  success: params.get('success_url'),
  cancel: params.get('cancel_url'),
  source: params.get('metadata[source]'),
  comp: params.get('metadata[zf_comp]'),
});

eq('sales page, no source (the pre-2026-09-07 body "{}")',
  pick(buildSessionParams('price_x', base, true, null, '')),
  { success: `${base}/welcome/?session_id={CHECKOUT_SESSION_ID}`, cancel: `${base}/sales/`, source: 'sales_page', comp: null });

eq('friends lane from /start/',
  pick(buildSessionParams('price_x', base, true, null, 'friends')),
  { success: `${base}/start/thanks/?session_id={CHECKOUT_SESSION_ID}`, cancel: `${base}/start/`, source: 'friends', comp: null });

eq('a made-up source falls back to the sales lane, never echoed',
  pick(buildSessionParams('price_x', base, true, null, 'lena-promo')),
  { success: `${base}/welcome/?session_id={CHECKOUT_SESSION_ID}`, cancel: `${base}/sales/`, source: 'sales_page', comp: null });

eq('comp link, default lane, keeps the historical comp_link marker',
  pick(buildSessionParams('price_x', base, true, 'coupon_x', '')),
  { success: `${base}/welcome/?session_id={CHECKOUT_SESSION_ID}`, cancel: `${base}/sales/`, source: 'comp_link', comp: 'granted' });

eq('comp link through the friends lane lands on /start/thanks/ and stays source=friends',
  pick(buildSessionParams('price_x', base, true, 'coupon_x', 'friends')),
  { success: `${base}/start/thanks/?session_id={CHECKOUT_SESSION_ID}`, cancel: `${base}/start/`, source: 'friends', comp: 'granted' });

eq('the price and the mode are untouched by the lane',
  [buildSessionParams('price_x', base, true, null, 'friends').get('line_items[0][price]'),
   buildSessionParams('price_x', base, true, null, 'friends').get('mode')],
  ['price_x', 'payment']);

eq('Meta Purchase: ad-funnel sale -> sent', shouldSendMetaPurchase({ isComp: false, lane: 'sales' }), true);
eq('Meta Purchase: friends sale -> NOT sent', shouldSendMetaPurchase({ isComp: false, lane: 'friends' }), false);
eq('Meta Purchase: comp, default lane -> NOT sent', shouldSendMetaPurchase({ isComp: true, lane: 'sales' }), false);
eq('Meta Purchase: comp through friends -> NOT sent', shouldSendMetaPurchase({ isComp: true, lane: 'friends' }), false);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
