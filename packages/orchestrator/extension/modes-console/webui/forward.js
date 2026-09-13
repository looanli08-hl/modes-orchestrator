/**
 * Shared forwarder for the modes-console extension apiRoutes.
 *
 * Each route file maps one exact extension path (aioncore registers manifest
 * paths literally — no path params) onto the console server's REST API on
 * 127.0.0.1:4177. Handlers are Express-style (req, res): req.method,
 * req.query, req.body (object or raw string), res.status().json().
 */

const CONSOLE_BASE_URL = process.env.MODES_CONSOLE_URL || 'http://127.0.0.1:4177';

/**
 * Forward req to `<console>/{upstreamPath}` and mirror status + JSON body back.
 * @param {object} bodyOverride - when set, sent as the JSON body instead of req.body
 */
async function forward(req, res, upstreamPath, bodyOverride, fetchImpl = fetch) {
  const init = { method: req.method };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = bodyOverride !== undefined ? bodyOverride : req.body;
    init.headers = { 'content-type': 'application/json' };
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

module.exports = { forward, CONSOLE_BASE_URL };
