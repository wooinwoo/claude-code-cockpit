export function register(ctx) {
  const {
    addRoute, json, readBody,
    getBoard, replaceBoardIfRevision, updateBoardNote, appendBoardNote, addBoardTask, updateBoardTask, deleteBoardTask,
  } = ctx;

  const handleError = (res, error) => {
    const status = error.code === 'BOARD_VALIDATION' ? 400
      : error.code === 'BOARD_CONFLICT' ? 409
        : error.code === 'BOARD_BUSY' ? 503 : 500;
    json(res, { error: error.message }, status);
  };

  addRoute('GET', '/api/board', (_req, res) => {
    try { json(res, getBoard()); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board', async (req, res) => {
    const body = await readBody(req);
    try { json(res, replaceBoardIfRevision(body.board, body.revision)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PUT', '/api/board/note', async (req, res) => {
    const body = await readBody(req);
    try { json(res, updateBoardNote(body.content)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/note/append', async (req, res) => {
    const body = await readBody(req);
    try { json(res, appendBoardNote(body.content)); }
    catch (error) { handleError(res, error); }
  });

  addRoute('POST', '/api/board/tasks', async (req, res) => {
    const body = await readBody(req);
    try { json(res, addBoardTask(body.text, body.checklistId), 201); }
    catch (error) { handleError(res, error); }
  });

  addRoute('PATCH', '/api/board/tasks/:id', async (req, res) => {
    const body = await readBody(req);
    try {
      const result = updateBoardTask(req.params.id, body);
      json(res, result || { error: 'Task not found' }, result ? 200 : 404);
    } catch (error) { handleError(res, error); }
  });

  addRoute('DELETE', '/api/board/tasks/:id', (req, res) => {
    try {
      const result = deleteBoardTask(req.params.id);
      json(res, result || { error: 'Task not found' }, result ? 200 : 404);
    } catch (error) { handleError(res, error); }
  });
}
