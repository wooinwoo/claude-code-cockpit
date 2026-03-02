// ─── API Tester Routes ───
import {
  executeRequest,
  listRequests, getRequest, createRequest, updateRequest, deleteRequest,
} from '../lib/api-tester-service.js';

export function register(ctx) {
  const { addRoute, json, readBody, isLocalhost, PORT, __dirname } = ctx;

  // Execute HTTP request (proxy)
  addRoute('POST', '/api/api-tester/execute', async (req, res) => {
    if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
    const body = await readBody(req);
    if (!body?.url) { json(res, { error: 'URL is required' }, 400); return; }
    try {
      const result = await executeRequest(body, PORT);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Saved requests CRUD
  addRoute('GET', '/api/api-tester/requests', async (_req, res) => {
    try { json(res, await listRequests(__dirname)); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/api-tester/requests/:id', async (req, res) => {
    const request = await getRequest(__dirname, req.params.id);
    if (!request) return json(res, { error: 'Not found' }, 404);
    json(res, request);
  });

  addRoute('POST', '/api/api-tester/requests', async (req, res) => {
    const body = await readBody(req);
    try { json(res, await createRequest(__dirname, body), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/api-tester/requests/:id', async (req, res) => {
    const body = await readBody(req);
    const request = await updateRequest(__dirname, req.params.id, body);
    if (!request) return json(res, { error: 'Not found' }, 404);
    json(res, request);
  });

  addRoute('DELETE', '/api/api-tester/requests/:id', async (req, res) => {
    const ok = await deleteRequest(__dirname, req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });
}
