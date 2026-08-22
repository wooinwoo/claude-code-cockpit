import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/directors.js';

let routes;
let service;

function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
}

function setup() {
  routes = {};
  service = {
    summary: () => ({ localOnly: true, directors: [] }),
    syncProjects: () => [],
    getRun: id => id === 'run-1' ? { id } : null,
    getBoard: async () => [],
    submitMessage: (id, prompt) => ({ id: 'run-1', directorId: id, prompt }),
    createObjective: async () => ({ id: 'task-1' }),
    tickDirector: async () => ({ spawned: 1 }),
  };
  register({
    directorService: service,
    addRoute(method, path, handler) { routes[`${method} ${path}`] = handler; },
    json(res, body, status = 200) { res.writeHead(status); res.end(JSON.stringify(body)); },
    readBody: async req => req.body || {},
  });
}

describe('director routes', () => {
  beforeEach(setup);

  it('exposes a local-only system summary', () => {
    const res = response();
    routes['GET /api/directors']({}, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.localOnly, true);
  });

  it('queues a message instead of blocking the HTTP request', async () => {
    const res = response();
    await routes['POST /api/directors/:id/messages']({ params: { id: 'project-director-1' }, body: { prompt: 'go' } }, res);
    assert.equal(res.status, 202);
    assert.equal(res.body.prompt, 'go');
  });

  it('requires objective title', async () => {
    const res = response();
    await routes['POST /api/directors/:id/objectives']({ params: { id: 'project-director-1' }, body: {} }, res);
    assert.equal(res.status, 400);
  });
});
