// ─── Dashboard Cards: project card rendering, sorting, pinning, filtering, tags ───
import { app, notify } from './state.js';
import { esc, timeAgo, showToast, postJson } from './utils.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';

// ─── Imports from dashboard core (will be set via init) ───
let _core = null;

export function initDashboardCards(core) {
  _core = core;
}

// ─── Session Elapsed Timer ───
function fmtElapsed(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── Cards ───
export function renderCard(id) {
  const el = document.getElementById(`card-${id}`);
  if (!el) return;
  const p = app.state.projects.get(id) || {};
  const s = p.session || {}, g = p.git || {}, prs = p.prs?.prs || [];
  const st = s.state || 'no_data';
  el.dataset.status = st;
  el.querySelector('.status').className = `status ${st}`;
  const statusLabel = { busy: 'Busy', waiting: 'Waiting', idle: 'Idle', no_data: 'No Data', no_sessions: 'No Sessions' }[st] || st;
  const elapsed = (st === 'busy' || st === 'waiting') && s.lastActivity ? ` <span class="status-timer">${fmtElapsed(s.lastActivity)}</span>` : '';
  el.querySelector('.status').innerHTML = `<span class="dot"></span>${statusLabel}${elapsed}`;
  const q = c => el.querySelector(c);
  if (q('.branch-val')) q('.branch-val').textContent = g.branch || '-';
  if (q('.uncommitted-val')) {
    q('.uncommitted-val').textContent = g.uncommittedCount ?? '-';
    q('.uncommitted-val').classList.toggle('has-changes', (g.uncommittedCount || 0) > 0);
  }
  if (q('.model-val')) q('.model-val').textContent = s.model || '-';
  if (q('.last-val')) q('.last-val').textContent = s.lastActivity ? timeAgo(s.lastActivity) : '-';
  // Badges row (stash, worktrees, PRs)
  const badgesRow = q('.card-badges-row');
  if (badgesRow) {
    const badges = [];
    if (g.stashCount > 0) badges.push(`<span class="card-badge card-badge-stash" title="${g.stashCount} stash${g.stashCount > 1 ? 'es' : ''}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/></svg> ${g.stashCount}</span>`);
    if (g.worktrees?.length > 1) badges.push(`<span class="card-badge card-badge-wt" title="${g.worktrees.length} worktrees"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 22V6a2 2 0 00-2-2H4a2 2 0 00-2 2v12a2 2 0 002 2h12z"/><path d="M22 22V9a2 2 0 00-2-2h-2"/></svg> ${g.worktrees.length}</span>`);
    if (prs.length) {
      const approved = prs.filter(pr => pr.reviewDecision === 'APPROVED').length;
      const changes = prs.filter(pr => pr.reviewDecision === 'CHANGES_REQUESTED').length;
      const prCls = changes > 0 ? 'card-badge-pr-changes' : approved > 0 ? 'card-badge-pr-ok' : 'card-badge-pr';
      badges.push(`<span class="card-badge ${prCls}" title="${prs.length} PR${prs.length > 1 ? 's' : ''}${approved ? `, ${approved} approved` : ''}${changes ? `, ${changes} needs changes` : ''}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M6 9v12"/></svg> ${prs.length}</span>`);
    }
    badgesRow.innerHTML = badges.join('');
  }
  const cl = q('.commits');
  if (cl && g.recentCommits) cl.innerHTML = g.recentCommits.slice(0, 3).map(c => `<li><span class="commit-hash">${esc(c.hash)}</span> <span class="commit-msg">${esc(c.message)}</span><span class="commit-ago">${esc(c.ago)}</span></li>`).join('');
  const pl = q('.pr-list');
  if (pl) pl.innerHTML = prs.length ? prs.slice(0, 2).map(pr => `<div class="pr-item"><span class="pr-num">#${pr.number}</span><span class="pr-title">${esc(pr.title)}</span><span class="pr-review ${pr.reviewDecision}">${pr.reviewDecision === 'APPROVED' ? 'OK' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes' : 'Pending'}</span></div>`).join('') : '';
  const resumeBtn = document.getElementById(`resume-last-${id}`);
  if (resumeBtn) {
    const hasSession = s.sessionId && s.state !== 'no_data' && s.state !== 'no_sessions';
    resumeBtn.style.display = hasSession ? '' : 'none';
    if (hasSession) resumeBtn.title = `Resume session (${s.state})`;
  }
  const devBtn = document.getElementById(`dev-btn-${id}`);
  if (devBtn) {
    const proj = app.projectList.find(pp => pp.id === id);
    const hasCmd = !!proj?.devCmd;
    const isRunning = app.devServerState.some(d => d.projectId === id);
    if (hasCmd) {
      const dsInfo = app.devServerState.find(d => d.projectId === id);
      const hasPort = !!dsInfo?.port;
      const isStarting = isRunning && !hasPort;
      const dotClass = isStarting ? 'spin' : isRunning ? 'on' : 'off';
      const btnClass = isStarting ? ' starting' : isRunning ? ' running' : '';
      const label = isStarting ? 'Starting...' : isRunning ? 'Stop' : 'Dev';
      const portKey = `${id}:${dsInfo?.port}`;
      const isNewPort = hasPort && !app._knownPorts.has(portKey);
      if (isNewPort) app._knownPorts.add(portKey);
      const portTag = hasPort ? `<span class="dev-port${isNewPort ? ' pop' : ''}" data-action="open-port" data-url="http://localhost:${dsInfo.port}">:${dsInfo.port}</span>` : '';
      devBtn.className = 'btn dev-btn' + btnClass;
      devBtn.innerHTML = `<span class="dev-dot ${dotClass}"></span>${label}${portTag}`;
      devBtn.dataset.action = 'toggle-dev';
      devBtn.title = proj.devCmd + (hasPort ? ` \u2192 localhost:${dsInfo.port}` : '');
    } else {
      devBtn.className = 'btn dev-btn';
      devBtn.innerHTML = `<span class="dev-dot none"></span>Dev`;
      devBtn.dataset.action = 'prompt-dev';
      devBtn.title = 'Set dev command';
    }
  }
  const ghBtn = document.getElementById(`github-btn-${id}`);
  if (ghBtn) {
    const proj = app.projectList.find(pp => pp.id === id);
    const ghUrl = proj?.github || g.remoteUrl || '';
    ghBtn.style.display = ghUrl ? '' : 'none';
  }
}

export function cardHTML(p) {
  const isPinned = app.pinnedProjects.has(p.id);
  return `<div class="card" id="card-${p.id}">
      <div class="card-accent" style="background:${p.color};--card-color:${p.color}"></div>
      <div class="card-body">
        <div class="card-header" data-action="jump-changes" data-id="${p.id}" style="cursor:pointer" title="View changes">
          <div><span class="card-name">${esc(p.name)}</span>${(() => { const t = getProjectTags()[p.id]; return t ? `<span class="card-tag" style="background:${getTagColor(t)}">${esc(t)}</span>` : ''; })()}</div>
          <div class="card-actions">
            <span class="card-stack">${esc(p.stack || '')}</span>
            <button class="card-edit-btn" data-action="edit-project" data-id="${p.id}" title="Edit project settings"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="card-pin ${isPinned ? 'pinned' : ''}" data-action="toggle-pin" data-id="${p.id}" title="${isPinned ? 'Unpin' : 'Pin to front'}"><svg viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></button>
          </div>
        </div>
        <div style="margin-bottom:4px"><span class="status no_data"><span class="dot"></span>Loading</span></div>
        <div class="card-badges-row"></div>
        <div class="card-info">
          <div class="info-row"><span class="info-label">Branch</span><span class="info-value branch branch-val">-</span></div>
          <div class="info-row"><span class="info-label">Uncommitted</span><span class="info-value uncommitted-val" data-action="jump-changes" data-id="${p.id}" title="View changes">-</span></div>
          <div class="info-row"><span class="info-label">Model</span><span class="info-value model-val">-</span></div>
          <div class="info-row"><span class="info-label">Last</span><span class="info-value last-val">-</span></div>
        </div>
        <ul class="commits"></ul>
        <div class="pr-list"></div>
        <div class="card-foot">
          <div class="card-btn-row">
            <button class="btn primary" data-action="open-term" data-id="${p.id}" data-cmd="claude" title="New Claude session">Claude</button>
            <button class="btn" data-action="open-term" data-id="${p.id}" data-cmd="claude --resume" title="Resume last conversation">Resume</button>
            <button class="btn resume-last-btn" id="resume-last-${p.id}" data-action="resume-last" data-id="${p.id}" style="display:none" title="Resume last session in external terminal">Last</button>
            <button class="btn" data-action="open-term" data-id="${p.id}" data-cmd="" title="Open shell">Shell</button>
            <button class="btn dev-btn" id="dev-btn-${p.id}" data-action="${p.devCmd ? 'toggle-dev' : 'prompt-dev'}" data-id="${p.id}" title="${p.devCmd ? esc(p.devCmd) : 'Set dev command'}"><span class="dev-dot ${p.devCmd ? 'off' : 'none'}"></span>Dev</button>
          </div>
          <div class="card-btn-row">
            <button class="btn" data-action="open-ide" data-id="${p.id}" data-ide="code" title="VS Code"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> VS</button>
            <button class="btn" data-action="open-ide" data-id="${p.id}" data-ide="cursor" title="Cursor">Cursor</button>
            <button class="btn" data-action="open-ide" data-id="${p.id}" data-ide="zed" title="Zed">Zed</button>
            <button class="btn" data-action="open-ide" data-id="${p.id}" data-ide="antigravity" title="Antigravity">AG</button>
            <button class="btn" data-action="open-browser" data-id="${p.id}" title="Open in Firefox Developer Edition">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg> FF
            </button>
            <button class="btn card-github-btn" id="github-btn-${p.id}" data-action="open-github" data-id="${p.id}" style="display:none">GitHub</button>
            <button class="btn" data-action="session-history" data-id="${p.id}" title="Session history">Sessions</button>
            <button class="btn" data-action="git-log" data-id="${p.id}" title="Git log">Log</button>
          </div>
        </div>
      </div>
    </div>`;
}

export function renderAllCards(projects) {
  const grid = document.getElementById('project-grid');
  const newIds = projects.map(p => p.id);
  if (app._renderedCardIds.length === newIds.length && app._renderedCardIds.every((id, i) => id === newIds[i])) {
    projects.forEach(p => renderCard(p.id));
  } else {
    grid.innerHTML = projects.map(p => cardHTML(p)).join('');
    app._renderedCardIds = newIds;
  }
  if (!grid.dataset.delegated) {
    grid.dataset.delegated = '1';
    grid.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const { action, id } = el.dataset;
      if (action === 'edit-project' || action === 'toggle-pin') e.stopPropagation();
      switch (action) {
        case 'jump-changes': jumpToChanges(id); break;
        case 'edit-project': notify('editProject', id); break;
        case 'toggle-pin': togglePin(id); break;
        case 'open-term': notify('openTermWith', { id, cmd: el.dataset.cmd }); break;
        case 'resume-last': notify('resumeLastSession', id); break;
        case 'toggle-dev': notify('toggleDevServer', id); break;
        case 'prompt-dev': notify('promptDevCmd', id); break;
        case 'open-ide': notify('openIDE', { id, ide: el.dataset.ide }); break;
        case 'open-browser': openInFirefoxDev(id); break;
        case 'open-github': notify('openGitHub', id); break;
        case 'session-history': notify('showSessionHistory', id); break;
        case 'git-log': notify('showGitLog', id); break;
        case 'open-port': e.stopPropagation(); window.open(el.dataset.url, '_blank'); break;
      }
    });
  }
  setTimeout(updateScrollIndicators, 50);
  updateEmptyProjectState();
}

function openInFirefoxDev(projectId) {
  // Find dev server port for this project
  const dsInfo = app.devServerState?.find(d => d.projectId === projectId);
  const url = dsInfo?.port ? `http://localhost:${dsInfo.port}` : null;
  if (url) {
    postJson('/api/open-url', { url, browser: 'firefox-dev' })
      .then(() => showToast(`Firefox Dev \u2192 localhost:${dsInfo.port}`))
      .catch(() => showToast('Failed to open', 'error'));
  } else {
    const input = prompt('No dev server running. Enter URL to open in Firefox Developer Edition:', 'http://localhost:3000');
    if (input) {
      postJson('/api/open-url', { url: input, browser: 'firefox-dev' })
        .then(() => showToast(`Firefox Dev \u2192 ${input}`))
        .catch(() => showToast('Failed to open', 'error'));
    }
  }
}

export function renderSkeletons(count) {
  document.getElementById('project-grid').innerHTML = Array(count).fill('<div class="skeleton skeleton-card"></div>').join('');
}

// ─── Project Pin ───
export function savePins() {
  localStorage.setItem('dl-pinned', JSON.stringify([...app.pinnedProjects]));
}

export function togglePin(id) {
  if (app.pinnedProjects.has(id)) app.pinnedProjects.delete(id);
  else app.pinnedProjects.add(id);
  savePins();
  sortAndRenderProjects();
}

export function setProjectSort(sortBy) {
  app._cardSortBy = sortBy;
  localStorage.setItem('dl-card-sort', sortBy);
  const sel = document.getElementById('card-sort-select');
  if (sel) sel.value = sortBy;
  sortAndRenderProjects();
}

export function sortAndRenderProjects() {
  const sorted = [...app.projectList].sort((a, b) => {
    // Pinned first
    const ap = app.pinnedProjects.has(a.id) ? 0 : 1;
    const bp = app.pinnedProjects.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    // Then by selected sort
    const sort = app._cardSortBy || 'name';
    if (sort === 'activity') {
      const sa = app.state.projects.get(a.id)?.session;
      const sb = app.state.projects.get(b.id)?.session;
      const stateOrder = { busy: 0, waiting: 1, idle: 2, no_data: 3, no_sessions: 4 };
      const oa = stateOrder[sa?.state] ?? 3;
      const ob = stateOrder[sb?.state] ?? 3;
      if (oa !== ob) return oa - ob;
    }
    if (sort === 'recent') {
      const ta = app.state.projects.get(a.id)?.session?.lastActivity || '';
      const tb = app.state.projects.get(b.id)?.session?.lastActivity || '';
      if (ta !== tb) return ta > tb ? -1 : 1;
    }
    if (sort === 'uncommitted') {
      const ua = app.state.projects.get(a.id)?.git?.uncommittedCount || 0;
      const ub = app.state.projects.get(b.id)?.git?.uncommittedCount || 0;
      if (ua !== ub) return ub - ua;
    }
    return (a.name || '').localeCompare(b.name || '');
  });
  app._renderedCardIds = [];
  renderAllCards(sorted);
  app.projectList.forEach(p => {
    const s = app.state.projects.get(p.id);
    if (s) renderCard(p.id);
  });
}

// ─── Project Search & Scroll Indicators ───
export function setProjectFilter(filter) {
  app._projectStatusFilter = filter;
  app._projectTagFilter = '';
  document.querySelectorAll('.pf-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  document.querySelectorAll('.pf-btn[data-tag]').forEach(b => b.classList.remove('active'));
  filterProjects();
}

export function filterProjects() {
  const query = document.getElementById('project-search').value.toLowerCase().trim();
  const countEl = document.getElementById('project-search-count');
  const tags = getProjectTags();
  let visible = 0;
  app.projectList.forEach(p => {
    const card = document.getElementById(`card-${p.id}`);
    if (!card) return;
    const pState = app.state.projects.get(p.id);
    const status = pState?.session?.state || 'no_data';
    const textMatch = !query || (p.name || '').toLowerCase().includes(query) || (p.stack || '').toLowerCase().includes(query) || status.toLowerCase().includes(query) || (tags[p.id] || '').toLowerCase().includes(query);
    let statusMatch = true;
    if (app._projectStatusFilter === 'active') statusMatch = status === 'busy' || status === 'waiting';
    else if (app._projectStatusFilter === 'idle') statusMatch = status === 'idle' || status === 'no_data' || status === 'no_sessions';
    const tagMatch = !app._projectTagFilter || tags[p.id] === app._projectTagFilter;
    card.style.display = textMatch && statusMatch && tagMatch ? '' : 'none';
    if (textMatch && statusMatch && tagMatch) visible++;
  });
  countEl.textContent = query || app._projectStatusFilter !== 'all' || app._projectTagFilter ? `${visible}/${app.projectList.length}` : '';
  updateScrollIndicators();
}

// ─── Project Tags ───
const TAG_KEY = 'dl-project-tags';
const TAG_COLORS = ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#60a5fa', '#c084fc', '#fb923c', '#22d3ee'];

export function getProjectTags() {
  try { return JSON.parse(localStorage.getItem(TAG_KEY) || '{}'); } catch { /* malformed JSON */ return {}; }
}

export function setProjectTag(projectId, tag) {
  const tags = getProjectTags();
  if (tag) tags[projectId] = tag; else delete tags[projectId];
  try { localStorage.setItem(TAG_KEY, JSON.stringify(tags)); } catch { /* storage unavailable */ }
  renderTagFilters();
  filterProjects();
}

export function getTagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function renderTagFilters() {
  const container = document.getElementById('project-filter-btns');
  if (!container) return;
  // Remove old tag buttons
  container.querySelectorAll('.pf-btn[data-tag]').forEach(b => b.remove());
  // Get unique tags
  const tags = getProjectTags();
  const uniqueTags = [...new Set(Object.values(tags))].sort();
  for (const tag of uniqueTags) {
    const btn = document.createElement('button');
    btn.className = 'pf-btn' + (app._projectTagFilter === tag ? ' active' : '');
    btn.dataset.tag = tag;
    btn.style.borderLeft = `3px solid ${getTagColor(tag)}`;
    btn.textContent = tag;
    btn.onclick = () => {
      app._projectTagFilter = app._projectTagFilter === tag ? '' : tag;
      container.querySelectorAll('.pf-btn[data-tag]').forEach(b => b.classList.toggle('active', b.dataset.tag === app._projectTagFilter));
      if (app._projectTagFilter) container.querySelectorAll('.pf-btn:not([data-tag])').forEach(b => b.classList.remove('active'));
      else container.querySelector('.pf-btn[data-filter="all"]')?.classList.add('active');
      filterProjects();
    };
    container.appendChild(btn);
  }
}

export function updateScrollIndicators() {
  const grid = document.getElementById('project-grid');
  const left = document.getElementById('scroll-ind-left');
  const right = document.getElementById('scroll-ind-right');
  if (!grid || !left || !right) return;
  left.classList.toggle('hidden', grid.scrollLeft <= 5);
  right.classList.toggle('hidden', grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 5);
}

export function jumpToChanges(projectId) {
  _core.switchView('diff');
  const sel = document.getElementById('diff-project');
  if (sel) { sel.value = projectId; notify('loadDiff'); }
}

// ─── Empty Project State ───
export function updateEmptyProjectState() {
  const grid = document.getElementById('project-grid');
  const empty = document.getElementById('empty-projects');
  if (!grid || !empty) return;
  const hasCards = grid.children.length > 0;
  grid.style.display = hasCards ? '' : 'none';
  empty.style.display = hasCards ? 'none' : '';
}

// Refresh elapsed timers on active cards every second
setInterval(() => {
  for (const [id, p] of app.state.projects) {
    const s = p.session || {};
    if ((s.state === 'busy' || s.state === 'waiting') && s.lastActivity) {
      const timer = document.querySelector(`#card-${id} .status-timer`);
      if (timer) timer.textContent = fmtElapsed(s.lastActivity);
    }
  }
}, 1000);

export async function fetchAllProjects(event) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
  let ok = 0, fail = 0;
  const total = app.projectList.length;
  const update = () => { if (btn) btn.textContent = `Fetching... ${ok + fail}/${total}`; };
  const promises = app.projectList.map(p => postJson(`/api/projects/${p.id}/fetch`, {}).then(d => { if (d.error) fail++; else ok++; update(); }).catch(() => { fail++; update(); }));
  await Promise.all(promises);
  if (btn) { btn.disabled = false; btn.textContent = 'Fetch All'; }
  showToast(`Fetch All: ${ok} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
}

export async function pullAllProjects(event) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling...'; }
  let ok = 0, fail = 0;
  const total = app.projectList.length;
  const update = () => { if (btn) btn.textContent = `Pulling... ${ok + fail}/${total}`; };
  const promises = app.projectList.map(p => postJson(`/api/projects/${p.id}/pull`, {}).then(d => { if (d.error) fail++; else ok++; update(); }).catch(() => { fail++; update(); }));
  await Promise.all(promises);
  if (btn) { btn.disabled = false; btn.textContent = 'Pull All'; }
  showToast(`Pull All: ${ok} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
}
