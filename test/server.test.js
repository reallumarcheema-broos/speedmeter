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

/* ---------------------------------------------------------- pages and SEO */

test('serves clean URLs for content pages', async () => {
  for (const url of ['/privacy', '/terms', '/about', '/contact', '/guides/', '/guides/why-is-my-wifi-slow']) {
    const res = await fetch(`${base}${url}`);
    assert.strictEqual(res.status, 200, `${url} returned ${res.status}`);
    assert.match(res.headers.get('content-type'), /text\/html/, `${url} wrong type`);
  }
});

test('no template placeholder survives into the response', async () => {
  for (const url of ['/', '/privacy', '/guides/', '/guides/mbps-vs-megabytes', '/missing-page']) {
    const body = await (await fetch(`${base}${url}`)).text();
    assert.ok(!body.includes('{{'), `${url} still contains an unreplaced placeholder`);
  }
});

test('every page carries a canonical link and a unique title', async () => {
  const titles = new Set();
  for (const url of ['/', '/about', '/contact', '/privacy', '/terms', '/guides/']) {
    const body = await (await fetch(`${base}${url}`)).text();
    assert.match(body, /<link rel="canonical" href="http/, `${url} has no canonical`);
    const title = body.match(/<title>([^<]+)<\/title>/)[1];
    assert.ok(!titles.has(title), `duplicate title on ${url}`);
    titles.add(title);
  }
});

test('unknown paths return the styled 404 page, marked noindex', async () => {
  const res = await fetch(`${base}/no-such-page`);
  assert.strictEqual(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /noindex/);
  assert.match(body, /That page does not exist/);
});

test('robots.txt points at the sitemap and keeps crawlers out of the api', async () => {
  const body = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(body, /Disallow: \/api\//);
  assert.match(body, /Sitemap: http/);
});

test('sitemap lists the content pages and excludes the 404', async () => {
  const res = await fetch(`${base}/sitemap.xml`);
  assert.match(res.headers.get('content-type'), /xml/);
  const body = await res.text();
  for (const page of ['/privacy', '/about', '/guides/', '/guides/why-is-my-wifi-slow']) {
    assert.ok(body.includes(`${page}</loc>`), `sitemap missing ${page}`);
  }
  assert.ok(!body.includes('404'), 'sitemap should not list the 404 page');
});

test('ads.txt is withheld until a publisher id is configured', async () => {
  // Publishing a placeholder id would mark every real buyer as unauthorised.
  const res = await fetch(`${base}/ads.txt`);
  assert.strictEqual(res.status, 404);
});

test('no ad code is emitted while AdSense is unconfigured', async () => {
  const body = await (await fetch(`${base}/`)).text();
  assert.ok(!body.includes('adsbygoogle.js'), 'ad loader should be absent without a publisher id');
  assert.ok(!body.includes('ca-pub-'), 'no publisher id should appear');
});

test('site-config.js exposes the public config as JavaScript', async () => {
  const res = await fetch(`${base}/site-config.js`);
  assert.match(res.headers.get('content-type'), /javascript/);
  const body = await res.text();
  assert.match(body, /^window\.SPEEDMETER_SITE=/);
  assert.ok(!body.includes('serverName'), 'only public fields should be exposed');
});

test('clean URL resolution cannot escape the public directory', async () => {
  for (const url of ['/../server.js', '/..%2fserver.js', '/guides/../../server.js']) {
    const res = await fetch(`${base}${url}`, { redirect: 'manual' });
    const body = res.status === 200 ? await res.text() : '';
    assert.ok(!body.includes('MAX_UPLOAD_BYTES'), `${url} leaked server source`);
  }
});

/* ------------------------------------------------ behaviour once ads are on */

test('with a publisher id configured, ad code and ads.txt appear', async (t) => {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const fsp = require('node:fs/promises');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'speedmeter-'));
  const configPath = path.join(dir, 'site.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    siteName: 'SpeedMeter',
    siteUrl: 'https://example.test',
    adsense: { client: 'ca-pub-1234567890123456', slots: { resultsBanner: '1122334455' } },
  }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', SITE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => { child.kill(); return fsp.rm(dir, { recursive: true, force: true }); });

  // The server prints its address once listening; PORT=0 picks a free one.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      const match = /:(\d+)\s*$/m.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const url = `http://127.0.0.1:${port}`;

  const adsTxt = await fetch(`${url}/ads.txt`);
  assert.strictEqual(adsTxt.status, 200);
  assert.strictEqual((await adsTxt.text()).trim(),
    'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0');

  const home = await (await fetch(url)).text();
  assert.match(home, /adsbygoogle\.js\?client=ca-pub-1234567890123456/);
  // Consent defaults must be denied and must come before the loader.
  assert.ok(home.indexOf("ad_storage:'denied'") < home.indexOf('adsbygoogle.js'),
    'consent defaults must be set before the AdSense loader runs');

  const config = await (await fetch(`${url}/site-config.js`)).text();
  assert.match(config, /1122334455/);
});
