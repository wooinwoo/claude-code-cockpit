/**
 * Supervisor — Claude Code 권한 요청 자동 결정.
 *
 *   1) 빠른 룰: safelist/blacklist 즉시 결정
 *   2) 모호하면 LLM(Gemini Flash)이 평가
 *   3) LLM도 ask면 텔레그램으로 자연어 질문 → 사용자 자유 텍스트 답변 → LLM이 해석
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as llm from './supervisor-llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECISIONS_LOG = path.join(__dirname, '..', 'logs', 'decisions.jsonl');
const HUMAN_TIMEOUT_MS = 100_000; // hook timeout(120s) 안에 들어오게 100초

const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebFetch', 'WebSearch',
  'TodoWrite', 'AskUserQuestion',
]);
// Edit/Write 류는 일반 경로면 safe, 위험 경로면 block — 따로 검사
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// approve 라도 텔레그램 알림 가치 있는 "활동성" 도구 (away 모드에서만)
const NOISY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// 위험 파일 경로 — 절대 직접 수정 금지
const DANGER_PATHS = [
  /^\/etc\//, /^\/usr\//, /^\/boot\//, /^\/bin\//, /^\/sbin\//, /^\/var\/lib\//,
  /^\/root\//, /\/\.ssh\//, /\/\.aws\//, /\/\.gnupg\//, /\/\.docker\/config\.json$/,
  /\/id_rsa(\.pub)?$/, /\/id_ed25519(\.pub)?$/, /\/\.bash_history$/,
  /\.env(\.|$)/, /\/credentials(\.json)?$/, /\.pem$/, /\.key$/, /\.crt$/,
];

function isDangerPath(p) {
  if (!p) return false;
  return DANGER_PATHS.some((r) => r.test(p));
}
const DANGER_PATTERNS = [
  // 파일시스템 파괴
  /\brm\s+-rf?\s+\//,
  /\brm\s+-rf?\s+~/,
  /\brm\s+-rf?\s+\$HOME/,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
  /\bmkfs\./,
  /\bdd\s+if=.*of=\/dev/,
  />\s*\/dev\/sd[a-z]/,
  // 권한 상승 / 시스템 변경
  /\bsudo\s+(rm|chmod|chown|dd|mkfs|systemctl|service|reboot|shutdown|halt|poweroff|kill)/,
  /\bsudo\s+-(i|s)\b/,
  /\bchmod\s+-?R?\s*[0-7]{3,4}\s+\//,
  /\bchown\s+-?R?\s*root\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\bkill\s+-9\s+1\b/,
  /\binit\s+[06]\b/,
  // 네트워크 / 방화벽 / cron
  /\biptables\s+.*-j\s+DROP/i,
  /\bufw\s+(disable|delete)\b/i,
  /\bcrontab\s+-r\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bservice\s+\S+\s+(stop|disable)\b/,
  // git 파괴
  /\bgit\s+push\s+--force(?!-with-lease)/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\s+(origin|HEAD~|[0-9a-f]{7,})/,
  /\bgit\s+clean\s+-[fdx]+/,
  /\bgit\s+filter-(branch|repo)/,
  // 패키지 / 배포
  /\bnpm\s+publish\b/, /\bnpm\s+unpublish\b/,
  /\bnpm\s+install\s+(-g|--global)\b/,
  /\bnpm\s+uninstall\b/,
  /\bpnpm\s+(publish|unpublish)\b/,
  /\byarn\s+publish\b/,
  /\bpip\s+install\s+--user\b/,
  /\bcurl\s+[^|]*\|\s*(bash|sh|zsh)\b/,
  /\bwget\s+[^|]*\|\s*(bash|sh|zsh)\b/,
  // DB
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)/i,
  /\bTRUNCATE\s+TABLE/i,
  /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i, // WHERE 없는 DELETE
];
// 진짜 read-only 또는 거의 안전한 것만. 나머지는 LLM에 위임.
const SAFE_BASH = /^(ls|pwd|cat|head|tail|echo|jq|find|grep|rg|wc|stat|file|which|env|date|whoami|hostname|uname|tree|du|df|ps|node\s+--version|npm\s+(test|run|ls|outdated|view|info|whoami)|pnpm\s+(test|run|ls|outdated|view|info|why)|yarn\s+(test|run|info|why)|git\s+(status|log|diff|branch|show|fetch|remote))(\s|$)/;

let _telegram = null;
let _logger = console;
let _mode = 'here'; // 'here' (사용자 옆에 있음, 알림 최소) | 'away' (자리 비움, ask 적극)

export function getMode() { return _mode; }
export function setMode(mode) {
  _mode = mode === 'away' ? 'away' : 'here';
  return _mode;
}

export function init(opts = {}) {
  _telegram = opts.telegram || null;
  _logger = opts.logger || console;
  ensureLogDir();
  if (_telegram?.onSupervisorCallback) {
    _telegram.onSupervisorCallback(handleHumanButton); // 옛 inline 버튼 호환
  }
}

function ensureLogDir() {
  try { fs.mkdirSync(path.dirname(DECISIONS_LOG), { recursive: true }); } catch {}
}

function decideRule(event) {
  const tool = event.tool_name || event.tool || 'Unknown';
  const input = event.tool_input || event.input || {};

  if (SAFE_TOOLS.has(tool)) {
    return { decision: 'approve', confidence: 0.99, reasoning: `${tool} is read-only/safe`, policy: 'safelist' };
  }
  // Edit / Write 류 — 위험 경로면 block, 아니면 approve
  if (EDIT_TOOLS.has(tool)) {
    const filePath = input.file_path || input.notebook_path || '';
    if (isDangerPath(filePath)) {
      return { decision: 'block', confidence: 0.99, reasoning: `dangerous path: ${filePath}`, policy: 'danger-path' };
    }
    return { decision: 'approve', confidence: 0.95, reasoning: `${tool} on safe path`, policy: 'safelist' };
  }
  if (tool === 'Bash') {
    const cmd = input.command || '';
    for (const pat of DANGER_PATTERNS) {
      if (pat.test(cmd)) {
        return { decision: 'block', confidence: 0.99, reasoning: `danger pattern: ${pat}`, policy: 'blacklist' };
      }
    }
    if (SAFE_BASH.test(cmd)) {
      return { decision: 'approve', confidence: 0.9, reasoning: 'common safe bash', policy: 'safelist' };
    }
  }
  return { decision: 'unsure', confidence: 0, reasoning: 'no rule matched', policy: 'rule-fallthrough' };
}

function logDecision(record) {
  try {
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify(record) + '\n');
  } catch (e) {
    _logger.error?.('supervisor', 'log write failed', e.message);
  }
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

// 인라인 버튼 흐름 (옛 호환, 새 LLM 흐름에선 안 씀)
const pendingButtons = new Map();
async function handleHumanButton(cb) {
  const [tag, id, action] = (cb.data || '').split(':');
  if (tag !== 'dec') return;
  const entry = pendingButtons.get(id);
  if (!entry) {
    await _telegram?.answerCallback?.(cb.id, '⌛ 만료');
    return;
  }
  pendingButtons.delete(id);
  clearTimeout(entry.timer);
  const decision = action === 'approve' ? 'approve' : 'block';
  await _telegram?.answerCallback?.(cb.id, action);
  await _telegram?.editAfterAnswer?.(entry.messageId, id, entry.record, action);
  entry.resolve({ ...entry.record, decision, policy: 'human-button', humanResponse: action });
}

// 자연어 흐름 (LLM이 ask 결정 시)
async function askHumanText(record) {
  if (!_telegram?.sendAskMessage || !_telegram?.registerPendingResolver) {
    _logger.warn?.('supervisor', 'no text channel — fallback to deny');
    return { ...record, decision: 'deny', reasoning: 'no human channel — deny', policy: 'no-channel' };
  }

  const id = newId();
  const askMsg = record.askMessage || record.reasoning || '결정이 필요해요. 어떻게 할까요?';

  await _telegram.sendAskMessage(askMsg, id, record).catch((e) =>
    _logger.error?.('supervisor', 'sendAskMessage failed', e.message)
  );
  _logger.info?.('supervisor', `asking human via text (id=${id})`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _telegram?.clearPendingResolver?.(id);
      _logger.info?.('supervisor', `timeout (id=${id}) → deny`);
      resolve({ ...record, decision: 'deny', reasoning: `no human answer in ${Math.round(HUMAN_TIMEOUT_MS / 1000)}s`, policy: 'timeout-deny' });
    }, HUMAN_TIMEOUT_MS);

    _telegram.registerPendingResolver(id, async (userAnswer) => {
      clearTimeout(timer);
      _logger.info?.('supervisor', `human answered (id=${id}): ${String(userAnswer).slice(0, 80)}`);
      const resolved = await llm.resolveLLM(record, askMsg, userAnswer).catch(() => null);
      if (!resolved) {
        // LLM 실패 시 단어 매칭 fallback
        const ans = String(userAnswer || '').toLowerCase().trim();
        const yes = /\b(yes|ok|응|네|그래|진행|해|hae|go|approve|승인)\b/.test(ans) || ans === 'y';
        const no = /\b(no|안|그만|stop|deny|거부|ㄴㄴ|취소)\b/.test(ans) || ans === 'n';
        const decision = yes ? 'approve' : no ? 'deny' : 'deny';
        await _telegram?.sendMessage?.(`결정: ${decision === 'approve' ? '✅ 진행' : '❌ 중단'} (LLM 해석 실패, 단어 매칭)`).catch(() => {});
        resolve({ ...record, decision, reasoning: `keyword fallback: ${ans.slice(0, 80)}`, policy: 'keyword-fallback', userAnswer });
        return;
      }
      const finalDecision = resolved.decision === 'approve' ? 'approve' : 'deny';
      await _telegram?.sendMessage?.(`결정: ${finalDecision === 'approve' ? '✅ 진행' : '❌ 중단'}\n사유: ${resolved.reasoning}`).catch(() => {});
      resolve({
        ...record,
        decision: finalDecision,
        reasoning: resolved.reasoning,
        policy: 'llm-resolved',
        userAnswer,
      });
    });
  });
}

export async function decide(event) {
  let record = {
    ts: new Date().toISOString(),
    tool: event.tool_name || event.tool || null,
    input: event.tool_input || event.input || null,
    sessionId: event.session_id || null,
    cwd: event.cwd || null,
  };

  const ruled = decideRule(event);
  if (ruled.decision === 'approve' || ruled.decision === 'block') {
    record = { ...record, ...ruled };
    logDecision(record);
    // block 만 알림 (silent, push X). approve 는 사용자 의사결정 불필요 → skip
    if (ruled.decision === 'block' && _telegram?.notifyDecision) {
      _telegram.notifyDecision(record).catch((err) => {
        _logger.error?.('supervisor', `notifyDecision (block) failed: ${err?.message || err}`);
      });
    }
    return formatResult(record);
  }

  // 룰 모호 → LLM에게
  if (llm.isReady()) {
    const llmResult = await llm.decideLLM(record).catch(() => null);
    if (llmResult) {
      record = {
        ...record,
        decision: llmResult.decision,
        confidence: llmResult.confidence ?? 0.5,
        reasoning: llmResult.reasoning || 'llm decided',
        askMessage: llmResult.ask_message || null,
        policy: 'llm',
      };
    } else {
      _logger.warn?.('supervisor', 'LLM failed, fallback to deny');
      record = { ...record, decision: 'deny', reasoning: 'LLM unavailable, conservative deny', policy: 'llm-fail-deny' };
    }
  } else {
    // LLM 미설정 → 보수적 deny
    record = { ...record, decision: 'deny', reasoning: 'no LLM, no rule match', policy: 'no-llm' };
  }

  // LLM 자체가 ask 결정.
  // AWAY(자리 비움) → 텔레그램으로 버튼/자연어 승인 요청 (최대 100초 대기).
  // HERE(자리에 있음) → 텔레그램으로 블록하지 않고 Claude 기본 화면 프롬프트로 위임 (ask 유지).
  if (record.decision === 'ask') {
    if (_mode === 'away') {
      record = await askHumanText(record);
    } else {
      record = { ...record, policy: 'here-passthrough', reasoning: `${record.reasoning || ''} (HERE: 화면 프롬프트로 위임)`.trim() };
    }
    record.ts = new Date().toISOString();
  }

  logDecision(record);

  // LLM 결정 — block/deny 만 알림 (silent). approve 는 의사결정 불필요 → skip.
  const shouldNotifyLlm = record.decision === 'block' || record.decision === 'deny';
  if (shouldNotifyLlm && _telegram?.notifyDecision) {
    _telegram.notifyDecision(record).catch((err) => {
      _logger.error?.('supervisor', `notifyDecision (llm-${record.decision}) failed: ${err?.message || err}`);
    });
  }

  return formatResult(record);
}

function formatResult(record) {
  // hook 스크립트가 처리하는 형식: approve / block만. deny → block 매핑.
  const decision =
    record.decision === 'deny' || record.decision === 'block' ? 'block'
    : record.decision === 'approve' ? 'approve'
    : 'ask';
  return {
    decision,
    confidence: record.confidence,
    reasoning: record.reasoning,
    policy: record.policy,
    userAnswer: record.userAnswer || null,
  };
}

export function getRecentDecisions(n = 20) {
  if (!fs.existsSync(DECISIONS_LOG)) return [];
  return fs.readFileSync(DECISIONS_LOG, 'utf8').split('\n').filter(Boolean).slice(-n)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function getPendingCount() {
  return pendingButtons.size;
}

// 활동성 hook (SessionStart / Stop / UserPromptSubmit / Notification) → 텔레그램 broadcast
const EVENT_EMOJI = {
  SessionStart: '🚀', Stop: '✅', SubagentStop: '🔚',
  UserPromptSubmit: '💬', Notification: '🔔', PreCompact: '🗜',
};
const _eventCounts = new Map(); // sessionId → { tool_uses, last_ts }
const _notifLastSent = new Map(); // sessionId → timestamp (Notification dedupe)
const NOTIF_COOLDOWN_MS = 15 * 60_000; // 같은 세션에서 15분 이내 재알림 X
export async function notifyEvent(event) {
  const type = event.hook_event_name || event.type || 'Event';
  const sessionId = event.session_id || null;
  const cwd = event.cwd || null;
  const project = cwd ? cwd.split('/').filter(Boolean).pop() : null;
  const sess = sessionId ? sessionId.slice(0, 8) : null;
  const emoji = EVENT_EMOJI[type] || '•';

  // ── 노이즈 필터 (사용자 의사결정 필요한 것만 통과) ──
  // 의사결정 불필요한 이벤트 → skip
  if (type === 'UserPromptSubmit') return { ok: true, skipped: 'echo' };
  if (type === 'SessionStart') {
    _eventCounts.set(sessionId, { tool_uses: 0, start: Date.now() });
    return { ok: true, skipped: 'self-action' };
  }
  if (type === 'Stop' || type === 'SubagentStop') {
    _eventCounts.delete(sessionId);
    _notifLastSent.delete(sessionId);
    return { ok: true, skipped: 'no-decision-needed' };
  }
  if (type === 'PreCompact') return { ok: true, skipped: 'auto' };
  // Notification — Claude 가 입력 기다림.
  // HERE 모드(자리에 있음)에선 텔레그램 알림 X — 콕핏 화면에서 직접 보면 됨. AWAY 일 때만 발신.
  if (type === 'Notification') {
    if (_mode !== 'away') return { ok: true, skipped: 'here-mode' };
    // 같은 세션 15분 cooldown 으로 도배 방지.
    const last = _notifLastSent.get(sessionId) || 0;
    if (Date.now() - last < NOTIF_COOLDOWN_MS) {
      return { ok: true, skipped: 'cooldown' };
    }
    _notifLastSent.set(sessionId, Date.now());
  }

  const headerCtx = project ? `📂 ${project}` : '';
  const headerSess = sess ? ` · <code>${sess}</code>` : '';

  let body = '';
  if (type === 'SessionStart') {
    const source = event.source || 'startup';
    body = `\n시작: ${escapeMini(source)}`;
    _eventCounts.set(sessionId, { tool_uses: 0, start: Date.now() });
  } else if (type === 'Stop' || type === 'SubagentStop') {
    const stats = _eventCounts.get(sessionId);
    const dur = stats?.start ? Math.round((Date.now() - stats.start) / 1000) : 0;
    const tools = stats?.tool_uses ?? 0;
    body = `\n⏱ ${dur}s · 🛠 ${tools}회`;
    _eventCounts.delete(sessionId);
  } else if (type === 'Notification') {
    const msg = String(event.message || '').slice(0, 280);
    body = msg ? `\n${escapeMini(msg)}` : '';
  } else if (type === 'PreCompact') {
    body = '\n대화 컨텍스트 압축 중…';
  }

  const text = `${emoji} <b>${escapeMini(type)}</b>${headerCtx ? '\n' + headerCtx + headerSess : headerSess ? '\n' + headerSess : ''}${body}`;

  // push: Stop / Notification. silent: 나머지.
  const silent = !(type === 'Stop' || type === 'Notification');
  try {
    await _telegram?.sendMessage?.(text, { parseMode: 'HTML', silent });
  } catch (e) {
    _logger.error?.('supervisor', `notifyEvent (${type}) failed: ${e?.message || e}`);
  }
  return { ok: true };
}

// PostToolUse 카운터 증가용
export function bumpToolUse(sessionId) {
  if (!sessionId) return;
  const s = _eventCounts.get(sessionId) || { tool_uses: 0, start: Date.now() };
  s.tool_uses++;
  _eventCounts.set(sessionId, s);
}

function escapeMini(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
