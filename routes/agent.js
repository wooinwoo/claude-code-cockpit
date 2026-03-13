import { chat as agentChat, stopAgent, listConversations as agentListConvs, getConversation as agentGetConv, deleteConversation as agentDeleteConv, newConversation as agentNewConv, setModel as agentSetModel, getModel as agentGetModel, getAgentProfiles, getTeams, setUserName as agentSetUserName, getUserName as agentGetUserName } from '../lib/agent-service.js';
import { getActiveAlerts, getReports as getMonitorReports, dismissReport as dismissMonitorReport, dismissAlert, clearAllAlerts } from '../lib/monitor-agent.js';

/**
 * Register AI agent routes (config, conversations, chat, TTS, monitoring).
 * @param {object} ctx - Server context with shared utilities
 * @param {Function} ctx.addRoute - Register an HTTP route: addRoute(method, pattern, handler)
 * @param {Function} ctx.json - Send JSON response: json(res, data, statusCode?)
 * @param {Function} ctx.readBody - Parse JSON request body: readBody(req) => Promise<object>
 * @param {Function} ctx.getAiConfig - Get current AI configuration object
 * @param {Function} ctx.saveAiConfig - Persist AI configuration object
 * @param {Function} ctx.rateLimit - Rate-limit check: rateLimit(key, maxPerMin) => boolean
 * @returns {void}
 */
export function register(ctx) {
  const { addRoute, json, readBody, getAiConfig, saveAiConfig, rateLimit } = ctx;

  // Lazy-loaded TTS class — fresh instance per request to avoid WebSocket state corruption
  let _MsEdgeTTS = null;

  // ─── AI Config ───

  addRoute('GET', '/api/ai/config', (_req, res) => {
    const config = getAiConfig();
    if (!config) return json(res, { configured: false });
    json(res, {
      configured: !!config.geminiApiKey,
      geminiApiKey: config.geminiApiKey ? '****' + config.geminiApiKey.slice(-4) : '',
    });
  });

  addRoute('POST', '/api/ai/config', async (req, res) => {
    const body = await readBody(req);
    if (!body.geminiApiKey) return json(res, { error: 'geminiApiKey required' }, 400);
    saveAiConfig({ geminiApiKey: body.geminiApiKey });
    // Hot-reload: update agent's API key without server restart
    const { setApiKey } = await import('../lib/agent-service.js');
    setApiKey(body.geminiApiKey);
    json(res, { success: true });
  });

  addRoute('POST', '/api/ai/test', async (req, res) => {
    const body = await readBody(req);
    if (!body.geminiApiKey) return json(res, { error: 'geminiApiKey required' }, 400);
    try {
      const testResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${body.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Say "OK" in one word.' }] }], generationConfig: { maxOutputTokens: 10 } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!testResp.ok) {
        const err = await testResp.text().catch(() => '');
        return json(res, { error: `API ${testResp.status}: ${err.slice(0, 200)}` }, 400);
      }
      json(res, { success: true });
    } catch (err) { json(res, { error: err.message }, 400); }
  });

  // ─── Agent Conversations ───

  addRoute('GET', '/api/agent/conversations', (_req, res) => {
    json(res, agentListConvs());
  });

  addRoute('POST', '/api/agent/conversations', (_req, res) => {
    json(res, agentNewConv(), 201);
  });

  addRoute('GET', '/api/agent/conversations/:id', (req, res) => {
    const conv = agentGetConv(req.params.id);
    if (!conv) return json(res, { error: 'Not found' }, 404);
    json(res, conv);
  });

  addRoute('DELETE', '/api/agent/conversations/:id', (req, res) => {
    json(res, agentDeleteConv(req.params.id));
  });

  addRoute('POST', '/api/agent/chat', async (req, res) => {
    if (!rateLimit(`agent:chat:${req.socket?.remoteAddress}`, 30)) return json(res, { error: 'Too many requests — please wait' }, 429);
    const body = await readBody(req);
    if (!body.convId || !body.message) return json(res, { error: 'convId and message required' }, 400);
    try { json(res, agentChat(body.convId, body.message, body.agentId || null, body.projectId || null)); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('POST', '/api/agent/stop', async (req, res) => {
    const body = await readBody(req);
    if (!body.convId) return json(res, { error: 'convId required' }, 400);
    json(res, stopAgent(body.convId));
  });

  // ─── Agent Model ───

  addRoute('GET', '/api/agent/model', (_req, res) => {
    json(res, agentGetModel());
  });

  addRoute('POST', '/api/agent/model', async (req, res) => {
    const body = await readBody(req);
    if (!body.model) return json(res, { error: 'model required' }, 400);
    json(res, agentSetModel(body.model));
  });

  // ─── Agent Profiles (multi-agent) ───

  addRoute('GET', '/api/agent/agents', (_req, res) => {
    json(res, getAgentProfiles());
  });

  addRoute('GET', '/api/agent/teams', (_req, res) => {
    json(res, getTeams());
  });

  addRoute('GET', '/api/agent/company', (_req, res) => {
    json(res, { teams: getTeams(), agents: getAgentProfiles() });
  });

  // ─── User Name ───
  addRoute('POST', '/api/agent/username', async (req, res) => {
    const body = await readBody(req);
    if (body.name) agentSetUserName(body.name);
    json(res, { name: agentGetUserName() });
  });
  addRoute('GET', '/api/agent/username', (_req, res) => {
    json(res, { name: agentGetUserName() });
  });

  // ─── Edge TTS (Neural Korean voice) ───
  // Use fresh instance per request to avoid WebSocket state corruption crash
  // (msedge-tts internal: "Cannot read properties of undefined (reading 'audio')")

  addRoute('POST', '/api/agent/tts', async (req, res) => {
    if (!rateLimit(`tts:${req.socket?.remoteAddress}`, 15)) return json(res, { error: 'Too many TTS requests' }, 429);
    const body = await readBody(req);
    if (!body.text) return json(res, { error: 'text required' }, 400);

    const text = body.text.slice(0, 800);
    try {
      if (!_MsEdgeTTS) _MsEdgeTTS = (await import('msedge-tts')).MsEdgeTTS;
      const tts = new _MsEdgeTTS();
      await tts.setMetadata('ko-KR-SunHiNeural', 'audio-24khz-48kbitrate-mono-mp3');
      const { audioStream } = await tts.toStream(text);
      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on('data', c => chunks.push(c));
        audioStream.on('end', resolve);
        audioStream.on('error', reject);
        // Safety timeout — if stream hangs, reject after 10s
        setTimeout(() => reject(new Error('TTS stream timeout')), 10000);
      });
      const buf = Buffer.concat(chunks);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (err) {
      console.warn('[TTS] Error:', err.message);
      if (!res.headersSent) json(res, { error: err.message }, 500);
    }
  });

  // ─── Proactive Alerts ───

  addRoute('GET', '/api/agent/alerts', (_req, res) => {
    json(res, getActiveAlerts());
  });

  addRoute('POST', '/api/agent/alerts/dismiss', async (req, res) => {
    const body = await readBody(req);
    if (!body.alertId) return json(res, { error: 'alertId required' }, 400);
    json(res, dismissAlert(body.alertId));
  });

  addRoute('POST', '/api/agent/alerts/clear', (_req, res) => {
    json(res, clearAllAlerts());
  });

  addRoute('POST', '/api/agent/alerts/act', async (req, res) => {
    const body = await readBody(req);
    if (!body.alertId || !body.convId || !body.prompt) return json(res, { error: 'alertId, convId, prompt required' }, 400);
    // Dismiss the alert and start agent chat with the suggested prompt
    dismissAlert(body.alertId);
    try { json(res, agentChat(body.convId, body.prompt)); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  // ─── Monitor Reports ───

  addRoute('GET', '/api/agent/reports', (_req, res) => {
    json(res, getMonitorReports());
  });

  addRoute('POST', '/api/agent/reports/dismiss', async (req, res) => {
    const body = await readBody(req);
    if (!body.reportId) return json(res, { error: 'reportId required' }, 400);
    json(res, dismissMonitorReport(body.reportId));
  });
}
