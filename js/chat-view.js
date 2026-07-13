// ─── Chat View: session.jsonl 기반 답변 디자인 ───
// VSC Claude 확장 풍 — 메시지 카드, 마크다운, 코드 신택스
// ANSI 안 거치고 raw markdown 사용 (안 깨짐)

import { app } from './state.js';
import { copyText, preserveScroll } from './utils.js';

// marked.js 설정
function configureMarked() {
  if (typeof window.marked === 'undefined') return null;
  if (window._markedConfigured) return window.marked;
  const renderer = new window.marked.Renderer();
  renderer.code = (code, lang) => {
    const codeStr = (typeof code === 'object' && code !== null) ? (code.text || '') : (code || '');
    const language = (typeof code === 'object' && code !== null) ? (code.lang || '') : (lang || '');
    const escaped = codeStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let highlighted = escaped;
    if (window.hljs && language) {
      try {
        if (window.hljs.getLanguage(language)) {
          highlighted = window.hljs.highlight(codeStr, { language }).value;
        }
      } catch { /* fallback */ }
    }
    const lines = codeStr.split('\n').length;
    const collapsible = lines > 25;
    const langLabel = language || 'text';
    // raw 코드를 data 속성에 보관 (복사용, base64 로 인코딩하여 HTML 안전하게)
    const b64 = (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(codeStr))) : '';
    return (
      `<div class="code-block${collapsible ? ' collapsible collapsed' : ''}" data-lines="${lines}" data-raw="${b64}">` +
        `<div class="code-bar">` +
          `<span class="code-lang">${escapeHtml(langLabel)}</span>` +
          `<div class="code-actions">` +
            (collapsible ? `<button class="code-act" data-action="code-toggle" title="펼치기/접기"><span class="toggle-label">${lines}줄 펼치기</span></button>` : '') +
            `<button class="code-act" data-action="code-copy" title="복사">복사</button>` +
          `</div>` +
        `</div>` +
        `<pre><code class="hljs language-${escapeHtml(language || 'text')}">${highlighted}</code></pre>` +
      `</div>`
    );
  };
  window.marked.setOptions({ gfm: true, breaks: true, renderer });
  window._markedConfigured = true;
  return window.marked;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// LRU 캐시 — text → rendered HTML
const MD_CACHE = new Map();
const MD_CACHE_MAX = 200;
function renderMarkdown(text) {
  const key = text || '';
  if (MD_CACHE.has(key)) {
    // LRU: 다시 set 으로 끝으로 보냄
    const v = MD_CACHE.get(key);
    MD_CACHE.delete(key); MD_CACHE.set(key, v);
    return v;
  }
  const marked = configureMarked();
  let out;
  if (!marked) out = `<p>${escapeHtml(text)}</p>`;
  else { try { out = marked.parse(key); } catch { out = `<p>${escapeHtml(text)}</p>`; } }
  MD_CACHE.set(key, out);
  if (MD_CACHE.size > MD_CACHE_MAX) {
    // 가장 오래된 항목 제거 (Map insertion order)
    const firstKey = MD_CACHE.keys().next().value;
    MD_CACHE.delete(firstKey);
  }
  return out;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function renderToolInput(input) {
  if (typeof input !== 'object' || input === null) return escapeHtml(String(input || ''));
  try {
    const json = JSON.stringify(input, null, 2);
    return escapeHtml(json.length > 2000 ? json.slice(0, 2000) + '\n…(truncated)' : json);
  } catch { return escapeHtml(String(input)); }
}

function renderToolResult(content) {
  if (typeof content === 'string') return escapeHtml(content.length > 4000 ? content.slice(0, 4000) + '\n…(truncated)' : content);
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return escapeHtml(item);
      if (item && item.type === 'text') return escapeHtml(item.text || '');
      if (item && item.type === 'image') return `[image]`;
      return escapeHtml(JSON.stringify(item));
    }).join('\n');
  }
  return escapeHtml(JSON.stringify(content || ''));
}

function thinkingHtml() {
  return (
    `<div class="msg msg-assistant msg-thinking-card">` +
      `<div class="msg-avatar">C</div>` +
      `<div class="msg-body">` +
        `<div class="msg-head"><span class="msg-name">Claude</span><span class="msg-ts thinking-label">생각중</span></div>` +
        `<div class="thinking-dots"><span></span><span></span><span></span></div>` +
      `</div>` +
    `</div>`
  );
}

function renderOneMessage(msg) {
  const isUser = msg.role === 'user';
  const avatar = isUser ? 'U' : 'C';
  const name = isUser ? 'You' : 'Claude';
  const ts = fmtTime(msg.ts);
  const bodyHtml = msg.parts.map(p => {
    if (p.kind === 'text') return `<div class="msg-text">${renderMarkdown(p.text)}</div>`;
    if (p.kind === 'thinking') return `<details class="msg-thinking"><summary>Thinking</summary><div class="thinking-body">${escapeHtml(p.text)}</div></details>`;
    if (p.kind === 'tool_use') return `<div class="msg-tool"><div class="tool-head"><span class="tool-icon">🛠</span><span class="tool-name">${escapeHtml(p.name)}</span></div><div class="tool-input">${renderToolInput(p.input)}</div></div>`;
    if (p.kind === 'tool_result') return `<details class="msg-tool-result"><summary>Tool result</summary><div class="result-body">${renderToolResult(p.content)}</div></details>`;
    if (p.kind === 'image') {
      const src = p.url || (p.media_type && p.data ? `data:${p.media_type};base64,${p.data}` : '');
      if (!src) return '';
      const label = p.label || (p.media_type || 'image');
      return `<div class="msg-image"><img src="${src}" alt="image" loading="lazy"/><div class="img-meta">${escapeHtml(label)}</div></div>`;
    }
    return '';
  }).join('');
  const rawText = msg.parts.filter(p => p.kind === 'text').map(p => p.text).join('\n\n');
  const b64Msg = (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(rawText))) : '';
  return (
    `<div class="msg msg-${msg.role}" data-raw="${b64Msg}" data-parts="${msg.parts.length}" data-ts="${msg.ts || ''}">` +
      `<div class="msg-avatar">${avatar}</div>` +
      `<div class="msg-body">` +
        `<div class="msg-head">` +
          `<span class="msg-name">${name}</span>` +
          `${ts ? `<span class="msg-ts">${ts}</span>` : ''}` +
          `<div class="msg-actions">` +
            `<button class="msg-act" data-action="msg-copy" title="메시지 복사">복사</button>` +
            `<button class="msg-act" data-action="msg-collapse" title="접기/펼치기">접기</button>` +
          `</div>` +
        `</div>` +
        `<div class="msg-content">${bodyHtml}</div>` +
      `</div>` +
    `</div>`
  );
}

function renderMessagesNew(messages) {
  if (!messages || !messages.length) {
    return `<div class="chat-empty"><div class="empty-icon">✦</div><div>아직 메시지가 없어요</div><div class="empty-hint">Claude 와 한 마디 나누면 여기 보임</div></div>`;
  }
  return messages.map(renderOneMessage).join('');
}

function renderMessages_legacy_unused(messages) {
  if (!messages || !messages.length) {
    return `<div class="chat-empty"><div class="empty-icon">✦</div><div>아직 메시지가 없어요</div><div class="empty-hint">Claude 와 한 마디 나누면 여기 보임</div></div>`;
  }
  const parts = [];
  for (const msg of messages) {
    const isUser = msg.role === 'user';
    const avatar = isUser ? 'U' : 'C';
    const name = isUser ? 'You' : 'Claude';
    const ts = fmtTime(msg.ts);
    const bodyHtml = msg.parts.map(p => {
      if (p.kind === 'text') return `<div class="msg-text">${renderMarkdown(p.text)}</div>`;
      if (p.kind === 'thinking') return `<details class="msg-thinking"><summary>Thinking</summary><div class="thinking-body">${escapeHtml(p.text)}</div></details>`;
      if (p.kind === 'tool_use') return `<div class="msg-tool"><div class="tool-head"><span class="tool-icon">🛠</span><span class="tool-name">${escapeHtml(p.name)}</span></div><div class="tool-input">${renderToolInput(p.input)}</div></div>`;
      if (p.kind === 'tool_result') return `<details class="msg-tool-result"><summary>Tool result</summary><div class="result-body">${renderToolResult(p.content)}</div></details>`;
      if (p.kind === 'image') {
        const src = p.url || (p.media_type && p.data ? `data:${p.media_type};base64,${p.data}` : '');
        if (!src) return '';
        const label = p.label || (p.media_type || 'image');
        return `<div class="msg-image"><img src="${src}" alt="image" loading="lazy"/><div class="img-meta">${escapeHtml(label)}</div></div>`;
      }
      return '';
    }).join('');
    // 메시지의 raw 텍스트 (복사용) — text part 만 합침
    const rawText = msg.parts.filter(p => p.kind === 'text').map(p => p.text).join('\n\n');
    const b64Msg = (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(rawText))) : '';
    parts.push(
      `<div class="msg msg-${msg.role}" data-raw="${b64Msg}">` +
        `<div class="msg-avatar">${avatar}</div>` +
        `<div class="msg-body">` +
          `<div class="msg-head">` +
            `<span class="msg-name">${name}</span>` +
            `${ts ? `<span class="msg-ts">${ts}</span>` : ''}` +
            `<div class="msg-actions">` +
              `<button class="msg-act" data-action="msg-copy" title="메시지 복사">복사</button>` +
              `<button class="msg-act" data-action="msg-collapse" title="접기/펼치기">접기</button>` +
            `</div>` +
          `</div>` +
          `<div class="msg-content">${bodyHtml}</div>` +
        `</div>` +
      `</div>`
    );
  }
  return parts.join('');
}

const ACTIVE_POLLERS = new Map();
const SLOW_MS = 1500;   // 기본
const FAST_MS = 500;    // 사용자 메시지 보낸 직후 부스트
const BOOST_DURATION = 30000; // 30초

async function fetchSession(projectPath, sessionId) {
  const sp = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
  const url = `/api/claude-session?projectPath=${encodeURIComponent(projectPath)}${sp}&_=${Date.now()}`;
  const r = await fetch(url, { headers: app.token ? { 'X-Token': app.token } : {} });
  if (!r.ok) throw new Error('fetch failed: ' + r.status);
  return r.json();
}

async function fetchSessionList(projectPath) {
  const url = `/api/claude-sessions?projectPath=${encodeURIComponent(projectPath)}&_=${Date.now()}`;
  const r = await fetch(url, { headers: app.token ? { 'X-Token': app.token } : {} });
  if (!r.ok) return { sessions: [] };
  return r.json();
}

function messagesSignature(messages, mtime) {
  if (!messages.length) return `empty:${mtime || 0}`;
  const last = messages[messages.length - 1];
  return `${messages.length}:${mtime || ''}:${last.ts || ''}:${last.parts.length}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

function shortModel(m) {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ');
}

async function refreshChat(leaf) {
  const termId = leaf.dataset.termId;
  const projectPath = leaf.dataset.projectPath;
  const sessionId = leaf.dataset.sessionId || '';
  const cv = leaf.querySelector('.chat-view');
  if (!cv || !projectPath) return;
  const statusEl = cv.querySelector('.chat-status');
  const sessionEl = cv.querySelector('.chat-session');
  const modelEl = cv.querySelector('.chat-model');
  const tokensEl = cv.querySelector('.chat-tokens');
  const msgsEl = cv.querySelector('.chat-messages');
  try {
    const data = await fetchSession(projectPath, sessionId);
    const sig = messagesSignature(data.messages || [], data.mtime);
    const poller = ACTIVE_POLLERS.get(termId);
    if (poller && poller.lastSig === sig) {
      if (statusEl) { statusEl.classList.add('live'); statusEl.textContent = 'live'; }
      return;
    }
    if (poller) poller.lastSig = sig;
    if (sessionEl) sessionEl.textContent = data.session ? data.session.slice(0, 8) : '—';
    if (modelEl) modelEl.textContent = shortModel(data.model) || '';
    if (tokensEl) {
      const u = data.usage || { in: 0, out: 0 };
      const total = (u.in || 0) + (u.out || 0);
      tokensEl.textContent = total ? `${fmtTokens(total)} tok` : '';
      tokensEl.title = `input ${fmtTokens(u.in)} · output ${fmtTokens(u.out)}`;
    }
    if (msgsEl) {
      const wasAtBottom = (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) < 40;
      const newMsgs = data.messages || [];
      const curSessionId = leaf.dataset.sessionId || data.session || '';
      const prevSessionId = poller?._lastSessionId || '';
      const fullRender = curSessionId !== prevSessionId || !msgsEl.querySelector('.msg');
      if (poller) poller._lastSessionId = curSessionId;

      // optimistic 메시지 정리 — jsonl 에 들어온 새 user 메시지와 매칭되면 제거
      const optimisticEls = [...msgsEl.querySelectorAll('.msg-optimistic')];
      if (optimisticEls.length) {
        for (const opt of optimisticEls) {
          const optText = opt.dataset.text || '';
          const matched = newMsgs.some((m) => m.role === 'user' && m.parts.some((p) => p.kind === 'text' && p.text.startsWith(optText)));
          if (matched) {
            opt.remove();
            // 첨부 blob URL 정리
            (leaf._optimisticUrls || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
            leaf._optimisticUrls = [];
          }
        }
      }
      if (fullRender) {
        // 세션 변경 또는 초기 → 전체 재렌더
        const renderAll = () => { msgsEl.innerHTML = renderMessagesNew(newMsgs); };
        if (wasAtBottom) renderAll();
        else preserveScroll(msgsEl, renderAll);
      } else {
        // incremental — 기존 메시지 유지, 추가/마지막 변동만 처리
        // thinking 카드는 일단 제거 (마지막 평가 후 다시 추가)
        msgsEl.querySelector('.msg-thinking-card')?.remove();
        const existingMsgs = [...msgsEl.querySelectorAll('.msg:not(.msg-thinking-card)')];
        const oldLen = existingMsgs.length;

        // 마지막 기존 메시지가 변동했는지 (parts 늘거나 ts 변경)
        if (oldLen > 0 && newMsgs.length >= oldLen) {
          const lastEl = existingMsgs[oldLen - 1];
          const correspondingNew = newMsgs[oldLen - 1];
          if (correspondingNew) {
            const oldParts = Number(lastEl.dataset.parts || 0);
            const oldTs = lastEl.dataset.ts || '';
            const newTs = correspondingNew.ts || '';
            if (oldParts !== correspondingNew.parts.length || oldTs !== newTs) {
              const tmp = document.createElement('div');
              tmp.innerHTML = renderOneMessage(correspondingNew);
              lastEl.replaceWith(tmp.firstElementChild);
            }
          }
        }
        // 새 메시지들 append
        for (let i = oldLen; i < newMsgs.length; i++) {
          msgsEl.insertAdjacentHTML('beforeend', renderOneMessage(newMsgs[i]));
        }
        // 메시지가 줄어든 경우 (rare — compact 등) → full render fallback
        if (newMsgs.length < oldLen) {
          const renderAll = () => { msgsEl.innerHTML = renderMessagesNew(newMsgs); };
          if (wasAtBottom) renderAll();
          else preserveScroll(msgsEl, renderAll);
        }
      }

      // 마지막이 user 면 thinking 표시
      const lastMsg = newMsgs[newMsgs.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        msgsEl.insertAdjacentHTML('beforeend', thinkingHtml());
      }
      if (wasAtBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
      updateScrollIndicator(leaf);
      const searchInput = cv.querySelector('.chat-search-input');
      if (searchInput && searchInput.value) highlightSearch(leaf, searchInput.value);
    }
    if (statusEl) { statusEl.classList.add('live'); statusEl.textContent = 'live'; }
  } catch (e) {
    if (statusEl) { statusEl.classList.remove('live'); statusEl.textContent = 'offline'; }
  }
}

function setPollInterval(poller, leaf, ms) {
  if (poller.timer) clearInterval(poller.timer);
  poller.intervalMs = ms;
  poller.timer = setInterval(() => refreshChat(leaf), ms);
}

function boostPolling(leaf) {
  const termId = leaf.dataset.termId;
  const poller = ACTIVE_POLLERS.get(termId);
  if (!poller) return;
  setPollInterval(poller, leaf, FAST_MS);
  if (poller.boostTimer) clearTimeout(poller.boostTimer);
  poller.boostTimer = setTimeout(() => {
    const p = ACTIVE_POLLERS.get(termId);
    if (p) setPollInterval(p, leaf, SLOW_MS);
  }, BOOST_DURATION);
}

function startPolling(leaf) {
  const termId = leaf.dataset.termId;
  stopPolling(termId);
  const poller = { timer: null, lastSig: '', intervalMs: SLOW_MS };
  ACTIVE_POLLERS.set(termId, poller);
  refreshChat(leaf);
  setPollInterval(poller, leaf, SLOW_MS);
  // 진정한 실시간: WS 로 server fs.watch 결과 subscribe
  if (app.ws?.readyState === 1) {
    try { app.ws.send(JSON.stringify({ type: 'chat-watch', termId, projectPath: leaf.dataset.projectPath })); } catch {}
  }
}

function stopPolling(termId) {
  const poller = ACTIVE_POLLERS.get(termId);
  if (poller) {
    if (poller.timer) clearInterval(poller.timer);
    if (poller.boostTimer) clearTimeout(poller.boostTimer);
  }
  ACTIVE_POLLERS.delete(termId);
  if (app.ws?.readyState === 1) {
    try { app.ws.send(JSON.stringify({ type: 'chat-unwatch', termId })); } catch {}
  }
}

// WS 의 session-update 메시지 hook — terminal.js 의 router 가 호출
export function onSessionUpdate(termId) {
  const leaf = document.querySelector(`.split-leaf[data-term-id="${CSS.escape(termId)}"]`);
  if (!leaf || !leaf.classList.contains('chat-active')) return;
  const poller = ACTIVE_POLLERS.get(termId);
  if (poller) poller.lastSig = '';
  refreshChat(leaf);
}
window.cvOnSessionUpdate = onSessionUpdate;

// WS 재연결 시 활성 chat-active leaf 모두 chat-watch 재구독
export function rewatchAllChats() {
  document.querySelectorAll('.split-leaf.chat-active').forEach((leaf) => {
    const termId = leaf.dataset.termId;
    const projectPath = leaf.dataset.projectPath;
    if (!termId || !projectPath || app.ws?.readyState !== 1) return;
    try { app.ws.send(JSON.stringify({ type: 'chat-watch', termId, projectPath })); } catch {}
  });
}
window.cvRewatchAll = rewatchAllChats;

export function ensureChatViewInLeaf(leaf, projectPath) {
  if (!leaf || leaf.querySelector('.chat-view')) {
    if (projectPath) leaf.dataset.projectPath = projectPath;
    return;
  }
  if (projectPath) leaf.dataset.projectPath = projectPath;
  const cv = document.createElement('div');
  cv.className = 'chat-view';
  cv.setAttribute('role', 'region');
  cv.setAttribute('aria-label', 'Claude 채팅');
  cv.innerHTML = `
    <div class="chat-toolbar" role="toolbar" aria-label="채팅 도구 모음">
      <span class="chat-title">Claude</span>
      <button class="chat-session" data-action="chat-sessions" title="세션 선택" aria-label="세션 선택" aria-haspopup="listbox">—</button>
      <span class="chat-model" aria-label="모델"></span>
      <span class="chat-tokens" title="누적 토큰" aria-label="누적 토큰"></span>
      <span class="spacer"></span>
      <span class="chat-status" role="status" aria-live="polite">idle</span>
      <button class="chat-tb-btn" data-action="chat-search" title="검색 (Ctrl+F)" aria-label="검색">🔍</button>
      <button class="chat-tb-btn" data-action="chat-download" title="세션을 .md 로 다운로드" aria-label="다운로드">⬇</button>
      <button class="chat-tb-btn" data-action="chat-refresh" title="새로고침" aria-label="새로고침">↻</button>
    </div>
    <div class="chat-search-bar" hidden role="search">
      <input class="chat-search-input" type="text" placeholder="메시지 검색…" aria-label="메시지 검색" />
      <span class="chat-search-count" aria-live="polite">0/0</span>
      <button class="chat-tb-btn" data-action="search-prev" title="이전" aria-label="이전 결과">↑</button>
      <button class="chat-tb-btn" data-action="search-next" title="다음" aria-label="다음 결과">↓</button>
      <button class="chat-tb-btn" data-action="search-close" title="닫기" aria-label="검색 닫기">×</button>
    </div>
    <div class="chat-sessions-dropdown" hidden role="listbox" aria-label="세션 목록"></div>
    <div class="chat-messages-wrap">
      <div class="chat-messages" role="log" aria-label="대화 기록" aria-live="polite"><div class="chat-empty"><div class="empty-icon">✦</div><div>로딩 중…</div></div></div>
      <button class="chat-scroll-bottom" data-action="chat-scroll-bottom" title="맨 아래로" aria-label="맨 아래로">▼ 새 메시지</button>
    </div>
    <div class="chat-composer" role="form" aria-label="메시지 입력">
      <div class="composer-attachments" aria-label="첨부된 이미지"></div>
      <div class="composer-row">
        <div class="composer-actions">
          <button class="composer-btn composer-attach" data-action="composer-attach" title="이미지 첨부 (Ctrl+V 도 가능)" aria-label="이미지 첨부">📎</button>
        </div>
        <textarea class="composer-input" placeholder="Claude 에게 한 마디… (이미지 Ctrl+V 로 바로 첨부)" rows="1" aria-label="Claude 에게 보낼 메시지" aria-multiline="true"></textarea>
        <button class="composer-send" data-action="composer-send" title="보내기 (Enter)" aria-label="보내기">▶</button>
      </div>
      <div class="composer-hint" aria-hidden="true">
        <span><kbd>Enter</kbd> 보내기</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈</span>
        <span><kbd>Ctrl</kbd>+<kbd>V</kbd> 이미지 붙여넣기</span>
        <span><kbd>/</kbd> 명령어</span>
      </div>
      <input type="file" class="composer-file-input" accept="image/*" multiple hidden aria-hidden="true" aria-label="이미지 파일 선택" tabindex="-1" />
    </div>
  `;
  const overlay = leaf.querySelector('.drop-overlay');
  if (overlay) leaf.insertBefore(cv, overlay);
  else leaf.appendChild(cv);
  wireComposer(cv, leaf);
}

// ── Composer 바인딩 ──
function wireComposer(cv, leaf) {
  const ta = cv.querySelector('.composer-input');
  const sendBtn = cv.querySelector('.composer-send');
  const attBtn = cv.querySelector('.composer-attach');
  const fileInput = cv.querySelector('.composer-file-input');
  const attsEl = cv.querySelector('.composer-attachments');
  if (!ta || !sendBtn) return;

  // textarea 자동 높이
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };
  ta.addEventListener('input', autosize);

  // Enter / 슬래시 메뉴 키보드 네비
  ta.addEventListener('keydown', (e) => {
    const slash = cv.querySelector('.composer-slash');
    const slashOpen = slash && !slash.hidden;
    if (slashOpen) {
      const items = [...slash.querySelectorAll('.slash-item')];
      const activeIdx = items.findIndex((i) => i.classList.contains('active'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (activeIdx + 1) % items.length;
        items.forEach((i, idx) => i.classList.toggle('active', idx === next));
        items[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (activeIdx - 1 + items.length) % items.length;
        items.forEach((i, idx) => i.classList.toggle('active', idx === prev));
        items[prev]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
        e.preventDefault();
        const cur = items[activeIdx >= 0 ? activeIdx : 0];
        if (cur) {
          ta.value = cur.dataset.cmd + ' ';
          ta.setSelectionRange(ta.value.length, ta.value.length);
          hideSlashMenu(leaf);
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(leaf); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendComposer(leaf);
    }
  });

  // 이미지 paste — chat-view 전체에서 받음, sync 처리
  const pasteHandler = (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    e.stopPropagation();
    const blobs = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    if (!blobs.length) return;
    cvToast(`이미지 ${blobs.length}개 첨부 중…`, 'info');
    // 비동기 fire-and-forget
    Promise.all(blobs.map((b) => attachImage(leaf, b))).then(() => {
      cvToast(`이미지 ${blobs.length}개 첨부됨`, 'info');
      focusComposer(leaf);
    });
  };
  // textarea 와 chat-view 둘 다 paste 받음
  ta.addEventListener('paste', pasteHandler);
  cv.addEventListener('paste', pasteHandler);

  // 첨부 버튼
  attBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    for (const f of files) {
      if (f.type.startsWith('image/')) await attachImage(leaf, f);
    }
    fileInput.value = '';
  });

  // send 버튼
  sendBtn.addEventListener('click', () => sendComposer(leaf));

  // 첨부 제거
  attsEl?.addEventListener('click', (e) => {
    const rm = e.target.closest('.att-remove');
    if (!rm) return;
    const item = rm.closest('.att-item');
    if (item) {
      const path = item.dataset.path;
      const list = leaf._chatAttachments || [];
      const removed = list.find(a => a.path === path);
      if (removed?.url) { try { URL.revokeObjectURL(removed.url); } catch {} }
      leaf._chatAttachments = list.filter(a => a.path !== path);
      renderAttachments(leaf);
    }
  });

  // 드래그&드롭
  cv.addEventListener('dragover', (e) => { e.preventDefault(); cv.classList.add('drag-over'); });
  cv.addEventListener('dragleave', (e) => { if (e.target === cv) cv.classList.remove('drag-over'); });
  cv.addEventListener('drop', async (e) => {
    e.preventDefault();
    cv.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) {
      if (f.type.startsWith('image/')) await attachImage(leaf, f);
    }
  });
}

function cvToast(msg, kind = 'info') {
  // cockpit 의 showToast 사용 시도, 없으면 자체 toast
  if (typeof window.showToast === 'function') { window.showToast(msg, kind); return; }
  const t = document.createElement('div');
  t.className = `cv-toast cv-toast-${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 220); }, 2400);
}

async function attachImage(leaf, blob) {
  if (blob.size > 10 * 1024 * 1024) { cvToast('이미지가 10MB 초과', 'error'); return; }
  try {
    const fd = new FormData();
    fd.append('file', blob, blob.name || 'paste.png');
    const r = await fetch('/api/uploads', {
      method: 'POST',
      body: fd,
      headers: app.token ? { 'X-Token': app.token } : {},
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => 'upload failed');
      throw new Error(errText.slice(0, 120));
    }
    const data = await r.json();
    if (!data.path) throw new Error('no path returned');
    const list = leaf._chatAttachments || (leaf._chatAttachments = []);
    list.push({ path: data.path, name: blob.name || 'image.png', url: URL.createObjectURL(blob) });
    renderAttachments(leaf);
  } catch (e) {
    console.error('[chat-view] attach failed', e);
    cvToast(`이미지 첨부 실패: ${e.message}`, 'error');
  }
}

function renderAttachments(leaf) {
  const cv = leaf.querySelector('.chat-view');
  const attsEl = cv?.querySelector('.composer-attachments');
  if (!attsEl) return;
  const list = leaf._chatAttachments || [];
  if (!list.length) {
    attsEl.classList.remove('has-items');
    attsEl.innerHTML = '';
    return;
  }
  attsEl.classList.add('has-items');
  attsEl.innerHTML = list.map(a => (
    `<div class="att-item" data-path="${escapeHtml(a.path)}">
      <img src="${escapeHtml(a.url)}" alt="" />
      <div class="att-label">${escapeHtml(a.name)}</div>
      <button class="att-remove" title="제거">×</button>
    </div>`
  )).join('');
}

function sendComposer(leaf) {
  const cv = leaf.querySelector('.chat-view');
  const ta = cv?.querySelector('.composer-input');
  if (!ta) return;
  const text = ta.value;
  const atts = leaf._chatAttachments || [];
  if (!text.trim() && !atts.length) return;
  if (app.ws?.readyState !== 1) {
    console.warn('[chat-view] ws not ready');
    cvToast('연결 끊김 — 잠시 후 다시 시도', 'error');
    return;
  }
  const termId = leaf.dataset.termId;
  let data = text;
  if (atts.length) {
    // Claude 가 Read 도구로 자동 처리하도록 명시적 자연어 prefix
    const paths = atts.map(a => a.path).join('\n');
    if (data.trim()) {
      data = `${data}\n\n첨부 이미지:\n${paths}`;
    } else {
      data = `이 이미지 ${atts.length > 1 ? '들' : ''} 봐줘:\n${paths}`;
    }
  }
  data += '\r';
  app.ws.send(JSON.stringify({ type: 'input', termId, data }));
  // optimistic — 내 메시지 즉시 채팅에 표시 (jsonl 폴링 기다리지 말고)
  const sentText = text;
  const sentAtts = atts.slice();
  appendOptimisticUserMsg(leaf, sentText, sentAtts);
  ta.value = '';
  ta.style.height = 'auto';
  // attachment blob URL 은 optimistic 카드가 참조하니까 revoke 늦춤 (refresh 시 정리)
  leaf._optimisticUrls = [...(leaf._optimisticUrls || []), ...atts.map(a => a.url).filter(Boolean)];
  leaf._chatAttachments = [];
  renderAttachments(leaf);
  // 즉시 thinking 표시 (assistant 응답 도착 전까지)
  showThinking(leaf, true);
  boostPolling(leaf);
  focusComposer(leaf);
}

function appendOptimisticUserMsg(leaf, text, atts) {
  const cv = leaf.querySelector('.chat-view');
  const msgsEl = cv?.querySelector('.chat-messages');
  if (!msgsEl) return;
  // empty 상태 제거
  msgsEl.querySelector('.chat-empty')?.remove();
  const ts = fmtTime(new Date().toISOString());
  const imageHtml = atts.map(a => `<div class="msg-image"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" loading="lazy"/><div class="img-meta">${escapeHtml(a.name)}</div></div>`).join('');
  // 텍스트는 마크다운 안 거치고 단순 escape (라이브 입력이라)
  const textHtml = text.trim() ? `<div class="msg-text"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div>` : '';
  const html = (
    `<div class="msg msg-user msg-optimistic" data-optimistic="1" data-text="${escapeHtml(text.slice(0, 200))}">` +
      `<div class="msg-avatar">U</div>` +
      `<div class="msg-body">` +
        `<div class="msg-head">` +
          `<span class="msg-name">You</span>` +
          `<span class="msg-ts">${ts}</span>` +
          `<span class="msg-pending"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>` +
        `</div>` +
        `<div class="msg-content">${textHtml}${imageHtml}</div>` +
      `</div>` +
    `</div>`
  );
  // thinking 카드가 있으면 그 위에, 없으면 끝에
  const thinking = msgsEl.querySelector('.msg-thinking-card');
  if (thinking) thinking.insertAdjacentHTML('beforebegin', html);
  else msgsEl.insertAdjacentHTML('beforeend', html);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function showThinking(leaf, on) {
  const cv = leaf.querySelector('.chat-view');
  const msgsEl = cv?.querySelector('.chat-messages');
  if (!msgsEl) return;
  const existing = msgsEl.querySelector('.msg-thinking-card');
  if (on) {
    if (!existing) {
      msgsEl.insertAdjacentHTML('beforeend', thinkingHtml());
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    leaf._chatThinking = true;
  } else {
    if (existing) existing.remove();
    leaf._chatThinking = false;
  }
}

export function toggleChatView(leaf) {
  if (!leaf) return;
  const wasActive = leaf.classList.contains('chat-active');
  leaf.classList.toggle('chat-active');
  const termId = leaf.dataset.termId;
  if (!wasActive) {
    startPolling(leaf);
    focusComposer(leaf);
  }
  else stopPolling(termId);
  // 토글 버튼 텍스트 즉시 갱신 (폴링 캐시 우회)
  const tgl = leaf.querySelector('.th-chat-toggle');
  if (tgl) tgl.textContent = leaf.classList.contains('chat-active') ? '셸' : '채팅';
}

function focusComposer(leaf) {
  // 다음 프레임에 focus (display:flex 적용 후)
  requestAnimationFrame(() => {
    const ta = leaf?.querySelector('.composer-input');
    if (ta && document.activeElement !== ta) ta.focus();
  });
}

// 외부에서 호출 가능하게 export
export function focusChatComposer(leaf) { focusComposer(leaf); }

export function updateChatProjectPath(leaf, projectPath) {
  if (!leaf || !projectPath) return;
  leaf.dataset.projectPath = projectPath;
  if (leaf.classList.contains('chat-active')) refreshChat(leaf);
}

function copyToClipboard(text) {
  return copyText(text);
}

function flashButton(btn, label = '✓') {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add('flashed');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('flashed'); }, 900);
}

function decodeB64(b64) {
  if (!b64) return '';
  try { return decodeURIComponent(escape(atob(b64))); } catch { return ''; }
}

async function downloadSessionMarkdown(leaf) {
  const projectPath = leaf.dataset.projectPath;
  if (!projectPath) return;
  try {
    const data = await fetchSession(projectPath);
    const lines = [`# Claude session — ${data.session || ''}`, '', `Project: ${projectPath}`, ''];
    for (const m of data.messages || []) {
      const ts = m.ts ? new Date(m.ts).toISOString() : '';
      lines.push(`## ${m.role === 'user' ? 'You' : 'Claude'} ${ts ? `(${ts})` : ''}`);
      for (const p of m.parts) {
        if (p.kind === 'text') lines.push(p.text || '');
        else if (p.kind === 'thinking') lines.push(`> _thinking:_ ${(p.text || '').replace(/\n/g, '\n> ')}`);
        else if (p.kind === 'tool_use') lines.push(`\n**🛠 ${p.name}**\n\n\`\`\`json\n${JSON.stringify(p.input || {}, null, 2)}\n\`\`\``);
        else if (p.kind === 'tool_result') {
          const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
          lines.push(`\n_tool result:_\n\n\`\`\`\n${c}\n\`\`\``);
        }
        else if (p.kind === 'image') lines.push(`![image](${p.url || `data:${p.media_type};base64,…`})`);
      }
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claude-session-${(data.session || 'export').replace(/\.jsonl$/, '')}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    console.error('[chat-view] download failed', e);
  }
}

function updateScrollIndicator(leaf) {
  const cv = leaf.querySelector('.chat-view');
  const msgsEl = cv?.querySelector('.chat-messages');
  const btn = cv?.querySelector('.chat-scroll-bottom');
  if (!msgsEl || !btn) return;
  const atBottom = (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) < 60;
  btn.classList.toggle('show', !atBottom);
}

// 메시지 영역 스크롤 감지 — 위로 가면 ▼ 버튼 노출
document.addEventListener('scroll', (e) => {
  const ms = e.target?.classList?.contains?.('chat-messages') ? e.target : null;
  if (!ms) return;
  const leaf = ms.closest('.split-leaf');
  if (leaf) updateScrollIndicator(leaf);
}, true);

// Terminal 탭 클릭 또는 view 전환 → 활성 chat-view 의 composer focus
function focusActiveChatComposer() {
  // 활성(또는 첫번째) chat-active leaf 의 composer 에 focus
  const leaf = document.querySelector('.split-leaf.active.chat-active') ||
               document.querySelector('.split-leaf.chat-active');
  if (leaf) focusComposer(leaf);
}

document.addEventListener('click', async (e) => {
  const navTerm = e.target.closest('[data-view="terminal"]');
  if (navTerm) setTimeout(focusActiveChatComposer, 120);
});

// 키보드 단축키 — Terminal view 가 보이는 동안 Ctrl+1 등으로 돌아오면 focus
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '2') {
    setTimeout(focusActiveChatComposer, 120);
  }
});

// chat-view 안 빈 영역 클릭 (메시지/버튼/textarea 외) → composer focus
document.addEventListener('click', async (e) => {
  const cv = e.target.closest('.chat-view');
  if (!cv) return;
  // 인터랙티브 요소 클릭이면 패스
  if (e.target.closest('button, input, textarea, a, .msg-text, .att-item')) return;
  const leaf = cv.closest('.split-leaf');
  if (leaf?.classList.contains('chat-active')) focusComposer(leaf);
});

// ── Selection toolbar (드래그하면 떠서 복사/AI/Run 등 액션) ──
let _selToolbarEl = null;
function ensureSelToolbar() {
  if (_selToolbarEl) return _selToolbarEl;
  const el = document.createElement('div');
  el.className = 'cv-sel-toolbar';
  el.hidden = true;
  el.innerHTML = `
    <button data-cvsel="copy" title="복사 (Ctrl+C)">⧉ 복사</button>
    <button data-cvsel="ask" title="채팅 입력창에 채우기">✦ Ask AI</button>
    <button data-cvsel="quote" title="인용으로 채팅에 채우기">❝ 인용</button>
    <button data-cvsel="run" title="셸로 실행">▶ Run</button>
    <button data-cvsel="url" title="URL 열기" hidden>🔗 열기</button>
  `;
  document.body.appendChild(el);
  _selToolbarEl = el;
  return el;
}

function hideSelToolbar() {
  if (_selToolbarEl) _selToolbarEl.hidden = true;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/;

function showSelToolbar(cv, text, rect) {
  const el = ensureSelToolbar();
  el.dataset.text = text;
  el.dataset.cvLeaf = cv.closest('.split-leaf')?.dataset.termId || '';
  // URL 버튼 토글
  const url = text.match(URL_RE)?.[0];
  el.querySelector('[data-cvsel="url"]').hidden = !url;
  if (url) el.dataset.url = url;
  // 위치 — selection rect 위쪽
  el.hidden = false;
  const tbRect = el.getBoundingClientRect();
  let top = rect.top - tbRect.height - 8 + window.scrollY;
  let left = rect.left + rect.width / 2 - tbRect.width / 2 + window.scrollX;
  if (top < 8) top = rect.bottom + 8 + window.scrollY;
  left = Math.max(8, Math.min(left, window.innerWidth - tbRect.width - 8));
  el.style.top = top + 'px';
  el.style.left = left + 'px';
}

document.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideSelToolbar(); return; }
    const text = sel.toString().trim();
    if (!text) { hideSelToolbar(); return; }
    const range = sel.getRangeAt(0);
    const cv = range.startContainer.parentElement?.closest?.('.chat-view');
    if (!cv) { hideSelToolbar(); return; }
    // composer / toolbar 안의 selection 은 무시 (자기 텍스트)
    if (range.startContainer.parentElement?.closest('.chat-composer, .chat-toolbar, .chat-search-bar')) {
      hideSelToolbar(); return;
    }
    showSelToolbar(cv, text, range.getBoundingClientRect());
  }, 10);
});

document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.cv-sel-toolbar')) return; // toolbar 자체 클릭은 유지
  hideSelToolbar();
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.cv-sel-toolbar button[data-cvsel]');
  if (!btn) return;
  e.preventDefault();
  const action = btn.dataset.cvsel;
  const text = _selToolbarEl.dataset.text || '';
  const termId = _selToolbarEl.dataset.cvLeaf;
  const leaf = termId ? document.querySelector(`.split-leaf[data-term-id="${CSS.escape(termId)}"]`) : null;
  if (action === 'copy') {
    const ok = await copyToClipboard(text);
    if (ok) {
      flashButton(btn, '✓ 복사됨');
      setTimeout(hideSelToolbar, 600);
    } else cvToast('복사 실패', 'error');
    return;
  }
  if (action === 'ask') {
    const ta = leaf?.querySelector('.composer-input');
    if (ta) {
      ta.value = (ta.value.trim() ? ta.value + '\n\n' : '') + text;
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    hideSelToolbar();
    return;
  }
  if (action === 'quote') {
    const ta = leaf?.querySelector('.composer-input');
    if (ta) {
      const quoted = text.split('\n').map((l) => `> ${l}`).join('\n');
      ta.value = (ta.value.trim() ? ta.value + '\n\n' : '') + quoted + '\n\n';
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    hideSelToolbar();
    return;
  }
  if (action === 'run') {
    if (leaf && app.ws?.readyState === 1) {
      app.ws.send(JSON.stringify({ type: 'input', termId: leaf.dataset.termId, data: text + '\r' }));
    }
    hideSelToolbar();
    return;
  }
  if (action === 'url') {
    const url = _selToolbarEl.dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
    hideSelToolbar();
    return;
  }
});

// 이미지 lightbox
function openLightbox(src, label) {
  const existing = document.querySelector('.cv-lightbox');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'cv-lightbox';
  overlay.innerHTML = `
    <button class="cv-lightbox-close" aria-label="닫기">×</button>
    <img src="${src}" alt="${escapeHtml(label || '')}" />
    ${label ? `<div class="cv-lightbox-label">${escapeHtml(label)}</div>` : ''}
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  const close = () => {
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  overlay.addEventListener('click', (ev) => {
    if (ev.target.closest('img')) return; // 이미지 클릭은 닫지 않음
    close();
  });
  document.addEventListener('keydown', onKey);
}

document.addEventListener('click', async (e) => {
  // 채팅 메시지 안 이미지 / 첨부 미리보기 클릭 → lightbox
  const msgImg = e.target.closest('.chat-view .msg-image img, .chat-view .att-item img');
  if (msgImg) {
    e.preventDefault(); e.stopPropagation();
    const label = msgImg.closest('.msg-image')?.querySelector('.img-meta')?.textContent
               || msgImg.closest('.att-item')?.querySelector('.att-label')?.textContent
               || msgImg.alt;
    openLightbox(msgImg.src, label);
    return;
  }
  const tgl = e.target.closest('.th-chat-toggle, [data-action="chat-toggle"], [data-action="mob-chat-toggle"]');
  if (tgl) {
    e.preventDefault(); e.stopPropagation();
    // mobile 의 토글은 외부 버튼 — 활성 leaf 직접 찾음
    const leaf = tgl.closest('.split-leaf')
              || document.querySelector('.split-leaf.mobile-leaf')
              || document.querySelector('.split-leaf.active');
    if (leaf) toggleChatView(leaf);
    return;
  }
  const ref = e.target.closest('[data-action="chat-refresh"]');
  if (ref) {
    e.preventDefault(); e.stopPropagation();
    const leaf = ref.closest('.split-leaf');
    if (leaf) refreshChat(leaf);
    return;
  }
  // 코드 블록 복사
  const codeCopy = e.target.closest('[data-action="code-copy"]');
  if (codeCopy) {
    e.preventDefault(); e.stopPropagation();
    const block = codeCopy.closest('.code-block');
    const raw = decodeB64(block?.dataset.raw || '');
    if (raw) {
      const ok = await copyToClipboard(raw);
      if (ok) flashButton(codeCopy, '✓ 복사됨');
      else cvToast('복사 실패', 'error');
    }
    return;
  }
  // 코드 블록 펼치기/접기
  const codeToggle = e.target.closest('[data-action="code-toggle"]');
  if (codeToggle) {
    e.preventDefault(); e.stopPropagation();
    const block = codeToggle.closest('.code-block');
    if (block) {
      const collapsed = block.classList.toggle('collapsed');
      const label = codeToggle.querySelector('.toggle-label');
      const lines = block.dataset.lines || '';
      if (label) label.textContent = collapsed ? `${lines}줄 펼치기` : '접기';
    }
    return;
  }
  // 메시지 복사
  const msgCopy = e.target.closest('[data-action="msg-copy"]');
  if (msgCopy) {
    e.preventDefault(); e.stopPropagation();
    const msg = msgCopy.closest('.msg');
    const raw = decodeB64(msg?.dataset.raw || '');
    if (raw) {
      const ok = await copyToClipboard(raw);
      if (ok) flashButton(msgCopy, '✓');
      else cvToast('복사 실패', 'error');
    }
    return;
  }
  // 메시지 접기/펼치기
  const msgCollapse = e.target.closest('[data-action="msg-collapse"]');
  if (msgCollapse) {
    e.preventDefault(); e.stopPropagation();
    const msg = msgCollapse.closest('.msg');
    if (msg) {
      const isCollapsed = msg.classList.toggle('collapsed');
      msgCollapse.textContent = isCollapsed ? '펼치기' : '접기';
    }
    return;
  }
  // 세션 다운로드
  const dl = e.target.closest('[data-action="chat-download"]');
  if (dl) {
    e.preventDefault(); e.stopPropagation();
    const leaf = dl.closest('.split-leaf');
    if (leaf) downloadSessionMarkdown(leaf);
    return;
  }
  // 맨 아래로
  const sb = e.target.closest('[data-action="chat-scroll-bottom"]');
  if (sb) {
    e.preventDefault(); e.stopPropagation();
    const leaf = sb.closest('.split-leaf');
    const ms = leaf?.querySelector('.chat-messages');
    if (ms) ms.scrollTop = ms.scrollHeight;
    return;
  }
});

export function cleanupChatView(termId) {
  stopPolling(termId);
}

// ─── 검색 ───
function highlightSearch(leaf, query) {
  const cv = leaf.querySelector('.chat-view');
  const msgsEl = cv?.querySelector('.chat-messages');
  if (!msgsEl) return;
  // 이전 하이라이트 제거
  msgsEl.querySelectorAll('mark.cv-mark').forEach((m) => {
    const t = document.createTextNode(m.textContent);
    m.replaceWith(t);
  });
  if (!query) {
    cv.querySelector('.chat-search-count').textContent = '0/0';
    return;
  }
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let count = 0;
  const walk = (node) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue;
      if (!re.test(text)) { re.lastIndex = 0; return; }
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      text.replace(re, (m, off) => {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, off)));
        const mark = document.createElement('mark');
        mark.className = 'cv-mark';
        mark.textContent = m;
        frag.appendChild(mark);
        count++;
        lastIdx = off + m.length;
        return m;
      });
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode?.replaceChild(frag, node);
    } else if (node.nodeType === 1 && !['SCRIPT','STYLE','MARK','INPUT','TEXTAREA','BUTTON'].includes(node.tagName)) {
      [...node.childNodes].forEach(walk);
    }
  };
  walk(msgsEl);
  const countEl = cv.querySelector('.chat-search-count');
  if (countEl) countEl.textContent = count ? `1/${count}` : '0/0';
  // 첫 매치 스크롤
  const first = msgsEl.querySelector('mark.cv-mark');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function navigateSearch(leaf, dir) {
  const cv = leaf.querySelector('.chat-view');
  const marks = [...cv.querySelectorAll('mark.cv-mark')];
  if (!marks.length) return;
  let idx = marks.findIndex((m) => m.classList.contains('cv-mark-active'));
  marks.forEach((m) => m.classList.remove('cv-mark-active'));
  idx = dir === 'next' ? (idx + 1) % marks.length : (idx - 1 + marks.length) % marks.length;
  if (idx < 0) idx = 0;
  marks[idx].classList.add('cv-mark-active');
  marks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const countEl = cv.querySelector('.chat-search-count');
  if (countEl) countEl.textContent = `${idx + 1}/${marks.length}`;
}

// ─── 세션 드롭다운 ───
async function openSessionDropdown(leaf) {
  const cv = leaf.querySelector('.chat-view');
  const dd = cv?.querySelector('.chat-sessions-dropdown');
  if (!dd) return;
  if (!dd.hidden) { dd.hidden = true; return; }
  dd.innerHTML = '<div class="cv-loading">로딩…</div>';
  dd.hidden = false;
  try {
    const data = await fetchSessionList(leaf.dataset.projectPath);
    const list = data.sessions || [];
    if (!list.length) { dd.innerHTML = '<div class="cv-empty">세션 없음</div>'; return; }
    const currentId = leaf.dataset.sessionId || (list[0]?.id || '');
    dd.innerHTML = list.map((s) => {
      const isCur = s.id === currentId;
      const date = new Date(s.mtime);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      return `<button class="session-item${isCur ? ' current' : ''}" data-action="session-pick" data-sid="${escapeHtml(s.id)}">
        <span class="session-date">${dateStr}</span>
        <span class="session-title">${escapeHtml(s.title || s.id.slice(0, 8))}</span>
      </button>`;
    }).join('');
  } catch (e) { dd.innerHTML = '<div class="cv-empty">에러</div>'; }
}

// ─── Slash command autocomplete ───
const SLASH_COMMANDS = [
  { cmd: '/help', desc: '도움말' },
  { cmd: '/clear', desc: '컨텍스트 초기화' },
  { cmd: '/compact', desc: '대화 압축' },
  { cmd: '/model', desc: '모델 변경' },
  { cmd: '/init', desc: 'CLAUDE.md 생성' },
  { cmd: '/agents', desc: '서브에이전트 목록' },
  { cmd: '/config', desc: '설정' },
  { cmd: '/memory', desc: '메모리 관리' },
  { cmd: '/mcp', desc: 'MCP 서버' },
  { cmd: '/pr-comments', desc: 'PR 코멘트' },
  { cmd: '/vim', desc: 'Vim 모드' },
  { cmd: '/cost', desc: '토큰/비용' },
  { cmd: '/login', desc: '로그인' },
  { cmd: '/logout', desc: '로그아웃' },
];
function showSlashMenu(leaf, query) {
  const cv = leaf.querySelector('.chat-view');
  let menu = cv?.querySelector('.composer-slash');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'composer-slash';
    cv.querySelector('.chat-composer').prepend(menu);
  }
  const filtered = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(query));
  if (!filtered.length) { hideSlashMenu(leaf); return; }
  menu.innerHTML = filtered.map((c, i) => (
    `<button class="slash-item${i === 0 ? ' active' : ''}" data-action="slash-pick" data-cmd="${escapeHtml(c.cmd)}"><span class="slash-cmd">${escapeHtml(c.cmd)}</span><span class="slash-desc">${escapeHtml(c.desc)}</span></button>`
  )).join('');
  menu.hidden = false;
}
function hideSlashMenu(leaf) {
  const menu = leaf.querySelector('.composer-slash');
  if (menu) menu.hidden = true;
}

// composer 의 input — slash 토큰 (공백 없는) 일 때만 메뉴 표시
document.addEventListener('input', (e) => {
  const ta = e.target.closest('.composer-input');
  if (!ta) return;
  const leaf = ta.closest('.split-leaf');
  if (!leaf) return;
  const v = ta.value;
  // `/` 로 시작하고 첫 단어에 공백 없을 때만 (즉 명령 입력 중)
  const firstLine = v.split('\n')[0];
  const firstToken = firstLine.split(/\s/)[0];
  if (firstToken.startsWith('/') && firstToken.length === firstLine.length) {
    showSlashMenu(leaf, firstToken);
  } else {
    hideSlashMenu(leaf);
  }
});

// 글로벌 클릭 핸들러 확장: 검색/세션/slash
document.addEventListener('click', (e) => {
  const cv = e.target.closest('.chat-view');
  const leafTop = e.target.closest('.split-leaf');

  // 검색 토글
  const searchBtn = e.target.closest('[data-action="chat-search"]');
  if (searchBtn && cv) {
    e.preventDefault(); e.stopPropagation();
    const bar = cv.querySelector('.chat-search-bar');
    if (bar) {
      bar.hidden = !bar.hidden;
      if (!bar.hidden) bar.querySelector('.chat-search-input')?.focus();
      else { highlightSearch(leafTop, ''); }
    }
    return;
  }
  // 검색 prev/next/close
  if (e.target.closest('[data-action="search-prev"]')) { navigateSearch(leafTop, 'prev'); return; }
  if (e.target.closest('[data-action="search-next"]')) { navigateSearch(leafTop, 'next'); return; }
  if (e.target.closest('[data-action="search-close"]')) {
    const bar = cv?.querySelector('.chat-search-bar');
    if (bar) { bar.hidden = true; highlightSearch(leafTop, ''); }
    return;
  }
  // 세션 드롭다운
  const sBtn = e.target.closest('[data-action="chat-sessions"]');
  if (sBtn && leafTop) { e.preventDefault(); e.stopPropagation(); openSessionDropdown(leafTop); return; }
  const sPick = e.target.closest('[data-action="session-pick"]');
  if (sPick && leafTop) {
    e.preventDefault(); e.stopPropagation();
    leafTop.dataset.sessionId = sPick.dataset.sid;
    cv.querySelector('.chat-sessions-dropdown').hidden = true;
    const poller = ACTIVE_POLLERS.get(leafTop.dataset.termId);
    if (poller) poller.lastSig = '';
    refreshChat(leafTop);
    return;
  }
  // slash 선택
  const slashPick = e.target.closest('[data-action="slash-pick"]');
  if (slashPick && leafTop) {
    e.preventDefault(); e.stopPropagation();
    const ta = leafTop.querySelector('.composer-input');
    if (ta) { ta.value = slashPick.dataset.cmd + ' '; ta.focus(); }
    hideSlashMenu(leafTop);
    return;
  }
  // dropdown 외부 클릭 시 닫기
  if (!e.target.closest('.chat-sessions-dropdown, [data-action="chat-sessions"]')) {
    document.querySelectorAll('.chat-sessions-dropdown').forEach((d) => d.hidden = true);
  }
  if (!e.target.closest('.composer-slash, .composer-input')) {
    document.querySelectorAll('.composer-slash').forEach((m) => m.hidden = true);
  }
});

// 검색 입력 핸들러
document.addEventListener('input', (e) => {
  const inp = e.target.closest('.chat-search-input');
  if (!inp) return;
  const leaf = inp.closest('.split-leaf');
  if (leaf) highlightSearch(leaf, inp.value);
});

// 검색 Enter = next, Esc = close
document.addEventListener('keydown', (e) => {
  const inp = e.target.closest('.chat-search-input');
  if (!inp) return;
  if (e.key === 'Enter') { e.preventDefault(); navigateSearch(inp.closest('.split-leaf'), e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') {
    const bar = inp.closest('.chat-search-bar');
    if (bar) { bar.hidden = true; highlightSearch(inp.closest('.split-leaf'), ''); inp.closest('.chat-view').querySelector('.composer-input')?.focus(); }
  }
});

// Ctrl+F — 검색 토글 (활성 chat-view 안에서)
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    const cv = document.querySelector('.split-leaf.chat-active .chat-view');
    if (cv && cv.offsetParent) {
      e.preventDefault();
      const bar = cv.querySelector('.chat-search-bar');
      if (bar) { bar.hidden = false; bar.querySelector('.chat-search-input')?.focus(); }
    }
  }
});

// 전역 paste — chat-active leaf 가 보이면 어디서든 Ctrl+V 로 이미지 첨부
window.addEventListener('paste', (e) => {
  const cv = document.querySelector('.split-leaf.active.chat-active .chat-view')
          || document.querySelector('.split-leaf.chat-active .chat-view');
  if (!cv || !cv.offsetParent) return;
  const items = [...(e.clipboardData?.items || [])];
  const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
  if (!imageItems.length) return;
  // 이미 wireComposer 에서 처리됐으면 (textarea focus 시) pass — preventDefault 됐으니까 여기 안 옴
  // 여기로 온 건 chat-view 안 아닌 곳에 focus 있던 경우
  e.preventDefault();
  e.stopPropagation();
  const leaf = cv.closest('.split-leaf');
  const blobs = imageItems.map((it) => it.getAsFile()).filter(Boolean);
  if (!blobs.length) return;
  cvToast(`이미지 ${blobs.length}개 첨부 중…`, 'info');
  Promise.all(blobs.map((b) => attachImage(leaf, b))).then(() => {
    cvToast(`이미지 ${blobs.length}개 첨부됨`, 'info');
    focusComposer(leaf);
  });
});
