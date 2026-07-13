import { getWorkflowRuns, getRunDetail, getRunJobs, getRunLogs, rerunWorkflow, cancelRun, getWorkflows } from '../lib/cicd-service.js';

export function register(ctx) {
  const { addRoute, json, withProject, readBody } = ctx;

  addRoute('GET', '/api/cicd/runs/:projectId', withProject(async (req, res, project) => {
    const runs = await getWorkflowRuns(project.path, { workflow: req.query.workflow, status: req.query.status, limit: parseInt(req.query.limit) || 30 });
    json(res, runs);
  }, 'projectId'));

  // MINOR-5: Validate CI/CD runId (must be numeric)
  addRoute('GET', '/api/cicd/runs/:projectId/:runId', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
    json(res, await getRunDetail(project.path, req.params.runId));
  }, 'projectId'));

  addRoute('GET', '/api/cicd/runs/:projectId/:runId/jobs', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
    json(res, await getRunJobs(project.path, req.params.runId));
  }, 'projectId'));

  addRoute('GET', '/api/cicd/runs/:projectId/:runId/logs', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
    const logs = await getRunLogs(project.path, req.params.runId);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(logs);
  }, 'projectId'));

  addRoute('POST', '/api/cicd/runs/:projectId/:runId/rerun', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
    const body = await readBody(req);
    json(res, await rerunWorkflow(project.path, req.params.runId, { failed: body.failed }));
  }, 'projectId'));

  addRoute('POST', '/api/cicd/runs/:projectId/:runId/cancel', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
    json(res, await cancelRun(project.path, req.params.runId));
  }, 'projectId'));

  addRoute('GET', '/api/cicd/workflows/:projectId', withProject(async (req, res, project) => {
    json(res, await getWorkflows(project.path));
  }, 'projectId'));
}
