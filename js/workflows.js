// ─── Workflows Module: LangGraph workflow management ───
import { app } from './state.js';
import { esc, showToast, timeAgo, simpleMarkdown } from './utils.js';

// ─── Init ───
export function initWorkflows() {
  if (app._workflowsInit) return;
  app._workflowsInit = true;
  loadWorkflowDefs();
  loadWorkflowRuns();
  loadSchedules();
  const view = document.getElementById('workflows-view');
  if (view && !view.dataset.delegated) {
    view.dataset.delegated = '1';
    view.addEventListener('click', e => {
      // Recent value chips
      const chip = e.target.closest('.wf-recent-chip[data-recent-key]');
      if (chip) { wfApplyRecent(chip.dataset.recentKey, chip.dataset.recentValue); return; }
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'select-def': selectWorkflowDef(el.dataset.id); break;
        case 'select-run': selectWorkflowRun(el.dataset.runid); break;
        case 'wf-autofill': wfAutoFill(el.dataset.key, el.dataset.aftype); break;
        case 'start-run': startWorkflowRun(); break;
        case 'toggle-step': e.stopPropagation(); toggleStepOutput(el.dataset.runid, el.dataset.stepid); break;
        case 'copy-step': e.stopPropagation(); copyStepOutput(el.dataset.runid, el.dataset.stepid); break;
        case 'stop-run': stopWorkflowRun(el.dataset.runid); break;
        case 'rerun': rerunWorkflow(el.dataset.runid); break;
        case 'copy-output': copyWorkflowOutput(el.dataset.runid); break;
        case 'toggle-raw': toggleRawOutput(); break;
        case 'open-schedule': openSchedulePanel(); break;
        case 'save-schedule': saveSchedule(); break;
        case 'delete-schedule': deleteSchedule(el.dataset.id); break;
        case 'toggle-schedule': toggleSchedule(el.dataset.id); break;
        case 'close-schedule': closeSchedulePanel(); break;
      }
    });
    view.addEventListener('change', e => {
      if (e.target.dataset.action === 'wf-project-changed') wfProjectChanged();
    });
  }
}

// ─── Load Definitions ───
export async function loadWorkflowDefs() {
  try {
    const res = await fetch('/api/workflows');
    app.workflowDefs = await res.json();
  } catch { app.workflowDefs = []; }
  renderDefList();
}

// ─── Load Runs ───
export async function loadWorkflowRuns() {
  try {
    const res = await fetch('/api/workflows/runs');
    app.workflowRuns = await res.json();
  } catch { app.workflowRuns = []; }
  renderRunList();
}

// ─── Run History Filter ───
let _runFilter = '';
export function filterWorkflowRuns(query) {
  _runFilter = (query || '').toLowerCase().trim();
  renderRunList();
}

// ─── Render Left Panel: Definition List ───
function renderDefList() {
  const el = document.getElementById('wf-def-list');
  if (!el) return;
  const countEl = document.getElementById('wf-def-count');
  if (countEl) countEl.textContent = app.workflowDefs.length || '';
  if (!app.workflowDefs.length) {
    el.innerHTML = '<div class="wf-empty-msg">No workflows found</div>';
    return;
  }
  const defIcon = (d) => {
    if (d.hasCycles) return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/></svg>';
    if ((d.stepCount || 0) >= 4) return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>';
  };
  el.innerHTML = app.workflowDefs.map(d => {
    const sched = getScheduleForWorkflow(d.id);
    const schedBadge = sched && sched.enabled ? ` <span class="wf-sched-badge" title="${esc(formatScheduleDesc(sched))}">⏰</span>` : '';
    return `
    <div class="wf-def-item${app._activeWorkflowDefId === d.id ? ' active' : ''}" data-action="select-def" data-id="${esc(d.id)}">
      <div class="wf-def-name"><span class="wf-def-icon">${defIcon(d)}</span>${esc(d.name)}${d.hasCycles ? ' <span class="wf-cycle-badge" title="Cycle">⟲</span>' : ''}${schedBadge}</div>
      <div class="wf-def-desc">${esc(d.description || '')}</div>
      <div class="wf-def-meta">${d.stepCount || 0} agents${d.maxIterations ? ` · max ${d.maxIterations} cycles` : ''}${d.models && d.models.length ? ` · ${d.models.join(', ')}` : ''}</div>
    </div>`;
  }).join('');
}

// ─── Render Left Panel: Run History ───
function renderRunList() {
  const el = document.getElementById('wf-run-list');
  if (!el) return;
  const runCountEl = document.getElementById('wf-run-count');
  if (runCountEl) runCountEl.textContent = app.workflowRuns.length || '';
  if (!app.workflowRuns.length) {
    el.innerHTML = '<div class="wf-empty-msg">No runs yet</div>';
    return;
  }
  const icons = { running: '⟳', done: '✓', error: '✗', stopped: '■', pending: '○' };
  let runs = app.workflowRuns;
  if (_runFilter) {
    runs = runs.filter(r => {
      const name = (r.workflowName || r.workflowId || '').toLowerCase();
      const status = (r.status || '').toLowerCase();
      return name.includes(_runFilter) || status.includes(_runFilter);
    });
  }
  if (!runs.length) {
    el.innerHTML = '<div class="wf-empty-msg">No matching runs</div>';
    return;
  }
  el.innerHTML = runs.map(r => `
    <div class="wf-run-item${app._activeWorkflowRunId === r.runId ? ' active' : ''}" data-action="select-run" data-runid="${esc(r.runId)}">
      <div class="wf-run-status wf-st-${r.status}">${icons[r.status] || '?'}</div>
      <div class="wf-run-info">
        <div class="wf-run-name">${esc(r.workflowName || r.workflowId)}</div>
        <div class="wf-run-time">${timeAgo(new Date(r.startedAt).toISOString())}</div>
      </div>
    </div>
  `).join('');
}

// ─── Build graph flow visualization ───
function buildGraphViz(def) {
  if (!def.edges || !def.steps) return '';
  const steps = def.steps;
  const typeIcons = { llm: '⬡', shell: '⌘', http: '⇄', condition: '◇' };

  // Build adjacency from edges
  const edgeMap = {};
  for (const e of def.edges) {
    const key = Array.isArray(e.from) ? e.from.join(',') : e.from;
    edgeMap[key] = e;
  }
  // Also index single-source edges by step id
  for (const e of def.edges) {
    if (!Array.isArray(e.from)) edgeMap[e.from] = e;
  }

  // Find fan-in targets: edges where from is an array
  const fanInTargets = new Map(); // target → [sources]
  for (const e of def.edges) {
    if (Array.isArray(e.from) && !Array.isArray(e.to)) {
      fanInTargets.set(e.to, e.from);
    }
  }

  const visited = new Set();
  const lines = [];

  function nodeHtml(stepId) {
    const step = steps.find(s => s.id === stepId);
    if (!step) return '';
    const idx = steps.indexOf(step) + 1;
    const roleSnippet = step.role ? esc(step.role) : '';
    const modelBadge = step.provider && step.model ? `<span class="wf-model-badge wf-mb-${esc(step.provider)}-${esc(step.model)}">${esc(step.provider)}:${esc(step.model)}</span>` : '';
    return `<div class="wf-gv-node wf-gvn-${step.type}">
      <span class="wf-gv-num">${idx}</span>
      <span class="wf-gv-icon wf-gv-${step.type}">${typeIcons[step.type] || '●'}</span>
      <span class="wf-gv-name">${esc(step.name)}</span>
      ${modelBadge}
      ${roleSnippet ? `<span class="wf-gv-role">${roleSnippet}</span>` : ''}
    </div>`;
  }

  function resolveNames(targets) {
    const arr = Array.isArray(targets) ? targets : [targets];
    return arr.map(t => t === 'END' ? 'END' : (steps.find(s => s.id === t)?.name || t)).join(', ');
  }

  function walkNode(stepId, depth) {
    if (visited.has(stepId) || depth > 20) return;
    visited.add(stepId);

    lines.push(nodeHtml(stepId));

    const edge = edgeMap[stepId];
    if (!edge) return;

    if (edge.condition) {
      const trueName = resolveNames(edge.condition.true);
      const falseName = resolveNames(edge.condition.false);
      const falseIsParallel = Array.isArray(edge.condition.false);
      const trueIsParallel = Array.isArray(edge.condition.true);
      lines.push(`<div class="wf-gv-branch">
        <div class="wf-gv-cond-label">pattern: <code>${esc(edge.condition.pattern.slice(0, 30))}</code></div>
        <div class="wf-gv-cond-yes">✓ match → ${esc(trueName)}</div>
        <div class="wf-gv-cond-no">✗ else → ${esc(falseName)} ${falseIsParallel ? '<span class="wf-parallel-badge">∥</span>' : ''}<span class="wf-cycle-badge">⟲</span></div>
      </div>`);
      // Continue walking the true path
      const trueTargets = Array.isArray(edge.condition.true) ? edge.condition.true : [edge.condition.true];
      if (trueTargets.length === 1 && trueTargets[0] !== 'END') {
        walkNode(trueTargets[0], depth + 1);
      } else if (trueTargets.length > 1) {
        lines.push('<div class="wf-gv-connector"><div class="wf-gv-line"></div><div class="wf-gv-arrowhead">▾</div></div>');
        walkParallel(trueTargets, depth + 1);
      }
    } else if (edge.to) {
      const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
      if (targets.length === 1) {
        if (targets[0] === 'END') {
          lines.push('<div class="wf-gv-end">✓ END</div>');
        } else {
          lines.push('<div class="wf-gv-connector"><div class="wf-gv-line"></div><div class="wf-gv-arrowhead">▾</div></div>');
          walkNode(targets[0], depth + 1);
        }
      } else {
        // Fan-out
        lines.push('<div class="wf-gv-connector"><div class="wf-gv-line"></div><div class="wf-gv-arrowhead">▾</div></div>');
        walkParallel(targets, depth + 1);
      }
    }
  }

  function walkParallel(stepIds, depth) {
    // Render parallel nodes side-by-side
    const inner = stepIds.map(id => {
      const step = steps.find(s => s.id === id);
      if (!step) return '';
      visited.add(id);
      return `<div class="wf-gv-pnode">${nodeHtml(id)}</div>`;
    }).join('');
    lines.push(`<div class="wf-gv-parallel"><div class="wf-gv-parallel-label">∥ parallel</div><div class="wf-gv-parallel-nodes">${inner}</div></div>`);

    // Find fan-in edge from these parallel nodes
    const fanInKey = stepIds.join(',');
    const fanInEdge = edgeMap[fanInKey];
    if (fanInEdge && fanInEdge.to && fanInEdge.to !== 'END') {
      lines.push('<div class="wf-gv-connector"><div class="wf-gv-line"></div><div class="wf-gv-arrowhead">▾</div></div>');
      walkNode(fanInEdge.to, depth + 1);
    } else if (fanInEdge && fanInEdge.to === 'END') {
      lines.push('<div class="wf-gv-end">✓ END</div>');
    }
  }

  // Find START edge
  const startEdge = def.edges.find(e => e.from === 'START');
  if (startEdge) {
    lines.push('<div class="wf-gv-start">START</div>');
    lines.push('<div class="wf-gv-connector"><div class="wf-gv-line"></div><div class="wf-gv-arrowhead">▾</div></div>');
    const targets = Array.isArray(startEdge.to) ? startEdge.to : [startEdge.to];
    if (targets.length === 1) {
      walkNode(targets[0], 0);
    } else {
      walkParallel(targets, 0);
    }
  }

  return `<div class="wf-graph-viz">${lines.join('')}</div>`;
}

// ─── Estimate run duration from past runs ───
function estimateDuration(workflowId) {
  const pastRuns = app.workflowRuns.filter(r => r.workflowId === workflowId && r.status === 'done' && r.startedAt && r.endedAt);
  if (!pastRuns.length) return null;
  const durations = pastRuns.map(r => r.endedAt - r.startedAt);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return avg;
}

function formatDuration(ms) {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

// ─── Build progress bar HTML ───
function buildProgressBar(steps, runStatus, workflowId, startedAt) {
  const total = steps.length;
  const done = steps.filter(s => s.status === 'done').length;
  const errors = steps.filter(s => s.status === 'error').length;
  const running = steps.filter(s => s.status === 'running').length;
  const pct = total ? Math.round(((done + errors) / total) * 100) : 0;

  let statusText = '';
  if (runStatus === 'done') statusText = `Completed · ${done}/${total} steps`;
  else if (runStatus === 'error') statusText = `Error · ${done + errors}/${total} steps`;
  else if (runStatus === 'stopped') statusText = `Stopped · ${done}/${total} steps`;
  else if (runStatus === 'running') {
    const currentStep = steps.find(s => s.status === 'running');
    statusText = currentStep ? `${esc(currentStep.name)}... · ${done}/${total}` : `${done}/${total} steps`;
  } else statusText = `${done}/${total} steps`;

  // Estimated time
  let etaHtml = '';
  if (runStatus === 'running') {
    const est = estimateDuration(workflowId);
    if (est && startedAt) {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, est - elapsed);
      etaHtml = remaining > 0
        ? `<span class="wf-progress-eta">~${formatDuration(remaining)} left</span>`
        : `<span class="wf-progress-eta">finishing...</span>`;
    }
  } else if (runStatus === 'done' && startedAt) {
    // Show total time for completed runs
    const run = app.workflowRuns.find(r => r.startedAt === startedAt);
    const endedAt = run?.endedAt || Date.now();
    etaHtml = `<span class="wf-progress-eta">${formatDuration(endedAt - startedAt)}</span>`;
  }

  return `
    <div class="wf-progress" id="wf-progress">
      <div class="wf-progress-header">
        <span class="wf-progress-text">${statusText}</span>
        ${etaHtml}
      </div>
      <div class="wf-progress-bar">
        <div class="wf-progress-fill wf-pf-${runStatus}" style="width:${pct}%"></div>
      </div>
    </div>`;
}

// ─── Auto-fill heuristics: map input keys to data sources ───
function _getAutoFill(key) {
  const k = key.toLowerCase();
  if (['code', 'diff', 'codebase'].includes(k)) return { type: 'diff', label: 'Git Diff', icon: '⎇' };
  if (['commits', 'log', 'git_log'].includes(k)) return { type: 'log', label: 'Git Log', icon: '⏱' };
  if (['project_name', 'projectname'].includes(k)) return { type: 'project_name', label: 'Project Name', icon: '📁' };
  if (k === 'version') return { type: 'version', label: 'Detect', icon: '🏷' };
  return null;
}

// ─── Fetch auto-fill data from project ───
export async function wfAutoFill(inputKey, fillType) {
  const sel = document.getElementById('wf-project-select');
  const projectId = sel?.value;
  if (!projectId && fillType !== 'project_name') { showToast('Select a project first', 'info'); return; }

  const field = document.getElementById(`wf-inp-${inputKey}`);
  if (!field) return;

  const project = app.projectList.find(p => p.id === projectId);
  const btn = document.querySelector(`[data-autofill="${inputKey}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    if (fillType === 'diff') {
      const res = await fetch(`/api/projects/${projectId}/diff`);
      const data = await res.json();
      // API returns { staged: { diff, files }, unstaged: { diff, files } }
      let diffText = '';
      if (data.staged?.diff) diffText += data.staged.diff;
      if (data.unstaged?.diff) diffText += (diffText ? '\n\n' : '') + data.unstaged.diff;
      if (!diffText) {
        const gitRes = await fetch(`/api/projects/${projectId}/git`);
        const git = await gitRes.json();
        diffText = git.status || 'No changes detected';
      }
      field.value = diffText;
      const fileCount = (data.staged?.files?.length || 0) + (data.unstaged?.files?.length || 0);
      showToast(fileCount ? `Loaded diff (${fileCount} files)` : 'No changes', fileCount ? 'success' : 'info');
    } else if (fillType === 'log') {
      const res = await fetch(`/api/projects/${projectId}/git/log?limit=30`);
      const data = await res.json();
      const commits = data.commits || [];
      field.value = commits.map(c => `${c.short || c.hash?.slice(0, 7) || '???'} ${c.message || ''}`).join('\n');
      showToast(`Loaded ${commits.length} commits`, 'success');
    } else if (fillType === 'project_name') {
      field.value = project?.name || project?.id || '';
      showToast('Filled project name', 'success');
    } else if (fillType === 'version') {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(project.path + '/package.json')}`);
        const pkg = await res.json();
        const parsed = typeof pkg === 'string' ? JSON.parse(pkg) : pkg;
        field.value = parsed.version || '';
        showToast(`Version: ${parsed.version}`, 'success');
      } catch { showToast('No package.json found', 'info'); }
    }
  } catch (err) {
    showToast('Auto-fill failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; const af = _getAutoFill(inputKey); btn.textContent = af ? `${af.icon} ${af.label}` : 'Fill'; }
  }
}

// ─── Get recent input values from past runs ───
function _getRecentValues(workflowId, inputKey) {
  const runs = app.workflowRuns.filter(r => r.workflowId === workflowId && r.inputs?.[inputKey]);
  const seen = new Set();
  const values = [];
  for (const r of runs) {
    const v = r.inputs[inputKey];
    if (typeof v === 'string' && v.length > 0 && v.length <= 200 && !seen.has(v)) {
      seen.add(v);
      values.push(v);
      if (values.length >= 3) break;
    }
  }
  return values;
}

// ─── Apply recent value ───
export function wfApplyRecent(inputKey, value) {
  const field = document.getElementById(`wf-inp-${inputKey}`);
  if (field) field.value = value;
}

// ─── Select Definition ───
export async function selectWorkflowDef(id) {
  app._activeWorkflowDefId = id;
  app._activeWorkflowRunId = null;
  renderDefList();
  renderRunList();

  const main = document.getElementById('wf-main');
  if (!main) return;

  // Load full definition
  let def;
  try {
    const res = await fetch(`/api/workflows/${id}`);
    def = await res.json();
  } catch { main.innerHTML = '<div class="wf-empty-msg">Failed to load workflow</div>'; return; }

  // Cache full definition for startRun
  app._activeWorkflowFullDef = def;

  const graphHtml = buildGraphViz(def);

  // Check if any inputs benefit from project context
  const hasAutoFill = (def.inputs || []).some(inp => _getAutoFill(inp.key));

  // Project selector (shown if any input can be auto-filled)
  const projectOpts = app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('');
  const projectSelectorHtml = hasAutoFill && app.projectList.length
    ? `<div class="wf-project-picker">
        <label>Project Context</label>
        <select id="wf-project-select" data-action="wf-project-changed">
          <option value="">— Select project —</option>
          ${projectOpts}
        </select>
      </div>` : '';

  // Build inputs with auto-fill buttons and recent values
  const inputsHtml = (def.inputs || []).map(inp => {
    const af = _getAutoFill(inp.key);
    const afBtn = af ? `<button class="wf-autofill-btn" data-action="wf-autofill" data-key="${esc(inp.key)}" data-aftype="${af.type}">${af.icon} ${af.label}</button>` : '';

    // Recent values from past runs
    const recents = _getRecentValues(id, inp.key);
    const recentHtml = recents.length ? `<div class="wf-recent-vals">${recents.map((v, i) => `<button class="wf-recent-chip" data-recent-key="${esc(inp.key)}" data-recent-value="${esc(v)}" title="${esc(v)}">${esc(v.length > 30 ? v.slice(0, 30) + '…' : v)}</button>`).join('')}</div>` : '';

    const labelExtra = `${esc(inp.label)}${inp.required ? ' *' : ''}`;

    if (inp.type === 'select') {
      const opts = (inp.options || []).map(o => `<option value="${esc(o)}"${o === inp.default ? ' selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="wf-input-row"><div class="wf-input-label-row"><label>${labelExtra}</label>${afBtn}</div><select id="wf-inp-${esc(inp.key)}">${opts}</select>${recentHtml}</div>`;
    }
    if (inp.type === 'textarea') {
      return `<div class="wf-input-row"><div class="wf-input-label-row"><label>${labelExtra}</label>${afBtn}</div><textarea id="wf-inp-${esc(inp.key)}" rows="6" placeholder="${esc(inp.label)}">${esc(inp.default || '')}</textarea>${recentHtml}</div>`;
    }
    return `<div class="wf-input-row"><div class="wf-input-label-row"><label>${labelExtra}</label>${afBtn}</div><input type="text" id="wf-inp-${esc(inp.key)}" value="${esc(inp.default || '')}" placeholder="${esc(inp.label)}">${recentHtml}</div>`;
  }).join('');

  // Estimated time hint
  const est = estimateDuration(id);
  const estHtml = est ? `<span class="wf-est-badge">~${formatDuration(est)}</span>` : '';

  main.innerHTML = `
    <div class="wf-detail-head">
      <div class="wf-detail-title">${esc(def.name)}${def.maxIterations ? ` <span class="wf-iter-badge">max ${def.maxIterations} cycles</span>` : ''} ${estHtml}</div>
      <div class="wf-detail-desc">${esc(def.description || '')}</div>
    </div>
    ${graphHtml}
    <div class="wf-inputs">
      <div class="wf-section-label">Inputs</div>
      ${projectSelectorHtml}
      ${inputsHtml}
    </div>
    <div class="wf-actions">
      <button class="btn btn-primary wf-run-btn" id="wf-run-btn" data-action="start-run">▶ Run</button>
      <button class="btn wf-schedule-btn" id="wf-schedule-btn" data-action="open-schedule">⏰ Schedule</button>
    </div>
    <div class="wf-schedule-panel" id="wf-schedule-panel" style="display:none"></div>
  `;

  // Auto-select first project if only one
  if (hasAutoFill && app.projectList.length === 1) {
    const sel = document.getElementById('wf-project-select');
    if (sel) sel.value = app.projectList[0].id;
  }

  // Auto-fill projectPath
  const autoPath = app.projectList.length ? app.projectList[0].path : '';
  const ppField = document.getElementById('wf-inp-projectPath');
  if (ppField && !ppField.value && autoPath) ppField.value = autoPath;
}

// ─── Project selection changed ───
export function wfProjectChanged() {
  const sel = document.getElementById('wf-project-select');
  if (!sel?.value) return;
  const project = app.projectList.find(p => p.id === sel.value);
  if (!project) return;

  // Auto-fill project_name if field exists
  const nameField = document.getElementById('wf-inp-project_name');
  if (nameField && !nameField.value) nameField.value = project.name || project.id || '';

  // Auto-fill projectPath if field exists
  const pathField = document.getElementById('wf-inp-projectPath');
  if (pathField) pathField.value = project.path || '';
}

// ─── Start Run ───
export async function startWorkflowRun() {
  const id = app._activeWorkflowDefId;
  if (!id) return;
  const btn = document.getElementById('wf-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }

  // Use full def (with steps), fallback to summary
  const def = app._activeWorkflowFullDef?.id === id ? app._activeWorkflowFullDef : app.workflowDefs.find(d => d.id === id);
  const inputs = {};
  for (const inp of (def?.inputs || [])) {
    const el = document.getElementById(`wf-inp-${inp.key}`);
    if (el) inputs[inp.key] = el.value;
  }

  try {
    const res = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: id, inputs })
    });
    const data = await res.json();
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast('Workflow started', 'info');
    showImmediateProgress(data.runId, def, inputs);
    setTimeout(() => loadWorkflowRuns(), 500);
  } catch (err) {
    showToast('Failed to start: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run Workflow'; }
  }
}

// ─── Re-run with same inputs ───
export async function rerunWorkflow(runId) {
  let run;
  try {
    const res = await fetch(`/api/workflows/runs/${runId}`);
    run = await res.json();
  } catch { showToast('Failed to load run', 'error'); return; }

  if (!run?.workflowId || !run?.inputs) { showToast('Missing run data', 'error'); return; }

  try {
    const res = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: run.workflowId, inputs: run.inputs })
    });
    const data = await res.json();
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast('Re-run started', 'info');

    // Load full def for immediate progress
    const def = await fetch(`/api/workflows/${run.workflowId}`).then(r => r.json()).catch(() => null);
    if (def) {
      showImmediateProgress(data.runId, def, run.inputs);
    }
    setTimeout(() => loadWorkflowRuns(), 500);
  } catch (err) {
    showToast('Failed to re-run: ' + err.message, 'error');
  }
}

// ─── Stop Run ───
export async function stopWorkflowRun(runId) {
  try {
    await fetch(`/api/workflows/runs/${runId}/stop`, { method: 'POST' });
    showToast('Workflow stopped', 'info');
  } catch { showToast('Failed to stop', 'error'); }
}

// ─── Show Immediate Progress (before SSE arrives) ───
function showImmediateProgress(runId, def, inputs) {
  app._activeWorkflowRunId = runId;
  app._activeWorkflowDefId = null;
  renderDefList();

  const fakeRun = {
    runId, workflowId: def.id, workflowName: def.name,
    status: 'running', startedAt: Date.now(), endedAt: null,
    inputs,
    steps: (def.steps || []).map(s => ({
      id: s.id, name: s.name, type: s.type, role: s.role || '',
      provider: s.provider || 'claude', model: s.model || 'auto',
      status: 'pending', iterations: 0,
      startedAt: null, endedAt: null, output: null, error: null
    })),
    error: null
  };
  app.workflowRuns.unshift({ runId, workflowId: def.id, workflowName: def.name, status: 'running', startedAt: Date.now() });
  renderRunList();
  renderRunDetail(fakeRun);
}

// ─── Select Run ───
export async function selectWorkflowRun(runId) {
  app._activeWorkflowRunId = runId;
  app._activeWorkflowDefId = null;
  renderDefList();
  renderRunList();

  const main = document.getElementById('wf-main');
  if (!main) return;

  let run;
  try {
    const res = await fetch(`/api/workflows/runs/${runId}`);
    run = await res.json();
  } catch { main.innerHTML = '<div class="wf-empty-msg">Failed to load run</div>'; return; }

  renderRunDetail(run);
}

function renderRunDetail(run) {
  const main = document.getElementById('wf-main');
  if (!main) return;

  const badges = { running: 'Running', done: 'Done', error: 'Error', stopped: 'Stopped', pending: 'Pending' };
  const statusIcons = { pending: '○', running: '⟳', done: '✓', error: '✗' };

  const stepsHtml = run.steps.map(s => {
    const dur = s.startedAt && s.endedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : s.startedAt ? '…' : '';
    const expandIcon = s.status === 'done' || s.status === 'error' ? '<span class="wf-sc-expand-icon">▸</span>' : '';
    const copyBtn = s.output ? `<button class="wf-sc-copy-btn" data-action="copy-step" data-runid="${esc(run.runId)}" data-stepid="${esc(s.id)}" title="Copy">Copy</button>` : '';
    const outputHtml = s.output ? `<div class="wf-sc-output" style="display:none"><pre class="wf-sc-output-body">${esc(s.output)}</pre>${copyBtn}</div>` : '';
    const errorHtml = s.error ? `<div class="wf-sc-output" style="display:none"><pre class="wf-sc-output-body" style="color:var(--red)">${esc(s.error)}</pre></div>` : '';
    const iterBadge = s.iterations > 1 ? `<span class="wf-sc-iter">×${s.iterations}</span>` : '';
    const roleHint = s.role ? `<div class="wf-sc-role">${esc(s.role)}</div>` : '';
    return `
      <div class="wf-step-card wf-sc-${s.status}" id="wf-step-${run.runId}-${s.id}">
        <div class="wf-sc-head" data-action="toggle-step" data-runid="${esc(run.runId)}" data-stepid="${esc(s.id)}">
          <span class="wf-sc-status-icon">${statusIcons[s.status] || '○'}</span>
          <span class="wf-sc-name">${esc(s.name)}</span>
          ${iterBadge}
          <span class="wf-sc-type">${s.type}</span>
          ${s.provider && s.model ? `<span class="wf-model-badge wf-mb-${esc(s.provider)}-${esc(s.model)}">${esc(s.provider)}:${esc(s.model)}</span>` : ''}
          <span class="wf-sc-duration">${dur}</span>
          ${expandIcon}
        </div>
        ${roleHint}
        ${outputHtml}${errorHtml}
      </div>`;
  }).join('');

  // Progress bar
  const progressHtml = buildProgressBar(run.steps, run.status, run.workflowId, run.startedAt);

  const stopBtn = run.status === 'running' ? `<button class="btn wf-stop-btn" data-action="stop-run" data-runid="${esc(run.runId)}">■ Stop</button>` : '';
  const rerunBtn = run.status !== 'running' ? `<button class="btn wf-rerun-btn" data-action="rerun" data-runid="${esc(run.runId)}">↻ Re-run</button>` : '';

  // Final output with markdown rendering
  const lastStep = run.steps.findLast(s => s.status === 'done');
  const finalOutput = run.status === 'done' && lastStep?.output
    ? `<div class="wf-final-output"><div class="wf-section-label">Final Output</div><div class="wf-output-md">${simpleMarkdown(lastStep.output)}</div><div class="wf-final-actions"><button class="btn" data-action="copy-output" data-runid="${esc(run.runId)}">Copy</button><button class="btn wf-toggle-raw-btn" data-action="toggle-raw">Raw</button></div><pre class="wf-output-body wf-output-raw" style="display:none">${esc(lastStep.output)}</pre></div>`
    : '';
  const errorMsg = run.error ? `<div class="wf-final-output" style="border-color:var(--red)"><div class="wf-section-label" style="color:var(--red)">Error</div><pre class="wf-output-body" style="color:var(--red)">${esc(run.error)}</pre></div>` : '';

  main.innerHTML = `
    <div class="wf-run-head">
      <div class="wf-run-title">${esc(run.workflowName || run.workflowId)} <span class="wf-run-id">#${run.runId.slice(0, 8)}</span></div>
      <div class="wf-run-status-badge wf-st-${run.status}">${badges[run.status] || run.status}</div>
      ${stopBtn}
      ${rerunBtn}
    </div>
    ${progressHtml}
    <div class="wf-steps" id="wf-steps-${run.runId}">${stepsHtml}</div>
    ${finalOutput}${errorMsg}
  `;
}

// ─── Toggle Step Output ───
export function toggleStepOutput(runId, stepId) {
  const card = document.getElementById(`wf-step-${runId}-${stepId}`);
  if (!card) return;
  const output = card.querySelector('.wf-sc-output');
  if (!output) return;
  const isOpen = output.style.display !== 'none';
  output.style.display = isOpen ? 'none' : '';
  card.classList.toggle('expanded', !isOpen);
}

// ─── Copy Step Output ───
export function copyStepOutput(runId, stepId) {
  const card = document.getElementById(`wf-step-${runId}-${stepId}`);
  if (!card) return;
  const body = card.querySelector('.wf-sc-output-body');
  if (body) {
    navigator.clipboard.writeText(body.textContent).then(() => showToast('Copied', 'success')).catch(() => {});
  }
}

// ─── Copy Final Output ───
export function copyWorkflowOutput(runId) {
  // Prefer raw text over markdown rendered
  const raw = document.querySelector('.wf-output-raw');
  const md = document.querySelector('.wf-output-md');
  const el = raw || md;
  if (el) {
    navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied', 'success')).catch(() => {});
  }
}

// ─── Toggle Raw / Markdown view ───
export function toggleRawOutput() {
  const md = document.querySelector('.wf-output-md');
  const raw = document.querySelector('.wf-output-raw');
  const btn = document.querySelector('.wf-toggle-raw-btn');
  if (!md || !raw || !btn) return;
  const showingRaw = raw.style.display !== 'none';
  if (showingRaw) {
    raw.style.display = 'none';
    md.style.display = '';
    btn.textContent = 'Raw';
  } else {
    raw.style.display = '';
    md.style.display = 'none';
    btn.textContent = 'Markdown';
  }
}

// ─── Update progress bar in real-time ───
function updateProgressBar(runId, runStatus, workflowId, startedAt) {
  const el = document.getElementById('wf-progress');
  if (!el) return;
  // Collect step statuses from DOM
  const stepsContainer = document.getElementById(`wf-steps-${runId}`);
  if (!stepsContainer) return;
  const cards = stepsContainer.querySelectorAll('.wf-step-card');
  const steps = [];
  cards.forEach(card => {
    const classes = card.className;
    let status = 'pending';
    if (classes.includes('wf-sc-done')) status = 'done';
    else if (classes.includes('wf-sc-running')) status = 'running';
    else if (classes.includes('wf-sc-error')) status = 'error';
    const nameEl = card.querySelector('.wf-sc-name');
    steps.push({ status, name: nameEl?.textContent || '' });
  });

  const total = steps.length;
  const done = steps.filter(s => s.status === 'done').length;
  const errors = steps.filter(s => s.status === 'error').length;
  const pct = total ? Math.round(((done + errors) / total) * 100) : 0;

  const fill = el.querySelector('.wf-progress-fill');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = `wf-progress-fill wf-pf-${runStatus}`;
  }

  const text = el.querySelector('.wf-progress-text');
  if (text) {
    const currentStep = steps.find(s => s.status === 'running');
    if (runStatus === 'running' && currentStep) {
      text.textContent = `${currentStep.name}... · ${done}/${total}`;
    } else {
      text.textContent = `${done}/${total} steps`;
    }
  }

  const eta = el.querySelector('.wf-progress-eta');
  if (eta && runStatus === 'running') {
    const est = estimateDuration(workflowId);
    if (est && startedAt) {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, est - elapsed);
      eta.textContent = remaining > 0 ? `~${formatDuration(remaining)} left` : 'finishing...';
    }
  }
}

// ─── SSE Event Handler ───
export function handleWorkflowEvent(eventName, data) {
  if (eventName === 'workflow:update') {
    // Update in-memory
    let run = app.workflowRuns.find(r => r.runId === data.runId);
    if (!run && data.workflowId) {
      run = { runId: data.runId, workflowId: data.workflowId, workflowName: data.workflowName, status: data.status, startedAt: Date.now(), endedAt: null, error: null };
      app.workflowRuns.unshift(run);
      renderRunList();
    }
    if (run) run.status = data.status === 'running' && !data.stepId ? 'running' : run.status;

    // Routing info (conditional edge decision)
    if (data.routing) {
      const routeEl = document.getElementById(`wf-route-info-${data.runId}`);
      if (!routeEl) {
        const stepsContainer = document.getElementById(`wf-steps-${data.runId}`);
        if (stepsContainer) {
          const div = document.createElement('div');
          div.id = `wf-route-info-${data.runId}`;
          div.className = 'wf-route-info';
          div.innerHTML = `⟲ Cycle ${data.routing.iteration}/${data.routing.maxIterations} — ${data.routing.matched ? '✓ Pattern matched → pass' : '✗ No match → continue'}`;
          stepsContainer.appendChild(div);
          setTimeout(() => div.remove(), 5000);
        }
      }
    }

    // Update step card in real-time
    if (data.stepId) {
      const card = document.getElementById(`wf-step-${data.runId}-${data.stepId}`);
      if (card) {
        card.className = `wf-step-card wf-sc-${data.status}`;
        const icon = card.querySelector('.wf-sc-status-icon');
        if (icon) icon.textContent = { pending: '○', running: '⟳', done: '✓', error: '✗' }[data.status] || '○';
        const dur = card.querySelector('.wf-sc-duration');
        if (dur && data.startedAt && data.endedAt) dur.textContent = `${((data.endedAt - data.startedAt) / 1000).toFixed(1)}s`;
        else if (dur && data.status === 'running') dur.textContent = '…';

        // Update iteration badge
        if (data.iteration && data.iteration > 1) {
          let iterEl = card.querySelector('.wf-sc-iter');
          if (!iterEl) {
            iterEl = document.createElement('span');
            iterEl.className = 'wf-sc-iter';
            const nameEl = card.querySelector('.wf-sc-name');
            if (nameEl) nameEl.after(iterEl);
          }
          iterEl.textContent = `×${data.iteration}`;
        }

        // Add output if done
        if ((data.status === 'done' || data.status === 'error') && (data.output || data.error)) {
          let outputEl = card.querySelector('.wf-sc-output');
          if (!outputEl) {
            outputEl = document.createElement('div');
            outputEl.className = 'wf-sc-output';
            outputEl.style.display = 'none';
            card.appendChild(outputEl);
          }
          // Update output content (may change on re-runs due to cycles)
          const copyBtn = data.output ? `<button class="wf-sc-copy-btn" data-action="copy-step" data-runid="${esc(data.runId)}" data-stepid="${esc(data.stepId)}" title="Copy">Copy</button>` : '';
          outputEl.innerHTML = `<pre class="wf-sc-output-body"${data.error ? ' style="color:var(--red)"' : ''}>${esc(data.output || data.error || '')}</pre>${copyBtn}`;
          // Add expand icon
          if (!card.querySelector('.wf-sc-expand-icon')) {
            const head = card.querySelector('.wf-sc-head');
            if (head) { const span = document.createElement('span'); span.className = 'wf-sc-expand-icon'; span.textContent = '▸'; head.appendChild(span); }
          }

          // Auto-expand completed step output
          if (data.status === 'done') {
            outputEl.style.display = '';
            card.classList.add('expanded');
          }
        }

        // Auto-scroll: scroll running step into view
        if (data.status === 'running') {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      // Update progress bar
      if (run) {
        updateProgressBar(data.runId, 'running', run.workflowId, run.startedAt);
      }
    }
  }

  if (eventName === 'workflow:complete') {
    const run = app.workflowRuns.find(r => r.runId === data.runId);
    if (run) { run.status = 'done'; run.endedAt = data.endedAt; }
    renderRunList();
    showToast('Workflow complete', 'success');
    if (app._activeWorkflowRunId === data.runId) selectWorkflowRun(data.runId);
  }

  if (eventName === 'workflow:error') {
    const run = app.workflowRuns.find(r => r.runId === data.runId);
    if (run) { run.status = 'error'; run.error = data.error; run.endedAt = data.endedAt; }
    renderRunList();
    showToast('Workflow error: ' + (data.error || 'Unknown'), 'error');
    if (app._activeWorkflowRunId === data.runId) selectWorkflowRun(data.runId);
  }

  if (eventName === 'schedule:fired') {
    showToast(`⏰ 스케줄 실행: ${data.workflowName}`, 'info');
    loadWorkflowRuns();
  }
  if (eventName === 'schedule:update') {
    loadSchedules();
  }
  if (eventName === 'schedule:error') {
    showToast(`⏰ 스케줄 실행 실패: ${data.error || 'Unknown'}`, 'error');
  }
}

// ─── Schedule Functions ───

const PRESET_LABELS = { daily: '매일', weekly: '매주', monthly: '매월' };
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

async function loadSchedules() {
  try {
    const res = await fetch('/api/workflows/schedules');
    app.workflowSchedules = await res.json();
  } catch { app.workflowSchedules = []; }
}

function getScheduleForWorkflow(workflowId) {
  return (app.workflowSchedules || []).find(s => s.workflowId === workflowId);
}

function formatScheduleDesc(sched) {
  if (!sched) return '';
  const h = String(sched.hour ?? 9).padStart(2, '0') + ':00';
  if (sched.preset === 'daily') return `매일 ${h}`;
  if (sched.preset === 'weekly') return `매주 ${DAY_LABELS[sched.day ?? 1]}요일 ${h}`;
  if (sched.preset === 'monthly') return `매월 ${sched.day ?? 1}일 ${h}`;
  return sched.preset;
}

function openSchedulePanel() {
  const id = app._activeWorkflowDefId;
  if (!id) return;
  const panel = document.getElementById('wf-schedule-panel');
  if (!panel) return;

  const existing = getScheduleForWorkflow(id);
  const preset = existing?.preset || 'weekly';
  const hour = existing?.hour ?? 9;
  const day = existing?.day ?? 1;
  const enabled = existing?.enabled ?? true;

  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="wf-sched-header">
      <span>Schedule</span>
      <button class="dt-icon-btn" data-action="close-schedule" title="Close">✕</button>
    </div>
    <div class="wf-sched-body">
      <div class="wf-sched-row">
        <label>반복</label>
        <select id="wf-sched-preset">
          <option value="daily"${preset === 'daily' ? ' selected' : ''}>매일</option>
          <option value="weekly"${preset === 'weekly' ? ' selected' : ''}>매주</option>
          <option value="monthly"${preset === 'monthly' ? ' selected' : ''}>매월</option>
        </select>
      </div>
      <div class="wf-sched-row" id="wf-sched-day-row">
        <label id="wf-sched-day-label">${preset === 'monthly' ? '날짜' : '요일'}</label>
        ${preset === 'monthly'
          ? `<select id="wf-sched-day">${Array.from({length: 28}, (_, i) => `<option value="${i + 1}"${(i + 1) === day ? ' selected' : ''}>${i + 1}일</option>`).join('')}</select>`
          : `<select id="wf-sched-day">${DAY_LABELS.map((d, i) => `<option value="${i}"${i === day ? ' selected' : ''}>${d}요일</option>`).join('')}</select>`
        }
      </div>
      <div class="wf-sched-row">
        <label>시간</label>
        <select id="wf-sched-hour">${Array.from({length: 24}, (_, i) => `<option value="${i}"${i === hour ? ' selected' : ''}>${String(i).padStart(2, '0')}:00</option>`).join('')}</select>
      </div>
      ${existing ? `
        <div class="wf-sched-row">
          <label>상태</label>
          <span class="wf-sched-status ${enabled ? 'active' : 'paused'}">${enabled ? '활성' : '일시정지'}</span>
          ${existing.nextRunAt ? `<span class="wf-sched-next">다음: ${new Date(existing.nextRunAt).toLocaleString('ko-KR')}</span>` : ''}
        </div>
      ` : ''}
      <div class="wf-sched-actions">
        <button class="btn btn-primary btn-sm" data-action="save-schedule">💾 ${existing ? '수정' : '저장'}</button>
        ${existing ? `
          <button class="btn btn-sm" data-action="toggle-schedule" data-id="${existing.id}">${enabled ? '⏸ 일시정지' : '▶ 활성화'}</button>
          <button class="btn btn-sm btn-danger" data-action="delete-schedule" data-id="${existing.id}">삭제</button>
        ` : ''}
      </div>
    </div>
  `;

  // Preset change handler: toggle day row visibility
  const presetSel = document.getElementById('wf-sched-preset');
  presetSel?.addEventListener('change', () => {
    const dayRow = document.getElementById('wf-sched-day-row');
    if (presetSel.value === 'daily') {
      dayRow.style.display = 'none';
    } else {
      dayRow.style.display = '';
      openSchedulePanel(); // Re-render with correct day options
    }
  });
  // Hide day row for daily
  if (preset === 'daily') {
    const dayRow = document.getElementById('wf-sched-day-row');
    if (dayRow) dayRow.style.display = 'none';
  }
}

function closeSchedulePanel() {
  const panel = document.getElementById('wf-schedule-panel');
  if (panel) panel.style.display = 'none';
}

async function saveSchedule() {
  const id = app._activeWorkflowDefId;
  if (!id) return;
  const def = app.workflowDefs.find(d => d.id === id);
  const existing = getScheduleForWorkflow(id);

  const preset = document.getElementById('wf-sched-preset')?.value || 'weekly';
  const hour = parseInt(document.getElementById('wf-sched-hour')?.value || '9');
  const day = parseInt(document.getElementById('wf-sched-day')?.value || '1');

  // Collect current input values as default inputs for scheduled runs
  const inputs = {};
  for (const inp of (def?.inputs || [])) {
    const el = document.getElementById(`wf-inp-${inp.key}`);
    if (el) inputs[inp.key] = el.value;
  }

  try {
    if (existing) {
      await fetch(`/api/workflows/schedules/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset, hour, day, inputs })
      });
      showToast('스케줄 수정됨', 'success');
    } else {
      await fetch('/api/workflows/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: id, workflowName: def?.name || id, inputs, preset, hour, day })
      });
      showToast('스케줄 등록됨', 'success');
    }
    await loadSchedules();
    openSchedulePanel(); // Refresh panel
    renderDefList(); // Refresh schedule badges
  } catch (err) {
    showToast('스케줄 저장 실패: ' + err.message, 'error');
  }
}

async function toggleSchedule(schedId) {
  const sched = (app.workflowSchedules || []).find(s => s.id === schedId);
  if (!sched) return;
  try {
    await fetch(`/api/workflows/schedules/${schedId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !sched.enabled })
    });
    showToast(sched.enabled ? '스케줄 일시정지' : '스케줄 활성화', 'info');
    await loadSchedules();
    openSchedulePanel();
    renderDefList();
  } catch (err) {
    showToast('실패: ' + err.message, 'error');
  }
}

async function deleteSchedule(schedId) {
  try {
    await fetch(`/api/workflows/schedules/${schedId}`, { method: 'DELETE' });
    showToast('스케줄 삭제됨', 'info');
    await loadSchedules();
    closeSchedulePanel();
    renderDefList();
  } catch (err) {
    showToast('삭제 실패: ' + err.message, 'error');
  }
}
