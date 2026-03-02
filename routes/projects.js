import { networkInterfaces } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, normalize, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { computeUsage } from '../lib/cost-service.js';
import { getBranches } from '../lib/git-service.js';

export function register(ctx) {
  const { addRoute, json, withProject, readBody, isLocalhost, getProjects, getProjectById, addProject, updateProject, deleteProject, poller, devServers, toWinPath, spawnForProject } = ctx;

  // --- Inline helpers ---

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

  function broadcastDevStatus() {
    const list = [];
    for (const [pid, ds] of devServers) {
      list.push({ projectId: pid, command: ds.command, startedAt: ds.startedAt, port: ds.port });
    }
    poller.broadcast('dev:status', { running: list });
  }

  // --- SSE Events ---

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

  // --- Projects CRUD ---

  addRoute('GET', '/api/projects', (_req, res) => {
    const data = getProjects().map(p => ({
      ...p,
      session: poller.getCached(`session:${p.id}`),
      git: poller.getCached(`git:${p.id}`),
      prs: poller.getCached(`pr:${p.id}`)
    }));
    json(res, data);
  });

  addRoute('POST', '/api/projects', async (req, res) => {
    const body = await readBody(req);
    if (!body.name || !body.path) return json(res, { error: 'name and path required' }, 400);
    const project = addProject(body);
    ctx.registerProjectPollers(project);
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

  // --- Polling speed ---

  addRoute('POST', '/api/polling-speed', async (req, res) => {
    const body = await readBody(req);
    const multiplier = parseFloat(body.multiplier) || 1;
    poller.setSpeed(multiplier);
    json(res, { speed: poller._speedMultiplier });
  });

  // --- Directory browser for path picker ---
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

  // --- Usage ---

  addRoute('GET', '/api/usage', async (_req, res) => {
    const data = await computeUsage();
    json(res, data);
  });

  // --- IDE launcher ---

  addRoute('POST', '/api/projects/:id/open-ide', withProject(async (req, res, project) => {
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
  }));

  // --- Branches + worktrees ---

  addRoute('GET', '/api/projects/:id/branches', withProject(async (req, res, project) => {
    const branches = await getBranches(project);
    const gitData = poller.getCached(`git:${project.id}`);
    json(res, { ...branches, worktrees: gitData?.worktrees || [] });
  }));

  // --- Package scripts lookup ---

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

  // --- Dev servers ---

  addRoute('GET', '/api/dev-servers', (req, res) => {
    const list = [];
    for (const [pid, ds] of devServers) {
      const p = getProjectById(pid);
      list.push({ projectId: pid, name: p?.name || pid, command: ds.command, startedAt: ds.startedAt, port: ds.port });
    }
    json(res, { running: list });
  });

  addRoute('POST', '/api/projects/:id/dev-server/start', withProject(async (req, res, project) => {
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
  }));

  addRoute('POST', '/api/projects/:id/dev-server/stop', withProject(async (req, res, project) => {
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
  }));

  // Export getNetworkIPs for other modules that may need it
  return { getNetworkIPs };
}
