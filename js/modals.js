// ─── Modals: settings, project CRUD, folder picker, dev servers, command palette,
//     file preview, context menu, error log, discover, notifications, git log, sessions ───
import { app } from './state.js';
import { esc, escapeHtml, showToast, timeAgo, fuzzyMatch, IMG_EXT } from './utils.js';

// ─── Settings Panel ───
export function openSettingsPanel() {
  renderSettingsProjectList();
  loadSettingsApiKeys();
  document.getElementById('settings-overlay').classList.add('open');
  document.getElementById('settings-panel').classList.add('open');
}
async function loadSettingsApiKeys() {
  try {
    const res = await fetch('/api/ai/config');
    const data = await res.json();
    const inp = document.getElementById('settings-gemini-key');
    if (inp && data.configured && data.geminiApiKey) {
      inp.value = '';
      inp.placeholder = data.geminiApiKey;
    }
  } catch {}
}
export async function saveSettingsGeminiKey() {
  const inp = document.getElementById('settings-gemini-key');
  const key = inp?.value?.trim();
  if (!key || key.startsWith('****')) { showToast('새 API key를 입력하세요', 'error'); return; }
  try {
    const res = await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geminiApiKey: key }) });
    const data = await res.json();
    if (data.success) showToast('Gemini API Key 저장 완료', 'success');
    else showToast(data.error || 'Save failed', 'error');
  } catch (err) { showToast(err.message, 'error'); }
}
export function closeSettingsPanel() {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('settings-panel').classList.remove('open');
}
function renderSettingsProjectList() {
  const el = document.getElementById('settings-project-list');
  el.innerHTML = app.projectList
    .map(p => `
    <div class="spi" data-id="${esc(p.id)}">
      <div class="spi-color" style="background:${p.color}"></div>
      <div class="spi-info"><div class="spi-name">${esc(p.name)}</div><div class="spi-path">${esc(p.path)}</div></div>
      <div class="spi-actions">
        <button class="btn btn-icon" data-action="edit-project" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-icon" data-action="delete-project" title="Delete" style="color:var(--red)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (btn.dataset.action === 'edit-project') editProject(id);
      else if (btn.dataset.action === 'delete-project') confirmDeleteProject(id);
    });
  }
}

// ─── Project Modal ───
export function openAddProjectModal() {
  document.getElementById('pm-edit-id').value = '';
  document.getElementById('pm-title').textContent = 'Add Project';
  document.getElementById('pm-name').value = '';
  document.getElementById('pm-path').value = '';
  document.getElementById('pm-stack').value = 'react-next';
  document.getElementById('pm-devcmd').value = '';
  document.getElementById('pm-github').value = '';
  document.getElementById('pm-color').value = '#6366f1';
  document.getElementById('pm-tag').value = '';
  document.getElementById('pm-scripts-list').style.display = 'none';
  closeFolderPicker();
  const pmDlg = document.getElementById('project-modal');
  if (!pmDlg.dataset.delegated) {
    pmDlg.dataset.delegated = '1';
    pmDlg.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'pick-script') pickScript(el);
    });
  }
  pmDlg.showModal();
}
export async function loadPkgScripts() {
  const pathInput = document.getElementById('pm-path').value.trim();
  const list = document.getElementById('pm-scripts-list');
  if (!pathInput) { showToast('Enter project path first', 'error'); return; }
  list.style.display = '';
  list.innerHTML = '<div style="padding:8px 12px;color:var(--text-3);font-size:.78rem">Loading...</div>';
  try {
    const res = await fetch(`/api/scripts-by-path?path=${encodeURIComponent(pathInput)}`);
    const data = await res.json();
    const scripts = data.scripts || {};
    const entries = Object.entries(scripts);
    if (!entries.length) {
      list.innerHTML = '<div style="padding:8px 12px;color:var(--text-3);font-size:.78rem">No scripts in package.json</div>';
      return;
    }
    list.innerHTML = entries.map(([name, cmd]) =>
      `<div class="pm-script-item" data-action="pick-script" data-cmd="npm run ${name}" style="padding:5px 12px;cursor:pointer;font-size:.78rem;display:flex;justify-content:space-between;gap:8px;transition:background var(--dur)">
        <span style="font-weight:500;color:var(--accent-bright);font-family:var(--mono)">${esc(name)}</span>
        <span style="color:var(--text-3);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cmd)}</span>
      </div>`
    ).join('');
  } catch {
    list.innerHTML = '<div style="padding:8px 12px;color:var(--red);font-size:.78rem">Error loading scripts</div>';
  }
}
export function pickScript(el) {
  document.getElementById('pm-devcmd').value = el.dataset.cmd;
  document.getElementById('pm-scripts-list').style.display = 'none';
}
export function editProject(id) {
  const p = app.projectList.find(x => x.id === id);
  if (!p) return;
  document.getElementById('pm-edit-id').value = p.id;
  document.getElementById('pm-title').textContent = 'Edit Project';
  document.getElementById('pm-name').value = p.name;
  document.getElementById('pm-path').value = p.path;
  document.getElementById('pm-stack').value = p.stack || 'other';
  document.getElementById('pm-devcmd').value = p.devCmd || '';
  document.getElementById('pm-github').value = p.github || '';
  document.getElementById('pm-color').value = p.color || '#6366f1';
  const tags = JSON.parse(localStorage.getItem('dl-project-tags') || '{}');
  document.getElementById('pm-tag').value = tags[p.id] || '';
  document.getElementById('project-modal').showModal();
}
export async function saveProject() {
  const editId = document.getElementById('pm-edit-id').value;
  const devCmd = document.getElementById('pm-devcmd').value.trim();
  const github = document.getElementById('pm-github').value.trim();
  const data = {
    name: document.getElementById('pm-name').value.trim(),
    path: document.getElementById('pm-path').value.trim(),
    stack: document.getElementById('pm-stack').value,
    color: document.getElementById('pm-color').value,
    devCmd: devCmd || '',
    github: github || '',
  };
  if (!data.name || !data.path) { showToast('Name and path required', 'error'); return; }
  const tag = document.getElementById('pm-tag').value.trim();
  if (editId) window.setProjectTag?.(editId, tag);
  if (editId) {
    await fetch(`/api/projects/${editId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    showToast('Project updated', 'success');
  } else {
    await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    showToast('Project added', 'success');
  }
  document.getElementById('project-modal').close();
  closeFolderPicker();
  await refreshProjectList();
}

// ─── Folder Picker ───
export function toggleFolderPicker() {
  const el = document.getElementById('folder-picker');
  if (el.classList.contains('open')) { closeFolderPicker(); return; }
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'browse-to') browseTo(btn.dataset.path);
    });
  }
  el.classList.add('open');
  const cur = document.getElementById('pm-path').value.trim().replace(/\\/g, '/');
  browseTo(cur || null);
}
export function closeFolderPicker() {
  document.getElementById('folder-picker').classList.remove('open');
}
export async function browseTo(dir) {
  app.fpCurrentDir = dir;
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  try {
    const res = await fetch(`/api/browse${qs}`);
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }
    renderBreadcrumb(data.current || null, data.parent);
    const list = document.getElementById('fp-list');
    if (!data.entries.length) { list.innerHTML = '<li class="fp-empty">No subfolders</li>'; return; }
    list.innerHTML = data.entries.map(e =>
      `<li class="fp-item" data-action="browse-to" data-path="${esc(e.path)}">\
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>${e.name}</li>`
    ).join('');
  } catch (err) {
    showToast('Browse failed', 'error');
  }
}
function renderBreadcrumb(current, parent) {
  const bc = document.getElementById('fp-breadcrumb');
  if (!current) { bc.innerHTML = '<span style="color:var(--text-3)">Drives</span>'; return; }
  const parts = current.replace(/\/$/, '').split('/');
  let html = '', acc = '';
  parts.forEach((p, i) => {
    acc += i === 0 ? p : '/' + p;
    const path = acc + (i === 0 ? '/' : '');
    if (i > 0) html += '<span class="fp-sep">/</span>';
    html += `<span data-action="browse-to" data-path="${esc(path)}">${p || '/'}</span>`;
  });
  bc.innerHTML = html;
}
export function selectCurrentFolder() {
  if (app.fpCurrentDir) document.getElementById('pm-path').value = app.fpCurrentDir;
  closeFolderPicker();
}

// ─── Project Delete & Refresh ───
export async function confirmDeleteProject(id) {
  const p = app.projectList.find(x => x.id === id);
  if (!confirm(`Delete "${p?.name}"? (Dashboard only, not from disk)`)) return;
  await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  showToast(`${p?.name} removed`, 'info');
  await refreshProjectList();
}
export async function refreshProjectList() {
  const res = await fetch('/api/projects');
  app.projectList = await res.json();
  window.renderAllCards?.(app.projectList);
  app.projectList.forEach(p => {
    if (app.state.projects.has(p.id)) window.renderCard?.(p.id);
  });
  renderSettingsProjectList();
  populateProjectSelects();
  window.updateSummaryStats?.();
}
export function populateProjectSelects() {
  const plainOpts = app.projectList.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const ntSel = document.getElementById('nt-project');
  if (ntSel) ntSel.innerHTML = plainOpts;

  // Diff select: show change counts, sort changed projects first
  const sel = document.getElementById('diff-project');
  const prev = sel?.value;
  const sorted = [...app.projectList].sort((a, b) => {
    const ca = app.state.projects.get(a.id)?.git?.uncommittedCount || 0;
    const cb = app.state.projects.get(b.id)?.git?.uncommittedCount || 0;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });
  const diffOpts = sorted.map(p => {
    const cnt = app.state.projects.get(p.id)?.git?.uncommittedCount || 0;
    const label = cnt > 0 ? `${esc(p.name)} (${cnt})` : esc(p.name);
    return `<option value="${p.id}"${cnt > 0 ? ' class="has-changes"' : ''}>${label}</option>`;
  }).join('');
  sel.innerHTML = diffOpts;
  if (prev && sorted.some(p => p.id === prev)) sel.value = prev;
}

// ─── Dev Server Management ───
function _setupDevDialogDelegation(dlg) {
  if (dlg.dataset.delegated) return;
  dlg.dataset.delegated = '1';
  dlg.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'set-dev-cmd': setDevCmd(el.dataset.pid, el.dataset.cmd); break;
      case 'save-dev-cmd': setDevCmd(el.dataset.pid, document.getElementById('dev-cmd-input').value); break;
      case 'open-port': window.open(el.dataset.url, '_blank'); break;
      case 'stop-dev': toggleDevServer(el.dataset.pid); break;
    }
  });
}
export async function promptDevCmd(projectId) {
  const p = app.projectList.find(x => x.id === projectId);
  if (!p) return;
  const dlg = document.getElementById('dev-dialog');
  const content = document.getElementById('dev-dialog-content');
  document.querySelector('#dev-dialog .modal-header h2').textContent = `Dev Command \u2014 ${p.name}`;
  content.innerHTML = '<div style="padding:12px;color:var(--text-3);font-size:.78rem">Loading scripts...</div>';
  _setupDevDialogDelegation(dlg);
  dlg.showModal();
  try {
    const res = await fetch(`/api/scripts-by-path?path=${encodeURIComponent(p.path)}`);
    const data = await res.json();
    const entries = Object.entries(data.scripts || {});
    let html = '';
    if (entries.length) {
      html += '<div style="padding:8px 14px;font-size:.72rem;color:var(--text-3)">package.json scripts \u2014 click to set</div>';
      html += entries.map(([name, cmd]) =>
        `<div class="dev-item" style="cursor:pointer" data-action="set-dev-cmd" data-pid="${projectId}" data-cmd="npm run ${name}">
          <span class="di-name" style="font-family:var(--mono);color:var(--accent-bright)">${esc(name)}</span>
          <span class="di-cmd">${esc(cmd)}</span>
        </div>`
      ).join('');
    } else {
      html += '<div style="padding:12px 14px;color:var(--text-3);font-size:.78rem">No scripts in package.json</div>';
    }
    html += `<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:6px;align-items:center">
      <input type="text" id="dev-cmd-input" placeholder="Or type custom command..." style="flex:1;padding:5px 10px;font-size:.78rem;background:var(--bg-0);border:1px solid var(--border);border-radius:var(--radius-xs);color:var(--text-1);font-family:var(--mono)">
      <button class="btn primary" data-action="save-dev-cmd" data-pid="${projectId}" style="font-size:.72rem">Save</button>
    </div>`;
    content.innerHTML = html;
  } catch {
    content.innerHTML = '<div style="padding:12px;color:var(--red);font-size:.78rem">Error loading scripts</div>';
  }
}
export async function setDevCmd(projectId, cmd) {
  if (!cmd?.trim()) { showToast('Enter a command', 'error'); return; }
  const p = app.projectList.find(x => x.id === projectId);
  if (!p) return;
  p.devCmd = cmd.trim();
  await fetch(`/api/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, devCmd: p.devCmd }) });
  document.getElementById('dev-dialog').close();
  showToast(`Dev command set: ${cmd.trim()}`, 'success');
  await refreshProjectList();
}
export async function toggleDevServer(projectId) {
  const isRunning = app.devServerState.some(d => d.projectId === projectId);
  const endpoint = isRunning ? 'stop' : 'start';
  try {
    const res = await fetch(`/api/projects/${projectId}/dev-server/${endpoint}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Dev server action failed', 'error');
      return;
    }
    const listRes = await fetch('/api/dev-servers');
    const data = await listRes.json();
    app.devServerState = data.running || [];
    updateDevBadge();
    window.renderCard?.(projectId);
    if (endpoint === 'start') {
      const pName = app.projectList.find(p => p.id === projectId)?.name || projectId;
      showToast(`Starting ${pName}...`, 'info', 2000);
      const tid = setTimeout(() => {
        const still = app.devServerState.find(d => d.projectId === projectId && !d.port);
        if (still) showToast(`${pName}: port not detected (may still be starting)`, 'error', 5000);
        app._devStartTimeouts.delete(projectId);
      }, 30000);
      app._devStartTimeouts.set(projectId, tid);
    }
    if (endpoint === 'stop' && app._devStartTimeouts.has(projectId)) {
      clearTimeout(app._devStartTimeouts.get(projectId));
      app._devStartTimeouts.delete(projectId);
    }
    const dlg = document.getElementById('dev-dialog');
    if (dlg.open) showDevServerDialog();
  } catch {
    showToast('Dev server action failed', 'error');
  }
}
export async function showDevServerDialog() {
  const dlg = document.getElementById('dev-dialog');
  _setupDevDialogDelegation(dlg);
  const content = document.getElementById('dev-dialog-content');
  document.querySelector('#dev-dialog .modal-header h2').textContent = 'Dev Servers';
  try {
    const res = await fetch('/api/dev-servers');
    const data = await res.json();
    if (!data.running?.length) {
      content.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3)">No dev servers running</div>';
    } else {
      content.innerHTML = data.running.map(d => {
        const ago = Math.round((Date.now() - d.startedAt) / 60000);
        const portTag = d.port
          ? `<span style="font-family:var(--mono);font-size:.74rem;color:var(--green);cursor:pointer" data-action="open-port" data-url="http://localhost:${d.port}" title="Open in browser">:${d.port}</span>`
          : '';
        return `<div class="dev-item">
          <span class="dev-dot on"></span>
          <span class="di-name">${esc(d.name)}</span>
          ${portTag}
          <span class="di-cmd">${esc(d.command)}</span>
          <span class="di-time">${ago}m</span>
          <button class="btn" data-action="stop-dev" data-pid="${d.projectId}" style="font-size:.72rem;padding:2px 8px;color:var(--red)">Stop</button>
        </div>`;
      }).join('');
    }
  } catch {
    content.innerHTML = '<div style="padding:20px;color:var(--red)">Error</div>';
  }
  dlg.showModal();
}
export function updateDevBadge() {
  const el = document.getElementById('dev-count');
  if (el) el.textContent = app.devServerState.length;
  const badge = document.getElementById('dev-server-badge');
  if (badge) badge.style.display = app.devServerState.length ? '' : 'none';
}

// ─── IDE / GitHub ───
export function openIDE(projectId, ide) {
  const p = app.projectList.find(x => x.id === projectId);
  if (!p) return;
  fetch('/api/open-in-ide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p.path, ide }),
  }).then(r => r.json()).then(d => {
    if (d.opened) showToast(`Opened in ${ide}`);
    else showToast(d.error || 'Failed', 'error');
  }).catch(() => showToast('Failed to open', 'error'));
}
export function openGitHub(projectId) {
  const p = app.projectList.find(x => x.id === projectId);
  if (p?.github) window.open(p.github, '_blank');
  else showToast('No GitHub URL configured', 'error');
}

// ─── Actions ───
export function openStartModal(id) {
  document.getElementById('modal-project-id').value = id;
  document.getElementById('start-modal').showModal();
}
export async function doStartSession() {
  const id = document.getElementById('modal-project-id').value;
  const model = document.getElementById('modal-model').value;
  const prompt = document.getElementById('modal-prompt').value;
  document.getElementById('start-modal').close();
  await fetch(`/api/sessions/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || undefined, prompt: prompt || undefined }),
  });
}

// ─── Resume Last Session ───
export async function resumeLastSession(projectId) {
  const p = app.state.projects.get(projectId);
  if (!p?.session?.sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${projectId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: p.session.sessionId }),
    });
    const data = await res.json();
    if (data.launched) showToast('Session resumed in Windows Terminal', 'success');
    else showToast(data.error || 'Failed', 'error');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Shortcut Help ───
export function showShortcutHelp() {
  document.getElementById('shortcut-overlay').classList.remove('hidden');
}
export function hideShortcutHelp() {
  document.getElementById('shortcut-overlay').classList.add('hidden');
}

// ─── Command Palette ───
function buildCommandList() {
  const cmds = [];
  const icon = d => `<span class="cpi-icon"><svg viewBox="0 0 24 24">${d}</svg></span>`;
  const navIcon = icon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
  const termIcon = icon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>');
  const gitIcon = icon('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/>');
  const settingsIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>');
  const themeIcon = icon('<path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/>');

  // Navigation
  cmds.push({ group: 'Navigation', label: 'Go to Overview', hint: 'Ctrl+1', icon: navIcon, action: () => window.switchView?.('dashboard') });
  cmds.push({ group: 'Navigation', label: 'Go to Terminal', hint: 'Ctrl+2', icon: termIcon, action: () => window.switchView?.('terminal') });
  cmds.push({ group: 'Navigation', label: 'Go to Changes', hint: 'Ctrl+3', icon: gitIcon, action: () => window.switchView?.('diff') });
  const jiraIcon = icon('<path d="M11.53 2c-.55 0-1.07.22-1.46.6L2.6 10.07a2.07 2.07 0 000 2.93l7.47 7.47c.39.38.91.6 1.46.6s1.07-.22 1.46-.6l7.47-7.47a2.07 2.07 0 000-2.93L13 2.6c-.39-.38-.91-.6-1.47-.6z"/>');
  cmds.push({ group: 'Navigation', label: 'Go to Jira', hint: 'Ctrl+4', icon: jiraIcon, action: () => window.switchView?.('jira') });
  const cicdIcon = icon('<circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/>');
  cmds.push({ group: 'Navigation', label: 'Go to CI/CD', hint: 'Ctrl+5', icon: cicdIcon, action: () => window.switchView?.('cicd') });
  const notesIcon = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>');
  cmds.push({ group: 'Navigation', label: 'Go to Notes', hint: 'Ctrl+6', icon: notesIcon, action: () => window.switchView?.('notes') });
  const logsIcon = icon('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  cmds.push({ group: 'Navigation', label: 'Go to Workflows', hint: 'Ctrl+7', icon: logsIcon, action: () => window.switchView?.('workflows') });
  cmds.push({ group: 'Navigation', label: 'Go to Forge', hint: 'Ctrl+8', icon: navIcon, action: () => window.switchView?.('forge') });
  cmds.push({ group: 'Navigation', label: 'Go to README', hint: 'Ctrl+9', icon: navIcon, action: () => window.switchView?.('readme') });
  const agentIcon = icon('<path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 110 2h-1.17A7 7 0 0113 22h-2a7 7 0 01-6.83-6H3a1 1 0 110-2h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2z"/>');
  cmds.push({ group: 'Navigation', label: 'Toggle Agent', hint: 'Ctrl+`', icon: agentIcon, action: () => window.toggleAgentPanel?.() });

  // Projects
  for (const p of app.projectList) {
    const pIcon = icon('<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>');
    cmds.push({ group: 'Projects', label: `Switch to ${p.name}`, icon: pIcon, action: () => {
      window.switchView?.('diff');
      document.getElementById('diff-project').value = p.id;
      window.loadDiff?.();
    }});
  }

  // Terminals
  for (const [tid, t] of app.termMap) {
    cmds.push({ group: 'Terminals', label: `Terminal: ${t.label || tid}`, icon: termIcon, action: () => {
      window.switchView?.('terminal');
      app.activeTermId = tid;
      window.renderLayout?.();
      window.updateTermHeaders?.();
    }});
  }

  // Actions
  cmds.push({ group: 'Actions', label: 'Recent Conversations', icon: navIcon, action: () => window.showConvList?.() });
  cmds.push({ group: 'Actions', label: 'New Terminal', hint: 'Ctrl+T', icon: termIcon, action: () => { window.switchView?.('terminal'); window.openNewTermModal?.(); } });
  cmds.push({ group: 'Actions', label: 'Toggle Theme', icon: themeIcon, action: () => window.toggleTheme?.() });
  cmds.push({ group: 'Actions', label: 'Open Settings', icon: settingsIcon, action: () => openSettingsPanel() });
  cmds.push({ group: 'Actions', label: 'Keyboard Shortcuts', hint: '?', icon: settingsIcon, action: () => showShortcutHelp() });
  cmds.push({ group: 'Actions', label: 'Refresh Diff', hint: 'R', icon: gitIcon, action: () => { window.switchView?.('diff'); window.loadDiff?.(); } });
  cmds.push({ group: 'Actions', label: 'Export Terminal Output', icon: termIcon, action: () => { window.switchView?.('terminal'); window.exportTerminal?.(); } });
  cmds.push({ group: 'Actions', label: 'Fetch All Projects', icon: gitIcon, action: () => window.fetchAllProjects?.() });
  cmds.push({ group: 'Actions', label: 'Pull All Projects', icon: gitIcon, action: () => window.pullAllProjects?.() });
  cmds.push({ group: 'Actions', label: 'Filter: Active Only', icon: navIcon, action: () => { window.switchView?.('dashboard'); window.setProjectFilter?.('active'); } });
  cmds.push({ group: 'Actions', label: 'Filter: Idle Only', icon: navIcon, action: () => { window.switchView?.('dashboard'); window.setProjectFilter?.('idle'); } });
  cmds.push({ group: 'Actions', label: 'Filter: Show All', icon: navIcon, action: () => { window.switchView?.('dashboard'); window.setProjectFilter?.('all'); } });

  return cmds;
}

function renderCommandList() {
  const list = document.getElementById('cmd-palette-list');
  if (!app._cmdFiltered.length) {
    list.innerHTML = '<div class="cmd-palette-empty">No matching commands</div>';
    return;
  }
  let html = '', lastGroup = '';
  app._cmdFiltered.forEach((cmd, i) => {
    if (cmd.group !== lastGroup) {
      html += `<div class="cmd-palette-group">${cmd.group}</div>`;
      lastGroup = cmd.group;
    }
    html += `<div class="cmd-palette-item${i === app._cmdActiveIdx ? ' active' : ''}" data-idx="${i}" data-action="exec-cmd">${cmd.icon}<span class="cpi-label">${cmd.label}</span>${cmd.hint ? `<span class="cpi-hint">${cmd.hint}</span>` : ''}</div>`;
  });
  list.innerHTML = html;
  const active = list.querySelector('.cmd-palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

export function setCmdActive(i) {
  app._cmdActiveIdx = i;
  renderCommandList();
}
export function execCmd(i) {
  const cmd = app._cmdFiltered[i];
  if (cmd) { closeCommandPalette(); cmd.action(); }
}
export function filterCommands(query) {
  const allCmds = buildCommandList();
  app._cmdFiltered = query ? allCmds.filter(c => fuzzyMatch(query, c.label)) : allCmds;
  app._cmdActiveIdx = 0;
  renderCommandList();
}
export function toggleCommandPalette() {
  const el = document.getElementById('cmd-palette');
  if (el.classList.contains('hidden')) openCommandPalette();
  else closeCommandPalette();
}
export function openCommandPalette() {
  const el = document.getElementById('cmd-palette');
  el.classList.remove('hidden');
  const input = document.getElementById('cmd-palette-input');
  input.value = '';
  filterCommands('');
  input.focus();
}
export function closeCommandPalette() {
  document.getElementById('cmd-palette').classList.add('hidden');
}
export function setupCommandPaletteListeners() {
  const palette = document.getElementById('cmd-palette');
  document.getElementById('cmd-palette-input')?.addEventListener('input', e => {
    filterCommands(e.target.value.trim());
  });
  document.getElementById('cmd-palette-input')?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); app._cmdActiveIdx = Math.min(app._cmdActiveIdx + 1, app._cmdFiltered.length - 1); renderCommandList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); app._cmdActiveIdx = Math.max(app._cmdActiveIdx - 1, 0); renderCommandList(); }
    else if (e.key === 'Enter') { e.preventDefault(); execCmd(app._cmdActiveIdx); }
    else if (e.key === 'Escape') { closeCommandPalette(); }
  });
  if (palette) {
    palette.addEventListener('click', e => {
      const el = e.target.closest('[data-action="exec-cmd"]');
      if (el) execCmd(parseInt(el.dataset.idx));
    });
    palette.addEventListener('mouseenter', e => {
      const el = e.target.closest('.cmd-palette-item[data-idx]');
      if (el) setCmdActive(parseInt(el.dataset.idx));
    }, true);
  }
}

// ─── Settings Export/Import ───
export async function exportSettings() {
  try {
    const res = await fetch('/api/settings/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cockpit-projects.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Settings exported', 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}
export async function importSettings(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/settings/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (result.error) showToast('Import failed: ' + result.error, 'error');
    else { showToast(`Imported ${result.imported} projects`, 'success'); location.reload(); }
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
  input.value = '';
}

// ─── Discover Projects ───
export async function openDiscoverModal() {
  const dialog = document.getElementById('discover-dialog');
  if (!dialog.dataset.delegated) {
    dialog.dataset.delegated = '1';
    dialog.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'toggle-select-all') toggleDiscoverSelectAll();
      else if (el.dataset.action === 'toggle-discover') toggleDiscoverItem(parseInt(el.dataset.idx));
    });
  }
  const body = document.getElementById('discover-body');
  const footer = document.getElementById('discover-footer');
  app._discoverData = [];
  app._discoverSelected.clear();
  body.innerHTML = '<div class="discover-loading">Scanning Claude projects</div>';
  footer.style.display = 'none';
  dialog.showModal();
  try {
    const res = await fetch('/api/discover-projects');
    app._discoverData = await res.json();
    renderDiscoverList();
  } catch (err) {
    body.innerHTML = `<div class="discover-empty">Failed to scan: ${esc(err.message)}</div>`;
  }
}
function renderDiscoverList() {
  const body = document.getElementById('discover-body');
  const footer = document.getElementById('discover-footer');
  if (app._discoverData.length === 0) {
    body.innerHTML = '<div class="discover-empty">No new projects found.<br><span style="font-size:.78rem;color:var(--text-3)">All Claude Code projects are already added.</span></div>';
    footer.style.display = 'none';
    return;
  }
  footer.style.display = '';
  const allSelected = app._discoverSelected.size === app._discoverData.length;
  let html = `<div class="discover-header">
    <span class="discover-count">${app._discoverData.length} project${app._discoverData.length > 1 ? 's' : ''} found</span>
    <button class="discover-select-all" data-action="toggle-select-all">${allSelected ? 'Deselect All' : 'Select All'}</button>
  </div><div class="discover-list">`;
  for (let i = 0; i < app._discoverData.length; i++) {
    const p = app._discoverData[i];
    const sel = app._discoverSelected.has(i) ? ' selected' : '';
    const gitBadge = p.hasGit ? '<span class="discover-badge git">git</span>' : '<span class="discover-badge no-git">no git</span>';
    const sessions = p.sessionCount ? `${p.sessionCount} session${p.sessionCount > 1 ? 's' : ''}` : '';
    const activity = p.lastActivity ? timeAgo(p.lastActivity) : '';
    const meta = [sessions, activity].filter(Boolean).join(' \u00B7 ');
    html += `<div class="discover-item${sel}" data-action="toggle-discover" data-idx="${i}">
      <div class="discover-check"></div>
      <div class="discover-info">
        <div class="discover-name">${esc(p.name)} ${gitBadge}</div>
        <div class="discover-path">${esc(p.path)}</div>
        ${meta ? `<div class="discover-meta">${meta}</div>` : ''}
      </div>
    </div>`;
  }
  html += '</div>';
  body.innerHTML = html;
  updateDiscoverBtn();
}
export function toggleDiscoverItem(idx) {
  if (app._discoverSelected.has(idx)) app._discoverSelected.delete(idx);
  else app._discoverSelected.add(idx);
  renderDiscoverList();
}
export function toggleDiscoverSelectAll() {
  if (app._discoverSelected.size === app._discoverData.length) {
    app._discoverSelected.clear();
  } else {
    for (let i = 0; i < app._discoverData.length; i++) app._discoverSelected.add(i);
  }
  renderDiscoverList();
}
function updateDiscoverBtn() {
  const btn = document.getElementById('discover-add-btn');
  if (btn) btn.textContent = `Add Selected (${app._discoverSelected.size})`;
}
export async function addDiscoveredProjects() {
  if (app._discoverSelected.size === 0) { showToast('Select at least one project', 'warn'); return; }
  const projects = [...app._discoverSelected].map(i => app._discoverData[i]).map(p => ({ name: p.name, path: p.path }));
  try {
    const res = await fetch('/api/discover-projects/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projects }) });
    const result = await res.json();
    if (result.error) { showToast('Failed: ' + result.error, 'error'); return; }
    showToast(`Added ${result.added} project${result.added > 1 ? 's' : ''}`, 'success');
    document.getElementById('discover-dialog').close();
    location.reload();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ─── Error Log Viewer ───
export function setupErrorLogCapture() {
  const origConsoleError = console.error;
  console.error = (...args) => {
    origConsoleError.apply(console, args);
    app._errorLog.push({ time: new Date().toISOString(), message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') });
    if (app._errorLog.length > 200) app._errorLog.shift();
    const btn = document.getElementById('error-log-btn');
    if (btn) btn.style.display = '';
  };
  window.addEventListener('error', e => {
    app._errorLog.push({ time: new Date().toISOString(), message: `${e.message} at ${e.filename}:${e.lineno}` });
    if (app._errorLog.length > 200) app._errorLog.shift();
    const btn = document.getElementById('error-log-btn');
    if (btn) btn.style.display = '';
  });
  window.addEventListener('unhandledrejection', e => {
    app._errorLog.push({ time: new Date().toISOString(), message: `Unhandled rejection: ${e.reason}` });
    if (app._errorLog.length > 200) app._errorLog.shift();
    const btn = document.getElementById('error-log-btn');
    if (btn) btn.style.display = '';
  });
}
export function openErrorLog() {
  const dlg = document.getElementById('error-log-dialog');
  const content = document.getElementById('error-log-content');
  if (!app._errorLog.length) {
    content.innerHTML = '<div class="error-log-empty">No errors logged</div>';
  } else {
    content.innerHTML = [...app._errorLog].reverse().map(e => {
      const t = new Date(e.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="error-log-item"><span class="el-time">${t}</span><span class="el-msg">${esc(e.message)}</span></div>`;
    }).join('');
  }
  dlg.showModal();
}
export function clearErrorLog() {
  app._errorLog.length = 0;
  document.getElementById('error-log-content').innerHTML = '<div class="error-log-empty">No errors logged</div>';
  const btn = document.getElementById('error-log-btn');
  if (btn) btn.style.display = 'none';
  showToast('Error log cleared', 'info');
}

// ─── Notification Filtering ───
function isNotifEnabledForProject(projectId) {
  return app._notifFilter[projectId] !== false;
}
function saveNotifFilter() {
  localStorage.setItem('dl-notif-filter', JSON.stringify(app._notifFilter));
}
export function toggleProjectNotif(projectId) {
  app._notifFilter[projectId] = !isNotifEnabledForProject(projectId);
  saveNotifFilter();
  renderNotifFilterList();
}
export function openNotifSettings() {
  renderNotifFilterList();
  document.getElementById('notif-settings-dialog').showModal();
}
export function renderNotifFilterList() {
  const el = document.getElementById('notif-filter-list');
  if (!el) return;
  el.innerHTML = app.projectList.map(p => {
    const enabled = isNotifEnabledForProject(p.id);
    return `<div class="notif-filter-row" data-id="${esc(p.id)}">
      <span class="nf-dot" style="background:${p.color}"></span>
      <span class="nf-name">${esc(p.name)}</span>
      <button class="notif-toggle ${enabled ? 'on' : ''}" data-action="toggle-notif" title="${enabled ? 'Disable' : 'Enable'} notifications"></button>
    </div>`;
  }).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="toggle-notif"]');
      if (!btn) return;
      const id = btn.closest('[data-id]')?.dataset.id;
      if (id) toggleProjectNotif(id);
    });
  }
}

// ─── Git History Viewer ───
export async function showGitLog(projectId) {
  const dlg = document.getElementById('git-log-dialog');
  const content = document.getElementById('git-log-content');
  const project = app.projectList.find(p => p.id === projectId);
  document.getElementById('git-log-title').textContent = `Git History \u2014 ${project?.name || projectId}`;
  content.innerHTML = '<div style="padding:14px;color:var(--text-3)">Loading\u2026</div>';
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/git/log?limit=50`);
    const data = await res.json();
    if (!data.commits?.length) {
      content.innerHTML = '<div style="padding:14px;color:var(--text-3)">No commits found</div>';
      return;
    }
    content.innerHTML = data.commits.map(c =>
      `<div class="git-log-item">
        <span class="git-log-hash">${esc(c.short)}</span>
        <span class="git-log-msg" title="${esc(c.message)}">${esc(c.message)}</span>
        <span class="git-log-author">${esc(c.author)}</span>
        <span class="git-log-time">${esc(c.ago)}</span>
      </div>`
    ).join('');
  } catch {
    content.innerHTML = '<div style="padding:14px;color:var(--red)">Error loading git log</div>';
  }
}

// ─── Session History ───
export async function showSessionHistory(projectId) {
  const dlg = document.getElementById('session-dialog');
  if (!dlg.dataset.delegated) {
    dlg.dataset.delegated = '1';
    dlg.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      e.stopPropagation();
      if (el.dataset.action === 'view-conv') viewSessionConversation(el.dataset.pid, el.dataset.sid);
      else if (el.dataset.action === 'resume-session') resumeSessionFromHistory(el.dataset.pid, el.dataset.sid);
    });
  }
  const content = document.getElementById('session-dialog-content');
  const project = app.projectList.find(p => p.id === projectId);
  document.getElementById('session-dialog-title').textContent = `Sessions \u2014 ${project?.name || projectId}`;
  content.innerHTML = '<div style="color:var(--text-3)">Loading\u2026</div>';
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/sessions`);
    const sessions = await res.json();
    if (!sessions?.length) {
      content.innerHTML = '<div style="color:var(--text-3)">No sessions found</div>';
      return;
    }
    content.innerHTML = sessions.slice(0, 30).map(s => {
      const model = (s.model || '?').replace('claude-', '').replace(/-\d{8}$/, '');
      const ago = s.lastModified ? timeAgo(s.lastModified) : '?';
      const size = s.sizeKB ? `${s.sizeKB} KB` : '';
      return `<div class="session-item">
        <span class="si-status" style="background:var(--text-3)"></span>
        <span class="si-model">${model}</span>
        <span class="si-time">${ago} ago</span>
        <span class="si-tokens">${size}</span>
        <span class="si-id">${(s.sessionId || '').slice(-8)}</span>
        <button class="btn" style="font-size:.68rem;padding:2px 6px" data-action="view-conv" data-pid="${esc(projectId)}" data-sid="${esc(s.sessionId)}" title="View conversation">View</button>
        <button class="btn" style="font-size:.68rem;padding:2px 6px" data-action="resume-session" data-pid="${esc(projectId)}" data-sid="${esc(s.sessionId)}" title="Resume session">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    }).join('');
  } catch {
    content.innerHTML = '<div style="color:var(--red)">Error loading sessions</div>';
  }
}
export async function resumeSessionFromHistory(projectId, sessionId) {
  document.getElementById('session-dialog').close();
  try {
    await fetch(`/api/sessions/${projectId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    showToast('Resuming session...', 'info');
  } catch (err) {
    showToast('Resume failed: ' + err.message, 'error');
  }
}

// ─── Conversation Viewer ───
export async function viewSessionConversation(projectId, sessionId) {
  let dlg = document.getElementById('conv-viewer-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'conv-viewer-dialog';
    dlg.style.cssText = 'max-width:800px;width:95%;max-height:85vh';
    dlg.innerHTML = `<div class="modal-header">
      <h2 id="conv-viewer-title">Conversation</h2>
      <button class="modal-close" data-action="close-conv-viewer">&times;</button>
    </div>
    <div class="modal-body" style="max-height:70vh;overflow-y:auto;padding:0">
      <div id="conv-viewer-content" style="padding:14px"></div>
    </div>`;
    dlg.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (el?.dataset.action === 'close-conv-viewer') dlg.close();
    });
    document.body.appendChild(dlg);
  }
  const content = document.getElementById('conv-viewer-content');
  const project = app.projectList.find(p => p.id === projectId);
  document.getElementById('conv-viewer-title').textContent = `${project?.name || projectId} — ${sessionId.slice(-8)}`;
  content.innerHTML = '<div style="color:var(--text-3);padding:20px">Loading conversation...</div>';
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/sessions/${sessionId}/messages`);
    const msgs = await res.json();
    if (!msgs?.length) {
      content.innerHTML = '<div style="color:var(--text-3);padding:20px">No messages found</div>';
      return;
    }
    content.innerHTML = msgs.map(m => {
      const isUser = m.role === 'user';
      const time = m.ts ? new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const modelTag = !isUser && m.model ? `<span class="cv-model">${esc(m.model)}</span>` : '';
      const toolsHtml = m.tools?.length ? m.tools.map(t =>
        `<div class="cv-tool"><span class="cv-tool-name">${esc(t.name)}</span><span class="cv-tool-input">${esc(t.input)}</span></div>`
      ).join('') : '';
      const text = esc(m.content || '')
        .replace(/```([\s\S]*?)```/g, '<pre class="cv-code">$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
      return `<div class="cv-msg ${isUser ? 'cv-user' : 'cv-ai'}">
        <div class="cv-header"><span class="cv-role">${isUser ? 'User' : 'Assistant'}</span>${modelTag}<span class="cv-time">${time}</span></div>
        <div class="cv-body">${text}</div>
        ${toolsHtml}
      </div>`;
    }).join('');
  } catch (err) {
    content.innerHTML = `<div style="color:var(--red);padding:20px">Error: ${esc(err.message)}</div>`;
  }
}

// ─── File Preview ───
function ensurePreviewModal() {
  if (document.getElementById('file-preview-overlay')) return;
  const el = document.createElement('div');
  el.id = 'file-preview-overlay';
  el.className = 'file-preview-overlay hidden';
  el.innerHTML = `<div class="file-preview-card">
    <div class="fp-header">
      <svg class="fp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="fp-name"></span>
      <span class="fp-path"></span>
      <span class="fp-size"></span>
      <button class="fp-close" data-action="close-preview">&times;</button>
    </div>
    <div class="fp-body"></div>
    <div class="fp-actions">
      <button class="btn" data-action="copy-path">Copy Path</button>
      <button class="btn" data-action="copy-content">Copy Content</button>
      <button class="btn" data-action="copy-codeblock">Copy as Code Block</button>
      <button class="btn" data-action="insert-path">Insert to Terminal</button>
    </div>
  </div>`;
  el.addEventListener('click', e => {
    if (e.target === el) { closeFilePreview(); return; }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'close-preview': closeFilePreview(); break;
      case 'copy-path': copyFilePathToClipboard(); break;
      case 'copy-content': copyFileContent(); break;
      case 'copy-codeblock': copyFileAsCodeBlock(); break;
      case 'insert-path': insertPathToTerminal(); break;
    }
  });
  document.body.appendChild(el);
}
export function openFilePreviewFromFile(file) {
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();
  ensurePreviewModal();
  const el = document.getElementById('file-preview-overlay');
  el.classList.remove('hidden');
  el.querySelector('.fp-name').textContent = name;
  el.querySelector('.fp-path').textContent = '(Dropped file)';
  el._filePath = name;
  el._content = '';
  const sizeStr = file.size < 1024 ? file.size + 'B' : (file.size / 1024).toFixed(1) + 'KB';
  el.querySelector('.fp-size').textContent = sizeStr;
  const body = el.querySelector('.fp-body');
  if (IMG_EXT.has(ext)) {
    const url = URL.createObjectURL(file);
    body.innerHTML = `<img class="fp-img" src="${url}" alt="${esc(name)}">`;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    body.innerHTML = '<div style="padding:20px;color:var(--red)">File too large (>2MB)</div>';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    el._content = reader.result;
    const lines = reader.result.split('\n');
    const escaped = lines.map((l, i) => `<span class="line-num">${i + 1}</span>${escapeHtml(l)}`).join('\n');
    body.innerHTML = `<pre>${escaped}</pre>`;
  };
  reader.onerror = () => { body.innerHTML = '<div style="padding:20px;color:var(--red)">Failed to read file</div>'; };
  reader.readAsText(file);
}
export function openFilePreview(filePath) {
  const name = filePath.replace(/\\/g, '/').split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  ensurePreviewModal();
  const el = document.getElementById('file-preview-overlay');
  el.classList.remove('hidden');
  el.querySelector('.fp-name').textContent = name;
  el.querySelector('.fp-path').textContent = filePath;
  el._filePath = filePath;
  el._content = '';
  const body = el.querySelector('.fp-body');
  body.innerHTML = '<div style="padding:20px;color:var(--text-3)">Loading...</div>';
  if (IMG_EXT.has(ext)) {
    const assetUrl = window.__TAURI__?.core?.convertFileSrc?.(filePath) || 'file:///' + filePath.replace(/\\/g, '/');
    body.innerHTML = `<img class="fp-img" src="${assetUrl}" alt="${esc(name)}">`;
    el.querySelector('.fp-size').textContent = 'Image';
    return;
  }
  fetch('/api/file?path=' + encodeURIComponent(filePath))
    .then(r => r.json())
    .then(data => {
      if (data.error) { body.innerHTML = `<div style="padding:20px;color:var(--red)">${esc(data.error)}</div>`; return; }
      el._content = data.content;
      const sizeStr = data.size < 1024 ? data.size + 'B' : (data.size / 1024).toFixed(1) + 'KB';
      el.querySelector('.fp-size').textContent = sizeStr;
      const lines = data.content.split('\n');
      const escaped = lines.map((l, i) => `<span class="line-num">${i + 1}</span>${escapeHtml(l)}`).join('\n');
      body.innerHTML = `<pre>${escaped}</pre>`;
    })
    .catch(() => { body.innerHTML = '<div style="padding:20px;color:var(--red)">Failed to read file</div>'; });
}
export function closeFilePreview() {
  const el = document.getElementById('file-preview-overlay');
  if (el) el.classList.add('hidden');
}
export function copyFilePathToClipboard() {
  const el = document.getElementById('file-preview-overlay');
  if (el?._filePath) navigator.clipboard.writeText(el._filePath).then(() => showToast('Path copied')).catch(() => {});
}
export function copyFileContent() {
  const el = document.getElementById('file-preview-overlay');
  if (el?._content) navigator.clipboard.writeText(el._content).then(() => showToast('Content copied')).catch(() => showToast('Copy failed — clipboard denied', 'error'));
}
export function copyFileAsCodeBlock() {
  const el = document.getElementById('file-preview-overlay');
  if (!el?._content || !el?._filePath) return;
  const ext = el._filePath.split('.').pop() || '';
  const block = '```' + ext + '\n' + el._content + '\n```';
  navigator.clipboard.writeText(block).then(() => showToast('Copied as code block')).catch(() => showToast('Copy failed', 'error'));
}
export function insertPathToTerminal() {
  const el = document.getElementById('file-preview-overlay');
  if (!el?._filePath || !app.activeTermId || !app.ws || app.ws.readyState !== 1) return;
  const p = el._filePath;
  app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: p.includes(' ') ? `"${p}"` : p }));
  closeFilePreview();
  window.switchView?.('terminal');
  showToast('Path inserted');
}

// ─── Context Menu ───
export function hideCtxMenu() {
  if (app._ctxMenu) { app._ctxMenu.remove(); app._ctxMenu = null; }
}
export function showCtxMenu(x, y, items) {
  hideCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (item === 'sep') { const d = document.createElement('div'); d.className = 'ctx-menu-sep'; menu.appendChild(d); continue; }
    if (item.label) { const d = document.createElement('div'); d.className = 'ctx-menu-label'; d.textContent = item.label; menu.appendChild(d); continue; }
    const d = document.createElement('div');
    d.className = 'ctx-menu-item';
    d.innerHTML = (item.icon || '') + `<span>${item.text}</span>`;
    d.onclick = e => { e.stopPropagation(); hideCtxMenu(); item.action(); };
    menu.appendChild(d);
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  app._ctxMenu = menu;
}
export const ICON = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
};
export function getFilePathAtPosition(xterm, x, y) {
  const line = xterm.buffer.active.getLine(y)?.translateToString() || '';
  const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|usr|tmp|var|etc|opt|mnt)[^\s"'<>|:]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (x >= m.index && x < m.index + m[0].length) return m[0];
  }
  return null;
}
export function openInIde(filePath, ide) {
  fetch('/api/open-in-ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, ide }) })
    .then(r => r.json())
    .then(d => { if (d.opened) showToast(`Opened in ${ide}`); else showToast(d.error || 'Failed', 'error'); })
    .catch(() => showToast('Failed to open', 'error'));
}
export function openContainingFolder(filePath) {
  fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) })
    .then(() => showToast('Opened in Explorer'))
    .catch(() => {});
}
export function setupCtxMenuListeners() {
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('contextmenu', hideCtxMenu);
}
