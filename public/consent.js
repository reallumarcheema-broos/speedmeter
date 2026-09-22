/*
 * Consent banner.
 *
 * Advertising storage defaults to denied for every visitor (the default is set
 * inline in <head> before the AdSense loader), so nothing personalised is
 * stored until someone accepts. Declining is not a dead end: ads still serve,
 * non-personalised.
 *
 * NOTE: for EEA/UK traffic Google requires a *certified* CMP. This banner is a
 * sensible baseline, not a certified one — enable Privacy & messaging in the
 * AdSense dashboard to meet that requirement. See the README.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'speedmeter.consent.v1';
  const site = window.SPEEDMETER_SITE || {};

  function read() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function write(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* Private mode: the banner simply reappears next visit. */
    }
  }

  function apply(choice) {
    const granted = choice === 'granted' ? 'granted' : 'denied';
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', {
        ad_storage: granted,
        ad_user_data: granted,
        ad_personalization: granted,
        analytics_storage: granted,
      });
    }
    document.dispatchEvent(new CustomEvent('speedmeter:consent', { detail: { choice: granted } }));
  }

  function dismiss(banner) {
    banner.remove();
    document.body.classList.remove('has-consent-banner');
  }

  function render() {
    const banner = document.createElement('div');
    banner.className = 'consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML = `
      <div class="consent-inner">
        <div class="consent-text">
          <strong>We use cookies for advertising.</strong>
          <p>This site is free because of ads. With your consent, Google and its partners may use
          cookies to personalise them. Decline and you will still see ads, just less relevant ones.
          Your speed test results are never shared either way &mdash; see our
          <a href="/privacy">privacy policy</a>.</p>
        </div>
        <div class="consent-actions">
          <button type="button" class="ghost-btn" data-consent="denied">Decline</button>
          <button type="button" class="start-btn consent-accept" data-consent="granted">Accept</button>
        </div>
      </div>`;

    banner.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-consent]')?.dataset.consent;
      if (!choice) return;
      write(choice);
      apply(choice);
      dismiss(banner);
    });

    document.body.appendChild(banner);
    document.body.classList.add('has-consent-banner');
  }

  const stored = read();
  if (stored) {
    apply(stored);
  } else if (site.adsense && site.adsense.client) {
    // Nothing to consent to until ads are actually configured.
    render();
  }

  // Footer link on every page, so the choice can always be revisited.
  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.querySelector('.footer-nav');
    if (!nav || !site.adsense || !site.adsense.client) return;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Cookie settings';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (!document.querySelector('.consent-banner')) render();
    });
    nav.appendChild(link);
  });
})();
