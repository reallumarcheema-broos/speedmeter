'use strict';

/*
 * GET /api/download?bytes=<n> — streams incompressible filler.
 *
 * The response is written in small chunks respecting backpressure, so the
 * client measures the network rather than how fast the platform can buffer.
 * The size is capped well below Vercel's response limit; the client discovers
 * that cap from /api/info and simply issues more requests instead of larger
 * ones.
 */

const {
  MAX_DOWNLOAD_BYTES, block, query, baseHeaders,
  handledPreflight, methodNotAllowed, clampInt,
} = require('./_lib.js');

const CHUNK_SIZE = 64 * 1024;

module.exports = (req, res) => {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res);

  const total = clampInt(query(req).get('bytes'), 1, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES);
  const source = block();

  res.writeHead(200, {
    ...baseHeaders(req),
    'Content-Type': 'application/octet-stream',
    'Content-Length': total,
    // Belt and braces: the payload is random, so compressing it only burns CPU.
    'Content-Encoding': 'identity',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let sent = 0;
  let closed = false;
  res.on('close', () => { closed = true; });

  const pump = () => {
    while (!closed && sent < total) {
      const size = Math.min(CHUNK_SIZE, total - sent);
      // Walk the offset so consecutive chunks differ for the whole transfer.
      const offset = sent % (source.length - size + 1);
      sent += size;
      if (!res.write(source.subarray(offset, offset + size))) {
        res.once('drain', pump);
        return;
      }
    }
    if (!closed) res.end();
  };

  pump();
};
