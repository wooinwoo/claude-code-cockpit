// ─── Dashboard: Overview tab, SSE, stats, cards, charts, usage ───
import { app } from './state.js';
import { esc, timeAgo, showToast, fmtTok, timeUntil, row, fetchJson, postJson } from './utils.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';

// ─── Notifications ───
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

export function notifySessionChange(projectId, oldState, newState) {
  if (!app.notifyEnabled) return;
  if (!isNotifEnabledForProject(projectId)) return;
  const project = app.projectList.find(p => p.id === projectId);
  const name = project?.name || projectId;
  const wasActive = oldState === 'busy' || oldState === 'waiting';
  let title = '', body = '';
  if (wasActive && newState === 'idle') {
    title = `${name} — Session Complete`;
    body = 'Claude session finished.';
  } else if (wasActive && (newState === 'no_data' || newState === 'no_sessions')) {
    title = `${name} — Session Ended`;
    body = 'Claude session disconnected.';
  }
  if (!title) return;
  // 1) Browser Notification API (if permission granted)
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag: `session-${projectId}`, silent: false });
    } catch {}
  }
  // 2) Audio beep — always plays as backup
  playNotifSound();
  // 3) Title flash — visible when tab is in background
  flashTitle(title);
}

// ─── Audio notification (reuse single AudioContext) ───
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

function playNotifSound() {
  try {
    const ctx = getAudioCtx();
    [0, 0.15].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 880 : 1100;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + offset + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.3);
    });
  } catch {}
}

// ─── Title flash ───
let _flashTimer = null;
function flashTitle(msg) {
  if (_flashTimer) clearInterval(_flashTimer);
  const orig = document.title;
  let on = true;
  _flashTimer = setInterval(() => {
    document.title = on ? `🔔 ${msg}` : orig;
    on = !on;
  }, 800);
  // Stop after 10 seconds or on focus
  const stop = () => {
    if (_flashTimer) { clearInterval(_flashTimer); _flashTimer = null; }
    document.title = orig;
    window.removeEventListener('focus', stop);
  };
  window.addEventListener('focus', stop);
  setTimeout(stop, 10000);
}

// ─── Clock ───
export function updateClock() {
  const now = new Date();
  document.getElementById('header-clock').textContent = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function startClock() {
  app._clockTimer = setInterval(updateClock, 1000);
  updateClock();
}

// ─── Activity Log ───
const MAX_ACTIVITY = 50;
const _activityLog = [];

export function addActivity(icon, text) {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  _activityLog.unshift({ icon, text, time });
  if (_activityLog.length > MAX_ACTIVITY) _activityLog.length = MAX_ACTIVITY;
  renderActivityLog();
}

function renderActivityLog() {
  const section = document.getElementById('activity-log-section');
  const list = document.getElementById('activity-log-list');
  if (!section || !list) return;
  if (_activityLog.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.innerHTML = _activityLog.slice(0, 15).map(a =>
    `<div class="al-item"><span class="al-icon">${a.icon}</span><span class="al-text">${esc(a.text)}</span><span class="al-time">${a.time}</span></div>`
  ).join('');
}

// ─── SSE ───
let _currentES = null;
export function connectSSE() {
  if (app._sseReconnTimer) { clearTimeout(app._sseReconnTimer); app._sseReconnTimer = null; }
  if (_currentES) { try { _currentES.close(); } catch {} _currentES = null; }
  const es = new EventSource('/api/events');
  _currentES = es;
  es.addEventListener('init', e => {
    app._sseBackoff = 1000;
    app._sseConnectedAt = Date.now();
    const d = JSON.parse(e.data);
    if (d.sessions) Object.entries(d.sessions).forEach(([k, v]) => {
      if (v) { upd(k, 'session', v); app.prevSessionStates.set(k, v.state); }
    });
    if (d.git) Object.entries(d.git).forEach(([k, v]) => { if (v) upd(k, 'git', v); });
    if (d.prs) Object.entries(d.prs).forEach(([k, v]) => { if (v) upd(k, 'prs', v); });
    if (d.costs) { app.state.usage = d.costs; renderCosts(); renderUsage(); }
    if (d.devServers) { app.devServerState = d.devServers; window.updateDevBadge?.(); }
    if (d.nodeVersion) app.nodeVersion = d.nodeVersion;
    const changedIds = new Set();
    if (d.sessions) Object.keys(d.sessions).forEach(k => changedIds.add(k));
    if (d.git) Object.keys(d.git).forEach(k => changedIds.add(k));
    if (d.prs) Object.keys(d.prs).forEach(k => changedIds.add(k));
    if (changedIds.size > 0) changedIds.forEach(id => renderCard(id));
    else app.projectList.forEach(p => renderCard(p.id));
    updateSummaryStats();
    fetchUsage();
    setConn(true);
  });
  es.addEventListener('session:status', e => {
    const d = JSON.parse(e.data);
    const oldState = app.prevSessionStates.get(d.projectId);
    const newState = d.state;
    if (oldState && oldState !== newState) {
      notifySessionChange(d.projectId, oldState, newState);
      const pName = app.projectList.find(p => p.id === d.projectId)?.name || d.projectId;
      const icons = { busy: '\u25B6', waiting: '\u23F8', idle: '\u23F9', no_data: '\u2013', no_sessions: '\u2013' };
      addActivity(icons[newState] || '\u2022', `${pName}: ${oldState} \u2192 ${newState}`);
    }
    app.prevSessionStates.set(d.projectId, newState);
    upd(d.projectId, 'session', d);
    queueRender(d.projectId);
    window.debouncedUpdateTermHeaders?.();
  });
  es.addEventListener('git:update', e => {
    const d = JSON.parse(e.data);
    upd(d.projectId, 'git', d);
    queueRender(d.projectId);
    window.debouncedUpdateTermHeaders?.();
    window.populateProjectSelects?.();
    window.renderProjectChips?.();
    if (document.getElementById('diff-view')?.classList.contains('active')) {
      const sel = document.getElementById('diff-project');
      if (sel?.value === d.projectId) window.debouncedLoadDiff?.();
    }
  });
  es.addEventListener('pr:update', e => {
    const d = JSON.parse(e.data);
    upd(d.projectId, 'prs', d);
    queueRender(d.projectId);
  });
  es.addEventListener('cost:update', e => {
    app.state.usage = JSON.parse(e.data);
    renderCosts();
    renderUsage();
    queueStats();
  });
  es.addEventListener('dev:status', e => {
    const d = JSON.parse(e.data);
    const newRunning = d.running || [];
    const runIds = new Set(newRunning.map(ds => ds.projectId));
    for (const key of app._knownPorts) {
      if (!runIds.has(key.split(':')[0])) app._knownPorts.delete(key);
    }
    app.devServerState = newRunning;
    for (const ds of newRunning) {
      if (ds.port && app._devStartTimeouts.has(ds.projectId)) {
        clearTimeout(app._devStartTimeouts.get(ds.projectId));
        app._devStartTimeouts.delete(ds.projectId);
      }
    }
    window.updateDevBadge?.();
    app.devServerState.forEach(ds => queueRender(ds.projectId));
    app.projectList.forEach(p => {
      if (!app.devServerState.some(ds => ds.projectId === p.id)) queueRender(p.id);
    });
  });
  es.addEventListener('workflow:update', e => { window.handleWorkflowEvent?.('workflow:update', JSON.parse(e.data)); });
  es.addEventListener('workflow:complete', e => { window.handleWorkflowEvent?.('workflow:complete', JSON.parse(e.data)); });
  es.addEventListener('workflow:error', e => { window.handleWorkflowEvent?.('workflow:error', JSON.parse(e.data)); });
  es.addEventListener('schedule:fired', e => { window.handleWorkflowEvent?.('schedule:fired', JSON.parse(e.data)); });
  es.addEventListener('schedule:update', e => { window.handleWorkflowEvent?.('schedule:update', JSON.parse(e.data)); });
  es.addEventListener('schedule:error', e => { window.handleWorkflowEvent?.('schedule:error', JSON.parse(e.data)); });
  es.addEventListener('agent:start', e => { window.handleAgentEvent?.('agent:start', JSON.parse(e.data)); });
  es.addEventListener('agent:thinking', e => { window.handleAgentEvent?.('agent:thinking', JSON.parse(e.data)); });
  es.addEventListener('agent:thinking-text', e => { window.handleAgentEvent?.('agent:thinking-text', JSON.parse(e.data)); });
  es.addEventListener('agent:step', e => { window.handleAgentEvent?.('agent:step', JSON.parse(e.data)); });
  es.addEventListener('agent:tool', e => { window.handleAgentEvent?.('agent:tool', JSON.parse(e.data)); });
  es.addEventListener('agent:tool-result', e => { window.handleAgentEvent?.('agent:tool-result', JSON.parse(e.data)); });
  es.addEventListener('agent:response', e => { window.handleAgentEvent?.('agent:response', JSON.parse(e.data)); });
  es.addEventListener('agent:done', e => { window.handleAgentEvent?.('agent:done', JSON.parse(e.data)); });
  es.addEventListener('agent:error', e => { window.handleAgentEvent?.('agent:error', JSON.parse(e.data)); });
  es.addEventListener('agent:streaming', e => { window.handleAgentEvent?.('agent:streaming', JSON.parse(e.data)); });
  es.addEventListener('agent:warning', e => { window.handleAgentEvent?.('agent:warning', JSON.parse(e.data)); });
  es.addEventListener('agent:edit-backup', e => { window.handleAgentEvent?.('agent:edit-backup', JSON.parse(e.data)); });
  // Forge events
  es.addEventListener('forge:start', e => { window.handleForgeEvent?.('forge:start', JSON.parse(e.data)); });
  es.addEventListener('forge:log', e => { window.handleForgeEvent?.('forge:log', JSON.parse(e.data)); });
  es.addEventListener('forge:phase', e => { window.handleForgeEvent?.('forge:phase', JSON.parse(e.data)); });
  es.addEventListener('forge:cost', e => { window.handleForgeEvent?.('forge:cost', JSON.parse(e.data)); });
  es.addEventListener('forge:done', e => { window.handleForgeEvent?.('forge:done', JSON.parse(e.data)); });
  es.addEventListener('forge:error', e => { window.handleForgeEvent?.('forge:error', JSON.parse(e.data)); });
  es.addEventListener('forge:stopped', e => { window.handleForgeEvent?.('forge:stopped', JSON.parse(e.data)); });
  es.onerror = () => {
    setConn(false);
    es.close();
    _currentES = null;
    if (_rafPending) { cancelAnimationFrame(_rafPending); _rafPending = null; }
    _dirtyCards.clear(); _statsDirty = false;
    if (app._sseConnectedAt && Date.now() - app._sseConnectedAt > 30000) app._sseBackoff = 1000;
    const jitter = Math.random() * 500;
    app._sseBackoff = Math.min(app._sseBackoff * 1.5, 10000);
    app._sseReconnTimer = setTimeout(connectSSE, app._sseBackoff + jitter);
  };
}

function upd(id, k, v) {
  if (!app.state.projects.has(id)) app.state.projects.set(id, {});
  app.state.projects.get(id)[k] = v;
}

// ─── RAF-batched rendering: queue dirty cards, flush once per frame ───
const _dirtyCards = new Set();
let _rafPending = null;
let _statsDirty = false;

function queueRender(id) {
  _dirtyCards.add(id);
  _statsDirty = true;
  if (!_rafPending) _rafPending = requestAnimationFrame(flushRenders);
}

function queueStats() {
  _statsDirty = true;
  if (!_rafPending) _rafPending = requestAnimationFrame(flushRenders);
}

function flushRenders() {
  _rafPending = null;
  for (const id of _dirtyCards) renderCard(id);
  _dirtyCards.clear();
  if (_statsDirty) { _statsDirty = false; updateSummaryStats(); }
}

function setConn(v) {
  app.state.connected = v;
  document.getElementById('conn-dot').className = 'conn-dot' + (v ? '' : ' off');
}

// ─── Summary Stats ───
export function updateSummaryStats() {
  let active = 0, totalPrs = 0, totalUncommitted = 0;
  for (const [, p] of app.state.projects) {
    if (p.session?.state === 'busy' || p.session?.state === 'waiting') active++;
    totalPrs += p.prs?.prs?.length || 0;
    totalUncommitted += p.git?.uncommittedCount || 0;
  }
  const elActive = document.getElementById('stat-active');
  const elPrs = document.getElementById('stat-prs');
  const elUncommitted = document.getElementById('stat-uncommitted');
  const elToday = document.getElementById('stat-today');
  if (elActive) elActive.textContent = active;
  if (elPrs) elPrs.textContent = totalPrs;
  if (elUncommitted) elUncommitted.textContent = totalUncommitted;
  if (elToday && app.state.usage?.today) elToday.textContent = fmtTok(app.state.usage.today.outputTokens || 0);
  document.title = active > 0 ? `(${active}) Cockpit` : 'Cockpit';
  updateFavicon(active);
  updateTabBadges(totalUncommitted);
  renderSmartActions();
}

// ─── Smart Actions ───
export function renderSmartActions() {
  const el = document.getElementById('smart-actions');
  if (!el) return;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'sa-nav': switchView(btn.dataset.view); if (btn.dataset.extra === 'new-term') openNewTermModal(); break;
        case 'sa-conv-list': showConvList(); break;
        case 'sa-agent': toggleAgentPanel(); break;
        case 'sa-cmd-palette': toggleCommandPalette(); break;
      }
    });
  }

  const actions = [];
  const projects = app.state?.projects || new Map();
  const projectList = app.projectList || [];
  const getName = id => projectList.find(p => p.id === id)?.name || id;

  // 1. Uncommitted changes
  const uncommittedProjects = [];
  for (const [id, p] of projects) {
    const cnt = p.git?.uncommittedCount || 0;
    if (cnt > 0) uncommittedProjects.push({ id, name: getName(id), count: cnt, branch: p.git?.branch });
  }
  if (uncommittedProjects.length > 0) {
    const total = uncommittedProjects.reduce((s, p) => s + p.count, 0);
    const names = uncommittedProjects.slice(0, 2).map(p => p.name).join(', ');
    const extra = uncommittedProjects.length > 2 ? ` +${uncommittedProjects.length - 2}` : '';
    actions.push({
      type: 'warning', icon: '📝',
      title: `${total}개 파일 변경됨`,
      desc: `${names}${extra}`,
      label: 'Changes', saAction: 'sa-nav', saView: 'diff'
    });
  }

  // 2. Active sessions
  const activeSessions = [];
  for (const [id, p] of projects) {
    if (p.session?.state === 'busy') activeSessions.push({ id, name: getName(id), model: p.session.model });
    else if (p.session?.state === 'waiting') activeSessions.push({ id, name: getName(id), model: p.session.model, waiting: true });
  }
  if (activeSessions.length > 0) {
    const busy = activeSessions.filter(s => !s.waiting).length;
    const waiting = activeSessions.filter(s => s.waiting).length;
    const parts = [];
    if (busy) parts.push(`${busy} working`);
    if (waiting) parts.push(`${waiting} waiting`);
    actions.push({
      type: 'info', icon: '🤖',
      title: `${activeSessions.length}개 세션 활성`,
      desc: parts.join(', '),
      label: 'Sessions', saAction: 'sa-conv-list'
    });
  }

  // 3. Open PRs
  const allPrs = [];
  for (const [id, p] of projects) {
    for (const pr of (p.prs?.prs || [])) {
      allPrs.push({ ...pr, project: getName(id) });
    }
  }
  const needsReview = allPrs.filter(pr => pr.reviewDecision === 'CHANGES_REQUESTED');
  const approved = allPrs.filter(pr => pr.reviewDecision === 'APPROVED');
  if (needsReview.length > 0) {
    actions.push({
      type: 'danger', icon: '🔴',
      title: `PR ${needsReview.length}개 수정 요청`,
      desc: needsReview.slice(0, 2).map(pr => `#${pr.number} ${pr.project}`).join(', '),
      label: 'View', saAction: 'sa-nav', saView: 'diff'
    });
  } else if (approved.length > 0) {
    actions.push({
      type: 'success', icon: '✅',
      title: `PR ${approved.length}개 승인됨`,
      desc: approved.slice(0, 2).map(pr => `#${pr.number}`).join(', '),
      label: 'Merge', saAction: 'sa-nav', saView: 'diff'
    });
  } else if (allPrs.length > 0) {
    actions.push({
      type: 'info', icon: '🔵',
      title: `PR ${allPrs.length}개 오픈`,
      desc: allPrs.slice(0, 2).map(pr => `#${pr.number} ${pr.project}`).join(', '),
      label: 'View', saAction: 'sa-nav', saView: 'diff'
    });
  }

  // 4. Usage today
  const usage = app.state?.usage?.today;
  if (usage && usage.outputTokens > 0) {
    const cost = typeof usage.apiEquivCost === 'number' ? `$${usage.apiEquivCost.toFixed(2)}` : '';
    actions.push({
      type: 'neutral', icon: '📊',
      title: `오늘 ${fmtTok(usage.outputTokens)} tokens`,
      desc: `${usage.messages || 0} msgs · ${usage.sessions || 0} sessions${cost ? ' · ' + cost : ''}`,
      label: ''
    });
  }

  // 5. No actions — all clear
  if (actions.length === 0) {
    el.innerHTML = `<div class="sa-empty">
      <span class="sa-empty-icon">👋</span>
      <span class="sa-empty-text">모든 프로젝트 상태 정상</span>
      <div class="sa-quick-links">
        <button class="sa-link" data-action="sa-nav" data-view="terminal" data-extra="new-term">Terminal</button>
        <button class="sa-link" data-action="sa-nav" data-view="diff">Changes</button>
        <button class="sa-link" data-action="sa-nav" data-view="jira">Jira</button>
        <button class="sa-link" data-action="sa-agent">Agent</button>
        <button class="sa-link" data-action="sa-cmd-palette">Commands <kbd>Ctrl+K</kbd></button>
      </div>
    </div>`;
    return;
  }

  el.innerHTML = actions.map(a => `<div class="sa-card sa-${a.type}">
    <span class="sa-icon">${a.icon}</span>
    <div class="sa-body">
      <div class="sa-title">${esc(a.title)}</div>
      <div class="sa-desc">${esc(a.desc)}</div>
    </div>
    ${a.label ? `<button class="sa-action" data-action="${a.saAction}"${a.saView ? ` data-view="${a.saView}"` : ''}>${a.label}</button>` : ''}
  </div>`).join('');
}

// ─── Tab Badges ───
export function updateTabBadges(uncommitted) {
  const termTab = document.querySelector('.nav-tab[aria-controls="terminal-view"]');
  const diffTab = document.querySelector('.nav-tab[aria-controls="diff-view"]');
  if (termTab) {
    const count = app.termMap?.size || 0;
    let badge = termTab.querySelector('.tab-badge');
    if (count > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge'; termTab.appendChild(badge); }
      badge.textContent = count;
    } else if (badge) { badge.remove(); }
  }
  if (diffTab) {
    let badge = diffTab.querySelector('.tab-badge');
    if (uncommitted > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge warn'; diffTab.appendChild(badge); }
      badge.textContent = uncommitted;
    } else if (badge) { badge.remove(); }
  }
}

// ─── Dynamic Favicon ───
function updateFavicon(activeCount) {
  if (!app._faviconLink) {
    app._faviconLink = document.querySelector('link[rel="icon"]');
    if (!app._faviconLink) {
      app._faviconLink = document.createElement('link');
      app._faviconLink.rel = 'icon';
      app._faviconLink.type = 'image/svg+xml';
      document.head.appendChild(app._faviconLink);
    }
  }
  const color = activeCount > 0 ? '%2334d399' : '%23818cf8';
  app._faviconLink.href = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="${color}"/>${activeCount > 0 ? `<text x="50" y="68" text-anchor="middle" font-size="50" font-weight="bold" fill="white">${activeCount}</text>` : '<path d="M35 50L45 60L65 40" stroke="white" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>`;
}

// ─── View Switching ───
export function switchView(name) {
  // Agent is now a floating panel, not a tab view
  if (name === 'agent') { window.toggleAgentPanel?.(); return; }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`)?.classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  const activeTab = document.querySelector(`.nav-tab[aria-controls="${name}-view"]`);
  if (activeTab) { activeTab.classList.add('active'); activeTab.setAttribute('aria-selected', 'true'); }
  setupNavOverflow();
  const safeInit = (fn) => { try { const r = fn(); if (r?.catch) r.catch(e => console.error('[View]', name, e)); } catch (e) { console.error('[View]', name, e); } };
  if (name === 'terminal') { safeInit(() => window.renderLayout?.()); setTimeout(() => window.fitAllTerminals?.(), 200); }
  if (name === 'diff') safeInit(() => window.loadDiff?.());
  if (name === 'pr') safeInit(() => window.initPR?.());
  if (name === 'jira') safeInit(() => window.initJira?.());
  if (name === 'cicd') safeInit(() => window.initCicd?.());
  if (name === 'notes') safeInit(() => window.initNotes?.());
  if (name === 'workflows') safeInit(() => window.initWorkflows?.());
  if (name === 'forge') safeInit(() => window.initForge?.());
  if (name === 'logs') safeInit(() => window.initLogs?.());
  if (name === 'monitor') safeInit(() => window.initMonitor?.());
  if (name === 'ports') safeInit(() => window.initPorts?.());
  if (name === 'api-tester') safeInit(() => window.initApiTester?.());
  try { localStorage.setItem('dl-view', name); } catch {}
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
      devBtn.title = proj.devCmd + (hasPort ? ` → localhost:${dsInfo.port}` : '');
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
        case 'edit-project': editProject(id); break;
        case 'toggle-pin': togglePin(id); break;
        case 'open-term': openTermWith(id, el.dataset.cmd); break;
        case 'resume-last': resumeLastSession(id); break;
        case 'toggle-dev': toggleDevServer(id); break;
        case 'prompt-dev': promptDevCmd(id); break;
        case 'open-ide': openIDE(id, el.dataset.ide); break;
        case 'open-browser': openInFirefoxDev(id); break;
        case 'open-github': openGitHub(id); break;
        case 'session-history': showSessionHistory(id); break;
        case 'git-log': showGitLog(id); break;
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
      .then(() => showToast(`Firefox Dev → localhost:${dsInfo.port}`))
      .catch(() => showToast('Failed to open', 'error'));
  } else {
    const input = prompt('No dev server running. Enter URL to open in Firefox Developer Edition:', 'http://localhost:3000');
    if (input) {
      postJson('/api/open-url', { url: input, browser: 'firefox-dev' })
        .then(() => showToast(`Firefox Dev → ${input}`))
        .catch(() => showToast('Failed to open', 'error'));
    }
  }
}

export function renderSkeletons(count) {
  document.getElementById('project-grid').innerHTML = Array(count).fill('<div class="skeleton skeleton-card"></div>').join('');
}

// ─── Charts ───
export function setChartPeriod(days) {
  app.chartPeriod = days;
  localStorage.setItem('dl-chart-period', days);
  document.querySelectorAll('.chart-period button').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === days));
  const lbl = document.getElementById('chart-period-label');
  if (lbl) lbl.textContent = `(${days}d)`;
  renderCosts();
}

let _chartLoading = false;
let _chartLoaded = typeof Chart !== 'undefined';

function ensureChartJS() {
  if (_chartLoaded) return Promise.resolve();
  if (_chartLoading) return _chartLoading;
  _chartLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/chart.min.js';
    s.onload = () => { _chartLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _chartLoading;
}

export function renderCosts() {
  const u = app.state.usage;
  if (!u?.daily) return;
  if (!_chartLoaded) { ensureChartJS().then(() => renderCosts()); return; }
  const allDaily = u.daily;
  const daily = allDaily.slice(-app.chartPeriod);
  const labels = daily.map(d => d.date?.slice(5) || '');
  const tokens = daily.map(d => d.outputTokens || 0);
  const chartColors = { line: '#818cf8', fill: 'rgba(129,140,248,.08)', grid: 'rgba(255,255,255,.03)', tick: '#565868' };
  if (app.dailyChart) {
    app.dailyChart.data.labels = labels;
    app.dailyChart.data.datasets[0].data = tokens;
    app.dailyChart.update('none');
  } else {
    app.dailyChart = new Chart(document.getElementById('daily-chart'), {
      type: 'line',
      data: { labels, datasets: [{ data: tokens, borderColor: chartColors.line, backgroundColor: chartColors.fill, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 1.5, pointHoverRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: chartColors.tick, font: { size: 9 } }, grid: { color: chartColors.grid } }, y: { ticks: { color: chartColors.tick, callback: v => fmtTok(v), font: { size: 9 } }, grid: { color: chartColors.grid } } } },
    });
  }
  const mm = {};
  daily.forEach(d => (d.modelBreakdowns || []).forEach(m => { const n = m.modelName || '?'; mm[n] = (mm[n] || 0) + (m.outputTokens || 0); }));
  if (app.modelChart) {
    app.modelChart.data.labels = Object.keys(mm);
    app.modelChart.data.datasets[0].data = Object.values(mm);
    app.modelChart.update('none');
  } else {
    app.modelChart = new Chart(document.getElementById('model-chart'), {
      type: 'doughnut',
      data: { labels: Object.keys(mm), datasets: [{ data: Object.values(mm), backgroundColor: ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#60a5fa'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: '#9395a5', font: { size: 10 }, padding: 8 } } }, tooltip: { callbacks: { label: ctx => fmtTok(ctx.raw) + ' tok' } } },
    });
  }
}

// ─── Usage Dashboard ───
export function fetchUsage() {
  fetchJson('/api/usage').then(data => {
    app.state.usage = data;
    app._usageLastUpdated = Date.now();
    app._usageRetryCount = 0;
    renderUsage();
    renderCosts();
    updateUsageTimestamp();
  }).catch(err => {
    app._usageRetryCount++;
    if (app._usageRetryCount <= 3) {
      console.warn(`[Usage] Retry ${app._usageRetryCount}/3: ${err.message}`);
      setTimeout(fetchUsage, 5000 * app._usageRetryCount);
    }
    updateUsageTimestamp();
  });
}

export function renderUsage() {
  const u = app.state.usage;
  if (!u) return;
  const t = u.today || {};
  const w = u.week || {};
  const $ = id => document.getElementById(id);
  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  const setHtml = (id, val) => { const e = $(id); if (e) e.innerHTML = val; };
  set('today-output', fmtTok(t.outputTokens || 0));
  set('today-msgs', t.messages || 0);
  set('stat-today', fmtTok(t.outputTokens || 0));
  set('uc-today-date', t.date || '');
  set('uc-today-output', fmtTok(t.outputTokens || 0) + ' tok');
  setHtml('uc-today-stats', [row('Messages', t.messages || 0), row('Sessions', t.sessions || 0), row('Tool Calls', t.toolCalls || 0)].join(''));
  const todayModels = t.models || {};
  const totalOut = t.outputTokens || 1;
  const mEntries = Object.entries(todayModels).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  setHtml('uc-today-models', mEntries.length ? mEntries.map(([name, m]) => { const pct = ((m.outputTokens || 0) / totalOut * 100).toFixed(1); return `<div class="uc-model-row"><span class="name">${esc(name)}</span><span class="val">${fmtTok(m.outputTokens || 0)}<span class="pct">(${pct}%)</span></span></div>`; }).join('') : '');
  set('uc-today-cost', `API Equiv. ~$${(t.apiEquivCost || 0).toFixed(2)}`);
  set('uc-week-output', fmtTok(w.outputTokens || 0) + ' tok');
  if (w.resetAt) set('uc-week-reset', `resets ${timeUntil(w.resetAt)}`);
  setHtml('uc-week-stats', [row('Messages', w.messages || 0)].join(''));
  const weekModels = w.models || {};
  const wmEntries = Object.entries(weekModels).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  setHtml('uc-week-models', wmEntries.length ? wmEntries.map(([name, m]) => `<div class="uc-model-row"><span class="name">${esc(name)}</span><span class="val">${fmtTok(m.outputTokens || 0)}</span></div>`).join('') : '');
  set('uc-week-cost', `API Equiv. ~$${(w.apiEquivCost || 0).toFixed(2)}`);
  setHtml('uc-overview-stats', [row('Total Sessions', t.sessions || 0), row('Cache Read', fmtTok(t.cacheReadTokens || 0) + ' tok'), row('Cache Write', fmtTok(t.cacheCreationTokens || 0) + ' tok'), row('Input Tokens', fmtTok(t.inputTokens || 0))].join(''));
  const daily = u.daily || [];
  const allTimeCost = daily.reduce((s, d) => s + (d.totalCost || 0), 0);
  set('uc-plan-info', `30-day API equiv: ~$${allTimeCost.toFixed(2)}`);
}

export function updateUsageTimestamp() {
  let el = document.getElementById('usage-last-updated');
  if (!el) {
    const container = document.querySelector('.usage-section .section-header') || document.querySelector('.usage-grid');
    if (container) {
      el = document.createElement('span');
      el.id = 'usage-last-updated';
      el.style.cssText = 'font-size:.7rem;color:var(--text-3);margin-left:auto;cursor:pointer';
      el.title = 'Click to refresh';
      el.addEventListener('click', () => fetchUsage());
      container.appendChild(el);
    }
  }
  if (el) {
    if (app._usageLastUpdated) {
      const ago = Math.round((Date.now() - app._usageLastUpdated) / 1000);
      el.textContent = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      el.style.color = ago > 300 ? 'var(--yellow)' : 'var(--text-3)';
    } else if (app._usageRetryCount > 0) {
      el.textContent = `error (retry ${app._usageRetryCount})`;
      el.style.color = 'var(--red)';
    }
  }
}

// ─── Recent Conversations ───
export async function showConvList() {
  const overlay = document.getElementById('conv-overlay');
  if (!overlay.dataset.delegated) {
    overlay.dataset.delegated = '1';
    overlay.addEventListener('click', e => {
      const el = e.target.closest('[data-action="open-conv"]');
      if (el) { closeConvList(); openTermWith(el.dataset.pid, 'claude --continue'); }
    });
  }
  const body = document.getElementById('conv-body');
  body.innerHTML = '<div class="conv-empty">Loading...</div>';
  overlay.classList.remove('hidden');
  try {
    const data = await fetchJson('/api/activity');
    if (!data.length) { body.innerHTML = '<div class="conv-empty">No recent conversations</div>'; return; }
    let html = '', lastDate = '';
    for (const e of data) {
      const d = e.timestamp?.slice(0, 10) || '';
      if (d !== lastDate) {
        const label = d === new Date().toISOString().slice(0, 10) ? 'Today' : d === new Date(Date.now() - 86400000).toISOString().slice(0, 10) ? 'Yesterday' : d;
        html += `<div class="conv-group-date">${label}</div>`;
        lastDate = d;
      }
      const msg = (e.command || '').replace(/\[Pasted text[^\]]*\]\s*/g, '').trim() || '(no message)';
      const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      const proj = app.projectList.find(p => e.projectPath && p.path.replace(/\\/g, '/').toLowerCase() === e.projectPath.toLowerCase());
      const pid = proj ? proj.id : '';
      html += `<div class="conv-item${pid ? ' clickable' : ''}" ${pid ? `data-action="open-conv" data-pid="${pid}" style="cursor:pointer" title="Open terminal with --continue"` : ''}>
        <span class="conv-project" title="${esc(e.projectPath || '')}">${esc(e.project || '?')}</span>
        <div class="conv-info">
          <div class="conv-msg" title="${esc(msg)}">${esc(msg)}</div>
          <div class="conv-time">${time}</div>
        </div>
      </div>`;
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="conv-empty">Error: ${esc(err.message)}</div>`;
  }
}

export function closeConvList() {
  document.getElementById('conv-overlay').classList.add('hidden');
}

// ─── Theme Toggle ───
export function applyTheme(theme) {
  app.currentTheme = theme;
  document.body.classList.toggle('light-theme', theme === 'light');
  document.getElementById('theme-icon-dark').style.display = theme === 'dark' ? '' : 'none';
  document.getElementById('theme-icon-light').style.display = theme === 'light' ? '' : 'none';
}

export function toggleTheme() {
  app._themeManual = true;
  applyTheme(app.currentTheme === 'dark' ? 'light' : 'dark');
  localStorage.setItem('dl-theme', app.currentTheme);
  window.updateTermTheme?.();
  showToast(`${app.currentTheme === 'light' ? 'Light' : 'Dark'} theme`, 'info');
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

// ─── Notification Toggle ───
export function toggleNotifications() {
  app.notifyEnabled = !app.notifyEnabled;
  localStorage.setItem('dl-notify', app.notifyEnabled);
  const btn = document.getElementById('notify-toggle');
  if (btn) {
    btn.textContent = app.notifyEnabled ? 'On' : 'Off';
    btn.className = 'btn' + (app.notifyEnabled ? '' : ' off-btn');
  }
  showToast(app.notifyEnabled ? 'Notifications enabled' : 'Notifications disabled', 'info');
  postJson('/api/notify/toggle', { enabled: app.notifyEnabled }).catch(() => {});
}

// ─── Notification Filter (per-project) ───
export function isNotifEnabledForProject(projectId) {
  return app._notifFilter[projectId] !== false;
}

export function saveNotifFilter() {
  localStorage.setItem('dl-notif-filter', JSON.stringify(app._notifFilter));
}

export function toggleProjectNotif(projectId) {
  app._notifFilter[projectId] = !isNotifEnabledForProject(projectId);
  saveNotifFilter();
  window.renderNotifFilterList?.();
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
  try { return JSON.parse(localStorage.getItem(TAG_KEY) || '{}'); } catch { return {}; }
}

export function setProjectTag(projectId, tag) {
  const tags = getProjectTags();
  if (tag) tags[projectId] = tag; else delete tags[projectId];
  try { localStorage.setItem(TAG_KEY, JSON.stringify(tags)); } catch {}
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

export async function fetchAllProjects() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Fetching...';
  let ok = 0, fail = 0;
  const total = app.projectList.length;
  const update = () => { btn.textContent = `Fetching... ${ok + fail}/${total}`; };
  const promises = app.projectList.map(p => postJson(`/api/projects/${p.id}/fetch`, {}).then(d => { if (d.error) fail++; else ok++; update(); }).catch(() => { fail++; update(); }));
  await Promise.all(promises);
  btn.disabled = false;
  btn.textContent = 'Fetch All';
  showToast(`Fetch All: ${ok} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
}

export async function pullAllProjects() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Pulling...';
  let ok = 0, fail = 0;
  const total = app.projectList.length;
  const update = () => { btn.textContent = `Pulling... ${ok + fail}/${total}`; };
  const promises = app.projectList.map(p => postJson(`/api/projects/${p.id}/pull`, {}).then(d => { if (d.error) fail++; else ok++; update(); }).catch(() => { fail++; update(); }));
  await Promise.all(promises);
  btn.disabled = false;
  btn.textContent = 'Pull All';
  showToast(`Pull All: ${ok} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
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
  switchView('diff');
  const sel = document.getElementById('diff-project');
  if (sel) { sel.value = projectId; window.loadDiff?.(); }
}

// ─── Adaptive Polling ───
export function onVisibilityChange() {
  if (document.hidden) {
    clearInterval(app._clockTimer); app._clockTimer = null;
    if (app.usageTimer) { clearInterval(app.usageTimer); app.usageTimer = null; }
  } else {
    if (!app._clockTimer) app._clockTimer = setInterval(updateClock, 1000);
    updateClock();
    if (!app.usageTimer) app.usageTimer = setInterval(fetchUsage, 60000);
  }
  postJson('/api/polling-speed', { multiplier: document.hidden ? 5 : 1 }).catch(() => {});
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

// ─── Tab Overflow "More" Dropdown ───
const OVERFLOW_THRESHOLD = 5; // Show first N tabs, rest go into More

export function setupNavOverflow() {
  const wrap = document.getElementById('nav-more-wrap');
  if (!wrap) return;
  const tabs = document.querySelectorAll('.nav-tabs > .nav-tab');
  const menu = document.getElementById('nav-more-menu');
  if (!menu) return;
  menu.innerHTML = '';
  tabs.forEach((tab, i) => {
    if (i >= OVERFLOW_THRESHOLD) {
      tab.classList.add('overflow-hidden');
      const item = document.createElement('button');
      item.className = 'nav-more-item' + (tab.classList.contains('active') ? ' active' : '');
      item.innerHTML = tab.querySelector('svg')?.outerHTML + '<span>' + (tab.querySelector('.tab-label')?.textContent || tab.textContent.trim()) + '</span>';
      item.onclick = () => { tab.click(); closeNavMore(); };
      menu.appendChild(item);
    } else {
      tab.classList.remove('overflow-hidden');
    }
  });
  // Show More btn highlight if any overflow tab is active
  const moreBtn = document.getElementById('nav-more-btn');
  const anyActive = [...tabs].slice(OVERFLOW_THRESHOLD).some(t => t.classList.contains('active'));
  if (moreBtn) moreBtn.classList.toggle('active', anyActive);

  // Add Settings item (visible on mobile where header-right is hidden)
  if (window.matchMedia('(max-width: 600px)').matches) {
    const divider = document.createElement('div');
    divider.className = 'nav-more-divider';
    menu.appendChild(divider);
    const settingsItem = document.createElement('button');
    settingsItem.className = 'nav-more-item';
    settingsItem.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg><span>Settings</span>';
    settingsItem.onclick = () => { document.querySelector('[data-action="open-settings"]')?.click(); closeNavMore(); };
    menu.appendChild(settingsItem);
  }
}

export function toggleNavMore() {
  const menu = document.getElementById('nav-more-menu');
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  if (!isOpen) {
    // Update active states in menu
    const tabs = document.querySelectorAll('.nav-tabs > .nav-tab');
    const items = menu.querySelectorAll('.nav-more-item');
    let idx = 0;
    tabs.forEach((tab, i) => {
      if (i >= OVERFLOW_THRESHOLD && items[idx]) {
        items[idx].classList.toggle('active', tab.classList.contains('active'));
        idx++;
      }
    });
    // Close on outside click
    setTimeout(() => {
      const handler = (e) => { if (!menu.contains(e.target) && e.target.id !== 'nav-more-btn') { closeNavMore(); document.removeEventListener('click', handler); } };
      document.addEventListener('click', handler);
    }, 0);
  }
}

function closeNavMore() {
  const menu = document.getElementById('nav-more-menu');
  if (menu) menu.classList.remove('open');
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

// ──────────── Phase 1: Session Timeline ────────────

export async function showSessionTimeline(projectId, sessionId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal timeline-modal"><div class="modal-header"><h3>Session Timeline</h3><button class="modal-close" data-action="close-overlay">&times;</button></div><div class="modal-body"><div class="timeline-loading">Loading timeline...</div></div></div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-action="close-overlay"]')) overlay.remove();
  });
  document.body.appendChild(overlay);

  try {
    const data = await fetchJson(`/api/projects/${projectId}/sessions/${sessionId}/timeline`);
    if (data.error) throw new Error(data.error);

    const body = overlay.querySelector('.modal-body');
    const s = data.summary;
    const events = data.events || [];

    body.innerHTML = `
      <div class="tl-summary">
        <div class="tl-sum-row"><span>Model</span><span>${esc(s?.model || '-')}</span></div>
        <div class="tl-sum-row"><span>Messages</span><span>${s?.messageCount || 0}</span></div>
        <div class="tl-sum-row"><span>Tokens</span><span>${formatK(s?.tokens?.input || 0)} in / ${formatK(s?.tokens?.output || 0)} out</span></div>
        <div class="tl-sum-row"><span>Cost</span><span>$${(s?.cost || 0).toFixed(2)}</span></div>
        ${s?.filesChanged?.length ? `<div class="tl-files"><strong>Files Changed:</strong> ${s.filesChanged.map(f => `<span class="tl-file">${esc(f.path)}</span>`).join(', ')}</div>` : ''}
      </div>
      <div class="tl-events">
        ${events.length === 0 ? '<div class="tl-empty">No tool events in this session</div>' : events.map(ev => {
          const time = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          const icon = { Read: '📄', Edit: '✏️', Write: '📝', Bash: '⚡', Grep: '🔍', Glob: '📂', Task: '🤖', commit: '📦' }[ev.name || ev.type] || '🔧';
          return `<div class="tl-event"><span class="tl-time">${time}</span><span class="tl-icon">${icon}</span><span class="tl-name">${esc(ev.name || ev.type)}</span><span class="tl-detail">${esc((ev.detail || '').slice(0, 100))}</span></div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML = `<div class="tl-error">Error: ${esc(err.message)}</div>`;
  }
}

function formatK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n; }

// ──────────── Phase 3: Morning Briefing Banner ────────────

export async function loadBriefing() {
  const banner = document.getElementById('briefing-banner');
  if (!banner) return;
  if (!banner.dataset.delegated) {
    banner.dataset.delegated = '1';
    banner.addEventListener('click', e => {
      if (e.target.closest('[data-action="toggle-briefing"]')) banner.classList.toggle('collapsed');
    });
  }

  try {
    const data = await fetchJson('/api/briefing');
    if (!data || data.items?.length === 0) { banner.style.display = 'none'; return; }

    banner.style.display = '';
    banner.innerHTML = `
      <div class="briefing-header" data-action="toggle-briefing">
        <span class="briefing-icon">☀️</span>
        <span class="briefing-title">Morning Briefing</span>
        <span class="briefing-meta">${data.attentionCount || 0} need attention · $${(data.cost?.today || 0).toFixed(2)} today · ${data.totalProjects} projects</span>
        <span class="briefing-toggle">▼</span>
      </div>
      <div class="briefing-body">
        ${data.items.map(item => `
          <div class="briefing-item ${item.needsAttention ? 'attention' : ''}">
            <span class="briefing-proj">${esc(item.projectId)}</span>
            <span class="briefing-changes">${item.changes.map(c => esc(c)).join(' · ')}</span>
          </div>
        `).join('')}
        <div class="briefing-cost">
          Yesterday: $${(data.cost?.yesterday || 0).toFixed(2)} · Weekly: $${(data.cost?.weekly || 0).toFixed(2)}
        </div>
      </div>`;
  } catch {
    banner.style.display = 'none';
  }
}

// ──────────── Phase 2: Smart Alerts ────────────

export async function checkSmartAlerts() {
  try {
    const alerts = await fetchJson('/api/alerts');
    if (!Array.isArray(alerts) || alerts.length === 0) return;

    const prefs = await fetchJson('/api/alerts/prefs');
    if (!prefs.enabled) return;
    const disabled = new Set(prefs.disabledProjects || []);

    for (const alert of alerts) {
      if (disabled.has(alert.projectId)) continue;
      if (alert.level === 'urgent') {
        showToast(`🔴 ${alert.message}`, 8000);
        playNotifSound();
      } else {
        showToast(alert.message, 4000);
      }
    }
  } catch {}
}

// ──────────── Phase 5: Batch Commands ────────────

export async function showBatchModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal batch-modal"><div class="modal-header"><h3>Batch Commands</h3><button class="modal-close" data-action="close-overlay">&times;</button></div><div class="modal-body"><div class="batch-loading">Loading...</div></div></div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { overlay.remove(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'close-overlay': overlay.remove(); break;
      case 'batch-all': toggleBatchAll(true); break;
      case 'batch-none': toggleBatchAll(false); break;
      case 'batch-cancel': overlay.remove(); break;
      case 'batch-execute': executeBatchCmd(); break;
    }
  });
  document.body.appendChild(overlay);

  try {
    const whitelist = await fetchJson('/api/batch/whitelist');
    const projects = app.projectList || [];

    overlay.querySelector('.modal-body').innerHTML = `
      <div class="batch-form">
        <div class="batch-field">
          <label>Command</label>
          <select id="batch-command">${whitelist.map(c => `<option value="${esc(c.id)}">${esc(c.label)} (${c.category})</option>`).join('')}</select>
        </div>
        <div class="batch-field">
          <label>Projects <button class="btn-sm" data-action="batch-all">All</button> <button class="btn-sm" data-action="batch-none">None</button></label>
          <div class="batch-project-list" id="batch-project-list">
            ${projects.map(p => `<label class="batch-proj-item"><input type="checkbox" value="${esc(p.id)}" checked> ${esc(p.name)}</label>`).join('')}
          </div>
        </div>
        <div class="batch-field">
          <label><input type="checkbox" id="batch-parallel"> Parallel execution (max 3 concurrent)</label>
        </div>
        <div class="batch-actions">
          <button class="btn" data-action="batch-cancel">Cancel</button>
          <button class="btn primary" data-action="batch-execute">Execute</button>
        </div>
      </div>
      <div id="batch-results" class="batch-results" style="display:none"></div>`;
  } catch (err) {
    overlay.querySelector('.modal-body').innerHTML = `<div class="batch-error">Error: ${esc(err.message)}</div>`;
  }
}

export function toggleBatchAll(checked) {
  document.querySelectorAll('#batch-project-list input[type="checkbox"]').forEach(cb => cb.checked = checked);
}

export async function executeBatchCmd() {
  const commandId = document.getElementById('batch-command')?.value;
  const projectIds = [...document.querySelectorAll('#batch-project-list input:checked')].map(cb => cb.value);
  const parallel = document.getElementById('batch-parallel')?.checked;

  if (projectIds.length === 0) return showToast('Select at least one project');

  const resultsEl = document.getElementById('batch-results');
  if (resultsEl) {
    resultsEl.style.display = '';
    resultsEl.innerHTML = '<div class="batch-running">Executing...</div>';
  }

  try {
    const result = await postJson('/api/batch/execute', { commandId, projectIds, parallel });

    if (result.error) throw new Error(result.error);

    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="batch-summary">${result.success}/${result.total} succeeded</div>
        ${(result.results || []).map(r => `
          <div class="batch-result-item ${r.status}">
            <span class="batch-result-icon">${r.status === 'success' ? '✅' : '❌'}</span>
            <span class="batch-result-name">${esc(r.projectName)}</span>
            <span class="batch-result-time">${r.duration}ms</span>
            <pre class="batch-result-output">${esc((r.output || '').slice(0, 500))}</pre>
          </div>
        `).join('')}`;
    }
  } catch (err) {
    if (resultsEl) resultsEl.innerHTML = `<div class="batch-error">Error: ${esc(err.message)}</div>`;
  }
}

// ─── Action Registration ───
registerClickActions({
  'switch-view': (el) => switchView(el.dataset.view),
  'toggle-nav-more': toggleNavMore,
  'toggle-notifications': toggleNotifications,
  'toggle-theme': toggleTheme,
  'set-project-filter': (el) => setProjectFilter(el.dataset.filterVal),
  'set-chart-period': (el) => setChartPeriod(Number(el.dataset.period)),
  'toggle-activity-log': () => document.getElementById('activity-log-list')?.classList.toggle('collapsed'),
  'close-conv-overlay': (el, e) => { if (e.target === el) closeConvList(); },
  'close-conv-list': closeConvList,
});
registerChangeActions({
  'set-project-sort': (el) => setProjectSort(el.value),
});
registerInputActions({
  'filter-projects': filterProjects,
});
