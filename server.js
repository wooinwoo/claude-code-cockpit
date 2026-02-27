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
import { networkInterfaces } from 'node:os';
import { getProjects, PORT, POLL_INTERVALS, LIMITS, getProjectById, addProject, updateProject, deleteProject, getJiraConfig, saveJiraConfig, getAiConfig, saveAiConfig, DATA_DIR } from './lib/config.js';
import { detectSessionState, getProjectSessions, getRecentActivity, discoverProjects, readSessionMessages, getSessionTimeline } from './lib/claude-data.js';
import { getGitStatus, getBranches } from './lib/git-service.js';
import { getGitHubPRs } from './lib/github-service.js';
import { computeUsage, getStatsCache } from './lib/cost-service.js';
import { startSession, resumeSession } from './lib/session-control.js';
import { Poller } from './lib/poller.js';
import { showNotification } from './lib/notify.js';
import { generateQRSvg } from './lib/qr.js';
import { gitExec, spawnForProject, parseWslPath, toWinPath } from './lib/wsl-utils.js';
import { testConnection as jiraTestConnection, getMyIssues as jiraGetIssues, getSprints as jiraGetSprints, getAllActiveSprints as jiraGetAllSprints, getBoards as jiraGetBoards, getProjects as jiraGetProjects, getIssue as jiraGetIssue, transitionIssue as jiraTransitionIssue, addComment as jiraAddComment, clearCache as jiraClearCache, proxyImage as jiraProxyImage } from './lib/jira-service.js';
import { getWorkflowRuns, getRunDetail, getRunJobs, getRunLogs, rerunWorkflow, cancelRun, getWorkflows } from './lib/cicd-service.js';
import { listNotes, getNote, createNote, updateNote, deleteNote } from './lib/notes-service.js';
import { init as initWorkflows, listWorkflowDefs, getWorkflowDef, startRun as startWorkflowRun, stopRun as stopWorkflowRun, listRuns as listWorkflowRuns, getRunDetail as getWorkflowRunDetail } from './lib/workflows-service.js';
import { init as initScheduler, listSchedules, addSchedule, updateSchedule, removeSchedule } from './lib/workflow-scheduler.js';
import { init as initAgent, chat as agentChat, stopAgent, listConversations as agentListConvs, getConversation as agentGetConv, deleteConversation as agentDeleteConv, newConversation as agentNewConv, setModel as agentSetModel, getModel as agentGetModel } from './lib/agent-service.js';
import { checkAlerts, saveDailySnapshot, generateBriefing, getAlertPrefs, saveAlertPrefs } from './lib/briefing-service.js';
import { getAllStats as getMonitorStats } from './lib/monitor-service.js';
import { initBatch, getWhitelist, executeBatch, stopBatch, getBatchStatus } from './lib/batch-service.js';
import { initForge, startForge, stopForge, getForgeRun, listForgeRuns, getPresets as getForgePresets, applyForgeResult, getForgeHistory, getForgeHistoryDetail, forgeReview } from './lib/forge-service.js';

// node-pty and ws are CJS modules
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const __dirname = dirname(fileURLToPath(import.meta.url));
const poller = new Poller();

// Detect PowerShell 7+ (pwsh.exe) — supports && operator
import { execFileSync } from 'node:child_process';
let _winShell = 'powershell.exe';
if (process.platform === 'win32') {
  try { execFileSync('where', ['pwsh.exe'], { stdio: 'ignore', timeout: 3000 }); _winShell = 'pwsh.exe'; } catch { /* pwsh not found, using powershell.exe */ }
}

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

// ──────────── Routes ────────────

// m1: Server-side login endpoint (sets HttpOnly cookie)
addRoute('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const token = body.token;
  if (!token || token.length !== LAN_TOKEN.length) return json(res, { error: 'Invalid token' }, 401);
  try {
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(LAN_TOKEN))) {
      return json(res, { error: 'Invalid token' }, 401);
    }
  } catch { return json(res, { error: 'Invalid token' }, 401); }
  res.writeHead(200, {
    'Set-Cookie': authCookie(req),
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify({ success: true }));
});

// Upload clipboard image → temp file, return absolute path
const PASTE_DIR = join(tmpdir(), 'cockpit-paste');
// MAJOR-5: Image upload with size limit (10 MB)
addRoute('POST', '/api/upload-image', async (req, res) => {
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > LIMITS.imageUploadBytes) return json(res, { error: 'File too large (max 10 MB)' }, 413);
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) return json(res, { error: 'empty body' }, 400);
  await mkdir(PASTE_DIR, { recursive: true });
  const ext = (req.headers['content-type'] || '').includes('png') ? 'png' : 'jpg';
  const name = `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
  const filePath = join(PASTE_DIR, name);
  await writeFile(filePath, buf);
  json(res, { path: filePath });
});

// Auto-cleanup paste images older than 1 hour (runs every 30 min)
async function cleanupPasteImages() {
  try {
    const files = await readdir(PASTE_DIR);
    const now = Date.now();
    for (const f of files) {
      if (!f.startsWith('paste-')) continue;
      const fp = join(PASTE_DIR, f);
      const s = await stat(fp);
      if (now - s.mtimeMs > 60 * 60 * 1000) try { unlinkSync(fp); } catch {}
    }
  } catch {}
}
setInterval(cleanupPasteImages, 30 * 60 * 1000);
setTimeout(cleanupPasteImages, 5000);

// Health check (for PM2, uptime monitors, etc.)
addRoute('GET', '/api/health', (_req, res) => {
  json(res, {
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    projects: getProjects().length,
    terminals: terminals?.size ?? 0,
    sseClients: poller.sseClients.size
  });
});

// LAN connection info (localhost only — for desktop app UI)
function getNetworkIPs() {
  const result = [];
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family !== 'IPv4' || net.internal) continue;
        const oct1 = parseInt(net.address.split('.')[0]);
        const oct2 = parseInt(net.address.split('.')[1]);
        // Tailscale uses 100.64-127.x.x (CGNAT range)
        const type = (oct1 === 100 && oct2 >= 64 && oct2 <= 127) ? 'tailscale' : 'lan';
        result.push({ ip: net.address, type });
      }
    }
  } catch {}
  // Tailscale first (works remotely), then LAN
  result.sort((a, b) => (a.type === 'tailscale' ? -1 : 1) - (b.type === 'tailscale' ? -1 : 1));
  return result;
}

addRoute('GET', '/api/lan-info', (req, res) => {
  if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
  json(res, { token: LAN_TOKEN, ips: getNetworkIPs(), port: PORT });
});

addRoute('GET', '/api/qr-code', (req, res) => {
  if (!isLocalhost(req)) { res.writeHead(403); res.end(); return; }
  const data = req.query.data;
  if (!data) { res.writeHead(400); res.end('Missing data param'); return; }
  const svg = generateQRSvg(data);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  res.end(svg);
});

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

// SSE endpoint
addRoute('GET', '/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive'
  });

  // Send initial state
  const devList = [];
  for (const [pid, ds] of devServers) {
    devList.push({ projectId: pid, command: ds.command, startedAt: ds.startedAt, port: ds.port });
  }
  const init = {
    sessions: poller.getAllCached('session:'),
    git: poller.getAllCached('git:'),
    prs: poller.getAllCached('pr:'),
    costs: poller.getCached('cost:daily'),
    activity: poller.getCached('activity'),
    devServers: devList,
    nodeVersion: process.version
  };
  res.write(`event: init\ndata: ${JSON.stringify(init)}\n\n`);

  let sseClosed = false;
  const keepAlive = setInterval(() => {
    if (sseClosed) return;
    try { res.write(':ping\n\n'); } catch { sseClosed = true; clearInterval(keepAlive); }
  }, 15000);

  poller.addClient(res);

  req.on('close', () => {
    sseClosed = true;
    clearInterval(keepAlive);
    poller.removeClient(res);
  });
});

// Projects list
addRoute('GET', '/api/projects', (_req, res) => {
  const data = getProjects().map(p => ({
    ...p,
    session: poller.getCached(`session:${p.id}`),
    git: poller.getCached(`git:${p.id}`),
    prs: poller.getCached(`pr:${p.id}`)
  }));
  json(res, data);
});

// Project CRUD
addRoute('POST', '/api/projects', async (req, res) => {
  const body = await readBody(req);
  if (!body.name || !body.path) return json(res, { error: 'name and path required' }, 400);
  const project = addProject(body);
  registerProjectPollers(project);
  json(res, project, 201);
});

addRoute('PUT', '/api/projects/:id', async (req, res) => {
  const body = await readBody(req);
  const updated = updateProject(req.params.id, body);
  if (!updated) return json(res, { error: 'Not found' }, 404);
  json(res, updated);
});

addRoute('DELETE', '/api/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  poller.unregister(`session:${req.params.id}`);
  poller.unregister(`git:${req.params.id}`);
  poller.unregister(`pr:${req.params.id}`);
  json(res, { deleted: true });
});

// Adaptive polling speed (browser visibility)
addRoute('POST', '/api/polling-speed', async (req, res) => {
  const body = await readBody(req);
  const multiplier = parseFloat(body.multiplier) || 1;
  poller.setSpeed(multiplier);
  json(res, { speed: poller._speedMultiplier });
});

// Directory browser for path picker
// m3: Drive root listing only available from localhost (for project registration)
addRoute('GET', '/api/browse', async (_req, res) => {
  const url = new URL(_req.url, `http://localhost`);
  const dir = (url.searchParams.get('dir') || '').replace(/\\/g, '/');
  if (!dir) {
    // Only allow drive root listing from localhost (project setup)
    if (!isLocalhost(_req)) return json(res, { error: 'Directory browsing requires localhost' }, 403);
    const checks = await Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter => {
      try { await stat(`${letter}:/`); return { name: `${letter}:/`, path: `${letter}:/`, isDir: true }; } catch { return null; }
    }));
    return json(res, { parent: null, entries: checks.filter(Boolean) });
  }
  // Non-root browsing: only allow localhost or paths inside registered projects
  if (!isLocalhost(_req)) {
    const resolvedBrowse = resolve(normalize(dir)).replace(/\\/g, '/').toLowerCase();
    const allowed = getProjects().some(p => {
      const r = resolve(normalize(p.path)).replace(/\\/g, '/').toLowerCase();
      return resolvedBrowse.startsWith(r + '/') || resolvedBrowse === r;
    });
    if (!allowed) return json(res, { error: 'Access denied' }, 403);
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: `${dir.replace(/\/$/, '')}/${e.name}`, isDir: true }));
    const parent = dir.replace(/\/$/, '').split('/').slice(0, -1).join('/') || null;
    json(res, { current: dir, parent, entries: dirs });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
});

// Usage
addRoute('GET', '/api/usage', async (_req, res) => {
  const data = await computeUsage();
  json(res, data);
});

// Single project git
addRoute('GET', '/api/projects/:id/git', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  json(res, await getGitStatus(project));
});

// Single project PRs
addRoute('GET', '/api/projects/:id/prs', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  json(res, await getGitHubPRs(project));
});

// Single project sessions
addRoute('GET', '/api/projects/:id/sessions', (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  json(res, getProjectSessions(project));
});

// Session conversation messages
addRoute('GET', '/api/projects/:id/sessions/:sessionId/messages', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  // Validate sessionId format (UUID-like, no path traversal)
  if (!/^[a-f0-9-]+$/i.test(req.params.sessionId)) return json(res, { error: 'Invalid sessionId' }, 400);
  try { json(res, await readSessionMessages(project, req.params.sessionId)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

// Cost data
addRoute('GET', '/api/cost/daily', async (_req, res) => {
  const cached = poller.getCached('cost:daily');
  json(res, cached || await computeUsage());
});

// Stats cache
addRoute('GET', '/api/stats', (_req, res) => {
  json(res, getStatsCache() || {});
});

// Activity
addRoute('GET', '/api/activity', (_req, res) => {
  const cached = poller.getCached('activity');
  json(res, cached || getRecentActivity());
});

// File preview (read-only, for drag-drop file viewer)
addRoute('GET', '/api/file', async (req, res) => {
  const filePath = new URL(req.url, 'http://localhost').searchParams.get('path');
  if (!filePath) return json(res, { error: 'Missing path' }, 400);
  // Path traversal guard: resolve to absolute and check against registered projects
  if (!isInsideAnyProject(filePath)) return json(res, { error: 'Access denied: path outside project directories' }, 403);
  // m4: Use resolved path for actual I/O to prevent TOCTOU via symlinks
  try {
    const st = await stat(resolved);
    if (st.size > LIMITS.filePreviewBytes) return json(res, { error: 'File too large (>2MB)' }, 413);
    const content = await readFile(resolved, 'utf8');
    json(res, { path: filePath, name: filePath.replace(/\\/g, '/').split('/').pop(), size: st.size, content });
  } catch (e) { json(res, { error: e.message }, 404); }
});

// MINOR-6/7: Validate path against registered projects for open-in-ide / open-folder
const isInsideProject = isInsideAnyProject;

// Open a file in IDE
addRoute('POST', '/api/open-in-ide', async (req, res) => {
  const body = await readBody(req);
  let filePath = body.path;
  const ide = body.ide || 'code';
  const line = parseInt(body.line) || 0;
  const column = parseInt(body.column) || 0;
  if (!filePath) return json(res, { error: 'Missing path' }, 400);
  // Resolve relative paths against project root if projectId provided
  if (body.projectId && !/^[A-Za-z]:/.test(filePath) && !filePath.startsWith('/')) {
    const proj = getProjectById(body.projectId);
    if (proj) filePath = join(toWinPath(proj.path), filePath);
  }
  if (!isInsideProject(filePath)) return json(res, { error: 'Path outside project directories' }, 403);
  const known = ['code', 'cursor', 'windsurf', 'antigravity', 'zed'];
  if (!known.includes(ide)) return json(res, { error: 'Unknown IDE' }, 400);
  const winPath = toWinPath(filePath);
  const isWin = process.platform === 'win32';
  // Zed uses its own exe path and different CLI args
  if (ide === 'zed') {
    const zedBin = isWin ? join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed', 'bin', 'zed.exe') : 'zed';
    const args = line > 0 ? [`${winPath}:${line}`] : [winPath];
    spawn(zedBin, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  } else {
    // VS Code/Cursor support --goto file:line:column
    const args = [];
    if (line > 0) { args.push('--goto', `${winPath}:${line}${column > 0 ? ':' + column : ''}`); }
    else { args.push(winPath); }
    // M1: .cmd needs shell on Windows — IDE name is from known[] whitelist so safe
    const ideBin = isWin ? `${ide}.cmd` : ide;
    spawn(ideBin, args, { detached: true, stdio: 'ignore', shell: isWin, windowsHide: true }).unref();
  }
  json(res, { opened: true });
});

// Open URL in default browser
addRoute('POST', '/api/open-url', async (req, res) => {
  const body = await readBody(req);
  const url = body.url;
  if (!url || typeof url !== 'string') return json(res, { error: 'Missing url' }, 400);
  if (!/^https?:\/\//i.test(url)) return json(res, { error: 'Only http/https URLs allowed' }, 400);
  const browser = body.browser || 'default';
  const isWin = process.platform === 'win32';
  if (browser === 'firefox-dev') {
    const ffBin = isWin ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Firefox Developer Edition', 'firefox.exe') : 'firefox-developer-edition';
    spawn(ffBin, [url], { detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  } else {
    const cmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = isWin ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  json(res, { opened: true });
});

// Open containing folder in Explorer
addRoute('POST', '/api/open-folder', async (req, res) => {
  const body = await readBody(req);
  if (!body.path) return json(res, { error: 'Missing path' }, 400);
  if (!isInsideProject(body.path)) return json(res, { error: 'Path outside project directories' }, 403);
  spawn('explorer', ['/select,', toWinPath(body.path)], { detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  json(res, { opened: true });
});

// Notification toggle (syncs client toggle to server-side notifications)
addRoute('POST', '/api/notify/toggle', async (req, res) => {
  const body = await readBody(req);
  _notifyEnabled = body.enabled !== false;
  json(res, { enabled: _notifyEnabled });
});

// Session control
addRoute('POST', '/api/sessions/:id/start', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  json(res, startSession(project, body));
});

addRoute('POST', '/api/sessions/:id/resume', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  json(res, resumeSession(project, body.sessionId));
});

// Git diff viewer
addRoute('GET', '/api/projects/:id/diff', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const opts = { timeout: 10000, maxBuffer: 5 * 1024 * 1024 };
  // Parse files + stats directly from diff output (avoids extra git commands)
  const parseDiffFiles = (diffText) => {
    if (!diffText || !diffText.trim()) return [];
    const files = [];
    const chunks = diffText.split(/(?=^diff --git )/m);
    for (const chunk of chunks) {
      if (!chunk.startsWith('diff ')) continue;
      const m = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
      if (!m) continue;
      const file = m[1];
      let status = 'M';
      if (/^new file mode/m.test(chunk)) status = 'A';
      else if (/^deleted file mode/m.test(chunk)) status = 'D';
      else if (/^rename from/m.test(chunk)) status = 'R';
      let additions = 0, deletions = 0;
      for (const line of chunk.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
      files.push({ file, status, additions, deletions });
    }
    return files;
  };
  try {
    const maxLines = 3000;
    const [stagedDiff, unstagedDiff, statusOut] = await Promise.all([
      gitExec(project.path, ['diff', '--cached', '-U3'], opts),
      gitExec(project.path, ['diff', '-U3'], opts),
      gitExec(project.path, ['status', '--porcelain'], opts),
    ]);
    const stagedFiles = parseDiffFiles(stagedDiff.stdout);
    const unstagedFiles = parseDiffFiles(unstagedDiff.stdout);
    // Untracked files (git diff doesn't include them — detect via status)
    const trackedInDiff = new Set([...stagedFiles, ...unstagedFiles].map(f => f.file));
    const statusLines = (statusOut.stdout || '').split('\n').filter(Boolean);
    for (const line of statusLines) {
      const code = line.substring(0, 2);
      const filePath = line.substring(3);
      if (!filePath || trackedInDiff.has(filePath)) continue;
      if (code === '??') {
        // Untracked → show as new file in unstaged
        unstagedFiles.push({ file: filePath, status: '?', additions: 0, deletions: 0 });
      } else if (code.trim() && !trackedInDiff.has(filePath)) {
        // Other statuses missing from diff (e.g. binary, permissions-only)
        const st = code[0] !== ' ' && code[0] !== '?' ? code[0] : code[1];
        unstagedFiles.push({ file: filePath, status: st || 'M', additions: 0, deletions: 0 });
      }
    }
    const truncate = (text) => {
      const lines = text.split('\n');
      if (lines.length <= maxLines) return text;
      return lines.slice(0, maxLines).join('\n') + '\n\n... truncated (' + lines.length + ' total lines) ...';
    };
    json(res, {
      projectId: project.id,
      staged: { diff: truncate(stagedDiff.stdout), files: stagedFiles },
      unstaged: { diff: truncate(unstagedDiff.stdout), files: unstagedFiles }
    });
  } catch {
    json(res, { projectId: project.id, staged: { diff: '', files: [] }, unstaged: { diff: '', files: [] } });
  }
});

// ──────────── Auto Commit (Haiku AI) ────────────

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

addRoute('POST', '/api/projects/:id/generate-commit-msg', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const opts = { timeout: 10000, maxBuffer: 5 * 1024 * 1024 };
  try {
    const result = await withGitLock(project.id, async () => {
      const [statusOut, diffOut] = await Promise.all([
        gitExec(project.path, ['diff', '--cached', '--stat'], opts),
        gitExec(project.path, ['diff', '--cached', '-U2'], opts),
      ]);
      return { stat: statusOut.stdout.trim(), diff: diffOut.stdout };
    });
    if (!result.stat) return json(res, { error: 'No staged changes' }, 400);
    const diff = result.diff.length > LIMITS.diffMaxChars ? result.diff.slice(0, LIMITS.diffMaxChars) + '\n...(truncated)' : result.diff;
    const commitMsgSystem = `You are a precise git commit message generator. Output ONLY the commit message — no quotes, no markdown fences, no explanation.
Rules:
- Conventional commits: feat:, fix:, refactor:, docs:, style:, chore:, test:
- First line: type(scope): description (max 72 chars)
- Scope = primary module or directory affected
- Describe WHY the change was made, not WHAT changed (the diff shows what)
- If multiple unrelated changes are staged, use the dominant change type
- For complex changes, add a blank line then bullet points for details`;
    const commitMsgUser = `[STAGED_CHANGES]\nStat:\n${result.stat}\n\nDiff:\n${diff}\n[/STAGED_CHANGES]`;
    const message = await callClaude(commitMsgUser, { systemPrompt: commitMsgSystem });
    const clean = message.replace(/^["'`]+|["'`]+$/g, '').replace(/^```\n?|```$/g, '').trim();
    json(res, { message: clean });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

addRoute('POST', '/api/projects/:id/auto-commit/plan', async (req, res) => {
  if (!rateLimit('autocommit', 5)) return json(res, { error: 'Too many requests — please wait' }, 429);
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);

  const opts = { timeout: 15000, maxBuffer: 5 * 1024 * 1024 };

  try {
    const gitResult = await withGitLock(project.id, async () => {
      const [statusOut, stagedDiffOut, unstagedDiffOut] = await Promise.all([
        gitExec(project.path, ['status', '--porcelain'], opts),
        gitExec(project.path, ['diff', '--cached', '-U2'], opts),
        gitExec(project.path, ['diff', '-U2'], opts),
      ]);
      return { status: statusOut.stdout.trim(), stagedDiff: stagedDiffOut.stdout, unstagedDiff: unstagedDiffOut.stdout };
    });

    const status = gitResult.status;
    if (!status) return json(res, { commits: [], message: 'No changes to commit' });

    const allDiff = (gitResult.stagedDiff + '\n' + gitResult.unstagedDiff).trim();
    const diffTruncated = allDiff.length > LIMITS.autoCommitDiffChars;
    const truncatedDiff = diffTruncated ? allDiff.slice(0, LIMITS.autoCommitDiffChars) + '\n...(truncated)' : allDiff;

    // Use model from request body if provided (default haiku)
    const body = await readBody(req).catch(() => ({}));
    const model = body.model || 'haiku';

    const planSystem = `You are a git commit planner. Analyze changed files and group them into logical, atomic commits. Output ONLY valid JSON, no markdown fences.

Rules:
- Group related changes: same feature, same bug fix, same refactor
- Conventional commits: feat: (new feature), fix: (bug fix), refactor: (restructure), docs:, style: (formatting), chore: (deps/config/build), test:
- Concise but descriptive messages in English
- Include ALL files from git status (use file paths from status, not diff headers)
- File paths from status are in column 4+ (after the 2-char status and a space)
- For renamed files (R status), use the new path
- Order: dependencies/config first, then core logic, then UI, then tests
- Prefer fewer commits (2-5) with clear logical grouping over many tiny commits
- If unsure about a file's purpose, group it with nearby directory siblings

Output schema: {"commits":[{"message":"type(scope): description","files":["file1","file2"],"reasoning":"why grouped"}]}

Example:
{"commits":[
  {"message":"feat(auth): add user authentication middleware","files":["src/middleware/auth.ts","src/types/auth.ts"],"reasoning":"All related to the new auth feature"},
  {"message":"chore(deps): update dependencies and config","files":["package.json","package-lock.json"],"reasoning":"Dependency updates"}
]}`;

    const planUser = `${diffTruncated ? 'NOTE: Diff was truncated. Rely on git status for the full file list. Group unknown files by directory/purpose.\n\n' : ''}[GIT_STATUS]\n${status}\n[/GIT_STATUS]\n\n[DIFF]\n${truncatedDiff}\n[/DIFF]`;

    const text = await callClaude(planUser, { model, systemPrompt: planSystem });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return json(res, { error: 'Failed to parse AI response', raw: text }, 500);

    let plan;
    try { plan = JSON.parse(jsonMatch[0]); } catch (parseErr) {
      return json(res, { error: 'Failed to parse commit plan JSON', raw: jsonMatch[0].slice(0, 500) }, 500);
    }
    if (diffTruncated) plan.truncated = true;
    json(res, plan);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

addRoute('POST', '/api/projects/:id/auto-commit/execute', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);

  const body = await readBody(req);
  const { message, files } = body;
  if (!message || !files?.length) return json(res, { error: 'message and files required' }, 400);

  const opts = { timeout: 10000, maxBuffer: 1024 * 1024 };

  try {
    const result = await withGitLock(project.id, async () => {
      await gitExec(project.path, ['reset', 'HEAD'], opts).catch(() => {});
      await gitExec(project.path, ['add', '--', ...files], opts);
      await gitExec(project.path, ['commit', '-m', message], opts);
      const newStatus = await gitExec(project.path, ['status', '--porcelain'], opts).catch(() => ({ stdout: '' }));
      return newStatus.stdout.trim().split('\n').filter(Boolean).length;
    });
    json(res, { success: true, message, files, remaining: result });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

// ──────────── Git Stage / Unstage / Discard / Commit ────────────

addRoute('POST', '/api/projects/:id/git/stage', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const files = body.files; // array of file paths, or ['--all']
  if (!files?.length) return json(res, { error: 'files required' }, 400);
  const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
  try {
    await withGitLock(project.id, () =>
      files[0] === '--all'
        ? gitExec(project.path, ['add', '-A'], gopts)
        : gitExec(project.path, ['add', '--', ...files], gopts)
    );
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/unstage', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const files = body.files;
  if (!files?.length) return json(res, { error: 'files required' }, 400);
  const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
  try {
    await withGitLock(project.id, () =>
      files[0] === '--all'
        ? gitExec(project.path, ['reset', 'HEAD'], gopts)
        : gitExec(project.path, ['reset', 'HEAD', '--', ...files], gopts)
    );
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/discard', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const files = body.files;
  if (!files?.length) return json(res, { error: 'files required' }, 400);
  const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
  try {
    await withGitLock(project.id, async () => {
      // Restore tracked files
      await gitExec(project.path, ['checkout', '--', ...files], gopts).catch(() => {});
      // Clean untracked files (batched in single call)
      await gitExec(project.path, ['clean', '-f', '--', ...files], gopts).catch(() => {});
    });
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/commit', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const message = body.message;
  if (!message) return json(res, { error: 'message required' }, 400);
  try {
    await withGitLock(project.id, () =>
      gitExec(project.path, ['commit', '-m', message], { timeout: 10000 })
    );
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/checkout', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const branch = body.branch;
  if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
  const gopts = { timeout: 15000, maxBuffer: 1024 * 1024 };
  try {
    await withGitLock(project.id, async () => {
      try { await gitExec(project.path, ['switch', branch], gopts); }
      catch { await gitExec(project.path, ['checkout', branch], gopts); }
    });
    json(res, { success: true, branch });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/push', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);

  try {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['push'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

// ──────────── Git Pull / Fetch / Stash / Branch ────────────

addRoute('POST', '/api/projects/:id/pull', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  try {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['pull'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/fetch', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  try {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['fetch', '--all', '--prune'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/stash', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
  try {
    await withGitLock(project.id, async () => {
      const args = ['stash', 'push', '-m', body.message || `Cockpit stash ${new Date().toLocaleString()}`];
      if (body.includeUntracked) args.push('-u');
      await gitExec(project.path, args, gopts);
    });
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/stash-pop', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  if (body.ref && !isValidStashRef(body.ref)) return json(res, { error: 'Invalid stash ref' }, 400);
  try {
    await withGitLock(project.id, () => {
      const args = ['stash', 'pop'];
      if (body.ref) args.push(body.ref);
      return gitExec(project.path, args, { timeout: 10000 });
    });
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/stash-apply', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const ref = body.ref || 'stash@{0}';
  if (!isValidStashRef(ref)) return json(res, { error: 'Invalid stash ref' }, 400);
  try {
    await withGitLock(project.id, () =>
      gitExec(project.path, ['stash', 'apply', ref], { timeout: 10000 })
    );
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/stash-drop', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const ref = body.ref || 'stash@{0}';
  if (!isValidStashRef(ref)) return json(res, { error: 'Invalid stash ref' }, 400);
  try {
    await withGitLock(project.id, () =>
      gitExec(project.path, ['stash', 'drop', ref], { timeout: 10000 })
    );
    json(res, { success: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/projects/:id/stash-list', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  try {
    const { stdout } = await gitExec(project.path, ['stash', 'list', '--format=%gd|%s|%cr'], { timeout: 5000 });
    const stashes = stdout.trim() ? stdout.trim().split('\n').map(line => {
      const [ref, msg, ago] = line.split('|');
      return { ref, message: msg || '', ago: ago || '' };
    }) : [];
    json(res, { projectId: project.id, stashes });
  } catch { json(res, { projectId: project.id, stashes: [] }); }
});

addRoute('POST', '/api/projects/:id/git/create-branch', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const branch = body.branch;
  if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
  try {
    await withGitLock(project.id, () =>
      gitExec(project.path, ['checkout', '-b', branch], { timeout: 10000 })
    );
    json(res, { success: true, branch });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/projects/:id/git/delete-branch', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const branch = body.branch;
  if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
  if (['main', 'master'].includes(branch)) return json(res, { error: 'Cannot delete main/master' }, 400);
  try {
    await withGitLock(project.id, () =>
      gitExec(project.path, ['branch', '-D', branch], { timeout: 10000 })
    );
    json(res, { success: true, branch });
  } catch (err) { json(res, { error: err.message }, 500); }
});

// Git log (commit history)
addRoute('GET', '/api/projects/:id/git/log', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const limit = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '30'), 100);
  try {
    const { stdout } = await gitExec(project.path, [
      'log', `--max-count=${limit}`,
      '--format=%H|%h|%an|%ae|%ar|%s'
    ], { timeout: 10000, maxBuffer: 1024 * 512 });
    const commits = stdout.trim() ? stdout.trim().split('\n').map(line => {
      const [hash, short, author, email, ago, ...msgParts] = line.split('|');
      return { hash, short, author, email, ago, message: msgParts.join('|') };
    }) : [];
    json(res, { projectId: project.id, commits });
  } catch { json(res, { projectId: project.id, commits: [] }); }
});

// Settings export
addRoute('GET', '/api/settings/export', (_req, res) => {
  json(res, { projects: getProjects() });
});

// Settings import
addRoute('POST', '/api/settings/import', async (req, res) => {
  try {
    const body = await readBody(req);
    const imported = body.projects || [];
    let added = 0;
    const existingPaths = new Set(getProjects().map(p => p.path.replace(/\\/g, '/').toLowerCase()));
    for (const p of imported) {
      if (!p.name || !p.path) continue;
      const normalPath = p.path.replace(/\\/g, '/');
      if (existingPaths.has(normalPath.toLowerCase())) continue;
      const project = addProject({ name: p.name, path: normalPath, stack: p.stack, devCmd: p.devCmd, github: p.github, color: p.color });
      registerProjectPollers(project);
      existingPaths.add(normalPath.toLowerCase());
      added++;
    }
    json(res, { success: true, imported: added });
  } catch (err) { json(res, { error: err.message }, 500); }
});

// Discover Claude projects
addRoute('GET', '/api/discover-projects', (_req, res) => {
  const existingPaths = getProjects().map(p => p.path.replace(/\\/g, '/'));
  json(res, discoverProjects(existingPaths));
});

// Bulk add discovered projects
addRoute('POST', '/api/discover-projects/add', async (req, res) => {
  const body = await readBody(req);
  const paths = body.projects; // array of { path, name }
  if (!paths?.length) return json(res, { error: 'projects required' }, 400);
  let added = 0;
  const existingPaths = new Set(getProjects().map(p => p.path.replace(/\\/g, '/').toLowerCase()));
  for (const p of paths) {
    if (!p.path || !p.name) continue;
    const normalPath = p.path.replace(/\\/g, '/');
    if (existingPaths.has(normalPath.toLowerCase())) continue;
    const project = addProject({ name: p.name, path: normalPath });
    registerProjectPollers(project);
    existingPaths.add(normalPath.toLowerCase());
    added++;
  }
  json(res, { success: true, added });
});

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

// ──────────── IDE Launcher ────────────

addRoute('POST', '/api/projects/:id/open-ide', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  const ide = body.ide || 'code';

  const known = ['code', 'cursor', 'windsurf', 'antigravity', 'zed'];
  if (!known.includes(ide)) return json(res, { error: 'Unknown IDE' }, 400);

  const idePath = toWinPath(project.path);
  const isWin = process.platform === 'win32';
  if (ide === 'zed') {
    const zedBin = isWin ? join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed', 'bin', 'zed.exe') : 'zed';
    spawn(zedBin, [idePath], { detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  } else {
    // VS Code etc. handle \\wsl$\ UNC paths natively — M1: .cmd needs shell, IDE from whitelist
    const ideBin = isWin ? `${ide}.cmd` : ide;
    spawn(ideBin, [idePath], { detached: true, stdio: 'ignore', shell: isWin, windowsHide: true }).unref();
  }
  json(res, { opened: true, ide, projectId: project.id });
});

// Branches + worktrees for terminal creation
addRoute('GET', '/api/projects/:id/branches', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const branches = await getBranches(project);
  const gitData = poller.getCached(`git:${project.id}`);
  json(res, { ...branches, worktrees: gitData?.worktrees || [] });
});

// ──────────── Package.json Scripts ────────────
addRoute('GET', '/api/scripts-by-path', async (req, res) => {
  const projectPath = req.query?.path;
  if (!projectPath) return json(res, { error: 'path required' }, 400);
  // Security: only allow paths inside registered project directories
  const resolvedPath = resolve(normalize(projectPath)).replace(/\\/g, '/').toLowerCase();
  const pathAllowed = getProjects().some(p => {
    const projRoot = resolve(normalize(p.path)).replace(/\\/g, '/').toLowerCase();
    return resolvedPath.startsWith(projRoot + '/') || resolvedPath === projRoot;
  });
  if (!pathAllowed) return json(res, { scripts: {} });
  const pkgPath = join(toWinPath(projectPath), 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    json(res, { scripts: pkg.scripts || {} });
  } catch {
    json(res, { scripts: {} });
  }
});

// ──────────── Dev Server Management ────────────
const devServers = new Map(); // projectId → { process, command, startedAt, port }

function broadcastDevStatus() {
  const list = [];
  for (const [pid, ds] of devServers) {
    list.push({ projectId: pid, command: ds.command, startedAt: ds.startedAt, port: ds.port });
  }
  poller.broadcast('dev:status', { running: list });
}

addRoute('GET', '/api/dev-servers', (req, res) => {
  const list = [];
  for (const [pid, ds] of devServers) {
    const p = getProjectById(pid);
    list.push({ projectId: pid, name: p?.name || pid, command: ds.command, startedAt: ds.startedAt, port: ds.port });
  }
  json(res, { running: list });
});

addRoute('POST', '/api/projects/:id/dev-server/start', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (devServers.has(project.id)) return json(res, { error: 'Already running' }, 409);
  const cmd = project.devCmd;
  if (!cmd) return json(res, { error: 'No devCmd configured' }, 400);
  const child = spawnForProject(project.path, cmd, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.unref();
  const ds = { process: child, command: cmd, startedAt: Date.now(), port: null };
  devServers.set(project.id, ds);
  // Scan stdout/stderr for port numbers (e.g. "localhost:3000", ":5173", "port 8080")
  const portRe = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b|(?:port\s*[=:]?\s*)(\d{4,5})\b|https?:\/\/[^:/\s]+:(\d{4,5})\b/i;
  const scanPort = (data) => {
    if (ds.port) return;
    const m = data.toString().match(portRe);
    if (m) {
      const port = parseInt(m[1] || m[2] || m[3], 10);
      if (port >= 1024 && port <= 65535) { ds.port = port; broadcastDevStatus(); }
    }
  };
  if (child.stdout) child.stdout.on('data', scanPort);
  if (child.stderr) child.stderr.on('data', scanPort);
  child.on('exit', () => { devServers.delete(project.id); broadcastDevStatus(); });
  broadcastDevStatus();
  json(res, { started: true, projectId: project.id });
});

addRoute('POST', '/api/projects/:id/dev-server/stop', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const ds = devServers.get(project.id);
  if (!ds) return json(res, { error: 'Not running' }, 404);
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(ds.process.pid), '/T', '/F'], { timeout: 5000 }, () => {});
    } else {
      process.kill(-ds.process.pid, 'SIGTERM');
    }
  } catch {}
  devServers.delete(project.id);
  broadcastDevStatus();
  json(res, { stopped: true, projectId: project.id });
});

// ──────────── AI Config ────────────

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
  const { setApiKey } = await import('./lib/agent-service.js');
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

// ──────────── Jira ────────────

addRoute('GET', '/api/jira/config', (_req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { configured: false });
  json(res, { configured: true, url: config.url, email: config.email,
    token: config.token ? '****' + config.token.slice(-4) : '',
    defaultProject: config.defaultProject || '', boardId: config.boardId || null });
});

addRoute('POST', '/api/jira/config', async (req, res) => {
  const body = await readBody(req);
  if (!body.url || !body.email || !body.token) return json(res, { error: 'url, email, token required' }, 400);
  // M9: Validate Jira URL — must be HTTPS, no private IPs/localhost
  let jiraUrl;
  try { jiraUrl = new URL(body.url); } catch { return json(res, { error: 'Invalid URL format' }, 400); }
  if (jiraUrl.protocol !== 'https:') return json(res, { error: 'Only HTTPS Jira URLs allowed' }, 400);
  const jHost = jiraUrl.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(jHost) ||
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(jHost)) {
    return json(res, { error: 'Private/internal URLs not allowed' }, 400);
  }
  saveJiraConfig({ url: body.url.replace(/\/+$/, ''), email: body.email, token: body.token,
    defaultProject: body.defaultProject || '', boardId: body.boardId || null });
  jiraClearCache();
  json(res, { success: true });
});

addRoute('POST', '/api/jira/test', async (req, res) => {
  const body = await readBody(req);
  try {
    const user = await jiraTestConnection(body);
    json(res, { success: true, user });
  } catch (err) { json(res, { error: err.message }, 400); }
});

// Helper: Jira error response — 401/403 auth errors get authError flag
function jiraErrorResponse(res, err) {
  if (err.authError) return json(res, { error: err.message, authError: true }, 401);
  json(res, { error: err.message }, 500);
}

addRoute('GET', '/api/jira/projects', async (_req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  try { json(res, { projects: await jiraGetProjects(config) }); }
  catch (err) { jiraErrorResponse(res, err); }
});

addRoute('GET', '/api/jira/issues', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const opts = {};
  if (url.searchParams.get('project')) opts.project = url.searchParams.get('project');
  if (url.searchParams.get('sprint')) opts.sprint = url.searchParams.get('sprint');
  if (url.searchParams.get('status')) opts.status = url.searchParams.get('status');
  try { json(res, { issues: await jiraGetIssues(config, opts) }); }
  catch (err) { jiraErrorResponse(res, err); }
});

addRoute('GET', '/api/jira/sprints', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const boardId = url.searchParams.get('boardId');
  // MINOR-4: Validate boardId format
  if (boardId && !/^\d+$/.test(boardId)) return json(res, { error: 'Invalid board ID' }, 400);
  try {
    const sprints = boardId
      ? await jiraGetSprints(config, boardId)
      : await jiraGetAllSprints(config);
    json(res, { sprints });
  } catch (err) { jiraErrorResponse(res, err); }
});

addRoute('GET', '/api/jira/boards', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const project = url.searchParams.get('project') || config.defaultProject || '';
  try { json(res, { boards: await jiraGetBoards(config, project) }); }
  catch (err) { jiraErrorResponse(res, err); }
});

// MINOR-3: Validate Jira issue key format
function isValidIssueKey(key) { return /^[A-Z][A-Z0-9]+-\d+$/i.test(key); }

addRoute('GET', '/api/jira/issues/:key', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  if (!isValidIssueKey(req.params.key)) return json(res, { error: 'Invalid issue key' }, 400);
  try { json(res, { issue: await jiraGetIssue(config, req.params.key) }); }
  catch (err) { jiraErrorResponse(res, err); }
});

addRoute('POST', '/api/jira/issues/:key/transition', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  if (!isValidIssueKey(req.params.key)) return json(res, { error: 'Invalid issue key' }, 400);
  const body = await readBody(req);
  try { await jiraTransitionIssue(config, req.params.key, body.transitionId); json(res, { success: true }); }
  catch (err) { jiraErrorResponse(res, err); }
});

addRoute('POST', '/api/jira/issues/:key/comment', async (req, res) => {
  const config = getJiraConfig();
  if (!config) return json(res, { error: 'Not configured' }, 400);
  if (!isValidIssueKey(req.params.key)) return json(res, { error: 'Invalid issue key' }, 400);
  const body = await readBody(req);
  try { await jiraAddComment(config, req.params.key, body.comment); json(res, { success: true }); }
  catch (err) { jiraErrorResponse(res, err); }
});

// ──────────── Jira Image Proxy ────────────

addRoute('GET', '/api/jira/image-proxy', async (req, res) => {
  const config = getJiraConfig();
  if (!config) { res.writeHead(400); res.end('Not configured'); return; }
  const imageUrl = req.query.url;
  if (!imageUrl) { res.writeHead(400); res.end('Missing url param'); return; }
  try {
    const { data, contentType } = await jiraProxyImage(config, imageUrl);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' });
    res.end(data);
  } catch (err) {
    res.writeHead(502); res.end(err.message);
  }
});

// ──────────── CI/CD Routes ────────────

addRoute('GET', '/api/cicd/runs/:projectId', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  try {
    const runs = await getWorkflowRuns(project.path, { workflow: req.query.workflow, status: req.query.status, limit: parseInt(req.query.limit) || 30 });
    json(res, runs);
  } catch (err) { json(res, { error: err.message }, 500); }
});

// MINOR-5: Validate CI/CD runId (must be numeric)
addRoute('GET', '/api/cicd/runs/:projectId/:runId', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
  try { json(res, await getRunDetail(project.path, req.params.runId)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/cicd/runs/:projectId/:runId/jobs', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
  try { json(res, await getRunJobs(project.path, req.params.runId)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/cicd/runs/:projectId/:runId/logs', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
  try {
    const logs = await getRunLogs(project.path, req.params.runId);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(logs);
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/cicd/runs/:projectId/:runId/rerun', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
  const body = await readBody(req);
  try { json(res, await rerunWorkflow(project.path, req.params.runId, { failed: body.failed })); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/cicd/runs/:projectId/:runId/cancel', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^\d+$/.test(req.params.runId)) return json(res, { error: 'Invalid run ID' }, 400);
  try { json(res, await cancelRun(project.path, req.params.runId)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/cicd/workflows/:projectId', async (req, res) => {
  const project = getProjectById(req.params.projectId);
  if (!project) return json(res, { error: 'Not found' }, 404);
  try { json(res, await getWorkflows(project.path)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

// ──────────── Notes Routes ────────────

addRoute('GET', '/api/notes', async (_req, res) => {
  try { json(res, await listNotes()); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/notes/:id', async (req, res) => {
  const note = await getNote(req.params.id);
  if (!note) return json(res, { error: 'Not found' }, 404);
  json(res, note);
});

addRoute('POST', '/api/notes', async (req, res) => {
  const body = await readBody(req);
  try { json(res, await createNote(body), 201); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('PUT', '/api/notes/:id', async (req, res) => {
  const body = await readBody(req);
  const note = await updateNote(req.params.id, body);
  if (!note) return json(res, { error: 'Not found' }, 404);
  json(res, note);
});

addRoute('DELETE', '/api/notes/:id', async (req, res) => {
  const ok = await deleteNote(req.params.id);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  json(res, { deleted: true });
});

// ──────────── Workflows Routes ────────────

addRoute('GET', '/api/workflows', async (_req, res) => {
  try { json(res, await listWorkflowDefs()); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/workflows/runs', (_req, res) => {
  json(res, listWorkflowRuns());
});

addRoute('POST', '/api/workflows/run', async (req, res) => {
  const body = await readBody(req);
  if (!body.workflowId) return json(res, { error: 'workflowId required' }, 400);
  try { json(res, await startWorkflowRun(body.workflowId, body.inputs || {}), 202); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/workflows/runs/:id', (req, res) => {
  const run = getWorkflowRunDetail(req.params.id);
  if (!run) return json(res, { error: 'Not found' }, 404);
  json(res, run);
});

addRoute('POST', '/api/workflows/runs/:id/stop', (req, res) => {
  json(res, stopWorkflowRun(req.params.id));
});

// ──────────── Workflow Schedules (BEFORE :id to avoid shadowing) ────────────

addRoute('GET', '/api/workflows/schedules', (_req, res) => {
  json(res, listSchedules());
});

addRoute('POST', '/api/workflows/schedules', async (req, res) => {
  const body = await readBody(req);
  if (!body.workflowId) return json(res, { error: 'workflowId required' }, 400);
  try { json(res, addSchedule(body), 201); }
  catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('PUT', '/api/workflows/schedules/:id', async (req, res) => {
  const body = await readBody(req);
  const result = updateSchedule(req.params.id, body);
  if (!result) return json(res, { error: 'Not found' }, 404);
  json(res, result);
});

addRoute('DELETE', '/api/workflows/schedules/:id', (req, res) => {
  const ok = removeSchedule(req.params.id);
  if (!ok) return json(res, { error: 'Not found' }, 404);
  json(res, { deleted: true });
});

addRoute('GET', '/api/workflows/:id', async (req, res) => {
  const def = await getWorkflowDef(req.params.id);
  if (!def) return json(res, { error: 'Not found' }, 404);
  json(res, def);
});

// ──────────── Agent Routes ────────────

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
let _MsEdgeTTS = null;

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

// ──────────── Phase 1: Session Timeline ────────────

addRoute('GET', '/api/projects/:id/sessions/:sessionId/timeline', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  if (!/^[a-f0-9-]+$/i.test(req.params.sessionId)) return json(res, { error: 'Invalid sessionId' }, 400);
  try { json(res, await getSessionTimeline(project, req.params.sessionId)); }
  catch (err) { json(res, { error: err.message }, 500); }
});

// ──────────── Phase 2-3: Briefing & Alerts ────────────

addRoute('GET', '/api/briefing', (_req, res) => {
  const projectStates = {};
  for (const p of getProjects()) {
    projectStates[p.id] = {
      session: poller.getCached('session:' + p.id),
      git: poller.getCached('git:' + p.id),
      prs: poller.getCached('prs:' + p.id),
      cicd: poller.getCached('cicd:' + p.id),
    };
  }
  const costData = poller.getCached('cost:daily');
  json(res, generateBriefing(projectStates, costData));
});

addRoute('GET', '/api/alerts', (_req, res) => {
  const projectStates = {};
  for (const p of getProjects()) {
    projectStates[p.id] = {
      session: poller.getCached('session:' + p.id),
      git: poller.getCached('git:' + p.id),
      cicd: poller.getCached('cicd:' + p.id),
    };
  }
  const costData = poller.getCached('cost:daily');
  json(res, checkAlerts(projectStates, costData));
});

addRoute('GET', '/api/alerts/prefs', (_req, res) => { json(res, getAlertPrefs()); });
addRoute('POST', '/api/alerts/prefs', async (req, res) => {
  const body = await readBody(req);
  saveAlertPrefs(body);
  json(res, { ok: true });
});

// ──────────── Phase 5: Batch Commands ────────────

addRoute('GET', '/api/batch/whitelist', (_req, res) => { json(res, getWhitelist()); });

addRoute('GET', '/api/batch/status', (_req, res) => { json(res, getBatchStatus()); });

addRoute('POST', '/api/batch/execute', async (req, res) => {
  const body = await readBody(req);
  if (!body.commandId || !Array.isArray(body.projectIds)) return json(res, { error: 'commandId and projectIds required' }, 400);
  const projects = body.projectIds.map(id => {
    const p = getProjectById(id);
    return p ? { id: p.id, name: p.name, path: p.path } : null;
  }).filter(Boolean);
  if (projects.length === 0) return json(res, { error: 'No valid projects' }, 400);
  try {
    const result = await executeBatch(body.commandId, projects, { parallel: body.parallel, maxConcurrent: body.maxConcurrent });
    json(res, result);
  } catch (err) { json(res, { error: err.message }, 400); }
});

addRoute('POST', '/api/batch/stop', (_req, res) => { json(res, { stopped: stopBatch() }); });

// ──────────── Forge: Autonomous Development Engine ────────────

addRoute('GET', '/api/forge/presets', (_req, res) => { json(res, getForgePresets()); });

addRoute('GET', '/api/forge/runs', (_req, res) => { json(res, listForgeRuns()); });

addRoute('GET', '/api/forge/runs/:taskId', (req, res) => {
  const run = getForgeRun(req.params.taskId);
  if (!run) return json(res, { error: 'Not found' }, 404);
  json(res, run);
});

addRoute('POST', '/api/forge/start', async (req, res) => {
  const body = await readBody(req);
  if (!body.projectId || !body.task) return json(res, { error: 'projectId and task required' }, 400);
  const project = getProjectById(body.projectId);
  if (!project) return json(res, { error: 'Project not found' }, 404);

  // Load reference files
  const referenceFiles = [];
  if (Array.isArray(body.referenceFiles)) {
    for (const rf of body.referenceFiles.slice(0, 10)) {
      try {
        const fullPath = join(toWinPath(project.path), rf);
        const content = readFileSync(fullPath, 'utf8');
        referenceFiles.push({ path: rf, content: content.slice(0, 10000) });
      } catch {}
    }
  }

  try {
    const result = await startForge({
      projectId: project.id, projectPath: project.path,
      task: body.task, referenceFiles,
      mode: body.mode, modelPreset: body.modelPreset,
      costLimit: body.costLimit,
    });
    json(res, result);
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('POST', '/api/forge/stop/:taskId', (req, res) => {
  json(res, { stopped: stopForge(req.params.taskId) });
});

addRoute('POST', '/api/forge/apply/:taskId', async (req, res) => {
  const project = getProjects().find(p => {
    const run = getForgeRun(req.params.taskId);
    return run && run.projectId === p.id;
  });
  if (!project) return json(res, { error: 'Project not found' }, 404);
  try {
    const result = await applyForgeResult(req.params.taskId, project.path);
    json(res, result);
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('GET', '/api/forge/history/:projectId', (req, res) => {
  json(res, getForgeHistory(req.params.projectId));
});

addRoute('GET', '/api/forge/history/:projectId/:taskId', (req, res) => {
  const detail = getForgeHistoryDetail(req.params.projectId, req.params.taskId);
  if (!detail) return json(res, { error: 'Not found' }, 404);
  json(res, detail);
});

addRoute('POST', '/api/forge/review', async (req, res) => {
  const body = await readBody(req);
  if (!body.projectId || !body.diff) return json(res, { error: 'projectId and diff required' }, 400);
  const project = getProjectById(body.projectId);
  if (!project) return json(res, { error: 'Project not found' }, 404);
  try {
    const result = await forgeReview({ projectId: project.id, projectPath: project.path, diff: body.diff, files: body.files || [] });
    json(res, result);
  } catch (err) { json(res, { error: err.message }, 500); }
});

// ──────────── File Write API (for Forge) ────────────

// C5 fix: Normalize both paths to lowercase forward slashes for Windows-safe comparison
function isInsideRoot(fullPath, rootPath) {
  const normFull = normalize(fullPath).toLowerCase().replace(/\\/g, '/');
  const normRoot = normalize(rootPath).toLowerCase().replace(/\\/g, '/');
  return normFull.startsWith(normRoot + '/') || normFull === normRoot;
}

function isFileProtected(filePath) {
  if ([/\.pem$/i, /\.key$/i, /\.p12$/i].some(p => p.test(filePath))) return true;
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some(s =>
    s === '.env' || s.startsWith('.env.') ||
    s === '.git' || s === '.ssh' || s === '.aws' || s === 'node_modules' ||
    /^credentials\.[a-z]+$/i.test(s) || /secret/i.test(s)
  );
}

addRoute('POST', '/api/projects/:id/files/write', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  if (!body.path || typeof body.content !== 'string') return json(res, { error: 'path and content required' }, 400);

  const root = toWinPath(project.path);
  const fullPath = resolve(root, body.path);
  if (!isInsideRoot(fullPath, root)) return json(res, { error: 'Path outside project root' }, 403);
  if (isFileProtected(body.path)) return json(res, { error: 'Protected file' }, 403);
  if (Buffer.byteLength(body.content, 'utf8') > LIMITS.fileWriteBytes) return json(res, { error: 'File too large (500KB max)' }, 400);

  try {
    const dir = join(fullPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, body.content, 'utf8');
    json(res, { ok: true, path: body.path });
  } catch (err) { json(res, { error: err.message }, 500); }
});

addRoute('DELETE', '/api/projects/:id/files', async (req, res) => {
  const project = getProjectById(req.params.id);
  if (!project) return json(res, { error: 'Not found' }, 404);
  const body = await readBody(req);
  if (!body.path) return json(res, { error: 'path required' }, 400);

  const root = toWinPath(project.path);
  const fullPath = resolve(root, body.path);
  if (!isInsideRoot(fullPath, root)) return json(res, { error: 'Path outside project root' }, 403);

  try {
    unlinkSync(fullPath);
    json(res, { ok: true });
  } catch (err) { json(res, { error: err.message }, 500); }
});

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
        // M6: Return 400 for JSON parse errors, 500 for others
        const status = err.message?.startsWith('Invalid JSON') ? 400 : 500;
        json(res, { error: status === 400 ? err.message : 'Internal error' }, status);
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
      shell = process.platform === 'win32' ? _winShell : 'bash';
      shellArgs = [];
      cwd = toWinPath(project.path);
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
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(ds.process.pid), '/T', '/F'], { timeout: 3000 }, () => {});
      } else {
        process.kill(-ds.process.pid, 'SIGTERM');
      }
    } catch {}
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
          shell = process.platform === 'win32' ? _winShell : 'bash';
          shellArgs = [];
          cwd = toWinPath(termPath);
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
  if (process.platform === 'win32') console.log(`  Shell: ${_winShell}`);
  // Show network IPs — M6: mask token in console, show only last 4 chars
  const netIPs = getNetworkIPs();
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
    spawn('cmd', ['/c', 'start', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process or change PORT in lib/config.js\n`);
    process.exit(1);
  }
  throw err;
});
