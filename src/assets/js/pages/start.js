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
})();
