// ─── Logs Module: Project Log Viewer ───
import { app } from './state.js';
import { esc, showToast } from './utils.js';

// ─── Init ───
export function initLogs() {
  if (app._logsInitialized) return;
  app._logsInitialized = true;
  renderLogsProjectSelector();
  if (!app._logsProject) {
    const p = app.projectList[0];
    if (p) { app._logsProject = p.id; loadLogFiles(); }
    else renderLogsEmpty('No projects configured');
  } else {
    loadLogFiles();
  }
}

function renderLogsProjectSelector() {
  const sel = document.getElementById('logs-project-filter');
  if (!sel) return;
  sel.innerHTML = app.projectList.map(p =>
    `<option value="${esc(p.id)}" ${p.id === app._logsProject ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
}

export function filterLogsByProject(id) {
  app._logsProject = id;
  app._logsActiveFile = null;
  app.logsContent = null;
  loadLogFiles();
}

// ─── Load Log Files ───
async function loadLogFiles() {
  if (!app._logsProject) return;
  const fileList = document.getElementById('logs-file-list');
  if (fileList) fileList.innerHTML = '<div class="logs-loading-sm">Scanning...</div>';
  try {
    const files = await fetch(`/api/logs/files/${app._logsProject}`).then(r => r.json());
    if (files.error) throw new Error(files.error);
    app.logsFiles = Array.isArray(files) ? files : [];
    renderLogFileList();
    if (!app.logsFiles.length) {
      renderLogsEmpty('No log files found in this project');
    } else if (!app._logsActiveFile) {
      loadLogContent(app.logsFiles[0].path);
    }
  } catch (err) {
    if (fileList) fileList.innerHTML = `<div class="logs-sidebar-empty">Error: ${esc(err.message)}</div>`;
  }
}

function renderLogFileList() {
  const el = document.getElementById('logs-file-list');
  if (!el) return;
  if (!app.logsFiles.length) {
    el.innerHTML = '<div class="logs-sidebar-empty">No log files</div>';
    return;
  }
  el.innerHTML = app.logsFiles.map(f => {
    const active = f.path === app._logsActiveFile ? 'active' : '';
    return `<div class="log-file-item ${active}" data-action="select-file" data-path="${esc(f.path)}">
      <div class="lf-name">${esc(f.relative || f.name)}</div>
      <div class="lf-meta">${formatSize(f.size)} · ${new Date(f.mtime).toLocaleDateString()}</div>
    </div>`;
  }).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const item = e.target.closest('[data-action="select-file"]');
      if (item) selectLogFile(item.dataset.path);
    });
  }
}

// ─── Load Content ───
export async function selectLogFile(path) {
  app._logsActiveFile = path;
  renderLogFileList();
  loadLogContent(path);
}

async function loadLogContent(path) {
  const viewer = document.getElementById('logs-viewer');
  if (!viewer) return;
  viewer.innerHTML = '<div class="logs-loading">Loading log file...</div>';
  try {
    const data = await fetch(`/api/logs/tail?path=${encodeURIComponent(path)}&lines=500`).then(r => r.json());
    if (data.error) throw new Error(data.error);
    app.logsContent = data;
    renderLogContent();
  } catch (err) {
    viewer.innerHTML = `<div class="logs-empty">Failed to load: ${esc(err.message)}</div>`;
  }
}

// ─── Render Content ───
function renderLogContent() {
  const data = app.logsContent;
  if (!data) return;
  const viewer = document.getElementById('logs-viewer');
  if (!viewer) return;

  const levels = data.levels || {};
  const filterBtns = `
    <button class="log-level-btn ${app._logsFilter === 'all' ? 'active' : ''}" data-action="filter-level" data-level="all">All <span class="llb-count">${data.lines.length}</span></button>
    <button class="log-level-btn log-error ${app._logsFilter === 'error' ? 'active' : ''}" data-action="filter-level" data-level="error">Error <span class="llb-count">${levels.error || 0}</span></button>
    <button class="log-level-btn log-warn ${app._logsFilter === 'warn' ? 'active' : ''}" data-action="filter-level" data-level="warn">Warn <span class="llb-count">${levels.warn || 0}</span></button>
    <button class="log-level-btn log-info ${app._logsFilter === 'info' ? 'active' : ''}" data-action="filter-level" data-level="info">Info <span class="llb-count">${levels.info || 0}</span></button>
  `;

  const filtered = filterLines(data.lines);
  const html = filtered.map((line, i) => {
    const cls = lineClass(line);
    return `<div class="log-line ${cls}"><span class="log-ln">${data.totalLines - data.lines.length + i + 1}</span><span class="log-text">${esc(line)}</span></div>`;
  }).join('');

  const followActive = app._logsFollowMode;
  viewer.innerHTML = `
    <div class="logs-toolbar">
      <div class="logs-file-info">
        <span class="lfi-name">${esc(data.name)}</span>
        <span class="lfi-lines">${data.totalLines.toLocaleString()} lines</span>
        <span class="lfi-tail">tail -500</span>
      </div>
      <div class="logs-filters">${filterBtns}</div>
      <input type="text" class="logs-search" placeholder="Search logs..." data-action="search-logs">
      <button class="dt-icon-btn ${followActive ? 'logs-follow-active' : ''}" data-action="toggle-follow" title="Follow mode${followActive ? ' (ON)' : ' (OFF)'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
      </button>
      <button class="dt-icon-btn" data-action="refresh" title="Refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg>
      </button>
    </div>
    <div class="logs-output" id="logs-output">${html}</div>
  `;

  if (!viewer.dataset.delegated) {
    viewer.dataset.delegated = '1';
    viewer.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'filter-level') filterLogLevel(btn.dataset.level);
      else if (btn.dataset.action === 'toggle-follow') toggleLogsFollow();
      else if (btn.dataset.action === 'refresh') refreshLogs();
    });
    viewer.addEventListener('input', e => {
      if (e.target.dataset.action === 'search-logs') searchLogs(e.target.value);
    });
  }
  // Auto-scroll to bottom if follow mode
  if (followActive) {
    const output = document.getElementById('logs-output');
    if (output) output.scrollTop = output.scrollHeight;
  }
  // Manage auto-refresh timer
  manageLogsRefresh();
}

export function filterLogLevel(level) {
  app._logsFilter = level;
  renderLogContent();
}

export function searchLogs(query) {
  const lines = document.querySelectorAll('.log-line');
  const q = query.toLowerCase();
  lines.forEach(el => {
    const text = el.querySelector('.log-text')?.textContent.toLowerCase() || '';
    el.style.display = (!q || text.includes(q)) ? '' : 'none';
  });
}

export function toggleLogsFollow() {
  app._logsFollowMode = !app._logsFollowMode;
  manageLogsRefresh();
  // Update button state
  const btn = document.querySelector('.logs-follow-active, .dt-icon-btn[data-action="toggle-follow"]');
  if (btn) btn.classList.toggle('logs-follow-active', app._logsFollowMode);
  if (app._logsFollowMode) {
    const output = document.getElementById('logs-output');
    if (output) output.scrollTop = output.scrollHeight;
  }
}

function manageLogsRefresh() {
  if (app._logsFollowMode && app._logsActiveFile && !app._logsRefreshTimer) {
    app._logsRefreshTimer = setInterval(() => {
      if (document.getElementById('logs-view')?.classList.contains('active')) {
        loadLogContent(app._logsActiveFile);
      }
    }, 5000);
  } else if (!app._logsFollowMode && app._logsRefreshTimer) {
    clearInterval(app._logsRefreshTimer);
    app._logsRefreshTimer = null;
  }
}

export function refreshLogs() {
  if (app._logsActiveFile) loadLogContent(app._logsActiveFile);
}

// ─── Helpers ───
function filterLines(lines) {
  if (app._logsFilter === 'all') return lines;
  return lines.filter(l => {
    const lower = l.toLowerCase();
    if (app._logsFilter === 'error') return lower.includes('error') || lower.includes('[err');
    if (app._logsFilter === 'warn') return lower.includes('warn') || lower.includes('[warn');
    if (app._logsFilter === 'info') return lower.includes('info') || lower.includes('[info');
    return true;
  });
}

function lineClass(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('[err')) return 'log-level-error';
  if (l.includes('warn') || l.includes('[warn')) return 'log-level-warn';
  if (l.includes('info') || l.includes('[info')) return 'log-level-info';
  if (l.includes('debug') || l.includes('[debug')) return 'log-level-debug';
  return '';
}

function formatSize(bytes) {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

function renderLogsEmpty(msg) {
  const viewer = document.getElementById('logs-viewer');
  if (viewer) viewer.innerHTML = `<div class="logs-empty">
    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="var(--text-3)" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <div class="je-title">${msg}</div>
  </div>`;
}
