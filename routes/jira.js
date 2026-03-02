import { testConnection as jiraTestConnection, getMyIssues as jiraGetIssues, getSprints as jiraGetSprints, getAllActiveSprints as jiraGetAllSprints, getBoards as jiraGetBoards, getProjects as jiraGetProjects, getIssue as jiraGetIssue, transitionIssue as jiraTransitionIssue, addComment as jiraAddComment, clearCache as jiraClearCache, proxyImage as jiraProxyImage } from '../lib/jira-service.js';

export function register(ctx) {
  const { addRoute, json, readBody, getJiraConfig, saveJiraConfig, PORT } = ctx;

  // Helper: Jira error response — 401/403 auth errors get authError flag
  function jiraErrorResponse(res, err) {
    if (err.authError) return json(res, { error: err.message, authError: true }, 401);
    json(res, { error: err.message }, 500);
  }

  // MINOR-3: Validate Jira issue key format
  function isValidIssueKey(key) { return /^[A-Z][A-Z0-9]+-\d+$/i.test(key); }

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
}
