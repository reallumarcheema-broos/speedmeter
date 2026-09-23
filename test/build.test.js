'use strict';

/*
 * The static build. A host like Vercel serves these files directly, so any
 * placeholder left unresolved here is shipped to visitors as literal text.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runBuild(env = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'speedmeter-build-'));
  execFileSync(process.execPath, [path.join(ROOT, 'build.js')], {
    cwd: ROOT,
    env: { ...process.env, BUILD_OUT: out, SITE_URL: 'https://speed.example.org', ...env },
    stdio: 'pipe',
  });
  return out;
}

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

test('build emits every page plus the generated files', () => {
  const out = runBuild();
  const files = walk(out);
  for (const expected of [
    '/index.html', '/privacy.html', '/terms.html', '/about.html', '/contact.html',
    '/404.html', '/guides/index.html', '/guides/why-is-my-wifi-slow.html',
    '/styles.css', '/app.js', '/ads.js', '/consent.js', '/favicon.svg',
    '/robots.txt', '/sitemap.xml', '/site-config.js',
  ]) {
    assert.ok(files.includes(expected), `missing ${expected}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test('no placeholder survives the build', () => {
  const out = runBuild();
  for (const file of walk(out)) {
    const body = fs.readFileSync(path.join(out, file.slice(1)), 'utf8');
    assert.ok(!body.includes('{{'), `${file} still contains a placeholder`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test('canonical URLs and the sitemap use the configured host', () => {
  const out = runBuild();
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /<link rel="canonical" href="https:\/\/speed\.example\.org">/);

  const guide = fs.readFileSync(path.join(out, 'guides/why-is-my-wifi-slow.html'), 'utf8');
  assert.match(guide, /canonical" href="https:\/\/speed\.example\.org\/guides\/why-is-my-wifi-slow"/);

  const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('https://speed.example.org/guides/'), 'sitemap missing guides index');
  assert.ok(!sitemap.includes('404'), 'sitemap should not list the 404 page');

  const robots = fs.readFileSync(path.join(out, 'robots.txt'), 'utf8');
  assert.match(robots, /Sitemap: https:\/\/speed\.example\.org\/sitemap\.xml/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('ads.txt and ad code appear only once a publisher id is set', () => {
  const without = runBuild();
  assert.ok(!fs.existsSync(path.join(without, 'ads.txt')), 'ads.txt must be withheld');
  assert.ok(!fs.readFileSync(path.join(without, 'index.html'), 'utf8').includes('adsbygoogle.js'));
  fs.rmSync(without, { recursive: true, force: true });

  const withAds = runBuild({ ADSENSE_CLIENT: 'ca-pub-1234567890123456' });
  assert.strictEqual(
    fs.readFileSync(path.join(withAds, 'ads.txt'), 'utf8').trim(),
    'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0',
  );
  const home = fs.readFileSync(path.join(withAds, 'index.html'), 'utf8');
  assert.match(home, /adsbygoogle\.js\?client=ca-pub-1234567890123456/);
  assert.ok(home.indexOf("ad_storage:'denied'") < home.indexOf('adsbygoogle.js'),
    'consent defaults must precede the loader');
  fs.rmSync(withAds, { recursive: true, force: true });
});

test('the built pages match what server.js renders at request time', async () => {
  // The two paths share lib/site.js; this guards against them drifting.
  const out = runBuild({ SITE_URL: 'https://speed.example.org' });
  const built = fs.readFileSync(path.join(out, 'about.html'), 'utf8');

  process.env.SITE_URL = 'https://speed.example.org';
  const site = require('../lib/site.js');
  const config = site.loadConfig();
  const rendered = site.renderHtml(
    config,
    fs.readFileSync(path.join(ROOT, 'public/about.html'), 'utf8'),
    '/about.html',
  );
  delete process.env.SITE_URL;

  assert.strictEqual(built, rendered);
  fs.rmSync(out, { recursive: true, force: true });
});
