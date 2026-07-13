/**
 * Autonomy Scheduler — 시간 기반 자동 트리거.
 *
 * 사용자가 텔레그램에서 /schedule add "09:00 daily" "어제 빌드 점검" 등록.
 * 60초마다 모든 등록 스케줄을 검사, 매칭되면 콕사원에게 prompt 던지고
 * 결과를 텔레그램으로 송신.
 *
 * 패턴:
 *   "HH:MM daily"   — 매일 HH:MM
 *   "every Nm"      — N분마다
 *   "every Nh"      — N시간마다
 *   "HH:MM weekday" — 평일 (월~금) HH:MM
 *
 * 의존성:
 *   - telegram-bridge: sendMessage, sendTyping, waitForAgent (간접), lastAssistantMessage
 *   - agent-service: chat, newConversation, getConversation, isRunning
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = path.join(__dirname, '..', 'logs', 'scheduled-tasks.json');

let _agent = null;        // { chat, getConversation, isRunning, newConversation }
let _telegram = null;     // { sendMessage, sendTyping }
let _logger = console;
let _schedules = [];      // [{ id, pattern, prompt, project?, enabled, lastRun, created }]
let _tickTimer = null;

export function init({ agent, telegram, logger }) {
  _agent = agent;
  _telegram = telegram;
  _logger = logger || console;
  load();
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = setInterval(tick, 60_000); // 60초마다
  _logger.info?.('scheduler', `loaded ${_schedules.length} schedules`);
  // 부팅 5초 후 한번 검사 (놓친 일정 catch-up)
  setTimeout(tick, 5_000);
}

export function shutdown() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function load() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) { _schedules = []; return; }
    _schedules = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    if (!Array.isArray(_schedules)) _schedules = [];
  } catch (e) {
    _logger.error?.('scheduler', 'load failed', e.message);
    _schedules = [];
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(_schedules, null, 2));
  } catch (e) {
    _logger.error?.('scheduler', 'save failed', e.message);
  }
}

export function add(pattern, prompt, opts = {}) {
  const id = crypto.randomBytes(3).toString('hex');
  const s = {
    id,
    pattern: String(pattern).trim(),
    prompt: String(prompt).trim(),
    project: opts.project || null,
    enabled: true,
    lastRun: null,
    created: new Date().toISOString(),
  };
  _schedules.push(s);
  save();
  return s;
}

export function list() {
  return [..._schedules];
}

export function remove(id) {
  const before = _schedules.length;
  _schedules = _schedules.filter((s) => s.id !== id);
  if (_schedules.length !== before) { save(); return true; }
  return false;
}

export function toggle(id) {
  const s = _schedules.find((x) => x.id === id);
  if (!s) return null;
  s.enabled = !s.enabled;
  save();
  return s;
}

// 패턴 매칭 — 현재 시각 기준 실행 시점인지 판단
function matches(s, now) {
  if (!s.enabled) return false;
  const lastRunMs = s.lastRun ? new Date(s.lastRun).getTime() : 0;
  const nowMs = now.getTime();

  // every Nm / Nh
  let m = s.pattern.match(/^every\s+(\d+)\s*(m|h)$/i);
  if (m) {
    const intervalMs = parseInt(m[1], 10) * (m[2].toLowerCase() === 'h' ? 3600_000 : 60_000);
    return nowMs - lastRunMs >= intervalMs;
  }

  // HH:MM daily | HH:MM weekday
  m = s.pattern.match(/^(\d{1,2}):(\d{2})\s+(daily|weekday)$/i);
  if (m) {
    const targetH = parseInt(m[1], 10);
    const targetM = parseInt(m[2], 10);
    const mode = m[3].toLowerCase();
    if (now.getHours() !== targetH || now.getMinutes() !== targetM) return false;
    if (mode === 'weekday' && (now.getDay() === 0 || now.getDay() === 6)) return false;
    // 오늘 이미 실행했는지
    if (s.lastRun) {
      const last = new Date(s.lastRun);
      if (last.toDateString() === now.toDateString()) return false;
    }
    return true;
  }

  return false;
}

async function execute(s) {
  if (!_agent?.chat || !_telegram?.sendMessage) {
    _logger.warn?.('scheduler', 'agent or telegram not ready');
    return;
  }
  s.lastRun = new Date().toISOString();
  save();

  const header = `⏰ <b>자율 트리거</b>\n` +
                 `📋 ${escapeHtml(s.pattern)} · #${s.id}\n` +
                 `🎯 ${escapeHtml(s.prompt)}`;
  await _telegram.sendMessage(header, { parseMode: 'HTML', silent: true }).catch(() => {});

  try {
    const conv = _agent.newConversation();
    const convId = conv?.id || conv?.convId || `sched-${s.id}-${Date.now()}`;
    const projHint = s.project ? `\n\n[프로젝트 hint] ${s.project}` : '';
    const prompt = `[자율 스케줄 실행 — pattern: ${s.pattern}]\n${s.prompt}${projHint}`;
    _agent.chat(convId, prompt);
    _telegram.sendTyping?.().catch(() => {});

    // 응답 대기 — 최대 5분 (긴 작업 허용)
    const start = Date.now();
    while (_agent.isRunning(convId)) {
      if (Date.now() - start > 5 * 60_000) {
        await _telegram.sendMessage(`⌛ 스케줄 #${s.id} 5분 초과. 백그라운드 진행 중일 수 있음.`).catch(() => {});
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const conv2 = _agent.getConversation(convId);
    if (conv2?.messages?.length) {
      // 마지막 assistant 메시지
      for (let i = conv2.messages.length - 1; i >= 0; i--) {
        const m = conv2.messages[i];
        if (m.role !== 'user') {
          await _telegram.sendMessage(m.content || m.text || '(빈 응답)').catch(() => {});
          break;
        }
      }
    }
  } catch (e) {
    _logger.error?.('scheduler', `execute #${s.id} failed`, e.message);
    await _telegram.sendMessage(`❌ 스케줄 #${s.id} 실행 실패: ${e.message}`).catch(() => {});
  }
}

async function tick() {
  const now = new Date();
  for (const s of _schedules) {
    try {
      if (matches(s, now)) {
        _logger.info?.('scheduler', `firing #${s.id}: ${s.pattern}`);
        await execute(s);
      }
    } catch (e) {
      _logger.error?.('scheduler', `tick err #${s.id}`, e.message);
    }
  }
}

export async function runNow(id) {
  const s = _schedules.find((x) => x.id === id);
  if (!s) return null;
  await execute(s);
  return s;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
