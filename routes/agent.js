import { chat as agentChat, stopAgent, listConversations as agentListConvs, getConversation as agentGetConv, deleteConversation as agentDeleteConv, newConversation as agentNewConv, setModel as agentSetModel, getModel as agentGetModel } from '../lib/agent-service.js';

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
      const testResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${body.geminiApiKey}`, {
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
    if (!rateLimit('agent:chat', 10)) return json(res, { error: 'Too many requests — please wait' }, 429);
    const body = await readBody(req);
    if (!body.convId || !body.message) return json(res, { error: 'convId and message required' }, 400);
    try { json(res, agentChat(body.convId, body.message)); }
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

  // ─── Edge TTS (Neural Korean voice) ───
  // Use fresh instance per request to avoid WebSocket state corruption crash
  // (msedge-tts internal: "Cannot read properties of undefined (reading 'audio')")

  addRoute('POST', '/api/agent/tts', async (req, res) => {
    if (!rateLimit('tts', 15)) return json(res, { error: 'Too many TTS requests' }, 429);
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
}
