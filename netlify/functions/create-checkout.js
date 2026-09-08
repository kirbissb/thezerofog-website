// Creates a Stripe Checkout Session (one-time payment) via the Stripe REST API
// using native fetch — no Stripe SDK / no npm dependencies. Returns the hosted
// checkout URL for the client to redirect to. Checkout collects email only
// (Stripe does this automatically); no name/address is collected.
//
// NOTE: Webhook handling / LMS enrollment is a SEPARATE later task — not here.

const ALLOWED_ORIGIN = 'https://thezerofog.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

// EU consumer-rights waiver (Art. 16(m), Directive 2011/83/EU): the buyer must
// actively consent to immediate delivery of digital content, waiving the 14-day
// withdrawal right. Requires the Terms of Service URL to be set in the Stripe
// Dashboard (Settings -> Business -> Public details); until it is set, Stripe
// rejects sessions with consent_collection, so we retry without it (see below).
// [attorney] exact waiver wording is on the review checklist.
const TOS_CONSENT_MESSAGE =
  'I request immediate access to the digital content and acknowledge that I ' +
  'thereby lose my EU 14-day right of withdrawal. This does not affect the ' +
  '30-day guarantee described in the [Refund Policy](https://thezerofog.com/refunds/).';

// Where a checkout was opened from, and therefore where its buyer lands afterwards.
//
// 'friends' is the lane for people forwarded a personal message by someone who knows the
// founders (memory zerofog-friends-lane-lena, plan T-081). Its tracking is the address itself:
// anything opened from /start/ is that lane, no code, no coupon, no visible referral. The lane
// differs from the ad funnel in exactly three places, all keyed off this one metadata value:
// the buyer lands on /start/thanks/ (the workshop recording, watched AFTER paying, instead of
// /welcome/), stripe-webhook.js sends no Purchase to Meta for it (buyers from Spain and Ukraine
// must not teach the optimizer before ads resume), and scripts/friends-report.mjs sums it for
// the monthly share. Everything else - price, enrollment, E14, the boards - is identical.
//
// Allow-listed, never echoed: a stranger's POST with a made-up source gets the default lane.
const LANES = {
  sales_page: { successPath: '/welcome/', cancelPath: '/sales/' },
  friends: { successPath: '/start/thanks/', cancelPath: '/start/' },
};

function laneFor(source) {
  return Object.prototype.hasOwnProperty.call(LANES, source) ? source : 'sales_page';
}

export function buildSessionParams(priceId, baseUrl, withTosConsent, compCoupon, source, withTax) {
  const lane = LANES[laneFor(source)];
  // Stripe expects bracket notation for nested and array params. URLSearchParams
  // encodes the literal {CHECKOUT_SESSION_ID} template braces as %7B...%7D,
  // which Stripe accepts and replaces server-side.
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${baseUrl}${lane.successPath}?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${baseUrl}${lane.cancelPath}`);
  // The lane, written server-side on a session Stripe then signs - the webhook trusts it.
  params.set('metadata[source]', laneFor(source));
  // Expire abandoned checkouts after 2 hours (Stripe allows 30min-24h, default 24h).
  // The `checkout.session.expired` webhook is what triggers the E18 abandoned-checkout
  // email — with the default expiry it would arrive a full day late.
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 2 * 60 * 60));
  // Adaptive Pricing presents the price in the buyer's local currency, and the
  // completed session then reports THAT currency and amount. stripe-webhook.js
  // compares both against EXPECTED_AMOUNT_TOTAL / EXPECTED_CURRENCY and returns
  // 200 (no retry) on a mismatch — so a non-USD buyer would pay and never be
  // enrolled, silently. Off here rather than in the Dashboard: this cannot be
  // undone by a stray click, and it shows up in a diff.
  params.set('adaptive_pricing[enabled]', 'false');
  if (withTosConsent) {
    params.set('consent_collection[terms_of_service]', 'required');
    params.set('custom_text[terms_of_service_acceptance][message]', TOS_CONSENT_MESSAGE);
  }
  // VAT. Stripe Tax works out the buyer's country and rate; the price carries
  // tax_behavior=inclusive, so an EU consumer is charged the $67 they were shown and the VAT is
  // carved out of it. That is what EU consumer law requires of a displayed price, and it is also
  // what keeps stripe-webhook.js's amount guard true: an exclusive price would charge 81.07 in
  // Spain, the guard would refuse the paid order, and the buyer would have no course.
  //
  // Sent only when the price is inclusive (taxIsSafeForPrice), and dropped by the retry in
  // createSession if the account is not set up for it yet. Same shape as the ToS retry above: the
  // feature turns itself on the moment the dashboards are finished, with no deploy.
  if (withTax) {
    params.set('automatic_tax[enabled]', 'true');
  }
  // A comped seat - see the GET branch in the handler. The coupon takes the price to zero,
  // and the metadata marker is what stripe-webhook.js checks before it lets a zero-amount
  // session through its amount guard. The marker is written HERE, server-side, on a session
  // Stripe then signs, so it cannot be forged by whoever opens the link.
  if (compCoupon) {
    params.set('discounts[0][coupon]', compCoupon);
    params.set('metadata[zf_comp]', 'granted');
    // A comp keeps the lane it was opened for, so a comped walk through /start/ lands on
    // /start/thanks/ and exercises the same webhook branch a paid friend would. `zf_comp` is
    // what marks it as a comp; `source` stays the lane.
    if (laneFor(source) === 'sales_page') params.set('metadata[source]', 'comp_link');
  }
  return params;
}

/**
 * Is the configured price safe to charge tax on top of?
 *
 * Only a price with tax_behavior=inclusive is: the buyer pays the $67 the page shows and the VAT
 * is carved out of it. With `exclusive` Stripe would ADD the VAT, so a Spanish consumer would see
 * 67 and be charged 81.07 - which EU price-display rules do not allow and which no line of copy on
 * the site prepares them for.
 *
 * So the tax flag is not a constant and not a deploy: it is read from the price itself. Today the
 * live price is exclusive and this returns false, so nothing changes. The moment STRIPE_PRICE_ID
 * points at the inclusive price, tax starts being collected with no code change - and if that env
 * var is ever pointed back at an exclusive price, tax stops again by itself.
 *
 * Cached per warm instance, and false on any failure: never let a lookup decide a sale.
 */
let priceIsInclusive = null;
let priceCheckedFor = null;

async function taxIsSafeForPrice(secretKey, priceId) {
  if (priceCheckedFor === priceId && priceIsInclusive !== null) return priceIsInclusive;
  try {
    const res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { Authorization: 'Bearer ' + secretKey },
    });
    if (!res.ok) {
      console.error('price lookup for tax behaviour returned', res.status, '- charging without tax');
      return false;
    }
    const price = await res.json();
    priceIsInclusive = price.tax_behavior === 'inclusive';
    priceCheckedFor = priceId;
    if (!priceIsInclusive) {
      console.warn(
        'Stripe Tax is NOT applied: price', priceId, 'has tax_behavior', price.tax_behavior,
        '- EU VAT is not being collected. Point STRIPE_PRICE_ID at a tax_behavior=inclusive price.'
      );
    }
    return priceIsInclusive;
  } catch (err) {
    console.error('price lookup failed, charging without tax:', err.message);
    return false;
  }
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Validate required server-side configuration.
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  const siteUrl = process.env.PUBLIC_SITE_URL;

  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY environment variable is not set');
    return serverConfigError();
  }
  if (!priceId) {
    console.error('STRIPE_PRICE_ID environment variable is not set');
    return serverConfigError();
  }
  if (!siteUrl) {
    console.error('PUBLIC_SITE_URL environment variable is not set');
    return serverConfigError();
  }

  // Normalize base URL (strip any trailing slash) so we build clean paths.
  const baseUrl = siteUrl.replace(/\/$/, '');

  // ---------------------------------------------------------------- comp link
  // One clickable link that opens a checkout already discounted to zero, for a person we
  // are giving the course to rather than selling it: a tester walking the funnel, or a
  // guest seat. It is a GET so it can be pasted into a message, and it redirects straight
  // into Stripe's own checkout - so the tester sees the real page, presses the real button
  // and travels the real webhook, with no card and no money.
  //
  // Gated on COMP_ACCESS_KEY, compared in full. Nothing about the normal POST path changes,
  // and no promotion-code field ever appears for a real buyer.
  if (req.method === 'GET') {
    const query = new URL(req.url).searchParams;
    const key = query.get('key') || '';
    const compSource = query.get('source') || '';
    const expected = process.env.COMP_ACCESS_KEY || '';
    const coupon = process.env.COMP_COUPON_ID || '';
    if (!expected || !coupon || key !== expected) {
      // Deliberately the same answer as a wrong method: a probe learns nothing about
      // whether comp links exist at all.
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const made = await createSession(secretKey, priceId, baseUrl, coupon, compSource);
    if (!made.url) {
      // Whoever holds the key is us, and a silent 500 on an admin link is a dead end -
      // Stripe's own sentence is what tells you which dashboard switch is off.
      return new Response(JSON.stringify({ error: 'Comp link failed', stripe: made.error }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // NOT a 303. Netlify appends the incoming query string to a redirect Location, which put
    // COMP_ACCESS_KEY inside the checkout.stripe.com URL - our admin key in a third party's
    // logs and in the tester's history. A one-line page hands the browser the URL Stripe gave
    // us and nothing else, and the visible link is there for anyone with scripts off.
    const safe = made.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Opening checkout</title>` +
      `<body style="font:16px/1.5 system-ui;padding:40px;text-align:center">` +
      `<p>Opening checkout...</p><p><a href="${safe}">Continue to checkout</a></p>` +
      `<script>location.replace(${JSON.stringify(made.url)})</script>`,
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } }
    );
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // The only thing read from the body. Anything but an allow-listed lane is the default one.
  let source = '';
  try {
    const body = await req.json();
    if (body && typeof body.source === 'string') source = body.source;
  } catch {
    // An empty or non-JSON body is the sales page's own call ('{}' until 2026-09-07) - default lane.
  }

  const { url } = await createSession(secretKey, priceId, baseUrl, null, source);
  if (!url) {
    return new Response(JSON.stringify({ error: 'Could not create checkout session' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, url }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Ask Stripe for a checkout session and return its URL, or null on any failure.
 *
 * One body for both entrances - the sales page's POST and the comp link's GET - so the
 * tester travels the same session shape a buyer does, minus the price. Errors are logged
 * in full server-side and never leak to the caller.
 */
async function createSession(secretKey, priceId, baseUrl, compCoupon, source) {
  // A zero-total session needs Stripe API 2023-08-16 or later ("no-cost orders"); this
  // account predates that, so its default version would reject the comp. Pinned on the comp
  // call ONLY - the selling path keeps the exact version that has already taken a real sale,
  // and is not moved for the sake of a tester.
  const versionHeader = compCoupon ? { 'Stripe-Version': '2023-08-16' } : {};
  try {
    // Two optional pieces can each be refused by an account that is not configured for them: the
    // EU withdrawal-right waiver (needs a Terms of Service URL) and Stripe Tax (needs an origin
    // address and a registration). Neither is worth losing a sale over, so each is dropped on the
    // error that names it and the call is retried. Both start ON, so the day the dashboard is
    // finished they simply begin working.
    let withTos = true;
    let withTax = await taxIsSafeForPrice(secretKey, priceId);
    let stripeRes;
    let session;

    for (let attempt = 0; attempt < 3; attempt++) {
      stripeRes = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + secretKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...versionHeader,
        },
        body: buildSessionParams(priceId, baseUrl, withTos, compCoupon, source, withTax).toString(),
      });
      session = await stripeRes.json();
      if (stripeRes.ok && !session.error) break;

      const msg = session.error?.message || '';
      if (withTos && /terms of service/i.test(msg)) {
        console.error('EU ToS consent rejected by Stripe (is the Terms of Service URL set in Dashboard -> Settings -> Business?). Retrying WITHOUT the withdrawal-right waiver:', msg);
        withTos = false;
        continue;
      }
      if (withTax && /tax|address/i.test(msg)) {
        console.error('Stripe Tax rejected (is the origin address set and a registration added in Dashboard -> Tax?). Retrying WITHOUT automatic tax - EU VAT is NOT being collected on this sale:', msg);
        withTax = false;
        continue;
      }
      break;
    }

    if (!stripeRes.ok || session.error) {
      console.error('Stripe checkout session error:', stripeRes.status, session.error || session);
      return { error: session.error?.message || `Stripe returned ${stripeRes.status}` };
    }
    if (!session.url) {
      console.error('Stripe response missing session url:', session);
      return { error: 'Stripe returned a session with no url' };
    }
    return { url: session.url };
  } catch (err) {
    console.error('Failed to create Stripe checkout session:', err);
    return { error: err.message };
  }
}

function serverConfigError() {
  return new Response(JSON.stringify({ error: 'Server configuration error' }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
