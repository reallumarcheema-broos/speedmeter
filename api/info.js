'use strict';

/*
 * GET /api/info — what the client needs to know about this backend.
 *
 * `limits` is load-bearing: the client sizes its download and upload requests
 * from it, so the same frontend works against a self-hosted server with no
 * practical caps and against a serverless platform with tight ones.
 *
 * This reads only environment variables, never site.config.json, so it does
 * not depend on that file being traced into the function bundle.
 */

const {
  MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES,
  handledPreflight, sendJson, methodNotAllowed, clientIp,
} = require('./_lib.js');

function serverName() {
  if (process.env.SPEEDMETER_SERVER_NAME) return process.env.SPEEDMETER_SERVER_NAME;
  if (process.env.VERCEL_REGION) return `Vercel (${process.env.VERCEL_REGION})`;
  return 'SpeedMeter';
}

module.exports = (req, res) => {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res);

  sendJson(req, res, 200, {
    ip: clientIp(req),
    server: serverName(),
    protocol: `HTTP/${req.httpVersion || '1.1'}`,
    time: new Date().toISOString(),
    limits: {
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    },
  });
};
