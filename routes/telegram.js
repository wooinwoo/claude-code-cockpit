import {
  saveConfig,
  getConfig,
  isEnabled,
  isPolling,
  startPolling,
  stopPolling,
  sendMessage,
} from '../lib/telegram-bridge.js';

export function register(ctx) {
  const { addRoute, json, readBody } = ctx;

  addRoute('GET', '/api/telegram/status', (_req, res) => {
    json(res, {
      configured: isEnabled(),
      polling: isPolling(),
      config: getConfig(),
    });
  });

  addRoute('POST', '/api/telegram/config', async (req, res) => {
    const body = await readBody(req);
    if (!body.token || !body.chatId) {
      return json(res, { error: 'token and chatId required' }, 400);
    }
    saveConfig({
      token: body.token,
      chatId: String(body.chatId),
      enabled: body.enabled !== false,
    });
    json(res, { ok: true, configured: isEnabled() });
  });

  addRoute('POST', '/api/telegram/start', async (_req, res) => {
    const ok = await startPolling();
    json(res, { ok, polling: isPolling() });
  });

  addRoute('POST', '/api/telegram/stop', (_req, res) => {
    stopPolling();
    json(res, { ok: true, polling: isPolling() });
  });

  addRoute('POST', '/api/telegram/test', async (req, res) => {
    const body = await readBody(req);
    const text = body.text || '🤖 Cockpit 테스트 메시지';
    try {
      const r = await sendMessage(text, { silent: true });
      json(res, { ok: Boolean(r?.ok), result: r });
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });
}
