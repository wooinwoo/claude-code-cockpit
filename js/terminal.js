// ─── Terminal: WebSocket, xterm, layout tree, headers, search ───
import { app } from './state.js';
import { esc, showToast, escapeHtml, IMG_EXT } from './utils.js';

// ─── Mobile Detection ───
export function isMobile() {
  return window.innerWidth <= 600 || (window.matchMedia('(hover: none) and (pointer: coarse)').matches && window.innerWidth <= 900);
}

// ─── Write Buffer ───
function bufferWrite(t, data, id) {
  if (!id) { t.xterm.write(data); return; }
  let buf = app.writeBuffers.get(id);
  if (!buf) { buf = { data: '', timer: null }; app.writeBuffers.set(id, buf); }
  buf.data += data;
  if (!buf.timer) {
    buf.timer = requestAnimationFrame(() => { t.xterm.write(buf.data); buf.data = ''; buf.timer = null; });
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
  } catch {}
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
    } catch {}
    const activeId = localStorage.getItem('dl-active');
    if (activeId && app.termMap.has(activeId)) app.activeTermId = activeId;
    return true;
  } catch { return false; }
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
  } catch {}
}

// ─── WebSocket ───
export function connectWS() {
  if (app._wsReconnTimer) { clearTimeout(app._wsReconnTimer); app._wsReconnTimer = null; }
  try {
    app.ws = new WebSocket(`ws://${location.host}`);
  } catch (e) {
    console.error('[WS] constructor error', e);
    return;
  }
  app.ws.onopen = () => {
    app._wsBackoff = 1000;
    app._wsConnectedAt = Date.now();
    showDisconnectIndicator(false);
  };
  app.ws.onmessage = e => {
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
          showToast(`Terminal "${t.label}" — process exited`, 'warning');
        }
        break;
      }
    }
    } catch (err) { console.error('[WS] message handler error', err); }
  };
  app.ws.onerror = err => { console.error('[WS] error', err); };
  app.ws.onclose = (ev) => {
    showDisconnectIndicator(true);
    // Flush pending writeBuffers to prevent stale RAF timers
    for (const [id, wb] of app.writeBuffers) { if (wb.timer) cancelAnimationFrame(wb.timer); }
    app.writeBuffers.clear();
    if (app._wsConnectedAt && Date.now() - app._wsConnectedAt > 30000) app._wsBackoff = 1000;
    app._wsBackoff = Math.min(app._wsBackoff * 1.5, 10000);
    const delay = Math.round(app._wsBackoff + Math.random() * 500);
    // Countdown on disconnect indicators
    let remain = Math.ceil(delay / 1000);
    const updateCountdown = () => { document.querySelectorAll('.term-disconnect').forEach(el => el.textContent = `Disconnected — reconnecting in ${remain}s`); };
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
      const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|usr|tmp|var|etc|opt|mnt)[^\s"'<>|:]+)/g;
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
    if ((ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') || (ev.ctrlKey && !ev.shiftKey && ev.key === 'c' && xterm.hasSelection())) {
      const text = xterm.getSelection();
      if (text) { navigator.clipboard.writeText(text).then(() => xterm.clearSelection()).catch(() => {}); }
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
  app.termMap.set(termId, { xterm, fitAddon, searchAddon, projectId, element, label: name, color, opened: false, pendingBuffer: null });
  if (addToView) {
    if (window._splitTarget) {
      const st = window._splitTarget; window._splitTarget = null;
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
    for (const [termId, t] of app.termMap) {
      if (!t.opened && t.element.parentNode) {
        t.xterm.open(t.element);
        if (!window.chrome?.webview) { try { t.xterm.loadAddon(new WebglAddon.WebglAddon()); } catch {} }
        try { t.xterm.loadAddon(new ImageAddon.ImageAddon()); } catch {}
        t.opened = true;
        if (t.pendingBuffer) { t.xterm.write(t.pendingBuffer); t.pendingBuffer = null; }
      }
    }
    setTimeout(fitAllTerminals, 120);
  });
  saveLayout();
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
        if (!window.chrome?.webview) { try { activeT.xterm.loadAddon(new WebglAddon.WebglAddon()); } catch {} }
        try { activeT.xterm.loadAddon(new ImageAddon.ImageAddon()); } catch {}
        activeT.opened = true;
        if (activeT.pendingBuffer) { activeT.xterm.write(activeT.pendingBuffer); activeT.pendingBuffer = null; }
      }
      setTimeout(() => { try { activeT.fitAddon.fit(); } catch {} }, 80);
      if (app.ws?.readyState === 1) app.ws.send(JSON.stringify({ type: 'resize', termId: app.activeTermId, cols: activeT.xterm.cols, rows: activeT.xterm.rows }));
    });
  }
  saveLayout();
}

export function mobileSwitchTerm(termId) {
  if (!app.termMap.has(termId)) return;
  app.activeTermId = termId;
  renderMobileLayout();
}

export function mobileCloseTerm(termId) {
  closeTerminal(termId);
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
    debouncedFit();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    cover.remove(); fitAllTerminals(); saveLayout();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Terminal Headers ───
export function debouncedUpdateTermHeaders() {
  if (app._termHeaderTimer) return;
  app._termHeaderTimer = requestAnimationFrame(() => { app._termHeaderTimer = null; updateTermHeaders(); });
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
    const bufPct = Math.round(bufUsed / getScrollback() * 100);
    const cacheKey = `${t.label}|${t.color}|${g.branch || ''}|${g.uncommittedCount || 0}|${model}|${nv}|${wt.length}|${tid === app.activeTermId}|${bufPct}`;
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
      (bufPct >= 80 ? `<span class="th-tag th-buf" data-action="clear-buf" style="color:${bufPct >= 95 ? 'var(--red)' : 'var(--yellow)'};font-size:.7rem;cursor:pointer" title="Buffer ${bufPct}% — click to clear">${bufPct}%</span>` : '') +
      `<span class="th-spacer"></span>` +
      `<button class="th-close" data-action="close" title="Close">\u00d7</button>`;
    head.onclick = e => {
      if (e.target.dataset.action === 'close') { e.stopPropagation(); closeTerminal(tid); return; }
      if (e.target.dataset.action === 'clear-buf') { e.stopPropagation(); const tt = app.termMap.get(tid); if (tt?.xterm) { tt.xterm.clear(); showToast('Buffer cleared'); updateTermHeaders(); } return; }
      if (e.target.classList.contains('th-changes')) { e.stopPropagation(); window.showDiffDialog?.(e.target.dataset.pid); return; }
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
  const finish = () => { const val = input.value.trim(); if (val) t.label = val; updateTermHeaders(); saveLayout(); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') updateTermHeaders(); e.stopPropagation(); });
  input.addEventListener('blur', finish);
  nameSpan.replaceWith(input); input.focus(); input.select();
}

// ─── Context Menu ───
export function showTermCtxMenu(e, termId) {
  const menu = document.getElementById('term-ctx-menu');
  const t = app.termMap.get(termId);
  if (!t) return;
  const g = app.state.projects.get(t.projectId)?.git || {};
  const hasChanges = g.uncommittedCount > 0;
  const sel = t.xterm.getSelection();
  let filePath = null;
  const wrap = t.element;
  const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
  const cellH = t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
  const rect = wrap.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (rect) {
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row = t.xterm.buffer.active.viewportY + Math.floor((e.clientY - rect.top) / cellH);
    filePath = getFilePathAtPosition(t.xterm, col, row);
  }
  let html = '';
  if (filePath) {
    html += `<div class="ctx-menu-label">File</div>`;
    html += `<div class="ctx-menu-item" data-act="preview" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F441}</span>Preview</div>`;
    html += `<div class="ctx-menu-item" data-act="open-code" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in VS Code</div>`;
    html += `<div class="ctx-menu-item" data-act="open-cursor" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Cursor</div>`;
    html += `<div class="ctx-menu-item" data-act="open-zed" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Zed</div>`;
    html += `<div class="ctx-menu-item" data-act="open-windsurf" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Windsurf</div>`;
    html += `<div class="ctx-menu-item" data-act="open-antigravity" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Antigravity</div>`;
    html += `<div class="ctx-menu-item" data-act="copy-path" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F4CB}</span>Copy Path</div>`;
    html += `<div class="ctx-menu-item" data-act="open-folder" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F4C2}</span>Open in Explorer</div>`;
    html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  }
  if (sel) html += `<div class="ctx-menu-item" data-act="copy"><span class="ctx-icon">\u{1F4CB}</span>Copy</div>`;
  html += `<div class="ctx-menu-item" data-act="paste"><span class="ctx-icon">\u{1F4CB}</span>Paste</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item" data-act="rename"><span class="ctx-icon">A</span>Rename</div>`;
  html += `<div class="ctx-menu-item" data-act="new"><span class="ctx-icon">+</span>New Terminal<span style="margin-left:auto" class="kbd">Ctrl+T</span></div>`;
  html += `<div class="ctx-menu-item" data-act="search"><span class="ctx-icon">\u{1F50D}</span>Search<span style="margin-left:auto" class="kbd">Ctrl+F</span></div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item" data-act="split-h"><span class="ctx-icon">\u2194</span>Split Right</div>`;
  html += `<div class="ctx-menu-item" data-act="split-v"><span class="ctx-icon">\u2195</span>Split Down</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  if (hasChanges) html += `<div class="ctx-menu-item" data-act="diff"><span class="ctx-icon">\u00B1</span>View Changes (${g.uncommittedCount})</div>`;
  html += `<div class="ctx-menu-item" data-act="ide"><span class="ctx-icon">&lt;/&gt;</span>Open Project in IDE</div>`;
  html += `<div class="ctx-menu-item" data-act="firefox-dev"><span class="ctx-icon">\u{1F310}</span>Open in Firefox Dev</div>`;
  html += `<div class="ctx-menu-item" data-act="clear"><span class="ctx-icon">\u2327</span>Clear Terminal</div>`;
  html += `<div class="ctx-menu-item" data-act="export"><span class="ctx-icon">\u{1F4BE}</span>Export Output</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item" data-act="cmd-history"><span class="ctx-icon">\u{1F4DC}</span>Command History<span style="margin-left:auto" class="kbd">Ctrl+R</span></div>`;
  html += `<div class="ctx-menu-item" data-act="presets"><span class="ctx-icon">\u2606</span>Presets</div>`;
  html += `<div class="ctx-menu-item" data-act="broadcast"><span class="ctx-icon">\u{1F4E1}</span>${_broadcastMode ? 'Broadcast OFF' : 'Broadcast Mode'}<span style="margin-left:auto" class="kbd">Ctrl+B</span></div>`;
  html += `<div class="ctx-menu-item" data-act="scrollback"><span class="ctx-icon">\u{1F4CF}</span>Scrollback: ${getScrollback().toLocaleString()}</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item danger" data-act="close"><span class="ctx-icon">\u00d7</span>Close Terminal<span style="margin-left:auto" class="kbd">Ctrl+W</span></div>`;
  menu.innerHTML = html;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 520) + 'px';
  menu.style.maxHeight = (window.innerHeight - 20) + 'px';
  menu.style.overflowY = 'auto';
  menu.classList.add('show');
  menu.onclick = ev => {
    const item = ev.target.closest('[data-act]');
    if (!item) return;
    menu.classList.remove('show');
    const path = item.dataset.path;
    switch (item.dataset.act) {
      case 'preview': if (path) window.openFilePreview?.(path); break;
      case 'open-code': if (path) openInIde(path, 'code'); break;
      case 'open-cursor': if (path) openInIde(path, 'cursor'); break;
      case 'open-zed': if (path) openInIde(path, 'zed'); break;
      case 'open-windsurf': if (path) openInIde(path, 'windsurf'); break;
      case 'open-antigravity': if (path) openInIde(path, 'antigravity'); break;
      case 'copy-path': if (path) { navigator.clipboard.writeText(path); showToast('Path copied'); } break;
      case 'open-folder': if (path) openContainingFolder(path); break;
      case 'copy': { const s = t.xterm.getSelection(); if (s) { navigator.clipboard.writeText(s); t.xterm.clearSelection(); showToast('Copied'); } break; }
      case 'paste': (async () => { try { const items = await navigator.clipboard.read(); for (const ci of items) { const imgT = ci.types.find(x => x.startsWith('image/')); if (imgT) { const blob = await ci.getType(imgT); const r = await fetch('/api/upload-image', { method: 'POST', headers: { 'Content-Type': imgT }, body: blob }); const { path: p } = await r.json(); if (p && app.ws?.readyState === 1) { app.ws.send(JSON.stringify({ type: 'input', termId, data: p + ' ' })); const thumb = URL.createObjectURL(blob); showToast(`<img src="${thumb}" style="max-width:120px;max-height:80px;border-radius:6px;vertical-align:middle;margin-right:6px" onload="URL.revokeObjectURL(this.src)">Image pasted`, 'success', 3000, true); } return; } } const txt = await navigator.clipboard.readText(); if (txt && app.ws?.readyState === 1) { const data = txt.includes('\n') ? `\x1b[200~${txt}\x1b[201~` : txt; app.ws.send(JSON.stringify({ type: 'input', termId, data })); } } catch {} })(); break;
      case 'rename': { const leaf = document.querySelector(`.split-leaf[data-term-id="${termId}"]`); const head = leaf?.querySelector('.term-head'); if (head) startRenameHeader(termId, head); break; }
      case 'new': window.openNewTermModal?.(); break;
      case 'search': app.activeTermId = termId; toggleTermSearch(); break;
      case 'split-h': openNewTermModalWithSplit(termId, 'right'); break;
      case 'split-v': openNewTermModalWithSplit(termId, 'bottom'); break;
      case 'diff': window.showDiffDialog?.(t.projectId); break;
      case 'ide': openInIDEProject(t.projectId); break;
      case 'firefox-dev': openInFirefoxDevFromTerm(t.projectId); break;
      case 'clear': t.xterm.clear(); break;
      case 'export': app.activeTermId = termId; exportTerminal(); break;
      case 'cmd-history': app.activeTermId = termId; toggleCmdPalette(); break;
      case 'presets': showPresetsDialog(); break;
      case 'broadcast': toggleBroadcastMode(); break;
      case 'scrollback': showScrollbackDialog(); break;
      case 'close': closeTerminal(termId); break;
    }
  };
  const dismiss = () => { menu.classList.remove('show'); document.removeEventListener('click', dismiss); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', dismiss, true); };
  const onKey = ev => { if (ev.key === 'Escape') dismiss(); };
  setTimeout(() => { document.addEventListener('click', dismiss); document.addEventListener('keydown', onKey); window.addEventListener('scroll', dismiss, true); }, 0);
}

function openNewTermModalWithSplit(targetTermId, pos) {
  // Auto-create with same project as source terminal (skip modal)
  const sourceT = app.termMap.get(targetTermId);
  if (sourceT?.projectId && app.ws?.readyState === WebSocket.OPEN) {
    window._splitTarget = { termId: targetTermId, pos };
    app.ws.send(JSON.stringify({ type: 'create', projectId: sourceT.projectId, cols: 120, rows: 30 }));
    return;
  }
  // Fallback: show modal
  const sel = document.getElementById('nt-project');
  sel.innerHTML = app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  document.getElementById('new-term-modal').showModal();
  window._splitTarget = { termId: targetTermId, pos };
}

function openInIDEProject(projectId) {
  fetch(`/api/projects/${projectId}/open-ide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
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
      try { t.fitAddon.fit(); } catch {}
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
  window.loadBranchesForTerm?.();
}

export function createTerminal() {
  const projectId = document.getElementById('nt-project').value;
  let cmd = document.getElementById('nt-cmd').value;
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
  window.switchView?.('terminal');
}

export function openTermWith(projectId, cmd) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { showToast('Terminal not connected', 'error'); return; }
  app.ws.send(JSON.stringify({ type: 'create', projectId, command: cmd || undefined, cols: 120, rows: 30 }));
  window.switchView?.('terminal');
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
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist)); } catch {}
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

// ─── File path detection ───
function getFilePathAtPosition(xterm, x, y) {
  const line = xterm.buffer.active.getLine(y)?.translateToString() || '';
  const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|usr|tmp|var|etc|opt|mnt)[^\s"'<>|:]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) { if (x >= m.index && x < m.index + m[0].length) return m[0]; }
  return null;
}

function openInIde(filePath, ide) {
  fetch('/api/open-in-ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, ide }) })
    .then(r => r.json()).then(d => { if (d.opened) showToast(`Opened in ${ide}`); else showToast(d.error || 'Failed', 'error'); })
    .catch(() => showToast('Failed to open', 'error'));
}

function openContainingFolder(filePath) {
  fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) })
    .then(() => showToast('Opened in Explorer')).catch(() => {});
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
      } catch {}
    }
    window.openFilePreviewFromFile?.(file);
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
        case 'new-term': openNewTermModal(); break;
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
        case 'create-terminal': createTerminal(); break;
        case 'select-branch': selectBranch(el); break;
      }
    });
    _ntModal.addEventListener('change', e => {
      if (e.target.dataset.action === 'load-branches') loadBranchesForTerm();
    });
  }
  const _termPanels = document.getElementById('term-panels');
  _termPanels.addEventListener('mousedown', e => {
    const leaf = e.target.closest('.split-leaf');
    if (leaf) { app.activeTermId = leaf.dataset.termId; updateTermHeaders(); }
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
      removeFromLayoutTree(app.draggedTermId);
      splitAt(targetId, app.draggedTermId, pos);
      app.activeTermId = app.draggedTermId;
      renderLayout(); updateTermHeaders();
    }
  });
  // Resize observer
  const termPanelsObs = new ResizeObserver(debouncedFit);
  termPanelsObs.observe(_termPanels);
  window.addEventListener('resize', debouncedFit);
  // Re-render layout when crossing mobile/desktop threshold
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== wasMobile) { wasMobile = nowMobile; renderLayout(); }
  });
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

function addCmdHistory(cmd) {
  if (!cmd || cmd.length < 2) return;
  // Skip single control chars, pure whitespace
  if (/^[\x00-\x1f]+$/.test(cmd)) return;
  const hist = getCmdHistory().filter(h => h !== cmd);
  hist.unshift(cmd);
  if (hist.length > MAX_CMD_HISTORY) hist.length = MAX_CMD_HISTORY;
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(hist)); } catch {}
}

// Command capture is hooked in addTerminal's onData handler

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
      <div class="hist-palette-hint">↑↓ Navigate · Enter Send · Esc Close</div>
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
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch { return []; }
}

function savePresets(presets) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch {}
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
  openTermWith(projectId, preset.command);
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
    showToast(`Broadcast mode ON — typing to ${_broadcastTargets.size} terminals`, 'info');
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

// Hook into terminal data sending for broadcast
export function setupBroadcastHook() {
  // Broadcast is hooked at the terminal onData level in addTerminal
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

// ─── Sticky Scrollback Setting ───
export function showScrollbackDialog() {
  const current = getScrollback();
  const val = prompt(`Scrollback lines (1,000 ~ 50,000)\nCurrent: ${current.toLocaleString()}`, current);
  if (val !== null) setScrollback(val);
}
