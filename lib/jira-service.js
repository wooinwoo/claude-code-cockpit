import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// ─── Cache ───
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cached(key, fn) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return Promise.resolve(entry.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

export function clearCache() { _cache.clear(); }

// ─── Auth Error ───
class JiraAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'JiraAuthError'; this.authError = true; }
}

// ─── HTTP helper ───
function makeRequest(config, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.url);
    const isHttps = url.protocol === 'https:';
    const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          let msg = `Jira API ${res.statusCode}`;
          try { const e = JSON.parse(raw); msg = e.errorMessages?.[0] || e.message || msg; } catch {}
          if (res.statusCode === 401 || res.statusCode === 403) {
            _cache.clear(); // 인증 실패 시 캐시 제거 — stale 데이터 방지
            return reject(new JiraAuthError(res.statusCode === 401
              ? 'Jira API 토큰이 만료되었거나 유효하지 않습니다'
              : 'Jira 접근 권한이 없습니다'));
          }
          return reject(new Error(msg));
        }
        if (!raw || res.statusCode === 204) return resolve(null);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Jira request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Simplify issue object ───
function simplifyIssue(raw) {
  const f = raw.fields || {};
  return {
    key: raw.key,
    id: raw.id,
    summary: f.summary || '',
    status: f.status ? { name: f.status.name, category: f.status.statusCategory?.key || 'undefined' } : null,
    priority: f.priority ? { name: f.priority.name, iconUrl: f.priority.iconUrl } : null,
    assignee: f.assignee ? { displayName: f.assignee.displayName, avatarUrl: f.assignee.avatarUrls?.['24x24'] } : null,
    reporter: f.reporter ? { displayName: f.reporter.displayName } : null,
    dueDate: f.duedate || null,
    created: f.created || null,
    updated: f.updated || null,
    storyPoints: f.story_points ?? f.customfield_10016 ?? null,
    type: f.issuetype ? { name: f.issuetype.name, iconUrl: f.issuetype.iconUrl, subtask: f.issuetype.subtask || false } : null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
    sprint: f.sprint ? { name: f.sprint.name, state: f.sprint.state, id: f.sprint.id } : null,
    labels: f.labels || [],
    description: f.description || null,
    renderedDescription: raw.renderedFields?.description || null,
    transitions: raw.transitions || [],
    comments: f.comment?.comments?.map(c => ({
      id: c.id,
      author: c.author?.displayName || 'Unknown',
      body: c.renderedBody || c.body,
      created: c.created,
    })) || [],
  };
}

// ─── Exported API functions ───

export async function testConnection(config) {
  const user = await makeRequest(config, 'GET', '/rest/api/3/myself');
  return { displayName: user.displayName, email: user.emailAddress, accountId: user.accountId };
}

// m9: JQL escape — prevent injection via double-quote escaping
function escJql(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

export async function getMyIssues(config, { project, sprint, status, maxResults } = {}) {
  const parts = ['assignee = currentUser()'];
  if (project) parts.push(`project = ${escJql(project)}`);
  if (sprint) parts.push(`sprint = ${escJql(sprint)}`);
  if (status) parts.push(`status = ${escJql(status)}`);
  const jql = parts.join(' AND ') + ' ORDER BY updated DESC';
  const key = `issues:${jql}`;

  return cached(key, async () => {
    const limit = maxResults || 200;
    let all = [];
    let nextPageToken = undefined;
    while (true) {
      const body = {
        jql,
        maxResults: Math.min(limit - all.length, 100),
        fields: ['summary','status','priority','assignee','reporter','duedate','created','updated','issuetype','sprint','labels','story_points','customfield_10016','parent'],
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const data = await makeRequest(config, 'POST', '/rest/api/3/search/jql', body);
      const batch = (data.issues || []).map(simplifyIssue);
      all = all.concat(batch);
      if (batch.length === 0 || data.isLast || all.length >= limit) break;
      nextPageToken = data.nextPageToken;
      if (!nextPageToken) break;
    }
    return all;
  });
}

// M3: Raw JQL search — used by Agent JIRA tool
export async function searchIssues(config, jql, { maxResults = 20 } = {}) {
  const limit = Math.min(maxResults, 50);
  const body = {
    jql,
    maxResults: limit,
    fields: ['summary','status','priority','assignee','reporter','duedate','created','updated','issuetype','sprint','labels','story_points','customfield_10016','parent'],
  };
  const data = await makeRequest(config, 'POST', '/rest/api/3/search/jql', body);
  return (data.issues || []).map(simplifyIssue);
}

export async function getSprints(config, boardId) {
  const key = `sprints:${boardId}`;
  return cached(key, async () => {
    const data = await makeRequest(config, 'GET', `/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=10`);
    return (data.values || []).map(s => ({
      id: s.id, name: s.name, state: s.state,
      startDate: s.startDate || null, endDate: s.endDate || null,
      goal: s.goal || '', boardId,
    }));
  });
}

export async function getAllActiveSprints(config) {
  const key = 'all-sprints';
  return cached(key, async () => {
    const boards = await getBoards(config);
    const scrumBoards = boards.filter(b => b.type === 'scrum');
    const results = await Promise.allSettled(
      scrumBoards.map(b => getSprints(config, b.id))
    );
    const all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
    // Deduplicate by sprint id, active first
    const seen = new Map();
    for (const s of all) {
      if (!seen.has(s.id) || s.state === 'active') seen.set(s.id, s);
    }
    return [...seen.values()].sort((a, b) => {
      if (a.state === 'active' && b.state !== 'active') return -1;
      if (b.state === 'active' && a.state !== 'active') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
  });
}

export async function getBoards(config, project) {
  const params = new URLSearchParams();
  if (project) params.set('projectKeyOrId', project);
  params.set('maxResults', '50');
  const data = await makeRequest(config, 'GET', `/rest/agile/1.0/board?${params}`);
  return (data.values || []).map(b => ({ id: b.id, name: b.name, type: b.type }));
}

export async function getProjects(config) {
  const key = 'projects';
  return cached(key, async () => {
    const data = await makeRequest(config, 'GET', '/rest/api/3/project/search?maxResults=50&orderBy=name');
    return (data.values || []).map(p => ({ key: p.key, name: p.name, id: p.id }));
  });
}

export async function getIssue(config, issueKey) {
  const data = await makeRequest(config, 'GET',
    `/rest/api/3/issue/${issueKey}?fields=summary,status,priority,assignee,reporter,duedate,created,updated,issuetype,sprint,labels,description,comment,story_points,customfield_10016&expand=transitions,renderedFields`);
  return simplifyIssue(data);
}

export async function getIssueTransitions(config, issueKey) {
  const data = await makeRequest(config, 'GET', `/rest/api/3/issue/${issueKey}/transitions`);
  return (data.transitions || []).map(t => ({ id: t.id, name: t.name, to: t.to?.name }));
}

export async function transitionIssue(config, issueKey, transitionId) {
  await makeRequest(config, 'POST', `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: transitionId }
  });
  clearCache();
}

export async function addComment(config, issueKey, comment) {
  // ADF format for Jira Cloud
  await makeRequest(config, 'POST', `/rest/api/3/issue/${issueKey}/comment`, {
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }]
    }
  });
}

// ─── Image proxy for Jira-hosted images (require auth) ───
export function proxyImage(config, imageUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    // Only proxy URLs from the configured Jira host
    const jiraHost = new URL(config.url).hostname;
    if (url.hostname !== jiraHost) return reject(new Error('Not a Jira URL'));
    const isHttps = url.protocol === 'https:';
    const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
    };
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return proxyImage(config, res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/png' });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Image proxy timeout')); });
    req.end();
  });
}
