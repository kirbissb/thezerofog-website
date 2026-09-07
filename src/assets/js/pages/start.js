// /start/ - Enroll button -> Stripe Checkout, friends lane.
// Identical to sales.js except for the one thing that makes it a lane: the body names the
// source, and create-checkout.js turns that into metadata source=friends, a /start/thanks/
// success page and no Meta Purchase (memory zerofog-friends-lane-lena). Two files rather than a
// flag on one so the ad funnel's button never changes when this one does.
(function() {
  var btn = document.getElementById('buyBtn');
  if (!btn) return;

  // Inline error element, inserted right after the button. We do not alter the
  // sales.njk markup, so the error node is created on demand here.
  var errorEl = null;
  function showError(msg) {
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.id = 'buyError';
      errorEl.style.cssText = 'color:#e5484d;font-size:0.85rem;text-align:center;margin-top:12px;';
      btn.parentNode.insertBefore(errorEl, btn.nextSibling);
    }
    errorEl.textContent = msg;
  }
  function clearError() {
    if (errorEl) errorEl.textContent = '';
  }

  btn.addEventListener('click', function(e) {
    e.preventDefault();

    var originalText = btn.textContent;
    clearError();
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
        showError('Something went wrong, please try again.');
      });
  });
})();
