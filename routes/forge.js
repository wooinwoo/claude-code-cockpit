import { startForge, stopForge, getForgeRun, listForgeRuns, getPresets as getForgePresets, applyForgeResult, getForgeHistory, getForgeHistoryDetail, forgeReview } from '../lib/forge-service.js';

export function register(ctx) {
  const { addRoute, json, withProject, readBody, getProjectById, getProjects, toWinPath, readFileSync, writeFile, mkdir, join, normalize, resolve, unlinkSync, LIMITS } = ctx;

  // inline helpers
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

  // ──────────── Forge Routes ────────────

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

  addRoute('POST', '/api/projects/:id/files/write', withProject(async (req, res, project) => {
    const body = await readBody(req);
    if (!body.path || typeof body.content !== 'string') return json(res, { error: 'path and content required' }, 400);

    const root = toWinPath(project.path);
    const fullPath = resolve(root, body.path);
    if (!isInsideRoot(fullPath, root)) return json(res, { error: 'Path outside project root' }, 403);
    if (isFileProtected(body.path)) return json(res, { error: 'Protected file' }, 403);
    if (Buffer.byteLength(body.content, 'utf8') > LIMITS.fileWriteBytes) return json(res, { error: 'File too large (500KB max)' }, 400);

    const dir = join(fullPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, body.content, 'utf8');
    json(res, { ok: true, path: body.path });
  }));

  addRoute('DELETE', '/api/projects/:id/files', withProject(async (req, res, project) => {
    const body = await readBody(req);
    if (!body.path) return json(res, { error: 'path required' }, 400);

    const root = toWinPath(project.path);
    const fullPath = resolve(root, body.path);
    if (!isInsideRoot(fullPath, root)) return json(res, { error: 'Path outside project root' }, 403);

    unlinkSync(fullPath);
    json(res, { ok: true });
  }));
}
