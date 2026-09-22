'use strict';

/**
 * SpeedMeter - a dependency-free HTTP server that serves the web client and
 * the endpoints the browser needs to measure latency, download and upload
 * throughput.
 *
 * Endpoints:
 *   GET  /api/ping?t=<nonce>       -> 204, used for latency / jitter probes
 *   GET  /api/download?bytes=<n>   -> <n> bytes of incompressible payload
 *   POST /api/upload               -> drains the body, replies with byte count
 *   GET  /api/info                 -> client IP, server name, limits
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = process.env.SITE_CONFIG || path.join(__dirname, 'site.config.json');

const DEFAULT_CONFIG = {
  siteName: 'SpeedMeter',
  siteUrl: 'http://localhost:3000',
  tagline: 'Test your internet speed',
  contactEmail: '',
  operator: 'SpeedMeter',
  operatorLocation: '',
  serverName: 'SpeedMeter (self-hosted)',
  adsense: { client: '', slots: {} },
};

/**
 * Site settings come from site.config.json so the publisher id, canonical
 * host and contact address live in one place instead of being copied into
 * every page. Environment variables win, which keeps deployments flexible.
 */
function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // No config file is fine; the defaults keep the site usable locally.
  }

  const config = { ...DEFAULT_CONFIG, ...fileConfig };
  config.adsense = { ...DEFAULT_CONFIG.adsense, ...(fileConfig.adsense || {}) };
  config.adsense.slots = { ...(fileConfig.adsense && fileConfig.adsense.slots) };

  if (process.env.SITE_URL) config.siteUrl = process.env.SITE_URL;
  if (process.env.SITE_NAME) config.siteName = process.env.SITE_NAME;
  if (process.env.CONTACT_EMAIL) config.contactEmail = process.env.CONTACT_EMAIL;
  if (process.env.ADSENSE_CLIENT) config.adsense.client = process.env.ADSENSE_CLIENT;
  if (process.env.SPEEDMETER_SERVER_NAME) config.serverName = process.env.SPEEDMETER_SERVER_NAME;

  config.siteUrl = String(config.siteUrl || '').replace(/\/$/, '');
  return config;
}

const CONFIG = loadConfig();

/** A publisher id is required before any ad code or ads.txt is emitted. */
const ADSENSE_CLIENT = /^ca-pub-\d{10,20}$/.test(CONFIG.adsense.client || '')
  ? CONFIG.adsense.client
  : '';

const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB per request
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024; // 256 MiB per request
const CHUNK_SIZE = 256 * 1024;

// A block of random bytes reused for every download. Random data keeps any
// transparent compression on the path from inflating the measured speed, and
// reusing one block keeps the server cheap under parallel streams.
const RANDOM_BLOCK = crypto.randomBytes(4 * 1024 * 1024);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
};

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': '*',
  };
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const addr = req.socket.remoteAddress || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    ...NO_STORE,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handlePing(req, res) {
  res.writeHead(204, { ...corsHeaders(req), ...NO_STORE });
  res.end();
}

/**
 * Streams the requested number of bytes, respecting backpressure so the
 * measurement reflects the network rather than the server's memory.
 */
function handleDownload(req, res, url) {
  const total = clampInt(url.searchParams.get('bytes'), 1, MAX_DOWNLOAD_BYTES, 10 * 1024 * 1024);

  res.writeHead(200, {
    ...corsHeaders(req),
    ...NO_STORE,
    'Content-Type': 'application/octet-stream',
    'Content-Length': total,
    'Content-Disposition': 'attachment; filename="speedmeter.bin"',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let sent = 0;
  let destroyed = false;
  res.on('close', () => {
    destroyed = true;
  });

  const pump = () => {
    while (!destroyed && sent < total) {
      const size = Math.min(CHUNK_SIZE, total - sent);
      // Walk the offset through the block so consecutive chunks differ for the
      // whole transfer, not just the first block's worth.
      const offset = sent % (RANDOM_BLOCK.length - size + 1);
      const chunk = RANDOM_BLOCK.subarray(offset, offset + size);
      sent += size;
      if (!res.write(chunk)) {
        res.once('drain', pump);
        return;
      }
    }
    if (!destroyed) res.end();
  };

  pump();
}

function handleUpload(req, res) {
  let received = 0;
  let aborted = false;
  const startedAt = Date.now();

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      sendJson(req, res, 413, { error: 'payload too large', limit: MAX_UPLOAD_BYTES });
      req.destroy();
    }
  });

  req.on('end', () => {
    if (aborted) return;
    sendJson(req, res, 200, { bytes: received, durationMs: Date.now() - startedAt });
  });

  req.on('error', () => {
    if (!aborted && !res.headersSent) {
      aborted = true;
      sendJson(req, res, 400, { error: 'upload interrupted' });
    }
  });
}

function handleInfo(req, res) {
  sendJson(req, res, 200, {
    ip: clientIp(req),
    server: CONFIG.serverName,
    protocol: `HTTP/${req.httpVersion}`,
    time: new Date().toISOString(),
    limits: {
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    },
  });
}

/** The AdSense loader plus Consent Mode defaults, or nothing when unconfigured. */
function adsenseHead() {
  if (!ADSENSE_CLIENT) return '';
  return [
    '<script>',
    'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}',
    // Default to denied everywhere, so no personalised ad cookie is set before
    // the visitor has answered the consent banner.
    "gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',",
    "ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});",
    '</script>',
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>`,
  ].join('\n');
}

function canonicalFor(pathname) {
  const clean = pathname.replace(/index\.html$/, '').replace(/\.html$/, '');
  const suffix = clean === '/' ? '' : clean;
  return `${CONFIG.siteUrl}${suffix}`;
}

/**
 * Fills the placeholders shared by every page. Pages stay plain static HTML —
 * only the handful of values that depend on deployment are substituted here.
 */
function renderHtml(html, pathname) {
  const email = CONFIG.contactEmail || '';
  return html
    .replaceAll('{{ADSENSE_HEAD}}', adsenseHead())
    .replaceAll('{{CANONICAL}}', escapeHtml(canonicalFor(pathname)))
    .replaceAll('{{SITE_URL}}', escapeHtml(CONFIG.siteUrl))
    .replaceAll('{{SITE_NAME}}', escapeHtml(CONFIG.siteName))
    .replaceAll('{{OPERATOR}}', escapeHtml(CONFIG.operator || CONFIG.siteName))
    .replaceAll('{{CONTACT_EMAIL}}', escapeHtml(email))
    .replaceAll('{{YEAR}}', String(new Date().getFullYear()));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Lists every page as a clean URL, used for the sitemap. */
function listPages(dir = PUBLIC_DIR, prefix = '') {
  const pages = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      pages.push(...listPages(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith('.html') && entry.name !== '404.html') {
      pages.push(entry.name === 'index.html' ? `${prefix}/` : `${prefix}/${entry.name.slice(0, -5)}`);
    }
  }
  return pages;
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function handleRobots(res) {
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /api/', ''];
  if (CONFIG.siteUrl) lines.push(`Sitemap: ${CONFIG.siteUrl}/sitemap.xml`);
  sendText(res, 200, `${lines.join('\n')}\n`);
}

function handleSitemap(res) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = listPages()
    .sort()
    .map((page) => {
      const loc = escapeHtml(`${CONFIG.siteUrl}${page === '/' ? '' : page}`);
      const priority = page === '/' ? '1.0' : '0.7';
      return `  <url><loc>${loc}${page === '/' ? '/' : ''}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>`;
    });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
  sendText(res, 200, xml, 'application/xml; charset=utf-8');
}

/**
 * ads.txt is only served once a real publisher id is configured. Publishing a
 * placeholder would mark every legitimate buyer as unauthorised and stop the
 * ads earning anything, so its absence is the safe default.
 */
function handleAdsTxt(res) {
  if (!ADSENSE_CLIENT) {
    sendText(res, 404, 'ads.txt is not configured. Set adsense.client in site.config.json.\n');
    return;
  }
  const pubId = ADSENSE_CLIENT.replace(/^ca-/, '');
  sendText(res, 200, `google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`);
}

/** Exposes the public half of the site config to the browser. */
function handleSiteConfig(res) {
  const publicConfig = {
    siteName: CONFIG.siteName,
    siteUrl: CONFIG.siteUrl,
    contactEmail: CONFIG.contactEmail,
    adsense: { client: ADSENSE_CLIENT, slots: CONFIG.adsense.slots || {} },
  };
  const body = `window.SPEEDMETER_SITE=${JSON.stringify(publicConfig)};\n`;
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendNotFound(req, res) {
  const page = path.join(PUBLIC_DIR, '404.html');
  fs.readFile(page, 'utf8', (err, html) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const body = renderHtml(html, '/404');
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

/**
 * Resolves a request path to a file, accepting clean URLs: /privacy serves
 * privacy.html and /guides/ serves guides/index.html.
 */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const base = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (base !== PUBLIC_DIR && !base.startsWith(PUBLIC_DIR + path.sep)) return null;

  const candidates = decoded.endsWith('/')
    ? [path.join(base, 'index.html')]
    : [base, `${base}.html`, path.join(base, 'index.html')];

  for (const candidate of candidates) {
    if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + path.sep)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function serveStatic(req, res, url) {
  const filePath = resolveFile(url.pathname === '/' ? '/index.html' : url.pathname);

  if (!filePath) {
    sendNotFound(req, res);
    return;
  }

  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  if (type.startsWith('text/html')) {
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) {
        sendNotFound(req, res);
        return;
      }
      const body = renderHtml(html, url.pathname);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      sendNotFound(req, res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  switch (url.pathname) {
    case '/api/ping':
      return handlePing(req, res);
    case '/api/download':
      if (req.method !== 'GET' && req.method !== 'HEAD') break;
      return handleDownload(req, res, url);
    case '/api/upload':
      if (req.method !== 'POST') break;
      return handleUpload(req, res);
    case '/api/info':
      return handleInfo(req, res);
    case '/robots.txt':
      return handleRobots(res);
    case '/sitemap.xml':
      return handleSitemap(res);
    case '/ads.txt':
      return handleAdsTxt(res);
    case '/site-config.js':
      return handleSiteConfig(res);
    default:
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  }

  res.writeHead(405, { ...corsHeaders(req), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
});

// Long tests on slow links must not be cut short by the default timeouts.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`SpeedMeter listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!ADSENSE_CLIENT) {
      console.log('AdSense: not configured — set adsense.client in site.config.json to enable ads and ads.txt.');
    }
  });
}

module.exports = { server, CONFIG, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES };
