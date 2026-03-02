import { computeUsage, getStatsCache } from '../lib/cost-service.js';
import { getRecentActivity, discoverProjects } from '../lib/claude-data.js';
import { showNotification } from '../lib/notify.js';
import { generateQRSvg } from '../lib/qr.js';
import { getAllStats as getMonitorStats } from '../lib/monitor-service.js';
import { checkAlerts, generateBriefing, getAlertPrefs, saveAlertPrefs } from '../lib/briefing-service.js';
import { getWhitelist, executeBatch, stopBatch, getBatchStatus } from '../lib/batch-service.js';

export function register(ctx) {
  const { addRoute, json, readBody, getProjects, getProjectById, addProject, poller, LAN_TOKEN, isInsideAnyProject, isLocalhost, authCookie, toWinPath, PORT, LIMITS, join, resolve, normalize, readFile, readdir, stat, writeFile, mkdir, existsSync, spawn, tmpdir, randomBytes, timingSafeEqual } = ctx;

  // ──────────── Inline helpers ────────────

  // Paste image temp directory
  const PASTE_DIR = join(tmpdir(), 'cockpit-paste');

  // Auto-cleanup paste images older than 1 hour (runs every 30 min)
  async function cleanupPasteImages() {
    try {
      const { unlinkSync } = await import('node:fs');
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

  // Alias for path validation
  const isInsideProject = isInsideAnyProject;

  // Mutable notification toggle state
  let _notifyEnabled = true;
  ctx.getNotifyEnabled = () => _notifyEnabled;

  // ──────────── Auth ────────────

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

  // ──────────── Upload ────────────

  // Upload clipboard image → temp file, return absolute path
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

  // ──────────── Health ────────────

  // Health check (for PM2, uptime monitors, etc.)
  addRoute('GET', '/api/health', (_req, res) => {
    json(res, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      projects: getProjects().length,
      terminals: ctx.terminals?.size ?? 0,
      sseClients: poller.sseClients.size
    });
  });

  // ──────────── LAN info & QR code ────────────

  addRoute('GET', '/api/lan-info', (req, res) => {
    if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
    json(res, { token: LAN_TOKEN, ips: ctx.getNetworkIPs(), port: PORT });
  });

  addRoute('GET', '/api/qr-code', (req, res) => {
    if (!isLocalhost(req)) { res.writeHead(403); res.end(); return; }
    const data = req.query.data;
    if (!data) { res.writeHead(400); res.end('Missing data param'); return; }
    const svg = generateQRSvg(data);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
  });

  // ──────────── Cost / Stats / Activity ────────────

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

  // ──────────── File access ────────────

  // File preview (read-only, for drag-drop file viewer)
  addRoute('GET', '/api/file', async (req, res) => {
    const filePath = new URL(req.url, 'http://localhost').searchParams.get('path');
    if (!filePath) return json(res, { error: 'Missing path' }, 400);
    // Path traversal guard: resolve to absolute and check against registered projects
    if (!isInsideAnyProject(filePath)) return json(res, { error: 'Access denied: path outside project directories' }, 403);
    // m4: Use resolved path for actual I/O to prevent TOCTOU via symlinks
    const resolved = resolve(normalize(filePath));
    try {
      const st = await stat(resolved);
      if (st.size > LIMITS.filePreviewBytes) return json(res, { error: 'File too large (>2MB)' }, 413);
      const content = await readFile(resolved, 'utf8');
      json(res, { path: filePath, name: filePath.replace(/\\/g, '/').split('/').pop(), size: st.size, content });
    } catch (e) { json(res, { error: e.message }, 404); }
  });

  // ──────────── IDE / URL / Folder openers ────────────

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

  // ──────────── Notifications toggle ────────────

  addRoute('POST', '/api/notify/toggle', async (req, res) => {
    const body = await readBody(req);
    _notifyEnabled = body.enabled !== false;
    json(res, { enabled: _notifyEnabled });
  });

  // ──────────── Settings export/import ────────────

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
        ctx.registerProjectPollers(project);
        existingPaths.add(normalPath.toLowerCase());
        added++;
      }
      json(res, { success: true, imported: added });
    } catch (err) { json(res, { error: err.message }, 500); }
  });

  // ──────────── Discover projects ────────────

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
      ctx.registerProjectPollers(project);
      existingPaths.add(normalPath.toLowerCase());
      added++;
    }
    json(res, { success: true, added });
  });

  // ──────────── Briefing & Alerts ────────────

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

  // ──────────── Batch Commands ────────────

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

  // ──────────── Monitor ────────────

  addRoute('GET', '/api/monitor/stats', (_req, res) => {
    json(res, getMonitorStats());
  });
}
