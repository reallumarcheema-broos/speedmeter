'use strict';

/*
 * Static build for hosts that serve files rather than running server.js
 * (Vercel, Netlify, any CDN).
 *
 * server.js substitutes the page placeholders at request time. A static host
 * cannot do that, so this does the same substitution ahead of time and writes
 * the result to dist/, alongside the generated robots.txt, sitemap.xml,
 * ads.txt and site-config.js. Both paths call into lib/site.js, so a page
 * renders identically either way.
 */

const fs = require('fs');
const path = require('path');
const site = require('./lib/site.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
// resolve, not join: BUILD_OUT may be an absolute path.
const OUT_DIR = path.resolve(__dirname, process.env.BUILD_OUT || 'dist');

function copyTree(from, to, config, stats) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copyTree(src, dest, config, stats);
      continue;
    }

    if (entry.name.endsWith('.html')) {
      const relative = `/${path.relative(PUBLIC_DIR, src).split(path.sep).join('/')}`;
      const rendered = site.renderHtml(config, fs.readFileSync(src, 'utf8'), relative);
      if (rendered.includes('{{')) {
        throw new Error(`Unresolved placeholder left in ${relative}`);
      }
      fs.writeFileSync(dest, rendered);
      stats.pages += 1;
    } else {
      fs.copyFileSync(src, dest);
      stats.assets += 1;
    }
  }
}

function build() {
  const config = site.loadConfig();
  const client = site.adsenseClient(config);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  const stats = { pages: 0, assets: 0 };
  copyTree(PUBLIC_DIR, OUT_DIR, config, stats);

  const write = (name, body) => fs.writeFileSync(path.join(OUT_DIR, name), body);
  write('robots.txt', site.robotsTxt(config));
  write('sitemap.xml', site.sitemapXml(config, site.listPages(PUBLIC_DIR)));
  write('site-config.js', site.siteConfigJs(config));

  const ads = site.adsTxt(client);
  if (ads) write('ads.txt', ads);

  console.log(`Built ${stats.pages} pages and ${stats.assets} assets into ${path.relative(__dirname, OUT_DIR)}/`);
  console.log(`  siteUrl: ${config.siteUrl}`);
  console.log(`  AdSense: ${client || 'not configured (no ad code, no ads.txt)'}`);

  if (/example\.com|localhost/.test(config.siteUrl)) {
    console.warn('\n  WARNING: siteUrl is still a placeholder. Canonical URLs and the');
    console.warn('  sitemap will point at the wrong host. Set it in site.config.json');
    console.warn('  or as the SITE_URL environment variable before going live.\n');
  }
}

if (require.main === module) build();

module.exports = { build, OUT_DIR };
