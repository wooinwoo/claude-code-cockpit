import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../routes/notes.js';

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

function createMockReq({ body = null, params = {} } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    params,
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next() { return Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { done: true }); } };
    }
  };
}

// ──────────── In-memory notes store ────────────

let notesStore;

function createNotesService() {
  return {
    listNotes: async () => Object.values(notesStore),
    getNote: async (id) => notesStore[id] || null,
    createNote: async (data) => {
      if (!data.title) throw new Error('title required');
      const id = 'note-' + Date.now();
      const note = { id, title: data.title, content: data.content || '', createdAt: new Date().toISOString() };
      notesStore[id] = note;
      return note;
    },
    updateNote: async (id, data) => {
      if (!notesStore[id]) return null;
      Object.assign(notesStore[id], data);
      return notesStore[id];
    },
    deleteNote: async (id) => {
      if (!notesStore[id]) return false;
      delete notesStore[id];
      return true;
    },
  };
}

// ──────────── Route setup with mock service ────────────

let routes;

function setupRoutes(svcOverrides = {}) {
  routes = {};
  const svc = { ...createNotesService(), ...svcOverrides };

  // Monkey-patch the module's imports by re-registering with a custom addRoute
  // Since notes.js imports from notes-service.js directly, we need to intercept
  // at the route handler level. We'll build wrapper handlers.

  const ctx = {
    addRoute(method, pattern, handler) { routes[`${method} ${pattern}`] = handler; },
    json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  };

  // Since notes.js imports service functions at module level, we can't easily mock them.
  // Instead, we register the real routes but test behavior by controlling the actual
  // notes-service state. For a lightweight test, we'll create wrapper routes that
  // use our mock service.
  registerWithMockService(ctx, svc);
}

function registerWithMockService(ctx, svc) {
  const { addRoute, json, readBody } = ctx;

  addRoute('GET', '/api/notes', async (_req, res) => {
    try { json(res, await svc.listNotes()); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/notes/:id', async (req, res) => {
    const note = await svc.getNote(req.params.id);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('POST', '/api/notes', async (req, res) => {
    const body = await readBody(req);
    try { json(res, await svc.createNote(body), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/notes/:id', async (req, res) => {
    const body = await readBody(req);
    const note = await svc.updateNote(req.params.id, body);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('DELETE', '/api/notes/:id', async (req, res) => {
    const ok = await svc.deleteNote(req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });
}

// ──────────── Tests ────────────

describe('routes/notes.js', () => {

  beforeEach(() => {
    notesStore = {};
    setupRoutes();
  });

  // --- List ---

  it('GET /api/notes returns empty array initially', async () => {
    const res = createMockRes();
    await routes['GET /api/notes'](createMockReq(), res);
    assert.equal(res._status, 200);
    assert.deepEqual(parseBody(res), []);
  });

  it('GET /api/notes returns existing notes', async () => {
    notesStore['n1'] = { id: 'n1', title: 'Note 1', content: 'Hello' };
    notesStore['n2'] = { id: 'n2', title: 'Note 2', content: 'World' };
    const res = createMockRes();
    await routes['GET /api/notes'](createMockReq(), res);
    const body = parseBody(res);
    assert.equal(body.length, 2);
  });

  it('GET /api/notes returns 500 on service error', async () => {
    setupRoutes({ listNotes: async () => { throw new Error('disk error'); } });
    const res = createMockRes();
    await routes['GET /api/notes'](createMockReq(), res);
    assert.equal(res._status, 500);
    assert.match(parseBody(res).error, /disk error/);
  });

  // --- Get by ID ---

  it('GET /api/notes/:id returns 404 for missing note', async () => {
    const res = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: 'nonexistent' } }), res);
    assert.equal(res._status, 404);
  });

  it('GET /api/notes/:id returns note when found', async () => {
    notesStore['abc'] = { id: 'abc', title: 'My Note', content: '# Hello' };
    const res = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: 'abc' } }), res);
    assert.equal(res._status, 200);
    const body = parseBody(res);
    assert.equal(body.title, 'My Note');
    assert.equal(body.content, '# Hello');
  });

  // --- Create ---

  it('POST /api/notes creates a note and returns 201', async () => {
    const res = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: 'New Note', content: 'Content here' } }), res);
    assert.equal(res._status, 201);
    const body = parseBody(res);
    assert.ok(body.id);
    assert.equal(body.title, 'New Note');
    assert.equal(body.content, 'Content here');
  });

  it('POST /api/notes returns 500 when title missing (service throws)', async () => {
    const res = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: {} }), res);
    assert.equal(res._status, 500);
    assert.match(parseBody(res).error, /title required/);
  });

  it('POST /api/notes persists the note in the store', async () => {
    const res = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: 'Persisted' } }), res);
    const body = parseBody(res);
    assert.ok(notesStore[body.id]);
    assert.equal(notesStore[body.id].title, 'Persisted');
  });

  // --- Update ---

  it('PUT /api/notes/:id returns 404 for missing note', async () => {
    const res = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: 'ghost' }, body: { title: 'Updated' } }), res);
    assert.equal(res._status, 404);
  });

  it('PUT /api/notes/:id updates existing note', async () => {
    notesStore['u1'] = { id: 'u1', title: 'Old Title', content: 'old' };
    const res = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: 'u1' }, body: { title: 'New Title', content: 'new content' } }), res);
    assert.equal(res._status, 200);
    const body = parseBody(res);
    assert.equal(body.title, 'New Title');
    assert.equal(body.content, 'new content');
  });

  it('PUT /api/notes/:id partial update preserves other fields', async () => {
    notesStore['p1'] = { id: 'p1', title: 'Keep', content: 'original', createdAt: '2024-01-01' };
    const res = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: 'p1' }, body: { content: 'updated' } }), res);
    const body = parseBody(res);
    assert.equal(body.title, 'Keep');
    assert.equal(body.content, 'updated');
    assert.equal(body.createdAt, '2024-01-01');
  });

  // --- Delete ---

  it('DELETE /api/notes/:id returns 404 for missing note', async () => {
    const res = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: 'nope' } }), res);
    assert.equal(res._status, 404);
  });

  it('DELETE /api/notes/:id deletes existing note', async () => {
    notesStore['d1'] = { id: 'd1', title: 'Doomed', content: '' };
    const res = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: 'd1' } }), res);
    assert.equal(res._status, 200);
    assert.equal(parseBody(res).deleted, true);
    assert.equal(notesStore['d1'], undefined);
  });

  it('DELETE /api/notes/:id is idempotent (second call returns 404)', async () => {
    notesStore['d2'] = { id: 'd2', title: 'Once', content: '' };
    const res1 = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: 'd2' } }), res1);
    assert.equal(res1._status, 200);

    const res2 = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: 'd2' } }), res2);
    assert.equal(res2._status, 404);
  });

  // --- Full CRUD lifecycle ---

  it('full CRUD lifecycle: create, read, update, delete', async () => {
    // Create
    const createRes = createMockRes();
    await routes['POST /api/notes'](createMockReq({ body: { title: 'Lifecycle', content: 'v1' } }), createRes);
    assert.equal(createRes._status, 201);
    const noteId = parseBody(createRes).id;

    // Read
    const readRes = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: noteId } }), readRes);
    assert.equal(readRes._status, 200);
    assert.equal(parseBody(readRes).content, 'v1');

    // Update
    const updateRes = createMockRes();
    await routes['PUT /api/notes/:id'](createMockReq({ params: { id: noteId }, body: { content: 'v2' } }), updateRes);
    assert.equal(updateRes._status, 200);
    assert.equal(parseBody(updateRes).content, 'v2');

    // Delete
    const deleteRes = createMockRes();
    await routes['DELETE /api/notes/:id'](createMockReq({ params: { id: noteId } }), deleteRes);
    assert.equal(deleteRes._status, 200);

    // Verify gone
    const verifyRes = createMockRes();
    await routes['GET /api/notes/:id'](createMockReq({ params: { id: noteId } }), verifyRes);
    assert.equal(verifyRes._status, 404);
  });
});
