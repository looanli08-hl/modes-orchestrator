/**
 * Shared forwarder for the modes-console extension apiRoutes.
 *
 * NOTE: aioncore 2.2.2 never mounts extension webui routes (verified headless
 * — upstream examples 404 identically), so these handlers are currently dead
 * in production and the embedded panel talks to the console server directly.
 * Kept so the extension lights up unchanged once aioncore mounts the routes.
 *
 * Each route file maps one exact extension path (aioncore registers manifest
 * paths literally — no path params) onto the console server's REST API on
 * 127.0.0.1:4177. Handlers are Express-style (req, res): req.method,
 * req.query, req.body (object or raw string), res.status().json().
 *
 * The console server gates /api/* with a bearer token (shared file at
 * packages/orchestrator/.modes-console-token); forward attaches it as
 * x-modes-token. MODES_CONSOLE_TOKEN env overrides the file (tests).
 */

const fs = require('node:fs');
const path = require('node:path');

const CONSOLE_BASE_URL = process.env.MODES_CONSOLE_URL || 'http://127.0.0.1:4177';

// webui/forward.js → ../../.. = packages/orchestrator
const TOKEN_PATH = path.resolve(__dirname, '../../../.modes-console-token');

function loadConsoleToken() {
  if (process.env.MODES_CONSOLE_TOKEN) return process.env.MODES_CONSOLE_TOKEN;
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Forward req to `<console>/{upstreamPath}` and mirror status + JSON body back.
 * @param {object} bodyOverride - when set, sent as the JSON body instead of req.body
 */
async function forward(req, res, upstreamPath, bodyOverride, fetchImpl = fetch) {
  const headers = {};
  const token = loadConsoleToken();
  if (token) headers['x-modes-token'] = token;

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = bodyOverride !== undefined ? bodyOverride : req.body;
    headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  }

  let upstream;
  try {
    upstream = await fetchImpl(`${CONSOLE_BASE_URL}${upstreamPath}`, init);
  } catch {
    return res
      .status(502)
      .json({ error: `modes console server is not reachable at ${CONSOLE_BASE_URL} (start it or reload the extension)` });
  }

  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: 'non-JSON response from console server', raw: text.slice(0, 500) };
  }
  return res.status(upstream.status).json(payload);
}

module.exports = { forward, loadConsoleToken, CONSOLE_BASE_URL, TOKEN_PATH };
