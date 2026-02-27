// ─── Workflows Service: LangGraph.js execution engine ───
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellExec } from './wsl-utils.js';
import { getAiConfig } from './config.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');
const RUNS_FILE = join(__dirname, '..', 'workflow-runs.json');

// ─── Lazy LangGraph imports ───
let _lgLoaded = false;
let StateGraph, Annotation, START, END, MemorySaver;
let ChatGoogleGenerativeAI;

async function ensureLangGraph() {
  if (_lgLoaded) return;
  const lg = await import('@langchain/langgraph');
  StateGraph = lg.StateGraph;
  Annotation = lg.Annotation;
  START = lg.START;
  END = lg.END;
  MemorySaver = lg.MemorySaver;
  try {
    const gg = await import('@langchain/google-genai');
    ChatGoogleGenerativeAI = gg.ChatGoogleGenerativeAI;
  } catch { /* google-genai optional */ }
  _lgLoaded = true;
}

// ─── Run store ───
const _runs = new Map();
let _callClaude = null;
let _poller = null;

export function init(poller, callClaude) {
  _poller = poller;
  _callClaude = callClaude;
  loadPersistedRuns();
}

// ─── Workflow Definitions ───
export async function listWorkflowDefs() {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const files = await readdir(WORKFLOWS_DIR);
  const defs = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(WORKFLOWS_DIR, f), 'utf8');
      const def = JSON.parse(raw);
      const models = [...new Set((def.steps || []).filter(s => s.provider && s.model).map(s => `${s.provider}:${s.model}`))];
      defs.push({
        id: def.id, name: def.name, description: def.description,
        inputs: def.inputs || [], stepCount: (def.steps || []).length,
        maxIterations: def.maxIterations || 0,
        hasCycles: (def.edges || []).some(e => e.condition),
        models
      });
    } catch { /* skip invalid */ }
  }
  return defs;
}

// MAJOR-1: Validate workflow ID to prevent path traversal
function isValidWorkflowId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id); }

export async function getWorkflowDef(id) {
  if (!isValidWorkflowId(id)) return null;
  const filePath = join(WORKFLOWS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch { return null; }
}

// ─── Runs ───
export function listRuns() {
  return [..._runs.values()]
    .map(r => ({ runId: r.runId, workflowId: r.workflowId, workflowName: r.workflowName, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50);
}

export function getRunDetail(runId) {
  const r = _runs.get(runId);
  if (!r) return null;
  return { runId: r.runId, workflowId: r.workflowId, workflowName: r.workflowName, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, inputs: r.inputs, steps: r.steps, error: r.error };
}

export async function startRun(workflowId, inputs) {
  const def = await getWorkflowDef(workflowId);
  if (!def) throw new Error(`Workflow not found: ${workflowId}`);

  const runId = randomBytes(8).toString('hex');
  const run = {
    runId, workflowId, workflowName: def.name,
    status: 'running', startedAt: Date.now(), endedAt: null,
    inputs: inputs || {},
    steps: def.steps.map(s => ({
      id: s.id, name: s.name, type: s.type, role: s.role || '',
      provider: s.provider || 'claude', model: s.model || 'auto',
      status: 'pending', iterations: 0,
      startedAt: null, endedAt: null, output: null, error: null
    })),
    error: null,
    _abort: new AbortController()
  };
  _runs.set(runId, run);

  broadcast('workflow:update', { runId, status: 'running', workflowId, workflowName: def.name });

  // Async execution — don't await
  executeRun(run, def).catch(err => {
    console.error(`[Workflows] Run ${run.runId} failed:`, err.message);
    if (run.status === 'running') {
      run.status = 'error';
      run.error = err.message;
      run.endedAt = Date.now();
      broadcast('workflow:error', { runId: run.runId, error: err.message, endedAt: run.endedAt });
      persistRuns();
    }
  });
  return { runId };
}

export function stopRun(runId) {
  const r = _runs.get(runId);
  if (!r || r.status !== 'running') return { stopped: false };
  r._abort.abort();
  r.status = 'stopped';
  r.endedAt = Date.now();
  broadcast('workflow:update', { runId, status: 'stopped', endedAt: r.endedAt });
  persistRuns();
  return { stopped: true };
}

// ─── Execution Engine ───
async function executeRun(run, def) {
  try {
    await ensureLangGraph();

    // Build state annotation — one string channel per outputKey
    const channels = {};
    for (const step of def.steps) {
      if (step.outputKey) {
        channels[step.outputKey] = Annotation({ reducer: (x, y) => y ?? x, default: () => '' });
      }
    }
    channels._lastOutput = Annotation({ reducer: (x, y) => y ?? x, default: () => '' });

    const GraphState = Annotation.Root(channels);
    const builder = new StateGraph(GraphState);

    // Register nodes — prefix IDs with 'n_' to avoid collision with state channel names
    const nid = id => `n_${id}`;
    for (const step of def.steps) {
      builder.addNode(nid(step.id), makeHandler(step, run));
    }

    // Register edges
    for (const edge of def.edges) {
      const from = edge.from === 'START' ? START : nid(edge.from);

      if (edge.condition) {
        // ─── Conditional edge with regex pattern matching ───
        // Supports cycles & fan-out: targets can be string or array
        let cycleCount = 0;
        const maxIter = def.maxIterations || 5;
        if (!isSafeRegex(edge.condition.pattern)) throw new Error('Unsafe regex pattern detected');
        const regex = new RegExp(edge.condition.pattern, 'i');
        const resolveTarget = t => t === 'END' ? END : nid(t);

        const trueArr = Array.isArray(edge.condition.true) ? edge.condition.true : [edge.condition.true];
        const falseArr = Array.isArray(edge.condition.false) ? edge.condition.false : [edge.condition.false];

        const pathMap = {};
        const passKeys = trueArr.map((t, i) => { const k = `pass_${i}`; pathMap[k] = resolveTarget(t); return k; });
        const failKeys = falseArr.map((t, i) => { const k = `fail_${i}`; pathMap[k] = resolveTarget(t); return k; });

        builder.addConditionalEdges(from, (state) => {
          cycleCount++;
          if (cycleCount > maxIter) {
            broadcast('workflow:update', { runId: run.runId, info: `Max iterations (${maxIter}) reached, forcing pass` });
            return passKeys;
          }
          const output = state._lastOutput || '';
          const matches = regex.test(output);
          broadcast('workflow:update', {
            runId: run.runId,
            routing: { from: edge.from, matched: matches, iteration: cycleCount, maxIterations: maxIter }
          });
          return matches ? passKeys : failKeys;
        }, pathMap);

      } else if (edge.branches) {
        // Legacy conditional edges — safe regex matching (C2: no vm.Script)
        const step = def.steps.find(s => s.id === edge.from);
        const prefixedBranches = {};
        for (const [k, v] of Object.entries(edge.branches)) {
          prefixedBranches[k] = v === 'END' ? END : nid(v);
        }
        builder.addConditionalEdges(from, (state) => {
          const ctx = stateToPlain(state, run.inputs);
          try {
            const pattern = resolve(step.pattern || step.expression || '', ctx);
            const target = step.target || '_lastOutput';
            const value = ctx[target] || '';
            if (!isSafeRegex(pattern)) return 'false';
            return new RegExp(pattern, 'i').test(value) ? 'true' : 'false';
          } catch { return 'false'; }
        }, prefixedBranches);

      } else {
        // Support fan-out (to: array) and fan-in (from: array)
        const sources = Array.isArray(edge.from)
          ? edge.from.map(f => f === 'START' ? START : nid(f))
          : [from];
        const targets = Array.isArray(edge.to)
          ? edge.to.map(t => t === 'END' ? END : nid(t))
          : [edge.to === 'END' ? END : nid(edge.to)];
        for (const src of sources) {
          for (const tgt of targets) {
            builder.addEdge(src, tgt);
          }
        }
      }
    }

    const compiled = builder.compile({ checkpointer: new MemorySaver() });

    // Stream execution node by node
    const stream = await compiled.stream({}, {
      streamMode: 'updates',
      configurable: { thread_id: run.runId }
    });

    for await (const chunk of stream) {
      if (run.status === 'stopped') break;
    }

    if (run.status !== 'stopped') {
      run.status = 'done';
      run.endedAt = Date.now();
      broadcast('workflow:complete', { runId: run.runId, status: 'done', endedAt: run.endedAt });
    }
  } catch (err) {
    if (run.status !== 'stopped') {
      run.status = 'error';
      run.error = err.message;
      run.endedAt = Date.now();
      broadcast('workflow:error', { runId: run.runId, error: err.message, endedAt: run.endedAt });
    }
  } finally {
    run._abort = null;
    persistRuns();
  }
}

function makeHandler(step, run) {
  return async (state) => {
    if (run.status === 'stopped') throw new Error('Run stopped');

    const stepRec = run.steps.find(s => s.id === step.id);
    stepRec.status = 'running';
    stepRec.iterations = (stepRec.iterations || 0) + 1;
    stepRec.startedAt = Date.now();
    stepRec.output = null;
    stepRec.error = null;
    broadcast('workflow:update', {
      runId: run.runId, stepId: step.id, status: 'running',
      startedAt: stepRec.startedAt, iteration: stepRec.iterations,
      role: step.role || '',
      provider: step.provider || 'claude', model: step.model || 'auto'
    });

    const ctx = stateToPlain(state, run.inputs);
    const res = (s) => resolve(s, ctx);
    let output = '';

    try {
      switch (step.type) {
        case 'llm': output = await runLlmNode(step, res); break;
        case 'shell': output = await runShellNode(step, res); break;
        case 'http': output = await runHttpNode(step, res); break;
        case 'condition': output = runConditionNode(step, res, ctx); break;
        default: throw new Error(`Unknown node type: ${step.type}`);
      }
      stepRec.status = 'done';
      stepRec.output = output;
    } catch (err) {
      stepRec.status = 'error';
      stepRec.error = err.message;
      output = '';
      throw err;
    } finally {
      stepRec.endedAt = Date.now();
      broadcast('workflow:update', {
        runId: run.runId, stepId: step.id, status: stepRec.status,
        output: (stepRec.output || '').slice(0, 2000),
        error: stepRec.error, endedAt: stepRec.endedAt,
        iteration: stepRec.iterations
      });
    }

    const update = {};
    if (step.outputKey) update[step.outputKey] = output;
    update._lastOutput = output;
    return update;
  };
}

// ─── Safety Helpers ───

/** C1: Shell command whitelist — only allow known safe commands */
const SHELL_ALLOWED_CMDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'git', 'npm', 'node', 'python', 'python3', 'pip', 'docker', 'make',
  'echo', 'pwd', 'date', 'which', 'where', 'file', 'stat', 'du', 'df',
]);

function isAllowedShellCmd(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  // Block shell metacharacters that enable chaining/injection
  if (/[`$;|&<>]/.test(trimmed)) return false;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  return SHELL_ALLOWED_CMDS.has(firstWord);
}

/** C3: SSRF guard — block private/reserved IPs and metadata endpoints */
function isBlockedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    // Block metadata endpoints
    if (host === '169.254.169.254' || host === 'metadata.google.internal') return true;
    // Block localhost
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    // Block private IP ranges
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    // Block link-local
    if (/^169\.254\./.test(host)) return true;
    // Block file:// protocol
    if (u.protocol === 'file:') return true;
    return false;
  } catch { return true; } // Invalid URL = block
}

// ─── Node Type Handlers ───
async function runLlmNode(step, res) {
  const provider = res(step.provider || 'claude');
  const role = step.role ? res(step.role) : '';
  const rawPrompt = res(step.prompt);
  const model = res(step.model || 'auto');

  // Prepend role as system instructions
  const prompt = role
    ? `[System Instructions]\n${role}\n\n[Task]\n${rawPrompt}`
    : rawPrompt;

  if (provider === 'gemini' && ChatGoogleGenerativeAI) {
    const geminiModel = model === 'auto' ? 'gemini-2.0-flash' : model;
    const aiConfig = getAiConfig();
    const apiKey = aiConfig?.geminiApiKey;
    if (!apiKey) throw new Error('Gemini API key not configured. Settings에서 API 키를 입력하세요.');
    let llm = new ChatGoogleGenerativeAI({ model: geminiModel, apiKey, maxOutputTokens: step.maxTokens || 4096 });

    // Enable Google Search grounding when WebSearch tool is requested
    const wantsSearch = Array.isArray(step.tools) && step.tools.includes('WebSearch');
    if (wantsSearch) {
      try { llm = llm.bindTools([{ googleSearch: {} }]); } catch { /* grounding unavailable */ }
    }

    const resp = await llm.invoke([{ role: 'user', content: prompt }]);
    if (typeof resp.content === 'string') return resp.content;
    // Search-grounded responses may return structured content blocks
    if (Array.isArray(resp.content)) {
      const text = resp.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      return text || JSON.stringify(resp.content);
    }
    return JSON.stringify(resp.content);
  }

  // Default: Claude via CLI
  if (!_callClaude) throw new Error('Claude CLI not available');
  const claudeModel = model === 'auto' ? 'sonnet' : model;
  return await _callClaude(prompt, { model: claudeModel, timeoutMs: step.timeout || 120000, tools: step.tools });
}

async function runShellNode(step, res) {
  const cmd = res(step.command);

  // C1: Validate command against whitelist
  if (!isAllowedShellCmd(cmd)) {
    throw new Error(`Blocked shell command (not in whitelist): ${cmd.slice(0, 80)}`);
  }

  const cwd = step.cwd ? res(step.cwd) : null;
  const opts = { timeout: step.timeout || 30000, maxBuffer: 2 * 1024 * 1024 };
  try {
    if (cwd) {
      const { stdout, stderr } = await shellExec(cwd, cmd, opts);
      return (stdout + stderr).trim();
    }
    const isWin = process.platform === 'win32';
    const { stdout, stderr } = await execFileAsync(
      isWin ? 'cmd' : 'sh',
      isWin ? ['/c', cmd] : ['-c', cmd],
      { ...opts, windowsHide: true }
    );
    return (stdout + stderr).trim();
  } catch (err) {
    if (err.stdout || err.stderr) return ((err.stdout || '') + (err.stderr || '')).trim();
    throw err;
  }
}

async function runHttpNode(step, res) {
  const url = res(step.url);

  // C3: Block SSRF to internal/metadata endpoints
  if (isBlockedUrl(url)) {
    throw new Error(`Blocked URL (private/internal): ${url.slice(0, 120)}`);
  }

  const body = step.body ? res(step.body) : undefined;
  const headers = {};
  for (const [k, v] of Object.entries(step.headers || {})) headers[k] = res(v);
  const resp = await fetch(url, {
    method: step.method || 'GET', headers, body,
    signal: AbortSignal.timeout(step.timeout || 15000)
  });
  return await resp.text();
}

/** MAJOR-7: Validate regex patterns to prevent ReDoS */
function isSafeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) return false;
  // Block nested quantifiers like (a+)+, (a*)+, (.+)* which cause catastrophic backtracking
  if (/(\+|\*|\{)\)(\+|\*|\{|\?)/.test(pattern)) return false;
  return true;
}

/** C2: Safe condition evaluation — regex matching only, no arbitrary JS */
function runConditionNode(step, res, ctx) {
  // Only support regex pattern matching against a context variable
  const pattern = res(step.pattern || step.expression || '');
  const target = res(step.target || '_lastOutput');
  const value = ctx[target] || '';
  if (!isSafeRegex(pattern)) return 'false';
  try {
    return new RegExp(pattern, 'i').test(value) ? 'true' : 'false';
  } catch { return 'false'; }
}

// ─── Helpers ───
function resolve(template, ctx) {
  if (!template || typeof template !== 'string') return template || '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx[key];
    return val !== undefined ? String(val) : '';
  });
}

function stateToPlain(state, inputs) {
  const plain = { ...inputs };
  if (state && typeof state === 'object') {
    for (const [k, v] of Object.entries(state)) {
      if (k !== '_lastOutput' && v) plain[k] = v;
    }
  }
  return plain;
}

function broadcast(event, data) {
  if (_poller) _poller.broadcast(event, data);
}

// ─── Persistence ───
async function persistRuns() {
  const toSave = [..._runs.values()]
    .filter(r => r.status !== 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50)
    .map(r => ({ ...r, _abort: undefined }));
  await writeFile(RUNS_FILE, JSON.stringify(toSave)).catch(err => { console.warn('[Workflows] Persist runs:', err.message); });
}

function loadPersistedRuns() {
  try {
    if (!existsSync(RUNS_FILE)) return;
    const data = JSON.parse(readFileSync(RUNS_FILE, 'utf8'));
    for (const r of data) {
      if (r.status === 'running') r.status = 'error';
      r._abort = null;
      _runs.set(r.runId, r);
    }
  } catch { /* ignore */ }
}
