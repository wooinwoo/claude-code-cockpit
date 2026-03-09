// ─── Agent Service v5: Main entry — imports from split modules ───
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { AGENT_PROFILES, TEAMS } from './agent-profiles.js';
import { initTools, updateGeminiApiKey as updateToolsApiKey } from './agent-tools.js';
import {
  detectMode, runAgentLoop, runOrchestratedLoop,
  initOrchestrator, updateOrchestratorState,
} from './agent-orchestrator.js';

const HISTORY_FILE = join(DATA_DIR, 'agent-history.json');

let _poller = null;
const _conversations = new Map();
const _runningLoops = new Map();
let _selectedModel = 'auto';
let _geminiApiKey = null;
let _callClaudeStream = null;

// Share the running loops map with the orchestrator
runAgentLoop._runningLoops = _runningLoops;

// ═══════════════════════════════════════════════════════
// Gemini API Client — stateless HTTP calls with SSE streaming
// ═══════════════════════════════════════════════════════

export class GeminiClient {
  constructor(apiKey, model = 'gemini-2.5-flash') {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Send a message to Gemini API with SSE streaming.
   * Returns the full response text.
   * onStream({type:'text', delta, full}) called for each chunk.
   */
  async send(systemPrompt, userContent, { timeoutMs = 120000, onStream = null } = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        // Enable thinking for Pro models, disable for Flash (saves tokens + latency)
        ...(this.model.includes('pro') ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      },
    };
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
      }

      // Parse SSE stream
      let fullText = '';
      const reader = resp.body;

      // Node fetch returns a ReadableStream; read as text chunks
      const decoder = new TextDecoder();
      let sseBuffer = '';

      for await (const chunk of reader) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        sseBuffer += text;

        // Process complete SSE lines
        let lineEnd;
        while ((lineEnd = sseBuffer.indexOf('\n')) !== -1) {
          const line = sseBuffer.slice(0, lineEnd).trim();
          sseBuffer = sseBuffer.slice(lineEnd + 1);

          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            const parts = data.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.thought && part.text) {
                  // Gemini thinking part — stream separately, don't mix into response
                  if (onStream) onStream({ type: 'thinking', delta: part.text });
                } else if (part.text) {
                  const delta = part.text;
                  fullText += delta;
                  if (onStream) onStream({ type: 'text', delta, full: fullText });
                }
              }
            }
          } catch {
            // Incomplete JSON chunk, skip
          }
        }
      }

      return fullText.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ═══════════════════════════════════════════════════════
// Init / Model
// ═══════════════════════════════════════════════════════

function broadcast(event, data) {
  if (_poller) _poller.broadcast(event, data);
}

export function init(poller, _unused, getProjectRoots, getProjectsMeta, extras = {}) {
  _poller = poller;
  const _getProjectRoots = getProjectRoots || (() => []);
  const _getProjectsMeta = getProjectsMeta || (() => []);
  const _getJiraConfig = extras.getJiraConfig || null;
  const _cockpitServices = extras.cockpit || null;
  _geminiApiKey = extras.geminiApiKey || null;
  _callClaudeStream = extras.callClaudeStream || null;

  // Initialize sub-modules
  initTools({
    getProjectRoots: _getProjectRoots,
    getProjectsMeta: _getProjectsMeta,
    getJiraConfig: _getJiraConfig,
    cockpitServices: _cockpitServices,
    geminiApiKey: _geminiApiKey,
    broadcast,
    GeminiClient,
  });

  initOrchestrator({
    getProjectRoots: _getProjectRoots,
    getProjectsMeta: _getProjectsMeta,
    cockpitServices: _cockpitServices,
    geminiApiKey: _geminiApiKey,
    callClaudeStream: _callClaudeStream,
    broadcast,
    userName: _userName,
    GeminiClient,
  });

  loadHistory();
  if (_geminiApiKey) console.log('[Agent] Gemini API key loaded');
  if (_callClaudeStream) console.log('[Agent] Claude stream available');
}

export function setModel(model) {
  const validIds = ['auto', 'flash', 'pro', ...Object.keys(AGENT_PROFILES)];
  if (validIds.includes(model)) _selectedModel = model;
  return { model: _selectedModel };
}

export function getModel() {
  return { model: _selectedModel };
}

export function getAgentProfiles() {
  // Deduplicate (skip legacy aliases)
  const seen = new Set();
  return Object.values(AGENT_PROFILES).filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).map(a => ({
    id: a.id, name: a.name, rank: a.rank, team: a.team, color: a.color,
    emoji: a.emoji, provider: a.provider, model: a.model, maxIter: a.maxIter,
    claudeAvailable: a.provider === 'claude' ? !!_callClaudeStream : true,
  }));
}

export function getTeams() {
  return Object.values(TEAMS);
}

export function setApiKey(key) {
  _geminiApiKey = key || null;
  updateToolsApiKey(key);
  updateOrchestratorState({ geminiApiKey: key });
  console.log('[Agent] Gemini API key updated');
}

// ═══════════════════════════════════════════════════════
// Chat: fire-and-forget, results via SSE
// ═══════════════════════════════════════════════════════

const MAX_USER_MESSAGE_LEN = 5000;

let _userName = '';
export function setUserName(name) {
  _userName = (name || '').trim();
  updateOrchestratorState({ userName: _userName });
}
export function getUserName() { return _userName; }

export function chat(convId, userMessage, targetAgentId = null) {
  if (!_geminiApiKey) throw new Error('Gemini API key not configured');
  if (_runningLoops.has(convId)) throw new Error('이미 실행 중인 작업이 있어영. 완료되거나 중단된 후 다시 시도해주세영.');

  // Input validation
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('메시지가 비어있어영. 내용을 입력해주세영.');
  }

  let trimmedMessage = userMessage.trim();
  let lengthWarning = '';
  if (trimmedMessage.length > MAX_USER_MESSAGE_LEN) {
    trimmedMessage = trimmedMessage.slice(0, MAX_USER_MESSAGE_LEN);
    lengthWarning = `(원본 ${userMessage.length}자 → ${MAX_USER_MESSAGE_LEN}자로 잘렸어영)`;
  }

  let conv = _conversations.get(convId);
  if (!conv) {
    conv = { messages: [], createdAt: Date.now() };
    _conversations.set(convId, conv);
  }

  conv.messages.push({ role: 'user', content: trimmedMessage, ts: Date.now() });
  if (lengthWarning) {
    broadcast('agent:warning', { convId, message: `메시지가 너무 길어서 ${MAX_USER_MESSAGE_LEN}자로 잘렸어영.` });
  }

  // Lock immediately to prevent duplicate requests during router call
  const routerState = { aborted: false };
  _runningLoops.set(convId, routerState);

  // Route to the right agent/mode — runs async
  (async () => {
    try {
      if (routerState.aborted) {
        _runningLoops.delete(convId);
        broadcast('agent:done', { convId });
        return;
      }

      let mode, agentId;
      if (targetAgentId && targetAgentId !== 'auto' && AGENT_PROFILES[targetAgentId]) {
        mode = 'solo';
        agentId = targetAgentId;
      } else if (_selectedModel === 'auto' || targetAgentId === 'auto') {
        broadcast('agent:start', { convId, maxIterations: 0, agentId: null, agentName: null, agentColor: null });
        const detected = await detectMode(trimmedMessage);
        mode = detected.mode;
        agentId = detected.agentId;
        if (detected.escalation) {
          const agentName = AGENT_PROFILES[agentId]?.name || agentId;
          const lastMsg = conv.messages[conv.messages.length - 1];
          if (lastMsg && lastMsg.role === 'user') {
            lastMsg.parts = [{ text: `[시스템: 사용자가 상급자를 호출해서 ${agentName}인 당신이 배정되었습니다. 당신이 바로 호출된 상사입니다. "네, 제가 왔습니다" 식으로 자연스럽게 인사하고, 무엇을 도와드릴지 물어보세요. 절대 DELEGATE로 또 다른 상사를 찾지 마세요.]\n\n원래 메시지: ${trimmedMessage}` }];
          }
        }
      } else if (AGENT_PROFILES[_selectedModel]) {
        mode = 'solo';
        agentId = _selectedModel;
      } else {
        mode = 'solo';
        agentId = _selectedModel === 'pro' ? 'dev_daeri' : 'dev_sawon';
      }

      if (routerState.aborted) {
        _runningLoops.delete(convId);
        broadcast('agent:done', { convId });
        return;
      }

      // Release the temporary lock — runAgentLoop/runOrchestratedLoop will re-set it
      _runningLoops.delete(convId);

      console.log(`[Agent] mode=${mode} agent=${agentId} selector=${_selectedModel}`);

      if (mode === 'orchestrated') {
        await runOrchestratedLoop(convId, conv, trimmedMessage, agentId, { saveHistory });
      } else {
        await runAgentLoop(convId, conv, agentId, { saveHistory });
      }
    } catch (err) {
      _runningLoops.delete(convId);
      broadcast('agent:error', { convId, error: err.message });
    }
  })();

  return { status: 'started' };
}

// ═══════════════════════════════════════════════════════
// Stop
// ═══════════════════════════════════════════════════════

export function stopAgent(convId) {
  const loop = _runningLoops.get(convId);
  if (loop) { loop.aborted = true; return { stopped: true }; }
  return { stopped: false, reason: 'no running loop' };
}

export function isRunning(convId) {
  return _runningLoops.has(convId);
}

// ═══════════════════════════════════════════════════════
// Conversations
// ═══════════════════════════════════════════════════════

export function listConversations() {
  return [..._conversations.entries()].map(([id, c]) => ({
    id,
    messageCount: c.messages.length,
    createdAt: c.createdAt,
    lastMessage: c.messages.length ? c.messages[c.messages.length - 1].content.slice(0, 80) : ''
  })).sort((a, b) => b.createdAt - a.createdAt);
}

export function getConversation(convId) {
  const conv = _conversations.get(convId);
  if (!conv) return null;
  return { id: convId, messages: conv.messages, createdAt: conv.createdAt };
}

export function deleteConversation(convId) {
  _conversations.delete(convId);
  saveHistory();
  return { deleted: true };
}

function evictStaleConversations() {
  const MAX_CONVERSATIONS = 50;
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  for (const [id, conv] of _conversations) {
    if (now - (conv.createdAt || 0) > TTL_MS) _conversations.delete(id);
  }
  if (_conversations.size >= MAX_CONVERSATIONS) {
    const sorted = [..._conversations.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    while (_conversations.size >= MAX_CONVERSATIONS && sorted.length) {
      const [oldId] = sorted.shift();
      _conversations.delete(oldId);
    }
  }
}

export function newConversation() {
  evictStaleConversations();
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  _conversations.set(id, { messages: [], createdAt: Date.now() });
  saveHistory();
  return { id };
}

// ═══════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════

function saveHistory() {
  const data = {};
  for (const [id, conv] of _conversations) {
    data[id] = { messages: conv.messages.slice(-100), createdAt: conv.createdAt };
  }
  writeFile(HISTORY_FILE, JSON.stringify(data)).catch(err => { console.warn('[Agent] Save history:', err.message); });
}

function loadHistory() {
  readFile(HISTORY_FILE, 'utf8').then(raw => {
    const data = JSON.parse(raw);
    for (const [id, conv] of Object.entries(data)) {
      _conversations.set(id, conv);
    }
  }).catch(err => { console.warn('[Agent] Load history:', err.message); });
}
