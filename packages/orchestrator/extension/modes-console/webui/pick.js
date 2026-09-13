/**
 * POST /modes-console/api/pick  body {id, pick} → POST /api/tasks/<id>/pick  body {pick}
 * (extension apiRoutes are exact paths, so the task id travels in the body;
 * fetchImpl is test-only — aioncore calls the handler as (req, res))
 */
const { forward } = require('./forward');

module.exports = function modesConsolePick(req, res, fetchImpl) {
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  const { id, pick } = body;
  if (!id) return res.status(400).json({ error: 'missing body field: id' });
  if (!pick) return res.status(400).json({ error: 'missing body field: pick' });
  return forward(req, res, `/api/tasks/${encodeURIComponent(String(id))}/pick`, { pick }, fetchImpl);
};
