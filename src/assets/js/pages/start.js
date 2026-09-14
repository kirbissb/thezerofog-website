// /start/ - Enroll button -> Stripe Checkout, friends lane.
// Identical to sales.js except for the one thing that makes it a lane: the body names the
// source, and create-checkout.js turns that into metadata source=friends, a /start/thanks/
// success page and no Meta Purchase (memory zerofog-friends-lane-lena). Two files rather than a
// flag on one so the ad funnel's button never changes when this one does.
(function() {
  // EVERY Enroll button opens checkout, not only the one in the price box (CEO 08.09: the other
  // two scrolled to the price and looked broken). The page has three: two in the flow and one
  // inside the box; they are bound as a set, and the click handler below is written for any of
  // them - `btn` was a single element until 08.09.
  // Only the REAL buy buttons open a checkout, and they are the ones the generator emits with
  // href="#": the one inside the price card and the one in the sticky bar. Everything else that
  // wears .cta-btn is navigation - the mid-page "Enroll Now" buttons that point at #enroll, and
  // the button that opens the free dashboard.
  //
  // Until 2026-09-14 the handler was bound to every .cta-btn and called preventDefault, so href
  // was dead markup on all of them: a reader who pressed "Enroll Now" three thousand pixels above
  // the price went straight to Stripe without ever seeing what was included or what it cost.
  var all = Array.prototype.slice.call(document.querySelectorAll('.cta-btn'));
  var buttons = all.filter(function (b) { return b.getAttribute('href') === '#'; });
  var enrollish = all.filter(function (b) {
    var h = b.getAttribute('href');
    return h === '#' || h === '#enroll';
  });
  if (!buttons.length) return;

  // The error is shown under the button that was actually clicked, so a failure on the last
  // button does not put a message 3,000 pixels up the page where nobody sees it.
  function showError(btn, msg) {
    var errorEl = btn.parentNode.querySelector('.buyError');
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'buyError';
      errorEl.style.cssText = 'color:#e5484d;font-size:0.85rem;text-align:center;margin-top:12px;';
      btn.parentNode.insertBefore(errorEl, btn.nextSibling);
    }
    errorEl.textContent = msg;
  }
  function clearError(btn) {
    var errorEl = btn.parentNode.querySelector('.buyError');
    if (errorEl) errorEl.textContent = '';
  }

  function onClick(e) {
    var btn = e.currentTarget;
    e.preventDefault();

    var originalText = btn.textContent;
    clearError(btn);
    btn.classList.add('is-loading');
    btn.setAttribute('aria-disabled', 'true');
    btn.style.pointerEvents = 'none';
    btn.textContent = 'Loading…';

    function restore() {
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-disabled');
      btn.style.pointerEvents = '';
      btn.textContent = originalText;
    }

    fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The lane comes from the page, not from this file: the same letter is served at /start/
      // (friends, counted as Lena's) and /protocol/ (article readers, counted as ours). Hard-coding
      // "friends" here is what would have paid her half on every article sale.
      body: JSON.stringify({ source: window.ZF_LANE || 'friends' }),
    })
      .then(function(res) {
        if (!res.ok) throw new Error('error');
        return res.json();
      })
      .then(function(data) {
        if (!data || !data.url) throw new Error('no url');
        // Redirect to Stripe's hosted checkout.
        window.location.href = data.url;
      })
      .catch(function() {
        restore();
        showError(btn, 'Something went wrong, please try again.');
      });
  }

  // THE BAR'S BUTTON IS TWO BUTTONS, decided by where the reader is (CEO 14.09.2026).
  //
  // Registered BEFORE the checkout handler on purpose: listeners on the element itself run in
  // the order they were added - the capture flag buys nothing at the target - so binding this
  // after onClick would let the checkout fire anyway.
  //
  // The bar arrives one screen into a 5,500-word letter, and under 480px its price line loses its
  // tail to a media query - so it can be the only thing a reader has seen, showing "$67" and
  // nothing else. Sending that person to Stripe is the same fault as a mid-page Enroll going
  // straight to payment. Above the offer the bar scrolls to it; once the reader has passed the
  // card, they have seen the contents and the price, and the bar pays.
  var priceCard = document.getElementById('enroll');
  var barBtn = document.getElementById('zfBarBtn');
  if (priceCard && barBtn) {
    barBtn.addEventListener('click', function (e) {
      // Top of the card still below the fold = not read yet. Measured at click time rather than
      // tracked: one number, no state to drift.
      if (priceCard.getBoundingClientRect().top > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        priceCard.scrollIntoView();
        try { history.replaceState(null, '', '#enroll'); } catch (err) {}
      }
    }, true);
  }

  buttons.forEach(function (b) { b.addEventListener('click', onClick); });


  // THE STICKY BAR.
  //
  // A 5,500-word letter puts the first buy button thousands of pixels down, and a busy reader can
  // leave without ever learning there is one (CEO 08.09.2026). The bar carries the price and a
  // button - it is bound above like any other .cta-btn, so it opens the same checkout.
  //
  // It appears only after the reader is past the first screen, and it hides itself whenever a real
  // Enroll button is on screen, so the page never shows two at once. IntersectionObserver rather
  // than a scroll handler: the browser does the work off the main thread, and a long page scrolled
  // with a trackpad is exactly where a scroll listener costs something visible.
  var bar = document.getElementById('zfBar');
  if (!bar || !('IntersectionObserver' in window)) return;

  // The bar steps aside for any enroll-shaped button, not only the ones that buy - two
  // "Enroll Now" on one screen is the thing it exists to avoid. The dashboard button is not
  // one of them and must not hide the bar.
  var inFlow = enrollish.filter(function (b) { return !bar.contains(b); });

  // A SET of what is currently on screen, not a counter. A counter was the first version and it
  // drifted: enter and leave events do not always arrive in pairs when the page jumps (an anchor,
  // a programmatic scroll, a restored position), and one missed leave hides the bar for the rest
  // of the session with nothing to show for it. Membership is recomputed from each entry, so any
  // callback ordering lands on the same answer.
  var onScreen = [];

  function update() {
    var pastFirstScreen = window.scrollY > window.innerHeight * 0.8;
    bar.classList.toggle('is-shown', pastFirstScreen && onScreen.length === 0);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var i = onScreen.indexOf(e.target);
      if (e.isIntersecting && i === -1) onScreen.push(e.target);
      if (!e.isIntersecting && i !== -1) onScreen.splice(i, 1);
    });
    update();
  }, { rootMargin: '-10% 0px -10% 0px' });
  inFlow.forEach(function (b) { io.observe(b); });

  addEventListener('scroll', update, { passive: true });
  update();
})();
