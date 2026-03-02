import { getProjectSessions, readSessionMessages, getSessionTimeline } from '../lib/claude-data.js';
import { startSession, resumeSession } from '../lib/session-control.js';

export function register(ctx) {
  const { addRoute, json, withProject, readBody } = ctx;

  addRoute('GET', '/api/projects/:id/sessions', withProject((req, res, project) => {
    json(res, getProjectSessions(project));
  }));

  addRoute('GET', '/api/projects/:id/sessions/:sessionId/messages', withProject(async (req, res, project) => {
    if (!/^[a-f0-9-]+$/i.test(req.params.sessionId)) return json(res, { error: 'Invalid sessionId' }, 400);
    json(res, await readSessionMessages(project, req.params.sessionId));
  }));

  addRoute('POST', '/api/sessions/:id/start', withProject(async (req, res, project) => {
    const body = await readBody(req);
    json(res, startSession(project, body));
  }));

  addRoute('POST', '/api/sessions/:id/resume', withProject(async (req, res, project) => {
    const body = await readBody(req);
    json(res, resumeSession(project, body.sessionId));
  }));

  addRoute('GET', '/api/projects/:id/sessions/:sessionId/timeline', withProject(async (req, res, project) => {
    if (!/^[a-f0-9-]+$/i.test(req.params.sessionId)) return json(res, { error: 'Invalid sessionId' }, 400);
    json(res, await getSessionTimeline(project, req.params.sessionId));
  }));
}
