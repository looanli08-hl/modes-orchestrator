/**
 * GET /modes-console/api/task?id=<taskId> → GET /api/tasks/<taskId>
 * (extension apiRoutes are exact paths, so the task id travels as a query param;
 * fetchImpl is test-only — aioncore calls the handler as (req, res))
 */
const { forward } = require('./forward');

module.exports = function modesConsoleTask(req, res, fetchImpl) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'missing query param: id' });
  return forward(req, res, `/api/tasks/${encodeURIComponent(String(id))}`, undefined, fetchImpl);
};
