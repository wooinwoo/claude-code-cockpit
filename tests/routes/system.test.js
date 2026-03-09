import { describe, it, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/system.js';

// Force exit after tests complete — imported modules may keep event loop alive
after(() => setTimeout(() => process.exit(0), 200));

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
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next() { return Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }); } };
    }
  };
}

// ──────────── Capture registered routes ────────────

let routes;
let ctxOverrides;

function setupRoutes(overrides = {}) {
  routes = {};
  ctxOverrides = overrides;
  const ctx = {
    addRoute(method, pattern, handler) { routes[`${method} ${pattern}`] = handler; },
    json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
    getProjects: () => overrides.projects || [],
    getProjectById: (id) => (overrides.projects || []).find(p => p.id === id),
    addProject: (p) => ({ id: 'new-1', ...p }),
    poller: { sseClients: new Map(), getCached: () => null },
    LAN_TOKEN: 'test-token-1234567',
    isInsideAnyProject: (path) => overrides.isInsideAnyProject?.(path) ?? true,
    isLocalhost: (req) => overrides.isLocalhost?.(req) ?? true,
    authCookie: () => 'auth=ok; Path=/',
    toWinPath: (p) => p.replace(/\//g, '\\'),
    PORT: 3847,
    LIMITS: { imageUploadBytes: 10 * 1024 * 1024, filePreviewBytes: 2 * 1024 * 1024 },
    join: (...args) => args.join('/'),
    resolve: (p) => p,
    normalize: (p) => p,
    readFile: async () => 'file content',
    readdir: async () => [],
    stat: async () => ({ size: 100, mtimeMs: Date.now() }),
    writeFile: async () => {},
    mkdir: async () => {},
    existsSync: () => true,
    spawn: () => ({ unref() {} }),
    tmpdir: () => '/tmp',
    randomBytes: (n) => ({ toString() { return 'abcd1234'; } }),
    timingSafeEqual: (a, b) => a.toString() === b.toString(),
    terminals: new Map(),
    getNetworkIPs: () => ['192.168.1.100'],
    registerProjectPollers: () => {},
    getNotifyEnabled: () => true,
    rateLimit: () => true,
    PKG_VERSION: '1.0.0-test',
    ...overrides,
  };
  register(ctx);
}

// ──────────── Tests ────────────

describe('routes/system.js', () => {

  beforeEach(() => setupRoutes());

  // --- Health ---

  it('GET /api/health returns status ok with expected fields', async () => {
    const res = createMockRes();
    await routes['GET /api/health'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.memory, 'number');
    assert.equal(body.projects, 0);
    assert.equal(body.terminals, 0);
  });

  // --- Auth ---

  it('POST /api/auth/login rejects missing token', async () => {
    const res = createMockRes();
    await routes['POST /api/auth/login'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 401);
    assert.equal(parseBody(res).error, 'Invalid token');
  });

  it('POST /api/auth/login rejects wrong token', async () => {
    const res = createMockRes();
    await routes['POST /api/auth/login'](createMockReq({ body: { token: 'wrong-token-xxxxxxx' } }), res);
    assert.equal(res._status, 401);
  });

  it('POST /api/auth/login accepts correct token', async () => {
    const res = createMockRes();
    await routes['POST /api/auth/login'](createMockReq({ body: { token: 'test-token-1234567' } }), res);
    assert.equal(res._status, 200);
    assert.ok(res._headers['Set-Cookie']);
  });

  // --- LAN info ---

  it('GET /api/lan-info returns token and IPs for localhost', async () => {
    const res = createMockRes();
    await routes['GET /api/lan-info'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.token, 'test-token-1234567');
    assert.deepEqual(body.ips, ['192.168.1.100']);
    assert.equal(body.port, 3847);
  });

  it('GET /api/lan-info returns 403 for non-localhost', async () => {
    setupRoutes({ isLocalhost: () => false });
    const res = createMockRes();
    await routes['GET /api/lan-info'](createMockReq(), res);
    assert.equal(res._status, 403);
  });

  // --- QR code ---

  it('GET /api/qr-code returns 400 when data param missing', async () => {
    const res = createMockRes();
    await routes['GET /api/qr-code'](createMockReq({ query: {} }), res);
    assert.equal(res._status, 400);
  });

  // --- File access ---

  it('GET /api/file returns 400 when path is missing', async () => {
    const res = createMockRes();
    await routes['GET /api/file'](createMockReq({ url: '/api/file' }), res);
    assert.equal(res._status, 400);
  });

  it('GET /api/file returns 403 when path is outside project', async () => {
    setupRoutes({ isInsideAnyProject: () => false });
    const res = createMockRes();
    await routes['GET /api/file'](createMockReq({ url: '/api/file?path=/etc/passwd' }), res);
    assert.equal(res._status, 403);
  });

  it('GET /api/file returns file content when path valid', async () => {
    const res = createMockRes();
    await routes['GET /api/file'](createMockReq({ url: '/api/file?path=/project/src/index.js' }), res);
    const body = parseBody(res);
    assert.equal(body.content, 'file content');
    assert.equal(body.name, 'index.js');
  });

  // --- Open URL ---

  it('POST /api/open-url rejects missing url', async () => {
    const res = createMockRes();
    await routes['POST /api/open-url'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/open-url rejects non-http URL', async () => {
    const res = createMockRes();
    await routes['POST /api/open-url'](createMockReq({ body: { url: 'file:///etc/passwd' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /http/i);
  });

  it('POST /api/open-url accepts valid https URL', async () => {
    const res = createMockRes();
    await routes['POST /api/open-url'](createMockReq({ body: { url: 'https://example.com' } }), res);
    assert.equal(res._status, 200);
    assert.equal(parseBody(res).opened, true);
  });

  // --- Open folder ---

  it('POST /api/open-folder rejects missing path', async () => {
    const res = createMockRes();
    await routes['POST /api/open-folder'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/open-folder rejects path outside project', async () => {
    setupRoutes({ isInsideAnyProject: () => false });
    const res = createMockRes();
    await routes['POST /api/open-folder'](createMockReq({ body: { path: '/etc' } }), res);
    assert.equal(res._status, 403);
  });

  // --- Open in IDE ---

  it('POST /api/open-in-ide rejects missing path', async () => {
    const res = createMockRes();
    await routes['POST /api/open-in-ide'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/open-in-ide rejects unknown IDE', async () => {
    const res = createMockRes();
    await routes['POST /api/open-in-ide'](createMockReq({ body: { path: '/project/file.js', ide: 'vim' } }), res);
    assert.equal(res._status, 400);
    assert.match(parseBody(res).error, /unknown/i);
  });

  // --- Settings export ---

  it('GET /api/settings/export returns projects list', async () => {
    setupRoutes({ projects: [{ id: 'p1', name: 'Test', path: '/test' }] });
    const res = createMockRes();
    await routes['GET /api/settings/export'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].name, 'Test');
  });

  // --- Batch execute ---

  it('POST /api/batch/execute rejects missing commandId', async () => {
    const res = createMockRes();
    await routes['POST /api/batch/execute'](createMockReq({ body: { projectIds: ['p1'] } }), res);
    assert.equal(res._status, 400);
  });

  it('POST /api/batch/execute rejects missing projectIds', async () => {
    const res = createMockRes();
    await routes['POST /api/batch/execute'](createMockReq({ body: { commandId: 'git-pull' } }), res);
    assert.equal(res._status, 400);
  });

  // --- Discover projects ---

  it('POST /api/discover-projects/add rejects empty projects array', async () => {
    const res = createMockRes();
    await routes['POST /api/discover-projects/add'](createMockReq({ body: { projects: [] } }), res);
    assert.equal(res._status, 400);
  });

  // --- Notify toggle ---

  it('POST /api/notify/toggle sets enabled state', async () => {
    const res = createMockRes();
    await routes['POST /api/notify/toggle'](createMockReq({ body: { enabled: false } }), res);
    const body = parseBody(res);
    assert.equal(body.enabled, false);
  });
});
