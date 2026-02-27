// ─── Agent Module v3: 9-Tool Agentic UI with Multi-Tool support ───
import { app } from './state.js';
import { esc, showToast } from './utils.js';

const TOOL_ICONS = {
  BASH: '⚡', READ: '📄', SEARCH: '🔍',
  EDIT: '✏️', WRITE: '📝', GLOB: '📂', GIT_DIFF: '📊',
  GIT_LOG: '📜', JIRA: '🎫', CICD: '🔄', OPEN: '🌐',
};

let _convId = null;
let _recognition = null;
let _listening = false;
let _ttsEnabled = true;
let _running = false; // agent loop is running
let _convList = []; // conversation history
let _sidebarOpen = false;
let _ttsVolume = parseFloat(localStorage.getItem('ag-tts-volume') || '0.8');
let _ttsRate = parseFloat(localStorage.getItem('ag-tts-rate') || '1.5');
let _ttsPitch = parseFloat(localStorage.getItem('ag-tts-pitch') || '1.05');

// ─── Wake Word ───
let _wakeWordMode = localStorage.getItem('ag-wake-word') === 'true';
let _wakeRecognition = null;
let _awaitingCommand = false;
let _wakeTimeout = null;
const WAKE_WORDS = [
  '웰시콕이', '웰시 콕이', '헤이 웰시콕이', '헤이 웰시 콕이', '헤이웰시콕이',
  '웰시코기', '웰시 코기', '헤이 웰시코기', '헤이 웰시 코기', '헤이웰시코기',
  '월시코기', '헤이 월시코기', '웰시꼭이', '헤이 웰시꼭이',
];

// ─── Init ───
export function initAgent() {
  if (app._agentInit) return;
  app._agentInit = true;
  loadOrCreateConversation();
  loadModelSetting();
}

// Boot wake word independently of panel — called from main.js on page load
export function initWakeWord() {
  console.log(`[WAKE] initWakeWord called, mode=${_wakeWordMode}`);
  if (_wakeWordMode) {
    setTimeout(() => { startWakeWordListening(); updateWakeWordUI(); }, 1000);
  }
}

// ─── Floating Panel Toggle ───
let _panelOpen = false;
export function toggleAgentPanel() {
  const panel = document.getElementById('agent-panel');
  const fab = document.getElementById('agent-fab');
  if (!panel) return;
  _panelOpen = !_panelOpen;
  panel.classList.toggle('open', _panelOpen);
  fab?.classList.toggle('active', _panelOpen);
  if (_panelOpen) {
    initAgent();
    // Hide badge when opened
    const badge = document.getElementById('agent-fab-badge');
    if (badge) badge.style.display = 'none';
    // Focus input
    setTimeout(() => document.getElementById('agent-input')?.focus(), 150);
  }
}

export function isAgentPanelOpen() { return _panelOpen; }

// Show badge on FAB when agent has new activity while panel is closed
export function showAgentFabBadge() {
  if (_panelOpen) return;
  const badge = document.getElementById('agent-fab-badge');
  if (badge) badge.style.display = '';
}

// ─── Model Selection ───
async function loadModelSetting() {
  try {
    const res = await fetch('/api/agent/model');
    const data = await res.json();
    const sel = document.getElementById('agent-model-select');
    if (sel && data.model) sel.value = data.model;
  } catch {}
}

export async function changeAgentModel(model) {
  try {
    await fetch('/api/agent/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    showToast(`모델 변경: ${model}`, 'success');
  } catch (err) {
    showToast('모델 변경 실패: ' + err.message, 'error');
  }
}

// ─── Conversation History Sidebar ───
export function toggleAgentSidebar() {
  _sidebarOpen = !_sidebarOpen;
  const sidebar = document.getElementById('agent-sidebar');
  if (sidebar) sidebar.classList.toggle('open', _sidebarOpen);
  if (_sidebarOpen) loadConversationList();
}

async function loadConversationList() {
  try {
    const res = await fetch('/api/agent/conversations');
    _convList = await res.json();
    renderConversationList();
  } catch {}
}

function renderConversationList() {
  const el = document.getElementById('agent-conv-list');
  if (!el) return;
  if (!_convList.length) {
    el.innerHTML = '<div class="ag-conv-empty">대화가 없어영</div>';
    return;
  }
  el.innerHTML = _convList.map(c => {
    const active = c.id === _convId ? ' ag-conv-active' : '';
    const date = new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const preview = esc(c.lastMessage || '(빈 대화)');
    return `<div class="ag-conv-item${active}" data-id="${esc(c.id)}" data-action="switch-conv" data-convid="${esc(c.id)}">
      <div class="ag-conv-preview">${preview}</div>
      <div class="ag-conv-meta"><span>${date}</span><span>${c.messageCount}개</span></div>
      <button class="ag-conv-delete" data-action="delete-conv" data-convid="${esc(c.id)}" title="삭제">&times;</button>
    </div>`;
  }).join('');
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const el2 = e.target.closest('[data-action]');
      if (!el2) return;
      if (el2.dataset.action === 'delete-conv') { e.stopPropagation(); deleteAgentConversation(el2.dataset.convid); }
      else if (el2.dataset.action === 'switch-conv') switchAgentConversation(el2.dataset.convid);
    });
  }
}

export async function switchAgentConversation(id) {
  if (id === _convId) return;
  if (_running) await stopAgentLoop();
  _convId = id;
  _running = false;
  updateActionButton();
  await loadMessages();
  renderChat();
  renderConversationList();
}

export async function deleteAgentConversation(id) {
  try {
    await fetch(`/api/agent/conversations/${id}`, { method: 'DELETE' });
    if (id === _convId) {
      _convId = null;
      app._agentMessages = [];
      await loadOrCreateConversation();
    }
    loadConversationList();
  } catch {}
}

async function loadOrCreateConversation() {
  try {
    const res = await fetch('/api/agent/conversations');
    const convs = await res.json();
    if (convs.length) {
      _convId = convs[0].id;
      await loadMessages();
    } else {
      const r = await fetch('/api/agent/conversations', { method: 'POST' });
      const data = await r.json();
      _convId = data.id;
    }
  } catch { /* ignore */ }
  renderChat();
}

async function loadMessages() {
  if (!_convId) return;
  try {
    const res = await fetch(`/api/agent/conversations/${_convId}`);
    const conv = await res.json();
    app._agentMessages = conv.messages || [];
  } catch { app._agentMessages = []; }
}

// ─── Render: full chat from stored messages ───
function renderChat() {
  const chatArea = document.getElementById('agent-chat');
  if (!chatArea) return;

  // Delegation on chat area for templates + tool cards
  if (!chatArea.dataset.delegated) {
    chatArea.dataset.delegated = '1';
    chatArea.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (el && el.dataset.action === 'toggle-tool-card') { el.parentElement.classList.toggle('expanded'); return; }
      const tpl = e.target.closest('.ag-tpl-btn');
      if (tpl) {
        const input = document.getElementById('agent-input');
        if (input) { input.value = tpl.dataset.prompt; input.focus(); }
      }
    });
  }

  const msgs = app._agentMessages || [];
  if (!msgs.length && !_running) {
    chatArea.innerHTML = `<div class="ag-welcome">
      <div class="ag-welcome-head">
        <span class="ag-welcome-icon">🐶</span>
        <div>
          <div class="ag-welcome-title">웰시콕이에여!</div>
          <div class="ag-welcome-desc">이런 거 할 수 있어영~</div>
        </div>
      </div>
      <div class="ag-caps">
        <div class="ag-cap-group">
          <div class="ag-cap-label">코드</div>
          <button class="ag-tpl-btn" data-prompt="이 프로젝트 구조를 분석해줘. 폴더 구조, 주요 파일, 기술 스택 정리해줘.">프로젝트 분석</button>
          <button class="ag-tpl-btn" data-prompt="src 폴더에서 TODO, FIXME, HACK 주석 모두 찾아서 정리해줘.">TODO 수집</button>
          <button class="ag-tpl-btn" data-prompt="package.json 보여줘">파일 읽기</button>
        </div>
        <div class="ag-cap-group">
          <div class="ag-cap-label">Git</div>
          <button class="ag-tpl-btn" data-prompt="git diff로 현재 변경 사항을 확인하고 요약해줘.">변경 사항</button>
          <button class="ag-tpl-btn" data-prompt="git log 최근 10개 보고 요약해줘.">커밋 히스토리</button>
        </div>
        <div class="ag-cap-group">
          <div class="ag-cap-label">Jira</div>
          <button class="ag-tpl-btn" data-prompt="내 Jira 이슈 목록 확인해줘. 진행 중인 것 위주로 정리해줘.">내 이슈</button>
          <button class="ag-tpl-btn" data-prompt="이번 스프린트 진행 상황 요약해줘.">스프린트 현황</button>
        </div>
        <div class="ag-cap-group">
          <div class="ag-cap-label">대시보드</div>
          <button class="ag-tpl-btn" data-prompt="오늘 API 비용 얼마 썼는지 확인해줘.">비용 확인</button>
          <button class="ag-tpl-btn" data-prompt="현재 시스템 상태 확인해줘. CPU, 메모리, 디스크.">시스템 상태</button>
          <button class="ag-tpl-btn" data-prompt="CI/CD 파이프라인 상태 확인해줘.">CI/CD</button>
        </div>
        <div class="ag-cap-group">
          <div class="ag-cap-label">기타</div>
          <button class="ag-tpl-btn" data-prompt="유튜브에서 로파이 음악 틀어줘">유튜브</button>
          <button class="ag-tpl-btn" data-prompt="서울 날씨 어때?">날씨</button>
          <button class="ag-tpl-btn" data-prompt="hello를 한국어로 번역해줘">번역/질문</button>
        </div>
      </div>
    </div>`;
    return;
  }

  chatArea.innerHTML = msgs.map(m => {
    const isUser = m.role === 'user';
    const time = m.ts ? new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="ag-msg ${isUser ? 'ag-msg-user' : 'ag-msg-ai'}">
      <div class="ag-msg-bubble">${formatMessage(m.content)}</div>
      <div class="ag-msg-time">${time}</div>
    </div>`;
  }).join('');

  scrollToBottom();
}

let _copyIdCounter = 0;

function formatMessage(text) {
  if (!text) return '';
  let html = esc(text);

  // ─── 1. Code blocks → placeholder (preserve from further formatting) ───
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = `ag-cp-${++_copyIdCounter}`;
    const langLabel = lang ? `<span class="ag-code-lang">${lang}</span>` : '';
    codeBlocks.push(
      `<div class="ag-code-wrap">${langLabel}<button class="ag-code-copy" data-copy-id="${id}" title="복사">Copy</button><pre class="ag-code" id="${id}">${code.replace(/^\n|\n$/g, '')}</pre></div>`
    );
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // ─── 2. Tables → placeholder (before line processing) ───
  const tables = [];
  // Match markdown tables: header | sep | rows
  html = html.replace(/((?:^|\n)\|[^\n]+\|\s*\n\|[\s:|-]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    const parseRow = (row) => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headers = parseRow(rows[0]);
    // rows[1] is separator, skip
    const dataRows = rows.slice(2).map(parseRow);

    let t = '<div class="ag-table-wrap"><table class="ag-table"><thead><tr>';
    headers.forEach(h => { t += `<th>${h}</th>`; });
    t += '</tr></thead><tbody>';
    dataRows.forEach(row => {
      t += '<tr>';
      row.forEach(cell => { t += `<td>${cell}</td>`; });
      t += '</tr>';
    });
    t += '</tbody></table></div>';
    tables.push(t);
    return `\x00TB${tables.length - 1}\x00`;
  });

  // ─── 3. Inline formatting ───
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ─── 4. Line-level: headers, lists, hr ───
  const lines = html.split('\n');
  html = lines.map(line => {
    const trimmed = line.trim();
    if (/^-{3,}$/.test(trimmed)) return '<hr class="ag-hr">';
    if (/^####\s/.test(trimmed)) return `<div class="ag-h4">${trimmed.slice(5)}</div>`;
    if (/^###\s/.test(trimmed)) return `<div class="ag-h3">${trimmed.slice(4)}</div>`;
    if (/^##\s/.test(trimmed)) return `<div class="ag-h2">${trimmed.slice(3)}</div>`;
    if (/^#\s/.test(trimmed)) return `<div class="ag-h1">${trimmed.slice(2)}</div>`;
    if (/^[-•]\s/.test(trimmed)) return `<div class="ag-li"><span class="ag-li-dot"></span>${trimmed.replace(/^[-•]\s+/, '')}</div>`;
    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
    if (numMatch) return `<div class="ag-li"><span class="ag-li-num">${numMatch[1]}.</span>${numMatch[2]}</div>`;
    return line;
  }).join('<br>');

  // Clean up <br> after block elements
  html = html.replace(/(<\/div>)<br>/g, '$1');
  html = html.replace(/(<hr[^>]*>)<br>/g, '$1');

  // ─── 5. Status badges ───
  html = html.replace(/\[([^\]\n]{1,20})\]/g, (full, s) => {
    const low = s.toLowerCase();
    let cls = 'ag-badge';
    if (/완료|done|closed|resolved|merge/i.test(low)) cls += ' ag-badge-done';
    else if (/진행|progress|active|running|doing|in.?progress/i.test(low)) cls += ' ag-badge-progress';
    else if (/대기|예정|todo|open|new|backlog|ready|to.?do/i.test(low)) cls += ' ag-badge-pending';
    else if (/실패|fail|error|block|reject|bug|critical/i.test(low)) cls += ' ag-badge-fail';
    else if (/검토|review|testing|qa|code.?review/i.test(low)) cls += ' ag-badge-review';
    else if (/높음|high|urgent|긴급/i.test(low)) cls += ' ag-badge-fail';
    else if (/보통|medium|normal|중간/i.test(low)) cls += ' ag-badge-progress';
    else if (/낮음|low|minor/i.test(low)) cls += ' ag-badge-done';
    else return full;
    return `<span class="${cls}">${s}</span>`;
  });

  // ─── 6. Issue keys & mentions ───
  html = html.replace(/\b([A-Z]{2,10}-\d+)\b/g, '<span class="ag-issue-key">$1</span>');
  html = html.replace(/@(\S+)/g, '<span class="ag-mention">@$1</span>');

  // ─── 7. Restore placeholders ───
  html = html.replace(/\x00TB(\d+)\x00/g, (_, i) => tables[+i]);
  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[+i]);

  // ─── 8. YouTube embeds ───
  html = html.replace(/@@EMBED:youtube:(https?:\/\/[^@]+)@@/g, (_, url) => {
    return `<div class="ag-youtube-wrap"><iframe class="ag-youtube" src="${url}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  });

  return html;
}

// ─── Code copy button handler (delegated) ───
document.addEventListener('click', e => {
  const btn = e.target.closest('.ag-code-copy');
  if (!btn) return;
  const id = btn.dataset.copyId;
  const pre = document.getElementById(id);
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});

function scrollToBottom() {
  const chatArea = document.getElementById('agent-chat');
  if (chatArea) requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
}

// ─── Send Message (fire-and-forget, results via SSE) ───
export async function sendAgentMessage() {
  if (_running) return;
  const input = document.getElementById('agent-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';

  // Add user message immediately
  if (!app._agentMessages) app._agentMessages = [];
  app._agentMessages.push({ role: 'user', content: text, ts: Date.now() });
  renderChat();

  // Fire-and-forget POST — results come via SSE
  try {
    const res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: _convId, message: text })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // status: 'started' — loop is running, SSE will deliver updates
  } catch (err) {
    app._agentMessages.push({ role: 'assistant', content: `앗 에러가 났어영.. ${err.message}`, ts: Date.now() });
    renderChat();
  }
}

// ─── Stop Agent ───
export async function stopAgentLoop() {
  if (!_running || !_convId) return;
  try {
    await fetch('/api/agent/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: _convId })
    });
  } catch { /* ignore */ }
}

// ─── SSE Event Handler (the real rendering engine) ───
export function handleAgentEvent(eventName, data) {
  const chatArea = document.getElementById('agent-chat');
  if (!chatArea) return;

  switch (eventName) {
    case 'agent:start': {
      _running = true;
      updateActionButton();
      // Reset streaming TTS state for new response
      resetStreamTTS();
      _ttsQueue.length = 0;
      _ttsPlaying = false;
      // Create live bubble container
      ensureLiveBubble(chatArea);
      updateLiveStatus('생각 중이에여...', 0, data.maxIterations || 10);
      break;
    }

    case 'agent:thinking': {
      updateLiveStatus(`생각 중이에여... (${data.iteration || '?'}/${data.maxIterations || 10})`, data.iteration, data.maxIterations || 10);
      break;
    }

    case 'agent:thinking-text': {
      // Display the model's thinking (CoT) in a collapsible section
      if (data.thinking) {
        appendThinkingBlock(data.iteration, data.thinking);
      }
      break;
    }

    case 'agent:streaming': {
      // Real-time streaming text from Claude — shows as it's generated
      const liveContent = document.querySelector('.ag-msg-live .ag-live-content');
      if (!liveContent) break;

      if (data.streamType === 'thinking') {
        // Stream thinking into a live thinking block
        let thinkEl = liveContent.querySelector('.ag-stream-thinking');
        if (!thinkEl) {
          const details = document.createElement('details');
          details.className = 'ag-thinking-block ag-stream-thinking';
          details.open = false;
          details.innerHTML = `<summary>🧠 사고 중...</summary><pre class="ag-thinking-pre"></pre>`;
          liveContent.appendChild(details);
          thinkEl = details;
        }
        const pre = thinkEl.querySelector('.ag-thinking-pre');
        if (pre) pre.textContent += data.delta;
      } else {
        // Stream response text — try to extract "message" field from JSON
        let streamEl = liveContent.querySelector('.ag-stream-text');
        if (!streamEl) {
          streamEl = document.createElement('div');
          streamEl.className = 'ag-live-step ag-stream-text';
          streamEl._prevTTSLen = 0;
          liveContent.appendChild(streamEl);
        }
        streamEl._rawText = (streamEl._rawText || '') + data.delta;
        // Try to parse JSON and extract message field for display
        let displayText = streamEl._rawText;
        let extractedMsg = '';
        try {
          let cleaned = displayText.trim();
          if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
          else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
          if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
          const parsed = JSON.parse(cleaned.trim());
          if (parsed.message) { displayText = parsed.message; extractedMsg = parsed.message; }
        } catch {
          // JSON incomplete — use regex to extract partial "message" value
          const m = displayText.match(/"message"\s*:\s*"((?:[^"\\]|\\[\s\S])*)(?:"|$)/);
          if (m) {
            try { extractedMsg = JSON.parse('"' + m[1] + '"'); } catch { extractedMsg = m[1]; }
            displayText = extractedMsg;
          }
        }
        streamEl.innerHTML = formatMessage(displayText);
        updateLiveStatus('응답 수신 중...', data.iteration, 0);
        // Feed streaming TTS — only feed the NEW portion of extracted message
        if (extractedMsg && extractedMsg.length > (streamEl._prevTTSLen || 0)) {
          const newPart = extractedMsg.slice(streamEl._prevTTSLen || 0);
          streamEl._prevTTSLen = extractedMsg.length;
          feedStreamTTS(newPart);
        }
      }
      scrollToBottom();
      break;
    }

    case 'agent:step': {
      if (data.text) {
        // Clear streaming element — final text replaces it
        const liveContent = document.querySelector('.ag-msg-live .ag-live-content');
        if (liveContent) {
          const streamEl = liveContent.querySelector('.ag-stream-text');
          if (streamEl) streamEl.remove();
          const streamThink = liveContent.querySelector('.ag-stream-thinking');
          if (streamThink) streamThink.remove();
        }
        appendLiveText(data.text);
      }
      if (!data.hasTool) {
        // Final step — no more tools
        updateLiveStatus('', 0, 0);
      }
      scrollToBottom();
      break;
    }

    case 'agent:tool': {
      appendToolCard(chatArea, data.iteration, data.tool, data.arg, null, data.toolIndex);
      scrollToBottom();
      break;
    }

    case 'agent:tool-result': {
      fillToolCardResult(data.iteration, data.tool, data.result, data.toolIndex);
      scrollToBottom();
      break;
    }

    case 'agent:edit-backup': {
      // Show a subtle backup notification in tools area
      const toolsEl = document.querySelector('.ag-msg-live .ag-live-tools');
      if (toolsEl) {
        const notice = document.createElement('div');
        notice.className = 'ag-edit-backup-notice';
        notice.textContent = `💾 백업 생성: ${data.file}`;
        toolsEl.appendChild(notice);
      }
      break;
    }

    case 'agent:response': {
      // Final response — finalize live bubble
      finalizeLiveBubble(data.content);
      // Flush remaining streaming TTS buffer, then skip full speak if already streamed
      flushStreamTTS();
      if (_ttsEnabled && data.content && !_streamTTSUsed) speak(data.content);
      showAgentFabBadge(); // notify if panel is closed
      break;
    }

    case 'agent:done': {
      _running = false;
      updateActionButton();
      removeLiveStatus();
      // Reload messages from server to sync state
      loadMessages().then(() => renderChat());
      // Safety net: ensure wake word resumes after agent loop ends
      ensureWakeWordRunning();
      break;
    }

    case 'agent:warning': {
      // Show warning toast (e.g. message truncation)
      const chatArea2 = document.getElementById('agent-chat');
      if (chatArea2 && data.message) {
        const toast = document.createElement('div');
        toast.className = 'ag-warning-toast';
        toast.textContent = data.message;
        chatArea2.style.position = 'relative';
        chatArea2.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
      }
      break;
    }

    case 'agent:error': {
      _running = false;
      updateActionButton();
      // Add red error styling to live bubble before removing status
      const liveBubbleErr = document.querySelector('.ag-msg-live');
      if (liveBubbleErr) liveBubbleErr.classList.add('ag-error');
      removeLiveStatus();
      ensureWakeWordRunning();
      // Add error to local messages so it persists through renderChat()
      if (!app._agentMessages) app._agentMessages = [];
      app._agentMessages.push({ role: 'assistant', content: `앗 에러가 났어영.. ${data.error || ''}`, ts: Date.now() });
      renderChat();
      scrollToBottom();
      break;
    }
  }
}

// ─── Live Bubble Management ───
function ensureLiveBubble(chatArea) {
  // Remove existing live bubble if any
  const existing = chatArea.querySelector('.ag-msg-live');
  if (existing) existing.remove();

  const liveBubble = document.createElement('div');
  liveBubble.className = 'ag-msg ag-msg-ai ag-msg-live';
  liveBubble.innerHTML = `
    <div class="ag-live-status">
      <div class="ag-live-dots"><span></span><span></span><span></span></div>
      <span class="ag-live-label">생각 중이에여...</span>
      <div class="ag-live-progress"><div class="ag-live-progress-bar"></div></div>
    </div>
    <div class="ag-live-content"></div>
    <div class="ag-live-tools"></div>
  `;
  chatArea.appendChild(liveBubble);
  scrollToBottom();
}

function updateLiveStatus(label, iteration, maxIterations) {
  const statusEl = document.querySelector('.ag-msg-live .ag-live-label');
  if (statusEl && label) statusEl.textContent = label;

  const bar = document.querySelector('.ag-msg-live .ag-live-progress-bar');
  if (bar && maxIterations > 0) {
    bar.style.width = `${Math.round((iteration / maxIterations) * 100)}%`;
  }
}

function removeLiveStatus() {
  const statusEl = document.querySelector('.ag-msg-live .ag-live-status');
  if (statusEl) statusEl.remove();
}

function appendLiveText(text) {
  const contentEl = document.querySelector('.ag-msg-live .ag-live-content');
  if (!contentEl) return;

  const p = document.createElement('div');
  p.className = 'ag-live-step';
  p.innerHTML = formatMessage(text);
  contentEl.appendChild(p);
}

function appendThinkingBlock(iteration, thinking) {
  const toolsEl = document.querySelector('.ag-msg-live .ag-live-tools');
  if (!toolsEl) return;
  const block = document.createElement('details');
  block.className = 'ag-thinking-block';
  block.innerHTML = `<summary>🧠 사고 과정 (${iteration}턴)</summary><pre class="ag-thinking-pre">${esc(thinking)}</pre>`;
  toolsEl.appendChild(block);
}

function appendToolCard(chatArea, iteration, tool, arg, result, toolIndex) {
  const toolsEl = document.querySelector('.ag-msg-live .ag-live-tools');
  const container = toolsEl || chatArea;

  const card = document.createElement('div');
  card.className = 'ag-tool-card';
  card.dataset.iteration = iteration;
  card.dataset.tool = tool;
  if (toolIndex != null) card.dataset.toolIndex = toolIndex;
  card.innerHTML = `
    <div class="ag-tool-card-head" data-action="toggle-tool-card">
      <span class="ag-tool-card-icon">${TOOL_ICONS[tool] || '🔧'}</span>
      <span class="ag-tool-card-name">${esc(tool)}</span>
      <code class="ag-tool-card-arg">${esc((arg || '').slice(0, 80))}</code>
      <span class="ag-tool-card-status ag-tool-running">⟳</span>
      <span class="ag-tool-card-expand">▸</span>
    </div>
    <div class="ag-tool-card-body">
      <pre class="ag-tool-card-result">실행 중...</pre>
    </div>
  `;
  container.appendChild(card);
}

function fillToolCardResult(iteration, tool, result, toolIndex) {
  let card;
  if (toolIndex != null) {
    card = document.querySelector(`.ag-tool-card[data-iteration="${iteration}"][data-tool="${tool}"][data-tool-index="${toolIndex}"]`);
  }
  if (!card) {
    const cards = document.querySelectorAll(`.ag-tool-card[data-iteration="${iteration}"][data-tool="${tool}"]`);
    card = cards[cards.length - 1];
  }
  if (!card) return;

  const statusEl = card.querySelector('.ag-tool-card-status');
  if (statusEl) {
    statusEl.textContent = '✓';
    statusEl.className = 'ag-tool-card-status ag-tool-done';
  }

  const resultEl = card.querySelector('.ag-tool-card-result');
  if (resultEl) {
    resultEl.textContent = result || '(no output)';
  }
}

function finalizeLiveBubble(content) {
  const live = document.querySelector('.ag-msg-live');
  if (!live) return;
  live.classList.remove('ag-msg-live');

  // Remove status bar
  const status = live.querySelector('.ag-live-status');
  if (status) status.remove();

  // The content and tool cards stay as-is (they show the journey)
}

// ─── Action Button: Send ↔ Stop toggle ───
function updateActionButton() {
  const sendBtn = document.getElementById('agent-send-btn');
  const stopBtn = document.getElementById('agent-stop-btn');
  if (sendBtn) sendBtn.style.display = _running ? 'none' : '';
  if (stopBtn) stopBtn.style.display = _running ? '' : 'none';

  const input = document.getElementById('agent-input');
  if (input) {
    input.disabled = _running;
    input.placeholder = _running ? '웰시콕이가 작업 중이에여...' : '메시지를 입력하세여...';
  }
}

// ─── Voice: Speech-to-Text (Push-to-Talk) ───
export function toggleVoiceInput() {
  if (_listening) stopListening();
  else startListening();
}

function startListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('이 브라우저에서 음성 인식 지원 안 해영 ㅠ', 'error');
    return;
  }

  // Pause wake word while push-to-talk is active (can't run two recognitions)
  if (_wakeRecognition) {
    try { _wakeRecognition.stop(); } catch {}
    _wakeRecognition = null;
  }

  _recognition = new SpeechRecognition();
  _recognition.lang = 'ko-KR';
  _recognition.continuous = false;
  _recognition.interimResults = true;

  const input = document.getElementById('agent-input');
  const micBtn = document.getElementById('agent-mic-btn');

  _recognition.onstart = () => {
    _listening = true;
    if (micBtn) micBtn.classList.add('ag-mic-active');
  };

  _recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (input) input.value = transcript;
    if (event.results[event.results.length - 1].isFinal) {
      setTimeout(() => sendAgentMessage(), 300);
    }
  };

  _recognition.onerror = (event) => {
    if (event.error !== 'no-speech') showToast(`음성 인식 에러: ${event.error}`, 'error');
    stopListening();
  };

  _recognition.onend = () => stopListening();
  _recognition.start();
}

function stopListening() {
  _listening = false;
  if (_recognition) {
    try { _recognition.stop(); } catch {}
    _recognition = null;
  }
  const micBtn = document.getElementById('agent-mic-btn');
  if (micBtn) micBtn.classList.remove('ag-mic-active');

  // Resume wake word if it was enabled
  if (_wakeWordMode) {
    setTimeout(() => startWakeWordListening(), 500);
  }
}

// ─── Wake Word: Always-Listening Mode ───
export function toggleWakeWord() {
  _wakeWordMode = !_wakeWordMode;
  localStorage.setItem('ag-wake-word', _wakeWordMode);
  console.log(`[WAKE] toggled: ${_wakeWordMode ? 'ON' : 'OFF'}`);

  if (_wakeWordMode) {
    startWakeWordListening();
    showToast('🐶 웰시콕이가 듣고 있어영~ "헤이 웰시콕이"로 불러보세여!', 'success');
  } else {
    stopWakeWordListening();
    showToast('웨이크워드 모드 꺼졌어영', 'info');
  }
  updateWakeWordUI();
}

let _wakeStarting = false; // guard against concurrent startWakeWordListening calls

function startWakeWordListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { console.warn('[WAKE] SpeechRecognition API not available'); return; }
  if (!_wakeWordMode) { console.warn('[WAKE] wake word mode is OFF'); return; }

  // Don't start if push-to-talk is active
  if (_listening) { console.warn('[WAKE] push-to-talk active, skipping'); return; }

  // Prevent duplicate starts
  if (_wakeStarting) { console.warn('[WAKE] already starting, skipping'); return; }
  _wakeStarting = true;

  // Clean up any existing instance first
  if (_wakeRecognition) {
    try { _wakeRecognition.stop(); } catch {}
    _wakeRecognition = null;
  }

  _wakeRecognition = new SpeechRecognition();
  _wakeRecognition.lang = 'ko-KR';
  _wakeRecognition.continuous = true;
  _wakeRecognition.interimResults = false; // only final results for wake word

  _wakeRecognition.onstart = () => {
    _wakeStarting = false;
    console.log('[WAKE] 🎤 listening started — say "헤이 웰시코기"');
  };

  _wakeRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (!event.results[i].isFinal) continue;
      const text = event.results[i][0].transcript.trim();
      const confidence = event.results[i][0].confidence;
      console.log(`[WAKE] 🗣️ heard: "${text}" (confidence: ${(confidence * 100).toFixed(1)}%)`);
      processWakeWordResult(text);
    }
  };

  _wakeRecognition.onend = () => {
    console.log('[WAKE] recognition ended, restarting...');
    // Auto-restart if still in wake word mode (Chrome stops after silence)
    if (_wakeWordMode && !_listening) {
      setTimeout(() => {
        if (_wakeWordMode && !_listening) startWakeWordListening();
      }, 300);
    }
  };

  _wakeRecognition.onerror = (event) => {
    console.warn(`[WAKE] error: ${event.error}`);
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    // Restart on recoverable errors
    if (_wakeWordMode && !_listening) {
      setTimeout(() => startWakeWordListening(), 1000);
    }
  };

  try {
    _wakeRecognition.start();
    console.log('[WAKE] 🐶 wake word recognition starting...');
  } catch (e) {
    _wakeStarting = false;
    console.warn('[WAKE] start failed:', e);
  }
}

// Safety net — called after agent loop ends to guarantee wake word resumes
function ensureWakeWordRunning() {
  if (!_wakeWordMode) return;
  if (_wakeRecognition) return; // already running
  if (_wakeStarting) return; // start in progress
  if (_listening) return; // push-to-talk active
  // Wait for any TTS to finish first
  if (_ttsAudio) {
    console.log('[WAKE] TTS still playing, will resume after onended');
    // Attach a one-shot listener in case existing onended doesn't fire
    const origEnd = _ttsAudio.onended;
    _ttsAudio.onended = function(...args) {
      if (origEnd) origEnd.apply(this, args);
      _ttsAudio = null;
      if (_wakeWordMode && !_wakeRecognition && !_listening) {
        setTimeout(() => startWakeWordListening(), 300);
      }
    };
    return;
  }
  console.log('[WAKE] safety net: restarting wake word');
  setTimeout(() => startWakeWordListening(), 500);
}

function stopWakeWordListening() {
  _awaitingCommand = false;
  if (_wakeTimeout) { clearTimeout(_wakeTimeout); _wakeTimeout = null; }
  if (_wakeRecognition) {
    try { _wakeRecognition.stop(); } catch {}
    _wakeRecognition = null;
  }
  updateWakeWordUI();
}

function processWakeWordResult(text) {
  const lower = text.toLowerCase().replace(/\s+/g, '');
  console.log(`[WAKE] processing: "${text}" → normalized: "${lower}"`);

  // State: awaiting command after wake word
  if (_awaitingCommand) {
    console.log(`[WAKE] ✅ command received: "${text}"`);
    _awaitingCommand = false;
    if (_wakeTimeout) { clearTimeout(_wakeTimeout); _wakeTimeout = null; }
    showWakeIndicator(false);
    sendVoiceCommand(text);
    return;
  }

  // State: check for wake word
  const wakeMatch = WAKE_WORDS.find(w => lower.includes(w.replace(/\s+/g, '')));
  if (!wakeMatch) {
    console.log(`[WAKE] ❌ no wake word match in: "${lower}"`);
    console.log(`[WAKE]    candidates: ${WAKE_WORDS.map(w => w.replace(/\s+/g, '')).join(', ')}`);
    return;
  }
  console.log(`[WAKE] ✅ wake word matched: "${wakeMatch}"`);

  // Extract command after wake word (e.g. "헤이 웰시콕이 이 프로젝트 분석해줘")
  const wakeNorm = wakeMatch.replace(/\s+/g, '');
  const idx = lower.indexOf(wakeNorm);
  // Rebuild the "after" text from the original (preserving spaces)
  let charCount = 0;
  let origIdx = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') charCount++;
    if (charCount > idx + wakeNorm.length) { origIdx = i; break; }
  }
  const afterWake = origIdx > 0 ? text.slice(origIdx).trim() : '';

  if (afterWake.length > 1) {
    // Wake word + command in one utterance
    pulseWakeIndicator();
    sendVoiceCommand(afterWake);
  } else {
    // Just wake word — acknowledge and wait for next utterance
    _awaitingCommand = true;
    if (!_panelOpen) toggleAgentPanel();
    showWakeIndicator(true);
    console.log('[WAKE] 🐶 wake word detected! Awaiting command...');
    // Use short beep/TTS without killing recognition
    speakQuick('네?');
    _wakeTimeout = setTimeout(() => {
      console.log('[WAKE] ⏰ command timeout (10s)');
      _awaitingCommand = false;
      showWakeIndicator(false);
    }, 10000);
  }
}

function sendVoiceCommand(text) {
  if (_running) return;
  // Ensure agent is initialized (wake word can fire before panel is opened)
  initAgent();
  // Open panel so user sees the response
  if (!_panelOpen) toggleAgentPanel();
  // Inject into input and send
  const input = document.getElementById('agent-input');
  if (input) input.value = text;
  sendAgentMessage();
}

function updateWakeWordUI() {
  const btn = document.getElementById('agent-wake-btn');
  if (btn) {
    btn.classList.toggle('ag-wake-active', _wakeWordMode);
    btn.title = _wakeWordMode ? '웨이크워드 ON — "헤이 웰시콕이"' : '웨이크워드 OFF';
  }
  // Also show wake state on FAB
  const fab = document.getElementById('agent-fab');
  if (fab) fab.classList.toggle('wake-active', _wakeWordMode);
}

function showWakeIndicator(active) {
  const indicator = document.getElementById('agent-wake-indicator');
  if (indicator) {
    indicator.style.display = active ? 'flex' : 'none';
    indicator.textContent = active ? '🐶 듣고 있어영... 말씀하세여!' : '';
  }
}

function pulseWakeIndicator() {
  const indicator = document.getElementById('agent-wake-indicator');
  if (!indicator) return;
  indicator.style.display = 'flex';
  indicator.textContent = '🐶 알겠어영!';
  setTimeout(() => { indicator.style.display = 'none'; }, 1500);
}

// Quick TTS for wake word ack — does NOT stop recognition
function speakQuick(text) {
  console.log(`[WAKE] speakQuick: "${text}"`);
  // Try Edge TTS first, but don't touch recognition
  fetch('/api/agent/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
    .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = _ttsVolume;
      audio.playbackRate = _ttsRate;
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play().catch(() => {});
    })
    .catch(() => {
      // Fallback: browser TTS
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.volume = _ttsVolume;
        u.rate = _ttsRate;
        window.speechSynthesis.speak(u);
      }
    });
}

// ─── Streaming TTS Queue — plays sentence chunks as they arrive ───
const _ttsQueue = [];
let _ttsPlaying = false;
let _streamTTSBuffer = '';  // accumulates streaming text
let _streamTTSUsed = false; // true if streaming TTS sent anything (skip final speak)

function _ttsPlayNext() {
  if (_ttsPlaying || !_ttsQueue.length) return;
  const text = _ttsQueue.shift();
  if (!text.trim()) { _ttsPlayNext(); return; }
  _ttsPlaying = true;

  fetch('/api/agent/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
    .then(r => { if (!r.ok) throw new Error('TTS failed'); return r.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = _ttsVolume;
      audio.playbackRate = _ttsRate;
      audio.onended = () => { URL.revokeObjectURL(url); _ttsPlaying = false; _ttsAudio = null; _ttsPlayNext(); };
      audio.onerror = () => { _ttsPlaying = false; _ttsAudio = null; _ttsPlayNext(); };
      _ttsAudio = audio;
      audio.play().catch(() => { _ttsPlaying = false; _ttsAudio = null; _ttsPlayNext(); });
    })
    .catch(() => { _ttsPlaying = false; _ttsPlayNext(); });
}

function enqueueStreamTTS(sentence) {
  const clean = sentence
    .replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
    .replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\n+/g, ' ').trim();
  if (!clean || clean.length < 2) return;
  _ttsQueue.push(clean);
  if (!_ttsPlaying) {
    pauseWakeForTTS();
    _ttsPlayNext();
  }
}

function flushStreamTTS() {
  if (_streamTTSBuffer.trim()) {
    enqueueStreamTTS(_streamTTSBuffer);
    _streamTTSBuffer = '';
  }
}

function feedStreamTTS(delta) {
  if (!_ttsEnabled) return;
  _streamTTSBuffer += delta;
  // Split on sentence boundaries (Korean/English)
  const sentenceEnd = /[.!?~]\s|[.!?~]$/;
  while (sentenceEnd.test(_streamTTSBuffer)) {
    const match = _streamTTSBuffer.match(sentenceEnd);
    const idx = match.index + match[0].length;
    const sentence = _streamTTSBuffer.slice(0, idx).trim();
    _streamTTSBuffer = _streamTTSBuffer.slice(idx);
    if (sentence.length >= 4) {
      _streamTTSUsed = true;
      enqueueStreamTTS(sentence);
    }
  }
}

function resetStreamTTS() {
  _streamTTSBuffer = '';
  _streamTTSUsed = false;
}

// ─── Voice: Text-to-Speech (Edge TTS Neural) ───
let _ttsAudio = null;

function speak(text) {
  if (!_ttsEnabled) return;
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/@@TOOL:\w+@@[\s\S]*?@@END@@/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 800);
  if (!clean.trim()) return;

  // Stop any currently playing audio
  if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }

  // Pause wake word while TTS is speaking (mic picks up speaker)
  pauseWakeForTTS();

  function resumeWake() {
    // Always check current state, not stale closure
    if (_wakeWordMode && !_wakeRecognition && !_listening) {
      console.log('[WAKE] resuming after TTS');
      setTimeout(() => startWakeWordListening(), 500);
    }
  }

  fetch('/api/agent/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean })
  })
    .then(r => {
      if (!r.ok) throw new Error('TTS failed');
      return r.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      _ttsAudio = new Audio(url);
      _ttsAudio.volume = _ttsVolume;
      _ttsAudio.playbackRate = _ttsRate;
      _ttsAudio.onended = () => {
        URL.revokeObjectURL(url);
        _ttsAudio = null;
        resumeWake();
      };
      _ttsAudio.onerror = () => {
        _ttsAudio = null;
        resumeWake();
      };
      _ttsAudio.play().catch(() => resumeWake());
    })
    .catch(() => {
      // Fallback to browser TTS if Edge TTS fails
      if (window.speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(clean.slice(0, 300));
        utterance.lang = 'ko-KR';
        utterance.volume = _ttsVolume;
        utterance.rate = _ttsRate;
        utterance.onend = () => resumeWake();
        utterance.onerror = () => resumeWake();
        window.speechSynthesis.speak(utterance);
      } else {
        resumeWake();
      }
    });
}

function pauseWakeForTTS() {
  if (_wakeRecognition) {
    console.log('[WAKE] pausing for TTS');
    try { _wakeRecognition.stop(); } catch {}
    _wakeRecognition = null;
  }
}

export function toggleTTS() {
  _ttsEnabled = !_ttsEnabled;
  const btn = document.getElementById('agent-tts-btn');
  if (btn) {
    btn.classList.toggle('ag-tts-off', !_ttsEnabled);
    btn.title = _ttsEnabled ? 'TTS On' : 'TTS Off';
  }
  if (!_ttsEnabled) {
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
    window.speechSynthesis?.cancel();
  }
}

// ─── New Conversation ───
export async function newAgentConversation() {
  if (_running) {
    await stopAgentLoop();
  }
  try {
    const res = await fetch('/api/agent/conversations', { method: 'POST' });
    const data = await res.json();
    _convId = data.id;
    app._agentMessages = [];
    _running = false;
    updateActionButton();
    renderChat();
  } catch (err) {
    showToast('새 대화 만들기 실패: ' + err.message, 'error');
  }
}

// ─── TTS Settings ───
export function setTTSVolume(val) {
  _ttsVolume = parseFloat(val);
  localStorage.setItem('ag-tts-volume', _ttsVolume);
  const label = document.getElementById('ag-vol-label');
  if (label) label.textContent = Math.round(_ttsVolume * 100) + '%';
}

export function setTTSRate(val) {
  _ttsRate = parseFloat(val);
  localStorage.setItem('ag-tts-rate', _ttsRate);
  const label = document.getElementById('ag-rate-label');
  if (label) label.textContent = _ttsRate.toFixed(1) + 'x';
}

export function setTTSPitch(val) {
  _ttsPitch = parseFloat(val);
  localStorage.setItem('ag-tts-pitch', _ttsPitch);
}

export function toggleVoiceSettings() {
  const panel = document.getElementById('ag-voice-settings');
  if (panel) panel.classList.toggle('hidden');
}

// ─── Input handlers ───
export function agentInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendAgentMessage();
  }
}

// ─── AI Settings Modal ───
export async function openAiSettings() {
  const dialog = document.getElementById('ai-settings-dialog');
  if (!dialog) return;
  // Load current config
  try {
    const res = await fetch('/api/ai/config');
    const data = await res.json();
    const inp = document.getElementById('ai-gemini-key');
    if (inp && data.configured) inp.placeholder = data.geminiApiKey || 'AIzaSy...';
  } catch {}
  document.getElementById('ai-test-result').textContent = '';
  dialog.showModal();
}

export async function testAiKey() {
  const inp = document.getElementById('ai-gemini-key');
  const result = document.getElementById('ai-test-result');
  const btn = document.getElementById('ai-test-btn');
  const key = inp?.value?.trim();
  if (!key) { result.textContent = 'API key를 입력하세요'; result.style.color = 'var(--red)'; return; }
  btn.disabled = true; btn.textContent = 'Testing...';
  result.textContent = '';
  try {
    const res = await fetch('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geminiApiKey: key }) });
    const data = await res.json();
    if (data.success) { result.textContent = 'Connection successful!'; result.style.color = 'var(--green)'; }
    else { result.textContent = data.error || 'Test failed'; result.style.color = 'var(--red)'; }
  } catch (err) { result.textContent = err.message; result.style.color = 'var(--red)'; }
  btn.disabled = false; btn.textContent = 'Test';
}

export async function saveAiConfig() {
  const inp = document.getElementById('ai-gemini-key');
  const key = inp?.value?.trim();
  if (!key) { showToast('API key를 입력하세요', 'error'); return; }
  try {
    const res = await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geminiApiKey: key }) });
    const data = await res.json();
    if (data.success) {
      showToast('AI 설정 저장 완료', 'success');
      document.getElementById('ai-settings-dialog')?.close();
    } else { showToast(data.error || 'Save failed', 'error'); }
  } catch (err) { showToast(err.message, 'error'); }
}
