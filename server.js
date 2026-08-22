import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesRuntime } from './lib/hermes-runtime.js';
import { DirectorService } from './lib/director-service.js';
import { DATA_DIR, MAX_PROJECTS, PORT, PROJECTS_ROOT, addProject, deleteProject, getProjects } from './lib/praetorium-config.js';
import { LOCAL_BIND_ADDRESS, isIgnoredBindRequest, isLoopbackAddress, isLoopbackHost } from './lib/local-only.js';
import { register as registerDirectors } from './routes/directors.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const MAX_BODY_BYTES = 1024 * 1024;
const routes = [];

function addRoute(method, pattern, handler) {
  const parameterNames = [];
  const expression = pattern.replace(/:(\w+)/g, (_match, name) => {
    parameterNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, regex: new RegExp(`^${expression}$`), parameterNames, handler });
}

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    const params = {};
    route.parameterNames.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    return { handler: route.handler, params };
  }
  return null;
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function json(res, value, statusCode = 200) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, { ...securityHeaders('application/json; charset=utf-8'), 'Content-Length': body.length });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}

function sameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const source = req.headers.origin || req.headers.referer;
  if (!source) return isLoopbackAddress(req.socket.remoteAddress);
  try { return new URL(source).host === req.headers.host; }
  catch { return false; }
}

const directorState = join(DATA_DIR, 'directors.json');

const directorService = new DirectorService({
  runtime: new HermesRuntime(),
  stateFile: directorState,
  projectsRoot: PROJECTS_ROOT,
  getProjects,
});
directorService.on('error', error => console.error('[Praetorium:Director]', error.message));
directorService.startScheduler(10000);

registerDirectors({ addRoute, json, readBody, directorService });

addRoute('GET', '/api/health', (_req, res) => json(res, {
  status: 'ok',
  version: VERSION,
  localOnly: true,
  uptime: Math.round(process.uptime()),
  projects: getProjects().length,
  directors: directorService.listDirectors().length,
}));

addRoute('GET', '/api/projects', (_req, res) => json(res, getProjects()));

addRoute('POST', '/api/projects', async (req, res) => {
  try {
    const project = addProject(await readBody(req));
    directorService.syncProjects();
    json(res, project, 201);
  } catch (error) { json(res, { error: error.message }, 400); }
});

addRoute('DELETE', '/api/projects/:id', (req, res) => {
  if (!deleteProject(req.params.id)) return json(res, { error: 'Project not found' }, 404);
  directorService.syncProjects();
  json(res, { deleted: true });
});

addRoute('POST', '/api/projects/discover', async (_req, res) => {
  try {
    const configured = getProjects();
    const known = new Set(configured.map(project => project.path.toLowerCase()));
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
    let added = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (configured.length + added >= MAX_PROJECTS) break;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = resolve(PROJECTS_ROOT, entry.name);
      if (known.has(candidate.toLowerCase())) continue;
      try {
        await stat(join(candidate, '.git'));
        addProject({ name: entry.name, path: candidate });
        known.add(candidate.toLowerCase());
        added += 1;
      } catch { /* not an immediate Git repository */ }
    }
    directorService.syncProjects();
    json(res, { added, projects: getProjects() });
  } catch (error) { json(res, { error: error.message }, 400); }
});

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/css/owner-console.css', ['css/owner-console.css', 'text/css; charset=utf-8']],
  ['/js/owner-console.js', ['js/owner-console.js', 'text/javascript; charset=utf-8']],
]);

async function serveStatic(pathname, res, method) {
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
  const target = staticFiles.get(pathname);
  if (!target) return false;
  const filePath = resolve(ROOT, normalize(target[0]));
  if (!filePath.startsWith(`${ROOT}${process.platform === 'win32' ? '\\' : '/'}`)) return false;
  const body = await readFile(filePath);
  res.writeHead(200, { ...securityHeaders(target[1]), 'Content-Length': body.length });
  if (method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return json(res, { error: 'Praetorium accepts loopback requests only.' }, 403);
    }
    if (!sameOrigin(req)) return json(res, { error: 'Origin rejected.' }, 403);

    const url = new URL(req.url, `http://${req.headers.host}`);
    if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(url.pathname, res, req.method)) return;
    const route = findRoute(req.method, url.pathname);
    if (!route) return json(res, { error: 'Not found' }, 404);
    req.params = route.params;
    req.query = Object.fromEntries(url.searchParams);
    await route.handler(req, res);
  } catch (error) {
    console.error('[Praetorium:HTTP]', error);
    if (!res.headersSent) json(res, { error: error.message || 'Internal server error' }, 500);
    else res.end();
  }
});

if (isIgnoredBindRequest(process.env.PRAETORIUM_BIND)) {
  console.warn('[Praetorium] Ignored non-loopback bind override.');
}

server.listen(PORT, LOCAL_BIND_ADDRESS, () => {
  console.log(`[Praetorium] v${VERSION} listening on http://${LOCAL_BIND_ADDRESS}:${PORT}`);
  console.log('[Praetorium] Remote access, gateways, webhooks, messaging, and shell terminals are disabled.');
});

function shutdown() {
  directorService.stopScheduler();
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export { server };
