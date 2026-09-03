import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/agent.js';

function setup(overrides = {}) {
  const routes = new Map();
  const ctx = {
    addRoute(method, path, handler) { routes.set(`${method} ${path}`, handler); },
    json(res, body, status = 200) { res.status = status; res.body = body; },
    readBody: async req => req.body,
    rateLimit: () => true,
    isLocalhost: () => true,
    updateDelegateStatus: () => ({ projectId: 'project-1', state: 'busy' }),
    ...overrides,
  };
  register(ctx);
  return routes.get('POST /api/agent/delegate-status');
}

function req(body) {
  return { body, socket: { remoteAddress: '127.0.0.1' } };
}

test('delegate status accepts a valid local heartbeat', async () => {
  const handler = setup();
  const res = {};
  await handler(req({ runId: 'run-1', state: 'heartbeat', model: 'sonnet', cwd: '/repo' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { projectId: 'project-1', state: 'busy' });
});

test('delegate status rejects remote or malformed updates', async () => {
  const remote = setup({ isLocalhost: () => false });
  const remoteRes = {};
  await remote(req({ runId: 'run-1', state: 'running' }), remoteRes);
  assert.equal(remoteRes.status, 403);

  const local = setup();
  const badRes = {};
  await local(req({ runId: '../bad', state: 'running' }), badRes);
  assert.equal(badRes.status, 400);

  const nullRes = {};
  await local(req(null), nullRes);
  assert.equal(nullRes.status, 400);
});
