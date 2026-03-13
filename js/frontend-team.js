// ─── Frontend Team (AutoBuild): Project Auto-Builder UI ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson, timeAgo } from './utils.js';
import { registerClickActions } from './actions.js';

let _inited = false;
let _currentPlanId = null;
let _currentFilter = 'all';
let _selectedFeatureId = null;
let _uploadedImages = []; // { file, dataUrl }
let _plans = [];

// ─── Init ───
export function initFrontendTeam() {
  if (_inited) { refreshHistory(); return; }
  _inited = true;

  populateProjectSelect();
  setupImageDrop();
  refreshHistory();

  registerClickActions({
    'ab-generate': onGenerate,
    'ab-filter': onFilter,
    'ab-approve': onApprove,
    'ab-execute': onExecute,
    'ab-stop': onStop,
    'ab-resume': onResume,
    'ab-delete': onDelete,
    'ab-add-feature': onAddFeature,
    'ab-history-item': onHistoryClick,
    'ab-feature-click': onFeatureClick,
    'ab-close-detail': onCloseDetail,
    'ab-toggle-phase': onTogglePhase,
  });
}

// ─── Project Select ───
function populateProjectSelect() {
  const sel = document.getElementById('ab-project');
  if (!sel) return;
  sel.innerHTML = '<option value="">프로젝트 선택...</option>' +
    (app.projectList || []).map(p =>
      `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`
    ).join('');
}

// ─── Image Upload ───
function setupImageDrop() {
  const drop = document.getElementById('ab-image-drop');
  const input = document.getElementById('ab-image-input');
  if (!drop || !input) return;

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('ab-drop-active'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('ab-drop-active'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('ab-drop-active');
    addImageFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    addImageFiles(input.files);
    input.value = '';
  });
}

function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      _uploadedImages.push({ file, dataUrl: reader.result });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreviews() {
  const el = document.getElementById('ab-image-preview');
  if (!el) return;
  el.innerHTML = _uploadedImages.map((img, i) => `
    <div class="ab-img-thumb" data-idx="${i}">
      <img src="${img.dataUrl}" alt="" />
      <button class="ab-img-remove" data-action="ab-remove-image" data-idx="${i}">&times;</button>
    </div>
  `).join('');
}

// ─── Generate Plan ───
async function onGenerate() {
  const projectId = document.getElementById('ab-project')?.value;
  const desc = document.getElementById('ab-description')?.value?.trim();
  if (!projectId || !desc) {
    showToast('프로젝트와 설명을 입력해주세요', 'warn');
    return;
  }

  const btn = document.getElementById('ab-generate-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI 분석 중...'; }

  try {
    // Upload images first if any
    const imagePaths = [];
    if (_uploadedImages.length > 0 && _currentPlanId) {
      for (const img of _uploadedImages) {
        const base64 = img.dataUrl.split(',')[1];
        const result = await postJson('/api/project-plan/upload', {
          planId: _currentPlanId,
          filename: img.file.name,
          data: base64,
        });
        if (result.url) imagePaths.push(result.url);
      }
    }

    const result = await postJson('/api/project-plan/generate', {
      projectId, description: desc, images: imagePaths,
    });

    if (result.error) throw new Error(result.error);

    _currentPlanId = result.planId;
    showPlan(result);
    refreshHistory();
    showToast(`${result.features?.length || 0}개 Feature 생성 완료`, 'success');
  } catch (err) {
    showToast(`분석 실패: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AI 분석 시작'; }
  }
}

// ─── Plan Display ───
function showPlan(plan) {
  if (!plan) return;
  _currentPlanId = plan.planId;
  _selectedFeatureId = null;

  document.getElementById('ab-empty-state')?.style.setProperty('display', 'none');
  const planView = document.getElementById('ab-plan-view');
  if (planView) planView.style.display = '';

  // Title & status
  const project = (app.projectList || []).find(p => p.id === plan.projectId);
  document.getElementById('ab-plan-title').textContent = project?.name || plan.projectId;
  renderPlanStatus(plan);
  renderPlanActions(plan);
  renderProgress(plan);
  renderPhases(plan);
  hideFeatureDetail();
}

function renderPlanStatus(plan) {
  const el = document.getElementById('ab-plan-status');
  if (!el) return;
  const icons = { draft: '📝', approved: '✅', running: '⏳', paused: '⏸', done: '🎉', failed: '❌' };
  const labels = { draft: '초안 (편집 가능)', approved: '승인됨', running: '실행 중', paused: '일시중지', done: '완료', failed: '실패' };
  el.innerHTML = `<span class="ab-status ab-status-${plan.status}">${icons[plan.status] || ''} ${labels[plan.status] || plan.status}</span>`;

  if (plan.startedAt && (plan.status === 'running' || plan.status === 'done')) {
    const elapsed = (plan.endedAt || Date.now()) - plan.startedAt;
    const min = Math.floor(elapsed / 60000);
    const sec = Math.floor((elapsed % 60000) / 1000);
    el.innerHTML += ` <span class="ab-elapsed">${min}m ${sec}s</span>`;
  }
}

function renderPlanActions(plan) {
  const el = document.getElementById('ab-plan-actions');
  if (!el) return;
  let html = '';
  if (plan.status === 'draft') {
    html = `<button class="ab-btn ab-btn-secondary" data-action="ab-add-feature">+ Feature</button>
            <button class="ab-btn ab-btn-primary" data-action="ab-approve">승인 & 실행</button>`;
  } else if (plan.status === 'approved') {
    html = `<button class="ab-btn ab-btn-primary" data-action="ab-execute">실행 시작</button>`;
  } else if (plan.status === 'running') {
    html = `<button class="ab-btn ab-btn-danger" data-action="ab-stop">중단</button>`;
  } else if (plan.status === 'paused') {
    html = `<button class="ab-btn ab-btn-primary" data-action="ab-resume">이어서 실행</button>
            <button class="ab-btn ab-btn-danger-outline" data-action="ab-delete">삭제</button>`;
  } else if (plan.status === 'done' || plan.status === 'failed') {
    html = `<button class="ab-btn ab-btn-danger-outline" data-action="ab-delete">삭제</button>`;
  }
  el.innerHTML = html;
}

function renderProgress(plan) {
  const wrap = document.getElementById('ab-progress-wrap');
  if (!wrap) return;
  const prog = plan.progress;
  if (!prog || plan.status === 'draft') { wrap.style.display = 'none'; return; }
  // Merge currentPhase from plan level into progress
  if (plan.currentPhase && !prog.currentPhase) prog.currentPhase = plan.currentPhase;
  wrap.style.display = '';
  const fill = document.getElementById('ab-progress-fill');
  const text = document.getElementById('ab-progress-text');
  if (fill) {
    fill.style.width = `${prog.percent}%`;
    fill.className = `ab-progress-fill ${prog.percent >= 100 ? 'ab-progress-complete' : ''}`;
  }
  if (text) {
    const phaseLabel = prog.currentPhase ? ` — Phase: ${prog.currentPhase}` : '';
    text.textContent = `${prog.percent}% (${prog.done}/${prog.total}) — Running: ${prog.running}, Failed: ${prog.failed}${phaseLabel}`;
  }
}

function renderPhases(plan) {
  const el = document.getElementById('ab-phases');
  if (!el) return;
  if (!plan.features?.length) {
    el.innerHTML = '<div class="ab-no-features">Feature가 없습니다</div>';
    return;
  }

  // Group by phase
  const phases = plan.phases || [{ id: 'default', label: '기능', order: 0 }];
  const grouped = {};
  for (const ph of phases) grouped[ph.id] = [];
  for (const f of plan.features) {
    const phId = f.phase || 'default';
    if (!grouped[phId]) grouped[phId] = [];
    grouped[phId].push(f);
  }

  let html = '';
  for (const ph of phases) {
    const features = grouped[ph.id] || [];
    if (!features.length) continue;
    const doneCount = features.filter(f => f.status === 'done').length;
    const allDone = doneCount === features.length;
    const hasRunning = features.some(f => f.status === 'running');
    const collapsed = allDone && plan.status === 'running';

    // Filter
    const filtered = _currentFilter === 'all' ? features : features.filter(f => f.status === _currentFilter);
    if (_currentFilter !== 'all' && !filtered.length) continue;

    html += `
      <div class="ab-phase ${collapsed ? 'ab-phase-collapsed' : ''}">
        <div class="ab-phase-header" data-action="ab-toggle-phase" data-phase="${esc(ph.id)}">
          <span class="ab-phase-arrow">${collapsed ? '▶' : '▼'}</span>
          <span class="ab-phase-label">${esc(ph.label)}</span>
          <span class="ab-phase-count">${doneCount}/${features.length}</span>
          ${hasRunning ? '<span class="ab-phase-running">⏳</span>' : ''}
          ${allDone ? '<span class="ab-phase-done">✅</span>' : ''}
        </div>
        <div class="ab-feature-grid ${collapsed ? 'ab-hidden' : ''}">
          ${(filtered).map(f => renderFeatureCard(f, plan.status === 'draft')).join('')}
        </div>
      </div>`;
  }

  el.innerHTML = html;
}

function renderFeatureCard(feature, editable) {
  const statusIcons = {
    queued: '⏸', ready: '🔵', running: '⏳', done: '✅', failed: '❌', skipped: '⏭',
  };
  const statusClasses = {
    queued: 'ab-card-queued', ready: 'ab-card-ready', running: 'ab-card-running',
    done: 'ab-card-done', failed: 'ab-card-failed', skipped: 'ab-card-skipped',
  };

  const elapsed = feature.startedAt && feature.endedAt
    ? `${Math.floor((feature.endedAt - feature.startedAt) / 60000)}m`
    : feature.startedAt ? `${Math.floor((Date.now() - feature.startedAt) / 60000)}m` : '';

  const retryInfo = feature.retryCount > 0 ? `<span class="ab-retry">(retry ${feature.retryCount})</span>` : '';

  return `
    <div class="ab-feature-card ${statusClasses[feature.status] || ''} ${_selectedFeatureId === feature.id ? 'ab-card-selected' : ''}"
         data-action="ab-feature-click" data-fid="${esc(feature.id)}" data-plan="${esc(_currentPlanId)}">
      <div class="ab-card-top">
        <span class="ab-card-id">${esc(feature.id)}</span>
        <span class="ab-card-icon">${statusIcons[feature.status] || ''}</span>
      </div>
      <div class="ab-card-title">${esc(feature.title)}</div>
      <div class="ab-card-bottom">
        ${feature.agentId ? `<span class="ab-card-deps">${esc(feature.agentId)}</span>` : ''}
        <span class="ab-card-time">${elapsed}</span>
        ${retryInfo}
        ${feature.deps?.length ? `<span class="ab-card-deps">deps: ${feature.deps.join(', ')}</span>` : ''}
      </div>
      ${feature.error ? `<div class="ab-card-error">${esc(feature.error).slice(0, 80)}</div>` : ''}
    </div>`;
}

// ─── Feature Detail Panel ───
function onFeatureClick(el) {
  const fid = el?.dataset?.fid;
  if (!fid || !_currentPlanId) return;
  _selectedFeatureId = fid;
  showFeatureDetail(fid);
  // Re-render to highlight selected card
  refreshCurrentPlan();
}

function showFeatureDetail(featureId) {
  const plan = _plans.find(p => p.planId === _currentPlanId);
  if (!plan) return;
  const feature = plan.features?.find(f => f.id === featureId);
  if (!feature) return;

  const el = document.getElementById('ab-feature-detail');
  if (!el) return;
  el.style.display = '';

  const statusIcons = { queued: '⏸', ready: '🔵', running: '⏳', done: '✅', failed: '❌', skipped: '⏭' };

  // Files info
  const filesHtml = feature.files?.length
    ? `<div class="ab-detail-deps"><strong>Files:</strong> ${feature.files.map(f => `<code>${esc(f)}</code>`).join(', ')}</div>` : '';

  // Agent info
  const agentHtml = feature.agentId
    ? `<div class="ab-detail-sprint"><strong>Agent:</strong> ${esc(feature.agentId)}</div>` : '';

  // Agent log
  const logHtml = feature.agentLog?.length
    ? `<div class="ab-detail-sprint" style="max-height:120px;overflow-y:auto;font-size:11px;margin-top:8px;">
        ${feature.agentLog.map(l => `<div style="margin:2px 0;"><span style="color:var(--text-3)">${l.ts?.slice(11,19) || ''}</span> <strong>${esc(l.agent || '')}</strong> ${esc(l.action || '')} <span style="color:var(--text-3)">${esc((l.detail || '').slice(0, 100))}</span></div>`).join('')}
      </div>` : '';

  el.innerHTML = `
    <div class="ab-detail-header">
      <h3>${esc(feature.id)}: ${esc(feature.title)}</h3>
      <button class="ab-detail-close" data-action="ab-close-detail">&times;</button>
    </div>
    <div class="ab-detail-status">${statusIcons[feature.status] || ''} ${feature.status} ${feature.type ? `(${feature.type})` : ''}</div>
    <div class="ab-detail-desc">${esc(feature.description)}</div>
    ${filesHtml}
    ${feature.deps?.length ? `<div class="ab-detail-deps"><strong>Dependencies:</strong> ${feature.deps.join(', ')}</div>` : ''}
    ${feature.images?.length ? `<div class="ab-detail-images">${feature.images.map(img => `<img src="${esc(img)}" class="ab-detail-img" />`).join('')}</div>` : ''}
    ${agentHtml}
    ${feature.error ? `<div class="ab-detail-error">${esc(feature.error)}</div>` : ''}
    ${logHtml}
  `;
}

function hideFeatureDetail() {
  _selectedFeatureId = null;
  const el = document.getElementById('ab-feature-detail');
  if (el) el.style.display = 'none';
}

function onCloseDetail() { hideFeatureDetail(); }

// ─── Phase Toggle ───
function onTogglePhase(el) {
  const phaseEl = el.closest('.ab-phase');
  if (!phaseEl) return;
  phaseEl.classList.toggle('ab-phase-collapsed');
  const grid = phaseEl.querySelector('.ab-feature-grid');
  if (grid) grid.classList.toggle('ab-hidden');
  const arrow = phaseEl.querySelector('.ab-phase-arrow');
  if (arrow) arrow.textContent = phaseEl.classList.contains('ab-phase-collapsed') ? '▶' : '▼';
}

// ─── Filter ───
function onFilter(el) {
  _currentFilter = el?.dataset?.filter || 'all';
  document.querySelectorAll('.ab-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === _currentFilter));
  refreshCurrentPlan();
}

// ─── Actions ───
async function onApprove() {
  if (!_currentPlanId) return;
  try {
    // Collect edited features (for now, pass null = no edits)
    const result = await postJson(`/api/project-plan/approve/${_currentPlanId}`, {});
    if (result.error) throw new Error(result.error);
    // Auto-execute after approve
    const execResult = await postJson(`/api/project-plan/execute/${_currentPlanId}`, {});
    if (execResult.error) throw new Error(execResult.error);
    showPlan(execResult);
    showToast('실행 시작!', 'success');
  } catch (err) {
    showToast(`실행 실패: ${err.message}`, 'error');
  }
}

async function onExecute() {
  if (!_currentPlanId) return;
  try {
    const result = await postJson(`/api/project-plan/execute/${_currentPlanId}`, {});
    if (result.error) throw new Error(result.error);
    showPlan(result);
    showToast('실행 시작!', 'success');
  } catch (err) {
    showToast(`실행 실패: ${err.message}`, 'error');
  }
}

async function onStop() {
  if (!_currentPlanId) return;
  try {
    const result = await postJson(`/api/project-plan/stop/${_currentPlanId}`, {});
    if (result.error) throw new Error(result.error);
    showPlan(result);
    showToast('중단됨', 'info');
  } catch (err) {
    showToast(`중단 실패: ${err.message}`, 'error');
  }
}

async function onResume() {
  if (!_currentPlanId) return;
  try {
    // executePlan accepts 'paused' status directly
    const result = await postJson(`/api/project-plan/execute/${_currentPlanId}`, {});
    if (result.error) throw new Error(result.error);
    showPlan(result);
    showToast('재개!', 'success');
  } catch (err) {
    showToast(`재개 실패: ${err.message}`, 'error');
  }
}

async function onDelete() {
  if (!_currentPlanId) return;
  if (!confirm('이 플랜을 삭제하시겠습니까?')) return;
  try {
    await fetchJson(`/api/project-plan/${_currentPlanId}`, { method: 'DELETE' });
    _currentPlanId = null;
    document.getElementById('ab-empty-state')?.style.setProperty('display', '');
    document.getElementById('ab-plan-view')?.style.setProperty('display', 'none');
    refreshHistory();
    showToast('삭제됨', 'info');
  } catch (err) {
    showToast(`삭제 실패: ${err.message}`, 'error');
  }
}

function onAddFeature() {
  // Simple prompt-based feature add
  const title = prompt('Feature 제목:');
  if (!title) return;
  const desc = prompt('구현 설명:') || title;
  const plan = _plans.find(p => p.planId === _currentPlanId);
  if (!plan) return;
  const maxId = plan.features.reduce((max, f) => {
    const num = parseInt(f.id.replace('F-', ''));
    return num > max ? num : max;
  }, 0);
  plan.features.push({
    id: `F-${maxId + 1}`,
    title, description: desc,
    phase: 'extra', deps: [], images: [], files: [], type: 'create',
    status: 'queued', sprintId: null, agentId: null, agentLog: [],
    retryCount: 0, startedAt: null, endedAt: null, error: null,
  });
  renderPhases(plan);
}

// ─── History ───
async function refreshHistory() {
  try {
    _plans = await fetchJson('/api/project-plan/runs');
    if (!Array.isArray(_plans)) _plans = [];
  } catch { _plans = []; }
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById('ab-history-list');
  if (!el) return;
  if (!_plans.length) {
    el.innerHTML = '<div class="ab-history-empty">플랜 없음</div>';
    return;
  }
  el.innerHTML = _plans.map(p => {
    const prog = p.progress || {};
    const icons = { draft: '📝', approved: '✅', running: '⏳', paused: '⏸', done: '🎉', failed: '❌' };
    const active = p.planId === _currentPlanId ? 'ab-history-active' : '';
    return `
      <div class="ab-history-item ${active}" data-action="ab-history-item" data-plan-id="${esc(p.planId)}">
        <span class="ab-history-icon">${icons[p.status] || '📄'}</span>
        <div class="ab-history-info">
          <div class="ab-history-name">${esc(p.description?.slice(0, 40) || p.planId)}</div>
          <div class="ab-history-meta">${prog.done || 0}/${prog.total || 0} features</div>
        </div>
      </div>`;
  }).join('');
}

async function onHistoryClick(el) {
  const planId = el?.dataset?.planId;
  if (!planId) return;
  try {
    const plan = await fetchJson(`/api/project-plan/runs/${planId}`);
    if (plan.error) throw new Error(plan.error);
    // Update local cache
    const idx = _plans.findIndex(p => p.planId === planId);
    if (idx >= 0) _plans[idx] = plan; else _plans.unshift(plan);
    showPlan(plan);
    renderHistory();
  } catch (err) {
    showToast(`플랜 로드 실패: ${err.message}`, 'error');
  }
}

// ─── Refresh Current Plan ───
function refreshCurrentPlan() {
  const plan = _plans.find(p => p.planId === _currentPlanId);
  if (plan) {
    renderPlanStatus(plan);
    renderPlanActions(plan);
    renderProgress(plan);
    renderPhases(plan);
    if (_selectedFeatureId) showFeatureDetail(_selectedFeatureId);
  }
}

// ─── SSE Event Handler ───
export function handleProjectPlanEvent(event, data) {
  if (!data) return;

  switch (event) {
    case 'project:plan': {
      // Full plan update
      const idx = _plans.findIndex(p => p.planId === data.planId);
      if (idx >= 0) _plans[idx] = data; else _plans.unshift(data);
      if (data.planId === _currentPlanId) showPlan(data);
      renderHistory();
      break;
    }
    case 'project:feature-update': {
      const plan = _plans.find(p => p.planId === data.planId);
      if (!plan) break;
      const feature = plan.features?.find(f => f.id === data.featureId);
      if (feature) {
        if (data.status) feature.status = data.status;
        if (data.sprintId) feature.sprintId = data.sprintId;
        if (data.error !== undefined) feature.error = data.error;
        if (data.elapsed) feature.endedAt = feature.startedAt ? feature.startedAt + data.elapsed : Date.now();
        if (data.cost) feature.cost = data.cost;
        if (data.retryCount !== undefined) feature.retryCount = data.retryCount;
      }
      if (data.planId === _currentPlanId) refreshCurrentPlan();
      break;
    }
    case 'project:progress': {
      const plan = _plans.find(p => p.planId === data.planId);
      if (plan) {
        plan.progress = data;
        if (data.planId === _currentPlanId) renderProgress(plan);
      }
      renderHistory();
      break;
    }
    case 'project:done': {
      const plan = _plans.find(p => p.planId === data.planId);
      if (plan) {
        plan.status = data.hasFailures ? 'failed' : 'done';
        plan.endedAt = Date.now();
        plan.totalCost = data.totalCost || 0;
      }
      if (data.planId === _currentPlanId) {
        refreshCurrentPlan();
        const elapsed = data.elapsed ? `${Math.floor(data.elapsed / 60000)}분` : '';
        showToast(`🎉 프로젝트 빌드 완료! ${elapsed} / $${(data.totalCost || 0).toFixed(2)}`, 'success');
      }
      renderHistory();
      break;
    }
    case 'project:plan-generating': {
      if (data.planId) {
        showToast('🤖 AI 분석 중...', 'info');
      }
      break;
    }
    case 'project:log': {
      // Real-time pipeline log — update status bar if current plan
      if (data.planId === _currentPlanId && data.message) {
        const statusEl = document.getElementById('ab-plan-status');
        if (statusEl) {
          const existing = statusEl.querySelector('.ab-status');
          const logLine = document.createElement('div');
          logLine.className = 'ab-elapsed';
          logLine.style.fontSize = '11px';
          logLine.textContent = `${data.role || 'system'}: ${data.message}`;
          // Replace previous log line
          const prev = statusEl.querySelector('.ab-log-line');
          if (prev) prev.remove();
          logLine.classList.add('ab-log-line');
          statusEl.appendChild(logLine);
        }
      }
      break;
    }
    case 'project:error': {
      if (data.planId === _currentPlanId) {
        showToast(`❌ 플랜 에러: ${data.error}`, 'error');
      }
      break;
    }
  }
}
