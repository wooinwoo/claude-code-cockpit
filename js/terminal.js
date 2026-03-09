// ─── Terminal Core: WebSocket, xterm, layout tree, search, font, export, theme ───
import { app, notify } from './state.js';
import { esc, showToast, escapeHtml } from './utils.js';

// ─── Import and re-export from terminal-ui ───
import {
  initTermUI,
  renderLayout, isMobile, mobileSwitchTerm, mobileCloseTerm,
  debouncedUpdateTermHeaders, updateTermHeaders, startRenameHeader,
  showTermCtxMenu, showDisconnectIndicator,
  initFileDrop, setupTermEventDelegation,
  setupMobileActions, setupMobileSwipe,
  toggleCmdPalette, closeCmdPalette,
  addPreset, removePreset, runPreset, showPresetsDialog,
  toggleBroadcastMode, toggleBroadcastTarget, broadcastInput, isBroadcastMode,
  showSelectionToolbar, hideSelectionToolbar,
  toggleQuickBar, renderQuickBar, loadProjectScripts,
  updateScrollIndicator, addOutputDecoration, scanOutput,
  addCmdHistory,
} from './terminal-ui.js';

// Re-export everything from terminal-ui so external consumers don't break
export {
  renderLayout, isMobile, mobileSwitchTerm, mobileCloseTerm,
  debouncedUpdateTermHeaders, updateTermHeaders, startRenameHeader,
  showTermCtxMenu, showDisconnectIndicator,
  initFileDrop, setupTermEventDelegation,
  setupMobileActions, setupMobileSwipe,
  toggleCmdPalette, closeCmdPalette,
  addPreset, removePreset, runPreset, showPresetsDialog,
  toggleBroadcastMode, toggleBroadcastTarget, broadcastInput, isBroadcastMode,
  showSelectionToolbar, hideSelectionToolbar,
  toggleQuickBar, renderQuickBar, loadProjectScripts,
  updateScrollIndicator, addOutputDecoration,
};

let _splitTarget = null;

// ─── Write Buffer ───
function bufferWrite(t, data, id) {
  if (!id) { t.xterm.write(data); return; }
  let buf = app.writeBuffers.get(id);
  if (!buf) { buf = { data: '', timer: null }; app.writeBuffers.set(id, buf); }
  buf.data += data;
  if (!buf.timer) {
    buf.timer = requestAnimationFrame(() => {
      const chunk = buf.data; buf.data = ''; buf.timer = null;
      t.xterm.write(chunk);
      scanOutput(t, chunk, id);
    });
  }
}

// ─── Layout Persistence ───
export function saveLayout() {
  try {
    localStorage.setItem('dl-tree', JSON.stringify(app.layoutRoot));
    const labels = {};
    for (const [id, t] of app.termMap) labels[id] = t.label;
    localStorage.setItem('dl-labels', JSON.stringify(labels));
    if (app.activeTermId) localStorage.setItem('dl-active', app.activeTermId);
    const view = document.querySelector('.view.active')?.id?.replace('-view', '');
    if (view) localStorage.setItem('dl-view', view);
  } catch { /* storage unavailable */ }
}

export function restoreSavedLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('dl-tree'));
    if (!saved) return false;
    function validate(node) {
      if (!node) return false;
      if (node.type === 'leaf') return app.termMap.has(node.termId);
      if (node.type === 'split') return node.children && validate(node.children[0]) && validate(node.children[1]);
      return false;
    }
    if (!validate(saved)) return false;
    app.layoutRoot = saved;
    try {
      const labels = JSON.parse(localStorage.getItem('dl-labels'));
      if (labels) for (const [id, label] of Object.entries(labels)) { const t = app.termMap.get(id); if (t) t.label = label; }
    } catch { /* malformed JSON */ }
    const activeId = localStorage.getItem('dl-active');
    if (activeId && app.termMap.has(activeId)) app.activeTermId = activeId;
    return true;
  } catch { /* malformed JSON */ return false; }
}

function remapLayoutIds(idMap) {
  try {
    const tree = JSON.parse(localStorage.getItem('dl-tree'));
    if (tree) {
      (function remap(node) {
        if (!node) return;
        if (node.type === 'leaf' && idMap[node.termId]) node.termId = idMap[node.termId];
        if (node.type === 'split') { remap(node.children[0]); remap(node.children[1]); }
      })(tree);
      localStorage.setItem('dl-tree', JSON.stringify(tree));
    }
    const labels = JSON.parse(localStorage.getItem('dl-labels'));
    if (labels) {
      const newLabels = {};
      for (const [oldId, label] of Object.entries(labels)) newLabels[idMap[oldId] || oldId] = label;
      localStorage.setItem('dl-labels', JSON.stringify(newLabels));
    }
    const active = localStorage.getItem('dl-active');
    if (active && idMap[active]) localStorage.setItem('dl-active', idMap[active]);
  } catch { /* storage unavailable */ }
}

// ─── WebSocket ───
export function connectWS() {
  if (app._wsReconnTimer) { clearTimeout(app._wsReconnTimer); app._wsReconnTimer = null; }
  let ws;
  try {
    ws = new WebSocket(`ws://${location.host}`);
    app.ws = ws;
  } catch (e) {
    console.error('[WS] constructor error', e);
    return;
  }
  ws.onopen = () => {
    app._wsBackoff = 1000;
    app._wsConnectedAt = Date.now();
    showDisconnectIndicator(false);
    // Refresh terminal headers every 30s for session timer
    if (app._termTimerInterval) clearInterval(app._termTimerInterval);
    app._termTimerInterval = setInterval(() => { if (app.termMap.size) updateTermHeaders(); }, 30000);
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    try {
    switch (msg.type) {
      case 'terminals': {
        if (msg.idMap) remapLayoutIds(msg.idMap);
        let added = false;
        msg.active.forEach(t => {
          if (!app.termMap.has(t.termId)) {
            addTerminal(t.termId, t.projectId, false);
            added = true;
            if (t.buffer) { const tm = app.termMap.get(t.termId); if (tm) tm.pendingBuffer = t.buffer; }
          }
        });
        if (added) {
          if (!restoreSavedLayout()) {
            for (const [id] of app.termMap) { if (!findLeaf(app.layoutRoot, id)) addToLayoutTree(id); }
          }
          renderLayout();
          updateTermHeaders();
          if (msg.idMap) showToast(`Restored ${msg.active.length} terminal(s)`, 'success');
        }
        break;
      }
      case 'created':
        if (!app.termMap.has(msg.termId)) addTerminal(msg.termId, msg.projectId, true);
        break;
      case 'output': {
        const t = app.termMap.get(msg.termId);
        if (t) bufferWrite(t, msg.data, msg.termId);
        break;
      }
      case 'exit': {
        const t = app.termMap.get(msg.termId);
        if (t) {
          t.xterm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
          showToast(`Terminal "${t.label}" \u2014 process exited`, 'warning');
        }
        break;
      }
    }
    } catch (err) { console.error('[WS] message handler error', err); }
  };
  ws.onerror = err => { console.error('[WS] error', err); };
  ws.onclose = (_ev) => {
    // Skip cleanup if a newer WS connection has already taken over
    if (app.ws !== ws) return;
    showDisconnectIndicator(true);
    // Clear terminal header refresh timer
    if (app._termTimerInterval) { clearInterval(app._termTimerInterval); app._termTimerInterval = null; }
    // Flush pending writeBuffers to prevent stale RAF timers
    for (const [_id, wb] of app.writeBuffers) { if (wb.timer) cancelAnimationFrame(wb.timer); }
    app.writeBuffers.clear();
    if (app._wsConnectedAt && Date.now() - app._wsConnectedAt > 30000) app._wsBackoff = 1000;
    app._wsBackoff = Math.min(app._wsBackoff * 1.5, 10000);
    const delay = Math.round(app._wsBackoff + Math.random() * 500);
    // Countdown on disconnect indicators
    let remain = Math.ceil(delay / 1000);
    const updateCountdown = () => { document.querySelectorAll('.term-disconnect').forEach(el => el.textContent = `Disconnected \u2014 reconnecting in ${remain}s`); };
    updateCountdown();
    const cdTimer = setInterval(() => { remain--; if (remain <= 0) { clearInterval(cdTimer); } else updateCountdown(); }, 1000);
    app._wsReconnTimer = setTimeout(() => { clearInterval(cdTimer); connectWS(); }, delay);
  };
}

// ─── Add Terminal ───
export function addTerminal(termId, projectId, addToView) {
  if (typeof Terminal === 'undefined') { showToast('xterm.js not loaded', 'error'); return; }
  const project = app.projectList.find(p => p.id === projectId);
  const color = project?.color || '#666';
  const name = project?.name || projectId;
  const darkTheme = { background: '#08090d', foreground: '#e8e9f0', cursor: '#818cf8', selectionBackground: 'rgba(129,140,248,.3)', black: '#08090d', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e8e9f0' };
  const lightTheme = { background: '#ffffff', foreground: '#1e293b', cursor: '#6366f1', selectionBackground: 'rgba(99,102,241,.2)', black: '#1e293b', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04', blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#f8fafc' };
  const xterm = new Terminal({
    theme: app.currentTheme === 'light' ? lightTheme : darkTheme,
    fontFamily: "'Cascadia Code','JetBrains Mono',monospace",
    fontSize: app.termFontSize,
    cursorBlink: true, allowProposedApi: true, scrollback: getScrollback(), fastScrollModifier: 'alt', fastScrollSensitivity: 5,
  });
  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon.WebLinksAddon((ev, url) => {
    fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).catch(() => window.open(url, '_blank'));
  }));
  const searchAddon = new SearchAddon.SearchAddon();
  xterm.loadAddon(searchAddon);
  xterm.registerLinkProvider({
    provideLinks(lineNum, cb) {
      const line = xterm.buffer.active.getLine(lineNum - 1)?.translateToString() || '';
      const links = [];
      // Absolute paths
      const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|Users|usr|tmp|var|etc|opt|mnt|app|workspace)[^\s"'<>|:]+)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const text = m[0]; const x1 = m.index + 1;
        links.push({ range: { start: { x: x1, y: lineNum }, end: { x: x1 + text.length, y: lineNum } }, text, activate(ev, t) { if (ev.button === 0) window.openFilePreview?.(t); } });
      }
      // Relative file:line patterns (e.g., src/foo.ts:42, ./bar.js:10:5)
      const relRe = /(?:\.\/)?([a-zA-Z0-9_\-./\\]+\.\w{1,10}):(\d+)(?::(\d+))?/g;
      while ((m = relRe.exec(line)) !== null) {
        const text = m[0]; const x1 = m.index + 1;
        const filePart = m[1]; const linePart = m[2]; const colPart = m[3] || '1';
        links.push({ range: { start: { x: x1, y: lineNum }, end: { x: x1 + text.length, y: lineNum } }, text,
          activate(ev) {
            if (ev.button === 0) {
              // Open in IDE with line number
              fetch('/api/open-in-ide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePart, line: parseInt(linePart), column: parseInt(colPart), ide: 'code', projectId })
              }).then(r => r.json()).then(d => { if (d.opened) showToast(`Opened ${filePart}:${linePart}`); })
                .catch(() => {});
            }
          }
        });
      }
      cb(links.length ? links : undefined);
    },
  });
  xterm.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown') return true;
    // Let F5 / Ctrl+R pass through to browser for page reload
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'F5' || (mod && ev.key === 'r' && !ev.shiftKey && !ev.altKey)) return false;
    // Let Ctrl+1~9 pass through for tab switching
    if (mod && ev.key >= '1' && ev.key <= '9') return false;
    if ((ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') || (ev.ctrlKey && !ev.shiftKey && ev.key === 'c' && xterm.hasSelection())) {
      const text = xterm.getSelection();
      if (text) { navigator.clipboard.writeText(text).then(() => xterm.clearSelection()).catch(() => {}); }
      return false;
    }
    // Ctrl+J — toggle quick bar (prevent terminal newline)
    if (ev.ctrlKey && !ev.shiftKey && (ev.key === 'j' || ev.key === 'J') && !ev.altKey) {
      ev.preventDefault();
      toggleQuickBar();
      return false;
    }
    if (ev.ctrlKey && (ev.key === 'v' || ev.key === 'V')) {
      ev.preventDefault();
      (async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imgType = item.types.find(t => t.startsWith('image/'));
            if (imgType) {
              const blob = await item.getType(imgType);
              const resp = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': imgType }, body: blob });
              const { path } = await resp.json();
              if (path && app.ws?.readyState === 1) {
                app.ws.send(JSON.stringify({ type: 'input', termId, data: path + ' ' }));
                const thumb = URL.createObjectURL(blob);
                showToast(`<img src="${thumb}" style="max-width:120px;max-height:80px;border-radius:6px;vertical-align:middle;margin-right:6px" onload="URL.revokeObjectURL(this.src)">Image pasted`, 'success', 3000, true);
              }
              return;
            }
          }
        } catch { /* clipboard.read() not supported — fall through to text */ }
        try {
          const t = await navigator.clipboard.readText();
          if (!t || app.ws?.readyState !== 1) return;
          const data = t.includes('\n') ? `\x1b[200~${t}\x1b[201~` : t;
          app.ws.send(JSON.stringify({ type: 'input', termId, data }));
        } catch { /* clipboard denied */ }
      })();
      return false;
    }
    return true;
  });
  // Selection toolbar handler
  xterm.onSelectionChange(() => {
    if (app._selToolbarTimer) { clearTimeout(app._selToolbarTimer); app._selToolbarTimer = null; }
    const sel = xterm.getSelection();
    if (sel && sel.trim()) {
      app._selToolbarTimer = setTimeout(() => showSelectionToolbar(termId), 200);
    } else {
      hideSelectionToolbar();
    }
  });
  // Scroll tracking for scroll-to-bottom indicator
  xterm.onScroll(() => {
    updateScrollIndicator(termId);
  });

  const element = document.createElement('div');
  element.className = 'xterm-wrap';
  let _cmdBuf = '';
  xterm.onData(data => {
    if (app.ws?.readyState === 1) {
      app.ws.send(JSON.stringify({ type: 'input', termId, data }));
      // Broadcast to other terminals if broadcast mode is on
      broadcastInput(termId, data);
    }
    // Capture commands for history palette
    if (data === '\r' || data === '\n') {
      const cmd = _cmdBuf.trim();
      if (cmd) addCmdHistory(cmd);
      _cmdBuf = '';
    } else if (data === '\x7f' || data === '\b') {
      _cmdBuf = _cmdBuf.slice(0, -1);
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      _cmdBuf += data;
    } else if (data.length > 1 && !data.startsWith('\x1b')) {
      _cmdBuf += data;
    }
  });
  app.termMap.set(termId, { xterm, fitAddon, searchAddon, projectId, element, label: name, color, opened: false, pendingBuffer: null, createdAt: Date.now() });
  if (addToView) {
    if (_splitTarget) {
      const st = _splitTarget; _splitTarget = null;
      splitAt(st.termId, termId, st.pos);
    } else { addToLayoutTree(termId); }
    app.activeTermId = termId;
    updateTermHeaders();
    renderLayout();
  }
}

// ─── Layout Tree ───
export function addToLayoutTree(termId) {
  if (!app.layoutRoot) { app.layoutRoot = { type: 'leaf', termId }; }
  else if (app.activeTermId && findLeaf(app.layoutRoot, app.activeTermId)) { splitAt(app.activeTermId, termId, 'right'); }
  else { app.layoutRoot = { type: 'split', dir: 'h', ratio: 0.5, children: [app.layoutRoot, { type: 'leaf', termId }] }; }
  app.activeTermId = termId;
}

export function findLeaf(node, termId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.termId === termId ? node : null;
  return findLeaf(node.children[0], termId) || findLeaf(node.children[1], termId);
}

export function splitAt(targetTermId, newTermId, position) {
  const dir = position === 'left' || position === 'right' ? 'h' : 'v';
  const newFirst = position === 'left' || position === 'top';
  function replace(node) {
    if (node.type === 'leaf' && node.termId === targetTermId)
      return { type: 'split', dir, ratio: 0.5, children: newFirst ? [{ type: 'leaf', termId: newTermId }, { type: 'leaf', termId: targetTermId }] : [{ type: 'leaf', termId: targetTermId }, { type: 'leaf', termId: newTermId }] };
    if (node.type === 'split') return { ...node, children: [replace(node.children[0]), replace(node.children[1])] };
    return node;
  }
  app.layoutRoot = replace(app.layoutRoot);
}

export function removeFromLayoutTree(termId) {
  if (!app.layoutRoot) return;
  if (app.layoutRoot.type === 'leaf') { if (app.layoutRoot.termId === termId) app.layoutRoot = null; return; }
  function collapse(node) {
    if (node.type !== 'split') return node;
    for (let i = 0; i < 2; i++) { if (node.children[i].type === 'leaf' && node.children[i].termId === termId) return node.children[1 - i]; }
    return { ...node, children: [collapse(node.children[0]), collapse(node.children[1])] };
  }
  app.layoutRoot = collapse(app.layoutRoot);
}

// ─── Close/Fit ───
export function closeTerminal(id) {
  const t = app.termMap.get(id);
  if (t) {
    if (app.ws?.readyState === 1) app.ws.send(JSON.stringify({ type: 'kill', termId: id }));
    t.xterm.dispose(); t.element.remove(); app.termMap.delete(id);
  }
  const wb = app.writeBuffers.get(id);
  if (wb) { if (wb.timer) cancelAnimationFrame(wb.timer); app.writeBuffers.delete(id); }
  app._headCache.delete(id);
  removeFromLayoutTree(id);
  if (app.activeTermId === id) { const first = app.termMap.keys().next().value; app.activeTermId = first || null; }
  renderLayout(); updateTermHeaders();
}

export function fitAllTerminals() {
  for (const [termId, t] of app.termMap) {
    if (t.opened && t.element.parentNode) {
      try { t.fitAddon.fit(); } catch { /* addon not available */ }
      if (app.ws?.readyState === 1) app.ws.send(JSON.stringify({ type: 'resize', termId, cols: t.xterm.cols, rows: t.xterm.rows }));
    }
  }
}

export function debouncedFit() {
  clearTimeout(app.fitDebounce);
  app.fitDebounce = setTimeout(fitAllTerminals, 80);
}

// ─── New Terminal ───
export function openNewTermModal() {
  const sel = document.getElementById('nt-project');
  sel.innerHTML = app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  // Pre-select active terminal's project
  const activeT = app.activeTermId ? app.termMap.get(app.activeTermId) : null;
  if (activeT?.projectId) sel.value = activeT.projectId;
  document.getElementById('nt-cmd').value = '';
  document.getElementById('new-term-modal').showModal();
  notify('loadBranchesForTerm');
}

export function createTerminal() {
  const projectId = document.getElementById('nt-project').value;
  const cmd = document.getElementById('nt-cmd').value;
  document.getElementById('new-term-modal').close();
  const msg = { type: 'create', projectId, command: cmd || undefined, cols: 120, rows: 30 };
  if (app._selectedBranch) {
    if (app._selectedBranch.type === 'worktree' && app._selectedBranch.cwd) { msg.cwd = app._selectedBranch.cwd; }
    else if (app._selectedBranch.type === 'local') { const checkout = `git checkout ${app._selectedBranch.value}`; msg.command = cmd ? `${checkout} && ${cmd}` : checkout; }
    else if (app._selectedBranch.type === 'remote') { const localName = app._selectedBranch.value.replace(/^[^/]+\//, ''); const checkout = `git checkout -b ${localName} ${app._selectedBranch.value} 2>/dev/null || git checkout ${localName}`; msg.command = cmd ? `${checkout} && ${cmd}` : checkout; }
  }
  app._selectedBranch = null;
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    showToast('Terminal not connected', 'error');
    return;
  }
  app.ws.send(JSON.stringify(msg));
  notify('switchView', 'terminal');
}

export function openTermWith(projectId, cmd) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { showToast('Terminal not connected', 'error'); return; }
  // Show the New Terminal modal with project & command pre-selected
  const sel = document.getElementById('nt-project');
  sel.innerHTML = app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (projectId) sel.value = projectId;
  const cmdSel = document.getElementById('nt-cmd');
  // Ensure cmd option exists, add if custom
  if (cmd) {
    let found = false;
    for (const opt of cmdSel.options) { if (opt.value === cmd) { found = true; break; } }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = cmd; opt.textContent = cmd;
      cmdSel.appendChild(opt);
    }
    cmdSel.value = cmd;
  } else {
    cmdSel.value = '';
  }
  document.getElementById('new-term-modal').showModal();
  notify('loadBranchesForTerm');
}

export function openNewTermModalWithSplit(targetTermId, pos) {
  // Auto-create with same project as source terminal (skip modal)
  const sourceT = app.termMap.get(targetTermId);
  if (sourceT?.projectId && app.ws?.readyState === WebSocket.OPEN) {
    _splitTarget = { termId: targetTermId, pos };
    app.ws.send(JSON.stringify({ type: 'create', projectId: sourceT.projectId, cols: 120, rows: 30 }));
    return;
  }
  // Fallback: show modal
  const sel = document.getElementById('nt-project');
  sel.innerHTML = app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  document.getElementById('new-term-modal').showModal();
  _splitTarget = { termId: targetTermId, pos };
}

// ─── Terminal Search ───
export function toggleTermSearch() {
  const sb = document.getElementById('term-search-bar');
  if (sb.classList.contains('open')) { closeTermSearch(); return; }
  sb.classList.add('open');
  const input = sb.querySelector('input'); input.value = ''; input.focus();
  // Populate search history datalist
  const dl = document.getElementById('term-search-history');
  if (dl) { dl.innerHTML = getSearchHistory().map(h => `<option value="${h.replace(/"/g, '&quot;')}">`).join(''); }
}

export function closeTermSearch() {
  const sb = document.getElementById('term-search-bar');
  sb.classList.remove('open');
  if (app.activeTermId) { const t = app.termMap.get(app.activeTermId); if (t?.searchAddon) t.searchAddon.clearDecorations(); }
}

const SEARCH_HISTORY_KEY = 'dl-term-search-history';
const MAX_SEARCH_HISTORY = 20;

function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch { return []; }
}

function addSearchHistory(q) {
  if (!q) return;
  const hist = getSearchHistory().filter(h => h !== q);
  hist.unshift(q);
  if (hist.length > MAX_SEARCH_HISTORY) hist.length = MAX_SEARCH_HISTORY;
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist)); } catch { /* storage unavailable */ }
}

export function doTermSearch(dir) {
  const input = document.querySelector('#term-search-bar input');
  const countEl = document.getElementById('ts-match-count');
  const q = input.value;
  if (!q || !app.activeTermId) { if (countEl) countEl.textContent = ''; return; }
  addSearchHistory(q);
  const t = app.termMap.get(app.activeTermId);
  if (!t?.searchAddon) return;
  const caseSensitive = document.getElementById('ts-case')?.classList.contains('active') || false;
  const regex = document.getElementById('ts-regex')?.classList.contains('active') || false;
  let found;
  if (dir === 'next') found = t.searchAddon.findNext(q, { regex, caseSensitive, incremental: true });
  else found = t.searchAddon.findPrevious(q, { regex, caseSensitive, incremental: true });
  if (countEl) countEl.textContent = found ? '' : 'No match';
}

// ─── Terminal Theme Sync ───
export function updateTermTheme() {
  const darkTheme = { background: '#08090d', foreground: '#e8e9f0', cursor: '#818cf8', selectionBackground: 'rgba(129,140,248,.3)', black: '#08090d', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e8e9f0' };
  const lightTheme = { background: '#ffffff', foreground: '#1e293b', cursor: '#6366f1', selectionBackground: 'rgba(99,102,241,.2)', black: '#1e293b', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04', blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#f8fafc' };
  const theme = app.currentTheme === 'light' ? lightTheme : darkTheme;
  for (const [, t] of app.termMap) {
    t.xterm.options.theme = theme;
  }
}

// ─── Terminal Font ───
export function changeTermFontSize(delta) {
  app.termFontSize = Math.max(8, Math.min(24, app.termFontSize + delta));
  localStorage.setItem('dl-term-font-size', app.termFontSize);
  const el = document.getElementById('term-font-size');
  if (el) el.textContent = app.termFontSize;
  for (const [, t] of app.termMap) { t.xterm.options.fontSize = app.termFontSize; t.fitAddon.fit(); }
}
export function resetTermFontSize() {
  app.termFontSize = 13;
  localStorage.setItem('dl-term-font-size', '13');
  const el = document.getElementById('term-font-size');
  if (el) el.textContent = 13;
  for (const [, t] of app.termMap) { t.xterm.options.fontSize = 13; t.fitAddon.fit(); }
  showToast('Font size reset to 13');
}

// ─── Terminal Export ───
export function exportTerminal() {
  if (!app.activeTermId) return showToast('No active terminal', 'error');
  const t = app.termMap.get(app.activeTermId);
  if (!t) return;
  const buf = t.xterm.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) { const line = buf.getLine(i); if (line) lines.push(line.translateToString(true)); }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const text = lines.join('\n').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `terminal-${t.label || app.activeTermId}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Terminal output exported', 'info');
}

// ─── Scrollback Setting ───
const SCROLLBACK_KEY = 'dl-term-scrollback';

export function getScrollback() {
  const v = parseInt(localStorage.getItem(SCROLLBACK_KEY));
  return (v >= 1000 && v <= 50000) ? v : 5000;
}

export function setScrollback(val) {
  const v = Math.max(1000, Math.min(50000, parseInt(val) || 5000));
  localStorage.setItem(SCROLLBACK_KEY, v);
  // Apply to all existing terminals
  for (const [, t] of app.termMap) {
    t.xterm.options.scrollback = v;
  }
  showToast(`Scrollback set to ${v.toLocaleString()} lines`);
}

export function showScrollbackDialog() {
  const current = getScrollback();
  const val = prompt(`Scrollback lines (1,000 ~ 50,000)\nCurrent: ${current.toLocaleString()}`, current);
  if (val !== null) setScrollback(val);
}

// ─── Branch picker for new terminal ───
export async function loadBranchesForTerm() {
  const projectId = document.getElementById('nt-project').value;
  const section = document.getElementById('nt-branch-section');
  const list = document.getElementById('nt-branch-list');
  app._selectedBranch = null;
  if (!projectId) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.innerHTML = '<div style="padding:10px;color:var(--text-3);font-size:.78rem">Loading...</div>';
  try {
    const res = await fetch(`/api/projects/${projectId}/branches`);
    app._branchData = await res.json();
    let html = '';
    if (app._branchData.worktrees?.length > 1) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Worktrees</div>`;
      for (const wt of app._branchData.worktrees) {
        const name = wt.path.split('/').pop();
        const isCurrent = wt.branch === app._branchData.current;
        html += `<div class="nt-branch-item" data-type="worktree" data-value="${esc(wt.branch)}" data-cwd="${esc(wt.path)}" data-action="select-branch"><span>${esc(wt.branch)}</span><span class="nb-wt-path">${esc(name)}</span>${isCurrent ? '<span class="nb-current">current</span>' : ''}</div>`;
      }
      html += '</div>';
    }
    if (app._branchData.local?.length) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Local</div>`;
      for (const b of app._branchData.local) { const isCurrent = b === app._branchData.current; html += `<div class="nt-branch-item" data-type="local" data-value="${esc(b)}" data-action="select-branch"><span>${esc(b)}</span>${isCurrent ? '<span class="nb-current">current</span>' : ''}</div>`; }
      html += '</div>';
    }
    if (app._branchData.remote?.length) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Remote</div>`;
      for (const b of app._branchData.remote) { html += `<div class="nt-branch-item" data-type="remote" data-value="${esc(b)}" data-action="select-branch"><span style="color:var(--text-2)">${esc(b)}</span></div>`; }
      html += '</div>';
    }
    list.innerHTML = html || '<div style="padding:10px;color:var(--text-3);font-size:.78rem">No branches found</div>';
  } catch { list.innerHTML = '<div style="padding:10px;color:var(--text-3);font-size:.78rem">Error loading branches</div>'; }
}

export function selectBranch(el) {
  document.querySelectorAll('#nt-branch-list .nt-branch-item.selected').forEach(x => x.classList.remove('selected'));
  if (app._selectedBranch && app._selectedBranch.value === el.dataset.value && app._selectedBranch.type === el.dataset.type) { app._selectedBranch = null; return; }
  el.classList.add('selected');
  app._selectedBranch = { type: el.dataset.type, value: el.dataset.value, cwd: el.dataset.cwd || '' };
}

// ─── Initialize terminal-ui with core references ───
initTermUI({
  fitAllTerminals,
  debouncedFit,
  saveLayout,
  closeTerminal,
  openNewTermModal,
  openNewTermModalWithSplit,
  openTermWith,
  createTerminal,
  selectBranch,
  loadBranchesForTerm,
  toggleTermSearch,
  closeTermSearch,
  doTermSearch,
  changeTermFontSize,
  exportTerminal,
  getScrollback,
  removeFromLayoutTree,
  splitAt,
});
