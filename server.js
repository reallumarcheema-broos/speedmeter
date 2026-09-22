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
    server: process.env.SPEEDMETER_SERVER_NAME || 'SpeedMeter (self-hosted)',
    protocol: `HTTP/${req.httpVersion}`,
    time: new Date().toISOString(),
    limits: {
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    },
  });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(requested)));

  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const type = MIME_TYPES[path.extname(safePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(safePath).on('error', () => res.destroy()).pipe(res);
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
  });
}

module.exports = { server, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES };
