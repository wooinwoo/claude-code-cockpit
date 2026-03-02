import { listNotes, getNote, createNote, updateNote, deleteNote } from '../lib/notes-service.js';

export function register(ctx) {
  const { addRoute, json, readBody } = ctx;

  addRoute('GET', '/api/notes', async (_req, res) => {
    try { json(res, await listNotes()); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/notes/:id', async (req, res) => {
    const note = await getNote(req.params.id);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('POST', '/api/notes', async (req, res) => {
    const body = await readBody(req);
    try { json(res, await createNote(body), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/notes/:id', async (req, res) => {
    const body = await readBody(req);
    const note = await updateNote(req.params.id, body);
    if (!note) return json(res, { error: 'Not found' }, 404);
    json(res, note);
  });

  addRoute('DELETE', '/api/notes/:id', async (req, res) => {
    const ok = await deleteNote(req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });
}
