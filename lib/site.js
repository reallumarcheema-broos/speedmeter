'use strict';

/**
 * Shared site logic.
 *
 * The pages in public/ are plain static HTML with a handful of deployment
 * specific placeholders. Two things render them:
 *
 *   - server.js  — substitutes at request time, for self-hosting
 *   - build.js   — substitutes at build time, for static hosts like Vercel
 *
 * Both call into here so the two paths cannot drift apart.
 */

const fs = require('fs');
const path = require('path');

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

const CONFIG_PATH = process.env.SITE_CONFIG || path.join(__dirname, '..', 'site.config.json');

/**
 * Settings come from site.config.json, overridden by environment variables so
 * one checkout can serve staging and production.
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
  // Vercel exposes the production domain at build time, so a deployment that
  // never set SITE_URL still gets correct canonical URLs rather than example.com.
  else if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    config.siteUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }

  if (process.env.SITE_NAME) config.siteName = process.env.SITE_NAME;
  if (process.env.CONTACT_EMAIL) config.contactEmail = process.env.CONTACT_EMAIL;
  if (process.env.ADSENSE_CLIENT) config.adsense.client = process.env.ADSENSE_CLIENT;
  if (process.env.SPEEDMETER_SERVER_NAME) config.serverName = process.env.SPEEDMETER_SERVER_NAME;

  config.siteUrl = String(config.siteUrl || '').replace(/\/$/, '');
  return config;
}

/** A publisher id must look real before any ad code or ads.txt is emitted. */
function adsenseClient(config) {
  return /^ca-pub-\d{10,20}$/.test(config.adsense.client || '') ? config.adsense.client : '';
}

/** The AdSense loader plus Consent Mode defaults, or nothing when unconfigured. */
function adsenseHead(client) {
  if (!client) return '';
  return [
    '<script>',
    'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}',
    // Denied by default, so no personalised ad cookie is set before the
    // visitor has answered the consent banner.
    "gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',",
    "ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});",
    '</script>',
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}" crossorigin="anonymous"></script>`,
  ].join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function canonicalFor(config, pathname) {
  const clean = pathname.replace(/index\.html$/, '').replace(/\.html$/, '');
  const suffix = clean === '/' ? '' : clean;
  return `${config.siteUrl}${suffix}`;
}

function renderHtml(config, html, pathname) {
  return html
    .replaceAll('{{ADSENSE_HEAD}}', adsenseHead(adsenseClient(config)))
    .replaceAll('{{CANONICAL}}', escapeHtml(canonicalFor(config, pathname)))
    .replaceAll('{{SITE_URL}}', escapeHtml(config.siteUrl))
    .replaceAll('{{SITE_NAME}}', escapeHtml(config.siteName))
    .replaceAll('{{OPERATOR}}', escapeHtml(config.operator || config.siteName))
    .replaceAll('{{CONTACT_EMAIL}}', escapeHtml(config.contactEmail || ''))
    .replaceAll('{{YEAR}}', String(new Date().getFullYear()));
}

/** Lists every page as a clean URL, used for the sitemap. */
function listPages(root, dir = root, prefix = '') {
  const pages = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      pages.push(...listPages(root, path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith('.html') && entry.name !== '404.html') {
      pages.push(entry.name === 'index.html' ? `${prefix}/` : `${prefix}/${entry.name.slice(0, -5)}`);
    }
  }
  return pages;
}

function robotsTxt(config) {
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /api/', ''];
  if (config.siteUrl) lines.push(`Sitemap: ${config.siteUrl}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

function sitemapXml(config, pages) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [...pages].sort().map((page) => {
    const loc = escapeHtml(`${config.siteUrl}${page === '/' ? '/' : page}`);
    const priority = page === '/' ? '1.0' : '0.7';
    return `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Returns null until a real publisher id exists. Publishing a placeholder
 * would mark every legitimate buyer as unauthorised and stop the ads earning
 * anything, so no file at all is the safe default.
 */
function adsTxt(client) {
  if (!client) return null;
  return `google.com, ${client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`;
}

/** The public half of the config, handed to the browser as a script. */
function siteConfigJs(config) {
  const publicConfig = {
    siteName: config.siteName,
    siteUrl: config.siteUrl,
    contactEmail: config.contactEmail,
    adsense: { client: adsenseClient(config), slots: config.adsense.slots || {} },
  };
  return `window.SPEEDMETER_SITE=${JSON.stringify(publicConfig)};\n`;
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  adsenseClient,
  adsenseHead,
  escapeHtml,
  canonicalFor,
  renderHtml,
  listPages,
  robotsTxt,
  sitemapXml,
  adsTxt,
  siteConfigJs,
};
