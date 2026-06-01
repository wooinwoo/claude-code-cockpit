/**
 * Telegram bridge — Cockpit ↔ Telegram 양방향.
 *
 * 흐름:
 *   long polling으로 메시지/콜백 수신
 *     ├─ /명령 → 내장 응답 (상태, 도움말 등)
 *     └─ 자유 텍스트 → Agent에게 위임 (chat) → 응답 폴링 → 텔레그램으로 전송
 *
 * 의존성 주입:
 *   init({ chat, getConversation, isRunning, newConversation }, config)
 *
 * Cockpit 코드 안 건드림 — 새 파일 1개.
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'telegram-config.json');

let _agent = null;       // { chat, getConversation, isRunning, newConversation }
let _cockpit = null;     // { getProjects, poller } — 세션/git 상태 조회용
let _config = null;      // { token, chatId, enabled }
let _lastDenied = null;  // 최근 거부/차단된 도구 호출 (답장 맥락용) — { tool, summary, project, reasoning, ts }
let _polling = false;
let _offset = 0;
let _convId = null;      // 현재 활성 conversation (텔레그램 채팅 1개당 1개)
let _logger = console;
let _focusedProject = null;   // sticky 프로젝트 (이름 또는 id)
let _trustExpiryTimer = null; // /trust 만료 5분 전 알림 타이머
let _startedAt = Date.now();  // 콕핏 부팅 시각 (uptime 계산용)

const MAX_TG_TEXT = 3800;
const AGENT_WAIT_TIMEOUT_MS = 60_000;

// ─── Config ─────────────────────────────────────────────────────────────

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    _logger.error?.('telegram', 'config load failed', e.message);
    return null;
  }
}

export function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
    _config = cfg;
    return true;
  } catch (e) {
    _logger.error?.('telegram', 'config save failed', e.message);
    return false;
  }
}

export function getConfig() {
  return _config ? { ...(_config), token: _config.token ? '***' : null } : null;
}

export function isEnabled() {
  return Boolean(_config?.token && _config?.chatId && _config?.enabled !== false);
}

// ─── Init ───────────────────────────────────────────────────────────────

export function init(agent, opts = {}, cockpit = null) {
  _agent = agent;
  _cockpit = cockpit;
  _logger = opts.logger || console;
  _config = loadConfig();
}

// ─── Telegram HTTP ──────────────────────────────────────────────────────

async function tgRequest(method, body, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  // getUpdates 는 long-polling (telegram 측 25s 대기) 이라 client timeout 도 길게.
  // 다른 호출 (sendMessage 등) 은 15s 면 충분.
  const isLongPoll = method === 'getUpdates' && (body?.timeout || 0) > 0;
  const REQ_TIMEOUT_MS = isLongPoll ? (body.timeout * 1000) + 5_000 : 15_000;
  try {
    return await new Promise((resolve, reject) => {
      if (!_config?.token) return reject(new Error('telegram not configured'));
      const data = JSON.stringify(body || {});
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          family: 4, // WSL2 IPv6 outbound 막혀있는 환경 → IPv4 강제
          path: `/bot${_config.token}/${method}`,
          method: 'POST',
          timeout: REQ_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => (chunks += c));
          res.on('end', () => {
            try { resolve(JSON.parse(chunks)); }
            catch (e) { reject(e); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error(`tg request timeout ${REQ_TIMEOUT_MS}ms`)); });
      req.write(data);
      req.end();
    });
  } catch (err) {
    const transient =
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.code === 'EAI_AGAIN' ||
      err.code === 'ENETUNREACH' ||
      /timeout/i.test(err.message || '');
    if (transient && attempt < MAX_ATTEMPTS) {
      const backoff = 500 * Math.pow(2, attempt - 1); // 500ms, 1s, 2s
      _logger.warn?.('telegram', `tg ${method} retry ${attempt}/${MAX_ATTEMPTS - 1} after ${backoff}ms — ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      return tgRequest(method, body, attempt + 1);
    }
    throw err;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function splitForTelegram(text) {
  const out = [];
  let remaining = String(text || '');
  while (remaining.length > MAX_TG_TEXT) {
    let cut = remaining.lastIndexOf('\n', MAX_TG_TEXT);
    if (cut < MAX_TG_TEXT * 0.5) cut = MAX_TG_TEXT;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}

export async function sendMessage(text, opts = {}) {
  if (!isEnabled()) return { ok: false, skipped: 'telegram disabled' };
  const chunks = splitForTelegram(text);
  let lastResult = null;
  for (const chunk of chunks) {
    lastResult = await tgRequest('sendMessage', {
      chat_id: _config.chatId,
      text: chunk,
      parse_mode: opts.parseMode || undefined,
      disable_notification: Boolean(opts.silent),
    });
  }
  return lastResult;
}

export async function notifyDecision(record) {
  // 거부/차단된 도구 호출은 맥락 기억 — 이후 "해도 돼" 같은 답장에 정확히 응답하기 위함
  if (record?.decision === 'block' || record?.decision === 'deny') {
    _lastDenied = {
      tool: record.tool || '?',
      summary: record.input?.command || record.input?.file_path || record.input?.path || record.tool || '',
      project: record.cwd ? record.cwd.split('/').filter(Boolean).pop() : null,
      reasoning: record.reasoning || '',
      ts: Date.now(),
    };
  }
  if (!isEnabled()) {
    _logger.warn?.('telegram', `notifyDecision skipped — telegram disabled (decision=${record.decision})`);
    return { ok: false, skipped: 'telegram disabled' };
  }
  const text = formatDecisionMessage(record);
  try {
    const result = await tgRequest('sendMessage', {
      chat_id: _config.chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: record.decision !== 'ask',
    });
    if (result?.ok) {
      _logger.info?.('telegram', `notifyDecision ${record.decision} sent OK (msg_id=${result.result?.message_id})`);
    } else {
      _logger.warn?.('telegram', `notifyDecision ${record.decision} sent but unexpected response: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return result;
  } catch (err) {
    _logger.error?.('telegram', `notifyDecision ${record.decision} FAILED — ${err.message}`);
    throw err;
  }
}

export async function sendTyping() {
  if (!isEnabled()) return;
  return tgRequest('sendChatAction', { chat_id: _config.chatId, action: 'typing' });
}

// ─── Cockpit context ────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// Gemini API 페이로드로 빠져나가기 직전에 호출. 발견 즉시 마스킹 — 콕사원 본인도 못 봄.
// 패턴 추가 시: 더 구체적인 것을 위에 둘 것 (먼저 매치).
function maskSecrets(text) {
  if (!text) return text;
  return String(text)
    // KEY=VALUE / KEY: VALUE 패턴 (PWD, PASSWORD, TOKEN, SECRET, KEY 등)
    .replace(/([A-Z_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|KEY|PWD|API_KEY)[A-Z_]*\s*[:=]\s*)['"]?([^'"\s]{4,})/gi,
             (_, prefix) => `${prefix}***`)
    // AWS
    .replace(/AKIA[A-Z0-9]{16,}/g, 'AKIA***')
    .replace(/aws_secret_access_key\s*=\s*\S+/gi, 'aws_secret_access_key=***')
    // OpenAI / Anthropic / Google (sk-ant 먼저 매치)
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, 'AIza***')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, 'ya29.***')
    // GitHub / GitLab
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***')
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, 'glpat-***')
    // Bearer / JWT
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, 'eyJ***')
    // postgres / mysql connection strings
    .replace(/(postgres(?:ql)?|mysql|mongodb)(\+srv)?:\/\/[^:]+:[^@]+@/gi, '$1$2://***:***@');
}

// ─── Todo backlog (텔레그램에서 등록한 작업 큐) ─────────────────────────
const TODO_PATH = path.join(__dirname, '..', 'logs', 'telegram-todos.jsonl');

function loadTodos() {
  try {
    if (!fs.existsSync(TODO_PATH)) return [];
    return fs.readFileSync(TODO_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function saveTodos(todos) {
  try {
    fs.mkdirSync(path.dirname(TODO_PATH), { recursive: true });
    fs.writeFileSync(TODO_PATH, todos.map((t) => JSON.stringify(t)).join('\n') + (todos.length ? '\n' : ''));
  } catch (e) { _logger.error?.('telegram', 'todo save failed', e.message); }
}
function addTodo(text) {
  const todos = loadTodos();
  const id = todos.length ? Math.max(...todos.map((t) => t.id || 0)) + 1 : 1;
  const todo = { id, ts: new Date().toISOString(), text, status: 'pending' };
  todos.push(todo);
  saveTodos(todos);
  return todo;
}
function listTodos(includeDone = false) {
  return loadTodos().filter((t) => includeDone || t.status === 'pending');
}
function markTodoDone(id) {
  const todos = loadTodos();
  const t = todos.find((x) => x.id === Number(id));
  if (!t) return null;
  t.status = 'done';
  t.doneAt = new Date().toISOString();
  saveTodos(todos);
  return t;
}
function nextTodo() {
  return listTodos(false)[0] || null;
}

function buildCockpitContext() {
  const lines = [];

  // [현재 모드 / Focus / Backlog] — 콕사원이 매번 알아야 할 sticky 상태
  const focusLine = _focusedProject ? `🎯 현재 focus: ${_focusedProject}` : null;
  const pendingTodos = listTodos(false);
  const todoLine = pendingTodos.length ? `📋 미완료 todo ${pendingTodos.length}건 (next: "${pendingTodos[0].text.slice(0, 60)}")` : null;
  if (focusLine || todoLine) {
    lines.push('[현재 sticky 상태]');
    if (focusLine) lines.push(focusLine);
    if (todoLine) lines.push(todoLine);
    if (focusLine) lines.push(`참고: "그거", "그 프로젝트" 등 모호한 표현은 우선적으로 "${_focusedProject}" 로 해석.`);
    lines.push('');
  }

  if (_cockpit?.getProjects) {
    const projects = _cockpit.getProjects() || [];
    if (projects.length) {
      lines.push('[Cockpit 프로젝트]');
      for (const p of projects) {
        const sess = _cockpit.poller?.getCached?.(`session:${p.id}`) || {};
        const git = _cockpit.poller?.getCached?.(`git:${p.id}`) || {};
        const stateIcon = sess.state === 'active' ? '🟢'
          : sess.state === 'idle' ? '⚪'
          : sess.state === 'paused' ? '⏸'
          : '·';
        const parts = [`${stateIcon} ${p.name}`];
        if (sess.state) parts.push(sess.state);
        if (sess.sessionCount != null) parts.push(`세션 ${sess.sessionCount}`);
        if (sess.lastActivity) parts.push(`최근 ${timeAgo(sess.lastActivity)}`);
        if (git.branch) parts.push(`branch ${git.branch}`);
        if (git.uncommittedCount) parts.push(`uncommitted ${git.uncommittedCount}`);
        lines.push('- ' + parts.join(' · '));
      }
    }
  }

  if (_cockpit?.supervisor?.getRecentDecisions) {
    const mode = _cockpit.supervisor.getMode?.() || 'here';
    const recent = _cockpit.supervisor.getRecentDecisions(100);
    const last1h = recent.filter((d) => {
      const t = new Date(d.ts || 0).getTime();
      return Date.now() - t < 3600_000;
    });
    const by = (arr, k) => arr.reduce((m, d) => { m[d[k]] = (m[d[k]] || 0) + 1; return m; }, {});
    const dec1h = by(last1h, 'decision');
    const blocked = last1h.filter((d) => d.decision === 'block' || d.decision === 'deny');
    const asked = last1h.filter((d) => d.decision === 'ask');
    const pending = _cockpit.supervisor.getPendingCount?.() || 0;

    lines.push('');
    lines.push(`[Supervisor — 모드: ${mode === 'away' ? '🚶 AWAY' : '🏠 HERE'}]`);
    lines.push(`최근 1시간: 자동 ${dec1h.approve || 0}건 통과, 차단 ${blocked.length}건, 사람 대기 ${pending}건`);

    if (pending > 0) {
      lines.push('');
      lines.push('⚠️ 사용자 답변 대기 중 — 답해주세요.');
    }

    if (blocked.length > 0) {
      lines.push('');
      lines.push('🔴 차단된 작업 (사용자 알 가치 있음):');
      for (const d of blocked.slice(-5).reverse()) {
        const what = (d.input?.command || d.input?.file_path || '').toString().slice(0, 80);
        const t = (d.ts || '').slice(11, 19);
        const reason = (d.reasoning || '').slice(0, 100);
        lines.push(`  ${t} ${d.tool || '?'}: ${what}`);
        if (reason) lines.push(`     이유: ${reason}`);
      }
    }

    if (asked.length > 0) {
      lines.push('');
      lines.push('🟡 사람 결정 거친 작업:');
      for (const d of asked.slice(-3).reverse()) {
        const what = (d.input?.command || d.input?.file_path || '').toString().slice(0, 80);
        const t = (d.ts || '').slice(11, 19);
        lines.push(`  ${t} ${d.tool || '?'}: ${what}`);
      }
    }

    lines.push('');
    lines.push('※ approve는 통상 사용자가 시킨 일이라 상세 생략. 위 차단/대기가 중요.');
  }

  // [터미널 작업판] — 사용자가 "그 세션", "방금 거" 같은 모호한 표현을 쓸 때
  // 콕사원이 즉시 맥락을 잡도록 모든 터미널의 최근 출력 요약을 주입한다.
  // 송신 전 maskSecrets 적용 — Google API 페이로드로 평문 비밀번호 흘러가는 거 방지.
  if (_cockpit?.listTerminals && _cockpit?.readTerminalBuffer) {
    const terms = _cockpit.listTerminals() || [];
    if (terms.length) {
      const projects = _cockpit.getProjects?.() || [];
      const projMap = Object.fromEntries(projects.map(p => [p.id, p.name]));
      lines.push('');
      lines.push('[터미널 작업판]');
      for (const t of terms) {
        const projName = projMap[t.projectId] || t.projectId || '?';
        const cmd = t.command || '(shell)';
        lines.push(`- [${t.termId}] ${projName} · cmd: ${maskSecrets(cmd)}`);
        const buf = _cockpit.readTerminalBuffer(t.termId);
        if (buf) {
          const clean = buf
            .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
            .replace(/\x1B\][^\x07]*\x07/g, '')
            .trim();
          const masked = maskSecrets(clean);
          const tailLines = masked.split('\n').slice(-6).join('\n').slice(-400);
          if (tailLines) {
            lines.push('  최근 출력:');
            for (const line of tailLines.split('\n')) {
              lines.push(`    ${line}`);
            }
          }
        }
      }
    }
  }

  if (!lines.length) return null;
  lines.push('');
  lines.push('위 현황을 참고해 답하세요. "그 세션", "방금 거" 같은 표현은 작업판에서 매핑. 정보 없으면 모른다고 말하고 추측 금지.');
  return lines.join('\n');
}

// ─── Agent helpers ──────────────────────────────────────────────────────

function ensureConv() {
  if (_convId) return _convId;
  const r = _agent.newConversation();
  _convId = r?.id || r?.convId || String(Date.now());
  return _convId;
}

async function waitForAgent(convId, timeoutMs = AGENT_WAIT_TIMEOUT_MS) {
  const start = Date.now();
  while (_agent.isRunning(convId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

function lastAssistantMessage(convId) {
  const conv = _agent.getConversation(convId);
  if (!conv?.messages?.length) return null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== 'user') return m;
  }
  return null;
}

// ─── Commands ────────────────────────────────────────────────────────────

function cmdHelp() {
  return [
    '🤖 <b>Cockpit 봇</b>',
    '',
    '<b>━ 모드 ━</b>',
    '/status — 모드 + 신뢰 + focus + todo 상태',
    '/here /away — 자리 모드',
    '/trust 30m /untrust — 신뢰 모드 (위험 자동, hard 만 묻기)',
    '',
    '<b>━ Sticky ━</b>',
    '/focus &lt;project&gt; — 이후 "그거" = focus 프로젝트',
    '/unfocus — 해제',
    '',
    '<b>━ Backlog ━</b>',
    '/todo add &lt;text&gt; — 추가',
    '/todo list — 미완료 목록',
    '/todo done N — 완료 처리',
    '/todo next — 다음 거 바로 콕사원에 위임',
    '',
    '<b>━ 자율 스케줄 ━</b>',
    '/schedule add "09:00 daily" "프롬프트"',
    '/schedule list /remove ID /run ID /toggle ID',
    '',
    '<b>━ 조회 (즉답, 토큰 0) ━</b>',
    '/history [N] /decisions [N] /approvals [N]',
    '/terminals /projects /log [N] /agents /diag',
    '',
    '<b>━ 기타 ━</b>',
    '/new /help',
    '',
    '그 외 자유 텍스트 → 콕사원 (Gemini Flash) 가 처리.',
    '예: "기획팀 박기리 불러", "tire-auction 푸시해", "그거 어떻게 됐어?"',
  ].join('\n');
}

function cmdStatus() {
  const mode = _cockpit?.supervisor?.getMode?.() || '?';
  const pending = _cockpit?.supervisor?.getPendingCount?.() || 0;
  const trust = getTrustState();
  const pendingTodos = listTodos(false).length;
  const lines = [
    '📊 Cockpit 상태',
    `모드: ${mode === 'away' ? '🚶 AWAY (적극 ask)' : '🏠 HERE (알림 최소)'}`,
    `신뢰: ${trust.active ? `🟢 ON · 남음 ${fmtRemaining(trust.remainingMs)}` : '🔴 OFF (위험 도구 확인)'}`,
    `Focus: ${_focusedProject ? `🎯 ${_focusedProject}` : '없음'}`,
    `Todo: ${pendingTodos > 0 ? `📋 ${pendingTodos}건` : '비어있음'}`,
    `사람 결정 대기: ${pending}건`,
    `대화 id: ${_convId || '없음'}`,
  ];
  return lines.join('\n');
}

function cmdSetMode(mode) {
  if (!_cockpit?.supervisor?.setMode) return '⚠️ supervisor 모드 변경 불가';
  const newMode = _cockpit.supervisor.setMode(mode);
  return newMode === 'away'
    ? '🚶 AWAY 모드로 전환됨\n모호한 결정은 너한테 물어봐.'
    : '🏠 HERE 모드로 전환됨\n알림 최소화. 위험한 거만 알림.';
}

function cmdNew() {
  _convId = null;
  const id = ensureConv();
  return `🔄 새 대화 시작: ${id}`;
}

// ─── Message handler ────────────────────────────────────────────────────

async function handleMessage(msg) {
  const fromChat = String(msg.chat?.id || '');
  if (!_config?.chatId || fromChat !== String(_config.chatId)) {
    _logger.info?.('telegram', `ignored msg from chat=${fromChat}`);
    return;
  }
  const text = (msg.text || '').trim();
  if (!text) return;

  _logger.info?.('telegram', `msg: ${text.slice(0, 80)}`);

  // 자연어 모드 전환 (명령 외우기 귀찮으니까)
  if (!text.startsWith('/') && _cockpit?.supervisor?.setMode) {
    const lower = text.toLowerCase();
    const awayKw = /(자리\s*비움|자리\s*비울|나갔|밖에|밖\s*나|away|회의|잘게|잘\s*거|자러|밤이|퇴근|외출)/i;
    const hereKw = /(왔어|돌아왔|돌아옴|복귀|일어났|기상|here\b|자리\s*있|작업\s*시작|시작할|이제\s*있)/i;
    if (awayKw.test(text)) {
      _cockpit.supervisor.setMode('away');
      return sendMessage('🚶 자리 비움 인지, AWAY 모드 전환됨\n모호한 결정 너한테 물어볼게.', { silent: true });
    }
    if (hereKw.test(text)) {
      _cockpit.supervisor.setMode('here');
      return sendMessage('🏠 자리 복귀 인지, HERE 모드 전환됨\n알림 최소화.', { silent: true });
    }
  }

  // 명령(/...) 이 아니고 pending 있으면 결정 답변으로 라우팅
  if (!text.startsWith('/') && _pendingResolvers.size > 0) {
    // 1순위: reply_to_message 가 ask 메시지면 그 ask 매칭
    let askId = null;
    const replyToId = msg.reply_to_message?.message_id;
    if (replyToId && _askMessageMap.has(replyToId)) {
      const candidateId = _askMessageMap.get(replyToId);
      if (_pendingResolvers.has(candidateId)) askId = candidateId;
    }
    // 2순위: pending 이 1개면 그거에 매칭
    if (!askId && _pendingResolvers.size === 1) {
      askId = _pendingResolvers.keys().next().value;
    }
    // 매칭 실패 (pending 여러 개 + reply 없음) — 잭에게 알림 + 첫 pending 으로 처리 + 경고
    if (!askId) {
      const ids = [..._pendingResolvers.keys()].map((k) => `<code>${k}</code>`).join(', ');
      sendMessage(`⚠️ pending ask 가 ${_pendingResolvers.size}개입니다 (${ids}). reply 로 정확히 매칭해주세요. 일단 가장 오래된 거에 답으로 처리합니다.`, { parseMode: 'HTML', silent: true }).catch(() => {});
      askId = _pendingResolvers.keys().next().value;
    }
    const fn = _pendingResolvers.get(askId);
    _pendingResolvers.delete(askId);
    sendMessage(`🤖 답변 받음 <code>${askId}</code>, LLM이 해석 중…`, { parseMode: 'HTML', silent: true }).catch(() => {});
    try {
      await fn(text);
    } catch (e) {
      _logger.error?.('telegram', 'pending resolver err', e.message);
    }
    return;
  }

  const [cmd] = text.split(/\s+/);
  if (cmd === '/help' || cmd === '/start') {
    return sendMessage(cmdHelp(), { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/status') {
    return sendMessage(cmdStatus(), { silent: true });
  }
  if (cmd === '/here') {
    return sendMessage(cmdSetMode('here'), { silent: true });
  }
  if (cmd === '/away') {
    return sendMessage(cmdSetMode('away'), { silent: true });
  }
  if (cmd === '/new') {
    return sendMessage(cmdNew(), { silent: true });
  }
  if (cmd === '/trust') {
    const arg = text.replace('/trust', '').trim();
    const ms = parseDuration(arg);
    if (!ms) {
      return sendMessage('사용법: <code>/trust 30m</code> 또는 <code>/trust 1h30m</code>\n중단: <code>/untrust</code>\nhard-risk (rm -rf, force push, publish) 는 trust 중에도 항상 확인합니다.', { parseMode: 'HTML', silent: true });
    }
    const s = setTrustWindow(ms);
    return sendMessage(`🟢 신뢰 모드 ${fmtRemaining(s.remainingMs)} 동안 활성.\nhard-risk 외 자동 승인 + audit 로그.\n중단: <code>/untrust</code>`, { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/untrust') {
    setTrustWindow(0);
    return sendMessage('🔴 신뢰 모드 OFF. 모든 위험 도구 다시 확인 받음.', { silent: true });
  }
  if (cmd === '/approvals') {
    try {
      if (!fs.existsSync(AUDIT_LOG_PATH)) return sendMessage('승인 audit 로그 없음.', { silent: true });
      const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').slice(-10);
      const rendered = lines.map((l) => {
        try {
          const r = JSON.parse(l);
          const icon = { 'user-approve': '✅', 'user-deny': '❌', 'timeout': '⏱', 'trust-auto': '🟢', 'deny-no-telegram': '🚫' }[r.decision] || '·';
          const t = (r.ts || '').slice(11, 19);
          return `${icon} ${t} ${r.label}${r.hard ? ' [HARD]' : ''}`;
        } catch { return l.slice(0, 80); }
      }).join('\n');
      return sendMessage(`<b>최근 승인 10건</b>\n<code>${escapeHtml(rendered)}</code>`, { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`audit 로그 읽기 실패: ${e.message}`, { silent: true });
    }
  }
  // ─── 정보 조회 명령 (콕사원 안 거치고 직접) ─────────────────────────
  if (cmd === '/history') {
    const n = parseInt(text.replace('/history', '').trim(), 10) || 10;
    try {
      const histPath = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(process.env.HOME || '', '.local', 'share'), 'cockpit', 'agent-history.json');
      if (!fs.existsSync(histPath)) return sendMessage('대화기록 파일 없음.', { silent: true });
      const data = JSON.parse(fs.readFileSync(histPath, 'utf8'));
      const convId = _convId && data[_convId] ? _convId : Object.keys(data).filter((k) => data[k]?.messages?.length).pop();
      if (!convId || !data[convId]?.messages) return sendMessage('현재 대화에 메시지 없음.', { silent: true });
      const msgs = data[convId].messages.slice(-n);
      const rendered = msgs.map((m, i) => {
        const role = m.role === 'user' ? '👤' : '🤖';
        const content = String(m.content || '').replace(/```json[\s\S]*?```/g, '').trim().slice(0, 200);
        return `${role} ${maskSecrets(content)}`;
      }).join('\n\n');
      return sendMessage(`<b>최근 ${msgs.length}건 (${convId.slice(0, 16)})</b>\n\n${escapeHtml(rendered)}`, { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`대화기록 읽기 실패: ${e.message}`, { silent: true });
    }
  }
  if (cmd === '/decisions') {
    const n = parseInt(text.replace('/decisions', '').trim(), 10) || 10;
    if (!_cockpit?.supervisor?.getRecentDecisions) return sendMessage('supervisor 미연결.', { silent: true });
    const recent = _cockpit.supervisor.getRecentDecisions(n);
    if (!recent.length) return sendMessage('supervisor 결정 없음.', { silent: true });
    const rendered = recent.slice(-n).map((d) => {
      const icon = { approve: '🟢', block: '🔴', deny: '🔴', ask: '🟡' }[d.decision] || '·';
      const t = (d.ts || '').slice(11, 19);
      const what = String(d.input?.command || d.input?.file_path || '').slice(0, 60);
      const proj = d.cwd ? d.cwd.split('/').filter(Boolean).pop() : '?';
      return `${icon} ${t} [${proj}] ${d.tool || '?'}: ${what}`;
    }).join('\n');
    return sendMessage(`<b>최근 supervisor 결정 ${recent.length}건</b>\n<code>${escapeHtml(rendered)}</code>`, { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/terminals') {
    if (!_cockpit?.listTerminals) return sendMessage('터미널 서비스 미연결.', { silent: true });
    const terms = _cockpit.listTerminals();
    if (!terms.length) return sendMessage('활성 터미널 없음.', { silent: true });
    const projects = _cockpit.getProjects?.() || [];
    const projMap = Object.fromEntries(projects.map((p) => [p.id, p.name]));
    const rendered = terms.map((t, i) => `${i + 1}. [<code>${escapeHtml(t.termId)}</code>] ${escapeHtml(projMap[t.projectId] || t.projectId || '?')} · ${escapeHtml(t.command || '(shell)')}`).join('\n');
    return sendMessage(`<b>활성 터미널 ${terms.length}개</b>\n${rendered}`, { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/projects') {
    if (!_cockpit?.getProjects) return sendMessage('프로젝트 서비스 미연결.', { silent: true });
    const projects = _cockpit.getProjects() || [];
    if (!projects.length) return sendMessage('등록된 프로젝트 없음.', { silent: true });
    const rendered = projects.map((p) => {
      const sess = _cockpit.poller?.getCached?.(`session:${p.id}`) || {};
      const git = _cockpit.poller?.getCached?.(`git:${p.id}`) || {};
      const icon = sess.state === 'active' ? '🟢' : sess.state === 'idle' ? '⚪' : '·';
      return `${icon} ${escapeHtml(p.name)}${git.branch ? ` · ${escapeHtml(git.branch)}` : ''}${git.uncommittedCount ? ` · uncommitted ${git.uncommittedCount}` : ''}`;
    }).join('\n');
    return sendMessage(`<b>프로젝트 ${projects.length}개</b>\n${rendered}`, { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/log') {
    const n = parseInt(text.replace('/log', '').trim(), 10) || 20;
    try {
      const logPath = '/tmp/cockpit.log';
      if (!fs.existsSync(logPath)) return sendMessage('서버 로그 파일 없음.', { silent: true });
      const all = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      const tail = all.slice(-Math.min(n, 50)).join('\n');
      return sendMessage(`<b>서버 로그 (마지막 ${Math.min(n, 50)}줄)</b>\n<code>${escapeHtml(maskSecrets(tail).slice(-3000))}</code>`, { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`로그 읽기 실패: ${e.message}`, { silent: true });
    }
  }
  if (cmd === '/agents') {
    try {
      const { AGENT_PROFILES, TEAMS } = await import('./agent-profiles.js');
      const lines = Object.values(TEAMS).map((team) => {
        const members = Object.values(AGENT_PROFILES).filter((a) => a.team === team.id);
        const names = members.map((m) => `${m.emoji || ''} ${m.name}(${m.rank})`).join(', ');
        return `${team.icon || ''} <b>${escapeHtml(team.name)}</b>: ${escapeHtml(names)}`;
      });
      const ceo = AGENT_PROFILES.daepyo;
      if (ceo) lines.unshift(`${ceo.emoji || ''} <b>${escapeHtml(ceo.name)}</b> (${ceo.rank})`);
      return sendMessage(`<b>에이전트 목록</b>\n${lines.join('\n')}\n\n사용: 채팅에 "기획팀 박기리 불러", "이사님 호출" 등 자연어로`, { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`agents 조회 실패: ${e.message}`, { silent: true });
    }
  }
  // ─── Sticky focus ────────────────────────────────────────────────────
  if (cmd === '/focus') {
    const arg = text.replace('/focus', '').trim();
    if (!arg) {
      return sendMessage(_focusedProject ? `🎯 현재 focus: <b>${escapeHtml(_focusedProject)}</b>\n해제: /unfocus` : 'focus 설정 안 됨.\n사용법: <code>/focus tire-auction</code>', { parseMode: 'HTML', silent: true });
    }
    _focusedProject = arg;
    return sendMessage(`🎯 focus 설정: <b>${escapeHtml(arg)}</b>\n이후 "그거", "그 프로젝트" 는 ${escapeHtml(arg)} 로 해석.\n해제: /unfocus`, { parseMode: 'HTML', silent: true });
  }
  if (cmd === '/unfocus') {
    const prev = _focusedProject;
    _focusedProject = null;
    return sendMessage(prev ? `🎯 focus 해제됨 (이전: ${escapeHtml(prev)})` : 'focus 설정 안 돼있었음.', { parseMode: 'HTML', silent: true });
  }
  // ─── Todo backlog ────────────────────────────────────────────────────
  if (cmd === '/todo') {
    const rest = text.replace('/todo', '').trim();
    const [sub, ...argParts] = rest.split(/\s+/);
    const argRest = argParts.join(' ').trim();
    if (!sub || sub === 'list') {
      const todos = listTodos(false);
      if (!todos.length) return sendMessage('미완료 todo 없음.\n추가: <code>/todo add 작업 내용</code>', { parseMode: 'HTML', silent: true });
      const rendered = todos.map((t) => `${t.id}. ${escapeHtml(t.text)}`).join('\n');
      return sendMessage(`<b>미완료 todo ${todos.length}건</b>\n${rendered}\n\n다음: <code>/todo next</code>  ·  완료: <code>/todo done N</code>`, { parseMode: 'HTML', silent: true });
    }
    if (sub === 'add') {
      if (!argRest) return sendMessage('사용법: <code>/todo add 작업 내용</code>', { parseMode: 'HTML', silent: true });
      const t = addTodo(argRest);
      return sendMessage(`📝 추가됨 (#${t.id}): ${escapeHtml(t.text)}`, { parseMode: 'HTML', silent: true });
    }
    if (sub === 'done') {
      const id = parseInt(argRest, 10);
      if (!id) return sendMessage('사용법: <code>/todo done 3</code>', { parseMode: 'HTML', silent: true });
      const t = markTodoDone(id);
      if (!t) return sendMessage(`#${id} todo 없음.`, { silent: true });
      return sendMessage(`✅ 완료 처리 (#${t.id}): ${escapeHtml(t.text)}`, { parseMode: 'HTML', silent: true });
    }
    if (sub === 'next') {
      const t = nextTodo();
      if (!t) return sendMessage('미완료 todo 없음.', { silent: true });
      // 콕사원에게 위임: 사용자가 "이거 처리해줘" 한 것과 같은 효과
      const convId2 = ensureConv();
      const ctx = buildCockpitContext();
      const enriched = `${ctx ? ctx + '\n\n' : ''}[사용자 질문]\n다음 todo 처리해줘: ${t.text}`;
      sendMessage(`▶️ #${t.id} 처리 시작: ${escapeHtml(t.text)}`, { parseMode: 'HTML', silent: true }).catch(() => {});
      _agent?.chat?.(convId2, enriched);
      sendTyping().catch(() => {});
      return;
    }
    return sendMessage('사용법: /todo [list | add <text> | done <N> | next]', { silent: true });
  }
  // ─── 자율 스케줄러 ─────────────────────────────────────────────────
  if (cmd === '/schedule') {
    const rest = text.replace('/schedule', '').trim();
    const [sub, ...argParts] = rest.split(/\s+/);
    try {
      const sched = await import('./autonomy-scheduler.js');
      if (!sub || sub === 'list') {
        const all = sched.list();
        if (!all.length) {
          return sendMessage(
            '<b>스케줄 없음</b>\n\n' +
            '추가: <code>/schedule add "pattern" "prompt"</code>\n\n' +
            '<b>패턴 예시:</b>\n' +
            '· <code>"09:00 daily"</code> — 매일 9시\n' +
            '· <code>"09:00 weekday"</code> — 평일 9시\n' +
            '· <code>"every 30m"</code> — 30분마다\n' +
            '· <code>"every 2h"</code> — 2시간마다\n\n' +
            '<b>사용 예:</b>\n' +
            '<code>/schedule add "09:00 weekday" "어제 빌드 상태 점검"</code>',
            { parseMode: 'HTML', silent: true }
          );
        }
        const rendered = all.map((s) => {
          const status = s.enabled ? '🟢' : '⚪';
          const last = s.lastRun ? ` (마지막 ${new Date(s.lastRun).toISOString().slice(11, 16)})` : '';
          return `${status} <code>${escapeHtml(s.id)}</code>: <b>${escapeHtml(s.pattern)}</b>\n   ${escapeHtml(s.prompt.slice(0, 80))}${last}`;
        }).join('\n\n');
        return sendMessage(`<b>스케줄 ${all.length}건</b>\n\n${rendered}\n\n제거: <code>/schedule remove ID</code>\n즉시 실행: <code>/schedule run ID</code>`, { parseMode: 'HTML', silent: true });
      }
      if (sub === 'add') {
        // 따옴표 파싱: /schedule add "pattern" "prompt"
        const m = rest.match(/^add\s+"([^"]+)"\s+"([^"]+)"$/);
        if (!m) return sendMessage('사용법: <code>/schedule add "pattern" "prompt"</code>\n예: <code>/schedule add "09:00 weekday" "오늘 할 일 정리"</code>', { parseMode: 'HTML', silent: true });
        const s = sched.add(m[1], m[2]);
        return sendMessage(`📅 등록됨 <code>${escapeHtml(s.id)}</code>\n패턴: ${escapeHtml(s.pattern)}\n작업: ${escapeHtml(s.prompt)}`, { parseMode: 'HTML', silent: true });
      }
      if (sub === 'remove') {
        const id = argParts[0];
        if (!id) return sendMessage('사용법: <code>/schedule remove ID</code>', { parseMode: 'HTML', silent: true });
        return sendMessage(sched.remove(id) ? `🗑 제거됨: ${id}` : `${id} 없음.`, { silent: true });
      }
      if (sub === 'run') {
        const id = argParts[0];
        if (!id) return sendMessage('사용법: <code>/schedule run ID</code>', { parseMode: 'HTML', silent: true });
        sched.runNow(id).catch(() => {});
        return sendMessage(`▶️ 즉시 실행: ${id}`, { silent: true });
      }
      if (sub === 'toggle') {
        const id = argParts[0];
        const s = sched.toggle(id);
        return sendMessage(s ? `${s.enabled ? '🟢' : '⚪'} ${id} 토글됨` : `${id} 없음.`, { silent: true });
      }
      return sendMessage('사용법: /schedule [list | add | remove | run | toggle]', { silent: true });
    } catch (e) {
      return sendMessage(`schedule 실패: ${e.message}`, { silent: true });
    }
  }
  // ─── 대화 검색 ───────────────────────────────────────────────────────
  if (cmd === '/find') {
    const pattern = text.replace('/find', '').trim();
    if (!pattern) return sendMessage('사용법: <code>/find &lt;검색어&gt;</code>\n예: <code>/find DB 비밀번호</code>', { parseMode: 'HTML', silent: true });
    try {
      const histPath = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(process.env.HOME || '', '.local', 'share'), 'cockpit', 'agent-history.json');
      if (!fs.existsSync(histPath)) return sendMessage('대화기록 없음.', { silent: true });
      const data = JSON.parse(fs.readFileSync(histPath, 'utf8'));
      const needle = pattern.toLowerCase();
      const matches = [];
      for (const [convId, conv] of Object.entries(data)) {
        if (!conv?.messages) continue;
        for (let i = 0; i < conv.messages.length; i++) {
          const m = conv.messages[i];
          const content = String(m.content || '').toLowerCase();
          if (content.includes(needle)) {
            matches.push({ convId, idx: i, role: m.role, content: m.content, createdAt: conv.createdAt });
            if (matches.length >= 10) break;
          }
        }
        if (matches.length >= 10) break;
      }
      if (!matches.length) return sendMessage(`"${escapeHtml(pattern)}" 검색 결과 없음.`, { parseMode: 'HTML', silent: true });
      const rendered = matches.map((m, i) => {
        const icon = m.role === 'user' ? '👤' : '🤖';
        const ts = (m.createdAt || '').slice(0, 16);
        // 매치 부분 컨텍스트 50자
        const lower = String(m.content || '').toLowerCase();
        const idx = lower.indexOf(needle);
        const start = Math.max(0, idx - 30);
        const snippet = String(m.content).slice(start, start + needle.length + 60);
        return `${i + 1}. ${icon} ${ts} (${m.convId.slice(-6)})\n   …${maskSecrets(snippet).replace(/\n/g, ' ').slice(0, 100)}…`;
      }).join('\n\n');
      return sendMessage(`<b>"${escapeHtml(pattern)}" 검색 결과 ${matches.length}건</b>\n\n${escapeHtml(rendered)}`, { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`검색 실패: ${e.message}`, { silent: true });
    }
  }
  // ─── 셀프 관리 ───────────────────────────────────────────────────────
  if (cmd === '/clear') {
    _convId = null;
    return sendMessage('🧹 현재 대화 컨텍스트 초기화됨. 새 대화 시작.', { silent: true });
  }
  if (cmd === '/restart') {
    sendMessage('🔄 콕핏 재시작 합니다... (외부 systemd/cron 이 다시 살려야 함)', { silent: true }).then(() => {
      setTimeout(() => process.exit(0), 1500);
    }).catch(() => process.exit(0));
    return;
  }
  // ─── 자기진단 ────────────────────────────────────────────────────────
  if (cmd === '/diag') {
    try {
      const mem = process.memoryUsage();
      const uptime = Math.round((Date.now() - _startedAt) / 1000);
      let logTail = '';
      let errCount = 0;
      let geminiAvg = 0;
      try {
        const log = fs.readFileSync('/tmp/cockpit.log', 'utf8').split('\n').slice(-500);
        errCount = log.filter((l) => l.includes('[ERROR]')).length;
        const geminiTimes = log.map((l) => {
          const m = l.match(/Gemini response in (\d+)ms/);
          return m ? parseInt(m[1], 10) : null;
        }).filter(Boolean);
        if (geminiTimes.length) geminiAvg = Math.round(geminiTimes.reduce((a, b) => a + b, 0) / geminiTimes.length);
        const recentErr = log.filter((l) => l.includes('ETIMEDOUT') || l.includes('ECONNRESET')).slice(-3);
        if (recentErr.length) logTail = recentErr.map((l) => l.slice(0, 80)).join('\n');
      } catch {}
      const trust = getTrustState();
      const lines = [
        `<b>🩺 자기진단</b>`,
        ``,
        `uptime: ${uptime < 60 ? uptime + '초' : uptime < 3600 ? Math.round(uptime / 60) + '분' : Math.round(uptime / 3600) + '시간'}`,
        `메모리: RSS ${Math.round(mem.rss / 1024 / 1024)}MB · Heap ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        `텔레그램: ${_polling ? '🟢 polling 중' : '🔴 미동작'} (offset=${_offset})`,
        `최근 500줄 에러: ${errCount}건`,
        `Gemini 평균 응답: ${geminiAvg || '?'}ms`,
        `신뢰 모드: ${trust.active ? '🟢 ' + fmtRemaining(trust.remainingMs) + ' 남음' : '🔴 OFF'}`,
        `Focus: ${_focusedProject || '없음'}`,
        `미완료 todo: ${listTodos(false).length}건`,
        `pending approvals: ${_approvalPending.size}건`,
      ];
      if (logTail) lines.push('', '<b>최근 네트워크 에러:</b>', `<code>${escapeHtml(logTail)}</code>`);
      return sendMessage(lines.join('\n'), { parseMode: 'HTML', silent: true });
    } catch (e) {
      return sendMessage(`diag 실패: ${e.message}`, { silent: true });
    }
  }

  if (!_agent?.chat) {
    return sendMessage('⚠️ Agent 연결 안 됨.');
  }

  let convId;
  try {
    convId = ensureConv();
    const ctx = buildCockpitContext();
    // 최근(5분 내) 거부된 도구 호출이 있으면 맥락 주입 — "해도 돼" 같은 답장에 헛소리 대신 정확히 응답
    let deniedCtx = '';
    if (_lastDenied && Date.now() - _lastDenied.ts < 5 * 60_000) {
      deniedCtx =
        `[방금 거부된 작업 — 참고]\n` +
        `프로젝트: ${_lastDenied.project || '?'} · 도구: ${_lastDenied.tool}\n` +
        `내용: ${_lastDenied.summary}\n` +
        (_lastDenied.reasoning ? `사유: ${_lastDenied.reasoning}\n` : '') +
        `중요: 이 도구 호출은 이미 차단되어 되돌릴 수 없습니다. 사용자가 "해도 돼" 등으로 승인하려 해도 텔레그램으로는 재실행할 수 없다고 정직하게 안내하고, 해당 세션(터미널)에서 직접 다시 실행해야 한다고 알려주세요. 파괴적 prod 작업(스택 삭제 등)이면 특히 신중히 확인하도록 안내하세요. 추측으로 다른 작업을 지어내지 마세요.\n\n`;
    }
    const enriched = `${ctx ? ctx + '\n\n' : ''}${deniedCtx}[사용자 질문]\n${text}`;
    _agent.chat(convId, enriched);
  } catch (err) {
    return sendMessage(`❌ Agent 에러: ${escapeHtml(err.message || String(err))}`);
  }

  sendTyping().catch(() => {});

  const done = await waitForAgent(convId);
  if (!done) {
    return sendMessage('⌛ Agent 응답 60초 초과. 백그라운드에서 진행 중일 수 있어요.');
  }

  const last = lastAssistantMessage(convId);
  const reply = last?.content || last?.text || '(빈 응답)';
  return sendMessage(reply);
}

const _supervisorCallbacks = new Set();
const _pendingResolvers = new Map(); // id → async fn(userAnswer)
const _askMessageMap = new Map(); // telegram message_id → ask_id  (reply 매칭용)

export function onSupervisorCallback(fn) {
  _supervisorCallbacks.add(fn);
}

export function registerPendingResolver(id, fn) {
  _pendingResolvers.set(id, fn);
}

export function clearPendingResolver(id) {
  _pendingResolvers.delete(id);
  // _askMessageMap 에서 이 ask 의 message_id 도 정리
  for (const [msgId, askId] of _askMessageMap) {
    if (askId === id) { _askMessageMap.delete(msgId); break; }
  }
}

export function hasPendingResolvers() {
  return _pendingResolvers.size > 0;
}

export async function sendAskMessage(question, id, record = {}) {
  if (!isEnabled()) return null;
  const body = record.tool ? describeToolForHuman(record) : '';
  const text =
    `⏸ <b>결정 필요</b>  <code>${id}</code>\n\n` +
    escapeHtml(question) +
    (body ? `\n\n${body}` : '') +
    `\n\n<i>버튼 누르거나 메시지에 reply 로 자유 답변 — 여러 ask 동시면 reply 로 정확히 매칭됩니다.</i>`;
  const result = await tgRequest('sendMessage', {
    chat_id: _config.chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ 승인', callback_data: `ask:${id}:approve` },
        { text: '❌ 거부', callback_data: `ask:${id}:deny` },
        { text: '💬 더 묻기', callback_data: `ask:${id}:more` },
      ]],
    },
  });
  if (result?.result?.message_id) {
    _askMessageMap.set(result.result.message_id, id);
    // 200개 이상이면 옛 것 삭제
    if (_askMessageMap.size > 200) {
      const firstKey = _askMessageMap.keys().next().value;
      _askMessageMap.delete(firstKey);
    }
  }
  return result;
}

// ─── 메시지 포맷터 ─── 텔레그램 HTML 풍부한 디자인
const DEC_BADGE = {
  approve: { emoji: '✅', label: 'APPROVED', tone: '진행' },
  block:   { emoji: '🚫', label: 'BLOCKED',  tone: '차단' },
  deny:    { emoji: '🚫', label: 'DENIED',   tone: '거부' },
  ask:     { emoji: '❓', label: 'ASKING',   tone: '확인 필요' },
};
const POLICY_LABEL = {
  'safelist':         '안전 룰',
  'blacklist':        '위험 패턴',
  'danger-path':      '위험 경로',
  'llm':              'AI 판단',
  'llm-resolved':     'AI + 너 답변',
  'llm-fail-deny':    'AI 실패 → 보수적 거부',
  'no-llm':           'AI 미연결',
  'no-channel':       '채널 없음',
  'timeout-deny':     '응답 없음 → 거부',
  'keyword-fallback': '키워드 매칭',
  'human-button':     '버튼 응답',
  'rule-fallthrough': '룰 없음',
};

function fmtTimeHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function formatDecisionMessage(record) {
  const dec = record.decision || 'unknown';
  const b = DEC_BADGE[dec] || { emoji: '⚪', label: dec.toUpperCase(), tone: '' };
  const project = record.cwd ? record.cwd.split('/').filter(Boolean).pop() : null;
  const sess = record.sessionId ? record.sessionId.slice(0, 8) : null;
  const policyLabel = POLICY_LABEL[record.policy] || record.policy || '?';
  const conf = typeof record.confidence === 'number' ? `${Math.round(record.confidence * 100)}%` : '–';

  // 헤더 — 결정 + tone
  const header = `${b.emoji} <b>${b.label}</b> · ${escapeHtml(b.tone)}`;

  // 컨텍스트 라인 — 프로젝트, 세션, 시각
  const ctxParts = [];
  if (project) ctxParts.push(`📂 ${escapeHtml(project)}`);
  if (sess) ctxParts.push(`<code>${sess}</code>`);
  ctxParts.push(`🕐 ${fmtTimeHM()}`);
  const ctx = ctxParts.join(' · ');

  // 본문 — describeToolForHuman 의 풍부한 표현
  const body = describeToolForHuman(record);

  // 사유 박스
  const reason = record.reasoning
    ? `\n<b>💭 사유</b>\n<blockquote>${escapeHtml(record.reasoning)}</blockquote>`
    : '';

  // 메타 (정책, 신뢰도)
  const meta = `📋 ${escapeHtml(policyLabel)} · 신뢰도 <b>${conf}</b>`;

  // 액션 가이드 (block / deny / ask 만)
  let actionHint = '';
  if (dec === 'block' || dec === 'deny') {
    actionHint = `\n<i>⛔ 이 도구 호출은 이미 차단됐어요. 답장으로는 되돌릴 수 없고, 다시 하려면 해당 세션(터미널)에서 재시도하세요. · "왜 막혔어?" 는 물어보셔도 됩니다.</i>`;
  } else if (dec === 'ask') {
    actionHint = `\n<i>💬 버튼을 누르거나 자유롭게 답해주세요 (100초 내)</i>`;
  }

  return (
    `${header}\n` +
    `${ctx}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${body}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${meta}` +
    `${reason}` +
    `${actionHint}`
  );
}

function describeToolForHuman(record) {
  const tool = record.tool || '?';
  const i = record.input || {};
  switch (tool) {
    case 'Bash': {
      const cmd = String(i.command || '');
      const desc = String(i.description || '');
      const truncated = cmd.length > 800;
      const cmdShown = cmd.slice(0, 800) + (truncated ? '\n… (총 ' + cmd.length + '자)' : '');
      const lines = ['⚙️ <b>Bash 명령</b>'];
      if (desc) lines.push(`<i>의도</i> · ${escapeHtml(desc)}`);
      lines.push(`<pre>${escapeHtml(cmdShown)}</pre>`);
      return lines.join('\n');
    }
    case 'Write': {
      const file = String(i.file_path || '');
      const content = String(i.content || '');
      const previewLines = content.split('\n').slice(0, 10);
      const preview = previewLines.join('\n').slice(0, 600);
      const truncated = content.length > preview.length || content.split('\n').length > 10;
      const dir = file.split('/').slice(0, -1).join('/') || '/';
      const name = file.split('/').pop() || file;
      return (
        `📝 <b>새 파일 생성</b>\n` +
        `<i>경로</i> · <code>${escapeHtml(dir)}/</code><b>${escapeHtml(name)}</b>\n` +
        `<i>크기</i> · ${content.length}자 / ${content.split('\n').length}줄\n` +
        `\n<i>미리보기</i>\n<pre>${escapeHtml(preview)}${truncated ? '\n…' : ''}</pre>`
      );
    }
    case 'Edit': {
      const file = String(i.file_path || '');
      const oldS = String(i.old_string || '').slice(0, 280);
      const newS = String(i.new_string || '').slice(0, 280);
      const dir = file.split('/').slice(0, -1).join('/') || '/';
      const name = file.split('/').pop() || file;
      return (
        `✏️ <b>파일 수정</b>\n` +
        `<i>경로</i> · <code>${escapeHtml(dir)}/</code><b>${escapeHtml(name)}</b>\n` +
        `\n<i>이전</i>\n<pre>${escapeHtml(oldS)}</pre>\n` +
        `<i>이후</i>\n<pre>${escapeHtml(newS)}</pre>`
      );
    }
    case 'MultiEdit': {
      const file = String(i.file_path || '');
      const edits = i.edits || [];
      const dir = file.split('/').slice(0, -1).join('/') || '/';
      const name = file.split('/').pop() || file;
      const lines = [
        `✏️✏️ <b>여러 수정</b>`,
        `<i>경로</i> · <code>${escapeHtml(dir)}/</code><b>${escapeHtml(name)}</b>`,
        `<i>변경 수</i> · <b>${edits.length}건</b>`,
      ];
      if (edits[0]) {
        const e = edits[0];
        lines.push(`\n<i>첫 변경</i>\n<pre>${escapeHtml(String(e.old_string || '').slice(0, 180))}</pre>\n↓\n<pre>${escapeHtml(String(e.new_string || '').slice(0, 180))}</pre>`);
      }
      if (edits.length > 1) lines.push(`<i>+ ${edits.length - 1}건 더</i>`);
      return lines.join('\n');
    }
    case 'AskUserQuestion': {
      const q = String(i.question || i.prompt || '').slice(0, 400);
      return `❓ <b>Claude가 사용자에게 질문 요청</b>\n${escapeHtml(q)}`;
    }
    case 'WebSearch':
    case 'WebFetch': {
      const u = String(i.url || i.query || '').slice(0, 300);
      return `🔧 <b>${tool}</b>\n${escapeHtml(u)}`;
    }
    case 'Task':
    case 'Agent': {
      const desc = String(i.description || i.prompt || '').slice(0, 400);
      return `🔧 <b>서브에이전트 실행</b>\n${escapeHtml(desc)}`;
    }
    default: {
      const dump = JSON.stringify(i, null, 2).slice(0, 600);
      return `🔧 <b>${escapeHtml(tool)}</b>\n<pre>${escapeHtml(dump)}</pre>`;
    }
  }
}

export async function askDecision(decisionId, record) {
  if (!isEnabled()) return { ok: false, skipped: 'telegram disabled' };
  const body = describeToolForHuman(record);
  const reason = record.reasoning ? `\n\n⚠️ ${escapeHtml(record.reasoning)}` : '';
  const meta =
    `\n\n신뢰도 ${record.confidence ?? '-'}` +
    (record.sessionId ? ` · 세션 <code>${escapeHtml(String(record.sessionId).slice(0, 8))}</code>` : '') +
    ` · id <code>${decisionId}</code>`;
  const text = `⏸ <b>Claude가 결정 필요</b>\n\n${body}${reason}${meta}`;
  return tgRequest('sendMessage', {
    chat_id: _config.chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ 승인', callback_data: `dec:${decisionId}:approve` },
        { text: '❌ 거부', callback_data: `dec:${decisionId}:deny` },
      ]],
    },
  });
}

export async function editAfterAnswer(messageId, decisionId, record, answer) {
  if (!isEnabled() || !messageId) return;
  const mark = answer === 'approve' ? '✅ 승인됨' : '❌ 거부됨';
  const cmd = record.input?.command || record.input?.file_path || '';
  const short = String(cmd).slice(0, 200);
  const text =
    `${mark} · <code>${escapeHtml(record.tool || '?')}</code>` +
    (short ? `\n<code>${escapeHtml(short)}</code>` : '') +
    `\n\n<i>id ${decisionId}</i>`;
  return tgRequest('editMessageText', {
    chat_id: _config.chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  });
}

export async function answerCallback(callbackQueryId, text) {
  return tgRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '처리 중...',
  });
}

// ─── Agent tool approval (위험 도구 실행 전 사용자 승인) ─────────────────
const _approvalPending = new Map(); // approvalId → { resolve, label, detail, hard }
const APPROVAL_TIMEOUT_MS = 60_000;
let _trustUntil = 0; // ms epoch — 신뢰 윈도우 만료 시각

const AUDIT_LOG_PATH = path.join(__dirname, '..', 'logs', 'approvals.jsonl');

function logApproval(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (e) {
    _logger.error?.('telegram', 'audit log write failed', e.message);
  }
}

export function getTrustState() {
  const remaining = _trustUntil - Date.now();
  return remaining > 0 ? { active: true, remainingMs: remaining } : { active: false, remainingMs: 0 };
}

export function setTrustWindow(ms) {
  _trustUntil = ms > 0 ? Date.now() + ms : 0;
  if (_trustExpiryTimer) { clearTimeout(_trustExpiryTimer); _trustExpiryTimer = null; }
  if (ms > 5 * 60_000) {
    // 만료 5분 전 자동 알림
    _trustExpiryTimer = setTimeout(() => {
      _trustExpiryTimer = null;
      const s = getTrustState();
      if (s.active && s.remainingMs <= 6 * 60_000) {
        sendMessage(`⏰ 신뢰 모드 만료 5분 전입니다.\n연장: <code>/trust 30m</code>  ·  종료: <code>/untrust</code>`, { parseMode: 'HTML', silent: true }).catch(() => {});
      }
    }, ms - 5 * 60_000);
  }
  return getTrustState();
}

/** duration "30m" / "1h" / "2h30m" / "45s" → ms */
function parseDuration(s) {
  if (!s) return 0;
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'h') total += n * 3600_000;
    else if (m[2] === 'm') total += n * 60_000;
    else if (m[2] === 's') total += n * 1000;
  }
  return total;
}

function fmtRemaining(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}분`;
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

export async function requestApproval(label, detail, opts = {}) {
  const hard = Boolean(opts.hard);
  const trust = getTrustState();

  // 신뢰 윈도우 활성 + hard 가 아니면 자동 승인 (로그만 남김)
  if (!hard && trust.active) {
    logApproval({ label, detail, decision: 'trust-auto', remainingMs: trust.remainingMs });
    return true;
  }

  if (!isEnabled()) {
    logApproval({ label, detail, decision: 'deny-no-telegram', hard });
    return false; // fail-closed
  }

  const id = crypto.randomBytes(4).toString('hex');
  return new Promise((resolve) => {
    _approvalPending.set(id, { resolve, label, detail, hard });
    setTimeout(() => {
      const entry = _approvalPending.get(id);
      if (entry) {
        _approvalPending.delete(id);
        logApproval({ label: entry.label, detail: entry.detail, decision: 'timeout', hard: entry.hard });
        entry.resolve(false);
        sendMessage(`⏱ 승인 ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}초 timeout — 거부 처리.`, { silent: true }).catch(() => {});
      }
    }, APPROVAL_TIMEOUT_MS);

    const trustNote = hard && trust.active
      ? `\n⚠️ <i>신뢰 모드 활성 중이지만 hard-risk 라 확인 필요.</i>`
      : '';
    const text =
      `🤖 <b>도구 실행 승인 요청${hard ? ' (HARD)' : ''}</b>\n` +
      `${escapeHtml(label)}\n\n` +
      `<code>${escapeHtml(String(detail).slice(0, 500))}</code>` +
      trustNote;

    tgRequest('sendMessage', {
      chat_id: _config.chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ 승인', callback_data: `apr:${id}:y` },
          { text: '❌ 거부', callback_data: `apr:${id}:n` },
        ]],
      },
    }).catch(() => {});
  });
}

async function handleCallback(cb) {
  _logger.info?.('telegram', `callback: ${cb.data}`);

  // 도구 승인 회수: "apr:<id>:<y|n>"
  if ((cb.data || '').startsWith('apr:')) {
    const [, id, ans] = cb.data.split(':');
    const entry = _approvalPending.get(id);
    if (entry) {
      _approvalPending.delete(id);
      logApproval({
        label: entry.label,
        detail: entry.detail,
        decision: ans === 'y' ? 'user-approve' : 'user-deny',
        hard: entry.hard,
      });
      entry.resolve(ans === 'y');
    }
    return tgRequest('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: ans === 'y' ? '✅ 승인' : '❌ 거부',
    });
  }

  // ask 응답: "ask:<id>:approve|deny|more" — 정확한 매칭
  if ((cb.data || '').startsWith('ask:')) {
    const [, askId, action] = cb.data.split(':');
    const fn = _pendingResolvers.get(askId);
    if (!fn) {
      return tgRequest('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '⌛ 만료되었거나 이미 처리됨',
      });
    }
    _pendingResolvers.delete(askId);
    const answer = action === 'approve' ? '진행해' : action === 'deny' ? '하지 마' : null;
    if (action === 'more') {
      // 더 묻기 — pending 유지하고 사용자에게 자유 텍스트 요청
      _pendingResolvers.set(askId, fn);
      return tgRequest('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '💬 자유롭게 답해주세요 (답장 또는 reply)',
      });
    }
    await tgRequest('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: action === 'approve' ? '✅ 승인 처리 중' : '❌ 거부 처리 중',
    });
    // 메시지 갱신 (버튼 제거 + 결과 표시)
    if (cb.message?.message_id) {
      tgRequest('editMessageReplyMarkup', {
        chat_id: _config.chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    try { await fn(answer); }
    catch (e) { _logger.error?.('telegram', 'ask cb err', e.message); }
    return;
  }

  // supervisor 결정 회수: "dec:<id>:<action>" 패턴은 supervisor에게 위임 (옛 흐름)
  if ((cb.data || '').startsWith('dec:')) {
    for (const fn of _supervisorCallbacks) {
      try { await fn(cb); } catch (e) { _logger.error?.('telegram', 'supervisor cb err', e.message); }
    }
    return;
  }
  return tgRequest('answerCallbackQuery', { callback_query_id: cb.id, text: '처리됨' });
}

// ─── Polling loop ───────────────────────────────────────────────────────

export async function startPolling() {
  if (!isEnabled()) {
    _logger.warn?.('telegram', 'not configured — polling not started');
    return false;
  }
  if (_polling) return true;

  // 백로그 무시: 재시작 후 24시간치 메시지 한꺼번에 처리 방지
  try {
    const initial = await tgRequest('getUpdates', { timeout: 0, limit: 100 });
    if (initial?.result?.length) {
      _offset = initial.result[initial.result.length - 1].update_id + 1;
      _logger.info?.('telegram', `skipped ${initial.result.length} backlog updates, offset=${_offset}`);
    }
  } catch (e) {
    _logger.warn?.('telegram', 'initial offset sync failed', e.message);
  }

  _polling = true;
  _logger.info?.('telegram', 'polling started');

  (async () => {
    while (_polling) {
      try {
        const r = await tgRequest('getUpdates', { offset: _offset, timeout: 25 });
        for (const u of r.result || []) {
          _offset = u.update_id + 1;
          if (u.message) {
            handleMessage(u.message).catch((e) => {
              _logger.error?.('telegram', 'msg handler err: ' + (e?.message || String(e)));
              if (e?.stack) console.error('[telegram stack]', e.stack);
            });
          }
          if (u.callback_query) {
            handleCallback(u.callback_query).catch((e) =>
              _logger.error?.('telegram', 'cb handler err', e.message)
            );
          }
        }
      } catch (e) {
        _logger.error?.('telegram', 'poll err', e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    _logger.info?.('telegram', 'polling stopped');
  })();

  // 첫 시작 시 인사
  sendMessage('🤖 Cockpit 봇 연결됨. /help', { silent: true }).catch(() => {});
  return true;
}

export function stopPolling() {
  _polling = false;
}

export function isPolling() {
  return _polling;
}
