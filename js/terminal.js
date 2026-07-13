// ─── Terminal Core: WebSocket, xterm, layout tree, search, font, export, theme ───
import { app, notify } from './state.js';
import { copyText, esc, showToast, escapeHtml } from './utils.js';

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

// ─── Chat View 연결 (모드 = chat 일 때 PTY 데이터 카드 렌더) ───
let _chatViewModule = null;
async function getChatView() {
  if (!_chatViewModule) _chatViewModule = await import('./chat-view.js');
  return _chatViewModule;
}

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
      // 모바일: 비활성 터미널에 새 출력 오면 탭에 미확인 점 표시 (탭 전환 시 리렌더로 자동 해제)
      if (id !== app.activeTermId) {
        const tab = document.querySelector(`.mob-tab[data-tid="${id}"]`);
        if (tab) tab.classList.add('has-unseen');
      }
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
    if (app._termTimerInterval) clearInterval(app._termTimerInterval);
    app._termTimerInterval = setInterval(() => { if (app.termMap.size) updateTermHeaders(); }, 30000);
    // chat-view fs.watch 재구독 (재연결 시)
    setTimeout(() => { if (typeof window.cvRewatchAll === 'function') window.cvRewatchAll(); }, 200);
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
      case 'session-update': {
        // chat-view \uc758 fs.watch push \ucc98\ub9ac
        if (typeof window.cvOnSessionUpdate === 'function') window.cvOnSessionUpdate(msg.termId);
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
  console.log('[SKIN-v2] addTerminal — new theme (#0a0b16 + JetBrains Mono) applied');
  const project = app.projectList.find(p => p.id === projectId);
  const color = project?.color || '#666';
  const name = project?.name || (projectId === '__home__' ? 'Home' : projectId);
  // 다크 테마 — 가독성 우선. 보라 톤 제거, 부드러운 다크 그레이 + 분홍/시안 액센트
  const darkTheme = {
    background: '#15171c',           // 부드러운 다크 그레이 (보라 없음, 살짝 푸른 톤)
    foreground: '#f5f1e8',           // 따뜻한 크림 화이트
    cursor: '#7ee8fb',                // 시안 (보라 빼고 가독성)
    cursorAccent: '#15171c',
    selectionBackground: 'rgba(126,232,251,.25)',
    selectionForeground: '#ffffff',
    black: '#1c1e26',
    red: '#ff8088',                   // 부드러운 산호
    green: '#8fef8b',                 // 살짝 라임
    yellow: '#ffd866',                // 꿀 톤
    blue: '#82b0ff',                  // 부드러운 청
    magenta: '#ff8fb8',               // 분홍 (보라 X)
    cyan: '#7ee8fb',                  // 시안
    white: '#f5f1e8',
    brightBlack: '#6e7281',           // dim 텍스트 — 잘 보이게 명도 상향
    brightRed: '#ffa7ad',
    brightGreen: '#aff5ad',
    brightYellow: '#ffe39c',
    brightBlue: '#a8c8ff',
    brightMagenta: '#ffb1d0',         // 밝은 분홍
    brightCyan: '#a8f0ff',
    brightWhite: '#ffffff',
  };
  const lightTheme = {
    background: '#fdfcfa',
    foreground: '#1e1f2a',
    cursor: '#6366f1',
    cursorAccent: '#fdfcfa',
    selectionBackground: 'rgba(99,102,241,.22)',
    black: '#1e1f2a',
    red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
    blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2',
    white: '#f0eff5',
  };
  const xterm = new Terminal({
    theme: app.currentTheme === 'light' ? lightTheme : darkTheme,
    fontFamily: "'JetBrains Mono','Cascadia Code','D2Coding','NanumGothicCoding','Pretendard Variable',monospace",
    fontSize: Math.max(16, app.termFontSize || 14),  // 최소 16
    fontWeight: '500',
    fontWeightBold: '800',
    letterSpacing: 0,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 3,
    cursorInactiveStyle: 'outline',
    allowProposedApi: true,
    scrollback: getScrollback(),
    fastScrollModifier: 'alt',
    fastScrollSensitivity: 5,
    minimumContrastRatio: 4.5,  // WCAG AA — dim 텍스트 강제로 보이게
    smoothScrollDuration: 120,
    drawBoldTextInBrightColors: true,
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
  // OSC 52 — TUI(Claude Code 등)가 pty 로 보내는 클립보드 복사 시퀀스.
  // 기본 xterm 은 무시해서 "copied to clipboard" 라고 떠도 실제 클립보드는 빔.
  // 쿼리('?')에는 절대 응답하지 않음 (클립보드 유출 + 리플레이 재응답 방지).
  xterm.parser.registerOscHandler(52, (data) => {
    const self = app.termMap.get(termId);
    if (self?._replaying) return true; // 리플레이 중 과거 복사가 현재 클립보드를 덮어쓰지 않게
    const m = /^[cps0-7]*;(.+)$/.exec(data);
    if (!m || m[1] === '?') return true;
    try {
      const bytes = Uint8Array.from(atob(m[1]), ch => ch.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) copyText(text);
    } catch { /* invalid base64 — ignore */ }
    return true;
  });
  // 벨(BEL) — 백그라운드 터미널의 작업 완료/입력 대기 알림
  xterm.onBell(() => {
    const self = app.termMap.get(termId);
    if (self?._replaying) return; // 리플레이 버퍼에 든 과거 벨은 무시
    if (!document.hidden && termId === app.activeTermId) return;
    const label = self?.label || 'terminal';
    showToast(`\u{1F514} ${label} — 벨 (완료/입력 대기)`, 'info', 4000);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`Cockpit — ${label}`, { body: '터미널 벨: 작업 완료 또는 입력 대기', tag: `bell-${termId}` }); } catch { /* unsupported */ }
    }
  });
  // 키 비교는 ev.code(물리 키) 기준 — 한글 IME 상태에선 ev.key 가 'ㅊ'/'ㅍ' 등으로 들어와
  // ev.key 비교가 전부 빗나감 (한글 입력 중 복사/붙여넣기 안 되던 원인)
  xterm.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown') return true;
    // Let F5 / Ctrl+R pass through to browser for page reload
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'F5' || (mod && ev.code === 'KeyR' && !ev.shiftKey && !ev.altKey)) return false;
    // Let Ctrl+1~9 pass through for tab switching
    if (mod && ev.key >= '1' && ev.key <= '9') return false;
    // Copy: Ctrl+Shift+C 또는 선택 영역이 있을 때 Ctrl+C (선택 없으면 SIGINT 로 통과)
    if (ev.ctrlKey && !ev.altKey && ev.code === 'KeyC' && (ev.shiftKey || xterm.hasSelection())) {
      const text = xterm.getSelection();
      if (text) copyText(text).then((ok) => { if (ok) xterm.clearSelection(); else showToast('Copy failed', 'error'); });
      return false;
    }
    // Ctrl+J — toggle quick bar (prevent terminal newline)
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyJ') {
      ev.preventDefault();
      toggleQuickBar();
      return false;
    }
    // Paste: Ctrl+V / Ctrl+Shift+V — preventDefault 없이 xterm 키 처리(^V 전송)만 차단.
    // 그러면 브라우저 기본 동작으로 paste 이벤트가 xterm textarea 에 발생하고,
    // 텍스트는 xterm 내장 paste(bracketed paste 모드 자동 반영), 이미지는
    // guardXtermPaste 가 업로드 처리. Clipboard API 권한/비보안(LAN) 접속과 무관하게 동작.
    if (ev.ctrlKey && !ev.altKey && ev.code === 'KeyV') return false;
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
  // Ctrl+휠 — 터미널 폰트 줌 (capture: xterm viewport 의 스크롤 처리보다 먼저 가로챔)
  element.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    changeTermFontSize(e.deltaY < 0 ? 1 : -1);
  }, { passive: false, capture: true });
  // 드래그 선택 시 자동 복사 (우클릭 메뉴 Tools 에서 토글)
  element.addEventListener('mouseup', () => {
    if (localStorage.getItem('dl-copy-on-select') !== '1') return;
    const sel = xterm.getSelection();
    if (sel && sel.trim()) copyText(sel);
  });
  let _cmdBuf = '';
  xterm.onData(data => {
    // 리플레이(재접속 버퍼 재생) 파싱 중 xterm 이 내는 자동응답(DA/DSR/커서위치 보고)이
    // live pty 에 입력으로 주입되는 것 차단 — 새로고침 시 프롬프트에 잡문자 찍히던 원인
    if (app.termMap.get(termId)?._replaying) return;
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

// ─── Layout Presets (정리) ───
// 현재 열린 터미널들을 순서대로 모아 균형 트리로 재배치
function collectLeaves(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'leaf') { acc.push(node.termId); return acc; }
  collectLeaves(node.children[0], acc);
  collectLeaves(node.children[1], acc);
  return acc;
}

// 노드 배열을 절반씩 나눠 균등 비율(leaf 수 기준)의 split 트리로 결합
function balanceNodes(nodes, dir) {
  if (nodes.length === 1) return nodes[0];
  const mid = Math.ceil(nodes.length / 2);
  const left = nodes.slice(0, mid);
  const right = nodes.slice(mid);
  return { type: 'split', dir, ratio: left.length / nodes.length, children: [balanceNodes(left, dir), balanceNodes(right, dir)] };
}

// mode: 'grid'(2x2 등) | 'cols'(가로 일렬) | 'rows'(세로 일렬)
export function arrangeTerminals(mode) {
  if (!app.layoutRoot) return;
  const ids = collectLeaves(app.layoutRoot).filter(id => app.termMap.has(id));
  if (ids.length < 2) { showToast('터미널이 2개 이상일 때 정리할 수 있어요'); return; }
  const leafOf = id => ({ type: 'leaf', termId: id });
  let root;
  if (mode === 'rows') root = balanceNodes(ids.map(leafOf), 'v');
  else if (mode === 'cols') root = balanceNodes(ids.map(leafOf), 'h');
  else { // grid — cols=ceil(sqrt(n)), 각 행은 좌우(h), 행끼리는 상하(v)
    const cols = Math.ceil(Math.sqrt(ids.length));
    const rows = [];
    for (let i = 0; i < ids.length; i += cols) rows.push(balanceNodes(ids.slice(i, i + cols).map(leafOf), 'h'));
    root = balanceNodes(rows, 'v');
  }
  app.layoutRoot = root;
  renderLayout();
  saveLayout();
  debouncedFit();
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
  // chat-view 폴링/watch 정리 (메모리 누수 방지)
  import('./chat-view.js').then(m => m.cleanupChatView?.(id));
  removeFromLayoutTree(id);
  if (app.activeTermId === id) { const first = app.termMap.keys().next().value; app.activeTermId = first || null; }
  renderLayout(); updateTermHeaders();
}

export function fitAllTerminals() {
  // 숨겨진 탭(백그라운드 폰/보조 창)은 pty 크기를 바꾸지 않음 — 여러 클라이언트가
  // 같은 pty 를 서로 자기 크기로 리사이즈하며 TUI 가 계속 재렌더링(화면 흔들림)되던 원인
  if (document.hidden) return;
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

// 다른 클라이언트가 pty 를 줄여놨어도 이 창으로 돌아오면 내 크기로 복구
window.addEventListener('focus', () => { if (app.termMap.size) debouncedFit(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && app.termMap.size) debouncedFit(); });

// ─── New Terminal ───
export function openNewTermModal() {
  const sel = document.getElementById('nt-project');
  sel.innerHTML = `<option value="__home__">빈 터미널 (홈)</option>`
    + app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
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

// 모달 없이 즉시 빈 터미널(홈 디렉터리, 프로젝트 비종속) 열기
export function openHomeTerminal() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { showToast('Terminal not connected', 'error'); return; }
  app._selectedBranch = null;
  app.ws.send(JSON.stringify({ type: 'create', projectId: '__home__', cols: 120, rows: 30 }));
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

// ─── Terminal Theme Sync (addTerminal 과 동일 옵션 라이브 적용) ───
export function updateTermTheme() {
  const darkTheme = {
    background: '#15171c', foreground: '#f5f1e8', cursor: '#7ee8fb', cursorAccent: '#15171c',
    selectionBackground: 'rgba(126,232,251,.25)', selectionForeground: '#ffffff',
    black: '#1c1e26', red: '#ff8088', green: '#8fef8b', yellow: '#ffd866',
    blue: '#82b0ff', magenta: '#ff8fb8', cyan: '#7ee8fb', white: '#f5f1e8',
    brightBlack: '#6e7281', brightRed: '#ffa7ad', brightGreen: '#aff5ad',
    brightYellow: '#ffe39c', brightBlue: '#a8c8ff', brightMagenta: '#ffb1d0',
    brightCyan: '#a8f0ff', brightWhite: '#ffffff',
  };
  const lightTheme = {
    background: '#fdfcfa', foreground: '#1e1f2a', cursor: '#6366f1', cursorAccent: '#fdfcfa',
    selectionBackground: 'rgba(99,102,241,.22)',
    black: '#1e1f2a', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
    blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#f0eff5',
  };
  const theme = app.currentTheme === 'light' ? lightTheme : darkTheme;
  for (const [, t] of app.termMap) {
    t.xterm.options.theme = theme;
    t.xterm.options.fontFamily = "'JetBrains Mono','Cascadia Code','D2Coding','NanumGothicCoding','Pretendard Variable',monospace";
    t.xterm.options.fontWeight = '500';
    t.xterm.options.fontWeightBold = '800';
    t.xterm.options.letterSpacing = 0;
    t.xterm.options.lineHeight = 1.4;
    t.xterm.options.cursorStyle = 'bar';
    t.xterm.options.cursorWidth = 3;
    t.xterm.options.minimumContrastRatio = 4.5;
    t.fitAddon?.fit?.();
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
  if (!projectId || projectId === '__home__') { section.style.display = 'none'; return; }
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
  openHomeTerminal,
  openTermWith,
  arrangeTerminals,
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
