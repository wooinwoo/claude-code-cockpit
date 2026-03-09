// ─── Jira Integration Module ───
import { app } from './state.js';
import { esc, showToast, timeAgo, sanitizeHtml } from './utils.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';

let _refreshTimer = null;
let _sortCol = 'updated';
let _sortAsc = false;

// Proxy a single Jira image URL through our server (avoids CSP and auth issues)
function proxyImg(url) {
  if (!url) return '';
  return '/api/jira/image-proxy?url=' + encodeURIComponent(url);
}

// Rewrite Jira-hosted image URLs to go through our proxy (they require auth)
function proxyJiraImages(html) {
  if (!html || !app.jiraConfig?.url) return html;
  const jiraHost = new URL(app.jiraConfig.url).hostname;
  // Match img src pointing to the Jira host
  return html.replace(/(<img\s[^>]*src=")([^"]*)/gi, (full, prefix, src) => {
    try {
      const u = new URL(src, app.jiraConfig.url);
      if (u.hostname === jiraHost) return prefix + proxyImg(u.href);
    } catch { /* invalid URL */ }
    return full;
  });
}

// ─── Init ───
export function initJira() {
  console.log('[Jira] initJira called, initialized:', app._jiraInitialized, 'config:', !!app.jiraConfig);
  if (app._jiraInitialized && app.jiraConfig) {
    // Already initialized — make sure main & correct view are visible
    document.getElementById('jira-setup').style.display = 'none';
    document.getElementById('jira-main').style.display = 'flex';
    const v = app._jiraView;
    document.getElementById('jira-list-view').style.display = v === 'list' ? '' : 'none';
    document.getElementById('jira-board-view').style.display = v === 'board' ? '' : 'none';
    document.getElementById('jira-timeline-view').style.display = v === 'timeline' ? '' : 'none';
    return;
  }
  restoreJiraFilterState();
  loadJiraConfig().then(cfg => {
    console.log('[Jira] config loaded:', !!cfg);
    if (cfg) {
      app.jiraConfig = cfg;
      document.getElementById('jira-setup').style.display = 'none';
      document.getElementById('jira-main').style.display = 'flex';
      // Ensure saved view is visible (HTML defaults to list only)
      const view = app._jiraView;
      document.getElementById('jira-list-view').style.display = view === 'list' ? '' : 'none';
      document.getElementById('jira-board-view').style.display = view === 'board' ? '' : 'none';
      document.getElementById('jira-timeline-view').style.display = view === 'timeline' ? '' : 'none';
      document.querySelectorAll('.jira-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
      if (!app._jiraInitialized) {
        app._jiraInitialized = true;
        // Validate token before loading data (search API may return 200 with empty even on expired tokens)
        validateJiraToken().then(valid => {
          if (valid) {
            loadJiraIssues();
            loadJiraProjects();
            startAutoRefresh();
          }
        });
      }
    } else {
      console.warn('[Jira] No config found, showing setup');
      document.getElementById('jira-setup').style.display = '';
      document.getElementById('jira-main').style.display = 'none';
    }
  }).catch(err => {
    console.error('[Jira] initJira error:', err);
    showToast('Jira init failed: ' + err.message, 'error');
  });
}

// ─── Auto-refresh ───
function startAutoRefresh() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => {
    if (document.getElementById('jira-view')?.classList.contains('active')) {
      loadJiraIssues();
    }
  }, 5 * 60 * 1000);
}

// ─── API helpers ───
class JiraAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'JiraAuthError'; }
}

async function jiraFetch(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    const msg = e.error || res.statusText;
    if (e.authError) throw new JiraAuthError(msg);
    throw new Error(msg);
  }
  return res.json();
}

async function validateJiraToken() {
  try {
    await jiraFetch('/api/jira/boards');
    return true;
  } catch (e) {
    if (e instanceof JiraAuthError) {
      showToast('Jira 토큰이 만료되었습니다', 'error');
      const container = document.getElementById(`jira-${app._jiraView}-view`);
      if (container) container.innerHTML = `<div class="jira-auth-error">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#ef4444" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16" r="0.5" fill="#ef4444"/></svg>
        <div class="jae-title">Jira 인증 만료</div>
        <div class="jae-msg">${esc(e.message)}</div>
        <div class="jae-hint">Atlassian에서 새 API 토큰을 생성한 후 재설정하세요.</div>
        <div class="jae-actions">
          <button class="btn jae-link" data-action="open-atlassian-tokens">Atlassian 토큰 관리</button>
          <button class="btn jae-btn" data-action="open-jira-settings">토큰 재설정</button>
        </div>
      </div>`;
      return false;
    }
    return true; // non-auth errors — proceed anyway
  }
}

async function loadJiraConfig() {
  try {
    const data = await jiraFetch('/api/jira/config');
    return data.configured ? data : null;
  } catch { return null; }
}

// ─── Setup ───
export async function testJiraConnection() {
  const btn = document.getElementById('jira-test-btn');
  const result = document.getElementById('jira-test-result');
  const url = document.getElementById('jira-url').value.trim();
  const email = document.getElementById('jira-email').value.trim();
  const token = document.getElementById('jira-token').value.trim();
  if (!url || !email || !token) { result.textContent = 'All fields required'; result.className = 'err'; return; }
  btn.disabled = true;
  result.textContent = 'Testing...';
  result.className = '';
  try {
    const data = await jiraFetch('/api/jira/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, email, token })
    });
    result.textContent = `Connected as ${data.user.displayName}`;
    result.className = 'ok';
    document.getElementById('jira-save-btn').disabled = false;
    await jiraFetch('/api/jira/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, email, token })
    });
    try {
      const [bdata, pdata] = await Promise.all([jiraFetch('/api/jira/boards'), jiraFetch('/api/jira/projects')]);
      const boards = bdata.boards || [], projects = pdata.projects || [];
      document.getElementById('jira-board-picker').style.display = '';
      document.getElementById('jira-default-project').innerHTML = '<option value="">All</option>' + projects.map(p => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join('');
      document.getElementById('jira-board-select').innerHTML = '<option value="">None</option>' + boards.map(b => `<option value="${b.id}">${esc(b.name)} (${b.type})</option>`).join('');
    } catch { /* request failed */ }
  } catch (e) {
    result.textContent = e.message;
    result.className = 'err';
  }
  btn.disabled = false;
}

export async function saveJiraSetup() {
  const url = document.getElementById('jira-url').value.trim();
  const email = document.getElementById('jira-email').value.trim();
  const token = document.getElementById('jira-token').value.trim();
  const project = document.getElementById('jira-default-project')?.value || '';
  const boardId = document.getElementById('jira-board-select')?.value || '';
  try {
    await jiraFetch('/api/jira/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, email, token, defaultProject: project, boardId })
    });
    showToast('Jira connected!', 'success');
    app._jiraInitialized = false;
    initJira();
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

export function openJiraSettings() {
  app._jiraInitialized = false;
  app.jiraConfig = null;
  document.getElementById('jira-setup').style.display = '';
  document.getElementById('jira-main').style.display = 'none';
  loadJiraConfig().then(cfg => {
    if (cfg) {
      document.getElementById('jira-url').value = cfg.url || '';
      document.getElementById('jira-email').value = cfg.email || '';
      document.getElementById('jira-token').value = '';
    }
  });
}

// ─── Data Loading ───
export async function loadJiraIssues() {
  console.log('[Jira] loadJiraIssues called, loading:', app._jiraLoading, 'view:', app._jiraView);
  if (app._jiraLoading) return;
  app._jiraLoading = true;
  const container = document.getElementById(`jira-${app._jiraView}-view`);
  if (container) container.innerHTML = '<div class="jira-loading">Loading issues</div>';
  try {
    const params = new URLSearchParams();
    if (app._jiraFilter.project) params.set('project', app._jiraFilter.project);
    if (app._jiraFilter.sprint) params.set('sprint', app._jiraFilter.sprint);
    if (app._jiraFilter.status) params.set('status', app._jiraFilter.status);
    console.log('[Jira] fetching /api/jira/issues?' + params.toString());
    const data = await jiraFetch(`/api/jira/issues?${params}`);
    app.jiraIssues = data.issues || [];
    console.log('[Jira] loaded', app.jiraIssues.length, 'issues');
    populateStatusFilter();
    populateTypeFilter();
    renderCurrentView();
    renderJiraSummary();
  } catch (e) {
    console.error('[Jira] loadJiraIssues error:', e);
    if (e instanceof JiraAuthError) {
      // 인증 오류 — 명확한 에러 UI + 재설정 버튼
      showToast('Jira 인증 실패 — 토큰을 확인하세요', 'error');
      if (container) container.innerHTML = `<div class="jira-auth-error">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#ef4444" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16" r="0.5" fill="#ef4444"/></svg>
        <div class="jae-title">Jira 인증 실패</div>
        <div class="jae-msg">${esc(e.message)}</div>
        <div class="jae-hint">Atlassian에서 새 API 토큰을 생성한 후 재설정하세요.</div>
        <div class="jae-actions">
          <button class="btn jae-link" data-action="open-atlassian-tokens">Atlassian 토큰 관리</button>
          <button class="btn jae-btn" data-action="open-jira-settings">토큰 재설정</button>
        </div>
      </div>`;
    } else {
      showToast('Failed to load issues: ' + e.message, 'error');
      if (container) container.innerHTML = `<div class="jira-empty"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><div class="je-title">Failed to load</div><div class="je-sub">${esc(e.message)}</div></div>`;
    }
  }
  app._jiraLoading = false;
}

async function loadJiraProjects() {
  try {
    const data = await jiraFetch('/api/jira/projects');
    const projects = data.projects || [];
    document.getElementById('jira-project-filter').innerHTML = '<option value="">All Projects</option>' + projects.map(p => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('');
  } catch (e) {
    if (e instanceof JiraAuthError) return; // issues 쪽에서 이미 표시됨
  }
  try {
    const sdata = await jiraFetch('/api/jira/sprints');
    app.jiraSprints = sdata.sprints || [];
    renderSprintBar();
    document.getElementById('jira-sprint-filter').innerHTML = '<option value="">All Sprints</option>' + app.jiraSprints.map(s => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('');
  } catch (e) {
    if (e instanceof JiraAuthError) return;
  }
}

function populateStatusFilter() {
  const sel = document.getElementById('jira-status-filter');
  if (!sel) return;
  const statuses = new Map();
  app.jiraIssues.forEach(i => {
    if (i.status?.name && !statuses.has(i.status.name)) statuses.set(i.status.name, i.status.category);
  });
  const current = sel.value;
  sel.innerHTML = '<option value="">All Status</option>' + [...statuses.entries()].map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  sel.value = current;
}

function populateTypeFilter() {
  const sel = document.getElementById('jira-type-filter');
  if (!sel) return;
  const types = new Set();
  app.jiraIssues.forEach(i => { if (i.type?.name) types.add(i.type.name); });
  const current = sel.value;
  sel.innerHTML = '<option value="">All Types</option>' + [...types].sort().map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = current;
}

export function filterJiraByType() {
  renderCurrentView();
  renderJiraSummary();
}

// ─── Summary Stats ───
function renderJiraSummary() {
  const bar = document.getElementById('jira-summary-bar');
  if (!bar) return;
  const issues = getFilteredIssues();
  const total = issues.length;
  const overdue = issues.filter(i => i.dueDate && new Date(i.dueDate) < new Date() && i.status?.category !== 'done').length;
  const inProgress = issues.filter(i => i.status?.category === 'indeterminate').length;
  const done = issues.filter(i => i.status?.category === 'done').length;
  const todo = total - inProgress - done;
  const donePct = total ? (done / total * 100).toFixed(1) : 0;
  const progPct = total ? (inProgress / total * 100).toFixed(1) : 0;
  bar.innerHTML = `<span class="js-stat"><span class="js-num">${total}</span> total</span>`
    + `<span class="js-stat"><span class="js-num js-todo">${todo}</span> to do</span>`
    + `<span class="js-stat"><span class="js-num js-prog">${inProgress}</span> in progress</span>`
    + `<span class="js-stat"><span class="js-num js-done">${done}</span> done</span>`
    + (overdue ? `<span class="js-stat js-stat-over"><span class="js-num js-over">${overdue}</span> overdue</span>` : '')
    + `<div class="js-progress"><div class="js-bar js-bar-done" style="width:${donePct}%"></div><div class="js-bar js-bar-prog" style="width:${progPct}%"></div></div>`;
}

// ─── Sprint Bar ───
let _sprintFilter = null;

function renderSprintBar() {
  const bar = document.getElementById('jira-sprint-bar');
  // Count issues per sprint from issue data
  const issueCounts = new Map();
  app.jiraIssues.forEach(i => {
    if (i.sprint) issueCounts.set(i.sprint.id, (issueCounts.get(i.sprint.id) || 0) + 1);
  });
  // Merge: API sprints + issue-derived sprints (dedup by id)
  const sprintMap = new Map();
  (app.jiraSprints || []).forEach(s => sprintMap.set(s.id, { ...s, count: issueCounts.get(s.id) || 0 }));
  app.jiraIssues.forEach(i => {
    if (i.sprint && !sprintMap.has(i.sprint.id)) sprintMap.set(i.sprint.id, { ...i.sprint, count: issueCounts.get(i.sprint.id) || 0 });
  });
  const sprints = [...sprintMap.values()].sort((a, b) => {
    if (a.state === 'active' && b.state !== 'active') return -1;
    if (b.state === 'active' && a.state !== 'active') return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  if (!sprints.length) { bar.innerHTML = ''; _sprintFilter = null; return; }
  const noSprint = app.jiraIssues.filter(i => !i.sprint).length;
  const allActive = _sprintFilter === null ? ' active' : '';
  let html = `<div class="sprint-chip${allActive}" data-action="filter-sprint" data-sprint="null"><span>All</span><span class="sprint-count">${app.jiraIssues.length}</span></div>`;
  sprints.forEach(s => {
    if (s.count === 0 && s.state !== 'active') return;
    const sel = String(_sprintFilter) === String(s.id) ? ' active' : '';
    html += `<div class="sprint-chip${sel}" data-action="filter-sprint" data-sprint="${s.id}"><span>${esc(s.name)}</span><span class="sprint-count">${s.count}</span></div>`;
  });
  if (noSprint) {
    const sel = _sprintFilter === 'none' ? ' active' : '';
    html += `<div class="sprint-chip${sel}" data-action="filter-sprint" data-sprint="none"><span>No Sprint</span><span class="sprint-count">${noSprint}</span></div>`;
  }
  bar.innerHTML = html;
  if (!bar.dataset.delegated) {
    bar.dataset.delegated = '1';
    bar.addEventListener('click', e => {
      const chip = e.target.closest('[data-action="filter-sprint"]');
      if (!chip) return;
      const v = chip.dataset.sprint;
      filterJiraBySprintChip(v === 'null' ? null : v);
    });
  }
}

export function filterJiraBySprintChip(sprintId) {
  _sprintFilter = sprintId;
  renderCurrentView();
  renderJiraSummary();
}

// ─── View Switching ───
export function setJiraView(mode) {
  app._jiraView = mode;
  try { localStorage.setItem('dl-jira-view', mode); } catch { /* storage unavailable */ }
  document.querySelectorAll('.jira-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  document.getElementById('jira-list-view').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('jira-board-view').style.display = mode === 'board' ? '' : 'none';
  document.getElementById('jira-timeline-view').style.display = mode === 'timeline' ? '' : 'none';
  renderCurrentView();
}

function renderCurrentView() {
  const filtered = getFilteredIssues();
  try {
    switch (app._jiraView) {
      case 'list': renderJiraList(filtered); break;
      case 'board': renderJiraBoard(filtered); break;
      case 'timeline': renderJiraTimeline(filtered); break;
    }
  } catch (err) {
    console.error('[Jira render]', err);
    const el = document.getElementById(`jira-${app._jiraView}-view`);
    if (el) el.innerHTML = `<div class="jira-empty"><div class="je-title">Render error</div><div class="je-sub">${esc(err.message)}</div></div>`;
  }
  renderSprintBar();
}

// ─── Filtering ───
function getFilteredIssues() {
  let issues = [...app.jiraIssues];
  // Sprint chip filter
  if (_sprintFilter === 'none') issues = issues.filter(i => !i.sprint);
  else if (_sprintFilter !== null) issues = issues.filter(i => String(i.sprint?.id) === String(_sprintFilter));
  const q = app._jiraFilter.search?.toLowerCase();
  if (q) issues = issues.filter(i => i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q) || (i.parent?.key || '').toLowerCase().includes(q) || (i.parent?.summary || '').toLowerCase().includes(q));
  const sf = document.getElementById('jira-status-filter')?.value;
  if (sf) issues = issues.filter(i => i.status?.name === sf);
  const tf = document.getElementById('jira-type-filter')?.value;
  if (tf) issues = issues.filter(i => i.type?.name === tf);
  return issues;
}

export function filterJiraByProject(val) {
  app._jiraFilter.project = val;
  saveJiraFilterState();
  loadJiraIssues();
}

export function filterJiraBySprint(val) {
  app._jiraFilter.sprint = val;
  saveJiraFilterState();
  loadJiraIssues();
}

export function filterJiraByStatus() {
  saveJiraFilterState();
  renderCurrentView();
  renderJiraSummary();
}

export function filterJiraIssues() {
  app._jiraFilter.search = document.getElementById('jira-search').value;
  renderCurrentView();
}

function saveJiraFilterState() {
  try {
    localStorage.setItem('dl-jira-filter', JSON.stringify({
      project: app._jiraFilter.project,
      sprint: app._jiraFilter.sprint,
      status: app._jiraFilter.status,
    }));
  } catch { /* storage unavailable */ }
}

function restoreJiraFilterState() {
  try {
    const saved = JSON.parse(localStorage.getItem('dl-jira-filter') || '{}');
    if (saved.project) app._jiraFilter.project = saved.project;
    if (saved.sprint) app._jiraFilter.sprint = saved.sprint;
    if (saved.status) app._jiraFilter.status = saved.status;
  } catch { /* malformed JSON */ }
}

// ─── Sorting ───
export function sortJiraBy(col) {
  if (_sortCol === col) _sortAsc = !_sortAsc;
  else { _sortCol = col; _sortAsc = col === 'key' || col === 'summary'; }
  renderCurrentView();
}

function sortIssues(issues) {
  const sorted = [...issues];
  sorted.sort((a, b) => {
    let va, vb;
    switch (_sortCol) {
      case 'key': va = a.key; vb = b.key; break;
      case 'type': va = a.type?.name || ''; vb = b.type?.name || ''; break;
      case 'summary': va = a.summary; vb = b.summary; break;
      case 'status': va = a.status?.name || ''; vb = b.status?.name || ''; break;
      case 'due':
        va = a.dueDate || '9999'; vb = b.dueDate || '9999'; break;
      case 'priority': {
        const pOrder = { Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4 };
        va = pOrder[a.priority?.name] ?? 5; vb = pOrder[b.priority?.name] ?? 5; break;
      }
      case 'assignee': va = a.assignee?.displayName || 'zzz'; vb = b.assignee?.displayName || 'zzz'; break;
      case 'updated': va = a.updated || ''; vb = b.updated || ''; break;
      default: va = a.updated || ''; vb = b.updated || '';
    }
    if (va < vb) return _sortAsc ? -1 : 1;
    if (va > vb) return _sortAsc ? 1 : -1;
    return 0;
  });
  // Always pin overdue to top (regardless of sort)
  const now = new Date();
  const overdue = sorted.filter(i => i.dueDate && new Date(i.dueDate) < now && i.status?.category !== 'done');
  const rest = sorted.filter(i => !(i.dueDate && new Date(i.dueDate) < now && i.status?.category !== 'done'));
  return [...overdue, ...rest];
}

// ─── Date helpers ───
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dDay(iso, statusCat) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d - now) / 86400000);
  if (statusCat === 'done') return 'Done';
  if (diff === 0) return 'D-Day';
  if (diff > 0) return `D-${diff}`;
  return `D+${Math.abs(diff)}`;
}

function dueBadge(iso, statusCat) {
  if (!iso) return '<span class="jt-due jt-due-none">-</span>';
  const d = new Date(iso);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.ceil((d - now) / 86400000);
  const dateStr = fmtDate(iso);
  const dd = dDay(iso, statusCat);
  if (statusCat === 'done') return `<span class="jt-due jt-due-done" title="${dateStr}">${dateStr}</span>`;
  if (diff < 0) return `<span class="jt-due jt-due-over" title="${dateStr} (${dd})">${dateStr} <small>${dd}</small></span>`;
  if (diff === 0) return `<span class="jt-due jt-due-today" title="Today!">${dateStr} <small>D-Day</small></span>`;
  if (diff <= 2) return `<span class="jt-due jt-due-soon" title="${dd}">${dateStr} <small>${dd}</small></span>`;
  if (diff <= 7) return `<span class="jt-due jt-due-week" title="${dd}">${dateStr} <small>${dd}</small></span>`;
  return `<span class="jt-due" title="${dd}">${dateStr} <small>${dd}</small></span>`;
}

const _projColors = new Map();
const _projPalette = ['#6366f1','#0ea5e9','#f59e0b','#10b981','#ec4899','#8b5cf6','#ef4444','#14b8a6','#f97316','#a855f7','#06b6d4','#e11d48','#84cc16','#f43f5e','#3b82f6','#d946ef'];

function projectColor(proj) {
  if (!_projColors.has(proj)) _projColors.set(proj, _projPalette[_projColors.size % _projPalette.length]);
  return _projColors.get(proj);
}

function projectTag(key) {
  const proj = key.split('-')[0];
  return `<span class="jt-proj" style="background:${projectColor(proj)}">${proj}</span>`;
}

function jiraUrl(key) {
  const base = app.jiraConfig?.url || '';
  return base ? `${base}/browse/${key}` : '#';
}

// ─── List View ───
function renderJiraList(issues) {
  const el = document.getElementById('jira-list-view');
  if (!issues.length) {
    el.innerHTML = '<div class="jira-empty"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg><div class="je-title">No issues found</div><div class="je-sub">Try changing filters</div></div>';
    return;
  }
  const sorted = sortIssues(issues);
  const arrow = col => _sortCol === col ? (_sortAsc ? ' &#9650;' : ' &#9660;') : '';
  el.innerHTML = `<table class="jira-table"><colgroup>
    <col style="width:32px"><col style="width:120px"><col><col style="width:110px"><col style="width:90px"><col style="width:36px"><col style="width:110px"><col style="width:80px">
  </colgroup><thead><tr>
    <th></th>
    <th data-action="sort" data-col="key" class="${_sortCol === 'key' ? 'sorted' : ''}">Key${arrow('key')}</th>
    <th data-action="sort" data-col="summary" class="${_sortCol === 'summary' ? 'sorted' : ''}">Summary${arrow('summary')}</th>
    <th data-action="sort" data-col="status" class="${_sortCol === 'status' ? 'sorted' : ''}">Status${arrow('status')}</th>
    <th data-action="sort" data-col="due" class="${_sortCol === 'due' ? 'sorted' : ''}">Due${arrow('due')}</th>
    <th data-action="sort" data-col="priority" class="${_sortCol === 'priority' ? 'sorted' : ''}">P${arrow('priority')}</th>
    <th data-action="sort" data-col="assignee" class="${_sortCol === 'assignee' ? 'sorted' : ''}">Assignee${arrow('assignee')}</th>
    <th data-action="sort" data-col="updated" class="${_sortCol === 'updated' ? 'sorted' : ''}">Updated${arrow('updated')}</th>
  </tr></thead><tbody>${sorted.map(i => {
    const overdue = i.dueDate && new Date(i.dueDate) < new Date() && i.status?.category !== 'done';
    const parentInfo = i.parent ? `<div class="jt-parent"><a class="jt-parent-link" href="${esc(jiraUrl(i.parent.key))}" target="_blank" rel="noopener" data-action="noop" title="${esc(i.parent.summary)}">${esc(i.parent.key)}</a> <span class="jt-parent-sum">${esc(i.parent.summary)}</span></div>` : '';
    const typeBadge = i.type ? `<span class="jt-type-badge">${esc(i.type.name)}</span>` : '';
    return `<tr class="${overdue ? 'jt-overdue' : ''}" data-action="show-detail" data-key="${esc(i.key)}">
    <td>${i.type?.iconUrl ? `<img class="jt-type-icon" src="${proxyImg(i.type.iconUrl)}" title="${esc(i.type.name)}">` : ''}</td>
    <td class="jt-key">${projectTag(i.key)}<a class="jt-key-link" href="${esc(jiraUrl(i.key))}" target="_blank" rel="noopener" title="Open in Jira">${esc(i.key)}</a></td>
    <td class="jt-summary-cell"><div class="jt-summary-row">${typeBadge}<span class="jt-summary">${esc(i.summary)}</span></div>${parentInfo}</td>
    <td>${statusBadge(i.status)}</td>
    <td>${dueBadge(i.dueDate, i.status?.category)}</td>
    <td>${priorityIcon(i.priority)}</td>
    <td class="jt-assignee">${i.assignee ? `<img class="jt-avatar" src="${proxyImg(i.assignee.avatarUrl)}" alt="">${esc(i.assignee.displayName)}` : '<span style="color:var(--text-3)">-</span>'}</td>
    <td class="jt-updated">${i.updated ? timeAgo(i.updated) : '-'}</td>
  </tr>`;
  }).join('')}</tbody></table>`;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      if (e.target.closest('a')) return; // let links work normally
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      if (actionEl.dataset.action === 'sort') sortJiraBy(actionEl.dataset.col);
      else if (actionEl.dataset.action === 'show-detail') showIssueDetail(actionEl.dataset.key);
    });
  }
}

// ─── Board View ───
function renderJiraBoard(issues) {
  const el = document.getElementById('jira-board-view');
  // Build columns from actual status names, grouped by category
  const statusMap = new Map();
  issues.forEach(i => {
    const name = i.status?.name || 'Unknown';
    const cat = i.status?.category || 'undefined';
    if (!statusMap.has(name)) statusMap.set(name, { name, cat, issues: [] });
    statusMap.get(name).issues.push(i);
  });
  // Sort columns: new → indeterminate → done
  const catOrder = { 'new': 0, 'undefined': 0, 'indeterminate': 1, 'done': 2 };
  const cols = [...statusMap.values()].sort((a, b) => (catOrder[a.cat] ?? 1) - (catOrder[b.cat] ?? 1));
  if (!cols.length) {
    el.innerHTML = '<div class="jira-empty"><div class="je-title">No issues</div></div>';
    return;
  }
  el.innerHTML = cols.map(c => {
    const catClass = c.cat === 'done' ? 'jbc-done' : c.cat === 'indeterminate' ? 'jbc-indeterminate' : 'jbc-new';
    return `<div class="jira-board-col ${catClass}" data-status="${esc(c.name)}">
    <div class="jira-board-col-head"><span>${esc(c.name)}</span><span class="col-count">${c.issues.length}</span></div>
    <div class="jira-board-col-body" data-dropzone="board" data-status="${esc(c.name)}">
      ${c.issues.map(i => boardCard(i)).join('')}
    </div>
  </div>`;
  }).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const card = e.target.closest('[data-action="show-detail"]');
      if (card) showIssueDetail(card.dataset.key);
    });
    el.addEventListener('dragstart', e => {
      const card = e.target.closest('.jira-card[data-key]');
      if (card) { e.dataTransfer.setData('text/plain', card.dataset.key); card.classList.add('dragging'); }
    });
    el.addEventListener('dragend', e => {
      const card = e.target.closest('.jira-card');
      if (card) card.classList.remove('dragging');
    });
    el.addEventListener('dragover', e => {
      const zone = e.target.closest('[data-dropzone="board"]');
      if (zone) { e.preventDefault(); zone.classList.add('drag-over'); }
    });
    el.addEventListener('dragleave', e => {
      const zone = e.target.closest('[data-dropzone="board"]');
      if (zone) zone.classList.remove('drag-over');
    });
    el.addEventListener('drop', e => {
      const zone = e.target.closest('[data-dropzone="board"]');
      if (zone) { e.preventDefault(); zone.classList.remove('drag-over'); handleBoardDrop(e, zone.dataset.status); }
    });
  }
}

function boardCard(i) {
  const overdue = i.dueDate && new Date(i.dueDate) < new Date() && i.status?.category !== 'done';
  return `<div class="jira-card${overdue ? ' jc-overdue' : ''}" draggable="true" data-key="${esc(i.key)}" data-action="show-detail">
    <div class="jc-head">
      <span class="jc-key">${esc(i.key)}</span>
      ${i.type?.iconUrl ? `<img class="jc-type" src="${proxyImg(i.type.iconUrl)}" alt="">` : ''}
    </div>
    <div class="jc-summary">${esc(i.summary)}</div>
    ${i.parent ? `<div class="jc-parent">${esc(i.parent.key)} ${esc(i.parent.summary)}</div>` : ''}
    <div class="jc-foot">
      <span class="jc-left">
        ${i.dueDate ? dueBadge(i.dueDate, i.status?.category) : ''}
        ${i.labels?.length ? `<span class="jc-label">${esc(i.labels[0])}</span>` : ''}
      </span>
      <span class="jc-right">
        ${priorityIcon(i.priority)}
        ${i.assignee?.avatarUrl ? `<img class="jc-avatar" src="${proxyImg(i.assignee.avatarUrl)}" title="${esc(i.assignee.displayName)}">` : ''}
      </span>
    </div>
  </div>`;
}

export async function handleBoardDrop(event, targetStatus) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  const key = event.dataTransfer.getData('text/plain');
  if (!key) return;
  try {
    const resp = await jiraFetch(`/api/jira/issues/${key}`);
    const trans = resp.issue?.transitions || [];
    // Find transition matching target status name
    const t = trans.find(tr => tr.to === targetStatus || tr.name === targetStatus)
      || trans.find(tr => tr.name.toLowerCase().includes(targetStatus.toLowerCase()))
      || trans[0];
    if (t) {
      await jiraFetch(`/api/jira/issues/${key}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transitionId: t.id })
      });
      showToast(`${key} → ${t.to || t.name}`, 'success');
      loadJiraIssues();
    }
  } catch (e) {
    showToast('Transition failed: ' + e.message, 'error');
  }
}

// ─── Timeline View (Gantt) ───
function renderJiraTimeline(issues) {
  const el = document.getElementById('jira-timeline-view');
  const dated = issues.filter(i => i.dueDate || i.created);
  if (!dated.length) {
    el.innerHTML = '<div class="jira-empty"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="4" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/></svg><div class="je-title">No timeline data</div><div class="je-sub">Issues need created/due dates</div></div>';
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Dynamic range: from earliest date to latest, with padding
  let minDate = new Date(today), maxDate = new Date(today);
  dated.forEach(i => {
    if (i.created) { const d = new Date(i.created); if (d < minDate) minDate = d; }
    if (i.dueDate) { const d = new Date(i.dueDate); if (d > maxDate) maxDate = d; }
  });
  const startDate = new Date(minDate);
  startDate.setDate(startDate.getDate() - 3);
  const endDate = new Date(maxDate);
  endDate.setDate(endDate.getDate() + 7);
  const totalDays = Math.max(14, Math.ceil((endDate - startDate) / 86400000));
  const days = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  const todayIdx = Math.floor((today - startDate) / 86400000);
  // Week headers
  const weeks = [];
  let currWeek = null;
  days.forEach(d => {
    const wk = getWeekNumber(d);
    const label = `${d.getMonth() + 1}월 W${wk}`;
    if (!currWeek || currWeek.label !== label) {
      currWeek = { label, count: 0 };
      weeks.push(currWeek);
    }
    currWeek.count++;
  });
  // Sort: overdue first, then by due date
  const sortedDated = [...dated].sort((a, b) => {
    const ad = a.dueDate || '9999', bd = b.dueDate || '9999';
    return ad.localeCompare(bd);
  });

  const labelW = 220;
  el.innerHTML = `<div class="jira-gantt" style="min-width:${labelW + days.length * 28}px">
    <div class="jira-gantt-header">
      <div class="gh-row">
        <div class="gh-label" style="min-width:${labelW}px">Issue</div>
        <div class="gh-dates">
          <div class="gh-weeks">${weeks.map(w => `<div class="gh-week" style="flex:${w.count}">${w.label}</div>`).join('')}</div>
          <div class="gh-days">${days.map(d => {
            const isToday = d.toDateString() === today.toDateString();
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            return `<div class="gh-day${isToday ? ' today' : ''}${isWeekend ? ' weekend' : ''}">${d.getDate()}</div>`;
          }).join('')}</div>
        </div>
      </div>
    </div>
    <div class="jira-gantt-body">
      ${sortedDated.map(i => {
        const created = i.created ? new Date(i.created) : null;
        const due = i.dueDate ? new Date(i.dueDate) : null;
        const barStart = created ? Math.max(0, Math.floor((created - startDate) / 86400000)) : todayIdx;
        const barEnd = due ? Math.min(totalDays, Math.ceil((due - startDate) / 86400000)) : barStart + 3;
        const left = (barStart / totalDays * 100).toFixed(2);
        const width = (Math.max(1, barEnd - barStart) / totalDays * 100).toFixed(2);
        const cat = i.status?.category;
        const statusClass = cat === 'done' ? 'done' : cat === 'indeterminate' ? 'in-progress' : '';
        const overdue = due && due < today && cat !== 'done' ? ' overdue' : '';
        return `<div class="jira-gantt-row" data-action="show-detail" data-key="${esc(i.key)}">
        <div class="gr-label" style="min-width:${labelW}px">
          ${i.type?.iconUrl ? `<img class="jt-type-icon" src="${proxyImg(i.type.iconUrl)}">` : ''}
          <span class="gr-key">${esc(i.key)}</span>
          <span class="gr-name">${esc(i.summary)}</span>
          ${due ? `<span class="gr-due">${dueBadge(i.dueDate, cat)}</span>` : ''}
        </div>
        <div class="gr-track">
          <div class="jira-gantt-bar ${statusClass}${overdue}" style="left:${left}%;width:${width}%" title="${i.key}: ${i.dueDate ? i.dueDate : 'no due date'}"></div>
        </div>
      </div>`;
      }).join('')}
    </div>
    <div class="jira-gantt-today-line" style="left:calc(${labelW}px + ${(todayIdx / totalDays * 100).toFixed(2)}%)"></div>
  </div>`;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const row = e.target.closest('[data-action="show-detail"]');
      if (row) showIssueDetail(row.dataset.key);
    });
  }
}

function getWeekNumber(d) {
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
}

// ─── Issue Detail Side Panel ───
export async function showIssueDetail(key) {
  app._jiraDetailKey = key;
  const panel = document.getElementById('jira-detail');
  panel.innerHTML = '<div class="jira-loading">Loading issue</div>';
  panel.classList.add('open');
  if (!panel.dataset.delegated) {
    panel.dataset.delegated = '1';
    panel.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      e.stopPropagation();
      switch (el.dataset.action) {
        case 'close-detail': closeIssueDetail(); break;
        case 'change-status': changeIssueStatus(el.dataset.key, el.dataset.tid); break;
        case 'forge-jira': forgeFromJira(el.dataset.key); break;
        case 'add-comment': addJiraComment(el.dataset.key); break;
      }
    });
  }
  try {
    const idata = await jiraFetch(`/api/jira/issues/${key}`);
    const issue = idata.issue;
    const url = jiraUrl(key);
    panel.innerHTML = `<div class="jira-detail-head">
      <div class="jd-head-left">
        ${issue.type?.iconUrl ? `<img src="${proxyImg(issue.type.iconUrl)}" width="18" height="18" style="border-radius:3px">` : ''}
        <a class="jd-key" href="${esc(url)}" target="_blank" rel="noopener" title="Open in Jira">${esc(issue.key)}</a>
        ${statusBadge(issue.status)}
      </div>
      <button class="jd-close" data-action="close-detail"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="jira-detail-body">
      <div class="jd-summary">${esc(issue.summary)}</div>
      ${issue.parent ? `<div class="jd-parent"><span class="jd-parent-label">Parent:</span> <a href="${esc(jiraUrl(issue.parent.key))}" target="_blank" rel="noopener" class="jd-parent-key">${esc(issue.parent.key)}</a> <span class="jd-parent-sum">${esc(issue.parent.summary)}</span></div>` : ''}
      ${issue.transitions?.length ? `<div class="jd-transitions">${issue.transitions.map(t => `<button class="jd-trans-btn" data-action="change-status" data-key="${esc(issue.key)}" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}
      <div class="jd-actions"><button class="btn jd-forge-btn" data-action="forge-jira" data-key="${esc(issue.key)}">🔥 Forge</button></div>
      <div class="jd-meta">
        <span class="jd-meta-label">Assignee</span>
        <span class="jd-meta-value">${issue.assignee ? `<img class="jt-avatar" src="${proxyImg(issue.assignee.avatarUrl)}" alt=""> ${esc(issue.assignee.displayName)}` : 'Unassigned'}</span>
        <span class="jd-meta-label">Reporter</span>
        <span class="jd-meta-value">${esc(issue.reporter?.displayName || '-')}</span>
        <span class="jd-meta-label">Priority</span>
        <span class="jd-meta-value">${priorityIcon(issue.priority)} ${esc(issue.priority?.name || '-')}</span>
        <span class="jd-meta-label">Due Date</span>
        <span class="jd-meta-value">${issue.dueDate ? `${dueBadge(issue.dueDate, issue.status?.category)}` : '-'}</span>
        ${issue.storyPoints != null ? `<span class="jd-meta-label">Points</span><span class="jd-meta-value"><span class="jc-points">${issue.storyPoints}</span></span>` : ''}
        ${issue.labels?.length ? `<span class="jd-meta-label">Labels</span><span class="jd-meta-value">${issue.labels.map(l => `<span class="jd-label">${esc(l)}</span>`).join(' ')}</span>` : ''}
        <span class="jd-meta-label">Created</span>
        <span class="jd-meta-value">${issue.created ? new Date(issue.created).toLocaleDateString('ko-KR') : '-'}</span>
        <span class="jd-meta-label">Updated</span>
        <span class="jd-meta-value">${issue.updated ? timeAgo(issue.updated) : '-'}</span>
      </div>
      ${issue.renderedDescription || issue.description ? `<div class="jd-description">${issue.renderedDescription ? proxyJiraImages(sanitizeHtml(issue.renderedDescription)) : '<p>' + esc(typeof issue.description === 'string' ? issue.description : 'See Jira for full description') + '</p>'}</div>` : ''}
      <div class="jd-comments">
        <h4>Comments${issue.comments?.length ? ` (${issue.comments.length})` : ''}</h4>
        ${(issue.comments || []).length === 0 ? '<div class="jd-no-comments">No comments yet</div>' : ''}
        ${(issue.comments || []).map(c => `<div class="jd-comment">
          <div class="jd-comment-head"><span class="jd-comment-author">${esc(c.author)}</span><span class="jd-comment-date">${timeAgo(c.created)}</span></div>
          <div class="jd-comment-body">${proxyJiraImages(sanitizeHtml(c.body || ''))}</div>
        </div>`).join('')}
        <div class="jd-add-comment">
          <textarea id="jira-comment-input" placeholder="Add a comment..." rows="2"></textarea>
          <button data-action="add-comment" data-key="${esc(issue.key)}">Send</button>
        </div>
      </div>
    </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="jira-detail-head"><div class="jd-head-left"><span class="jd-key">${esc(key)}</span></div><button class="jd-close" data-action="close-detail"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="jira-detail-body"><div class="jira-empty"><div class="je-title">Failed to load</div><div class="je-sub">${esc(e.message)}</div></div></div>`;
  }
}

export function closeIssueDetail() {
  app._jiraDetailKey = null;
  document.getElementById('jira-detail').classList.remove('open');
}

export async function changeIssueStatus(key, transitionId) {
  try {
    await jiraFetch(`/api/jira/issues/${key}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transitionId })
    });
    showToast('Status updated', 'success');
    showIssueDetail(key);
    loadJiraIssues();
  } catch (e) {
    showToast('Transition failed: ' + e.message, 'error');
  }
}

export async function addJiraComment(key) {
  const input = document.getElementById('jira-comment-input');
  const text = input?.value.trim();
  if (!text) return;
  try {
    await jiraFetch(`/api/jira/issues/${key}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: text })
    });
    input.value = '';
    showToast('Comment added', 'success');
    showIssueDetail(key);
  } catch (e) {
    showToast('Comment failed: ' + e.message, 'error');
  }
}

// ─── Helpers ───
function statusBadge(status) {
  if (!status) return '<span class="jira-status st-undefined">Unknown</span>';
  const cat = status.category || 'undefined';
  return `<span class="jira-status st-${cat}">${esc(status.name)}</span>`;
}

function priorityIcon(priority) {
  if (!priority) return '';
  if (priority.iconUrl) return `<img class="jt-priority" src="${proxyImg(priority.iconUrl)}" alt="${esc(priority.name)}" title="${esc(priority.name)}">`;
  const cls = 'jp-' + (priority.name || '').toLowerCase();
  return `<span class="${cls}" title="${esc(priority.name)}">${esc(priority.name)}</span>`;
}

// ─── Forge Integration ───
export function forgeFromJira(issueKey) {
  const issue = app.jiraIssues.find(i => i.key === issueKey);
  if (!issue) { showToast('Issue not found', 'error'); return; }

  let descText = '';
  if (issue.renderedDescription) {
    const div = document.createElement('div');
    div.innerHTML = issue.renderedDescription;
    descText = div.textContent || '';
  } else if (typeof issue.description === 'string') {
    descText = issue.description;
  }

  // Extract file paths from description
  const pathRegex = /(?:^|\s)((?:src|lib|app|test|pages|components|services|utils|config)\/[\w./-]+\.\w+)/gm;
  const paths = [];
  let m;
  while ((m = pathRegex.exec(descText)) !== null) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }

  // Match project by Jira key prefix
  const prefix = issueKey.split('-')[0].toLowerCase();
  const proj = (app.projectList || []).find(p => p.name.toLowerCase().includes(prefix));

  openForgeWithPrefill({
    task: `[${issue.key}] ${issue.summary}\n\n${descText}`.trim(),
    referenceFiles: paths.slice(0, 10).join('\n'),
    projectId: proj?.id || '',
    plan: 'standard',
    source: 'jira',
    sourceRef: issueKey,
  });
}

// ─── Action Registration ───
registerClickActions({
  'test-jira': testJiraConnection,
  'save-jira': saveJiraSetup,
  'set-jira-view': (el) => setJiraView(el.dataset.view),
  'refresh-jira': loadJiraIssues,
  'open-jira-settings': openJiraSettings,
  'open-atlassian-tokens': () => fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://id.atlassian.com/manage-profile/security/api-tokens' }) }),
});
registerChangeActions({
  'jira-project-filter': (el) => filterJiraByProject(el.value),
  'jira-status-filter': filterJiraByStatus,
  'jira-type-filter': filterJiraByType,
});
registerInputActions({
  'filter-jira-issues': filterJiraIssues,
});
