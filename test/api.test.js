'use strict';

/*
 * The Vercel serverless functions, exercised over real HTTP.
 *
 * Vercel maps /api/<name> to api/<name>.js and invokes the default export with
 * Node-style (req, res). Mounting them on a bare http server reproduces that
 * contract closely enough to catch the mistakes that matter.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const handlers = {
  '/api/ping': require('../api/ping.js'),
  '/api/download': require('../api/download.js'),
  '/api/upload': require('../api/upload.js'),
  '/api/info': require('../api/info.js'),
};
const { MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES } = require('../api/_lib.js');

let base;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const handler = handlers[pathname];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  });
});

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('ping returns 204 and is not cacheable', async () => {
  const res = await fetch(`${base}/api/ping?t=1`);
  assert.strictEqual(res.status, 204);
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('download returns exactly the requested bytes', async () => {
  const res = await fetch(`${base}/api/download?bytes=1000000`);
  assert.strictEqual(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.length, 1000000);
});

test('download caps the size instead of failing, staying inside platform limits', async () => {
  // The client should never ask for this, but a hand-typed URL must not be
  // able to push the function past what Vercel will return.
  const res = await fetch(`${base}/api/download?bytes=999999999`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.length, MAX_DOWNLOAD_BYTES);
  assert.ok(MAX_DOWNLOAD_BYTES <= 4.5 * 1000 * 1000,
    'download cap must stay under the 4.5 MB serverless response limit');
});

test('download payload is incompressible and does not repeat', async () => {
  const res = await fetch(`${base}/api/download?bytes=${4 * 1024 * 1024}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const gz = require('node:zlib').gzipSync(buf);
  assert.ok(gz.length > buf.length * 0.9, 'random payload should not compress');

  const seen = new Set();
  for (let off = 0; off + 65536 <= buf.length; off += 65536) {
    seen.add(buf.subarray(off, off + 65536).toString('base64').slice(0, 48));
  }
  assert.ok(seen.size > 50, `expected varied chunks, saw ${seen.size}`);
});

test('upload counts the bytes it received', async () => {
  const payload = Buffer.alloc(1024 * 1024, 3);
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).bytes, payload.length);
});

test('upload works when the runtime pre-parsed the body into req.body', async () => {
  // Vercel buffers the request body before invoking the function, leaving the
  // stream spent. The handler must use req.body rather than hanging on 'end'.
  const upload = require('../api/upload.js');
  const chunk = Buffer.alloc(2048, 9);
  const req = {
    method: 'POST',
    headers: { 'content-length': String(chunk.length) },
    body: chunk,
    readableEnded: true,
    readable: false,
    on() {},
  };
  const captured = {};
  const res = {
    writeHead(status) { captured.status = status; return this; },
    end(body) { captured.body = body; },
  };
  await upload(req, res);
  assert.strictEqual(captured.status, 200);
  assert.strictEqual(JSON.parse(captured.body).bytes, chunk.length);
});

test('upload advertises a limit the client can actually send', async () => {
  assert.ok(MAX_UPLOAD_BYTES < 4 * 1000 * 1000,
    'upload chunks must stay under 4 MB as well as under the 4.5 MB platform cap');
});

test('upload rejects an oversized chunk', async () => {
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: Buffer.alloc(MAX_UPLOAD_BYTES * 2, 1),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.strictEqual(res.status, 413);
});

test('info reports the forwarded client IP and the limits the client plans from', async () => {
  const res = await fetch(`${base}/api/info`, {
    headers: { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' },
  });
  const body = await res.json();
  assert.strictEqual(body.ip, '203.0.113.9');
  assert.strictEqual(body.limits.maxDownloadBytes, MAX_DOWNLOAD_BYTES);
  assert.strictEqual(body.limits.maxUploadBytes, MAX_UPLOAD_BYTES);
});

test('every endpoint answers a CORS preflight and refuses the wrong method', async () => {
  for (const route of Object.keys(handlers)) {
    const pre = await fetch(`${base}${route}`, { method: 'OPTIONS' });
    assert.strictEqual(pre.status, 204, `${route} preflight`);
    assert.ok(pre.headers.get('access-control-allow-origin'), `${route} CORS header`);
  }
  assert.strictEqual((await fetch(`${base}/api/upload`)).status, 405);
  assert.strictEqual((await fetch(`${base}/api/ping`, { method: 'POST' })).status, 405);
});
