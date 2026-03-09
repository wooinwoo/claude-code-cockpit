// ─── Forge Module: Autonomous Development Engine UI ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson } from './utils.js';

const ROLE_ICONS = {
  architect: '🏗️', critic: '🔍', builder_react: '⚛️', builder_nest: '🐈',
  builder_test: '🧪', attacker: '⚔️', integrator: '🔗',
};
const ROLE_COLORS = {
  architect: '#3B82F6', critic: '#EF4444', builder_react: '#10B981', builder_nest: '#10B981',
  builder_test: '#8B5CF6', attacker: '#F59E0B', integrator: '#6366F1',
};
const PHASE_LABELS = { design: '설계', build: '빌드', verify: '검증', integrate: '통합' };
const FRAMEWORK_LABELS = { generic: '일반', nest: 'NestJS', react: 'React', fullstack: '풀스택' };
const MODE_LABELS = { quick: '빠름', balanced: '표준', thorough: '정밀' };
const ROLE_LABELS = { architect: '설계자', critic: '검증자', builder_react: '빌더(React)', builder_nest: '빌더(Nest)', builder_test: '테스터', attacker: '공격자', integrator: '통합자' };
function fmtDur(s) { if (s < 60) return `${s}초`; const m = Math.floor(s / 60), r = s % 60; return r ? `${m}분 ${r}초` : `${m}분`; }

// ─── Unified Plans: 사용자는 하나만 고르면 됨 ───
const FORGE_PLANS = [
  { id: 'quick',    mode: 'quick',    preset: 'balanced', icon: '⚡', name: 'Quick Fix',
    cost: '$0.08', costNum: 0.08, desc: 'Simple bug fix, small change', detail: 'Sonnet+Haiku · Skip design' },
  { id: 'standard', mode: 'balanced', preset: 'balanced', icon: '⚖️', name: 'Standard',
    cost: '$0.15', costNum: 0.15, desc: 'General feature development', detail: 'Sonnet+Haiku · 4 phases', recommended: true },
  { id: 'quality',  mode: 'balanced', preset: 'quality',  icon: '🔥', name: 'Quality',
    cost: '$2',    costNum: 2.00, desc: 'Complex features, high code quality', detail: 'Opus+Sonnet · 4 phases' },
  { id: 'max',      mode: 'thorough', preset: 'quality',  icon: '🎯', name: 'Maximum',
    cost: '$5',    costNum: 5.00, desc: 'Architecture design + deep verify x3', detail: 'Opus+Sonnet · 3 verify cycles' },
];

let _forgeRuns = [];
let _activeTaskId = null;
let _logAutoScroll = true;

// ─── Init ───
let _forgeInitialized = false;
export function initForge() {
  if (_forgeInitialized) return;
  _forgeInitialized = true;
  loadForgeRuns();
  renderForgeUI();
}

async function loadForgeRuns() {
  try {
    _forgeRuns = await fetchJson('/api/forge/runs');
    renderRunList();
  } catch { /* request failed */ }
}

// ─── Main Render ───
function renderForgeUI() {
  const container = document.getElementById('forge-content');
  if (!container) return;

  container.innerHTML = `
    <div class="forge-layout">
      <div class="forge-sidebar">
        <div class="forge-sidebar-header">
          <span class="forge-title">Forge</span>
          <button class="btn primary forge-new-btn" data-action="new-task">+ New</button>
        </div>
        <div id="forge-run-list" class="forge-run-list"></div>
      </div>
      <div class="forge-main" id="forge-main">
        <div class="forge-empty">
          <div class="forge-empty-icon">🔥</div>
          <div class="forge-empty-title">Forge — Autonomous Dev Engine</div>
          <div class="forge-empty-desc">Multi-agent pipeline: Design → Build → Verify → Integrate</div>
          <div class="forge-empty-hints">
            <div class="forge-empty-hint"><span class="forge-eh-icon">🏗️</span> Architect</div>
            <div class="forge-empty-hint"><span class="forge-eh-icon">⚛️</span> Builder</div>
            <div class="forge-empty-hint"><span class="forge-eh-icon">🔍</span> Verifier</div>
            <div class="forge-empty-hint"><span class="forge-eh-icon">🔗</span> Integrator</div>
          </div>
          <button class="btn primary" data-action="new-task">Start New Task</button>
        </div>
      </div>
    </div>`;
  if (!container.dataset.delegated) {
    container.dataset.delegated = '1';
    container.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'new-task': showForgeNewTask(); break;
        case 'select-run': selectForgeRun(el.dataset.taskid); break;
        case 'select-plan': selectForgePlan(el); break;
        case 'cancel': renderForgeUI(); break;
        case 'submit': submitForgeTask(); break;
        case 'stop-run': stopForgeRun(el.dataset.taskid); break;
        case 'apply-result': applyForgeResult(el.dataset.taskid); break;
      }
    });
    container.addEventListener('change', e => {
      if (e.target.dataset.action === 'toggle-autoscroll') toggleForgeAutoScroll(e.target.checked);
    });
  }
  renderRunList();
}

function renderRunList() {
  const el = document.getElementById('forge-run-list');
  if (!el) return;
  const titleEl = document.querySelector('.forge-title');
  if (titleEl) titleEl.innerHTML = `Forge${_forgeRuns.length ? ` <span class="wf-count-badge">${_forgeRuns.length}</span>` : ''}`;
  if (_forgeRuns.length === 0) {
    el.innerHTML = '<div class="forge-sidebar-empty">No runs yet</div>';
    return;
  }
  el.innerHTML = _forgeRuns.map(r => {
    const statusIcon = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'stopped' ? '⏹' : '●';
    const active = r.taskId === _activeTaskId ? ' active' : '';
    const cost = typeof r.cost === 'number' ? `$${r.cost.toFixed(2)}` : '';
    return `<div class="forge-run-item${active}" data-action="select-run" data-taskid="${esc(r.taskId)}">
      <span class="forge-run-status">${statusIcon}</span>
      <div class="forge-run-info">
        <div class="forge-run-task">${esc((r.task || '').slice(0, 50))}</div>
        <div class="forge-run-meta">${cost} · ${timeAgoShort(r.startedAt)}</div>
      </div>
    </div>`;
  }).join('');
}

// ─── New Task Form ───
export function showForgeNewTask(prefill = {}) {
  const main = document.getElementById('forge-main');
  if (!main) return;

  const projects = app.projectList || [];
  main.innerHTML = `
    <div class="forge-form">
      <h3>New Forge Task</h3>
      ${prefill.source ? `<div class="forge-source-badge">from ${esc(prefill.source === 'jira' ? 'Jira' : prefill.source === 'cicd' ? 'CI/CD' : 'Changes')}${prefill.sourceRef ? ' · ' + esc(prefill.sourceRef) : ''}</div>` : ''}
      <div class="forge-field">
        <label>Project</label>
        <select id="forge-project">${projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      </div>
      <div class="forge-field">
        <label>Task Description</label>
        <textarea id="forge-task" rows="4" placeholder="e.g. 사용자 인증 API에 JWT refresh token 로직 추가"></textarea>
      </div>
      <div class="forge-field forge-refs-field">
        <label>Reference Files <span class="forge-optional">(optional)</span></label>
        <textarea id="forge-refs" rows="2" placeholder="src/auth/auth.service.ts&#10;src/auth/auth.controller.ts"></textarea>
      </div>

      <div class="forge-field">
        <label>Plan</label>
        <div class="forge-plan-selector">
          ${FORGE_PLANS.map(p => `<button class="forge-plan-btn${p.recommended ? ' active' : ''}" data-plan="${p.id}" data-action="select-plan">
            <div class="forge-plan-top">
              <span class="forge-plan-icon">${p.icon}</span>
              <span class="forge-plan-name">${p.name}</span>
              <span class="forge-plan-cost">${p.cost}</span>
            </div>
            <div class="forge-plan-desc">${p.desc}</div>
            <div class="forge-plan-detail">${p.detail}</div>
            ${p.recommended ? '<span class="forge-plan-badge">Recommended</span>' : ''}
          </button>`).join('')}
        </div>
      </div>

      <div class="forge-actions">
        <button class="btn" data-action="cancel">Cancel</button>
        <button class="btn primary" data-action="submit">🔥 Start Forge</button>
      </div>
    </div>`;

  // Prefill fields
  if (prefill.task) document.getElementById('forge-task').value = prefill.task;
  if (prefill.referenceFiles) document.getElementById('forge-refs').value = prefill.referenceFiles;
  if (prefill.projectId) document.getElementById('forge-project').value = prefill.projectId;
  if (prefill.plan) {
    const planBtn = document.querySelector(`.forge-plan-btn[data-plan="${prefill.plan}"]`);
    if (planBtn) selectForgePlan(planBtn);
  }
  app._forgeSource = prefill.source ? { type: prefill.source, ref: prefill.sourceRef } : null;
}

// ─── Open Forge with Prefilled Data (cross-tab integration) ───
export function openForgeWithPrefill(prefill) {
  switchView('forge');
  setTimeout(() => showForgeNewTask(prefill), 100);
}

export function selectForgePlan(btn) {
  btn.parentElement.querySelectorAll('.forge-plan-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// keep old names exported but as no-ops (window registration compatibility)
export function selectForgeMode() {}
export function selectForgePreset() {}
export function selectForgeBudget() {}
export function onForgeBudgetInput() {}

function getSelectedPlan() {
  const planId = document.querySelector('.forge-plan-btn.active')?.dataset.plan || 'standard';
  return FORGE_PLANS.find(p => p.id === planId) || FORGE_PLANS[1];
}

export async function submitForgeTask() {
  const projectId = document.getElementById('forge-project')?.value;
  const task = document.getElementById('forge-task')?.value?.trim();
  if (!task) return showToast('Task description required');

  const plan = getSelectedPlan();
  const mode = plan.mode;
  const modelPreset = plan.preset;
  const costLimit = Math.max(1, Math.ceil(plan.costNum * 5)); // 자동: 예상비용 × 5
  const refsText = document.getElementById('forge-refs')?.value || '';
  const referenceFiles = refsText.split('\n').map(l => l.trim()).filter(Boolean);

  try {
    const result = await postJson('/api/forge/start', { projectId, task, referenceFiles, mode, modelPreset, costLimit });

    _activeTaskId = result.taskId;
    showToast(`Forge started (${FRAMEWORK_LABELS[result.framework] || result.framework})`);
    loadForgeRuns();
    showForgeRunView(result.taskId);
  } catch (err) {
    showToast('Forge error: ' + err.message);
  }
}

// ─── Run Detail View ───
export async function selectForgeRun(taskId) {
  _activeTaskId = taskId;
  renderRunList();
  showForgeRunView(taskId);
}

async function showForgeRunView(taskId) {
  const main = document.getElementById('forge-main');
  if (!main) return;

  let run;
  try {
    run = await fetchJson(`/api/forge/runs/${taskId}`);
  } catch (err) {
    main.innerHTML = `<div class="forge-empty">Error: ${esc(err.message)}</div>`;
    return;
  }

  const isDone = run.status === 'done' || run.status === 'failed' || run.status === 'stopped';
  const duration = run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : Math.round((Date.now() - run.startedAt) / 1000);

  main.innerHTML = `
    <div class="forge-run-view">
      <div class="forge-run-header">
        <div>
          <h3>${esc((run.task || '').slice(0, 80))}</h3>
          <div class="forge-run-meta-bar">
            <span class="forge-badge">${FRAMEWORK_LABELS[run.framework] || run.framework}</span>
            <span class="forge-badge">${MODE_LABELS[run.mode] || run.mode}</span>
            <span class="forge-cost">$${(run.cost?.total || 0).toFixed(2)}</span>
            <span>${fmtDur(duration)}</span>
          </div>
        </div>
        ${!isDone ? `<button class="btn danger" data-action="stop-run" data-taskid="${esc(taskId)}">⏹ Stop</button>` : ''}
      </div>
      <div class="forge-pipeline">
        ${['design', 'build', 'verify', 'integrate'].map(p => {
          const isActive = run.phase === p && !isDone;
          const isDonePhase = getPhaseOrder(run.phase) > getPhaseOrder(p) || isDone;
          const cls = isActive ? 'active' : isDonePhase ? 'done' : 'pending';
          return `<div class="forge-phase ${cls}"><span class="forge-phase-icon">${isDonePhase ? '✅' : isActive ? '▶' : '○'}</span> ${PHASE_LABELS[p]}</div>`;
        }).join('<span class="forge-phase-arrow">→</span>')}
      </div>
      <div class="forge-log-container">
        <div class="forge-log-header">
          <span>Realtime Log</span>
          <label><input type="checkbox" ${_logAutoScroll ? 'checked' : ''} data-action="toggle-autoscroll"> Auto-scroll</label>
        </div>
        <div class="forge-log" id="forge-log">
          ${(run.log || []).map(renderLogEntry).join('')}
        </div>
      </div>
      ${isDone ? renderForgeResult(run) : ''}
    </div>`;

  if (_logAutoScroll) {
    const logEl = document.getElementById('forge-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

function renderLogEntry(entry) {
  const icon = ROLE_ICONS[entry.role] || '📋';
  const color = ROLE_COLORS[entry.role] || '#888';
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<div class="forge-log-entry">
    <span class="forge-log-time">${time}</span>
    <span class="forge-log-role" style="color:${color}">${icon} ${ROLE_LABELS[entry.role] || entry.role}</span>
    <span class="forge-log-msg">${esc((entry.message || '').length > 80 ? entry.message.slice(0, 80) + '…' : entry.message)}</span>
    ${entry.detail ? `<div class="forge-log-detail">${esc((entry.detail || '').slice(0, 120))}${(entry.detail || '').length > 120 ? '…' : ''}</div>` : ''}
  </div>`;
}

function renderForgeResult(run) {
  const files = run.finalFiles || [];
  const issues = run.verifyIssues || [];
  const cost = run.cost || {};
  const noOutput = files.length === 0;

  return `<div class="forge-result">
    ${noOutput ? `<div class="forge-result-empty">
      <span class="forge-result-empty-icon">${run.status === 'failed' ? '❌' : run.status === 'stopped' ? '⏹' : run.status === 'done' ? '📭' : '⚠️'}</span>
      <span>${run.status === 'failed' ? '작업 실패 — 결과물 없음' : run.status === 'stopped' ? '사용자가 중지함' : '생성된 파일 없음 — 더 구체적인 설명이 필요합니다'}</span>
    </div>` : ''}
    ${files.length > 0 ? `<div class="forge-result-section">
      <h4>📁 파일 (${files.length})</h4>
      ${files.map(f => `<div class="forge-file-item"><span class="forge-file-action ${f.action}">${f.action === 'create' ? '+' : '~'}</span> ${esc(f.path)}</div>`).join('')}
    </div>` : ''}
    ${issues.length > 0 ? `<div class="forge-result-section">
      <h4>🔍 검증 결과</h4>
      <div class="forge-verify-summary">사이클: ${run.verifyCycles || 0} · 이슈: ${issues.length}</div>
      ${issues.map(i => `<div class="forge-issue ${i.severity}"><span class="forge-issue-sev">${i.severity}</span> ${esc(i.title || '')}</div>`).join('')}
    </div>` : ''}
    <div class="forge-result-section">
      <h4>💰 비용</h4>
      <table class="forge-cost-table">
        ${Object.entries(cost.byRole || {}).map(([role, data]) =>
          `<tr><td>${ROLE_ICONS[role] || ''} ${ROLE_LABELS[role] || role}</td><td>$${(data.usd || 0).toFixed(3)}</td><td>${data.model || ''}</td></tr>`
        ).join('')}
        <tr class="forge-cost-total"><td>합계</td><td>$${(cost.total || 0).toFixed(2)}</td><td></td></tr>
      </table>
    </div>
    ${files.length > 0 && run.status === 'done' ? `<div class="forge-apply-bar">
      <button class="btn primary" data-action="apply-result" data-taskid="${esc(run.taskId)}">Apply to Project</button>
    </div>` : ''}
  </div>`;
}

export async function stopForgeRun(taskId) {
  await postJson(`/api/forge/stop/${taskId}`, {});
  showToast('Forge stopped');
  setTimeout(() => selectForgeRun(taskId), 500);
}

export async function applyForgeResult(taskId) {
  try {
    const result = await postJson(`/api/forge/apply/${taskId}`, {});
    const applied = result.filter(r => r.status === 'applied').length;
    showToast(`Applied ${applied} files`);
  } catch (err) {
    showToast('Apply error: ' + err.message);
  }
}

export function toggleForgeAutoScroll(val) { _logAutoScroll = val; }

// ─── SSE Event Handlers ───
export function handleForgeEvent(eventName, data) {
  if (eventName === 'forge:start') {
    loadForgeRuns();
  } else if (eventName === 'forge:log' && data.taskId === _activeTaskId) {
    const logEl = document.getElementById('forge-log');
    if (logEl) {
      logEl.insertAdjacentHTML('beforeend', renderLogEntry(data));
      if (_logAutoScroll) logEl.scrollTop = logEl.scrollHeight;
    }
  } else if (eventName === 'forge:phase' && data.taskId === _activeTaskId) {
    showForgeRunView(data.taskId);
  } else if (eventName === 'forge:cost' && data.taskId === _activeTaskId) {
    const costEl = document.querySelector('.forge-cost');
    if (costEl) costEl.textContent = `$${(data.total || 0).toFixed(2)}`;
  } else if (eventName === 'forge:done' || eventName === 'forge:error' || eventName === 'forge:stopped') {
    loadForgeRuns();
    if (data.taskId === _activeTaskId) showForgeRunView(data.taskId);
  }
}

// ─── Helpers ───
function getPhaseOrder(phase) {
  return { design: 1, build: 2, verify: 3, integrate: 4 }[phase] || 0;
}

function timeAgoShort(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
