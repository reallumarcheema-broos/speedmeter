'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server.js');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('serves the app shell at /', async () => {
  const res = await fetch(base);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /SpeedMeter/);
});

test('ping responds 204 with no caching', async () => {
  const res = await fetch(`${base}/api/ping?t=1`);
  assert.strictEqual(res.status, 204);
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('download returns exactly the requested number of bytes', async () => {
  const bytes = 1_500_000;
  const res = await fetch(`${base}/api/download?bytes=${bytes}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(Number(res.headers.get('content-length')), bytes);
  const buffer = await res.arrayBuffer();
  assert.strictEqual(buffer.byteLength, bytes);
});

test('download payload is not trivially compressible', async () => {
  const res = await fetch(`${base}/api/download?bytes=65536`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const gzipped = require('node:zlib').gzipSync(buffer);
  assert.ok(gzipped.length > buffer.length * 0.9, 'random payload should not shrink much');
});

test('download clamps an out-of-range size instead of failing', async () => {
  const res = await fetch(`${base}/api/download?bytes=notanumber`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(Number(res.headers.get('content-length')), 10 * 1024 * 1024);
  await res.arrayBuffer();
});

test('upload counts the bytes it received', async () => {
  const payload = Buffer.alloc(512 * 1024, 7);
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: payload });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.bytes, payload.length);
});

test('info reports the client address and limits', async () => {
  const res = await fetch(`${base}/api/info`);
  const body = await res.json();
  assert.ok(body.ip);
  assert.ok(body.limits.maxDownloadBytes > 0);
});

test('static serving cannot escape the public directory', async () => {
  const res = await fetch(`${base}/../server.js`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404, `unexpected status ${res.status}`);
});

test('rejects the wrong method on an api route', async () => {
  const res = await fetch(`${base}/api/upload`, { method: 'GET' });
  assert.strictEqual(res.status, 405);
});

test('a large download does not repeat the same chunk over and over', async () => {
  // Spans several times the server's random block, so a naive generator would
  // start emitting an identical slice after the first block.
  const res = await fetch(`${base}/api/download?bytes=${12 * 1024 * 1024}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const size = 256 * 1024;
  const seen = new Set();
  for (let offset = 0; offset + size <= buffer.length; offset += size) {
    seen.add(buffer.subarray(offset, offset + size).toString('base64').slice(0, 64));
  }
  assert.ok(seen.size > 40, `expected varied chunks, saw ${seen.size} distinct`);
});
