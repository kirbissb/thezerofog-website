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
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.cta-btn'));
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
      body: JSON.stringify({ source: "friends" }),
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

  var inFlow = buttons.filter(function (b) { return !bar.contains(b); });
  var visible = 0;

  function update() {
    var pastFirstScreen = window.scrollY > window.innerHeight * 0.8;
    bar.classList.toggle('is-shown', pastFirstScreen && visible === 0);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible += e.isIntersecting ? 1 : -1; });
    if (visible < 0) visible = 0;
    update();
  }, { rootMargin: '-10% 0px -10% 0px' });
  inFlow.forEach(function (b) { io.observe(b); });

  addEventListener('scroll', update, { passive: true });
  update();
})();
