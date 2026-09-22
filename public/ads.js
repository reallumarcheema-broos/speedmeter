/*
 * Ad slot loader.
 *
 * The one rule that matters here: never let an ad load while a speed test is
 * running. An ad fetching a few hundred kilobytes of creative during the
 * measurement window competes for exactly the bandwidth the meter is trying to
 * measure — but those bytes are not counted by the meter, so the reported speed
 * comes out low. Accuracy is the product; the ads wait.
 *
 * app.js dispatches speedmeter:teststart and speedmeter:testend, which this
 * module uses to hold and release the queue.
 */
(() => {
  'use strict';

  const site = window.SPEEDMETER_SITE || {};
  const adsense = site.adsense || {};
  const SLOTS = adsense.slots || {};

  // Short settle delay on pages with the tester, so a visitor who clicks Start
  // immediately is never racing an in-flight ad request.
  const INITIAL_DELAY_MS = document.getElementById('startBtn') ? 1200 : 0;

  const pending = [];
  let testRunning = false;
  let settled = false;

  function slotId(name) {
    const id = SLOTS[name];
    return typeof id === 'string' && /^\d{6,20}$/.test(id) ? id : '';
  }

  /** Builds the <ins> AdSense expects, plus the label that keeps ads distinguishable. */
  function fill(container) {
    const name = container.dataset.adSlot;
    const id = slotId(name);
    if (!id) return false;

    const label = document.createElement('span');
    label.className = 'ad-label';
    label.textContent = 'Advertisement';

    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', adsense.client);
    ins.setAttribute('data-ad-slot', id);
    ins.setAttribute('data-ad-format', container.dataset.adFormat || 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');

    container.append(label, ins);
    container.classList.add('is-filled');

    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      return true;
    } catch {
      container.classList.remove('is-filled');
      container.replaceChildren();
      return false;
    }
  }

  function flush() {
    if (testRunning || !settled) return;
    while (pending.length > 0) {
      fill(pending.shift());
    }
  }

  function init() {
    // With no publisher id or no slot ids the containers stay empty and
    // collapsed, so the layout has no holes in it during development.
    if (!adsense.client) return;

    for (const container of document.querySelectorAll('.ad-slot')) {
      if (slotId(container.dataset.adSlot)) pending.push(container);
    }
    if (pending.length === 0) return;

    setTimeout(() => {
      settled = true;
      flush();
    }, INITIAL_DELAY_MS);
  }

  document.addEventListener('speedmeter:teststart', () => {
    testRunning = true;
  });

  document.addEventListener('speedmeter:testend', () => {
    testRunning = false;
    flush();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
