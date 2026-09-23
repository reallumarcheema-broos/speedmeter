'use strict';

/*
 * Helpers shared by the Vercel serverless functions.
 *
 * Vercel ignores files beginning with an underscore when mapping /api routes,
 * so this is not itself an endpoint.
 *
 * The handlers deliberately use only plain Node req/res APIs rather than
 * Vercel's req.query / res.json helpers, so the same code can be mounted on a
 * bare http server and tested.
 */

const crypto = require('crypto');

// Vercel's documented request body limit for a Serverless Function is 4.5 MB,
// and a buffered response is subject to a similar cap. Both endpoints stay
// well inside it and the client asks /api/info how much it may send, so the
// measurement adapts instead of failing.
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// Reused across warm invocations so only a cold start pays for the entropy.
let randomBlock = null;
function block() {
  if (!randomBlock) randomBlock = crypto.randomBytes(2 * 1024 * 1024);
  return randomBlock;
}

function query(req) {
  // req.query exists on Vercel; parsing the URL keeps this portable.
  if (req.query && typeof req.query === 'object') {
    return new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  }
  return new URL(req.url, 'http://localhost').searchParams;
}

function baseHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Timing-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  };
}

/** Answers a CORS preflight. Returns true when the request is fully handled. */
function handledPreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, { ...baseHeaders(req), 'Access-Control-Max-Age': '86400' });
  res.end();
  return true;
}

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...baseHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function methodNotAllowed(req, res) {
  sendJson(req, res, 405, { error: 'method not allowed' });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

module.exports = {
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  block,
  query,
  baseHeaders,
  handledPreflight,
  sendJson,
  methodNotAllowed,
  clampInt,
  clientIp,
};
