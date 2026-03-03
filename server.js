import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, unlinkSync, watch, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
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
import { init as initAgent } from './lib/agent-service.js';
import { checkAlerts, saveDailySnapshot, generateBriefing } from './lib/briefing-service.js';
import { getAllStats as getMonitorStats } from './lib/monitor-service.js';
import { initBatch } from './lib/batch-service.js';
import { initForge } from './lib/forge-service.js';
import { listNotes, getNote } from './lib/notes-service.js';

// Route modules
import { register as regNotes } from './routes/notes.js';
import { register as regCicd } from './routes/cicd.js';
import { register as regPR } from './routes/pr.js';
import { register as regWorkflows } from './routes/workflows.js';
import { register as regSessions } from './routes/sessions.js';
import { register as regJira } from './routes/jira.js';
import { register as regAgent } from './routes/agent.js';
import { register as regForge } from './routes/forge.js';
import { register as regGit } from './routes/git.js';
import { register as regProjects } from './routes/projects.js';
import { register as regSystem } from './routes/system.js';
import { register as regPorts } from './routes/ports.js';
import { register as regApiTester } from './routes/api-tester.js';

// node-pty and ws are CJS modules
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const __dirname = dirname(fileURLToPath(import.meta.url));
const poller = new Poller();

// Detect default shell (cross-platform)
const _defaultShell = getShell();

// Prevent server crash from unhandled promise rejections (e.g., msedge-tts WebSocket errors)
process.on('unhandledRejection', (reason) => {
  console.warn('[UnhandledRejection]', reason?.message || reason);
});

// State file lives in %LOCALAPPDATA%/cockpit (survives reinstall)
const STATE_FILE = join(DATA_DIR, 'session-state.json');

// ──────────── Perf helpers ────────────
const execFileAsync = promisify(execFile);
// Cache index.html in memory (reload on file change in dev)
let _cachedHTML = null;
async function getCachedHTML() {
  if (!_cachedHTML) _cachedHTML = await readFile(join(__dirname, 'index.html'), 'utf8');
  return _cachedHTML;
}
// Invalidate cache when file changes (dev convenience)
try { watch(join(__dirname, 'index.html'), () => { _cachedHTML = null; }); } catch {}

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
  } catch {}
  const token = randomBytes(16).toString('hex');
  try { writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); } catch {}
  return token;
}
const LAN_TOKEN = loadOrCreateToken();

function isLocalhost(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
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
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
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
    try { return new URL(origin).host === host; } catch { return false; }
  }
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
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

// Serve static assets (style.css, app.js, js/*.js modules)
const STATIC_TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.map': 'application/json' };
for (const file of ['style.css', 'app.js']) {
  const ext = file.slice(file.lastIndexOf('.'));
  addRoute('GET', `/${file}`, async (_req, res) => {
    try {
      const content = await readFile(join(__dirname, file), 'utf8');
      res.writeHead(200, { 'Content-Type': `${STATIC_TYPES[ext]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
// Serve PWA files
addRoute('GET', '/manifest.json', async (_req, res) => {
  try {
    const content = await readFile(join(__dirname, 'manifest.json'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
addRoute('GET', '/sw.js', async (_req, res) => {
  try {
    const content = await readFile(join(__dirname, 'sw.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
// Serve JS modules from js/ directory
addRoute('GET', '/js/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.js') || filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(join(__dirname, 'js', filename), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});

// Serve CSS module files
addRoute('GET', '/css/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.css') || filename.includes('..') || /[^a-zA-Z0-9._-]/.test(filename)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(join(__dirname, 'css', filename), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
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
  } catch { res.writeHead(404); res.end('Not found'); }
});

// ──────────── Dev Server State ────────────
const devServers = new Map(); // projectId → { process, command, startedAt, port }

// ──────────── callClaude (used by init: workflows, forge) ────────────

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
      try { child.kill('SIGKILL'); } catch {}
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

// ─── Route Context & Registration ───
const routeCtx = {
  addRoute, json, withProject, readBody, rateLimit,
  getProjects, getProjectById, addProject, updateProject, deleteProject,
  getJiraConfig, saveJiraConfig, getAiConfig, saveAiConfig,
  withGitLock, gitExec, toWinPath, parseWslPath, spawnForProject,
  isInsideAnyProject, isValidBranch, isValidStashRef, isLocalhost, authCookie,
  PORT, LIMITS, DATA_DIR, __dirname,
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
regNotes(routeCtx);
regCicd(routeCtx);
regPR(routeCtx);
regWorkflows(routeCtx);
regSessions(routeCtx);
regJira(routeCtx);
regAgent(routeCtx);
regForge(routeCtx);
regGit(routeCtx);
regPorts(routeCtx);
regApiTester(routeCtx);

// ──────────── Polling ────────────

const _prevSessionStates = new Map();
let _notifyEnabled = true;

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
try { initWorkflows(poller, callClaude); } catch (err) { console.error('[Workflows] Init failed:', err.message); }
try { initScheduler(poller, startWorkflowRun); } catch (err) { console.error('[Scheduler] Init failed:', err.message); }

// Initialize Agent engine
try {
  initAgent(poller, null,
    () => getProjects().map(p => p.path),
    () => getProjects().map(p => ({ name: p.name, path: p.path, stack: p.stack })),
    {
      getJiraConfig,
      geminiApiKey: getAiConfig()?.geminiApiKey || null,
      cockpit: {
        computeUsage,
        getProjects,
        getProjectById,
        listNotes,
        getNote,
        getAllStats: getMonitorStats,
        generateBriefing,
        checkAlerts,
        getRecentActivity,
        listWorkflowDefs,
        getWorkflowDef,
        listWorkflowRuns,
        getWorkflowRunDetail,
        poller,
      },
    }
  );
} catch (err) { console.error('[Agent] Init failed:', err.message); }

// ──────────── Init new services ────────────

initBatch(poller);
try { initForge(poller, callClaude, (path) => getProjects().find(p => p.path === path)); }
catch (err) { console.error('[Forge] Init failed:', err.message); }

// Morning briefing: save daily snapshot on startup
try {
  const projectStates = {};
  for (const p of getProjects()) {
    projectStates[p.id] = { session: null, git: null, prs: null };
  }
  saveDailySnapshot(projectStates, null);
} catch {}

// ──────────── Server ────────────

const server = createServer(async (req, res) => {
  // m10: Security headers on all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data: blob:; worker-src 'self'");

  const url = new URL(req.url, `http://localhost:${PORT}`);

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
      if (!err.message?.startsWith('Invalid JSON')) console.error('[Server]', err);
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
    if (!isAuthenticated(req)) return false;
    // INFO-4: Verify Origin header to prevent cross-site WebSocket hijacking
    const origin = req.headers['origin'];
    if (origin) {
      try {
        const o = new URL(origin);
        const host = req.headers['host'] || '';
        if (o.host !== host) return false;
      } catch { return false; }
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
  entry._bufArr.push(data);
  entry._bufLen += data.length;
  while (entry._bufLen > MAX_BUFFER && entry._bufArr.length > 1) {
    entry._bufLen -= entry._bufArr.shift().length;
  }
}
function bufRead(entry) { return entry._bufArr.join(''); }

// ── Session State Persistence (tmux-resurrect style) ──

let _saveQueued = false;
function saveTerminalState() {
  if (_saveQueued) return; // debounce
  _saveQueued = true;
  queueMicrotask(async () => {
    _saveQueued = false;
    const st = [];
    for (const [id, t] of terminals) {
      st.push({ termId: id, projectId: t.projectId, command: t.command || '' });
    }
    if (st.length === 0 && !existsSync(STATE_FILE)) return;
    try {
      await writeFile(STATE_FILE, JSON.stringify({ terminals: st, timestamp: Date.now() }));
      if (st.length > 0) console.log(`[State] Saved ${st.length} terminal(s)`);
    } catch (err) {
      console.error('[State] Save error:', err.message);
    }
  });
}

function loadTerminalState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // Only restore if less than 24 hours old
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      try { unlinkSync(STATE_FILE); } catch {}
      return null;
    }
    return data;
  } catch { return null; }
}

function restoreTerminals() {
  const saved = loadTerminalState();
  if (!saved?.terminals?.length) return null;

  const idMap = {};
  const restored = [];

  for (const entry of saved.terminals) {
    const project = getProjectById(entry.projectId);
    if (!project) continue;

    const newTermId = `${entry.projectId}-${randomBytes(6).toString('hex')}`;
    const wsl = parseWslPath(project.path);
    let shell, shellArgs, cwd;
    if (wsl) {
      shell = 'wsl.exe';
      shellArgs = ['-d', wsl.distro, '--cd', wsl.linuxPath];
      cwd = process.env.SYSTEMROOT || 'C:\\Windows';
    } else {
      shell = _defaultShell;
      shellArgs = [];
      cwd = IS_WIN ? toWinPath(project.path) : project.path;
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
        try { client.send(msg); } catch {}
      }
    });

    term.onExit(({ exitCode }) => {
      terminals.delete(newTermId);
      const msg = JSON.stringify({ type: 'exit', termId: newTermId, exitCode });
      for (const client of wss.clients) {
        try { client.send(msg); } catch {}
      }
    });

    terminals.set(newTermId, { pty: term, projectId: entry.projectId, _bufArr: [], _bufLen: 0, command: entry.command || '' });
    idMap[entry.termId] = newTermId;
    restored.push({ termId: newTermId, projectId: entry.projectId });

    // Re-run the command that was running — m6: strict command validation
    if (entry.command && typeof entry.command === 'string' && entry.command.length < 500
        && /^(claude|npm|npx|node|git|python|pip|docker|yarn|pnpm|bun|cargo|make|cmake|go|rustc|ruby|java|javac|mvn|gradle|dotnet|terraform|kubectl|helm|ansible|packer|deno|tsx|ts-node|jest|vitest|pytest|eslint|prettier|tsc)\b/.test(entry.command)
        && !/[&|<>^;`$(){}]/.test(entry.command)
        && !/\s+-[cCeE]\s/.test(entry.command)) { // Block -c/-e (arbitrary code exec)
      setTimeout(() => term.write(entry.command + '\r'), 500);
    }
  }

  // Clean up state file after successful restore
  try { unlinkSync(STATE_FILE); } catch {}

  console.log(`[State] Restored ${restored.length} terminal(s) from saved state`);
  return { idMap, restored };
}

// Auto-save terminal state every 30 seconds
setInterval(saveTerminalState, 30000);

// Save on shutdown
function onShutdown() {
  saveTerminalState();
  for (const [, t] of terminals) { try { t.pty.kill(); } catch {} }
  // Kill dev server processes
  for (const [, ds] of devServers) {
    try { killProcessTree(ds.process.pid); } catch {}
  }
  devServers.clear();
}
process.on('SIGINT', () => { onShutdown(); process.exit(0); });
process.on('SIGTERM', () => { onShutdown(); process.exit(0); });

let _terminalsRestored = false;
wss.on('connection', (ws) => {
  let currentTermId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        // Create a new PTY terminal for a project
        const project = getProjectById(msg.projectId);
        if (!project) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown project' })); return; }

        // C5: Validate cwd against project path — must be inside project or omitted
        let termPath = project.path;
        if (msg.cwd && typeof msg.cwd === 'string') {
          const resolvedCwd = resolve(normalize(toWinPath(msg.cwd))).replace(/\\/g, '/').toLowerCase();
          const projResolved = resolve(normalize(toWinPath(project.path))).replace(/\\/g, '/').toLowerCase();
          if (resolvedCwd.startsWith(projResolved + '/') || resolvedCwd === projResolved) {
            termPath = msg.cwd;
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'cwd must be inside project directory' }));
            return;
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
            try { client.send(msg); } catch {}
          }
        });

        term.onExit(({ exitCode }) => {
          terminals.delete(termId);
          const msg = JSON.stringify({ type: 'exit', termId, exitCode });
          for (const client of wss.clients) {
            try { client.send(msg); } catch {}
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
        currentTermId = termId;

        const createdMsg = JSON.stringify({ type: 'created', termId, projectId: msg.projectId });
        for (const client of wss.clients) {
          try { client.send(createdMsg); } catch {}
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
    }
  });

  ws.on('close', () => {
    // Don't kill terminals on disconnect — they persist
    // User can reconnect and resume
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
      console.error('[State] Restore failed:', err.message);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Claude Code Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Shell: ${_defaultShell}`);
  // Show network IPs — M6: mask token in console, show only last 4 chars
  const getNetworkIPs = routeCtx.getNetworkIPs;
  const netIPs = getNetworkIPs ? getNetworkIPs() : [];
  const masked = LAN_TOKEN.slice(0, 4) + '...' + LAN_TOKEN.slice(-4);
  for (const { ip, type } of netIPs) {
    const label = type === 'tailscale' ? 'Tailscale' : 'LAN';
    console.log(`  http://${ip}:${PORT} (${label})`);
  }
  if (netIPs.length) {
    console.log(`\n  Token: ${masked} (full token in ${TOKEN_FILE})`);
    console.log(`  Use ?token=<TOKEN> or scan QR from localhost`);
  }
  console.log('');
  if (!process.argv.includes('--no-open')) {
    platformOpenUrl(`http://localhost:${PORT}`);
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process or change PORT in lib/config.js\n`);
    process.exit(1);
  }
  throw err;
});
