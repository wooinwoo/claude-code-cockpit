import { decide, getStatus, buildBriefing, setMode, getMode, resetSession } from '../lib/autopilot.js';

export function register(ctx) {
  const { addRoute, json, readBody } = ctx;

  // PreToolUse hook calls this to gate a proposed tool call.
  // Body: { tool_name, tool_input } (Claude Code hook shape) or { tool, input }.
  addRoute('POST', '/api/autopilot/decide', async (req, res) => {
    const body = await readBody(req);
    try {
      json(res, await decide(body));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  addRoute('GET', '/api/autopilot/status', (_req, res) => json(res, getStatus()));
  addRoute('GET', '/api/autopilot/briefing', (_req, res) => json(res, buildBriefing()));

  addRoute('POST', '/api/autopilot/mode', async (req, res) => {
    const body = await readBody(req);
    if (!['attended', 'unattended'].includes(body?.mode)) {
      return json(res, { error: 'mode must be attended|unattended' }, 400);
    }
    json(res, { mode: setMode(body.mode) });
  });

  addRoute('GET', '/api/autopilot/mode', (_req, res) => json(res, { mode: getMode() }));

  addRoute('POST', '/api/autopilot/reset', (_req, res) => {
    resetSession();
    json(res, { ok: true });
  });
}
