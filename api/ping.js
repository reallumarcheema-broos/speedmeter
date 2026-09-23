'use strict';

/* GET /api/ping — 204 with no body. Timed by the client for latency and jitter. */

const { handledPreflight, baseHeaders, methodNotAllowed } = require('./_lib.js');

module.exports = (req, res) => {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res);

  res.writeHead(204, baseHeaders(req));
  res.end();
};
