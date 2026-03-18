// ─── Forge Module: Redesigned Two-Panel UI ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson } from './utils.js';

const ROLE_ICONS = {
  builder: '⚛️', attacker: '⚔️', system: '🔧',
  'verify:tsc': '📋', 'verify:build': '🏗️', 'verify:eslint': '🔍',
  'verify:knip': '✂️', 'verify:audit': '🛡️', 'verify:attacker': '⚔️',
};
const ROLE_COLORS = {
  builder: '#10B981', attacker: '#F59E0B', system: '#6B7280',
  'verify:tsc': '#3B82F6', 'verify:build': '#3B82F6', 'verify:eslint': '#8B5CF6',
  'verify:knip': '#8B5CF6', 'verify:audit': '#EF4444', 'verify:attacker': '#F59E0B',
};
const ROLE_LABELS = {
  builder: '빌더', attacker: '보안검토', system: '시스템',
  'verify:tsc': 'TypeScript', 'verify:build': '빌드', 'verify:eslint': 'ESLint',
  'verify:knip': 'Knip', 'verify:audit': '보안감사', 'verify:attacker': '보안리뷰',
};
const PHASE_LABELS = { building: '빌드', verifying: '검증', fixing: '수정' };
const FRAMEWORK_LABELS = { generic: '일반', react: 'React', nextjs: 'Next.js', express: 'Express' };

const FORGE_MODES = {
  quick:    { mode: 'quick',    icon: '⚡', name: '빠른',   desc: 'Sonnet · 1회 검증', costLimit: 2 },
  standard: { mode: 'standard', icon: '⚙️', name: '표준',   desc: 'Opus · 2회 검증 + 보안', costLimit: 5 },
  thorough: { mode: 'thorough', icon: '🔬', name: '정밀',   desc: 'Opus · 3회 검증 + 보안 + 전체 도구', costLimit: 10 },
};

let _activeTaskId = null;
let _logAutoScroll = true;
let _selectedMode = 'standard';
let _previewPort = null;

function fmtDur(s) { if (s < 60) return `${s}초`; const m = Math.floor(s / 60), r = s % 60; return r ? `${m}분 ${r}초` : `${m}분`; }

// ─── Init ───
let _forgeInitialized = false;
export function initForge() {
  if (_forgeInitialized) return;
  _forgeInitialized = true;
  populateProjectSelector();
  registerClickActions();
}

function populateProjectSelector() {
  const sel = document.getElementById('forge-project');
  if (!sel) return;
  const projects = app.projectList || [];
  sel.innerHTML = projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}

function registerClickActions() {
  const view = document.getElementById('forge-view');
  if (!view || view.dataset.delegated) return;
  view.dataset.delegated = '1';

  view.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'forge-select-mode': selectMode(el); break;
      case 'forge-submit': submitForgeTask(); break;
      case 'forge-stop': stopForgeRun(_activeTaskId); break;
      case 'forge-apply': applyForgeResult(_activeTaskId); break;
      case 'forge-create-pr': createForgePR(_activeTaskId); break;
      case 'forge-preview-refresh': refreshPreview(); break;
      case 'forge-preview-open': openPreviewInBrowser(); break;
    }
  });
  view.addEventListener('change', e => {
    if (e.target.dataset.action === 'forge-toggle-autoscroll') {
      _logAutoScroll = e.target.checked;
    }
  });
}

function selectMode(btn) {
  document.querySelectorAll('.forge-mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _selectedMode = btn.dataset.mode;
}

// ─── Open Forge with Prefilled Data (cross-tab integration) ───
export function openForgeWithPrefill(prefill) {
  // switchView is handled by the caller
  setTimeout(() => {
    if (prefill.projectId) {
      const sel = document.getElementById('forge-project');
      if (sel) sel.value = prefill.projectId;
    }
    if (prefill.task) {
      const ta = document.getElementById('forge-task');
      if (ta) ta.value = prefill.task;
    }
    if (prefill.plan) {
      const modeMap = { quick: 'quick', standard: 'standard', quality: 'standard', max: 'thorough' };
      const mode = modeMap[prefill.plan] || 'standard';
      const btn = document.querySelector(`.forge-mode-btn[data-mode="${mode}"]`);
      if (btn) selectMode(btn);
    }
    app._forgeSource = prefill.source ? { type: prefill.source, ref: prefill.sourceRef } : null;
  }, 100);
}

// ─── Submit ───
export async function submitForgeTask() {
  const projectId = document.getElementById('forge-project')?.value;
  const task = document.getElementById('forge-task')?.value?.trim();
  if (!task) return showToast('Task description required');

  const modeConfig = FORGE_MODES[_selectedMode] || FORGE_MODES.standard;

  try {
    const result = await postJson('/api/forge/start', {
      projectId,
      task,
      referenceFiles: [],
      mode: modeConfig.mode,
      costLimit: modeConfig.costLimit,
    });

    _activeTaskId = result.taskId;
    showToast(`Forge started (${FRAMEWORK_LABELS[result.framework] || result.framework})`);
    showProgress(result);
    showBottomActions(true, false);
    clearLog();
    detectPreviewPort(projectId);
  } catch (err) {
    showToast('Forge error: ' + err.message);
  }
}

// ─── Progress UI ───
function showProgress(run) {
  const el = document.getElementById('forge-progress');
  if (el) el.style.display = '';
  updatePhaseBar(run.phase || 'design', false);
  updateStatusLine(run);
}

function updatePhaseBar(currentPhase, isDone) {
  const phases = ['design', 'build', 'verify', 'integrate'];
  const currentIdx = phases.indexOf(currentPhase);
  document.querySelectorAll('.forge-phase-step').forEach(step => {
    const phase = step.dataset.phase;
    const idx = phases.indexOf(phase);
    step.classList.remove('active', 'done', 'pending');
    if (isDone || idx < currentIdx) {
      step.classList.add('done');
    } else if (idx === currentIdx && !isDone) {
      step.classList.add('active');
    } else {
      step.classList.add('pending');
    }
  });
  // Update connectors
  document.querySelectorAll('.forge-phase-connector').forEach((conn, i) => {
    conn.classList.remove('done');
    if (isDone || i < currentIdx) conn.classList.add('done');
  });
}

function updateStatusLine(run) {
  const badge = document.getElementById('forge-status-badge');
  const cost = document.getElementById('forge-status-cost');
  const time = document.getElementById('forge-status-time');
  if (badge) {
    const status = run.status || 'running';
    const statusText = { running: '실행 중', done: '완료', failed: '실패', stopped: '중지' }[status] || status;
    badge.textContent = statusText;
    badge.className = `forge-status-badge ${status}`;
  }
  if (cost) cost.textContent = `$${((run.cost?.total || run.cost) || 0).toFixed ? ((run.cost?.total || 0)).toFixed(2) : '0.00'}`;
  if (time) {
    const duration = run.endedAt
      ? Math.round((run.endedAt - run.startedAt) / 1000)
      : Math.round((Date.now() - (run.startedAt || Date.now())) / 1000);
    time.textContent = fmtDur(duration);
  }
}

function showBottomActions(running, completed) {
  const el = document.getElementById('forge-bottom-actions');
  if (!el) return;
  el.style.display = '';
  const stopBtn = el.querySelector('[data-action="forge-stop"]');
  const applyBtn = el.querySelector('[data-action="forge-apply"]');
  const prBtn = el.querySelector('[data-action="forge-create-pr"]');
  if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  if (applyBtn) applyBtn.style.display = completed ? '' : 'none';
  if (prBtn) prBtn.style.display = completed ? '' : 'none';
}

// ─── Log ───
function clearLog() {
  const logEl = document.getElementById('forge-log');
  if (logEl) logEl.innerHTML = '';
}

function appendLogEntry(entry) {
  const logEl = document.getElementById('forge-log');
  if (!logEl) return;
  // Remove empty state if present
  const empty = logEl.querySelector('.forge-log-empty');
  if (empty) empty.remove();

  const icon = ROLE_ICONS[entry.role] || '📋';
  const color = ROLE_COLORS[entry.role] || '#888';
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const html = `<div class="forge-log-entry">
    <span class="forge-log-time">${time}</span>
    <span class="forge-log-role" style="color:${color}">${icon} ${ROLE_LABELS[entry.role] || entry.role}</span>
    <span class="forge-log-msg">${esc((entry.message || '').length > 120 ? entry.message.slice(0, 120) + '…' : entry.message)}</span>
    ${entry.detail ? `<div class="forge-log-detail">${esc((entry.detail || '').slice(0, 200))}${(entry.detail || '').length > 200 ? '…' : ''}</div>` : ''}
  </div>`;
  logEl.insertAdjacentHTML('beforeend', html);
  if (_logAutoScroll) logEl.scrollTop = logEl.scrollHeight;
}

// ─── Preview ───
async function detectPreviewPort(projectId) {
  try {
    const projects = app.projectList || [];
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    // Check devServerState for this project's port
    const devState = (app.devServerState || []).find(d => d.projectId === projectId);
    if (devState && devState.port) {
      showPreview(devState.port);
      return;
    }
    // Try common ports
    const ports = await fetchJson('/api/ports');
    const devPorts = (ports || []).filter(p => [3000, 3001, 5173, 5174, 8080, 4200].includes(p.port));
    if (devPorts.length > 0) {
      showPreview(devPorts[0].port);
    }
  } catch { /* ignore */ }
}

function showPreview(port) {
  _previewPort = port;
  const iframe = document.getElementById('forge-preview-iframe');
  const placeholder = document.getElementById('forge-preview-placeholder');
  const urlInput = document.getElementById('forge-preview-url');
  if (iframe) {
    iframe.src = `http://localhost:${port}`;
    iframe.style.display = '';
  }
  if (placeholder) placeholder.style.display = 'none';
  if (urlInput) urlInput.value = `localhost:${port}`;
}

function refreshPreview() {
  const iframe = document.getElementById('forge-preview-iframe');
  if (iframe && _previewPort) {
    iframe.src = `http://localhost:${_previewPort}`;
  }
}

function openPreviewInBrowser() {
  if (_previewPort) {
    postJson('/api/open-url', { url: `http://localhost:${_previewPort}` }).catch(() => {});
  }
}

// ─── Actions ───
export async function stopForgeRun(taskId) {
  if (!taskId) return;
  await postJson(`/api/forge/stop/${taskId}`, {});
  showToast('Forge stopped');
  showBottomActions(false, false);
}

export async function applyForgeResult(taskId) {
  if (!taskId) return;
  try {
    const result = await postJson(`/api/forge/apply/${taskId}`, {});
    const applied = result.filter(r => r.status === 'applied').length;
    showToast(`Applied ${applied} files`);
  } catch (err) {
    showToast('Apply error: ' + err.message);
  }
}

async function createForgePR(taskId) {
  if (!taskId) return;
  showToast('PR creation not yet implemented');
}

// keep old names exported for compatibility
export function showForgeNewTask(prefill = {}) { openForgeWithPrefill(prefill); }
export function selectForgePlan() {}
export function selectForgeMode() {}
export function selectForgePreset() {}
export function selectForgeBudget() {}
export function onForgeBudgetInput() {}
export function toggleForgeAutoScroll(val) { _logAutoScroll = val; }

// ─── SSE Event Handlers ───
export function handleForgeEvent(eventName, data) {
  if (eventName === 'forge:start') {
    // Refresh project selector in case things changed
    populateProjectSelector();
  } else if (eventName === 'forge:log' && data.taskId === _activeTaskId) {
    appendLogEntry(data);
  } else if (eventName === 'forge:phase' && data.taskId === _activeTaskId) {
    updatePhaseBar(data.phase, false);
  } else if (eventName === 'forge:cost' && data.taskId === _activeTaskId) {
    const costEl = document.getElementById('forge-status-cost');
    if (costEl) costEl.textContent = `$${(data.total || 0).toFixed(2)}`;
  } else if (eventName === 'forge:done' || eventName === 'forge:error' || eventName === 'forge:stopped') {
    if (data.taskId === _activeTaskId) {
      const isDone = eventName === 'forge:done';
      const isFailed = eventName === 'forge:error';
      updatePhaseBar('integrate', isDone);
      const badge = document.getElementById('forge-status-badge');
      if (badge) {
        badge.textContent = isDone ? '완료' : isFailed ? '실패' : '중지';
        badge.className = `forge-status-badge ${isDone ? 'done' : isFailed ? 'failed' : 'stopped'}`;
      }
      showBottomActions(false, isDone);
      if (_previewPort) refreshPreview();
    }
  }
}

// ─── Helpers ───
function timeAgoShort(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
