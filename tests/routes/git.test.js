import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/git.js';

// ──────────── Test Helpers ────────────

function createMockRes() {
  const res = {
    _status: null,
    _headers: {},
    _body: null,
    writeHead(status, headers) { res._status = status; Object.assign(res._headers, headers || {}); },
    end(data) { res._body = data; },
  };
  return res;
}

function parseBody(res) {
  if (res._body == null) return null;
  return JSON.parse(res._body);
}

function createMockReq({ method = 'GET', url = '/', body = null, headers = {}, query = {}, params = {} } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method, url, headers, query, params,
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next() { return Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }); } };
    }
  };
}

// ──────────── Route setup ────────────

const BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;
const STASH_RE = /^stash@\{\d{1,3}\}$/;

const testProject = { id: 'proj1', name: 'TestProj', path: '/projects/test' };

let routes;
let lastGitArgs;

function setupRoutes(overrides = {}) {
  routes = {};
  lastGitArgs = null;

  const mockGitExec = async (cwd, args, opts) => {
    lastGitArgs = { cwd, args, opts };
    if (overrides.gitExecResult) return overrides.gitExecResult;
    if (overrides.gitExecFn) return overrides.gitExecFn(cwd, args, opts);
    return { stdout: '', stderr: '' };
  };

  const ctx = {
    addRoute(method, pattern, handler) { routes[`${method} ${pattern}`] = handler; },
    json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    },
    withProject(handler) {
      return async (req, res) => {
        const project = overrides.project || testProject;
        if (!project) return ctx.json(res, { error: 'Not found' }, 404);
        return handler(req, res, project);
      };
    },
    rateLimit: () => overrides.rateLimitOk !== false,
    withGitLock: async (id, fn) => fn(),
    gitExec: mockGitExec,
    toWinPath: (p) => p,
    parseWslPath: (p) => p,
    spawnForProject: () => {},
    isValidBranch: (name) => name && BRANCH_RE.test(name),
    isValidStashRef: (ref) => ref && STASH_RE.test(ref),
    LIMITS: { claudeTimeoutMs: 30000, diffMaxChars: 50000, autoCommitDiffChars: 50000 },
    __dirname: '/app',
    join: (...args) => args.join('/'),
    readFile: async () => '',
    spawn: () => {
      const child = {
        stdout: { on: () => {} }, stderr: { on: () => {} },
        stdin: { write: () => {}, end: () => {} },
        on: (evt, cb) => { if (evt === 'close') setTimeout(() => cb(0), 0); },
        kill: () => {},
      };
      return child;
    },
    poller: { getCached: () => null },
    ...overrides,
  };
  register(ctx);
}

// ──────────── Tests ────────────

describe('routes/git.js', () => {

  beforeEach(() => setupRoutes());

  // --- Stage ---

  it('POST /api/projects/:id/git/stage rejects empty files', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stage'](createMockReq({ body: { files: [] } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /files required/);
  });

  it('POST /api/projects/:id/git/stage calls git add with files', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stage'](createMockReq({ body: { files: ['src/index.js', 'package.json'] } }), res);
    assert.equal(res._status, 200);
    assert.equal(parseBody(res).success, true);
    assert.deepEqual(lastGitArgs.args, ['add', '--', 'src/index.js', 'package.json']);
  });

  it('POST /api/projects/:id/git/stage handles --all flag', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stage'](createMockReq({ body: { files: ['--all'] } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(lastGitArgs.args, ['add', '-A']);
  });

  // --- Unstage ---

  it('POST /api/projects/:id/git/unstage rejects empty files', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/unstage'](createMockReq({ body: { files: [] } }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/projects/:id/git/unstage calls git reset HEAD with files', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/unstage'](createMockReq({ body: { files: ['a.js'] } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(lastGitArgs.args, ['reset', 'HEAD', '--', 'a.js']);
  });

  // --- Discard ---

  it('POST /api/projects/:id/git/discard rejects empty files', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/discard'](createMockReq({ body: { files: [] } }), res);
    assert.equal(res._status, 400);
  });

  // --- Commit ---

  it('POST /api/projects/:id/git/commit rejects missing message', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/commit'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /message required/);
  });

  it('POST /api/projects/:id/git/commit succeeds with message', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/commit'](createMockReq({ body: { message: 'feat: add tests' } }), res);
    assert.equal(res._status, 200);
    assert.equal(parseBody(res).success, true);
    assert.deepEqual(lastGitArgs.args, ['commit', '-m', 'feat: add tests']);
  });

  // --- Checkout ---

  it('POST /api/projects/:id/git/checkout rejects invalid branch name', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/checkout'](createMockReq({ body: { branch: 'bad branch name!' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /invalid branch/i);
  });

  it('POST /api/projects/:id/git/checkout succeeds with valid branch', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/checkout'](createMockReq({ body: { branch: 'feature/login' } }), res);
    assert.equal(res._status, 200);
    assert.equal(parseBody(res).branch, 'feature/login');
  });

  // --- Create branch ---

  it('POST /api/projects/:id/git/create-branch rejects invalid name', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/create-branch'](createMockReq({ body: { branch: '' } }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/projects/:id/git/create-branch succeeds with valid name', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/create-branch'](createMockReq({ body: { branch: 'fix/bug-123' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(lastGitArgs.args, ['checkout', '-b', 'fix/bug-123']);
  });

  // --- Delete branch ---

  it('POST /api/projects/:id/git/delete-branch rejects main', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/delete-branch'](createMockReq({ body: { branch: 'main' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /cannot delete/i);
  });

  it('POST /api/projects/:id/git/delete-branch rejects master', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/delete-branch'](createMockReq({ body: { branch: 'master' } }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/projects/:id/git/delete-branch succeeds for feature branch', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/delete-branch'](createMockReq({ body: { branch: 'old-feature' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(lastGitArgs.args, ['branch', '-D', 'old-feature']);
  });

  // --- Stash ---

  it('POST /api/projects/:id/git/stash-pop rejects invalid stash ref', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stash-pop'](createMockReq({ body: { ref: 'invalid' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /invalid stash/i);
  });

  it('POST /api/projects/:id/git/stash-apply accepts valid stash ref', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stash-apply'](createMockReq({ body: { ref: 'stash@{0}' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(lastGitArgs.args, ['stash', 'apply', 'stash@{0}']);
  });

  it('POST /api/projects/:id/git/stash-drop rejects invalid ref', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/git/stash-drop'](createMockReq({ body: { ref: 'bad' } }), res);
    assert.equal(res._status, 400);
  });

  // --- Diff ---

  it('GET /api/projects/:id/diff returns structured response', async () => {
    setupRoutes({
      gitExecFn: (cwd, args) => {
        if (args[0] === 'diff' && args.includes('--cached')) return { stdout: '', stderr: '' };
        if (args[0] === 'diff') return { stdout: '', stderr: '' };
        if (args[0] === 'status') return { stdout: '?? newfile.txt\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });
    const res = createMockRes();
    await routes['GET /api/projects/:id/diff'](createMockReq({ params: { id: 'proj1' } }), res);
    const body = parseBody(res);
    assert.equal(body.projectId, 'proj1');
    assert.ok(body.staged);
    assert.ok(body.unstaged);
    assert.ok(Array.isArray(body.unstaged.files));
    // Should pick up untracked file from status
    const untracked = body.unstaged.files.find(f => f.file === 'newfile.txt');
    assert.ok(untracked, 'untracked file should appear in unstaged');
    assert.equal(untracked.status, '?');
  });

  // --- Auto commit execute ---

  it('POST /api/projects/:id/auto-commit/execute rejects missing fields', async () => {
    const res = createMockRes();
    await routes['POST /api/projects/:id/auto-commit/execute'](createMockReq({ body: { message: 'test' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /files required/i);
  });

  // --- Push ---

  it('POST /api/projects/:id/push returns success with output', async () => {
    setupRoutes({ gitExecResult: { stdout: 'Everything up-to-date', stderr: '' } });
    const res = createMockRes();
    await routes['POST /api/projects/:id/push'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.success, true);
    assert.match(body.output, /up-to-date/);
  });

  // --- Stash list ---

  it('GET /api/projects/:id/stash-list parses stash entries', async () => {
    setupRoutes({
      gitExecFn: () => ({ stdout: 'stash@{0}|WIP on main|2 hours ago\nstash@{1}|fix something|1 day ago\n', stderr: '' }),
    });
    const res = createMockRes();
    await routes['GET /api/projects/:id/stash-list'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.stashes.length, 2);
    assert.equal(body.stashes[0].ref, 'stash@{0}');
    assert.equal(body.stashes[0].message, 'WIP on main');
  });
});
