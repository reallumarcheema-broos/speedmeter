'use strict';

/*
 * POST /api/upload — accepts a chunk and reports how many bytes arrived.
 *
 * The measurement itself happens in the browser, via XMLHttpRequest upload
 * progress; this endpoint only has to accept the body and acknowledge it.
 *
 * Vercel buffers the request body before invoking the function, so req.body is
 * normally already populated and the stream is spent. Draining is kept as a
 * fallback for runtimes that hand over an unread stream, and Content-Length is
 * the last resort.
 */

const {
  MAX_UPLOAD_BYTES, handledPreflight, sendJson, methodNotAllowed,
} = require('./_lib.js');

// A little headroom over the advertised limit, so a slightly oversized chunk
// is measured rather than rejected outright.
const HARD_LIMIT = Math.round(MAX_UPLOAD_BYTES * 1.5);

function drain(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > HARD_LIMIT) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

function bodyLength(body) {
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  return null;
}

module.exports = async (req, res) => {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(req, res);

  const declared = Number(req.headers['content-length']) || 0;
  if (declared > HARD_LIMIT) {
    return sendJson(req, res, 413, { error: 'payload too large', limit: MAX_UPLOAD_BYTES });
  }

  const startedAt = Date.now();
  let bytes = bodyLength(req.body);

  if (bytes === null) {
    if (req.readableEnded || req.readable === false) {
      bytes = declared;
    } else {
      try {
        bytes = await drain(req);
      } catch (error) {
        const status = error.statusCode || 400;
        return sendJson(req, res, status, {
          error: status === 413 ? 'payload too large' : 'upload interrupted',
          limit: MAX_UPLOAD_BYTES,
        });
      }
    }
  }

  return sendJson(req, res, 200, { bytes: bytes || declared, durationMs: Date.now() - startedAt });
};
