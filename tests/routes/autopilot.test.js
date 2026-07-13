import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/autopilot.js';
import { init, resetSession } from '../../lib/autopilot.js';

after(() => setTimeout(() => process.exit(0), 200));

function mockRes() {
  const res = { _status: null, _body: null,
    writeHead(s) { res._status = s; }, end(d) { res._body = d; } };
  return res;
}
function mockReq(body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() { let i = 0; return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }; } };
}
function setup() {
  const routes = {};
  register({
    addRoute(m, p, h) { routes[`${m} ${p}`] = h; },
    json(res, d, s = 200) { res.writeHead(s); res.end(JSON.stringify(d)); },
    readBody: async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString()); },
  });
  return routes;
}
const body = (res) => JSON.parse(res._body);

describe('autopilot route', () => {
  beforeEach(() => { init({ askHuman: null, mode: 'attended' }); resetSession(); });

  it('decide: safe command → approve/auto', async () => {
    const routes = setup();
    const res = mockRes();
    await routes['POST /api/autopilot/decide'](mockReq({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), res);
    assert.equal(body(res).decision, 'approve');
    assert.equal(body(res).action, 'auto');
  });

  it('decide: destructive command → deny/block', async () => {
    const routes = setup();
    const res = mockRes();
    await routes['POST /api/autopilot/decide'](mockReq({ tool_name: 'Bash', tool_input: { command: 'rm -rf / --no-preserve-root' } }), res);
    assert.equal(body(res).decision, 'deny');
    assert.equal(body(res).action, 'block');
  });

  it('decide: production op (attended, no channel) → ask', async () => {
    const routes = setup();
    const res = mockRes();
    await routes['POST /api/autopilot/decide'](mockReq({ tool_name: 'Bash', tool_input: { command: 'aws s3api delete-bucket --bucket prod' } }), res);
    assert.equal(body(res).action, 'escalate');
    assert.equal(body(res).decision, 'ask');
  });

  it('status exposes mode + metrics', async () => {
    const routes = setup();
    const res = mockRes();
    await routes['POST /api/autopilot/decide'](mockReq({ tool_name: 'Read', tool_input: {} }), mockRes());
    await routes['GET /api/autopilot/status'](mockReq(), res);
    const s = body(res);
    assert.equal(s.mode, 'attended');
    assert.ok(s.metrics.total >= 1);
  });

  it('mode toggle validates input', async () => {
    const routes = setup();
    const bad = mockRes();
    await routes['POST /api/autopilot/mode'](mockReq({ mode: 'nope' }), bad);
    assert.equal(bad._status, 400);
    const good = mockRes();
    await routes['POST /api/autopilot/mode'](mockReq({ mode: 'unattended' }), good);
    assert.equal(body(good).mode, 'unattended');
  });
});
