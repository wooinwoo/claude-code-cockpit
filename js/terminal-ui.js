// ─── Terminal UI: context menu, headers, layout rendering, mobile, drag/drop,
//     selection toolbar, quick bar, presets, broadcast, command palette,
//     file drop, event delegation ───
import { app, notify } from './state.js';
import { esc, showToast, escapeHtml } from './utils.js';
import { registerClickActions, registerInputActions } from './actions.js';

// ─── Imports from terminal core (will be set via init) ───
let _core = null;

export function initTermUI(core) {
  _core = core;
}

// ─── Layout Rendering ───
export function renderLayout() {
  if (isMobile()) { renderMobileLayout(); return; }
  const container = document.getElementById('term-panels');
  for (const [, t] of app.termMap) { if (t.element.parentNode) t.element.parentNode.removeChild(t.element); }
  container.innerHTML = '';
  // Hide mobile elements on desktop
  const mobTabs = document.getElementById('mob-term-tabs');
  const mobActions = document.getElementById('mob-term-actions');
  if (mobTabs) mobTabs.style.display = 'none';
  if (mobActions) mobActions.style.display = 'none';
  if (!app.layoutRoot) {
    container.innerHTML = `<div class="term-empty">
        <div class="term-empty-icon">&#x2756;</div>
        <button class="btn" data-action="new-term">+ New Terminal</button>
        <div class="term-empty-hint">Ctrl+T</div>
        <div class="term-empty-features">
          <span class="term-ef">&#x2194;&#xFE0F; Split</span>
          <span class="term-ef">&#x1F50D; Search</span>
          <span class="term-ef">&#x1F4E1; Broadcast</span>
          <span class="term-ef">&#x1F4BE; Export</span>
        </div>
      </div>`;
    return;
  }
  renderNode(app.layoutRoot, container);
  app._headCache.clear();
  updateTermHeaders();
  requestAnimationFrame(() => {
    for (const [_termId, t] of app.termMap) {
      if (!t.opened && t.element.parentNode) {
        t.xterm.open(t.element);
        if (!window.chrome?.webview) { try { t.xterm.loadAddon(new WebglAddon.WebglAddon()); } catch { /* addon not available */ } }
        try { t.xterm.loadAddon(new ImageAddon.ImageAddon()); } catch { /* addon not available */ }
        t.opened = true;
        if (t.pendingBuffer) { t.xterm.write(t.pendingBuffer); t.pendingBuffer = null; }
      }
    }
    setTimeout(() => _core.fitAllTerminals(), 120);
  });
  _core.saveLayout();
}

// ─── Mobile Layout ───
function renderMobileLayout() {
  const container = document.getElementById('term-panels');
  const mobTabs = document.getElementById('mob-term-tabs');
  const mobActions = document.getElementById('mob-term-actions');

  // Detach all terminal elements
  for (const [, t] of app.termMap) { if (t.element.parentNode) t.element.parentNode.removeChild(t.element); }
  container.innerHTML = '';

  if (app.termMap.size === 0) {
    container.innerHTML = `<div class="term-empty">
        <div class="term-empty-icon">&#x2756;</div>
        <button class="btn" data-action="new-term">+ New Terminal</button>
        <div class="term-empty-hint">Ctrl+T</div>
      </div>`;
    if (mobTabs) mobTabs.style.display = 'none';
    if (mobActions) mobActions.style.display = 'none';
    return;
  }

  // Show mobile elements
  if (mobTabs) mobTabs.style.display = '';
  if (mobActions) mobActions.style.display = '';

  // Ensure activeTermId is valid
  if (!app.activeTermId || !app.termMap.has(app.activeTermId)) {
    app.activeTermId = app.termMap.keys().next().value;
  }

  // Render tab bar
  if (mobTabs) {
    let tabsHtml = '';
    for (const [id, t] of app.termMap) {
      const active = id === app.activeTermId ? ' active' : '';
      tabsHtml += `<button class="mob-tab${active}" data-tid="${id}" data-action="mob-switch" data-termid="${id}">` +
        `<span class="mob-tab-dot" style="background:${t.color}"></span>` +
        `<span class="mob-tab-name">${esc(t.label)}</span></button>`;
    }
    tabsHtml += `<button class="mob-tab mob-tab-add" data-action="new-term">+</button>`;
    mobTabs.innerHTML = tabsHtml;
    // Auto-scroll to active tab
    const activeTab = mobTabs.querySelector('.mob-tab.active');
    if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  // Render only the active terminal
  const activeT = app.termMap.get(app.activeTermId);
  if (activeT) {
    activeT.element.style.flex = '1';
    container.appendChild(activeT.element);
    requestAnimationFrame(() => {
      if (!activeT.opened) {
        activeT.xterm.open(activeT.element);
        if (!window.chrome?.webview) { try { activeT.xterm.loadAddon(new WebglAddon.WebglAddon()); } catch { /* addon not available */ } }
        try { activeT.xterm.loadAddon(new ImageAddon.ImageAddon()); } catch { /* addon not available */ }
        activeT.opened = true;
        if (activeT.pendingBuffer) { activeT.xterm.write(activeT.pendingBuffer); activeT.pendingBuffer = null; }
      }
      setTimeout(() => { try { activeT.fitAddon.fit(); } catch { /* addon not available */ } }, 80);
      if (app.ws?.readyState === 1) app.ws.send(JSON.stringify({ type: 'resize', termId: app.activeTermId, cols: activeT.xterm.cols, rows: activeT.xterm.rows }));
    });
  }
  _core.saveLayout();
}

export function mobileSwitchTerm(termId) {
  if (!app.termMap.has(termId)) return;
  app.activeTermId = termId;
  renderMobileLayout();
}

export function mobileCloseTerm(termId) {
  _core.closeTerminal(termId);
  renderMobileLayout();
}

function renderNode(node, container) {
  if (node.type === 'leaf') {
    const t = app.termMap.get(node.termId);
    if (!t) return;
    const leaf = document.createElement('div');
    leaf.className = 'split-leaf'; leaf.dataset.termId = node.termId;
    leaf.style.display = 'flex'; leaf.style.flexDirection = 'column';
    const head = document.createElement('div');
    head.className = 'term-head'; head.draggable = true; head.dataset.termId = node.termId; head.style.cursor = 'grab';
    leaf.appendChild(head); leaf.appendChild(t.element);
    const overlay = document.createElement('div'); overlay.className = 'drop-overlay';
    ['top', 'bottom', 'left', 'right'].forEach(pos => { const zone = document.createElement('div'); zone.className = `drop-zone ${pos}`; overlay.appendChild(zone); });
    leaf.appendChild(overlay); container.appendChild(leaf);
    return;
  }
  const splitEl = document.createElement('div');
  splitEl.className = `split-container ${node.dir === 'h' ? 'horizontal' : 'vertical'}`;
  const prop = node.dir === 'h' ? 'width' : 'height';
  const first = document.createElement('div');
  first.className = 'split-child'; first.style[prop] = `calc(${node.ratio * 100}% - 2px)`;
  first.style[node.dir === 'h' ? 'height' : 'width'] = '100%';
  renderNode(node.children[0], first); splitEl.appendChild(first);
  const divider = document.createElement('div');
  divider.className = `split-divider ${node.dir === 'h' ? 'h' : 'v'}`;
  divider.addEventListener('mousedown', e => startDividerDrag(e, node, splitEl));
  splitEl.appendChild(divider);
  const second = document.createElement('div');
  second.className = 'split-child'; second.style[prop] = `calc(${(1 - node.ratio) * 100}% - 2px)`;
  second.style[node.dir === 'h' ? 'height' : 'width'] = '100%';
  renderNode(node.children[1], second); splitEl.appendChild(second);
  container.appendChild(splitEl);
}

function startDividerDrag(e, node, splitEl) {
  e.preventDefault();
  const isH = node.dir === 'h';
  const rect = splitEl.getBoundingClientRect();
  const totalSize = isH ? rect.width : rect.height;
  const firstChild = splitEl.children[0], secondChild = splitEl.children[2];
  const prop = isH ? 'width' : 'height';
  const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:' + (isH ? 'col-resize' : 'row-resize');
  document.body.appendChild(cover);
  document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
  document.body.style.userSelect = 'none';
  const onMove = e => {
    const pos = isH ? e.clientX - rect.left : e.clientY - rect.top;
    const ratio = Math.max(0.08, Math.min(0.92, pos / totalSize));
    node.ratio = ratio;
    firstChild.style[prop] = `calc(${ratio * 100}% - 2px)`;
    secondChild.style[prop] = `calc(${(1 - ratio) * 100}% - 2px)`;
    _core.debouncedFit();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    cover.remove(); _core.fitAllTerminals(); _core.saveLayout();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Mobile Detection ───
export function isMobile() {
  return window.innerWidth <= 600 || (window.matchMedia('(hover: none) and (pointer: coarse)').matches && window.innerWidth <= 900);
}

// ─── Terminal Headers ───
export function debouncedUpdateTermHeaders() {
  if (app._termHeaderTimer) return;
  app._termHeaderTimer = requestAnimationFrame(() => { app._termHeaderTimer = null; updateTermHeaders(); });
}

// ─── Duration Formatter ───
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function updateTermHeaders() {
  document.querySelectorAll('.split-leaf').forEach(leaf => {
    const tid = leaf.dataset.termId;
    const t = app.termMap.get(tid);
    if (!t) return;
    leaf.classList.toggle('active', tid === app.activeTermId);
    let head = leaf.querySelector('.term-head');
    if (!head) { head = document.createElement('div'); head.className = 'term-head'; leaf.insertBefore(head, leaf.firstChild); }
    const g = app.state.projects.get(t.projectId)?.git || {};
    const s = app.state.projects.get(t.projectId)?.session || {};
    const model = s.model ? s.model.replace('claude-', '').replace(/-\d{8}$/, '') : '';
    const wt = (g.worktrees || []).filter(w => !w.bare);
    const nv = app.nodeVersion || '';
    const bufUsed = t.xterm.buffer.active.length;
    const bufPct = Math.round(bufUsed / _core.getScrollback() * 100);
    const timerStr = t.createdAt ? fmtDuration(Date.now() - t.createdAt) : '';
    const cacheKey = `${t.label}|${t.color}|${g.branch || ''}|${g.uncommittedCount || 0}|${model}|${nv}|${wt.length}|${tid === app.activeTermId}|${bufPct}|${timerStr}`;
    if (app._headCache.get(tid) === cacheKey) return;
    app._headCache.set(tid, cacheKey);
    const p = app.projectList.find(pp => pp.id === t.projectId);
    const pPath = (p?.path || '').replace(/\\/g, '/');
    const currentWt = wt.find(w => w.path === pPath || pPath.endsWith(w.path));
    let wtTag = '';
    if (wt.length > 1) {
      const wtName = currentWt ? currentWt.path.split('/').pop() : wt[0].path.split('/').pop();
      const popoverItems = wt.map(w => { const isCur = w === currentWt; return `<div class="wt-popover-item${isCur ? ' wt-current' : ''}"><span class="wt-branch">${esc(w.branch || '?')}${isCur ? ' \u2190' : ''}</span><span class="wt-path">${esc(w.path)}</span></div>`; }).join('');
      wtTag = `<span class="th-tag th-worktree">${esc(wtName)} <span style="opacity:.5">+${wt.length - 1}</span><div class="wt-popover">${popoverItems}</div></span>`;
    }
    const projectPath = p?.path || '';
    head.title = projectPath;
    head.innerHTML = `<span class="th-dot" style="background:${t.color}"></span>` +
      `<span class="th-name">${esc(t.label)}</span>` +
      (g.branch ? `<span class="th-tag th-branch">${esc(g.branch)}</span>` : '') + wtTag +
      (g.uncommittedCount ? `<span class="th-tag th-changes" data-pid="${t.projectId}">\u00B1${g.uncommittedCount}</span>` : '') +
      (model ? `<span class="th-tag th-model">${esc(model)}</span>` : '') +
      (nv ? `<span class="th-tag th-node" title="Node.js ${nv}">${esc(nv)}</span>` : '') +
      (t.createdAt ? `<span class="th-tag th-timer" title="Session duration">${fmtDuration(Date.now() - t.createdAt)}</span>` : '') +
      (bufPct >= 80 ? `<span class="th-tag th-buf" data-action="clear-buf" style="color:${bufPct >= 95 ? 'var(--red)' : 'var(--yellow)'};font-size:.7rem;cursor:pointer" title="Buffer ${bufPct}% — click to clear">${bufPct}%</span>` : '') +
      `<span class="th-spacer"></span>` +
      `<button class="th-close" data-action="close" title="Close">\u00d7</button>`;
    head.onclick = e => {
      if (e.target.dataset.action === 'close') { e.stopPropagation(); _core.closeTerminal(tid); return; }
      if (e.target.dataset.action === 'clear-buf') { e.stopPropagation(); const tt = app.termMap.get(tid); if (tt?.xterm) { tt.xterm.clear(); showToast('Buffer cleared'); updateTermHeaders(); } return; }
      if (e.target.classList.contains('th-changes')) { e.stopPropagation(); showDiffForProject(e.target.dataset.pid); return; }
    };
    head.ondblclick = e => {
      if (e.target.dataset.action === 'close') return;
      e.stopPropagation();
      if (e.target.classList.contains('th-name')) { startRenameHeader(tid, head); return; }
      // Maximize / restore toggle
      if (app._savedLayout) {
        app.layoutRoot = app._savedLayout; app._savedLayout = null;
        showToast('Layout restored');
      } else if (app.layoutRoot?.type === 'split') {
        app._savedLayout = JSON.parse(JSON.stringify(app.layoutRoot));
        app.layoutRoot = { type: 'leaf', termId: tid };
        showToast('Maximized');
      }
      app.activeTermId = tid; updateTermHeaders(); renderLayout();
    };
  });
}

export function startRenameHeader(termId, headEl) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const nameSpan = headEl.querySelector('.th-name');
  const input = document.createElement('input');
  input.type = 'text'; input.value = t.label;
  input.style.cssText = 'font-size:.68rem;padding:1px 4px;background:var(--bg-0);border:1px solid var(--accent);color:var(--text-1);border-radius:3px;width:100px;';
  const finish = () => { const val = input.value.trim(); if (val) t.label = val; updateTermHeaders(); _core.saveLayout(); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') updateTermHeaders(); e.stopPropagation(); });
  input.addEventListener('blur', finish);
  nameSpan.replaceWith(input); input.focus(); input.select();
}

// ─── Context Menu ───
let _ctxDismiss = null;

// SVG icons (13px, stroke-based, explicit size)
const _S = 'width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"';
const _ci = {
  copy:     `<svg ${_S}><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M3.5 10.5V3.5a1 1 0 011-1h5"/></svg>`,
  paste:    `<svg ${_S}><rect x="4" y="4" width="8.5" height="9.5" rx="1"/><path d="M6.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1"/></svg>`,
  run:      `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3l8 5-8 5V3z"/></svg>`,
  splitH:   `<svg ${_S}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="8" y1="2.5" x2="8" y2="13.5"/></svg>`,
  splitV:   `<svg ${_S}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>`,
  search:   `<svg ${_S}><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5"/></svg>`,
  clear:    `<svg ${_S}><path d="M3 3l10 10M13 3L3 13"/></svg>`,
  close:    `<svg ${_S}><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>`,
  file:     `<svg ${_S}><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M9 2v4h4"/></svg>`,
  ide:      `<svg ${_S}><rect x="1.5" y="2" width="13" height="12" rx="1.5"/><path d="M6 6L4 8l2 2M10 6l2 2-2 2"/></svg>`,
  folder:   `<svg ${_S}><path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/></svg>`,
  globe:    `<svg ${_S}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.5 2 9.5 0 12M8 2c-2 2.5-2 9.5 0 12"/></svg>`,
  git:      `<svg ${_S}><circle cx="8" cy="4" r="1.5"/><circle cx="8" cy="12" r="1.5"/><line x1="8" y1="5.5" x2="8" y2="10.5"/></svg>`,
  broadcast:`<svg ${_S}><circle cx="8" cy="8" r="2"/><path d="M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7"/></svg>`,
  export:   `<svg ${_S}><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 11v2h10v-2"/></svg>`,
  rename:   `<svg ${_S}><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z"/></svg>`,
  cmd:      `<svg ${_S}><path d="M4 5l3 3-3 3"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`,
  newTerm:  `<svg ${_S}><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 7l2 1.5-2 1.5"/><line x1="8" y1="10" x2="11" y2="10"/></svg>`,
  select:   `<svg ${_S}><rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="2 2"/></svg>`,
  chevron:  `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4l4 4-4 4"/></svg>`,
};
const _ic = (name) => `<span class="ctx-ic">${_ci[name] || ''}</span>`;

export function showTermCtxMenu(e, termId) {
  const menu = document.getElementById('term-ctx-menu');
  const t = app.termMap.get(termId);
  if (!t) return;
  if (_ctxDismiss) _ctxDismiss();
  const g = app.state.projects.get(t.projectId)?.git || {};
  const sel = t.xterm.getSelection();
  const _pName = app.projectList.find(p => p.id === t.projectId)?.name || '';
  const termCount = app.termMap.size;

  // Detect file path at cursor
  let fileInfo = null;
  const wrap = t.element;
  const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
  const cellH = t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
  const screenEl = wrap.querySelector('.xterm-screen');
  const rect = screenEl?.getBoundingClientRect();
  if (rect) {
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row = t.xterm.buffer.active.viewportY + Math.floor((e.clientY - rect.top) / cellH);
    fileInfo = getFilePathAtPosition(t.xterm, col, row);
  }

  // ── Build menu ──
  let html = '';

  // File context (only when on a file path)
  if (fileInfo) {
    const fp = escapeHtml(fileInfo.path);
    const la = fileInfo.line ? ` data-line="${fileInfo.line}"` : '';
    const ca = fileInfo.column ? ` data-col="${fileInfo.column}"` : '';
    html += `<div class="ctx-label">File</div>`;
    html += `<div class="ctx-item" data-act="preview" data-path="${fp}"${la}>${_ic('file')}Preview</div>`;
    html += `<div class="ctx-item" data-act="open-file-ide" data-ide="code" data-path="${fp}"${la}${ca}>${_ic('ide')}Open in IDE</div>`;
    html += `<div class="ctx-item" data-act="copy-path" data-path="${fp}">${_ic('copy')}Copy Path</div>`;
    html += `<div class="ctx-sep"></div>`;
  }

  // Edit
  if (sel) {
    html += `<div class="ctx-item" data-act="copy">${_ic('copy')}Copy<span class="ctx-key">Ctrl+C</span></div>`;
    html += `<div class="ctx-item" data-act="run-sel">${_ic('run')}Run Selection</div>`;
    html += `<div class="ctx-item" data-act="select-all">${_ic('select')}Select All</div>`;
  } else {
    html += `<div class="ctx-item" data-act="select-all">${_ic('select')}Select All</div>`;
  }
  html += `<div class="ctx-item" data-act="paste">${_ic('paste')}Paste<span class="ctx-key">Ctrl+V</span></div>`;
  html += `<div class="ctx-sep"></div>`;

  // Layout
  html += `<div class="ctx-item" data-act="split-h">${_ic('splitH')}Split Right</div>`;
  html += `<div class="ctx-item" data-act="split-v">${_ic('splitV')}Split Down</div>`;
  html += `<div class="ctx-item" data-act="new-term">${_ic('newTerm')}New Terminal</div>`;
  html += `<div class="ctx-sep"></div>`;

  // Open ▸
  html += `<div class="ctx-item ctx-toggle" data-sub="open">${_ic('ide')}Open<span class="ctx-chevron">${_ci.chevron}</span></div>`;
  html += `<div class="ctx-panel" data-sub-id="open">`;
  html += `<div class="ctx-item" data-act="ide" data-ide="code">${_ic('ide')}VS Code</div>`;
  html += `<div class="ctx-item" data-act="ide" data-ide="cursor">${_ic('ide')}Cursor</div>`;
  html += `<div class="ctx-item" data-act="ide" data-ide="zed">${_ic('ide')}Zed</div>`;
  html += `<div class="ctx-item" data-act="firefox-dev">${_ic('globe')}Firefox Dev</div>`;
  html += `<div class="ctx-item" data-act="folder">${_ic('folder')}Folder</div>`;
  html += `</div>`;

  // Tools ▸
  html += `<div class="ctx-item ctx-toggle" data-sub="tools">${_ic('cmd')}Tools<span class="ctx-chevron">${_ci.chevron}</span></div>`;
  html += `<div class="ctx-panel" data-sub-id="tools">`;
  html += `<div class="ctx-item" data-act="search">${_ic('search')}Search<span class="ctx-key">Ctrl+F</span></div>`;
  html += `<div class="ctx-item" data-act="broadcast">${_ic('broadcast')}Broadcast</div>`;
  html += `<div class="ctx-item" data-act="quick-bar">${_ic('cmd')}Quick Bar<span class="ctx-key">Ctrl+J</span></div>`;
  html += `<div class="ctx-item" data-act="export">${_ic('export')}Export</div>`;
  html += `<div class="ctx-item" data-act="rename">${_ic('rename')}Rename</div>`;
  html += `</div>`;

  html += `<div class="ctx-sep"></div>`;
  if (g.uncommittedCount > 0) html += `<div class="ctx-item" data-act="diff">${_ic('git')}Changes<span class="ctx-badge">${g.uncommittedCount}</span></div>`;
  html += `<div class="ctx-item" data-act="clear">${_ic('clear')}Clear</div>`;
  if (termCount > 1) html += `<div class="ctx-item ctx-danger" data-act="close">${_ic('close')}Close</div>`;

  menu.innerHTML = html;

  // ── Submenu toggle ──
  menu.querySelectorAll('.ctx-toggle').forEach(toggle => {
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const subId = toggle.dataset.sub;
      const panel = menu.querySelector(`.ctx-panel[data-sub-id="${subId}"]`);
      if (!panel) return;
      const isOpen = panel.style.display === 'block';
      menu.querySelectorAll('.ctx-panel').forEach(s => { s.style.display = 'none'; });
      menu.querySelectorAll('.ctx-toggle').forEach(t => { t.classList.remove('ctx-active'); });
      if (!isOpen) {
        panel.style.display = 'block';
        toggle.classList.add('ctx-active');
        // Style sub-items
        panel.querySelectorAll('.ctx-item').forEach(el => {
          el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:.76rem;color:#7982a9;cursor:pointer;white-space:nowrap;border-radius:4px;margin:0 2px;';
          el.onmouseenter = () => { el.style.background = 'rgba(99,102,241,.1)'; el.style.color = '#c0caf5'; };
          el.onmouseleave = () => { el.style.background = ''; el.style.color = '#7982a9'; };
        });
      }
      requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, window.innerHeight - mr.height - 8) + 'px';
      });
    });
  });

  // ── Force styles (Tauri WebView workaround) ──
  menu.style.cssText = `
    position:fixed; z-index:10000; display:block;
    background:#1a1b26; border:1px solid #2a2b3d; border-radius:10px;
    padding:4px; min-width:190px; max-width:260px;
    box-shadow:0 12px 48px rgba(0,0,0,.6); font-family:inherit;
  `;
  // Apply item styles
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:.8rem;color:#a9b1d6;cursor:pointer;white-space:nowrap;border-radius:6px;`;
    el.onmouseenter = () => { el.style.background = '#24283b'; el.style.color = '#c0caf5'; };
    el.onmouseleave = () => { el.style.background = ''; el.style.color = el.classList.contains('ctx-danger') ? '#f7768e' : '#a9b1d6'; };
    if (el.classList.contains('ctx-danger')) el.style.color = '#f7768e';
  });
  menu.querySelectorAll('.ctx-sep').forEach(el => { el.style.cssText = 'height:1px;background:#2a2b3d;margin:3px 8px;opacity:.5;'; });
  menu.querySelectorAll('.ctx-label').forEach(el => { el.style.cssText = 'padding:5px 10px 2px;font-size:.62rem;color:#565f89;text-transform:uppercase;letter-spacing:.07em;font-weight:600;'; });
  menu.querySelectorAll('.ctx-panel').forEach(el => { el.style.cssText = 'display:none;overflow:hidden;margin:2px 4px 2px 10px;padding:2px 0;border-left:2px solid rgba(99,102,241,.3);border-radius:0 4px 4px 0;background:rgba(99,102,241,.04);'; });
  menu.querySelectorAll('.ctx-key').forEach(el => { el.style.cssText = 'margin-left:auto;font-size:.62rem;color:#565f89;font-family:monospace;padding:1px 5px;background:#16161e;border-radius:3px;border:1px solid #2a2b3d;line-height:1.2;'; });
  menu.querySelectorAll('.ctx-badge').forEach(el => { el.style.cssText = 'margin-left:auto;padding:1px 7px;border-radius:8px;font-size:.62rem;font-weight:700;background:#7aa2f7;color:#fff;'; });
  menu.querySelectorAll('.ctx-chevron').forEach(el => { el.style.cssText = 'margin-left:auto;width:10px;height:10px;opacity:.4;display:inline-flex;'; });
  menu.querySelectorAll('.ctx-ic').forEach(el => { el.style.cssText = 'width:13px;height:13px;flex-shrink:0;opacity:.45;display:inline-flex;align-items:center;'; });

  // ── Position ──
  const mRect = menu.getBoundingClientRect();
  const vW = window.innerWidth, vH = window.innerHeight;
  let left = e.clientX, top = e.clientY;
  if (left + mRect.width > vW - 8) left = Math.max(8, vW - mRect.width - 8);
  if (top + mRect.height > vH - 8) top = Math.max(8, vH - mRect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // ── Dismiss ──
  function dismiss() {
    menu.style.display = 'none';
    menu.classList.remove('show');
    menu.onclick = null;
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onEsc);
    _ctxDismiss = null;
  }
  function onOutside(ev) { if (!menu.contains(ev.target)) dismiss(); }
  function onEsc(ev) { if (ev.key === 'Escape') dismiss(); }
  _ctxDismiss = dismiss;

  // ── Actions ──
  menu.onclick = ev => {
    const item = ev.target.closest('[data-act]');
    if (!item) return;
    if (item.classList.contains('ctx-toggle')) return;
    dismiss();
    const path = item.dataset.path;
    switch (item.dataset.act) {
      case 'preview': if (path) notify('openFilePreview', path); break;
      case 'open-file-ide': if (path) openInIde(path, item.dataset.ide, t.projectId, item.dataset.line, item.dataset.col); break;
      case 'copy-path': if (path) { navigator.clipboard.writeText(path); showToast('Path copied'); } break;
      case 'copy': { const s = t.xterm.getSelection(); if (s) { navigator.clipboard.writeText(s); t.xterm.clearSelection(); showToast('Copied'); } break; }
      case 'run-sel': { const s = t.xterm.getSelection(); if (s && app.ws?.readyState === 1) { app.ws.send(JSON.stringify({ type: 'input', termId, data: s.trim() + '\r' })); t.xterm.clearSelection(); } break; }
      case 'select-all': t.xterm.selectAll(); break;
      case 'paste': (async () => { try { const items = await navigator.clipboard.read(); for (const ci of items) { const imgT = ci.types.find(x => x.startsWith('image/')); if (imgT) { const blob = await ci.getType(imgT); const r = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': imgT }, body: blob }); const { path: p } = await r.json(); if (p && app.ws?.readyState === 1) { app.ws.send(JSON.stringify({ type: 'input', termId, data: p + ' ' })); showToast('Image pasted', 'success'); } return; } } const txt = await navigator.clipboard.readText(); if (txt && app.ws?.readyState === 1) { const data = txt.includes('\n') ? `\x1b[200~${txt}\x1b[201~` : txt; app.ws.send(JSON.stringify({ type: 'input', termId, data })); } } catch { /* clipboard API unavailable */ } })(); break;
      case 'split-h': _core.openNewTermModalWithSplit(termId, 'right'); break;
      case 'split-v': _core.openNewTermModalWithSplit(termId, 'bottom'); break;
      case 'new-term': _core.openTermWith(t.projectId); break;
      case 'ide': openInIDEProject(t.projectId, item.dataset.ide); break;
      case 'firefox-dev': openInFirefoxDevFromTerm(t.projectId); break;
      case 'folder': fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: app.projectList.find(p => p.id === t.projectId)?.path }) }).catch(() => {}); break;
      case 'search': _core.toggleTermSearch(); break;
      case 'broadcast': toggleBroadcastMode(); break;
      case 'quick-bar': toggleQuickBar(); break;
      case 'export': _core.exportTerminal(); break;
      case 'rename': { const hdr = t.element.closest('.term-panel')?.querySelector('.term-header[data-id="' + termId + '"]'); if (hdr) startRenameHeader(termId, hdr); break; }
      case 'diff': showDiffForProject(t.projectId); break;
      case 'clear': t.xterm.clear(); break;
      case 'close': _core.closeTerminal(termId); break;
    }
  };

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
  }, 50);
}

function openInIDEProject(projectId, ide = 'code') {
  fetch(`/api/projects/${projectId}/open-ide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ide }) }).catch(() => {});
}

function showDiffForProject(projectId) {
  notify('switchView', 'diff');
  // Select the project in the diff dropdown and reload
  setTimeout(() => {
    const sel = document.getElementById('diff-project');
    if (sel && projectId) { sel.value = projectId; sel.dispatchEvent(new Event('change')); }
  }, 100);
}

function openInFirefoxDevFromTerm(projectId) {
  const dsInfo = app.devServerState?.find(d => d.projectId === projectId);
  const url = dsInfo?.port ? `http://localhost:${dsInfo.port}` : null;
  if (url) {
    fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, browser: 'firefox-dev' }) })
      .then(() => showToast(`Firefox Dev → localhost:${dsInfo.port}`))
      .catch(() => showToast('Failed to open', 'error'));
  } else {
    const input = prompt('Enter URL to open in Firefox Developer Edition:', 'http://localhost:3000');
    if (input) {
      fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input, browser: 'firefox-dev' }) })
        .then(() => showToast(`Firefox Dev → ${input}`))
        .catch(() => showToast('Failed to open', 'error'));
    }
  }
}

// ─── File path detection ───
function getFilePathAtPosition(xterm, x, y) {
  const line = xterm.buffer.active.getLine(y)?.translateToString() || '';
  // Match absolute paths, optionally followed by :line:col
  const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|]+|\/(?:home|Users|usr|tmp|var|etc|opt|mnt|app|workspace)[^\s"'<>|]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (x >= m.index && x < m.index + m[0].length) {
      // Extract path, line, column from "path:line:col"
      const parts = m[0].match(/^(.+?):(\d+)(?::(\d+))?$/);
      if (parts) return { path: parts[1], line: parseInt(parts[2]), column: parseInt(parts[3] || '0') };
      return { path: m[0], line: 0, column: 0 };
    }
  }
  return null;
}

function openInIde(filePath, ide, projectId, line, column) {
  const body = { path: filePath, ide };
  if (projectId) body.projectId = projectId;
  if (line) body.line = parseInt(line);
  if (column) body.column = parseInt(column);
  fetch('/api/open-in-ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(d => { if (d.opened) showToast(`Opened in ${ide}`); else showToast(d.error || 'Failed', 'error'); })
    .catch(() => showToast('Failed to open', 'error'));
}

// ─── WS Disconnect Indicator ───
export function showDisconnectIndicator(show) {
  document.querySelectorAll('.term-disconnect').forEach(el => el.remove());
  if (show) {
    document.querySelectorAll('.split-leaf').forEach(leaf => {
      const ind = document.createElement('div'); ind.className = 'term-disconnect'; ind.textContent = 'Disconnected';
      leaf.appendChild(ind);
    });
  }
}

// ─── File Drop ───
export function initFileDrop() {
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.innerHTML = '<div class="drop-msg">Drop file to preview</div>';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(99,102,241,.15);backdrop-filter:blur(2px);pointer-events:none;align-items:center;justify-content:center';
  overlay.querySelector('.drop-msg').style.cssText = 'background:var(--bg-2);border:2px dashed var(--accent);color:var(--text-0);padding:20px 40px;border-radius:12px;font-size:16px;font-weight:600';
  document.body.appendChild(overlay);
  document.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); overlay.style.display = 'flex'; overlay.querySelector('.drop-msg').textContent = app.activeTermId ? 'Drop image to paste path / file to preview' : 'Drop file to preview'; } });
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', e => { if (e.relatedTarget === null || e.relatedTarget === document.documentElement) overlay.style.display = 'none'; });
  document.addEventListener('drop', async e => {
    overlay.style.display = 'none';
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    const file = files[0];
    // Image drop → upload & paste path into active terminal
    if (file.type.startsWith('image/') && app.activeTermId && app.ws?.readyState === 1) {
      try {
        const resp = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        const { path } = await resp.json();
        if (path) {
          app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: path + ' ' }));
          const thumb = URL.createObjectURL(file);
          showToast(`<img src="${thumb}" style="max-width:120px;max-height:80px;border-radius:6px;vertical-align:middle;margin-right:6px" onload="URL.revokeObjectURL(this.src)">Image dropped`, 'success', 3000, true);
          return;
        }
      } catch { /* upload failed */ }
    }
    notify('openFilePreviewFromFile', file);
  });
}

// ─── Event Delegation Setup ───
export function setupTermEventDelegation() {
  const _termView = document.getElementById('terminal-view');
  if (_termView) {
    _termView.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'new-term': _core.openNewTermModal(); break;
        case 'mob-switch': mobileSwitchTerm(el.dataset.termid); break;
      }
    });
  }
  const _ntModal = document.getElementById('new-term-modal');
  if (_ntModal) {
    _ntModal.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'close-modal': _ntModal.close(); break;
        case 'create-terminal': _core.createTerminal(); break;
        case 'select-branch': _core.selectBranch(el); break;
      }
    });
    _ntModal.addEventListener('change', e => {
      if (e.target.dataset.action === 'load-branches') _core.loadBranchesForTerm();
    });
  }
  const _termPanels = document.getElementById('term-panels');
  _termPanels.addEventListener('mousedown', e => {
    const leaf = e.target.closest('.split-leaf');
    if (leaf) {
      const prevId = app.activeTermId;
      app.activeTermId = leaf.dataset.termId;
      updateTermHeaders();
      // Reload quick bar scripts when switching terminals
      if (prevId !== app.activeTermId && app.quickBar.visible) {
        const t = app.termMap.get(app.activeTermId);
        if (t) loadProjectScripts(t.projectId);
      }
    }
  });
  _termPanels.addEventListener('contextmenu', e => {
    const leaf = e.target.closest('.split-leaf');
    if (leaf) { e.preventDefault(); e.stopPropagation(); showTermCtxMenu(e, leaf.dataset.termId); }
  }, true);
  _termPanels.addEventListener('dblclick', e => {
    const name = e.target.closest('.th-name'); if (!name) return;
    const head = name.closest('.term-head'); if (!head) return;
    const tid = head.dataset.termId; if (tid) startRenameHeader(tid, head);
  });
  _termPanels.addEventListener('dragstart', e => {
    const head = e.target.closest('.term-head'); if (!head) return;
    const tid = head.dataset.termId; app.draggedTermId = tid;
    head.style.cursor = 'grabbing'; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tid);
    requestAnimationFrame(() => { document.querySelectorAll('.split-leaf').forEach(l => { if (l.dataset.termId !== tid) l.classList.add('drag-over'); }); });
  });
  _termPanels.addEventListener('dragend', e => {
    const head = e.target.closest('.term-head'); if (head) head.style.cursor = 'grab';
    app.draggedTermId = null;
    document.querySelectorAll('.split-leaf').forEach(l => l.classList.remove('drag-over'));
    document.querySelectorAll('.drop-zone').forEach(z => z.classList.remove('active'));
  });
  _termPanels.addEventListener('dragover', e => {
    const zone = e.target.closest('.drop-zone');
    if (zone) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; zone.classList.add('active'); }
  });
  _termPanels.addEventListener('dragleave', e => { const zone = e.target.closest('.drop-zone'); if (zone) zone.classList.remove('active'); });
  _termPanels.addEventListener('drop', e => {
    const zone = e.target.closest('.drop-zone'); if (!zone) return;
    e.preventDefault(); zone.classList.remove('active');
    const leaf = zone.closest('.split-leaf'); if (leaf) leaf.classList.remove('drag-over');
    const targetId = leaf?.dataset.termId;
    const pos = ['top', 'bottom', 'left', 'right'].find(p => zone.classList.contains(p));
    if (app.draggedTermId && targetId && app.draggedTermId !== targetId && pos) {
      _core.removeFromLayoutTree(app.draggedTermId);
      _core.splitAt(targetId, app.draggedTermId, pos);
      app.activeTermId = app.draggedTermId;
      renderLayout(); updateTermHeaders();
    }
  });
  // Selection toolbar event delegation
  const selToolbar = document.getElementById('term-selection-toolbar');
  if (selToolbar) {
    selToolbar.addEventListener('mousedown', e => e.stopPropagation()); // prevent xterm losing selection
    selToolbar.addEventListener('click', e => {
      const btn = e.target.closest('[data-sel-action]');
      if (btn) { e.stopPropagation(); handleSelectionAction(btn.dataset.selAction); }
    });
  }
  // Quick command bar: handle qb-remove click (prevent running the parent qb-run)
  const qbBar = document.getElementById('term-quick-bar');
  if (qbBar) {
    qbBar.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-action="qb-remove"]');
      if (removeBtn) { e.stopPropagation(); removeQuickCmd(removeBtn.dataset.idx); return; }
    });
  }
  // Hide selection toolbar on click anywhere in term panels
  _termPanels.addEventListener('mousedown', e => {
    if (!e.target.closest('.term-selection-toolbar')) hideSelectionToolbar();
  });
  // Resize observer
  const termPanelsObs = new ResizeObserver(() => _core.debouncedFit());
  termPanelsObs.observe(_termPanels);
  window.addEventListener('resize', () => _core.debouncedFit());
  // Initialize quick bar if it was visible
  const qbBarInit = document.getElementById('term-quick-bar');
  if (qbBarInit && app.quickBar.visible) {
    qbBarInit.style.display = 'flex';
    renderQuickBar();
  }
  // Re-render layout when crossing mobile/desktop threshold
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== wasMobile) { wasMobile = nowMobile; renderLayout(); }
  });
}

// ─── Mobile Quick-Action Keys ───
const KEY_MAP = {
  'escape': '\x1b',
  'tab': '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  'ctrl-l': '\x0c',
  'ctrl-r': '\x12',
  'ctrl-a': '\x01',
  'ctrl-e': '\x05',
  'up': '\x1b[A',
  'down': '\x1b[B',
};

export function setupMobileActions() {
  const bar = document.getElementById('mob-term-actions');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    e.preventDefault();
    const key = btn.dataset.key;
    const seq = KEY_MAP[key];
    if (!seq || !app.activeTermId || !app.ws || app.ws.readyState !== 1) return;
    app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: seq }));
    // Focus the terminal after key press
    const t = app.termMap.get(app.activeTermId);
    if (t) t.xterm.focus();
    // Visual feedback
    btn.classList.add('mob-btn-flash');
    setTimeout(() => btn.classList.remove('mob-btn-flash'), 150);
  });
}

// ─── Mobile Swipe to Switch Terminals ───
export function setupMobileSwipe() {
  const container = document.getElementById('term-panels');
  if (!container) return;
  let startX = 0, startY = 0, swiping = false;
  container.addEventListener('touchstart', e => {
    if (!isMobile() || app.termMap.size < 2) return;
    const touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY; swiping = true;
  }, { passive: true });
  container.addEventListener('touchend', e => {
    if (!swiping || !isMobile()) return;
    swiping = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    // Only horizontal swipe, minimum 60px, must be more horizontal than vertical
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const ids = [...app.termMap.keys()];
    const idx = ids.indexOf(app.activeTermId);
    if (idx < 0) return;
    if (dx < 0 && idx < ids.length - 1) mobileSwitchTerm(ids[idx + 1]); // swipe left → next
    if (dx > 0 && idx > 0) mobileSwitchTerm(ids[idx - 1]); // swipe right → prev
  }, { passive: true });
}

// ─── Command History Palette ───
const CMD_HISTORY_KEY = 'dl-cmd-history';
const MAX_CMD_HISTORY = 200;

function getCmdHistory() {
  try { return JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]'); } catch { return []; }
}

export function addCmdHistory(cmd) {
  if (!cmd || cmd.length < 2) return;
  // Skip single control chars, pure whitespace
  if (/^[\x00-\x1f]+$/.test(cmd)) return;
  const hist = getCmdHistory().filter(h => h !== cmd);
  hist.unshift(cmd);
  if (hist.length > MAX_CMD_HISTORY) hist.length = MAX_CMD_HISTORY;
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(hist)); } catch { /* storage unavailable */ }
}

let _cmdPaletteOpen = false;

export function toggleCmdPalette() {
  if (_cmdPaletteOpen) { closeCmdPalette(); return; }
  if (!app.activeTermId) return;
  _cmdPaletteOpen = true;
  let overlay = document.getElementById('hist-palette-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'hist-palette-overlay';
    overlay.className = 'hist-palette-overlay';
    overlay.innerHTML = `<div class="hist-palette">
      <input type="text" class="hist-palette-input" placeholder="Search command history..." autofocus />
      <div class="hist-palette-list"></div>
      <div class="hist-palette-hint">\u2191\u2193 Navigate \u00B7 Enter Send \u00B7 Esc Close</div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeCmdPalette(); });
  }
  overlay.style.display = ''; // Reset inline style from close
  overlay.classList.add('open');
  const input = overlay.querySelector('.hist-palette-input');
  const list = overlay.querySelector('.hist-palette-list');
  let selected = -1;
  const render = (filter) => {
    let hist = getCmdHistory();
    if (filter) {
      const lf = filter.toLowerCase();
      hist = hist.filter(h => h.toLowerCase().includes(lf));
    }
    list.innerHTML = hist.slice(0, 50).map((h, i) =>
      `<div class="hist-palette-item${i === selected ? ' selected' : ''}" data-idx="${i}" data-cmd="${escapeHtml(h)}">${escapeHtml(h)}</div>`
    ).join('') || '<div class="hist-palette-empty">No commands found</div>';
  };
  render('');
  input.value = '';
  input.focus();
  input.oninput = () => { selected = -1; render(input.value); };
  input.onkeydown = e => {
    const items = list.querySelectorAll('.hist-palette-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(input.value); items[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(input.value); items[selected]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = selected >= 0 ? items[selected]?.dataset.cmd : input.value;
      if (cmd && app.ws?.readyState === 1 && app.activeTermId) {
        app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
        const t = app.termMap.get(app.activeTermId);
        if (t) t.xterm.focus();
      }
      closeCmdPalette();
    }
    else if (e.key === 'Escape') { closeCmdPalette(); }
  };
  list.onclick = e => {
    const item = e.target.closest('.hist-palette-item');
    if (!item) return;
    const cmd = item.dataset.cmd;
    if (cmd && app.ws?.readyState === 1 && app.activeTermId) {
      app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
      const t = app.termMap.get(app.activeTermId);
      if (t) t.xterm.focus();
    }
    closeCmdPalette();
  };
}

export function closeCmdPalette() {
  _cmdPaletteOpen = false;
  const overlay = document.getElementById('hist-palette-overlay');
  if (overlay) { overlay.classList.remove('open'); overlay.style.display = 'none'; }
  // Refocus terminal
  const t = app.termMap.get(app.activeTermId);
  if (t) setTimeout(() => t.xterm.focus(), 50);
}

// ─── Terminal Presets ───
const PRESETS_KEY = 'dl-term-presets';

function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch { /* malformed JSON */ return []; }
}

function savePresets(presets) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch { /* storage unavailable */ }
}

export function addPreset(name, command, projectId) {
  const presets = getPresets();
  presets.push({ name, command, projectId: projectId || '', id: Date.now().toString(36) });
  savePresets(presets);
  showToast(`Preset "${name}" saved`);
}

export function removePreset(presetId) {
  const presets = getPresets().filter(p => p.id !== presetId);
  savePresets(presets);
}

export function runPreset(presetId) {
  const preset = getPresets().find(p => p.id === presetId);
  if (!preset) return;
  const projectId = preset.projectId || app.projectList[0]?.id;
  if (!projectId) { showToast('No project available', 'error'); return; }
  _core.openTermWith(projectId, preset.command);
}

export function showPresetsDialog() {
  let dlg = document.getElementById('presets-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'presets-dialog';
    dlg.className = 'presets-dialog';
    // Append inside themed container for proper CSS variable inheritance
    (document.getElementById('app') || document.body).appendChild(dlg);
  }
  const presets = getPresets();
  // Resolve CSS vars for top-layer dialog (doesn't inherit from DOM)
  const cs = getComputedStyle(document.documentElement);
  const bg2 = cs.getPropertyValue('--bg-2').trim();
  const txt1 = cs.getPropertyValue('--text-1').trim();
  const txt3 = cs.getPropertyValue('--text-3').trim();
  const bdr = cs.getPropertyValue('--border').trim();
  const bg0 = cs.getPropertyValue('--bg-0').trim();
  const bg1 = cs.getPropertyValue('--bg-1').trim();
  dlg.style.cssText = `background:${bg2};color:${txt1};border:1px solid ${bdr};border-radius:10px;padding:0;width:480px;max-width:90vw;box-shadow:0 12px 32px rgba(0,0,0,.4)`;
  dlg.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid ${bdr}">
      <h3 style="font-size:1.05rem;font-weight:600;margin:0">Terminal Presets</h3>
      <button data-action="close-dialog" style="background:none;border:none;color:${txt3};cursor:pointer;font-size:1.1rem;padding:4px 8px;border-radius:4px">&times;</button>
    </div>
    <div style="max-height:300px;overflow-y:auto;padding:8px 0">${presets.length ? presets.map(p => `
      <div class="preset-item" style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid ${bg1};cursor:pointer">
        <div style="flex:1;min-width:0" data-action="run-preset" data-pid="${p.id}">
          <div style="font-weight:600;font-size:.84rem;color:${txt1}">${escapeHtml(p.name)}</div>
          <div style="font-family:var(--mono);font-size:.76rem;color:${txt3};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.command)}</div>
        </div>
        <button data-action="delete-preset" data-pid="${p.id}" title="Delete" style="background:none;border:none;color:${txt3};cursor:pointer;font-size:1rem;padding:4px 8px">&times;</button>
      </div>
    `).join('') : `<div style="padding:24px 16px;text-align:center;color:${txt3};font-size:.82rem">No presets yet. Save one from the form below.</div>`}
    </div>
    <div style="display:flex;gap:6px;padding:12px 16px;border-top:1px solid ${bdr};flex-wrap:wrap">
      <input type="text" id="preset-name" placeholder="Name (e.g., Dev Server)" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem;outline:none" />
      <input type="text" id="preset-cmd" placeholder="Command (e.g., npm run dev)" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem;font-family:var(--mono);outline:none" />
      <select id="preset-project" style="flex:1;min-width:100px;padding:6px 10px;background:${bg0};color:${txt1};border:1px solid ${bdr};border-radius:4px;font-size:.8rem"><option value="">Any Project</option>${app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn btn-sm" data-action="save-preset">Save</button>
    </div>`;
  if (!dlg.dataset.delegated) {
    dlg.dataset.delegated = '1';
    dlg.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'close-dialog': dlg.close(); break;
        case 'run-preset': runPreset(el.dataset.pid); dlg.close(); break;
        case 'delete-preset': removePreset(el.dataset.pid); showPresetsDialog(); break;
        case 'save-preset': {
          const n = document.getElementById('preset-name').value.trim();
          const c = document.getElementById('preset-cmd').value.trim();
          if (!n || !c) { showToast('Name and command required', 'error'); return; }
          addPreset(n, c, document.getElementById('preset-project').value);
          showPresetsDialog();
          break;
        }
      }
    });
  }
  dlg.showModal();
}

// ─── Broadcast Input Mode ───
let _broadcastMode = false;
let _broadcastTargets = new Set();

export function toggleBroadcastMode() {
  _broadcastMode = !_broadcastMode;
  if (_broadcastMode) {
    // Select all terminals by default
    _broadcastTargets = new Set(app.termMap.keys());
    showToast(`Broadcast mode ON \u2014 typing to ${_broadcastTargets.size} terminals`, 'info');
  } else {
    _broadcastTargets.clear();
    showToast('Broadcast mode OFF');
  }
  updateBroadcastUI();
}

export function toggleBroadcastTarget(termId) {
  if (_broadcastTargets.has(termId)) _broadcastTargets.delete(termId);
  else _broadcastTargets.add(termId);
  updateBroadcastUI();
}

function updateBroadcastUI() {
  // Update header badges
  document.querySelectorAll('.split-leaf').forEach(leaf => {
    const tid = leaf.dataset.termId;
    leaf.classList.toggle('broadcast-target', _broadcastMode && _broadcastTargets.has(tid));
  });
  // Update broadcast indicator
  const ind = document.getElementById('broadcast-indicator');
  if (ind) {
    ind.style.display = _broadcastMode ? 'flex' : 'none';
    ind.querySelector('.bc-count').textContent = _broadcastTargets.size;
  }
}

export function broadcastInput(fromTermId, data) {
  if (!_broadcastMode || !app.ws || app.ws.readyState !== 1) return false;
  if (_broadcastTargets.size <= 1) return false;
  for (const tid of _broadcastTargets) {
    if (tid !== fromTermId) {
      app.ws.send(JSON.stringify({ type: 'input', termId: tid, data }));
    }
  }
  return true;
}

export function isBroadcastMode() { return _broadcastMode; }

// ═══════════════════════════════════════════
// Selection Floating Toolbar
// ═══════════════════════════════════════════

let _selToolbarTimer = null;

export function showSelectionToolbar(termId) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const sel = t.xterm.getSelection();
  if (!sel || !sel.trim()) { hideSelectionToolbar(); return; }

  const toolbar = document.getElementById('term-selection-toolbar');
  if (!toolbar) return;
  const termView = document.getElementById('terminal-view');
  if (!termView) return;

  // Reset transform before measuring
  toolbar.style.transform = '';
  toolbar.style.display = 'flex';

  const screen = t.element.querySelector('.xterm-screen');
  const viewRect = termView.getBoundingClientRect();
  const tbRect = toolbar.getBoundingClientRect();

  let left, top;

  // Try xterm's selection position API
  const selPos = t.xterm.getSelectionPosition?.();
  if (selPos && screen) {
    const screenRect = screen.getBoundingClientRect();
    const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
    const cellH = t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
    const startY = screenRect.top + (selPos.start.y - t.xterm.buffer.active.viewportY) * cellH;
    const startX = screenRect.left + selPos.start.x * cellW;
    const endX = screenRect.left + selPos.end.x * cellW;
    const centerX = (startX + endX) / 2;
    left = centerX - tbRect.width / 2 - viewRect.left;
    top = startY - tbRect.height - 8 - viewRect.top;
    if (top < 4) top = startY + cellH + 4 - viewRect.top;
  } else if (screen) {
    // Fallback: position near the mouse / center of screen element
    const screenRect = screen.getBoundingClientRect();
    left = (screenRect.left + screenRect.width / 2) - tbRect.width / 2 - viewRect.left;
    top = screenRect.top - viewRect.top + 12;
  } else {
    left = (viewRect.width - tbRect.width) / 2;
    top = 12;
  }

  // Clamp inside view
  left = Math.max(4, Math.min(left, viewRect.width - tbRect.width - 4));
  top = Math.max(4, top);
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';

  // Show/hide "Open URL" button based on URL in selection
  const urlBtn = toolbar.querySelector('[data-sel-action="open-url"]');
  const urlMatch = sel.match(/https?:\/\/\S+/);
  if (urlBtn) urlBtn.style.display = urlMatch ? '' : 'none';

  // Store current selection context
  toolbar.dataset.termId = termId;
  toolbar.dataset.selText = sel;
  if (urlMatch) toolbar.dataset.selUrl = urlMatch[0];
  else delete toolbar.dataset.selUrl;
}

export function hideSelectionToolbar() {
  const toolbar = document.getElementById('term-selection-toolbar');
  if (toolbar) toolbar.style.display = 'none';
}

function handleSelectionAction(action) {
  const toolbar = document.getElementById('term-selection-toolbar');
  if (!toolbar) return;
  const text = toolbar.dataset.selText || '';
  const termId = toolbar.dataset.termId;
  const t = app.termMap.get(termId);

  switch (action) {
    case 'copy':
      navigator.clipboard.writeText(text).then(() => { showToast('Copied'); if (t) t.xterm.clearSelection(); });
      break;
    case 'ask-ai': {
      // Inject into agent panel input
      const agentInput = document.getElementById('agent-input');
      if (agentInput) {
        agentInput.value = text;
        agentInput.focus();
        // Open agent panel if closed
        const panel = document.getElementById('agent-panel');
        if (panel && !panel.classList.contains('open')) {
          notify('toggleAgentPanel');
        }
      }
      break;
    }
    case 'search':
      // Open terminal search with selected text
      if (termId) app.activeTermId = termId;
      _core.toggleTermSearch();
      setTimeout(() => {
        const input = document.querySelector('#term-search-bar input');
        if (input) { input.value = text; _core.doTermSearch('next'); }
      }, 50);
      break;
    case 'run':
      if (text.trim() && app.ws?.readyState === 1 && termId) {
        app.ws.send(JSON.stringify({ type: 'input', termId, data: text.trim() + '\r' }));
        showToast('Command sent');
      }
      break;
    case 'open-url': {
      const url = toolbar.dataset.selUrl;
      if (url) {
        fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
          .then(() => showToast(`Opening ${url}`)).catch(() => window.open(url, '_blank'));
      }
      break;
    }
  }
  hideSelectionToolbar();
}

// ═══════════════════════════════════════════
// Quick Command Bar
// ═══════════════════════════════════════════

const BUILT_IN_CMDS = [
  { label: 'git status', cmd: 'git status', type: 'builtin' },
  { label: 'git diff --stat', cmd: 'git diff --stat', type: 'builtin' },
  { label: 'clear', cmd: 'clear', type: 'builtin' },
];

export function toggleQuickBar() {
  app.quickBar.visible = !app.quickBar.visible;
  localStorage.setItem('dl-quick-bar-visible', JSON.stringify(app.quickBar.visible));
  const bar = document.getElementById('term-quick-bar');
  if (bar) bar.style.display = app.quickBar.visible ? 'flex' : 'none';
  if (app.quickBar.visible) renderQuickBar();
  // Re-fit terminals since space changed
  setTimeout(() => _core.fitAllTerminals(), 50);
}

export function renderQuickBar() {
  const container = document.getElementById('qb-cmds');
  if (!container) return;

  let html = '';
  // Built-in commands
  for (const c of BUILT_IN_CMDS) {
    html += `<button class="qb-chip" data-action="qb-run" data-cmd="${escapeHtml(c.cmd)}" title="${escapeHtml(c.cmd)}">${escapeHtml(c.label)}</button>`;
  }

  // npm scripts (cached)
  if (app._quickBarScripts) {
    for (const [name, script] of Object.entries(app._quickBarScripts)) {
      html += `<button class="qb-chip qb-npm" data-action="qb-run" data-cmd="npm run ${escapeHtml(name)}" title="${escapeHtml(script)}">npm run ${escapeHtml(name)}</button>`;
    }
  }

  // Custom commands
  for (const c of app.quickBar.customCmds) {
    html += `<button class="qb-chip" data-action="qb-run" data-cmd="${escapeHtml(c.cmd)}" title="${escapeHtml(c.cmd)}">${escapeHtml(c.label)}<span class="qb-x" data-action="qb-remove" data-idx="${c.id}">&times;</span></button>`;
  }

  container.innerHTML = html;
}

export async function loadProjectScripts(projectId) {
  if (!projectId) { app._quickBarScripts = null; renderQuickBar(); return; }
  const project = app.projectList.find(p => p.id === projectId);
  if (!project?.path) { app._quickBarScripts = null; renderQuickBar(); return; }
  try {
    const res = await fetch(`/api/scripts-by-path?path=${encodeURIComponent(project.path)}`);
    const data = await res.json();
    app._quickBarScripts = data.scripts || {};
  } catch {
    app._quickBarScripts = null;
  }
  renderQuickBar();
}

function runQuickCmd(cmd) {
  if (!cmd || !app.ws || app.ws.readyState !== 1 || !app.activeTermId) {
    showToast('No active terminal', 'error');
    return;
  }
  app.ws.send(JSON.stringify({ type: 'input', termId: app.activeTermId, data: cmd + '\r' }));
  const t = app.termMap.get(app.activeTermId);
  if (t) t.xterm.focus();
}

function addQuickCmd() {
  const label = prompt('Command label (e.g., "build"):');
  if (!label) return;
  const cmd = prompt('Command to run:', label);
  if (!cmd) return;
  const entry = { id: Date.now().toString(36), label, cmd };
  app.quickBar.customCmds.push(entry);
  localStorage.setItem('dl-quick-cmds', JSON.stringify(app.quickBar.customCmds));
  renderQuickBar();
  showToast(`Quick command "${label}" added`);
}

function removeQuickCmd(id) {
  app.quickBar.customCmds = app.quickBar.customCmds.filter(c => c.id !== id);
  localStorage.setItem('dl-quick-cmds', JSON.stringify(app.quickBar.customCmds));
  renderQuickBar();
}

// ═══════════════════════════════════════════
// Scroll-to-Bottom + Output Annotations
// ═══════════════════════════════════════════

// Track new lines since user scrolled up
const _scrollState = new Map(); // termId -> { scrolledUp, newLines }

function getScrollState(termId) {
  if (!_scrollState.has(termId)) _scrollState.set(termId, { scrolledUp: false, newLines: 0 });
  return _scrollState.get(termId);
}

export function updateScrollIndicator(termId) {
  const t = app.termMap.get(termId);
  if (!t) return;
  const buf = t.xterm.buffer.active;
  // viewportY is the scroll offset from top; baseY is max scrollable
  const isAtBottom = (buf.baseY - buf.viewportY) <= 1;
  const ss = getScrollState(termId);

  if (isAtBottom) {
    ss.scrolledUp = false;
    ss.newLines = 0;
    if (termId === app.activeTermId) hideScrollIndicator();
  } else {
    ss.scrolledUp = true;
  }
}

function showScrollIndicator(count) {
  const btn = document.getElementById('term-scroll-bottom');
  if (!btn) return;
  btn.style.display = 'flex';
  const countEl = document.getElementById('tsb-count');
  if (countEl) countEl.textContent = count > 99 ? '99+' : count;
}

function hideScrollIndicator() {
  const btn = document.getElementById('term-scroll-bottom');
  if (btn) btn.style.display = 'none';
}

function scrollToBottom() {
  if (!app.activeTermId) return;
  const t = app.termMap.get(app.activeTermId);
  if (!t) return;
  t.xterm.scrollToBottom();
  const ss = getScrollState(app.activeTermId);
  ss.scrolledUp = false;
  ss.newLines = 0;
  hideScrollIndicator();
  t.xterm.focus();
}

// Output annotation patterns
const ERROR_RE = /\b(error|Error|ERROR|FAIL|failed|FAILED|ERR!|ERR:|panic|PANIC|exception|Exception|FATAL|fatal|TypeError|ReferenceError|SyntaxError|Cannot find|not found|No such file|ENOENT|EACCES|ECONNREFUSED|segfault|Segmentation fault)\b/;
const SUCCESS_RE = /\b(success|Success|SUCCESS|passed|PASSED|PASS|\u2713|done|Done|DONE|completed|Completed|\u2714|ok\b|OK\b)\b/;

export function addOutputDecoration(xterm, lineNum, type) {
  try {
    // registerMarker(0) = current cursor line, negative = lines above cursor
    const cursorAbsLine = xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
    const offset = lineNum - cursorAbsLine;
    const marker = xterm.registerMarker(offset);
    if (!marker || marker.line < 0) return;
    const deco = xterm.registerDecoration({
      marker,
      width: 1,
      overviewRulerOptions: {
        color: type === 'error' ? '#f87171' : '#34d399',
        position: 'full',
      },
    });
    if (deco) {
      deco.onRender(el => {
        el.className = type === 'error' ? 'term-gutter-error' : 'term-gutter-success';
        el.style.width = '3px';
        el.style.height = '100%';
      });
    }
  } catch { /* addon not available */ }
}

// Enhanced bufferWrite with output scanning
export function scanOutput(t, data, termId) {
  // Skip ANSI control sequences for pattern matching
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    const curLine = t.xterm.buffer.active.baseY + t.xterm.buffer.active.cursorY;

    if (ERROR_RE.test(line)) {
      addOutputDecoration(t.xterm, curLine, 'error');
    } else if (SUCCESS_RE.test(line)) {
      addOutputDecoration(t.xterm, curLine, 'success');
    }
  }

  // Track scroll state for new output
  const ss = getScrollState(termId);
  if (ss.scrolledUp) {
    const lineCount = (clean.match(/\n/g) || []).length + 1;
    ss.newLines += lineCount;
    if (termId === app.activeTermId) showScrollIndicator(ss.newLines);
  }
}

// ─── Action Registration ───
registerClickActions({
  'toggle-broadcast': toggleBroadcastMode,
  'new-term': () => _core.openNewTermModal(),
  'ts-toggle-case': (el) => { el.classList.toggle('active'); _core.doTermSearch('next'); },
  'ts-toggle-regex': (el) => { el.classList.toggle('active'); _core.doTermSearch('next'); },
  'term-search-prev': () => _core.doTermSearch('prev'),
  'term-search-next': () => _core.doTermSearch('next'),
  'close-term-search': () => _core.closeTermSearch(),
  'font-size-down': () => _core.changeTermFontSize(-1),
  'font-size-up': () => _core.changeTermFontSize(1),
  'export-terminal': () => _core.exportTerminal(),
  'term-scroll-bottom': scrollToBottom,
  'qb-toggle': toggleQuickBar,
  'qb-add-cmd': addQuickCmd,
  'qb-run': (el) => runQuickCmd(el.dataset.cmd),
  'qb-remove': (el, e) => { e?.stopPropagation(); removeQuickCmd(el.dataset.idx); },
});
registerInputActions({
  'term-search-input': () => _core.doTermSearch('next'),
});
