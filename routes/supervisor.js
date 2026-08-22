import { decide, getRecentDecisions, getPendingCount, notifyEvent } from '../lib/supervisor-service.js';

export function register(ctx) {
  const { addRoute, json, readBody } = ctx;

  // PreToolUse hook이 호출
  addRoute('POST', '/api/supervisor/decide', async (req, res) => {
    const body = await readBody(req);
    try {
      const result = await decide(body);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // SessionStart / Stop / UserPromptSubmit / Notification 같은 활동성 hook
  addRoute('POST', '/api/supervisor/event', async (req, res) => {
    const body = await readBody(req);
    try {
      await notifyEvent(body);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  addRoute('GET', '/api/supervisor/recent', (req, res) => {
    const n = parseInt(req.query?.n || '20', 10) || 20;
    json(res, getRecentDecisions(n));
  });

  addRoute('GET', '/api/supervisor/status', (_req, res) => {
    json(res, { pending: getPendingCount() });
  });
}
