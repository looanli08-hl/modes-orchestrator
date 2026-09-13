/**
 * GET  /modes-console/api/tasks → GET  /api/tasks   (list)
 * POST /modes-console/api/tasks → POST /api/tasks   (create: {mode, prompt, repoPath?})
 * (fetchImpl is test-only; aioncore calls the handler as (req, res))
 */
const { forward } = require('./forward');

module.exports = function modesConsoleTasks(req, res, fetchImpl) {
  return forward(req, res, '/api/tasks', undefined, fetchImpl);
};
