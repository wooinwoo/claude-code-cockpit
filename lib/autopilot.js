/**
 * Autopilot engine — turns the policy classifier into an operating loop.
 *
 * Every proposed tool call flows through decide():
 *   auto      → approve instantly (unattended-safe)
 *   block     → deny (never run)
 *   escalate  → ask a human via the injected channel (phone); deny on timeout
 *   review    → attended: hand back to Claude Code's own prompt ('ask');
 *               unattended: escalate to phone (conservative)
 *
 * The human channel is dependency-injected (askHuman) so the engine is testable
 * without Telegram; server.js wires it to the Telegram bridge.
 */

import { classify } from './autopilot-policy.js';

let _askHuman = null;      // async (prompt: string, ctx) => 'approve' | 'deny'
let _logger = console;
let _mode = 'attended';    // 'attended' (human at screen) | 'unattended' (overnight)

const _metrics = { total: 0, auto: 0, block: 0, escalate: 0, review: 0, asked: 0, approved: 0, denied: 0, timedOut: 0 };
const _sessionLog = [];
const MAX_LOG = 500;
let _startedAt = null;

export function init(opts = {}) {
  if ('askHuman' in opts) _askHuman = opts.askHuman;   // explicit null clears the channel
  if (opts.logger) _logger = opts.logger;
  if (opts.mode) _mode = opts.mode;
  if (!_startedAt) _startedAt = Date.now();
}

export function setMode(m) {
  if (m === 'attended' || m === 'unattended') _mode = m;
  return _mode;
}
export function getMode() { return _mode; }

export function getStatus() {
  return { mode: _mode, startedAt: _startedAt, metrics: { ..._metrics }, recent: _sessionLog.slice(-30) };
}

export function resetSession(now = Date.now()) {
  _sessionLog.length = 0;
  for (const k of Object.keys(_metrics)) _metrics[k] = 0;
  _startedAt = now;
}

function snippet(tool, input) {
  const s = input.command || input.file_path || input.url || '';
  return String(s).replace(/\/home\/[^/]+/, '~').slice(0, 100);
}

function record(entry) {
  _sessionLog.push(entry);
  if (_sessionLog.length > MAX_LOG) _sessionLog.splice(0, _sessionLog.length - MAX_LOG);
}

/**
 * Decide on a proposed tool call.
 * @param {{tool?:string, tool_name?:string, input?:object, tool_input?:object, ts?:number}} event
 * @returns {Promise<{decision:'approve'|'deny'|'ask', action:string, category:string, reason:string}>}
 */
export async function decide(event) {
  const tool = event.tool || event.tool_name || '';
  const input = event.input || event.tool_input || {};
  const ts = event.ts || null;
  const { action, category, reason } = classify(tool, input);
  _metrics.total++;
  _metrics[action] = (_metrics[action] || 0) + 1;

  let decision;
  if (action === 'auto') decision = 'approve';
  else if (action === 'block') decision = 'deny';
  else if (_mode === 'attended') decision = 'ask';   // escalate|review → Claude Code's own on-screen prompt
  else decision = await escalate({ tool, input, action, category, reason });   // unattended → phone

  record({ ts, tool, action, decision, category, reason, snippet: snippet(tool, input) });
  return { decision, action, category, reason };
}

function formatPrompt({ tool, input, category, reason }) {
  return `🤖 승인 필요 (${category})\n도구: ${tool}\n${snippet(tool, input)}\n사유: ${reason}\n→ 진행할까요?`;
}

async function escalate(ctx) {
  if (!_askHuman) {
    // No phone channel: unattended must fail safe (deny); attended hands to screen.
    return _mode === 'unattended' ? 'deny' : 'ask';
  }
  _metrics.asked++;
  try {
    const ans = await _askHuman(formatPrompt(ctx), ctx);
    const ok = ans === 'approve' || ans === true;
    if (ok) _metrics.approved++; else _metrics.denied++;
    return ok ? 'approve' : 'deny';
  } catch (err) {
    _metrics.timedOut++;
    _logger.warn?.('autopilot', 'escalation failed/timeout → deny', err?.message);
    return 'deny';
  }
}

/**
 * Build a morning briefing from the current session log.
 * @returns {{summary:string, ran:number, escalations:number, approved:number, denied:number, blocked:number, timedOut:number, byCategory:Object, notable:Array}}
 */
export function buildBriefing() {
  const m = _metrics;
  const byCategory = {};
  const notable = [];
  for (const e of _sessionLog) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    if (e.action === 'escalate' || e.action === 'block') {
      notable.push({ decision: e.decision, tool: e.tool, category: e.category, snippet: e.snippet });
    }
  }
  const dur = _startedAt ? Math.round((Date.now() - _startedAt) / 60000) : 0;
  const lines = [
    `🌅 오토파일럿 브리핑 (${_mode}, ${dur}분 가동)`,
    `• 자동 실행 ${m.auto} · 검토 위임 ${m.review} · 차단 ${m.block}`,
    `• 폰 승인요청 ${m.asked} → 승인 ${m.approved} / 거부 ${m.denied} / 무응답 ${m.timedOut}`,
  ];
  if (notable.length) {
    lines.push('• 주요 결정:');
    for (const n of notable.slice(0, 8)) lines.push(`   ${n.decision === 'approve' ? '✅' : n.decision === 'deny' ? '⛔' : '⏸'} [${n.category}] ${n.snippet}`);
  }
  return {
    summary: lines.join('\n'),
    ran: m.auto, escalations: m.asked, approved: m.approved, denied: m.denied,
    blocked: m.block, timedOut: m.timedOut, byCategory, notable,
  };
}
