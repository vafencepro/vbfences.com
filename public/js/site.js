/* ============================================================
   VB Fences patches (form lead capture + Acuity redirect + tracking)
   ============================================================ */

/* ============================================================
   VB Fences — quote form → /api/lead capture → Acuity redirect
   On submit:
     1. Beacon full form data to /api/lead (Worker emails sales@ + KV backup)
     2. Pass name/email/phone to Acuity for pre-fill
     3. Redirect to scheduler
   The /api/lead beacon ensures we capture the lead even if the
   customer abandons the Acuity step.
   ============================================================ */
(function () {
  var SCHEDULER = 'https://vbfences.as.me/?appointmentType=category:Project%20Quotes';

  // Turnstile: paste the real sitekey after creating the widget
  // (dash.cloudflare.com → Turnstile → Add widget → vbfences.com, managed).
  // While this placeholder remains, no widget renders and nothing changes.
  var TURNSTILE_SITEKEY = 'REPLACE_WITH_TURNSTILE_SITEKEY';
  var tsWidgetId = null;

  function findQuoteForm() {
    // Explicit selectors only — no bare `form` fallback (avoids capturing
    // newsletter/search forms once those exist).
    return document.querySelector('form#quote-form, form[data-form="quote"], form[action*="quote"]');
  }

  function initTurnstile(form) {
    if (TURNSTILE_SITEKEY.indexOf('REPLACE_') === 0) return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    var slot = document.createElement('div');
    slot.className = 'turnstile-slot';
    form.insertBefore(slot, btn);
    window.__vbTsInit = function () {
      try {
        tsWidgetId = window.turnstile.render(slot, {
          sitekey: TURNSTILE_SITEKEY,
          action: 'turnstile-spin-v1'
        });
      } catch (e) {}
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__vbTsInit';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  function turnstileToken() {
    try {
      if (window.turnstile && tsWidgetId !== null) {
        return String(window.turnstile.getResponse(tsWidgetId) || '');
      }
    } catch (e) {}
    return '';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = findQuoteForm();
    if (!form) return;
    initTurnstile(form);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();

      var fd;
      try { fd = new FormData(form); } catch (e) { fd = null; }

      // ---- 1. Capture lead to /api/lead (fire-and-forget beacon) ----
      try {
        var leadPayload = JSON.stringify({
          name:    fd ? String(fd.get('name')    || '') : '',
          email:   fd ? String(fd.get('email')   || '') : '',
          phone:   fd ? String(fd.get('phone')   || '') : '',
          service: fd ? String(fd.get('service') || '') : '',
          address: fd ? String(fd.get('address') || '') : '',
          details: fd ? String(fd.get('details') || fd.get('message') || '') : '',
          website: fd ? String(fd.get('website') || '') : '',
          token: turnstileToken(),
          u: location.pathname,
          t: Date.now()
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/lead', new Blob([leadPayload], { type: 'application/json' }));
        } else {
          fetch('/api/lead', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: leadPayload,
            keepalive: true
          }).catch(function () {});
        }
      } catch (e) {}

      // ---- 2. Build Acuity prefill params ----
      var params = new URLSearchParams();
      if (fd) {
        var name = String(fd.get('name') || '').trim();
        if (name) {
          var first = name.split(' ')[0];
          var last  = name.split(' ').slice(1).join(' ');
          if (first) params.set('firstName', first);
          if (last)  params.set('lastName',  last);
        }
        var email = String(fd.get('email') || '').trim();
        if (email) params.set('email', email);
        var phone = String(fd.get('phone') || '').trim();
        if (phone) params.set('phone', phone);

        var notes = [];
        var svc = String(fd.get('service') || '').trim();
        if (svc) notes.push('Service: ' + svc);
        var addr = String(fd.get('address') || '').trim();
        if (addr) notes.push('Address: ' + addr);
        var msg = String(fd.get('details') || fd.get('message') || '').trim();
        if (msg) notes.push('Notes: ' + msg);
        if (notes.length) params.set('field:notes', notes.join(' | '));
      }

      // ---- 3. Redirect to scheduler ----
      var qs = params.toString();
      window.location.href = SCHEDULER + (qs ? '&' + qs : '');
    });
  });
})();

/* ============================================================
   VB Fences — conversion tracking
   Beacons phone_click, estimate_click, scheduler_click events.
   Form submit is no longer tracked here — /api/lead is the canonical
   conversion record.
   ============================================================ */
(function () {
  function track(name, props) {
    try {
      var payload = JSON.stringify({
        e: name,
        p: props || {},
        u: location.pathname,
        t: Date.now()
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/track', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) {}
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a, button');
    if (!a) return;
    var href = (a.getAttribute('href') || '').toLowerCase();
    var text = (a.textContent || '').toLowerCase();

    if (href.indexOf('tel:') === 0) {
      track('phone_click', { n: href.replace('tel:', '') });
    } else if (href.indexOf('vbfences.as.me') > -1) {
      track('scheduler_click', { href: a.getAttribute('href') });
    } else if (text.indexOf('schedule estimate') > -1 || text.indexOf('book free estimate') > -1 || text.indexOf('schedule online') > -1) {
      track('estimate_click', { text: text.slice(0, 40) });
    }
  }, { passive: true });
})();
