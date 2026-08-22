/**
 * Supervisor LLM — Gemini Flash로 도구 호출 결정.
 *
 *   decideLLM(record)                    — 자동 결정 시도, 결과 JSON
 *   resolveLLM(record, askMsg, answer)   — 사용자 답변 해석 → 최종 결정
 */
import { GeminiClient } from './agent-service.js';
import { getAiConfig } from './config.js';

let _client = null;
let _logger = console;

export function init(opts = {}) {
  _logger = opts.logger || console;
  refreshClient();
}

export function refreshClient() {
  const key = getAiConfig()?.geminiApiKey || null;
  if (!key) { _client = null; return false; }
  _client = new GeminiClient(key, 'gemini-2.5-flash');
  return true;
}

export function isReady() {
  return Boolean(_client);
}

function buildDecideSystem() {
  return `너는 Claude Code 도구 호출 supervisor. **기본은 approve**. 사용자가 시킨 작업으로 가정해.

ask 는 **사용자만이 답할 수 있는** 진짜 의사결정일 때만:
- prod DB 마이그레이션 / 데이터 손실 가능
- prod 배포 / 외부 결제·API 키 발급
- 비밀번호·키 변경

거의 모든 dev 작업은 approve. 단순 서버 재시작, 로컬 파일 작업, 빌드, git 작업 (force-push 빼고) 등 다.

출력 JSON 한 개:
{
  "decision": "approve" | "deny" | "ask",
  "confidence": 0.0~1.0,
  "reasoning": "왜 이 결정인지 한국어 한 문장",
  "ask_message": "decision이 ask일 때만"
}

기준:
- approve: dev 작업 일체 (편집/생성/조회/빌드/테스트/재시작/일반 Bash)
- deny: 명백히 파괴 (rm -rf /, force push to main, drop table, prod 데이터 삭제)
- ask: prod 영향 + 복원 불가 + 사용자 결정이 본질인 거`;
}

const RESOLVE_SYSTEM = `너는 supervisor. 도구 호출에 대해 사용자에게 질문했고, 답변을 받았어. 그 답을 해석해 최종 결정.

출력 JSON 한 개:
{
  "decision": "approve" | "deny",
  "reasoning": "사용자 답변 요약 + 결정 근거 한국어 한 문장"
}

사용자가 "그냥 해", "OK", "응" 등 동의 → approve
사용자가 "안 돼", "ㄴㄴ", "그만" 등 거부 → deny
조건 답변 ("Y는 빼고 해", "A 먼저 확인") → 의도를 reasoning에 적고 decision 결정 (확실치 않으면 deny가 안전)`;

async function callGemini(systemPrompt, userMsg, timeoutMs = 25_000) {
  if (!_client) refreshClient();
  if (!_client) return null;

  let text = '';
  try {
    await _client.send(systemPrompt, userMsg, {
      timeoutMs,
      onStream: ({ type, delta }) => { if (type === 'text') text += (delta || ''); },
    });
  } catch (e) {
    _logger.error?.('supervisor-llm', 'gemini call failed', e.message);
    return null;
  }
  return parseJson(text);
}

function parseJson(text) {
  if (!text) return null;
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = codeBlock ? codeBlock[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function decideLLM(record) {
  const tool = record.tool || '?';
  const input = JSON.stringify(record.input || {}, null, 2).slice(0, 1500);
  const session = record.sessionId ? `\n세션: ${record.sessionId}` : '';
  const userMsg = `도구: ${tool}${session}\n\n입력:\n${input}\n\n결정 JSON으로 응답.`;
  return callGemini(buildDecideSystem(), userMsg);
}

export async function resolveLLM(record, askMessage, userAnswer) {
  const tool = record.tool || '?';
  const input = JSON.stringify(record.input || {}, null, 2).slice(0, 800);
  const userMsg =
    `원래 도구: ${tool}\n입력: ${input}\n\n` +
    `내가 사용자에게 물어본 것:\n${askMessage}\n\n` +
    `사용자 답변:\n${userAnswer}\n\n` +
    `최종 결정 JSON.`;
  return callGemini(RESOLVE_SYSTEM, userMsg, 15_000);
}
