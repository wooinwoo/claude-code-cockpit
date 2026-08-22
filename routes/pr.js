import { getGitHubPRs, getGitHubPRDetail, getPRDiff, approvePR, requestChangesPR, commentPR, mergePR } from '../lib/github-service.js';
import { getGitStatus } from '../lib/git-service.js';

export function register(ctx) {
  const { addRoute, json, withProject, readBody, getProjects } = ctx;

  addRoute('GET', '/api/projects/:id/git', withProject(async (req, res, project) => {
    json(res, await getGitStatus(project));
  }));

  // Single project PRs
  addRoute('GET', '/api/projects/:id/prs', withProject(async (req, res, project) => {
    json(res, await getGitHubPRs(project));
  }));

  // All PRs across projects
  addRoute('GET', '/api/prs', async (req, res) => {
    const state = req.query.state || 'all';
    const projects = getProjects();
    const results = await Promise.allSettled(projects.map(p => getGitHubPRs(p, state)));
    const all = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.prs?.length) {
        r.value.prs.forEach(pr => all.push({ ...pr, projectId: projects[i].id, projectName: projects[i].name }));
      }
    });
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    json(res, { prs: all });
  });

  // PR detail
  addRoute('GET', '/api/projects/:id/prs/:number', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    json(res, await getGitHubPRDetail(project, req.params.number));
  }));

  // PR diff
  addRoute('GET', '/api/projects/:id/prs/:number/diff', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    const diff = await getPRDiff(project, req.params.number);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(diff);
  }));

  // PR actions
  addRoute('POST', '/api/projects/:id/prs/:number/approve', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    const body = await readBody(req);
    json(res, await approvePR(project, req.params.number, body.body));
  }));

  addRoute('POST', '/api/projects/:id/prs/:number/request-changes', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    const body = await readBody(req);
    json(res, await requestChangesPR(project, req.params.number, body.body));
  }));

  addRoute('POST', '/api/projects/:id/prs/:number/comment', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    const body = await readBody(req);
    if (!body.body?.trim()) return json(res, { error: 'Comment body required' }, 400);
    json(res, await commentPR(project, req.params.number, body.body));
  }));

  addRoute('POST', '/api/projects/:id/prs/:number/merge', withProject(async (req, res, project) => {
    if (!/^\d+$/.test(req.params.number)) return json(res, { error: 'Invalid PR number' }, 400);
    const body = await readBody(req);
    json(res, await mergePR(project, req.params.number, body.method));
  }));
}
