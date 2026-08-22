export function register(ctx) {
  const { addRoute, json, readBody, directorService } = ctx;
  if (!directorService) return;

  addRoute('GET', '/api/directors', (_req, res) => json(res, directorService.summary()));

  addRoute('POST', '/api/directors/sync', (_req, res) => {
    try { json(res, { directors: directorService.syncProjects() }); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/directors/runs/:id', (req, res) => {
    const run = directorService.getRun(req.params.id);
    if (!run) return json(res, { error: 'Run not found' }, 404);
    json(res, run);
  });

  addRoute('GET', '/api/directors/:id/board', async (req, res) => {
    try { json(res, { tasks: await directorService.getBoard(req.params.id) }); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('POST', '/api/directors/:id/messages', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, directorService.submitMessage(req.params.id, body.prompt), 202);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : /already running/i.test(err.message) ? 409 : 400;
      json(res, { error: err.message }, status);
    }
  });

  addRoute('POST', '/api/directors/:id/objectives', async (req, res) => {
    try {
      const body = await readBody(req);
      if (!body.title) return json(res, { error: 'title required' }, 400);
      json(res, await directorService.createObjective(req.params.id, body), 202);
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  addRoute('POST', '/api/directors/:id/dispatch', async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, await directorService.tickDirector(req.params.id, body.max));
    } catch (err) { json(res, { error: err.message }, 400); }
  });
}
