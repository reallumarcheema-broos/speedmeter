/* SpeedMeter client — latency, download and upload measurement. */
(() => {
  'use strict';

  const CONFIG = {
    pingProbes: 12,
    pingTimeoutMs: 4000,
    download: {
      streams: 4,
      durationMs: 10000,
      warmupMs: 2000,
      // What we would ask for given a backend with no per-request cap. The
      // real size is the smaller of this and the limit /api/info reports.
      preferredRequestBytes: 64 * 1024 * 1024,
    },
    upload: {
      streams: 3,
      durationMs: 10000,
      warmupMs: 2500,
      preferredBlobBytes: 8 * 1024 * 1024,
    },
    // Used only if /api/info could not be read. Small enough to work on a
    // serverless host, where request and response bodies are tightly capped.
    fallbackLimits: {
      maxDownloadBytes: 4 * 1024 * 1024,
      maxUploadBytes: 3 * 1024 * 1024,
    },
    sampleIntervalMs: 100,
    displayWindowMs: 700,
    historyLimit: 10,
    historyKey: 'speedmeter.history.v1',
    themeKey: 'speedmeter.theme',
  };

  // Gauge stops, spaced evenly around the dial so the low end stays readable.
  const GAUGE_STOPS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];

  const API_BASE = (() => {
    const override = new URLSearchParams(location.search).get('api');
    if (override) return override.replace(/\/$/, '');
    return location.origin;
  })();

  const $ = (id) => document.getElementById(id);

  const els = {
    startBtn: $('startBtn'),
    againBtn: $('againBtn'),
    shareBtn: $('shareBtn'),
    phaseLabel: $('phaseLabel'),
    liveValue: $('liveValue'),
    statusLine: $('statusLine'),
    gaugeFill: $('gaugeFill'),
    gaugeMarker: $('gaugeMarker'),
    gaugeTicks: $('gaugeTicks'),
    download: $('downloadValue'),
    upload: $('uploadValue'),
    ping: $('pingValue'),
    jitter: $('jitterValue'),
    verdict: $('verdict'),
    metaServer: $('metaServer'),
    metaIp: $('metaIp'),
    metaProtocol: $('metaProtocol'),
    history: $('history'),
    historyBody: $('historyBody'),
    clearHistory: $('clearHistory'),
    themeToggle: $('themeToggle'),
  };

  const state = {
    running: false,
    abort: null,
    results: null,
    limits: null,
  };

  /**
   * Sizes the transfers to whatever the backend can actually serve.
   *
   * A self-hosted server streams as much as we ask for, so few large requests
   * are ideal. A serverless platform caps each request at a few megabytes, so
   * the same stage has to be made of many small ones — and because every
   * request boundary is a brief gap in the flow, more connections run in
   * parallel to keep the link saturated.
   */
  function transferPlan() {
    const limits = state.limits || CONFIG.fallbackLimits;
    const requestBytes = Math.min(
      CONFIG.download.preferredRequestBytes,
      limits.maxDownloadBytes || CONFIG.fallbackLimits.maxDownloadBytes,
    );
    const blobBytes = Math.min(
      CONFIG.upload.preferredBlobBytes,
      limits.maxUploadBytes || CONFIG.fallbackLimits.maxUploadBytes,
    );
    return {
      requestBytes,
      blobBytes,
      downloadStreams: requestBytes < 16 * 1024 * 1024 ? 8 : CONFIG.download.streams,
      uploadStreams: blobBytes < 4 * 1024 * 1024 ? 6 : CONFIG.upload.streams,
    };
  }

  /* ---------------------------------------------------------------- utils */

  const nonce = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolves after `ms`, or as soon as `signal` aborts — whichever is first. */
  function sleepOrAbort(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  function formatSpeed(mbps) {
    if (!Number.isFinite(mbps)) return '0.00';
    if (mbps >= 100) return mbps.toFixed(0);
    if (mbps >= 10) return mbps.toFixed(1);
    return mbps.toFixed(2);
  }

  function formatMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
  }

  /** Maps a speed in Mbps onto 0..1 of the dial using the piecewise stops. */
  function speedToFraction(mbps) {
    const value = Math.max(0, mbps || 0);
    const last = GAUGE_STOPS.length - 1;
    if (value >= GAUGE_STOPS[last]) return 1;
    for (let i = 0; i < last; i += 1) {
      const lo = GAUGE_STOPS[i];
      const hi = GAUGE_STOPS[i + 1];
      if (value <= hi) {
        const within = (value - lo) / (hi - lo);
        return (i + within) / last;
      }
    }
    return 1;
  }

  /* ---------------------------------------------------------------- gauge */

  const gauge = {
    length: 0,
    init() {
      this.length = els.gaugeFill.getTotalLength();
      els.gaugeFill.style.strokeDasharray = `${this.length}`;
      this.set(0);
      this.renderTicks();
    },
    renderTicks() {
      const svgNS = 'http://www.w3.org/2000/svg';
      const frag = document.createDocumentFragment();
      GAUGE_STOPS.forEach((stop, index) => {
        const fraction = index / (GAUGE_STOPS.length - 1);
        const angle = (-90 + fraction * 180) * (Math.PI / 180);
        const label = document.createElementNS(svgNS, 'text');
        const radius = 140; // Outside the arc, leaving the dial clear.
        // Labels near the ends are nudged downwards so the marker, which
        // reaches the same height, never sits on top of them.
        const drop = 3.5 + 9 * Math.abs(Math.sin(angle));
        label.setAttribute('x', (160 + radius * Math.sin(angle)).toFixed(1));
        label.setAttribute('y', (176 - radius * Math.cos(angle) + drop).toFixed(1));
        label.textContent = String(stop);
        frag.appendChild(label);
      });
      els.gaugeTicks.appendChild(frag);
    },
    set(mbps) {
      const fraction = speedToFraction(mbps);
      els.gaugeFill.style.strokeDashoffset = `${this.length * (1 - fraction)}`;
      els.gaugeMarker.style.transform = `rotate(${(-90 + fraction * 180).toFixed(2)}deg)`;
      els.liveValue.textContent = formatSpeed(mbps);
    },
  };

  /* ------------------------------------------------------------ transport */

  async function fetchJson(pathname, options) {
    const response = await fetch(`${API_BASE}${pathname}`, { cache: 'no-store', ...options });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  }

  async function loadServerInfo() {
    try {
      const info = await fetchJson('/api/info');
      if (info.limits) state.limits = info.limits;
      els.metaServer.textContent = info.server || '—';
      els.metaIp.textContent = info.ip || '—';
      els.metaProtocol.textContent = info.protocol || '—';
      return info;
    } catch {
      els.metaServer.textContent = 'unreachable';
      return null;
    }
  }

  /* ------------------------------------------------------------ ping test */

  async function measureLatency(signal) {
    const samples = [];

    // One warm-up probe so connection setup is not counted as latency.
    try {
      await fetch(`${API_BASE}/api/ping?t=${nonce()}`, { cache: 'no-store', signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Cannot reach the speed test server.');
    }

    for (let i = 0; i < CONFIG.pingProbes; i += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const timeout = AbortSignal.timeout
        ? AbortSignal.timeout(CONFIG.pingTimeoutMs)
        : undefined;
      const started = performance.now();
      try {
        await fetch(`${API_BASE}/api/ping?t=${nonce()}`, {
          cache: 'no-store',
          signal: timeout ? anySignal([signal, timeout]) : signal,
        });
        samples.push(performance.now() - started);
      } catch (error) {
        if (error.name === 'AbortError' && signal.aborted) throw error;
        // A dropped probe is data too: skip it and keep going.
      }
      setProgress(`Measuring latency… ${i + 1}/${CONFIG.pingProbes}`);
      await sleep(40);
    }

    if (samples.length < 2) throw new Error('Latency probes failed — check your connection.');

    const ping = Math.min(...samples);
    let jitterTotal = 0;
    for (let i = 1; i < samples.length; i += 1) {
      jitterTotal += Math.abs(samples[i] - samples[i - 1]);
    }
    const jitter = jitterTotal / (samples.length - 1);

    return { ping, jitter, samples };
  }

  /** Minimal AbortSignal.any shim so we work on slightly older browsers. */
  function anySignal(signals) {
    if (AbortSignal.any) return AbortSignal.any(signals);
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }

  /* --------------------------------------------------------- measurement */

  /**
   * Runs a throughput stage: workers add to a shared byte counter while a
   * sampler turns that into a live reading and a final average that ignores
   * the warm-up period (TCP slow start, connection setup, ramp-up).
   */
  function createMeter({ durationMs, warmupMs, onLive }) {
    const samples = [];
    let bytes = 0;
    let startedAt = 0;
    let timer = null;

    return {
      add(count) {
        bytes += count;
      },
      start() {
        startedAt = performance.now();
        samples.push({ at: startedAt, bytes: 0 });
        timer = setInterval(() => {
          const now = performance.now();
          samples.push({ at: now, bytes });

          // Live reading over a short trailing window keeps the needle lively
          // without letting a single stalled chunk dominate.
          const windowStart = now - CONFIG.displayWindowMs;
          let reference = samples[0];
          for (let i = samples.length - 1; i >= 0; i -= 1) {
            if (samples[i].at <= windowStart) {
              reference = samples[i];
              break;
            }
          }
          const elapsed = now - reference.at;
          if (elapsed > 0) onLive(toMbps(bytes - reference.bytes, elapsed));
        }, CONFIG.sampleIntervalMs);
      },
      stop() {
        if (timer !== null) clearInterval(timer);
        timer = null;
        const endedAt = performance.now();
        samples.push({ at: endedAt, bytes });

        // Average across the steady-state window only.
        const cutoff = startedAt + warmupMs;
        let baseline = samples[0];
        for (const sample of samples) {
          if (sample.at <= cutoff) baseline = sample;
          else break;
        }
        const elapsed = endedAt - baseline.at;
        const measured = bytes - baseline.bytes;
        if (elapsed < 200 || measured <= 0) {
          // The stage was too short to trim; fall back to the whole run.
          const whole = endedAt - startedAt;
          return { mbps: whole > 0 ? toMbps(bytes, whole) : 0, bytes };
        }
        return { mbps: toMbps(measured, elapsed), bytes };
      },
      get durationMs() {
        return durationMs;
      },
    };
  }

  function toMbps(bytes, ms) {
    if (ms <= 0) return 0;
    return (bytes * 8) / (ms / 1000) / 1e6;
  }

  /* -------------------------------------------------------- download test */

  async function measureDownload(signal, plan) {
    const { durationMs, warmupMs } = CONFIG.download;
    const { requestBytes, downloadStreams: streams } = plan;
    const meter = createMeter({ durationMs, warmupMs, onLive: (mbps) => gauge.set(mbps) });
    const controller = new AbortController();
    const stageSignal = anySignal([signal, controller.signal]);

    const worker = async () => {
      while (!stageSignal.aborted) {
        let response;
        try {
          response = await fetch(
            `${API_BASE}/api/download?bytes=${requestBytes}&t=${nonce()}`,
            { cache: 'no-store', signal: stageSignal },
          );
        } catch {
          return; // Stage ended or the connection dropped; other streams carry on.
        }
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            meter.add(value.byteLength);
          }
        } catch {
          return;
        } finally {
          reader.cancel().catch(() => {});
        }
      }
    };

    meter.start();
    const workers = Array.from({ length: streams }, worker);
    await sleepOrAbort(durationMs, signal);
    controller.abort();
    await Promise.allSettled(workers);

    const result = meter.stop();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (result.bytes === 0) throw new Error('Download test received no data.');
    return result;
  }

  /* ---------------------------------------------------------- upload test */

  function makeRandomBlob(size) {
    const buffer = new Uint8Array(size);
    const step = 65536; // crypto.getRandomValues caps at 64 KiB per call.
    for (let offset = 0; offset < size; offset += step) {
      crypto.getRandomValues(buffer.subarray(offset, Math.min(offset + step, size)));
    }
    return new Blob([buffer], { type: 'application/octet-stream' });
  }

  async function measureUpload(signal, plan) {
    const { durationMs, warmupMs } = CONFIG.upload;
    const { blobBytes, uploadStreams: streams } = plan;
    const meter = createMeter({ durationMs, warmupMs, onLive: (mbps) => gauge.set(mbps) });
    const payload = makeRandomBlob(blobBytes);
    const active = new Set();
    let stopped = false;

    // XHR is used instead of fetch because only XHR reports real upload
    // progress; fetch would only tell us when the whole body has been sent.
    const sendOnce = () => new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      active.add(xhr);
      let lastLoaded = 0;

      xhr.upload.addEventListener('progress', (event) => {
        meter.add(event.loaded - lastLoaded);
        lastLoaded = event.loaded;
      });
      const finish = () => {
        active.delete(xhr);
        resolve();
      };
      xhr.addEventListener('load', finish);
      xhr.addEventListener('error', finish);
      xhr.addEventListener('abort', finish);

      xhr.open('POST', `${API_BASE}/api/upload?t=${nonce()}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(payload);
    });

    const worker = async () => {
      while (!stopped && !signal.aborted) {
        await sendOnce();
      }
    };

    meter.start();
    const workers = Array.from({ length: streams }, worker);
    await sleepOrAbort(durationMs, signal);
    stopped = true;
    for (const xhr of active) xhr.abort();
    await Promise.allSettled(workers);

    const result = meter.stop();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (result.bytes === 0) throw new Error('Upload test sent no data.');
    return result;
  }

  /* ---------------------------------------------------------------- flow */

  function setPhase(label) {
    els.phaseLabel.textContent = label;
  }

  function setProgress(message, isError = false) {
    els.statusLine.textContent = message;
    els.statusLine.classList.toggle('is-error', isError);
  }

  function markActive(metric) {
    document.querySelectorAll('.result-card').forEach((card) => {
      card.classList.toggle('is-active', card.dataset.metric === metric);
    });
  }

  function resetResults() {
    els.download.textContent = '—';
    els.upload.textContent = '—';
    els.ping.textContent = '—';
    els.jitter.textContent = '—';
    els.verdict.hidden = true;
    els.shareBtn.hidden = true;
    els.againBtn.hidden = true;
    gauge.set(0);
  }

  function describe(results) {
    const { download, ping, jitter } = results;
    const parts = [];

    if (download >= 100) parts.push('plenty for 4K streaming on several devices at once');
    else if (download >= 25) parts.push('comfortable for 4K video and video calls');
    else if (download >= 10) parts.push('fine for HD video and everyday browsing');
    else if (download >= 5) parts.push('enough for HD video on one device');
    else parts.push('tight for video — expect buffering on HD streams');

    if (ping <= 30 && jitter <= 10) parts.push('responsive enough for gaming and calls');
    else if (ping <= 80) parts.push('fine for calls, a little slow for competitive gaming');
    else parts.push('high latency, which can make calls and gaming feel laggy');

    return parts;
  }

  function showVerdict(results) {
    const parts = describe(results);
    els.verdict.innerHTML =
      `<strong>${formatSpeed(results.download)} Mbps down · ${formatSpeed(results.upload)} Mbps up</strong> — ` +
      `${parts.join(', and ')}.`;
    els.verdict.hidden = false;
  }

  async function runTest() {
    if (state.running) return;

    // Tells ads.js to hold any pending ad load: creatives fetched during the
    // measurement would steal bandwidth from it and depress the result.
    document.dispatchEvent(new CustomEvent('speedmeter:teststart'));

    state.running = true;
    state.abort = new AbortController();
    const { signal } = state.abort;

    resetResults();
    els.startBtn.disabled = false;
    els.startBtn.classList.add('is-abort');
    els.startBtn.querySelector('.start-btn-text').textContent = 'Stop';

    try {
      // Awaited: the reported limits decide how the transfer stages are sized.
      await loadServerInfo();
      const plan = transferPlan();

      setPhase('Ping');
      markActive('ping');
      setProgress('Measuring latency…');
      const latency = await measureLatency(signal);
      els.ping.textContent = formatMs(latency.ping);
      els.jitter.textContent = formatMs(latency.jitter);

      setPhase('Download');
      markActive('download');
      setProgress(`Measuring download over ${plan.downloadStreams} connections…`);
      const download = await measureDownload(signal, plan);
      els.download.textContent = formatSpeed(download.mbps);
      gauge.set(download.mbps);

      await sleep(500);

      setPhase('Upload');
      markActive('upload');
      setProgress(`Measuring upload over ${plan.uploadStreams} connections…`);
      gauge.set(0);
      const upload = await measureUpload(signal, plan);
      els.upload.textContent = formatSpeed(upload.mbps);
      gauge.set(upload.mbps);

      const results = {
        download: download.mbps,
        upload: upload.mbps,
        ping: latency.ping,
        jitter: latency.jitter,
        at: new Date().toISOString(),
      };
      state.results = results;

      markActive(null);
      setPhase('Result');
      setProgress('Test complete.');
      showVerdict(results);
      saveHistory(results);
      els.shareBtn.hidden = false;
      els.againBtn.hidden = false;
    } catch (error) {
      markActive(null);
      if (error.name === 'AbortError') {
        setPhase('Stopped');
        setProgress('Test stopped.');
      } else {
        setPhase('Error');
        setProgress(error.message || 'The test could not be completed.', true);
      }
      els.againBtn.hidden = false;
    } finally {
      state.running = false;
      state.abort = null;
      document.dispatchEvent(new CustomEvent('speedmeter:testend'));
      els.startBtn.disabled = false;
      els.startBtn.classList.remove('is-abort');
      els.startBtn.querySelector('.start-btn-text').textContent = 'Test again';
    }
  }

  /* ------------------------------------------------------------- history */

  function readHistory() {
    try {
      const raw = localStorage.getItem(CONFIG.historyKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory(entry) {
    try {
      const entries = [entry, ...readHistory()].slice(0, CONFIG.historyLimit);
      localStorage.setItem(CONFIG.historyKey, JSON.stringify(entries));
      renderHistory();
    } catch {
      /* Storage may be unavailable (private mode); results still show above. */
    }
  }

  function renderHistory() {
    const entries = readHistory();
    els.history.hidden = entries.length === 0;
    els.historyBody.replaceChildren();

    for (const entry of entries) {
      const row = document.createElement('tr');
      const when = new Date(entry.at);
      const cells = [
        Number.isNaN(when.getTime()) ? '—' : when.toLocaleString(),
        `${formatSpeed(entry.download)} Mbps`,
        `${formatSpeed(entry.upload)} Mbps`,
        `${formatMs(entry.ping)} ms`,
        `${formatMs(entry.jitter)} ms`,
      ];
      for (const text of cells) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.appendChild(cell);
      }
      els.historyBody.appendChild(row);
    }
  }

  /* --------------------------------------------------------------- theme */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(CONFIG.themeKey, theme);
    } catch {
      /* ignore */
    }
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem(CONFIG.themeKey);
    } catch {
      /* ignore */
    }
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(stored || (prefersLight ? 'light' : 'dark'));
  }

  /* --------------------------------------------------------------- wiring */

  els.startBtn.addEventListener('click', () => {
    if (state.running) {
      state.abort?.abort();
      return;
    }
    runTest();
  });

  els.againBtn.addEventListener('click', () => runTest());

  els.shareBtn.addEventListener('click', async () => {
    if (!state.results) return;
    const r = state.results;
    const text =
      `SpeedMeter result — ${new Date(r.at).toLocaleString()}\n` +
      `Download: ${formatSpeed(r.download)} Mbps\n` +
      `Upload:   ${formatSpeed(r.upload)} Mbps\n` +
      `Ping:     ${formatMs(r.ping)} ms\n` +
      `Jitter:   ${formatMs(r.jitter)} ms`;
    try {
      await navigator.clipboard.writeText(text);
      els.shareBtn.textContent = 'Copied!';
      setTimeout(() => { els.shareBtn.textContent = 'Copy results'; }, 1800);
    } catch {
      setProgress('Clipboard unavailable — select the numbers above to copy them.');
    }
  });

  els.clearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem(CONFIG.historyKey);
    } catch {
      /* ignore */
    }
    renderHistory();
  });

  els.themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  initTheme();
  gauge.init();
  renderHistory();
  loadServerInfo();
})();
