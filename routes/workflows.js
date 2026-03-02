import { listWorkflowDefs, getWorkflowDef, startRun as startWorkflowRun, stopRun as stopWorkflowRun, listRuns as listWorkflowRuns, getRunDetail as getWorkflowRunDetail } from '../lib/workflows-service.js';
import { listSchedules, addSchedule, updateSchedule, removeSchedule } from '../lib/workflow-scheduler.js';

export function register(ctx) {
  const { addRoute, json, readBody } = ctx;

  addRoute('GET', '/api/workflows', async (_req, res) => {
    try { json(res, await listWorkflowDefs()); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/workflows/runs', (_req, res) => {
    json(res, listWorkflowRuns());
  });

  addRoute('POST', '/api/workflows/run', async (req, res) => {
    const body = await readBody(req);
    if (!body.workflowId) return json(res, { error: 'workflowId required' }, 400);
    try { json(res, await startWorkflowRun(body.workflowId, body.inputs || {}), 202); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/workflows/runs/:id', (req, res) => {
    const run = getWorkflowRunDetail(req.params.id);
    if (!run) return json(res, { error: 'Not found' }, 404);
    json(res, run);
  });

  addRoute('POST', '/api/workflows/runs/:id/stop', (req, res) => {
    json(res, stopWorkflowRun(req.params.id));
  });

  // ──────────── Workflow Schedules (BEFORE :id to avoid shadowing) ────────────

  addRoute('GET', '/api/workflows/schedules', (_req, res) => {
    json(res, listSchedules());
  });

  addRoute('POST', '/api/workflows/schedules', async (req, res) => {
    const body = await readBody(req);
    if (!body.workflowId) return json(res, { error: 'workflowId required' }, 400);
    try { json(res, addSchedule(body), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/workflows/schedules/:id', async (req, res) => {
    const body = await readBody(req);
    const result = updateSchedule(req.params.id, body);
    if (!result) return json(res, { error: 'Not found' }, 404);
    json(res, result);
  });

  addRoute('DELETE', '/api/workflows/schedules/:id', (req, res) => {
    const ok = removeSchedule(req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });

  addRoute('GET', '/api/workflows/:id', async (req, res) => {
    const def = await getWorkflowDef(req.params.id);
    if (!def) return json(res, { error: 'Not found' }, 404);
    json(res, def);
  });
}
