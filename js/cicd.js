// ─── CI/CD Module: GitHub Actions Integration ───
import { app } from './state.js';
import { esc, showToast, timeAgo, fetchJson, fetchText, postJson } from './utils.js';
import { registerClickActions, registerChangeActions } from './actions.js';

// ─── Init ───
export function initCicd() {
  if (app._cicdInitialized && app._cicdProject) return;
  app._cicdInitialized = true;
  // Auto-select first project
  if (!app._cicdProject && app.projectList.length) {
    app._cicdProject = app.projectList[0].id;
  }
  renderProjectSelector();
  if (app._cicdProject) loadCicdRuns();
  else renderCicdEmpty('No projects configured');
}

function renderProjectSelector() {
  const sel = document.getElementById('cicd-project-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select Project</option>' +
    app.projectList.map(p =>
      `<option value="${esc(p.id)}" ${p.id === app._cicdProject ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');
}

export function filterCicdByProject(id) {
  app._cicdProject = id || null;
  app._cicdDetailRun = null;
  if (id) loadCicdRuns();
  else renderCicdEmpty('Select a project to view CI/CD pipelines');
}

// ─── Load Runs ───
export async function loadCicdRuns() {
  if (!app._cicdProject) return;
  app._cicdLoading = true;
  renderCicdLoading();
  try {
    const [runs, workflows] = await Promise.all([
      fetchJson(`/api/cicd/runs/${app._cicdProject}`),
      fetchJson(`/api/cicd/workflows/${app._cicdProject}`),
    ]);
    app.cicdRuns = Array.isArray(runs) ? runs : [];
    app.cicdWorkflows = Array.isArray(workflows) ? workflows : [];
    renderCicdRuns();
    // Auto-poll if any runs are in_progress or queued
    manageCicdPolling();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('gh:')) {
      renderCicdEmpty(`<code>gh</code> CLI not found.<br><span style="font-size:.8rem;color:var(--text-3)">Install: <code>winget install GitHub.cli</code> then <code>gh auth login</code></span>`);
    } else if (msg.includes('auth') || msg.includes('401') || msg.includes('login')) {
      renderCicdEmpty(`<code>gh</code> not authenticated.<br><span style="font-size:.8rem;color:var(--text-3)">Run <code>gh auth login</code> in your terminal</span>`);
    } else {
      renderCicdEmpty(`Failed to load: ${esc(msg)}`);
    }
  }
  app._cicdLoading = false;
}

// ─── Auto-poll for running builds ───
function manageCicdPolling() {
  const hasRunning = app.cicdRuns.some(r => r.status === 'in_progress' || r.status === 'queued');
  if (hasRunning && !app._cicdPollTimer) {
    app._cicdPollTimer = setInterval(() => {
      if (document.getElementById('cicd-view')?.classList.contains('active')) {
        loadCicdRuns();
      }
    }, 10000);
  } else if (!hasRunning && app._cicdPollTimer) {
    clearInterval(app._cicdPollTimer);
    app._cicdPollTimer = null;
  }
}

// ─── Render Runs ───
function renderCicdRuns() {
  const el = document.getElementById('cicd-content');
  if (!el) return;
  const runs = app.cicdRuns;
  if (!runs.length) { renderCicdEmpty('No workflow runs found'); return; }

  const workflowFilter = document.getElementById('cicd-workflow-filter');
  if (workflowFilter && !workflowFilter.querySelector('option[value]')) {
    const wfNames = [...new Set(runs.map(r => r.workflowName).filter(Boolean))];
    workflowFilter.innerHTML = '<option value="">All Workflows</option>' +
      wfNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  const filter = workflowFilter?.value || '';
  const filtered = filter ? runs.filter(r => r.workflowName === filter) : runs;

  // Summary stats
  const total = filtered.length;
  const success = filtered.filter(r => r.conclusion === 'success').length;
  const failed = filtered.filter(r => r.conclusion === 'failure').length;
  const running = filtered.filter(r => r.status === 'in_progress').length;

  const summaryEl = document.getElementById('cicd-summary');
  if (summaryEl) {
    const passPct = total ? (success / total * 100).toFixed(1) : 0;
    const failPct = total ? (failed / total * 100).toFixed(1) : 0;
    summaryEl.innerHTML = `
      <span class="cs-stat"><span class="cs-num">${total}</span> total</span>
      <span class="cs-stat cs-success${success === 0 ? ' cs-dim' : ''}"><span class="cs-num">${success}</span> passed</span>
      <span class="cs-stat cs-fail${failed === 0 ? ' cs-dim' : ''}"><span class="cs-num">${failed}</span> failed</span>
      ${running ? `<span class="cs-stat cs-running"><span class="cs-num">${running}</span> running</span>` : ''}
      <div class="cs-progress"><div class="cs-bar cs-bar-pass" style="width:${passPct}%"></div><div class="cs-bar cs-bar-fail" style="width:${failPct}%"></div></div>
    `;
  }

  const polling = !!app._cicdPollTimer;
  el.innerHTML = `${polling ? '<div class="cicd-poll-indicator">Auto-refreshing every 10s</div>' : ''}<table class="cicd-table">
    <thead><tr>
      <th style="width:28px"></th>
      <th>Workflow</th>
      <th>Branch</th>
      <th style="width:90px">Status</th>
      <th style="width:100px">Duration</th>
      <th style="width:120px">Updated</th>
      <th style="width:60px"></th>
    </tr></thead>
    <tbody>${filtered.map(r => renderRunRow(r)).join('')}</tbody>
  </table>`;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      const runId = parseInt(btn.dataset.runid);
      if (btn.dataset.action === 'show-detail') showCicdDetail(runId);
      else if (btn.dataset.action === 'cancel-run') cancelCicdRun(runId);
      else if (btn.dataset.action === 'rerun') rerunCicd(runId, btn.dataset.failed === 'true');
    });
  }
}

function renderRunRow(r) {
  const icon = statusIcon(r.status, r.conclusion);
  const statusCls = statusClass(r.status, r.conclusion);
  const statusLabel = r.status === 'completed' ? (r.conclusion || 'unknown') : r.status;
  const duration = r.updatedAt && r.createdAt ? formatDuration(new Date(r.updatedAt) - new Date(r.createdAt)) : '-';
  const rowCls = r.conclusion || r.status;
  return `<tr class="cicd-run-row row-${rowCls}" data-action="show-detail" data-runid="${r.databaseId}">
    <td class="cicd-icon">${icon}</td>
    <td>
      <div class="cr-title">${esc(r.displayTitle || r.name || 'Run')}</div>
      <div class="cr-workflow">${esc((r.workflowName || '').replace('.github/workflows/', ''))}</div>
    </td>
    <td><span class="cr-branch">${esc(r.headBranch || '-')}</span></td>
    <td><span class="cicd-status ${statusCls}">${statusLabel}</span></td>
    <td class="cr-duration">${duration}</td>
    <td class="cr-updated">${r.updatedAt ? timeAgo(r.updatedAt) : '-'}</td>
    <td class="cr-actions">
      ${r.status === 'in_progress' ? `<button class="cr-act-btn" data-action="cancel-run" data-runid="${r.databaseId}" title="Cancel">✕</button>` : ''}
      ${r.conclusion === 'failure' ? `<button class="cr-act-btn" data-action="rerun" data-runid="${r.databaseId}" data-failed="true" title="Rerun failed">↻</button>` : ''}
    </td>
  </tr>`;
}

// ─── Run Detail ───
export async function showCicdDetail(runId) {
  app._cicdDetailRun = runId;
  const panel = document.getElementById('cicd-detail');
  if (!panel) return;
  panel.classList.add('open');
  panel.innerHTML = '<div class="cicd-loading">Loading run details...</div>';
  if (!panel.dataset.delegated) {
    panel.dataset.delegated = '1';
    panel.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const runId = parseInt(btn.dataset.runid);
      if (btn.dataset.action === 'close-detail') closeCicdDetail();
      else if (btn.dataset.action === 'rerun') rerunCicd(runId, btn.dataset.failed === 'true');
      else if (btn.dataset.action === 'forge-fix') forgeFixCicd(runId);
      else if (btn.dataset.action === 'view-logs') viewCicdLogs(runId);
    });
  }
  try {
    const detail = await fetchJson(`/api/cicd/runs/${app._cicdProject}/${runId}`);
    renderCicdDetail(detail);
  } catch (err) {
    panel.innerHTML = `<div class="cicd-empty"><div class="je-title">Error</div><div class="je-sub">${esc(err.message)}</div></div>`;
  }
}

function renderCicdDetail(run) {
  const panel = document.getElementById('cicd-detail');
  const jobs = run.jobs || [];
  panel.innerHTML = `
    <div class="cd-head">
      <div class="cd-head-left">
        <span class="cd-status-icon">${statusIcon(run.status, run.conclusion)}</span>
        <div>
          <div class="cd-title">${esc(run.displayTitle || run.name)}</div>
          <div class="cd-sub">${esc(run.workflowName || '')} #${run.databaseId}</div>
        </div>
      </div>
      <button class="jd-close" data-action="close-detail">✕</button>
    </div>
    <div class="cd-body">
      <div class="cd-meta">
        <span class="cd-meta-label">Branch</span><span class="cd-meta-value">${esc(run.headBranch || '-')}</span>
        <span class="cd-meta-label">Event</span><span class="cd-meta-value">${esc(run.event || '-')}</span>
        <span class="cd-meta-label">Commit</span><span class="cd-meta-value cd-mono">${esc((run.headSha || '').slice(0, 7))}</span>
        <span class="cd-meta-label">Started</span><span class="cd-meta-value">${run.createdAt ? new Date(run.createdAt).toLocaleString() : '-'}</span>
      </div>
      <div class="cd-jobs-title">Jobs (${jobs.length})</div>
      <div class="cd-jobs">${jobs.map(j => renderJob(j)).join('')}</div>
      <div class="cd-actions">
        <button class="btn" data-action="rerun" data-runid="${run.databaseId}" data-failed="false">Rerun All</button>
        ${run.conclusion === 'failure' ? `<button class="btn primary" data-action="rerun" data-runid="${run.databaseId}" data-failed="true">Rerun Failed</button>` : ''}
        ${run.conclusion === 'failure' ? `<button class="btn jd-forge-btn" data-action="forge-fix" data-runid="${run.databaseId}">🔥 Fix with Forge</button>` : ''}
        <button class="btn" data-action="view-logs" data-runid="${run.databaseId}">View Full Logs</button>
      </div>
    </div>
  `;
}

function renderJob(j) {
  const icon = statusIcon(j.status, j.conclusion);
  const dur = j.completedAt && j.startedAt ? formatDuration(new Date(j.completedAt) - new Date(j.startedAt)) : '-';
  const steps = (j.steps || []).map(s =>
    `<div class="cd-step ${stepClass(s.conclusion)}"><span class="cd-step-icon">${stepIcon(s.conclusion)}</span><span class="cd-step-name">${esc(s.name)}</span><span class="cd-step-dur">${s.completedAt && s.startedAt ? formatDuration(new Date(s.completedAt) - new Date(s.startedAt)) : ''}</span></div>`
  ).join('');
  return `<details class="cd-job ${statusClass(j.status, j.conclusion)}">
    <summary class="cd-job-head">${icon} <span class="cd-job-name">${esc(j.name)}</span> <span class="cd-job-dur">${dur}</span></summary>
    <div class="cd-job-steps">${steps || '<div class="cd-no-steps">No steps</div>'}</div>
  </details>`;
}

export function closeCicdDetail() {
  app._cicdDetailRun = null;
  document.getElementById('cicd-detail')?.classList.remove('open');
}

// ─── Actions ───
export async function rerunCicd(runId, failed) {
  try {
    await postJson(`/api/cicd/runs/${app._cicdProject}/${runId}/rerun`, { failed });
    showToast(failed ? 'Rerunning failed jobs...' : 'Rerunning all jobs...');
    setTimeout(loadCicdRuns, 2000);
  } catch (err) { showToast('Rerun failed: ' + err.message, 'error'); }
}

export async function cancelCicdRun(runId) {
  try {
    await postJson(`/api/cicd/runs/${app._cicdProject}/${runId}/cancel`, {});
    showToast('Run cancelled');
    setTimeout(loadCicdRuns, 1000);
  } catch (err) { showToast('Cancel failed: ' + err.message, 'error'); }
}

export async function viewCicdLogs(runId) {
  const panel = document.getElementById('cicd-detail');
  const logsEl = panel?.querySelector('.cd-body');
  if (!logsEl) return;
  logsEl.innerHTML = '<div class="cicd-loading">Fetching logs...</div>';
  try {
    const text = await fetchText(`/api/cicd/runs/${app._cicdProject}/${runId}/logs`);
    logsEl.innerHTML = `<pre class="cd-logs">${esc(text)}</pre>`;
  } catch { logsEl.innerHTML = '<div class="cicd-empty">Failed to load logs</div>'; }
}

export function filterCicdByWorkflow() {
  renderCicdRuns();
}

// ─── Helpers ───
function renderCicdEmpty(msg) {
  const el = document.getElementById('cicd-content');
  if (el) el.innerHTML = `<div class="cicd-empty"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="var(--text-3)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg><div class="je-title">${msg}</div></div>`;
}

function renderCicdLoading() {
  const el = document.getElementById('cicd-content');
  if (el) el.innerHTML = '<div class="cicd-loading">Loading workflow runs...</div>';
}

function statusIcon(status, conclusion) {
  if (status === 'in_progress') return '<span class="ci-icon ci-running">●</span>';
  if (status === 'queued') return '<span class="ci-icon ci-queued">○</span>';
  if (conclusion === 'success') return '<span class="ci-icon ci-success">✓</span>';
  if (conclusion === 'failure') return '<span class="ci-icon ci-failure">✕</span>';
  if (conclusion === 'cancelled') return '<span class="ci-icon ci-cancelled">⊘</span>';
  if (conclusion === 'skipped') return '<span class="ci-icon ci-skipped">→</span>';
  return '<span class="ci-icon ci-unknown">?</span>';
}

function statusClass(status, conclusion) {
  if (status === 'in_progress') return 'st-running';
  if (status === 'queued') return 'st-queued';
  if (conclusion === 'success') return 'st-success';
  if (conclusion === 'failure') return 'st-failure';
  if (conclusion === 'cancelled') return 'st-cancelled';
  return 'st-unknown';
}

function stepIcon(conclusion) {
  if (conclusion === 'success') return '✓';
  if (conclusion === 'failure') return '✕';
  if (conclusion === 'skipped') return '→';
  return '○';
}

function stepClass(conclusion) {
  if (conclusion === 'success') return 'step-ok';
  if (conclusion === 'failure') return 'step-fail';
  if (conclusion === 'skipped') return 'step-skip';
  return '';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── Forge Integration ───
export async function forgeFixCicd(runId) {
  if (!app._cicdProject) return;
  showToast('Fetching failure logs...', 'info');

  try {
    const logsText = await fetchText(`/api/cicd/runs/${app._cicdProject}/${runId}/logs`);

    const run = app.cicdRuns?.find(r => r.databaseId === runId);
    const failedJobs = (run?.jobs || [])
      .filter(j => j.conclusion === 'failure')
      .map(j => ({
        name: j.name,
        failedSteps: (j.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name)
      }));

    const errorContext = _extractErrorLines(logsText, 150);
    const filePaths = _extractFilePaths(logsText);

    let task = `Fix CI/CD failure: ${run?.displayTitle || 'Workflow Run'}\n`;
    task += `Branch: ${run?.headBranch || 'unknown'}\n\n`;
    if (failedJobs.length) {
      task += 'Failed jobs:\n';
      failedJobs.forEach(j => {
        task += `- ${j.name}`;
        if (j.failedSteps.length) task += `: ${j.failedSteps.join(', ')}`;
        task += '\n';
      });
      task += '\n';
    }
    if (errorContext) task += 'Error output:\n```\n' + errorContext + '\n```';

    openForgeWithPrefill({
      task,
      referenceFiles: filePaths.join('\n'),
      projectId: app._cicdProject,
      plan: 'quick',
      source: 'cicd',
      sourceRef: String(runId),
    });
  } catch (err) {
    showToast('Failed to prepare: ' + err.message, 'error');
  }
}

function _extractErrorLines(logs, maxLines) {
  if (!logs) return '';
  const lines = logs.split('\n');
  const indicators = ['error', 'Error', 'ERROR', 'FAIL', 'fail', 'exception', 'Exception', 'TypeError', 'ReferenceError'];
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (indicators.some(ind => lines[i].includes(ind))) {
      for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 5); j++) {
        if (!result.includes(lines[j])) result.push(lines[j]);
      }
    }
  }
  return result.slice(0, maxLines).join('\n');
}

function _extractFilePaths(logs) {
  if (!logs) return [];
  const regex = /((?:src|lib|app|test|spec|pages|components)\/[\w./-]+\.\w+)/g;
  const paths = new Set();
  let m;
  while ((m = regex.exec(logs)) !== null) paths.add(m[1]);
  return [...paths].slice(0, 10);
}

// ─── Action Registration ───
registerClickActions({
  'refresh-cicd': loadCicdRuns,
});
registerChangeActions({
  'cicd-project-filter': (el) => filterCicdByProject(el.value),
  'cicd-workflow-filter': filterCicdByWorkflow,
});
