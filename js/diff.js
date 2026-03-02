// ─── Diff: Changes tab, diff rendering, git ops, auto-commit, branches ───
import { app } from './state.js';
import { esc, showToast, DIFF_LINE_LIMIT, fetchJson, postJson } from './utils.js';
import { highlightLine, getLangFromPath } from './highlight.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';

// ─── Diff Utilities ───
function parseDiffToFiles(diffText) {
  if (!diffText || !diffText.trim()) return [];
  const chunks = diffText.split(/(?=^diff --git )/m);
  return chunks.filter(c => c.startsWith('diff ')).map(chunk => {
    const lines = chunk.split('\n');
    const m = lines[0].match(/b\/(.+)$/);
    return { path: m ? m[1] : '?', lines };
  });
}

function renderDiffTable(lines, filePath) {
  const lang = getLangFromPath(filePath);
  let oldN = 0, newN = 0, prevOldEnd = 0, prevNewEnd = 0, hunkCount = 0;
  const rows = [];
  let rowCount = 0;
  const totalLines = lines.length;
  let truncated = false;
  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (rowCount >= DIFF_LINE_LIMIT) { truncated = true; break; }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)/);
    if (hunkMatch) {
      const hunkOldStart = parseInt(hunkMatch[1], 10);
      const hunkNewStart = parseInt(hunkMatch[3], 10);
      if (hunkCount > 0) {
        const skipped = Math.max(hunkOldStart - prevOldEnd, hunkNewStart - prevNewEnd);
        if (skipped > 0) rows.push(`<tr class="dl-fold"><td class="dl-gutter" colspan="2"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></td><td class="dl-code" style="color:var(--text-3);font-style:italic;font-size:.75rem">... ${skipped} lines hidden ...</td></tr>`);
      }
      oldN = hunkOldStart; newN = hunkNewStart;
      rows.push(`<tr class="dl-hunk"><td class="dl-gutter" colspan="2"></td><td class="dl-code">${esc(line)}</td></tr>`);
      hunkCount++; continue;
    }
    const hl = lang ? highlightLine(line, lang) : esc(line);
    if (line.startsWith('+')) {
      rows.push(`<tr class="dl-add"><td class="dl-gutter"></td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${hl}</td></tr>`);
      newN++; prevNewEnd = newN;
    } else if (line.startsWith('-')) {
      rows.push(`<tr class="dl-del"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new"></td><td class="dl-code">${hl}</td></tr>`);
      oldN++; prevOldEnd = oldN;
    } else if (line !== '') {
      rows.push(`<tr class="dl-ctx"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${hl}</td></tr>`);
      oldN++; newN++; prevOldEnd = oldN; prevNewEnd = newN;
    }
    rowCount++;
  }
  if (truncated) {
    rows.push(`<tr class="dl-truncated"><td colspan="3" style="padding:8px 12px;text-align:center;color:var(--text-3);font-size:.78rem;background:var(--bg-surface);cursor:pointer" data-action="show-all-diff">Showing ${DIFF_LINE_LIMIT} of ${totalLines} lines \u2014 click to show all</td></tr>`);
  }
  return `<table>${rows.join('')}</table>`;
}

export function renderDiffTableFull(linesJson, filePath) {
  const lang = getLangFromPath(filePath || '');
  const lines = JSON.parse(linesJson);
  let oldN = 0, newN = 0, prevOldEnd = 0, prevNewEnd = 0, hunkCount = 0;
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)/);
    if (hunkMatch) {
      const hOld = parseInt(hunkMatch[1], 10), hNew = parseInt(hunkMatch[3], 10);
      if (hunkCount > 0) {
        const sk = Math.max(hOld - prevOldEnd, hNew - prevNewEnd);
        if (sk > 0) rows.push(`<tr class="dl-fold"><td class="dl-gutter" colspan="2"></td><td class="dl-code" style="color:var(--text-3);font-style:italic;font-size:.75rem">... ${sk} lines hidden ...</td></tr>`);
      }
      oldN = hOld; newN = hNew;
      rows.push(`<tr class="dl-hunk"><td class="dl-gutter" colspan="2"></td><td class="dl-code">${esc(line)}</td></tr>`);
      hunkCount++; continue;
    }
    const hl2 = lang ? highlightLine(line, lang) : esc(line);
    if (line.startsWith('+')) {
      rows.push(`<tr class="dl-add"><td class="dl-gutter"></td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${hl2}</td></tr>`);
      newN++; prevNewEnd = newN;
    } else if (line.startsWith('-')) {
      rows.push(`<tr class="dl-del"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new"></td><td class="dl-code">${hl2}</td></tr>`);
      oldN++; prevOldEnd = oldN;
    } else if (line !== '') {
      rows.push(`<tr class="dl-ctx"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${hl2}</td></tr>`);
      oldN++; newN++; prevOldEnd = oldN; prevNewEnd = newN;
    }
  }
  return `<table>${rows.join('')}</table>`;
}

function fileStatusLetter(status) {
  if (!status) return 'M';
  const s = status.charAt(0).toUpperCase();
  if (s === 'A') return 'A'; if (s === 'D') return 'D'; if (s === 'R') return 'R'; if (s === '?') return '?';
  return 'M';
}

function buildDiffPanel(filePath, fileInfo, sectionType, panelId) {
  const st = fileStatusLetter(fileInfo?.status);
  const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/') + 1) : '';
  const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
  const add = fileInfo?.additions || 0, del = fileInfo?.deletions || 0;
  const badge = sectionType === 'staged' ? '<span class="dp-badge staged">Staged</span>' : '<span class="dp-badge unstaged">Unstaged</span>';
  const isStaged = sectionType === 'staged';
  let actionsHtml = '<span class="dp-actions">';
  if (!isStaged) {
    actionsHtml += `<button class="dp-action" data-action="discard" data-file="${esc(filePath)}" title="Discard changes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg></button>`;
    actionsHtml += `<button class="dp-action" data-action="stage" data-file="${esc(filePath)}" title="Stage file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
  } else {
    actionsHtml += `<button class="dp-action" data-action="unstage" data-file="${esc(filePath)}" title="Unstage file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`;
  }
  actionsHtml += '</span>';
  return `<div class="diff-panel" id="${panelId}" data-file="${esc(filePath)}" data-section="${sectionType}">
    <div class="diff-panel-head">
      <span class="dp-chevron">\u25BC</span>
      <span class="dp-status st-${st}">${st}</span>
      <span class="dp-path" title="${esc(filePath)}"><span class="dp-dir">${esc(dir)}</span>${esc(name)}</span>
      <span class="dp-stat">${add ? `<span class="ps-add">+${add}</span>` : ''}${del ? `<span class="ps-del">-${del}</span>` : ''}</span>
      ${badge}${actionsHtml}
    </div>
    <div class="diff-panel-body"></div>
  </div>`;
}

function renderDiffSummary(targetId, stagedFiles, unstagedFiles) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const total = stagedFiles.length + unstagedFiles.length;
  const totalAdd = [...stagedFiles, ...unstagedFiles].reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = [...stagedFiles, ...unstagedFiles].reduce((s, f) => s + (f.deletions || 0), 0);
  if (!total) { el.innerHTML = ''; return; }
  el.innerHTML = `<span class="ds-files">${total} file${total > 1 ? 's' : ''}</span>` + (totalAdd ? `<span class="ds-add">+${totalAdd}</span>` : '') + (totalDel ? `<span class="ds-del">\u2212${totalDel}</span>` : '');
}

function renderDiffSidebar(stagedFiles, unstagedFiles) {
  const sb = document.getElementById('diff-sidebar-list');
  if (!sb) return;
  const buildGroup = (label, files, section) => {
    if (!files.length) return '';
    const isStaged = section === 'staged';
    const actionIcon = isStaged
      ? `<button class="ds-action" data-action="unstage-all" title="Unstage All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`
      : `<button class="ds-action" data-action="stage-all" title="Stage All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
    const discardIcon = !isStaged ? `<button class="ds-action" data-action="discard-all" title="Discard All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>` : '';
    let html = `<div class="ds-group" data-section="${section}"><div class="ds-group-head"><span class="ds-chevron">\u25BC</span>${label}<span class="ds-count">${files.length}</span><span class="ds-actions">${discardIcon}${actionIcon}</span></div><div class="ds-group-items">`;
    // Group files by directory
    const grouped = {};
    for (const f of files) {
      const dir = f.file.includes('/') ? f.file.substring(0, f.file.lastIndexOf('/') + 1) : '';
      if (!grouped[dir]) grouped[dir] = [];
      grouped[dir].push(f);
    }
    const dirs = Object.keys(grouped).sort((a, b) => { if (!a) return -1; if (!b) return 1; return a.localeCompare(b); });
    for (const dir of dirs) {
      if (dir) html += `<div class="diff-dir-group"><div class="diff-dir-head"><span class="dir-chevron">\u25BC</span><span>${esc(dir)}</span></div><div class="dir-files">`;
      for (const f of grouped[dir]) {
        const st = fileStatusLetter(f.status);
        const fname = f.file.includes('/') ? f.file.substring(f.file.lastIndexOf('/') + 1) : f.file;
        const pid = `dp-${section}-${f.file.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const stageBtn = isStaged
          ? `<button class="fi-action fa-unstage" data-action="unstage" data-file="${esc(f.file)}" title="Unstage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`
          : `<button class="fi-action fa-stage" data-action="stage" data-file="${esc(f.file)}" title="Stage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
        const discardBtn = !isStaged ? `<button class="fi-action fa-discard" data-action="discard" data-file="${esc(f.file)}" title="Discard"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg></button>` : '';
        html += `<div class="diff-file-item" data-panel="${pid}" data-file="${esc(f.file)}" data-action="scroll-to-panel">
          <span class="fi-status st-${st}">${st}</span><span class="fi-name" title="${esc(f.file)}">${esc(fname)}</span>
          <span class="fi-stat">${f.additions ? `<span class="fs-add">+${f.additions}</span>` : ''}${f.deletions ? `<span class="fs-del">-${f.deletions}</span>` : ''}</span>
          <span class="fi-actions">${discardBtn}${stageBtn}</span></div>`;
      }
      if (dir) html += '</div></div>';
    }
    html += '</div></div>';
    return html;
  };
  sb.innerHTML = buildGroup('Staged', stagedFiles, 'staged') + buildGroup('Unstaged', unstagedFiles, 'unstaged');
  if (!sb.dataset.delegated) {
    sb.dataset.delegated = '1';
    sb.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        const action = btn.dataset.action;
        const file = btn.dataset.file || btn.closest('[data-file]')?.dataset.file;
        const panel = btn.dataset.panel || btn.closest('[data-panel]')?.dataset.panel;
        if (action === 'stage-all') diffStageAll();
        else if (action === 'unstage-all') diffUnstageAll();
        else if (action === 'discard-all') diffDiscardAll();
        else if (action === 'stage' && file) diffStageFile(file);
        else if (action === 'unstage' && file) diffUnstageFile(file);
        else if (action === 'discard' && file) diffDiscardFile(file);
        else if (action === 'scroll-to-panel' && panel) scrollToDiffPanel(panel);
        return;
      }
      const groupHead = e.target.closest('.ds-group-head');
      if (groupHead) { groupHead.parentElement.classList.toggle('collapsed'); return; }
      const dirHead = e.target.closest('.diff-dir-head');
      if (dirHead) { dirHead.parentElement.classList.toggle('collapsed'); }
    });
  }
  updateCommitBar(stagedFiles.length);
}

function renderDiffPanels(targetId, stagedFiles, unstagedFiles, stagedDiff, unstagedDiff, prefix = 'dp') {
  const container = document.getElementById(targetId);
  if (!container) return;
  const stagedParsed = parseDiffToFiles(stagedDiff);
  const unstagedParsed = parseDiffToFiles(unstagedDiff);
  let html = '';
  if (stagedFiles.length) {
    html += `<div class="diff-section-label"><span class="dsl-dot" style="background:var(--accent)"></span>Staged</div>`;
    for (const f of stagedFiles) { const pid = `${prefix}-staged-${f.file.replace(/[^a-zA-Z0-9]/g, '_')}`; html += buildDiffPanel(f.file, f, 'staged', pid); }
  }
  if (unstagedFiles.length) {
    html += `<div class="diff-section-label"><span class="dsl-dot" style="background:var(--yellow)"></span>Unstaged</div>`;
    for (const f of unstagedFiles) { const pid = `${prefix}-unstaged-${f.file.replace(/[^a-zA-Z0-9]/g, '_')}`; html += buildDiffPanel(f.file, f, 'unstaged', pid); }
  }
  container.innerHTML = html;
  if (!container.dataset.delegated) {
    container.dataset.delegated = '1';
    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        const file = btn.dataset.file;
        if (btn.dataset.action === 'stage' && file) diffStageFile(file);
        else if (btn.dataset.action === 'unstage' && file) diffUnstageFile(file);
        else if (btn.dataset.action === 'discard' && file) diffDiscardFile(file);
        else if (btn.dataset.action === 'show-all-diff') {
          const body = btn.closest('.diff-panel-body');
          if (body) body.innerHTML = renderDiffTableFull(body.dataset.lines, body.dataset.filePath || '');
        }
        return;
      }
      const panelHead = e.target.closest('.diff-panel-head');
      if (panelHead && !e.target.closest('.dp-actions')) panelHead.parentElement.classList.toggle('collapsed');
    });
  }
  const renderBodies = (parsed, section) => {
    for (const p of parsed) {
      const f = (section === 'staged' ? stagedFiles : unstagedFiles).find(x => x.file === p.path || p.path.endsWith(x.file));
      const pid = `${prefix}-${section}-${(f?.file || p.path).replace(/[^a-zA-Z0-9]/g, '_')}`;
      const panel = document.getElementById(pid);
      if (panel) {
        const body = panel.querySelector('.diff-panel-body');
        const fp = f?.file || p.path || '';
        if (p.lines.length > DIFF_LINE_LIMIT) body.dataset.lines = JSON.stringify(p.lines);
        body.dataset.filePath = fp;
        body.innerHTML = renderDiffTable(p.lines, fp);
      }
    }
  };
  renderBodies(stagedParsed, 'staged');
  renderBodies(unstagedParsed, 'unstaged');
  // Fill untracked/no-diff panels with placeholder
  container.querySelectorAll('.diff-panel-body').forEach(body => {
    if (!body.innerHTML) body.innerHTML = '<div style="padding:12px 16px;color:var(--text-3);font-size:.8rem;font-style:italic">Untracked file — stage to see diff</div>';
  });
}

export function scrollToDiffPanel(pid) {
  const el = document.getElementById(pid);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.diff-file-item.active').forEach(x => x.classList.remove('active'));
  document.querySelector(`.diff-file-item[data-panel="${pid}"]`)?.classList.add('active');
  el.classList.remove('collapsed');
}

export function debouncedLoadDiff() {
  if (app._diffDebounceTimer) clearTimeout(app._diffDebounceTimer);
  app._diffDebounceTimer = setTimeout(() => { app._diffDebounceTimer = null; loadDiff(); }, 1000);
}

export async function loadDiff() {
  const sel = document.getElementById('diff-project');
  const projectId = sel.value;
  if (!projectId) return;
  if (app._diffAbort) { app._diffAbort.abort(); app._diffAbort = null; }
  app._diffAbort = new AbortController();
  const signal = app._diffAbort.signal;
  const mainEl = document.getElementById('diff-main');
  mainEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">Loading...</div>';
  updateDiffBranchInfo();
  try {
    const data = await fetchJson(`/api/projects/${projectId}/diff`, { signal });
    const stagedFiles = data.staged?.files || [], unstagedFiles = data.unstaged?.files || [];
    const stagedDiff = data.staged?.diff || '', unstagedDiff = data.unstaged?.diff || '';
    if (!stagedFiles.length && !unstagedFiles.length) {
      mainEl.innerHTML = ''; mainEl.appendChild(createDiffEmpty());
      document.getElementById('diff-sidebar-list').innerHTML = '';
      renderDiffSummary('diff-summary', [], []); updateCommitBar(0); return;
    }
    renderDiffSummary('diff-summary', stagedFiles, unstagedFiles);
    renderDiffSidebar(stagedFiles, unstagedFiles);
    mainEl.innerHTML = '';
    const panelsDiv = document.createElement('div');
    panelsDiv.id = 'diff-panels-inner'; panelsDiv.className = 'diff-main-inner';
    mainEl.appendChild(panelsDiv);
    renderDiffPanels('diff-panels-inner', stagedFiles, unstagedFiles, stagedDiff, unstagedDiff);
  } catch (err) {
    if (err.name === 'AbortError') return;
    mainEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red)">Error loading diff</div>';
  } finally { if (!signal.aborted) app._diffAbort = null; }
}

function createDiffEmpty() {
  const d = document.createElement('div');
  d.className = 'diff-empty';
  d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
    <span class="de-title">No changes</span><span class="de-sub">Working tree is clean</span>`;
  return d;
}

// ─── Diff Actions ───
function _diffProjectId() { return document.getElementById('diff-project')?.value; }

async function _diffGitAction(action, files) {
  const projectId = _diffProjectId();
  if (!projectId) return;
  try {
    await postJson(`/api/projects/${projectId}/git/${action}`, { files });
    loadDiff();
  } catch (err) { showToast(`${action} failed: ${err.message}`, 'error'); }
}

export function diffStageFile(file) { _diffGitAction('stage', [file]); }
export function diffUnstageFile(file) { _diffGitAction('unstage', [file]); }
export function diffDiscardFile(file) {
  if (!confirm(`Discard changes to "${file}"? This cannot be undone.`)) return;
  _diffGitAction('discard', [file]);
}
export function diffStageAll() { _diffGitAction('stage', ['--all']); }
export function diffUnstageAll() { _diffGitAction('unstage', ['--all']); }
export function diffDiscardAll() {
  if (!confirm('Discard ALL unstaged changes? This cannot be undone.')) return;
  const items = document.querySelectorAll('.ds-group[data-section="unstaged"] .diff-file-item');
  const files = [...items].map(el => el.dataset.file).filter(Boolean);
  if (files.length) _diffGitAction('discard', files);
}

export function diffExpandAll() { document.querySelectorAll('#diff-main .diff-panel.collapsed').forEach(p => p.classList.remove('collapsed')); }
export function diffCollapseAll() { document.querySelectorAll('#diff-main .diff-panel:not(.collapsed)').forEach(p => p.classList.add('collapsed')); }

export function filterDiffFiles() {
  const q = (document.getElementById('diff-file-search')?.value || '').toLowerCase().trim();
  document.querySelectorAll('#diff-sidebar-list .diff-file-item').forEach(el => { el.style.display = !q || (el.dataset.file || '').toLowerCase().includes(q) ? '' : 'none'; });
  document.querySelectorAll('#diff-main .diff-panel').forEach(el => { el.style.display = !q || (el.dataset.file || '').toLowerCase().includes(q) ? '' : 'none'; });
}

// ─── Commit Box ───
function updateCommitBar(stagedCount) {
  app._diffStagedCount = stagedCount;
  document.querySelector('.diff-commit-box')?.classList.toggle('no-staged', stagedCount === 0);
  const info = document.getElementById('dcb-staged-info'), btn = document.getElementById('dcb-commit-btn');
  if (!info) return;
  if (stagedCount > 0) { info.textContent = `${stagedCount} staged`; btn.disabled = false; }
  else { info.textContent = 'No staged files'; btn.disabled = true; }
}

export async function doManualCommit() {
  const msg = document.getElementById('diff-commit-msg')?.value?.trim();
  if (!msg) { showToast('Enter a commit message', 'info'); document.getElementById('diff-commit-msg')?.focus(); return; }
  const projectId = _diffProjectId(); if (!projectId) return;
  const btn = document.getElementById('dcb-commit-btn');
  btn.disabled = true; const origHTML = btn.innerHTML;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite;width:13px;height:13px"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Committing...';
  try {
    await postJson(`/api/projects/${projectId}/git/commit`, { message: msg });
    showToast('Committed: ' + msg, 'success'); document.getElementById('diff-commit-msg').value = '';
    loadDiff();
  } catch (err) { showToast('Commit error: ' + err.message, 'error'); }
  btn.disabled = false; btn.innerHTML = origHTML;
}

// ─── AI Commit Message ───
export async function generateCommitMsg() {
  const projectId = _diffProjectId(); if (!projectId) return;
  const btn = document.getElementById('dcb-ai-btn'), textarea = document.getElementById('diff-commit-msg');
  if (!btn || !textarea) return;
  btn.disabled = true; btn.classList.add('loading');
  textarea.classList.add('ai-loading'); textarea.value = '';
  textarea.placeholder = '\u2726 AI analyzing staged changes...';
  try {
    const data = await postJson(`/api/projects/${projectId}/generate-commit-msg`, {});
    if (data.message) { textarea.value = data.message; textarea.focus(); textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; showToast('Commit message generated', 'success'); }
  } catch (err) { showToast('AI error: ' + err.message, 'error'); }
  btn.disabled = false; btn.classList.remove('loading');
  textarea.classList.remove('ai-loading'); textarea.placeholder = 'Commit message (Ctrl+Enter to commit)';
}

// ─── Auto Commit ───
export async function updateDiffBranchInfo() {
  const el = document.getElementById('diff-branch-info');
  if (!el) return;
  const projectId = document.getElementById('diff-project')?.value;
  if (!projectId) { el.innerHTML = ''; app._acBranchInfo = null; return; }
  try {
    const data = await fetchJson(`/api/projects/${projectId}/git`);
    app._acBranchInfo = { branch: data.branch || 'unknown', worktrees: data.worktrees || [] };
    const branchSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><path d="M18 9a3 3 0 100-6 3 3 0 000 6z"/><path d="M6 21a3 3 0 100-6 3 3 0 000 6z"/><path d="M18 9c0 6-12 6-12 12"/></svg>`;
    let html = `<span class="dbi-branch" data-action="toggle-branch-dd">${branchSvg}${esc(data.branch || 'unknown')}<span class="dbi-chevron">\u25BC</span></span>`;
    if (data.worktrees?.length > 1) html += `<span class="dbi-wt" data-action="toggle-wt-dd">${data.worktrees.length} worktrees</span>`;
    // Stash count badge from SSE data
    const gitData = app.state.projects.get(projectId)?.git;
    if (gitData?.stashCount > 0) html += `<span class="dbi-stash" data-action="stash-list" title="View stashes">${gitData.stashCount} stash${gitData.stashCount > 1 ? 'es' : ''}</span>`;
    html += '<div class="branch-dropdown" id="branch-dropdown"></div>';
    el.innerHTML = html;
    if (!el.dataset.delegated) {
      el.dataset.delegated = '1';
      el.addEventListener('click', e => {
        const action = e.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'toggle-branch-dd') { e.stopPropagation(); toggleBranchDropdown(e); }
        else if (action.dataset.action === 'toggle-wt-dd') { e.stopPropagation(); toggleWorktreeDropdown(e); }
      });
    }
  } catch { el.innerHTML = ''; app._acBranchInfo = null; }
}

export async function toggleBranchDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('branch-dropdown');
  if (!dd) return;
  if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
  const projectId = _diffProjectId(); if (!projectId) return;
  dd.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-3);font-size:.76rem">Loading...</div>';
  dd.classList.add('open');
  try {
    const data = await fetchJson(`/api/projects/${projectId}/branches`);
    const current = data.current || app._acBranchInfo?.branch || '';
    const locals = data.local || [];
    const remotes = (data.remote || []).filter(r => !locals.includes(r.replace(/^origin\//, '')));
    let html = '<div class="bd-search"><input type="text" placeholder="Search branches..." data-action="branch-search" autofocus></div>';
    if (locals.length) {
      html += '<div class="bd-section"><div class="bd-label">Local</div>';
      for (const b of locals) {
        const isCurrent = b === current, canDelete = !isCurrent && !['main', 'master'].includes(b);
        html += `<div class="bd-item ${isCurrent ? 'current' : ''}" data-branch="${esc(b)}" data-action="switch-branch"><span class="bd-check">${isCurrent ? '\u25CF' : ''}</span><span class="bd-name">${esc(b)}</span>${canDelete ? `<span class="bd-delete" data-action="delete-branch" data-project="${projectId}" title="Delete branch">&times;</span>` : ''}</div>`;
      }
      html += '</div>';
    }
    if (remotes.length) {
      html += '<div class="bd-section"><div class="bd-label">Remote</div>';
      for (const b of remotes) { const short = b.replace(/^origin\//, ''); html += `<div class="bd-item" data-branch="${esc(short)}" data-action="switch-branch"><span class="bd-check"></span><span class="bd-name">${esc(b)}</span></div>`; }
      html += '</div>';
    }
    const wts = data.worktrees || app._acBranchInfo?.worktrees || [];
    if (wts.length > 1) {
      html += '<div class="bd-section" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><div class="bd-label">Worktrees</div>';
      for (const wt of wts) {
        const wtName = wt.path ? wt.path.split(/[/\\]/).pop() : wt.branch || '?';
        const isCurrent = wt.branch === current;
        html += `<div class="bd-item ${isCurrent ? 'current' : ''}" data-branch="${esc(wt.branch || '')}" data-action="switch-branch"><span class="bd-check">${isCurrent ? '\u25CF' : ''}</span><span class="bd-name">${esc(wtName)} <span style="color:var(--text-3);font-size:.68rem">(${esc(wt.branch || '')})</span></span></div>`;
      }
      html += '</div>';
    }
    html += `<div class="branch-create-row"><input type="text" id="new-branch-input" placeholder="New branch name..." data-project="${projectId}"><button data-action="create-branch" data-project="${projectId}">Create</button></div>`;
    dd.innerHTML = html;
    if (!dd.dataset.delegated) {
      dd.dataset.delegated = '1';
      dd.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        e.stopPropagation();
        const action = el.dataset.action;
        if (action === 'delete-branch') { deleteBranch(el.dataset.project, el.closest('[data-branch]')?.dataset.branch); }
        else if (action === 'switch-branch') { switchBranch(el.dataset.branch); }
        else if (action === 'create-branch') { createBranch(el.dataset.project); }
      });
      dd.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.id === 'new-branch-input') { e.stopPropagation(); createBranch(e.target.dataset.project); }
      });
      dd.addEventListener('input', e => {
        if (e.target.dataset.action === 'branch-search') filterBranchDropdown(e.target.value);
      });
    }
    dd.querySelector('.bd-search input')?.focus();
  } catch (err) { dd.innerHTML = `<div style="padding:12px;text-align:center;color:var(--red);font-size:.76rem">Error: ${esc(err.message)}</div>`; }
  const close = ev => { if (!dd.contains(ev.target)) { dd.classList.remove('open'); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

export function filterBranchDropdown(q) {
  const dd = document.getElementById('branch-dropdown'); if (!dd) return;
  const query = q.toLowerCase().trim();
  dd.querySelectorAll('.bd-item').forEach(item => { item.style.display = !query || (item.dataset.branch || '').toLowerCase().includes(query) ? '' : 'none'; });
}

export async function switchBranch(branch) {
  const projectId = _diffProjectId(); if (!projectId) return;
  const dd = document.getElementById('branch-dropdown'); if (dd) dd.classList.remove('open');
  if (branch === app._acBranchInfo?.branch) return;
  showToast(`Switching to ${branch}...`, 'info');
  try {
    await postJson(`/api/projects/${projectId}/git/checkout`, { branch });
    showToast(`Switched to ${branch}`, 'success'); loadDiff();
  } catch (err) { showToast('Switch error: ' + err.message, 'error'); }
}

export function toggleWorktreeDropdown(e) { toggleBranchDropdown(e); }

export async function startAutoCommit() {
  const projectId = document.getElementById('diff-project').value; if (!projectId) return;
  const btn = document.getElementById('ac-btn');
  btn.classList.add('loading');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Analyzing...`;
  try {
    const data = await postJson(`/api/projects/${projectId}/auto-commit/plan`, {});
    if (!data.commits?.length) { showToast('No changes to commit', 'info'); resetAcBtn(); return; }
    app._acPlan = { projectId, commits: data.commits, pending: [], truncated: !!data.truncated };
    renderAutoCommitPlan();
    if (data.truncated) showToast('Diff was truncated \u2014 some files grouped by directory heuristic', 'info');
  } catch (err) { showToast('Failed to get AI plan: ' + err.message, 'error'); }
  resetAcBtn();
}

function resetAcBtn() {
  const btn = document.getElementById('ac-btn');
  btn.classList.remove('loading');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M5.5 8.5l13 7M18.5 8.5l-13 7"/></svg>AI Commit`;
}

function acFileTag(file, commitIdx) {
  const name = file.includes('/') ? file.substring(file.lastIndexOf('/') + 1) : file;
  const isPending = commitIdx === -1;
  const tag = document.createElement('span');
  tag.className = 'ac-file-tag'; tag.title = file; tag.draggable = true;
  tag.dataset.file = file; tag.dataset.from = String(commitIdx);
  tag.innerHTML = `<span class="aft-dot" style="background:var(--yellow)"></span>${esc(name)}<span class="aft-down" title="${isPending ? 'Move up to commit' : 'Move to pending'}">\u25BC</span>`;
  tag.addEventListener('dragstart', e => { app._acDragFile = { file, fromCommit: commitIdx }; tag.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', file); });
  tag.addEventListener('dragend', () => { tag.classList.remove('dragging'); app._acDragFile = null; });
  tag.querySelector('.aft-down').addEventListener('click', e => {
    e.stopPropagation();
    if (isPending) { const lastIdx = app._acPlan.commits.length - 1; if (lastIdx >= 0) acMoveFile(file, -1, lastIdx); }
    else acMoveFile(file, commitIdx, -1);
  });
  return tag;
}

function acMoveFile(file, fromIdx, toIdx) {
  if (!app._acPlan || fromIdx === toIdx) return;
  if (fromIdx === -1) app._acPlan.pending = app._acPlan.pending.filter(f => f !== file);
  else { const c = app._acPlan.commits[fromIdx]; if (c) c.files = c.files.filter(f => f !== file); }
  if (toIdx === -1) { if (!app._acPlan.pending.includes(file)) app._acPlan.pending.push(file); }
  else { const c = app._acPlan.commits[toIdx]; if (c && !c.files.includes(file)) c.files.push(file); }
  rerenderAcBody();
}

function acAddCommit() { if (!app._acPlan) return; app._acPlan.commits.push({ message: 'chore: new commit', files: [], reasoning: '' }); rerenderAcBody(); }

function acDeleteCommit(idx) {
  if (!app._acPlan || !app._acPlan.commits[idx]) return;
  app._acPlan.commits[idx].files.forEach(f => { if (!app._acPlan.pending.includes(f)) app._acPlan.pending.push(f); });
  app._acPlan.commits.splice(idx, 1); rerenderAcBody();
}

function acDropZone(el, targetIdx) {
  el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drag-over'); if (app._acDragFile) { acMoveFile(app._acDragFile.file, app._acDragFile.fromCommit, targetIdx); app._acDragFile = null; } });
}

function rerenderAcBody() {
  if (!app._acPlan) return;
  const body = document.getElementById('ac-body'); if (!body) return;
  body.innerHTML = '';
  const plan = app._acPlan;
  plan.commits.forEach((c, i) => {
    const card = document.createElement('div'); card.className = 'ac-commit-card'; card.id = `ac-card-${i}`;
    const head = document.createElement('div'); head.className = 'ac-card-head';
    head.innerHTML = `<div class="ac-card-num">${i + 1}</div><div class="ac-card-msg"><input type="text" value="${c.message.replace(/"/g, '&quot;')}" data-idx="${i}"></div><button class="ac-card-delete" title="Delete commit (files go to pending)">&times;</button>`;
    head.querySelector('input').addEventListener('change', e => { c.message = e.target.value; });
    head.querySelector('.ac-card-delete').addEventListener('click', () => acDeleteCommit(i));
    card.appendChild(head);
    if (c.reasoning) { const reason = document.createElement('div'); reason.className = 'ac-card-reason'; reason.textContent = c.reasoning; card.appendChild(reason); }
    const filesDiv = document.createElement('div'); filesDiv.className = 'ac-card-files';
    c.files.forEach(f => filesDiv.appendChild(acFileTag(f, i)));
    card.appendChild(filesDiv); acDropZone(card, i); body.appendChild(card);
  });
  const addBtn = document.createElement('div'); addBtn.className = 'ac-add-commit';
  addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 5v14M5 12h14"/></svg> Add Commit`;
  addBtn.addEventListener('click', acAddCommit); body.appendChild(addBtn);
  const pending = document.createElement('div'); pending.className = 'ac-pending';
  pending.innerHTML = `<div class="ac-pending-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="10" stroke-dasharray="4 2"/></svg>Pending<span class="aph-count">${plan.pending.length}</span></div>`;
  const pFiles = document.createElement('div'); pFiles.className = 'ac-pending-files';
  if (plan.pending.length === 0) pFiles.innerHTML = '<span class="ac-pending-empty">Drag files here to exclude from commits</span>';
  else plan.pending.forEach(f => pFiles.appendChild(acFileTag(f, -1)));
  pending.appendChild(pFiles); acDropZone(pending, -1); body.appendChild(pending);
  const totalFiles = plan.commits.reduce((s, c) => s + c.files.length, 0);
  const sc = document.querySelector('.acs-commits'), sf = document.querySelector('.acs-files');
  if (sc) sc.textContent = `${plan.commits.length} commit${plan.commits.length !== 1 ? 's' : ''}`;
  if (sf) sf.textContent = `${totalFiles} file${totalFiles !== 1 ? 's' : ''}`;
  const commitBtn = document.getElementById('ac-commit-btn');
  if (commitBtn && !app._acExecuting) { const ac = plan.commits.filter(c => c.files.length > 0).length; commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Commit All (${ac})`; }
}

function renderAutoCommitPlan() {
  const layout = document.querySelector('#diff-view .diff-layout');
  layout.querySelector('.ac-overlay')?.remove();
  const plan = app._acPlan; if (!plan) return;
  const totalFiles = plan.commits.reduce((s, c) => s + c.files.length, 0);
  const overlay = document.createElement('div'); overlay.className = 'ac-overlay';
  let branchHtml = '';
  if (app._acBranchInfo) branchHtml = `<span class="ac-branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M6 3v12"/><path d="M18 9a3 3 0 100-6 3 3 0 000 6z"/><path d="M6 21a3 3 0 100-6 3 3 0 000 6z"/><path d="M18 9c0 6-12 6-12 12"/></svg>${esc(app._acBranchInfo.branch)}</span>`;
  overlay.innerHTML = `<div class="ac-header"><h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M5.5 8.5l13 7M18.5 8.5l-13 7"/></svg>Auto Commit Plan</h3>${branchHtml}<div class="ac-stats"><span class="acs-commits">${plan.commits.length} commit${plan.commits.length > 1 ? 's' : ''}</span><span class="acs-files">${totalFiles} file${totalFiles > 1 ? 's' : ''}</span></div><button class="ac-cancel" data-action="ac-cancel">Cancel</button></div><div class="ac-body" id="ac-body"></div><div class="ac-footer" id="ac-footer"><div class="ac-progress" id="ac-progress" style="display:none"><div class="ac-progress-bar"><div class="ac-progress-fill" id="ac-progress-fill"></div></div><span class="ac-progress-text" id="ac-progress-text">0/${plan.commits.length}</span></div><button class="ac-commit-btn" id="ac-commit-btn" data-action="ac-execute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Commit All (${plan.commits.length})</button></div>`;
  layout.appendChild(overlay); rerenderAcBody();
  overlay.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'ac-cancel': cancelAutoCommit(); break;
      case 'ac-execute': executeAutoCommit(); break;
      case 'ac-close': cancelAutoCommit(); loadDiff(); break;
      case 'ac-push': doPush(el.dataset.projectid); break;
    }
  });
}

export function cancelAutoCommit() {
  app._acPlan = null; app._acExecuting = false; app._acDragFile = null;
  document.querySelector('#diff-view .diff-layout .ac-overlay')?.remove();
}

export async function executeAutoCommit() {
  if (!app._acPlan || app._acExecuting) return;
  if (app._acBranchInfo) { const cb = app._acBranchInfo.branch; if (cb === 'main' || cb === 'master') { if (!confirm(`You are about to commit to "${cb}". Are you sure?`)) return; } }
  const activeCommits = app._acPlan.commits.filter(c => c.files.length > 0);
  if (!activeCommits.length) { showToast('No files in any commit', 'info'); return; }
  app._acExecuting = true;
  const { projectId } = app._acPlan;
  const commitBtn = document.getElementById('ac-commit-btn'), progressEl = document.getElementById('ac-progress'), progressFill = document.getElementById('ac-progress-fill'), progressText = document.getElementById('ac-progress-text');
  commitBtn.disabled = true;
  commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Committing...`;
  progressEl.style.display = 'flex'; progressText.textContent = `0/${activeCommits.length}`;
  let completed = 0, failed = false;
  for (let i = 0; i < app._acPlan.commits.length; i++) {
    const c = app._acPlan.commits[i]; if (!c.files.length) continue;
    const card = document.getElementById(`ac-card-${i}`); if (!card) continue;
    card.classList.add('executing'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      await postJson(`/api/projects/${projectId}/auto-commit/execute`, { message: c.message, files: c.files });
      card.classList.remove('executing');
      card.classList.add('done'); card.querySelector('.ac-card-num').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>`;
      completed++; progressFill.style.width = Math.round(completed / activeCommits.length * 100) + '%'; progressText.textContent = `${completed}/${activeCommits.length}`;
    } catch (err) { card.classList.remove('executing'); card.classList.add('failed'); card.querySelector('.ac-card-num').textContent = '!'; showToast(`Commit ${i + 1} failed: ${err.message}`, 'error'); failed = true; break; }
  }
  app._acExecuting = false;
  const footer = document.getElementById('ac-footer');
  if (!failed && completed === activeCommits.length) {
    footer.innerHTML = `<div class="ac-done-msg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>${completed} commit${completed > 1 ? 's' : ''} done!</div><div style="flex:1"></div><button class="ac-cancel" data-action="ac-close">Close</button><button class="ac-push-btn" data-action="ac-push" data-projectid="${projectId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>Push</button>`;
    showToast(`${completed} commits created successfully`, 'success');
  } else { commitBtn.disabled = false; commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Retry remaining`; }
}

export async function doPush(projectId) {
  const pushBtn = document.querySelector('.ac-push-btn'); if (!pushBtn) return;
  pushBtn.disabled = true;
  pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Pushing...`;
  try {
    await postJson(`/api/projects/${projectId}/push`, {});
    showToast('Pushed successfully!', 'success'); pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Pushed!`; pushBtn.style.background = 'rgba(16,185,129,.2)'; pushBtn.style.border = '1px solid rgba(16,185,129,.3)';
  } catch (err) { showToast('Push error: ' + err.message, 'error'); pushBtn.disabled = false; pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>Push`; }
}

// ─── Pull / Fetch / Stash ───
function getDiffProjectId() { return document.getElementById('diff-project')?.value; }
function withGitActionLock(key, fn) {
  if (app._gitActionLocks.has(key)) return;
  app._gitActionLocks.add(key);
  fn().finally(() => app._gitActionLocks.delete(key));
}

export function doPull() {
  withGitActionLock('pull', async () => {
    const pid = getDiffProjectId(); if (!pid) return showToast('Select a project first', 'error');
    const btn = document.getElementById('dt-pull-btn'); btn.classList.add('loading'); btn.disabled = true; btn.textContent = 'Pulling...';
    try {
      await postJson(`/api/projects/${pid}/pull`, {});
      showToast('Pull complete', 'success'); loadDiff();
    } catch (err) { showToast('Pull error: ' + err.message, 'error'); }
    btn.classList.remove('loading'); btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>Pull`;
  });
}

export function doFetch() {
  withGitActionLock('fetch', async () => {
    const pid = getDiffProjectId(); if (!pid) return showToast('Select a project first', 'error');
    const btn = document.getElementById('dt-fetch-btn'); btn.classList.add('loading'); btn.disabled = true; btn.textContent = 'Fetching...';
    try {
      await postJson(`/api/projects/${pid}/fetch`, {});
      showToast('Fetch complete', 'success');
    } catch (err) { showToast('Fetch error: ' + err.message, 'error'); }
    btn.classList.remove('loading'); btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Fetch`;
  });
}

export function doStash() {
  withGitActionLock('stash', async () => {
    const pid = getDiffProjectId(); if (!pid) return showToast('Select a project first', 'error');
    try {
      await postJson(`/api/projects/${pid}/git/stash`, { includeUntracked: true });
      showToast('Changes stashed', 'success'); loadDiff();
    } catch (err) { showToast('Stash error: ' + err.message, 'error'); }
  });
}

export function doStashPop() {
  withGitActionLock('stash-pop', async () => {
    const pid = getDiffProjectId(); if (!pid) return showToast('Select a project first', 'error');
    try {
      await postJson(`/api/projects/${pid}/git/stash-pop`, {});
      showToast('Stash popped', 'success'); loadDiff();
    } catch (err) { showToast('Stash pop error: ' + err.message, 'error'); }
  });
}

// ─── Branch Create/Delete ───
export async function createBranch(projectId) {
  const input = document.getElementById('new-branch-input'); if (!input) return;
  const name = input.value.trim();
  if (!name) return showToast('Enter a branch name', 'error');
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) return showToast('Invalid branch name', 'error');
  try {
    await postJson(`/api/projects/${projectId}/git/create-branch`, { branch: name });
    showToast(`Branch '${name}' created`, 'success'); input.value = ''; loadDiff(); updateDiffBranchInfo();
  } catch (err) { showToast('Create error: ' + err.message, 'error'); }
}

export async function deleteBranch(projectId, branch) {
  if (!confirm(`Delete branch '${branch}'?`)) return;
  try {
    await postJson(`/api/projects/${projectId}/git/delete-branch`, { branch });
    showToast(`Branch '${branch}' deleted`, 'success'); updateDiffBranchInfo();
  } catch (err) { showToast('Delete error: ' + err.message, 'error'); }
}

// ─── Commit Message Persistence ───
const _commitMsgKey = 'cockpit-commit-msg';
export function saveCommitMsg() { const el = document.getElementById('commit-msg-input'); if (el && el.value.trim()) localStorage.setItem(_commitMsgKey, el.value); }
export function restoreCommitMsg() { const el = document.getElementById('commit-msg-input'); const saved = localStorage.getItem(_commitMsgKey); if (el && saved && !el.value) el.value = saved; }
export function clearCommitMsg() { localStorage.removeItem(_commitMsgKey); const el = document.getElementById('commit-msg-input'); if (el) el.value = ''; }

// ─── Stash List Viewer ───
export async function showStashList() {
  const pid = getDiffProjectId();
  if (!pid) return showToast('Select a project first', 'error');
  const dialog = document.getElementById('stash-list-dialog');
  if (!dialog) return;
  const body = dialog.querySelector('.stash-list-body');
  body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3)">Loading...</div>';
  dialog.showModal();
  try {
    const data = await fetchJson(`/api/projects/${pid}/stash-list`);
    if (!data.stashes?.length) {
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3)">No stashes</div>';
      return;
    }
    body.innerHTML = data.stashes.map(s => `
      <div class="stash-item">
        <div class="stash-info">
          <span class="stash-ref">${esc(s.ref)}</span>
          <span class="stash-msg">${esc(s.message)}</span>
          <span class="stash-ago">${esc(s.ago)}</span>
        </div>
        <div class="stash-actions">
          <button class="btn" data-action="stash-apply" data-ref="${esc(s.ref)}">Apply</button>
          <button class="btn" data-action="stash-pop" data-ref="${esc(s.ref)}">Pop</button>
          <button class="btn" data-action="stash-drop" data-ref="${esc(s.ref)}">Drop</button>
        </div>
      </div>
    `).join('');
    if (!body.dataset.delegated) {
      body.dataset.delegated = '1';
      body.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const ref = btn.dataset.ref;
        if (btn.dataset.action === 'stash-apply') doStashApply(ref);
        else if (btn.dataset.action === 'stash-pop') doStashPopRef(ref);
        else if (btn.dataset.action === 'stash-drop') doStashDrop(ref);
      });
    }
  } catch (err) {
    body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red)">Error: ${esc(err.message)}</div>`;
  }
}

export async function doStashApply(ref) {
  const pid = getDiffProjectId(); if (!pid) return;
  try {
    await postJson(`/api/projects/${pid}/git/stash-apply`, { ref });
    showToast('Stash applied', 'success'); loadDiff();
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

export async function doStashPopRef(ref) {
  const pid = getDiffProjectId(); if (!pid) return;
  try {
    await postJson(`/api/projects/${pid}/git/stash-pop`, { ref });
    showToast('Stash popped', 'success'); showStashList(); loadDiff();
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

export async function doStashDrop(ref) {
  if (!confirm(`Drop ${ref}? This cannot be undone.`)) return;
  const pid = getDiffProjectId(); if (!pid) return;
  try {
    await postJson(`/api/projects/${pid}/git/stash-drop`, { ref });
    showToast('Stash dropped', 'success'); showStashList();
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

// ─── Project Chips (changed projects summary) ───
export function renderProjectChips() {
  const el = document.getElementById('diff-project-chips');
  if (!el) return;
  const sel = document.getElementById('diff-project');
  const current = sel?.value;
  const changed = [];
  for (const p of app.projectList) {
    const cnt = app.state.projects.get(p.id)?.git?.uncommittedCount || 0;
    if (cnt > 0) changed.push({ id: p.id, name: p.name, count: cnt });
  }
  if (changed.length === 0) { el.innerHTML = ''; el.style.display = 'none'; return; }
  changed.sort((a, b) => b.count - a.count);
  el.style.display = '';
  el.innerHTML = `<span class="dpc-label">Changes:</span>` + changed.map(p =>
    `<button class="dpc-chip${p.id === current ? ' active' : ''}" data-action="select-project" data-id="${esc(p.id)}">${esc(p.name)}<span class="dpc-count">${p.count}</span></button>`
  ).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="select-project"]');
      if (!btn) return;
      document.getElementById('diff-project').value = btn.dataset.id;
      loadDiff(); renderProjectChips();
    });
  }
}

// ─── Forge Review Integration ───
export async function forgeReviewDiff() {
  const projectId = document.getElementById('diff-project').value;
  if (!projectId) return showToast('Select a project first', 'error');

  const btn = document.getElementById('forge-review-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🔥 Reviewing...'; }

  try {
    const data = await fetchJson(`/api/projects/${projectId}/diff`);
    const diff = ((data.staged?.diff || '') + '\n' + (data.unstaged?.diff || '')).trim();
    if (!diff) { showToast('No changes to review', 'info'); return; }

    const allFiles = [...(data.staged?.files || []), ...(data.unstaged?.files || [])];
    const review = await postJson('/api/forge/review', { projectId, diff, files: allFiles });
    _showReviewResults(review, projectId);
  } catch (err) {
    showToast('Review failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔥 Review'; }
  }
}

function _showReviewResults(review, projectId) {
  const mainEl = document.getElementById('diff-main');
  if (!mainEl) return;

  // Remove previous overlay if any
  mainEl.querySelector('.forge-review-overlay')?.remove();

  const riskColors = { high: 'var(--red)', medium: '#f59e0b', low: 'var(--green)', clean: 'var(--green)', unknown: 'var(--text-3)' };
  const riskColor = riskColors[review.overallRisk] || riskColors.unknown;
  const sevIcons = { HIGH: '🔴', MED: '🟡', LOW: '🟢' };
  const issues = review.issues || [];

  const overlay = document.createElement('div');
  overlay.className = 'forge-review-overlay';
  overlay.innerHTML = `
    <div class="fr-header">
      <span class="fr-title">🔥 Forge Review</span>
      <span class="fr-risk" style="color:${riskColor}">${(review.overallRisk || 'unknown').toUpperCase()}</span>
      <span class="fr-count">${issues.length} issue${issues.length !== 1 ? 's' : ''}</span>
      <button class="fr-close" data-action="fr-close">✕</button>
    </div>
    <div class="fr-summary">${esc(review.summary || '')}</div>
    ${issues.length === 0 ? '<div class="fr-clean">No issues found. Code looks clean.</div>' : ''}
    <div class="fr-issues">
      ${issues.map(i => `
        <div class="fr-issue sev-${(i.severity || '').toLowerCase()}">
          <div class="fri-head">
            <span class="fri-sev">${sevIcons[i.severity] || '⚪'} ${i.severity || ''}</span>
            <span class="fri-cat">${esc(i.category || '')}</span>
            ${i.file ? `<span class="fri-file">${esc(i.file)}</span>` : ''}
          </div>
          <div class="fri-desc">${esc(i.description || '')}</div>
          ${i.suggestion ? `<div class="fri-fix"><strong>Fix:</strong> ${esc(i.suggestion)}</div>` : ''}
        </div>
      `).join('')}
    </div>
    ${issues.length > 0 ? `<div class="fr-actions"><button class="btn primary" data-action="fr-fix">🔥 Fix with Forge</button></div>` : ''}
  `;

  app._lastForgeReview = { review, projectId };
  mainEl.insertBefore(overlay, mainEl.firstChild);
  overlay.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'fr-close') overlay.remove();
    else if (el.dataset.action === 'fr-fix') forgeFixFromReview();
  });
}

export function forgeFixFromReview() {
  const ctx = app._lastForgeReview;
  if (!ctx?.review?.issues?.length) return;

  const issueDescs = ctx.review.issues.map(i =>
    `- [${i.severity}] ${i.file || ''}: ${i.description}${i.suggestion ? ` → ${i.suggestion}` : ''}`
  ).join('\n');
  const filePaths = [...new Set(ctx.review.issues.map(i => i.file).filter(Boolean))];

  openForgeWithPrefill({
    task: `Fix code review issues:\n\n${issueDescs}`,
    referenceFiles: filePaths.join('\n'),
    projectId: ctx.projectId,
    plan: 'standard',
    source: 'diff',
    sourceRef: 'review',
  });
}

// ─── Action Registration ───
registerClickActions({
  'diff-expand-all': diffExpandAll,
  'diff-collapse-all': diffCollapseAll,
  'refresh-diff': loadDiff,
  'start-auto-commit': startAutoCommit,
  'forge-review-diff': forgeReviewDiff,
  'do-pull': doPull,
  'do-fetch': doFetch,
  'do-stash': doStash,
  'do-stash-pop': doStashPop,
  'show-stash-list': showStashList,
  'generate-commit-msg': generateCommitMsg,
  'do-manual-commit': doManualCommit,
});
registerChangeActions({
  'load-diff': loadDiff,
});
registerInputActions({
  'filter-diff-files': filterDiffFiles,
  'commit-msg-input': (el) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; },
});
