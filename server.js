import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, unlinkSync, watch, writeFileSync, copyFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getProjects, PORT, POLL_INTERVALS, LIMITS, getProjectById, addProject, updateProject, deleteProject, getJiraConfig, saveJiraConfig, getAiConfig, saveAiConfig, DATA_DIR } from './lib/config.js';
import { detectSessionState, getRecentActivity } from './lib/claude-data.js';
import { getGitStatus } from './lib/git-service.js';
import { getGitHubPRs } from './lib/github-service.js';
import { computeUsage } from './lib/cost-service.js';
import { Poller } from './lib/poller.js';
import { showNotification } from './lib/notify.js';
import { IS_WIN, getShell, killProcessTree, openUrl as platformOpenUrl } from './lib/platform.js';
import { gitExec, spawnForProject, parseWslPath, toWinPath } from './lib/wsl-utils.js';
import { init as initWorkflows, listWorkflowDefs, getWorkflowDef, startRun as startWorkflowRun, listRuns as listWorkflowRuns, getRunDetail as getWorkflowRunDetail } from './lib/workflows-service.js';
import { init as initScheduler } from './lib/workflow-scheduler.js';
import { init as initAgent, chat as agentChat, newConversation as agentNewConv, getConversation as agentGetConv, isRunning as agentIsRunning, isConfigured as agentIsConfigured } from './lib/agent-service.js';
import * as telegramBridge from './lib/telegram-bridge.js';
import * as autonomyScheduler from './lib/autonomy-scheduler.js';
import { init as initMonitorAgent } from './lib/monitor-agent.js';
import { checkAlerts, saveDailySnapshot, generateBriefing } from './lib/briefing-service.js';
import { getAllStats as getMonitorStats } from './lib/monitor-service.js';
import { initBatch } from './lib/batch-service.js';
import { logger } from './lib/logger.js';
import { listNotes, getNote, createNote, updateNote } from './lib/notes-service.js';

// Route modules
import { register as regCicd } from './routes/cicd.js';
import { register as regPR } from './routes/pr.js';
import { register as regWorkflows } from './routes/workflows.js';
import { register as regSessions } from './routes/sessions.js';
import { register as regAgent } from './routes/agent.js';
import { register as regGit } from './routes/git.js';
import { register as regProjects } from './routes/projects.js';
import { register as regSystem } from './routes/system.js';
import { register as regPorts } from './routes/ports.js';
import { register as regTelegram } from './routes/telegram.js';
import { register as regSupervisor } from './routes/supervisor.js';
import { register as regAutopilot } from './routes/autopilot.js';
import { init as initAutopilot } from './lib/autopilot.js';
import * as supervisorService from './lib/supervisor-service.js';
import * as supervisorLlm from './lib/supervisor-llm.js';

// node-pty and ws are CJS modules
const require = createRequire(import.meta.url);
let pty, WebSocketServer;
try {
  pty = require('node-pty');
  ({ WebSocketServer } = require('ws'));
} catch (err) {
  logger.error('server', `Missing native dependency: ${err.message}`);
  logger.error('server', 'Run: npm install');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const poller = new Poller();
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

// Detect default shell (cross-platform)
const _defaultShell = getShell();

// Prevent server crash from unhandled promise rejections (e.g., msedge-tts WebSocket errors)
process.on('unhandledRejection', (reason) => {
  logger.warn('server', 'UnhandledRejection', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  logger.error('server', `Uncaught exception: ${err.message}`, err.stack);
  process.exit(1);
});

// State file lives in %LOCALAPPDATA%/cockpit (survives reinstall)
const STATE_FILE = join(DATA_DIR, 'session-state.json');

// ──────────── Perf helpers ────────────
const _execFileAsync = promisify(execFile);
// Cache index.html in memory (reload on file change in dev)
let _cachedHTML = null;
async function getCachedHTML() {
  if (!_cachedHTML) _cachedHTML = await readFile(join(__dirname, 'index.html'), 'utf8');
  return _cachedHTML;
}
// Invalidate cache when file changes (dev convenience)
try { watch(join(__dirname, 'index.html'), () => { _cachedHTML = null; }); } catch { /* watch not supported in this env */ }

// Git concurrency: serialize git ops per project to prevent lock conflicts
const _gitLocks = new Map();
let _gitLockSeq = 0;
async function withGitLock(projectId, fn) {
  if (!_gitLocks.has(projectId)) _gitLocks.set(projectId, { promise: Promise.resolve(), seq: 0 });
  const entry = _gitLocks.get(projectId);
  const mySeq = ++_gitLockSeq;
  entry.seq = mySeq;
  const next = entry.promise.then(fn, fn);
  entry.promise = next.catch(err => { console.warn(`[Git] Lock ${projectId}:`, err.message); });
  // Clean up only if no newer ops were queued (prevents stale entry accumulation)
  entry.promise.then(() => { if (_gitLocks.get(projectId)?.seq === mySeq) _gitLocks.delete(projectId); });
  return next;
}

// Migrate old data files from install dir to DATA_DIR
for (const f of ['.cockpit-token', 'session-state.json', 'agent-history.json']) {
  const oldP = join(__dirname, f), newP = join(DATA_DIR, f);
  if (!existsSync(newP) && existsSync(oldP)) { try { copyFileSync(oldP, newP); } catch (err) { console.warn(`[Migration] Copy ${f}:`, err.message); } }
}

// ──────────── LAN Auth ────────────
const TOKEN_FILE = join(DATA_DIR, '.cockpit-token');
const TOKEN_COOKIE = 'cockpit-token';
const COOKIE_MAX_AGE = 365 * 24 * 3600; // 1 year

function loadOrCreateToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
      if (saved.length >= 16) return saved;
    }
  } catch { /* corrupt token file — regenerate */ }
  const token = randomBytes(16).toString('hex');
  try { writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); } catch { /* non-critical — token lives in memory */ }
  return token;
}
const LAN_TOKEN = loadOrCreateToken();

function isLocalhost(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ──────────── Host allowlist (anti DNS-rebinding) ────────────
// remoteAddress-based localhost trust (isLocalhost) is spoofable via DNS rebinding:
// an attacker page rebound to 127.0.0.1 connects locally (remoteAddress=127.0.0.1)
// but sends Host: evil.com, which the Origin===Host CSRF check happily accepts —
// reaching the terminal WebSocket = unauthenticated shell. Pinning the Host header
// to a known-good allowlist closes that path: the forged Host never matches.
// Network IPs are added at listen() time; extra hosts via COCKPIT_ALLOWED_HOSTS.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
for (const h of (process.env.COCKPIT_ALLOWED_HOSTS || '').split(',')) {
  const t = h.trim().toLowerCase();
  if (t) ALLOWED_HOSTS.add(t);
}
function hostAllowed(req) {
  const raw = req.headers?.['host'] || '';
  if (!raw) return false;
  let name = raw;
  const lastColon = name.lastIndexOf(':');
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'));               // [::1]:3847
  else if (lastColon > 0 && /^\d+$/.test(name.slice(lastColon + 1))) name = name.slice(0, lastColon); // host:port
  name = name.toLowerCase();
  if (ALLOWED_HOSTS.has(name)) return true;
  if (name.endsWith('.ts.net')) return true;   // Tailscale MagicDNS
  return false;
}

function parseCookies(req) {
  const obj = {};
  const hdr = req.headers.cookie;
  if (!hdr) return obj;
  for (const pair of hdr.split(';')) {
    const [k, ...v] = pair.split('=');
    obj[k.trim()] = v.join('=').trim();
  }
  return obj;
}

// MINOR-11: Build auth cookie string with conditional Secure flag
function authCookie(req) {
  const isSecure = req?.headers?.['x-forwarded-proto'] === 'https' || req?.socket?.encrypted;
  return `${TOKEN_COOKIE}=${LAN_TOKEN};path=/;max-age=${COOKIE_MAX_AGE};SameSite=Strict;HttpOnly${isSecure ? ';Secure' : ''}`;
}

// m11: Timing-safe token comparison
function safeTokenCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; /* encoding error — treat as mismatch */ }
}

function isAuthenticated(req) {
  if (isLocalhost(req)) return true;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (safeTokenCompare(url.searchParams.get('token'), LAN_TOKEN)) return true;
  const cookies = parseCookies(req);
  if (safeTokenCompare(cookies[TOKEN_COOKIE], LAN_TOKEN)) return true;
  return false;
}

// ──────────── CSRF Protection ────────────
function csrfCheck(req) {
  // GET/HEAD/OPTIONS are safe methods — skip check
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  // m2: Even localhost must pass origin/referer check if present
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const host = req.headers['host'] || '';
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; /* malformed origin URL */ }
  }
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; /* malformed referer URL */ }
  }
  // No origin/referer: allow localhost (non-browser tools like curl), block LAN
  if (isLocalhost(req)) return true;
  return false;
}

function serveLoginPage(res) {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cockpit - Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2rem;max-width:400px;width:90%}
  h1{font-size:1.3rem;margin-bottom:.5rem}
  p{color:#94a3b8;font-size:.85rem;margin-bottom:1.2rem;line-height:1.5}
  input{width:100%;padding:.6rem .8rem;border:1px solid #475569;border-radius:6px;background:#0f172a;color:#e2e8f0;font-size:.9rem;font-family:monospace;margin-bottom:.8rem}
  input:focus{outline:none;border-color:#818cf8}
  button{width:100%;padding:.6rem;background:#818cf8;color:#fff;border:none;border-radius:6px;font-size:.9rem;cursor:pointer}
  button:hover{background:#6366f1}
  .err{color:#f87171;font-size:.8rem;margin-bottom:.5rem;display:none}
</style>
</head><body>
<div class="card">
  <h1>Cockpit Dashboard</h1>
  <p>LAN access requires authentication.<br>Enter the token shown in the server console.</p>
  <div class="err" id="err">Invalid token</div>
  <form onsubmit="return doLogin()">
    <input id="tok" placeholder="Access token" autofocus autocomplete="off">
    <button type="submit">Login</button>
  </form>
</div>
<script>
function doLogin(){
  var t=document.getElementById('tok').value.trim();
  if(!t)return false;
  fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})}).then(function(r){
    if(r.ok){location.href='/';}
    else{document.getElementById('err').style.display='block';}
  });
  return false;
}
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ──────────── Shared Validators ────────────
const BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;
function isValidBranch(name) { return name && BRANCH_RE.test(name); }

/** Resolve & normalize a path to lowercase forward-slash form for safe comparison */
function normPath(p) { return resolve(normalize(p)).replace(/\\/g, '/').toLowerCase(); }

/** Check if filePath is inside any registered project root */
function isInsideAnyProject(filePath) {
  const resolved = normPath(filePath);
  return getProjects().some(p => {
    const root = normPath(p.path);
    return resolved.startsWith(root + '/') || resolved === root;
  });
}

const STASH_RE = /^stash@\{\d{1,3}\}$/;
function isValidStashRef(ref) { return ref && STASH_RE.test(ref); }

// ──────────── Router ────────────
const routes = [];

function addRoute(method, pattern, handler) {
  const paramNames = [];
  const regexStr = pattern.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => params[name] = match[i + 1]);
      return { handler: route.handler, params };
    }
  }
  return null;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function withProject(handler, paramName = 'id') {
  return async (req, res) => {
    const project = getProjectById(req.params[paramName]);
    if (!project) return json(res, { error: 'Not found' }, 404);
    return handler(req, res, project);
  };
}

// M5: Simple in-memory rate limiter for expensive endpoints
const _rateLimits = new Map(); // key → { count, resetAt }
function rateLimit(key, maxPerMinute = 5) {
  const now = Date.now();
  let entry = _rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    _rateLimits.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}
// Periodic cleanup of stale entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimits) { if (now > v.resetAt) _rateLimits.delete(k); }
}, 120000);

// MAJOR-6: JSON body with size limit (5 MB)
async function readBody(req) {
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > LIMITS.jsonBodyBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) {
    // M6: Throw instead of silently returning {} — callers should handle 400
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

// ──────────── Static File Routes ────────────

// Serve frontend
addRoute('GET', '/', async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(await getCachedHTML());
});

// Serve PWA files
addRoute('GET', '/manifest.json', async (_req, res) => {
  try {
    const content = await readFile(join(__dirname, 'manifest.json'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(content);
  } catch { /* file not found */ res.writeHead(404); res.end('Not found'); }
});
addRoute('GET', '/sw.js', async (_req, res) => {
  try {
    const content = await readFile(join(__dirname, 'sw.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' });
    res.end(content);
  } catch { /* file not found */ res.writeHead(404); res.end('Not found'); }
});
// Serve JS modules from js/ directory
addRoute('GET', '/js/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.js') || filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(join(__dirname, 'js', filename), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { /* file not found */ res.writeHead(404); res.end('Not found'); }
});

// Serve CSS module files
addRoute('GET', '/css/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.css') || filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(join(__dirname, 'css', filename), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { /* file not found */ res.writeHead(404); res.end('Not found'); }
});

// Serve vendor files (xterm.js etc.)
addRoute('GET', '/vendor/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = filename.endsWith('.css') ? 'text/css' : 'text/javascript';
  try {
    const content = await readFile(join(__dirname, 'vendor', filename));
    res.writeHead(200, { 'Content-Type': `${ext}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { /* file not found */ res.writeHead(404); res.end('Not found'); }
});
// Claude sessions 목록 — 해당 프로젝트의 .jsonl 파일들 (mtime 순)
// in-memory 캐시: file → { mtime, size, title } · mtime 변경 시만 재파싱
const SESSION_TITLE_CACHE = new Map(); // filePath → { mtime, title, size }
addRoute('GET', '/api/claude-sessions', async (req, res) => {
  try {
    const projectPath = req.query?.projectPath;
    if (!projectPath) { res.writeHead(400); return res.end('{}'); }
    const encoded = projectPath.replace(/[/\\]/g, '-');
    const dir = join(homedir(), '.claude', 'projects', encoded);
    if (!existsSync(dir)) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ sessions: [] }));
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const sessions = await Promise.all(files.map(async (f) => {
      const fpath = join(dir, f);
      const s = await stat(fpath);
      const cached = SESSION_TITLE_CACHE.get(fpath);
      // mtime / size 동일하면 캐시 hit
      if (cached && cached.mtime === s.mtimeMs && cached.size === s.size) {
        return { id: f.replace(/\.jsonl$/, ''), file: f, mtime: s.mtimeMs, size: s.size, title: cached.title };
      }
      // miss — 첫 user message peek (50라인만)
      let title = '';
      try {
        // 큰 파일은 첫 8KB 만 read (50 message header 면 보통 1~4KB)
        const fd = await readFile(fpath, { encoding: 'utf8' });
        for (const line of fd.split('\n').slice(0, 50)) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && d.message?.content) {
              const c = d.message.content;
              const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x.type === 'text')?.text || '') : '';
              if (text.trim()) { title = text.replace(/\s+/g, ' ').slice(0, 60); break; }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      SESSION_TITLE_CACHE.set(fpath, { mtime: s.mtimeMs, size: s.size, title });
      // LRU cap — 500 entries
      if (SESSION_TITLE_CACHE.size > 500) {
        const firstKey = SESSION_TITLE_CACHE.keys().next().value;
        SESSION_TITLE_CACHE.delete(firstKey);
      }
      return { id: f.replace(/\.jsonl$/, ''), file: f, mtime: s.mtimeMs, size: s.size, title };
    }));
    sessions.sort((a, b) => b.mtime - a.mtime);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

// Claude session.jsonl — 프로젝트 path 기준 최근 세션 파싱 (또는 sessionId 지정)
addRoute('GET', '/api/claude-session', async (req, res) => {
  try {
    const projectPath = req.query?.projectPath;
    if (!projectPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'projectPath required' }));
    }
    // Claude 의 jsonl 파일은 ~/.claude/projects/<encoded-path>/ 안에 저장됨
    // 인코딩: / → -, 첫 / 도 - (예: /home/user → -home-user)
    const encoded = projectPath.replace(/[/\\]/g, '-');
    const dir = join(homedir(), '.claude', 'projects', encoded);
    if (!existsSync(dir)) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [], session: null }));
    }
    const wantSession = req.query?.sessionId;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ messages: [], session: null }));
    }
    const sorted = await Promise.all(files.map(async (f) => {
      const s = await stat(join(dir, f));
      return { name: f, mtime: s.mtimeMs };
    }));
    sorted.sort((a, b) => b.mtime - a.mtime);
    let latest = sorted[0].name;
    if (wantSession) {
      const match = files.find((f) => f === `${wantSession}.jsonl` || f.startsWith(wantSession));
      if (match) latest = match;
    }
    const fstat = await stat(join(dir, latest));
    const content = await readFile(join(dir, latest), 'utf8');
    // usage 누적 — token 표시용
    let tokensIn = 0, tokensOut = 0, model = '';
    const messages = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' || d.type === 'assistant') {
          const m = d.message || {};
          if (m.usage) {
            tokensIn += (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
            tokensOut += m.usage.output_tokens || 0;
          }
          if (m.model && !model) model = m.model;
          const ts = d.timestamp || d.createdAt || null;
          const c = m.content;
          const parts = [];
          if (typeof c === 'string') {
            parts.push({ kind: 'text', text: c });
          } else if (Array.isArray(c)) {
            for (const item of c) {
              if (!item || typeof item !== 'object') continue;
              if (item.type === 'text') parts.push({ kind: 'text', text: item.text || '' });
              else if (item.type === 'thinking') parts.push({ kind: 'thinking', text: item.thinking || '' });
              else if (item.type === 'tool_use') parts.push({ kind: 'tool_use', name: item.name, input: item.input || {}, id: item.id });
              else if (item.type === 'tool_result') {
                // tool_result.content 도 array 일 수 있음 — image 포함 가능
                if (Array.isArray(item.content)) {
                  const flat = [];
                  for (const sub of item.content) {
                    if (!sub) continue;
                    if (sub.type === 'image' && sub.source) {
                      const s = sub.source;
                      if (s.type === 'base64') parts.push({ kind: 'image', media_type: s.media_type, data: s.data, label: 'tool image' });
                      else if (s.type === 'url') parts.push({ kind: 'image', url: s.url, label: 'tool image' });
                    } else if (sub.type === 'text') {
                      flat.push(sub.text || '');
                    } else if (typeof sub === 'string') {
                      flat.push(sub);
                    }
                  }
                  if (flat.length) parts.push({ kind: 'tool_result', content: flat.join('\n'), tool_use_id: item.tool_use_id });
                } else {
                  parts.push({ kind: 'tool_result', content: item.content, tool_use_id: item.tool_use_id });
                }
              }
              else if (item.type === 'image' && item.source) {
                const s = item.source;
                if (s.type === 'base64') parts.push({ kind: 'image', media_type: s.media_type, data: s.data });
                else if (s.type === 'url') parts.push({ kind: 'image', url: s.url });
              }
            }
          }
          if (parts.length) messages.push({ role: d.type, ts, parts });
        }
      } catch { /* skip */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: latest,
      mtime: fstat.mtimeMs,
      model,
      usage: { in: tokensIn, out: tokensOut },
      messages,
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// vendor/fonts/X.woff2 (Pretendard 등)
addRoute('GET', '/vendor/fonts/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  const ct = filename.endsWith('.woff2') ? 'font/woff2'
           : filename.endsWith('.woff') ? 'font/woff'
           : filename.endsWith('.ttf') ? 'font/ttf'
           : 'application/octet-stream';
  try {
    const content = await readFile(join(__dirname, 'vendor', 'fonts', filename));
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});

// ──────────── Image Upload (chat view paste/drop) ────────────
const UPLOAD_DIR = join(tmpdir(), 'cockpit-uploads');
try { await mkdir(UPLOAD_DIR, { recursive: true }); } catch { /* dir exists */ }

addRoute('POST', '/api/uploads', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected multipart/form-data' }));
    return;
  }
  // 간단 multipart 파서 (단일 파일, boundary 만 처리)
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no boundary in content-type' }));
    return;
  }
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);
  const chunks = [];
  let totalSize = 0;
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB

  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_SIZE) { reject(new Error('file too large (>10MB)')); return; }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  }).catch((e) => {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return null;
  });
  if (totalSize > MAX_SIZE) return;

  const buf = Buffer.concat(chunks);
  // boundary 로 분할 — 단일 파일 만 처리
  const parts = buf.toString('binary').split(boundary);
  let saved = null;
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));
    const filenameMatch = header.match(/filename="([^"]+)"/);
    if (!filenameMatch) continue;
    const origName = filenameMatch[1];
    const ext = (origName.split('.').pop() || 'bin').toLowerCase().slice(0, 8);
    if (!/^[a-z0-9]+$/.test(ext)) continue;
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `extension .${ext} not allowed` }));
      return;
    }
    const ts = Date.now().toString(36);
    const rand = randomBytes(3).toString('hex');
    const name = `img-${ts}-${rand}.${ext}`;
    const filePath = join(UPLOAD_DIR, name);
    const data = Buffer.from(body, 'binary');
    await writeFile(filePath, data);
    saved = { path: filePath, name, size: data.length };
    break;
  }
  if (!saved) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no file found in upload' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(saved));
});

// ──────────── Dev Server State ────────────
const devServers = new Map(); // projectId → { process, command, startedAt, port }

// ──────────── callClaude (used by init: workflows) ────────────

/**
 * callClaude — invoke Claude CLI.
 * @param {string} prompt - User message (stdin)
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {string} opts.model
 * @param {string} opts.systemPrompt - System prompt (separate from user message).
 *   C1: System prompt uses Markdown (no angle brackets), so --system-prompt
 *   works safely on ALL platforms including Windows cmd.exe.
 */
function callClaude(prompt, { timeoutMs = LIMITS.claudeTimeoutMs, model = 'haiku', systemPrompt } = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // C2: On Windows, call node + cli.js directly (shell: false) to avoid
    // cmd.exe encoding issues with Korean text and special chars in --system-prompt.
    // With shell: false, Node.js passes args as proper Unicode strings via CreateProcessW.
    let bin, args;
    if (isWin) {
      const nodeExe = process.execPath; // Current node.exe path
      const cliJs = join(dirname(nodeExe), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      bin = nodeExe;
      args = [cliJs, '-p', '--model', model];
    } else {
      bin = 'claude';
      args = ['-p', '--model', model];
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      reject(new Error('Claude CLI timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`Failed to run claude CLI: ${err.message}`)); } });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * callClaudeStream — invoke Claude CLI with streaming output.
 * Calls onChunk(text) for each text delta.
 * Returns full accumulated text.
 */
function callClaudeStream(prompt, { timeoutMs = LIMITS.claudeTimeoutMs, model = 'haiku', systemPrompt, onChunk, continue: useContinue = false } = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let bin, args;
    if (isWin) {
      const nodeExe = process.execPath;
      const cliJs = join(dirname(nodeExe), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      bin = nodeExe;
      args = [cliJs, '-p', '--verbose', '--model', model, '--output-format', 'stream-json'];
    } else {
      bin = 'claude';
      args = ['-p', '--verbose', '--model', model, '--output-format', 'stream-json'];
    }
    if (useContinue) args.push('--continue');
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env,
    });

    let fullText = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      reject(new Error('Claude CLI timed out'));
    }, timeoutMs);

    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
            fullText += obj.delta.text;
            if (onChunk) onChunk(obj.delta.text);
          } else if (obj.type === 'message' && obj.message?.content) {
            // Final message fallback
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text && !fullText) {
                fullText = block.text;
                if (onChunk) onChunk(block.text);
              }
            }
          } else if (obj.type === 'result' && typeof obj.result === 'string' && !fullText) {
            fullText = obj.result;
            if (onChunk) onChunk(obj.result);
          }
        } catch { /* incomplete JSON line — skip */ }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`Failed to run claude CLI: ${err.message}`)); } });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer);
          if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
            fullText += obj.delta.text;
            if (onChunk) onChunk(obj.delta.text);
          } else if (obj.type === 'result' && typeof obj.result === 'string') {
            if (!fullText) fullText = obj.result;
          } else if (obj.type === 'message' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text && !fullText) fullText = block.text;
            }
          }
        } catch { /* not valid JSON */ }
      }
      if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve(fullText);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ─── Route Context & Registration ───
const routeCtx = {
  addRoute, json, withProject, readBody, rateLimit,
  getProjects, getProjectById, addProject, updateProject, deleteProject,
  getJiraConfig, saveJiraConfig, getAiConfig, saveAiConfig, callClaudeStream,
  withGitLock, gitExec, toWinPath, parseWslPath, spawnForProject,
  isInsideAnyProject, isValidBranch, isValidStashRef, isLocalhost, authCookie,
  PORT, LIMITS, DATA_DIR, __dirname, PKG_VERSION,
  readFile, readdir, stat, writeFile, mkdir, existsSync, readFileSync, unlinkSync,
  join, resolve, normalize, spawn, execFile, randomBytes, timingSafeEqual, tmpdir,
  poller, devServers, LAN_TOKEN,
  get wss() { return wss; },
  get terminals() { return terminals; },
  get registerProjectPollers() { return registerProjectPollers; },
  get getNetworkIPs() { return regProjectsResult?.getNetworkIPs; },
};

const regProjectsResult = regProjects(routeCtx);
regSystem(routeCtx);
regCicd(routeCtx);
regPR(routeCtx);
regWorkflows(routeCtx);
regSessions(routeCtx);
regAgent(routeCtx);
regGit(routeCtx);
regPorts(routeCtx);
regTelegram(routeCtx);
regSupervisor(routeCtx);
regAutopilot(routeCtx);

// ──────────── Polling ────────────

const _prevSessionStates = new Map();
const _notifyEnabled = true;

function registerProjectPollers(project) {
  poller.register(`session:${project.id}`, () => {
    const result = detectSessionState(project);
    const prev = _prevSessionStates.get(project.id);
    _prevSessionStates.set(project.id, result.state);
    if (_notifyEnabled && prev && prev !== result.state) {
      const wasActive = prev === 'busy' || prev === 'waiting';
      if (wasActive && result.state === 'idle') {
        showNotification(`${project.name} — Session Complete`, 'Claude session finished.');
      }
    }
    return result;
  }, POLL_INTERVALS.sessionStatus, 'session:status');
  poller.register(`git:${project.id}`, () => getGitStatus(project), POLL_INTERVALS.gitStatus, 'git:update');
  poller.register(`pr:${project.id}`, () => getGitHubPRs(project), POLL_INTERVALS.prStatus, 'pr:update');
}

for (const project of getProjects()) {
  registerProjectPollers(project);
}

poller.register('cost:daily', computeUsage, POLL_INTERVALS.costData, 'cost:update');
poller.register('activity', () => getRecentActivity(), POLL_INTERVALS.activity, 'activity:new');

// Initialize Workflows engine — m13: handle init errors
try { initWorkflows(poller, callClaude); } catch (err) { logger.error('workflows', 'Init failed', err.message); }
try { initScheduler(poller, startWorkflowRun); } catch (err) { logger.error('scheduler', 'Init failed', err.message); }

// Initialize Agent engine
try {
  initAgent(poller, null,
    () => getProjects().map(p => p.path),
    () => getProjects().map(p => ({ name: p.name, path: p.path, stack: p.stack })),
    {
      getJiraConfig,
      geminiApiKey: getAiConfig()?.geminiApiKey || null,
      callClaudeStream,
      cockpit: {
        computeUsage,
        getProjects,
        getProjectById,
        listNotes,
        getNote,
        createNote,
        updateNote,
        getAllStats: getMonitorStats,
        generateBriefing,
        checkAlerts,
        getRecentActivity,
        listWorkflowDefs,
        getWorkflowDef,
        listWorkflowRuns,
        getWorkflowRunDetail,
        startWorkflowRun,
        poller,
        // Terminal access for agent
        listTerminals: () => {
          const result = [];
          for (const [id, t] of terminals) {
            result.push({ termId: id, projectId: t.projectId, command: t.command || '' });
          }
          return result;
        },
        readTerminalBuffer: (termId) => {
          const t = terminals.get(termId);
          if (!t) return null;
          return bufRead(t);
        },
        writeTerminalInput: (termId, data) => {
          const t = terminals.get(termId);
          if (!t) return false;
          t.pty.write(data);
          return true;
        },
        createTerminal: (projectId, command) => {
          const project = getProjectById(projectId);
          if (!project) return null;
          const termId = 'agent-' + Date.now();
          const shell = getShell();
          const shellArgs = IS_WIN ? [] : ['-l'];
          let cwd;
          try { cwd = IS_WIN ? toWinPath(project.path) : project.path; } catch { cwd = project.path; }
          const term = pty.spawn(shell, shellArgs, {
            name: 'xterm-256color', cols: 120, rows: 30, cwd, env: cleanEnv,
          });
          term.onData((data) => {
            const e = terminals.get(termId);
            if (e) bufAppend(e, data);
            const msg = JSON.stringify({ type: 'output', termId, data });
            for (const client of wss.clients) { try { client.send(msg); } catch { /* client disconnected */ } }
          });
          term.onExit(({ exitCode }) => {
            terminals.delete(termId);
            const msg = JSON.stringify({ type: 'exit', termId, exitCode });
            for (const client of wss.clients) { try { client.send(msg); } catch { /* client disconnected */ } }
            saveTerminalState();
          });
          let safeCommand = '';
          if (command && typeof command === 'string' && command.length < 500
              && /^(claude|npm|npx|node|git|python|pip|docker|yarn|pnpm|bun|cargo|make|cmake|go|rustc|ruby|java|javac|mvn|gradle|dotnet|terraform|kubectl|helm|ansible|packer|deno|tsx|ts-node|jest|vitest|pytest|eslint|prettier|tsc)\b/.test(command)
              && !/[&|<>^;`$]/.test(command)) {
            safeCommand = command;
          }
          terminals.set(termId, { pty: term, projectId, _bufArr: [], _bufLen: 0, command: safeCommand });
          const createdMsg = JSON.stringify({ type: 'created', termId, projectId });
          for (const client of wss.clients) { try { client.send(createdMsg); } catch { /* client disconnected */ } }
          if (safeCommand) term.write(safeCommand + '\r');
          saveTerminalState();
          return termId;
        },
      },
    }
  );
} catch (err) { logger.error('agent', 'Init failed', err.message); }

// Initialize Telegram bridge (optional — uses telegram-config.json)
try {
  telegramBridge.init(
    {
      chat: agentChat,
      getConversation: agentGetConv,
      isRunning: agentIsRunning,
      newConversation: agentNewConv,
    },
    { logger },
    {
      getProjects,
      poller,
      supervisor: supervisorService,
      listTerminals: () => { const r = []; for (const [id, t] of terminals) r.push({ termId: id, projectId: t.projectId, command: t.command || '' }); return r; },
      readTerminalBuffer: (id) => { const t = terminals.get(id); return t ? bufRead(t) : null; },
    },
  );
  if (telegramBridge.isEnabled()) {
    telegramBridge.startPolling();
  } else {
    logger.info('telegram', 'not configured — polling skipped');
  }
} catch (err) { logger.error('telegram', 'Init failed', err.message); }

// Initialize Autopilot engine — phone approval via the Telegram bridge.
try {
  initAutopilot({
    logger,
    mode: 'attended', // safe default; POST /api/autopilot/mode to flip to 'unattended'
    askHuman: async (prompt, ctx) => {
      const approved = await telegramBridge.requestApproval(
        `오토파일럿: ${ctx.category}`, prompt,
        { hard: ctx.category === 'production' || ctx.category === 'destructive' },
      );
      return approved ? 'approve' : 'deny';
    },
  });
} catch (err) { logger.error('autopilot', 'Init failed', err.message); }

// Initialize Autonomy Scheduler (자율 트리거)
try {
  autonomyScheduler.init({
    agent: { chat: agentChat, getConversation: agentGetConv, isRunning: agentIsRunning, newConversation: agentNewConv },
    telegram: telegramBridge,
    logger,
  });
} catch (err) { logger.error('scheduler', 'Init failed', err.message); }

// Initialize Supervisor (PreToolUse hook 결정 자동화)
try {
  supervisorLlm.init({ logger });
  supervisorService.init({
    telegram: telegramBridge,
    logger,
  });
  logger.info('supervisor', `initialized (LLM ${supervisorLlm.isReady() ? 'ready' : 'no api key'})`);
} catch (err) { logger.error('supervisor', 'Init failed', err.message); }

// Agent Monitor init — deferred to after terminals Map declaration (see below)

// ──────────── Init new services ────────────

initBatch(poller);

// Morning briefing: save daily snapshot on startup
try {
  const projectStates = {};
  for (const p of getProjects()) {
    projectStates[p.id] = { session: null, git: null, prs: null };
  }
  saveDailySnapshot(projectStates, null);
} catch { /* non-critical — briefing snapshot can fail silently */ }

// ──────────── Server ────────────

const server = createServer(async (req, res) => {
  // m10: Security headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* http://localhost:*; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net");

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Anti DNS-rebinding: reject any request whose Host header we don't recognize,
  // before it can reach auth (which trusts localhost by remoteAddress).
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: host not allowed');
    return;
  }

  // LAN auth: token via query param sets cookie and redirects (MINOR-8: timing-safe)
  if (!isLocalhost(req) && safeTokenCompare(url.searchParams.get('token'), LAN_TOKEN)) {
    res.writeHead(200, {
      'Set-Cookie': authCookie(req),
      'Content-Type': 'text/html'
    });
    res.end(`<html><head><meta http-equiv="refresh" content="0;url=/"></head><body>Redirecting...</body></html>`);
    return;
  }

  // LAN auth: block unauthenticated requests (exempt login endpoint)
  if (!isAuthenticated(req) && url.pathname !== '/api/auth/login') {
    serveLoginPage(res);
    return;
  }

  const route = matchRoute(req.method, url.pathname);

  if (route) {
    req.params = route.params;
    req.query = Object.fromEntries(url.searchParams);
    // CSRF: block non-GET requests from foreign origins
    if (!csrfCheck(req)) {
      json(res, { error: 'CSRF check failed' }, 403);
      return;
    }
    try {
      await route.handler(req, res);
    } catch (err) {
      if (!res.writableEnded) {
        const status = err.message?.startsWith('Invalid JSON') ? 400 : 500;
        json(res, { error: err.message || 'Internal error' }, status);
      }
      if (!err.message?.startsWith('Invalid JSON')) logger.error('server', 'Request handler error', err);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ──────────── WebSocket Terminal ────────────

const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => {
    if (!hostAllowed(req)) return false;   // anti DNS-rebinding (see hostAllowed)
    if (!isAuthenticated(req)) return false;
    // INFO-4: Verify Origin header to prevent cross-site WebSocket hijacking
    const origin = req.headers['origin'];
    if (origin) {
      try {
        const o = new URL(origin);
        const host = req.headers['host'] || '';
        if (o.host !== host) return false;
      } catch { return false; /* malformed origin URL */ }
    }
    return true;
  }
});

// Clean env for child terminals: remove CLAUDECODE to allow nested claude launches
const cleanEnv = { ...process.env, TERM: 'xterm-256color' };
delete cleanEnv.CLAUDECODE;

// Track active PTY processes: Map<termId, { pty, projectId, buffer, command }>
const terminals = new Map();
const MAX_BUFFER = 50000;
// Optimized buffer: append to array, join on read
function bufAppend(entry, data) {
  // OSC 52(클립보드 복사) 시퀀스는 리플레이 버퍼에 저장하지 않음 — 과거 복사가
  // 재접속 시 클립보드를 덮어쓰고, 트림에 잘리면 base64 조각이 화면에 텍스트로 노출됨
  if (data.includes('\x1b]52;')) data = data.replace(/\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
  entry._bufArr.push(data);
  entry._bufLen += data.length;
  while (entry._bufLen > MAX_BUFFER && entry._bufArr.length > 1) {
    entry._bufLen -= entry._bufArr.shift().length;
    entry._bufTrimmed = true; // 청크 경계는 이스케이프 시퀀스 중간일 수 있음
  }
}
function bufRead(entry) {
  let s = entry._bufArr.join('');
  // 트림된 적 있으면 첫 개행까지 버려서 잘린 시퀀스 조각이 리플레이되지 않게
  if (entry._bufTrimmed) {
    const i = s.indexOf('\n');
    if (i >= 0 && i < 4096) s = s.slice(i + 1);
  }
  return s;
}

// ── Session State Persistence (tmux-resurrect style) ──

let _saveQueued = false;
// Initialize Agent Monitor (proactive background scanning) — after terminals Map
try {
  const monitorCockpit = {
    listTerminals: () => { const r = []; for (const [id, t] of terminals) r.push({ termId: id, projectId: t.projectId, command: t.command || '' }); return r; },
    readTerminalBuffer: (id) => { const t = terminals.get(id); return t ? bufRead(t) : null; },
    getProjects,
  };
  initMonitorAgent(poller, monitorCockpit, getProjects, {
    getJiraConfig,
    triggerReview: async (agentId, prompt, metadata) => {
      // No Gemini key → don't create empty conversations that chat() will immediately
      // fail on. This was writing junk to agent-history.json on every commit scan.
      if (!agentIsConfigured()) return '';
      try {
        const conv = agentNewConv();
        // Fire-and-forget: chat sends SSE events, frontend captures as reports
        // Tag the conversation so frontend knows it's a monitor-triggered review
        poller.broadcast('monitor:review-start', { convId: conv.id, agentId, ...metadata });
        agentChat(conv.id, prompt, agentId);
        return conv.id;
      } catch (err) {
        logger.warn('monitor', 'triggerReview failed', err.message);
        return '';
      }
    },
  });
} catch (err) { logger.error('monitor', 'Init failed', err.message); }

function saveTerminalState() {
  if (_saveQueued) return; // debounce
  _saveQueued = true;
  queueMicrotask(async () => {
    _saveQueued = false;
    const st = [];
    for (const [id, t] of terminals) {
      // 셸의 실제 현재 경로 캡처 (사용자가 cd 로 바꾼 경로까지). Linux/WSL: /proc/<pid>/cwd
      let cwd = '';
      try { if (t.pty?.pid) cwd = readlinkSync(`/proc/${t.pty.pid}/cwd`); }
      catch { /* /proc 없음(비-Linux) 또는 프로세스 종료 — 경로 생략, 복원 시 루트로 폴백 */ }
      st.push({ termId: id, projectId: t.projectId, command: t.command || '', cwd });
    }
    if (st.length === 0 && !existsSync(STATE_FILE)) return;
    try {
      await writeFile(STATE_FILE, JSON.stringify({ terminals: st, timestamp: Date.now() }));
      if (st.length > 0) logger.debug('state', `Saved ${st.length} terminal(s)`);
    } catch (err) {
      logger.error('state', 'Save error', err.message);
    }
  });
}

function loadTerminalState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // Only restore if less than 24 hours old
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      try { unlinkSync(STATE_FILE); } catch { /* cleanup — file may not exist */ }
      return null;
    }
    return data;
  } catch { return null; /* corrupt state file — skip restore */ }
}

function restoreTerminals() {
  const saved = loadTerminalState();
  if (!saved?.terminals?.length) return null;

  const idMap = {};
  const restored = [];

  for (const entry of saved.terminals) {
    // __home__ = 프로젝트 비종속 빈 터미널. 그 외엔 등록 프로젝트 필요.
    const isHome = entry.projectId === '__home__';
    const project = isHome ? null : getProjectById(entry.projectId);
    if (!isHome && !project) continue;

    // 복원 기준 경로: 저장된 cwd(사용자가 cd 한 위치)가 아직 살아있으면 그것, 아니면 프로젝트 루트(홈)
    const basePath = isHome ? homedir() : project.path;
    let termPath = basePath;
    if (entry.cwd && existsSync(IS_WIN ? toWinPath(entry.cwd) : entry.cwd)) {
      termPath = entry.cwd;
    }

    const newTermId = `${entry.projectId}-${randomBytes(6).toString('hex')}`;
    const wsl = parseWslPath(termPath);
    let shell, shellArgs, cwd;
    if (wsl) {
      shell = 'wsl.exe';
      shellArgs = ['-d', wsl.distro, '--cd', wsl.linuxPath];
      cwd = process.env.SYSTEMROOT || 'C:\\Windows';
    } else {
      shell = _defaultShell;
      shellArgs = [];
      cwd = IS_WIN ? toWinPath(termPath) : termPath;
    }

    const term = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120, rows: 30, cwd,
      env: cleanEnv
    });

    term.onData((data) => {
      const e = terminals.get(newTermId);
      if (e) bufAppend(e, data);
      const msg = JSON.stringify({ type: 'output', termId: newTermId, data });
      for (const client of wss.clients) {
        try { client.send(msg); } catch { /* client disconnected */ }
      }
    });

    term.onExit(({ exitCode }) => {
      terminals.delete(newTermId);
      const msg = JSON.stringify({ type: 'exit', termId: newTermId, exitCode });
      for (const client of wss.clients) {
        try { client.send(msg); } catch { /* client disconnected */ }
      }
    });

    terminals.set(newTermId, { pty: term, projectId: entry.projectId, _bufArr: [], _bufLen: 0, command: entry.command || '' });
    idMap[entry.termId] = newTermId;
    restored.push({ termId: newTermId, projectId: entry.projectId });

    // 복원된 모든 터미널에 'claude' 를 미리 입력만 해둠 (실행 X — 사용자가 Enter 로 시작).
    // \r 안 붙임: 프롬프트에 타이핑만 된 상태로 대기.
    setTimeout(() => { try { term.write('claude'); } catch { /* term already gone */ } }, 500);
  }

  // Clean up state file after successful restore
  try { unlinkSync(STATE_FILE); } catch { /* cleanup — file may not exist */ }

  logger.info('state', `Restored ${restored.length} terminal(s) from saved state`);
  return { idMap, restored };
}

// Auto-save terminal state every 30 seconds
setInterval(saveTerminalState, 30000);

// Save on shutdown
function onShutdown(signal) {
  logger.info('server', `${signal} received, shutting down...`);
  saveTerminalState();
  // Kill all terminal processes
  for (const [, t] of terminals) { try { t.pty.kill(); } catch { /* process already exited */ } }
  // Kill dev server processes
  for (const [, ds] of devServers) {
    try { killProcessTree(ds.process.pid); } catch { /* process already exited */ }
  }
  devServers.clear();
  // Close all WebSocket connections
  for (const client of wss.clients) { try { client.close(1001, 'Server shutting down'); } catch { /* ignore */ } }
  // Stop accepting new connections
  server.close(() => { logger.info('server', 'HTTP server closed'); });
  wss.close(() => { logger.info('ws', 'WebSocket server closed'); });
  // Force exit after 5s if cleanup hangs
  setTimeout(() => { logger.error('server', 'Force exit after timeout'); process.exit(1); }, 5000).unref();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

let _terminalsRestored = false;
wss.on('connection', (ws) => {
  let _currentTermId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; /* malformed JSON, ignore message */ }

    switch (msg.type) {
      case 'create': {
        // Plain/scratch terminal — not tied to any project, opens in home dir
        const isHome = msg.projectId === '__home__';
        let termPath;
        if (isHome) {
          termPath = homedir();
        } else {
          // Create a new PTY terminal for a project
          const project = getProjectById(msg.projectId);
          if (!project) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown project' })); return; }

          // C5: Validate cwd against project path — must be inside project or omitted
          termPath = project.path;
          if (msg.cwd && typeof msg.cwd === 'string') {
            const resolvedCwd = resolve(normalize(IS_WIN ? toWinPath(msg.cwd) : msg.cwd)).replace(/\\/g, '/').toLowerCase();
            const projResolved = resolve(normalize(IS_WIN ? toWinPath(project.path) : project.path)).replace(/\\/g, '/').toLowerCase();
            if (resolvedCwd.startsWith(projResolved + '/') || resolvedCwd === projResolved) {
              termPath = msg.cwd;
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'cwd must be inside project directory' }));
              return;
            }
          }
        }

        const termId = `${msg.projectId}-${randomBytes(6).toString('hex')}`;
        const wsl = parseWslPath(termPath);
        let shell, shellArgs, cwd;
        if (wsl) {
          shell = 'wsl.exe';
          shellArgs = ['-d', wsl.distro, '--cd', wsl.linuxPath];
          cwd = process.env.SYSTEMROOT || 'C:\\Windows';
        } else {
          shell = _defaultShell;
          shellArgs = [];
          cwd = IS_WIN ? toWinPath(termPath) : termPath;
        }

        const term = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: msg.cols || 120,
          rows: msg.rows || 30,
          cwd,
          env: cleanEnv
        });

        term.onData((data) => {
          const entry = terminals.get(termId);
          if (entry) bufAppend(entry, data);
          const msg = JSON.stringify({ type: 'output', termId, data });
          for (const client of wss.clients) {
            try { client.send(msg); } catch { /* client disconnected */ }
          }
        });

        term.onExit(({ exitCode }) => {
          terminals.delete(termId);
          const msg = JSON.stringify({ type: 'exit', termId, exitCode });
          for (const client of wss.clients) {
            try { client.send(msg); } catch { /* client disconnected */ }
          }
        });

        // C4: Validate command — only allow safe known prefixes
        let safeCommand = '';
        if (msg.command && typeof msg.command === 'string' && msg.command.length < 500
            && /^(claude|npm|npx|node|git|python|pip|docker|yarn|pnpm|bun|cargo|make|cmake|go|rustc|ruby|java|javac|mvn|gradle|dotnet|terraform|kubectl|helm|ansible|packer|deno|tsx|ts-node|jest|vitest|pytest|eslint|prettier|tsc)\b/.test(msg.command)
            && !/[&|<>^;`$]/.test(msg.command)) {
          safeCommand = msg.command;
        }

        terminals.set(termId, { pty: term, projectId: msg.projectId, _bufArr: [], _bufLen: 0, command: safeCommand });
        _currentTermId = termId;

        const createdMsg = JSON.stringify({ type: 'created', termId, projectId: msg.projectId });
        for (const client of wss.clients) {
          try { client.send(createdMsg); } catch { /* client disconnected */ }
        }

        // Auto-run only validated commands
        if (safeCommand) {
          term.write(safeCommand + '\r');
        }
        break;
      }

      case 'input': {
        const t = terminals.get(msg.termId);
        if (t) t.pty.write(msg.data);
        break;
      }

      case 'resize': {
        const t = terminals.get(msg.termId);
        if (t) t.pty.resize(msg.cols, msg.rows);
        break;
      }

      case 'kill': {
        const t = terminals.get(msg.termId);
        if (t) { t.pty.kill(); terminals.delete(msg.termId); }
        break;
      }

      case 'chat-watch': {
        // session.jsonl 변경 실시간 push (한 leaf 당 한 watcher)
        const projectPath = msg.projectPath;
        const termId = msg.termId;
        if (!projectPath || !termId) break;
        const encoded = projectPath.replace(/[/\\]/g, '-');
        const dir = join(homedir(), '.claude', 'projects', encoded);
        if (!existsSync(dir)) break;
        if (!ws._chatWatchers) ws._chatWatchers = new Map();
        // 이미 watching 이면 패스
        if (ws._chatWatchers.has(termId)) break;
        let debounceTimer = null;
        try {
          const watcher = watch(dir, { persistent: false }, (eventType, fname) => {
            if (!fname || !fname.endsWith('.jsonl')) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              try {
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'session-update', termId, projectPath, file: fname }));
                }
              } catch { /* ws closed */ }
            }, 120);
          });
          watcher.on('error', () => { try { watcher.close(); } catch {} ws._chatWatchers?.delete(termId); });
          ws._chatWatchers.set(termId, watcher);
        } catch (e) {
          logger.warn?.('chat-watch', 'failed to watch ' + dir + ': ' + e.message);
        }
        break;
      }

      case 'chat-unwatch': {
        const termId = msg.termId;
        if (!ws._chatWatchers) break;
        const w = ws._chatWatchers.get(termId);
        if (w) { try { w.close(); } catch {} ws._chatWatchers.delete(termId); }
        break;
      }
    }
  });

  ws.on('close', () => {
    // chat watchers cleanup
    if (ws._chatWatchers) {
      for (const w of ws._chatWatchers.values()) { try { w.close(); } catch {} }
      ws._chatWatchers.clear();
    }
    // terminals 는 유지
  });

  // On connect: restore from saved state if no active terminals (once only)
  // Set flag BEFORE restore to prevent race between concurrent WS connections
  let idMap = null;
  if (terminals.size === 0 && !_terminalsRestored) {
    _terminalsRestored = true;
    try {
      const result = restoreTerminals();
      if (result) idMap = result.idMap;
    } catch (err) {
      logger.error('state', 'Restore failed', err.message);
    }
  }

  // Send list of active terminals (+ idMap if restored)
  const active = [];
  for (const [id, t] of terminals) {
    active.push({ termId: id, projectId: t.projectId, buffer: bufRead(t) });
  }
  const msg = { type: 'terminals', active };
  if (idMap) msg.idMap = idMap;
  ws.send(JSON.stringify(msg));
});

// ──────────── Start ────────────

// Bind address: 0.0.0.0 (all interfaces) by default; set COCKPIT_BIND to a specific
// interface (e.g. the Tailscale 100.x IP) to drop physical-LAN exposure to a lever.
const BIND_ADDR = process.env.COCKPIT_BIND || '0.0.0.0';
server.listen(PORT, BIND_ADDR, () => {
  logger.info('server', `Claude Code Dashboard v${PKG_VERSION}`);
  logger.info('server', `http://localhost:${PORT} (bind ${BIND_ADDR})`);
  logger.info('server', `Shell: ${_defaultShell}, PID: ${process.pid}`);
  // Show network IPs — M6: mask token in console, show only last 4 chars
  const getNetworkIPs = routeCtx.getNetworkIPs;
  const netIPs = getNetworkIPs ? getNetworkIPs() : [];
  const masked = LAN_TOKEN.slice(0, 4) + '...' + LAN_TOKEN.slice(-4);
  for (const { ip, type } of netIPs) {
    ALLOWED_HOSTS.add(String(ip).toLowerCase());   // trust our own interfaces as Host
    const label = type === 'tailscale' ? 'Tailscale' : 'LAN';
    logger.info('server', `http://${ip}:${PORT} (${label})`);
  }
  if (netIPs.length) {
    logger.info('server', `Token: ${masked} (full token in ${TOKEN_FILE})`);
    logger.info('server', 'Use ?token=<TOKEN> or scan QR from localhost');
  }
  if (!process.argv.includes('--no-open')) {
    platformOpenUrl(`http://localhost:${PORT}`);
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('server', `Port ${PORT} is already in use. Kill the existing process or change PORT in lib/config.js`);
    process.exit(1);
  }
  throw err;
});
