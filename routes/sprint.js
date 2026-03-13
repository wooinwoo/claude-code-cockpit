// ─── Sprint Routes: React Sprint API ───
import {
  startSprint, stopSprint, getSprintRun, listSprintRuns,
  getSprintDiff, getSprintHistory,
} from '../lib/sprint-engine.js';

export function register(ctx) {
  const { addRoute, json, readBody, getProjectById, rateLimit } = ctx;

  // List active + completed runs
  addRoute('GET', '/api/sprint/runs', (_req, res) => {
    json(res, listSprintRuns());
  });

  // Get single run detail
  addRoute('GET', '/api/sprint/runs/:id', (req, res) => {
    const run = getSprintRun(req.params.id);
    if (!run) return json(res, { error: 'Not found' }, 404);
    json(res, run);
  });

  // Start a sprint
  addRoute('POST', '/api/sprint/start', async (req, res) => {
    if (!rateLimit(`sprint:start:${req.socket?.remoteAddress}`, 5)) {
      return json(res, { error: 'Rate limit exceeded' }, 429);
    }
    const body = await readBody(req);
    if (!body.projectId || !body.task) {
      return json(res, { error: 'projectId and task required' }, 400);
    }
    const project = getProjectById(body.projectId);
    if (!project) return json(res, { error: 'Project not found' }, 404);

    try {
      const result = await startSprint({
        projectId: body.projectId,
        task: body.task,
      });
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // Stop a sprint
  addRoute('POST', '/api/sprint/stop/:id', (req, res) => {
    json(res, { stopped: stopSprint(req.params.id) });
  });

  // Get diff info for a sprint
  addRoute('GET', '/api/sprint/diff/:id', (req, res) => {
    const info = getSprintDiff(req.params.id);
    if (!info) return json(res, { error: 'Not found or no worktree' }, 404);
    json(res, info);
  });

  // Sprint history (completed runs)
  addRoute('GET', '/api/sprint/history', (_req, res) => {
    json(res, getSprintHistory());
  });
}
