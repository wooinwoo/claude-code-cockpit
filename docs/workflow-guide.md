# LangGraph.js + Claude/Gemini 멀티 에이전트 워크플로우

JSON으로 워크플로우를 정의하면 LangGraph.js가 실행하는 멀티 에이전트 파이프라인.
Claude Code CLI (OAuth) + Gemini API 두 가지 LLM 프로바이더를 지원한다.

---

## 1. 프로젝트 셋업

### 1-1. 초기화

```bash
mkdir my-workflow && cd my-workflow
npm init -y
```

`package.json`:
```json
{
  "name": "my-workflow",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "debate": "node index.js workflows/debate.json",
    "review": "node index.js workflows/code-review.json"
  },
  "dependencies": {
    "@langchain/core": "^1.1.26",
    "@langchain/langgraph": "^1.1.5",
    "@langchain/google-genai": "^2.1.19"
  }
}
```

```bash
npm install
```

### 1-2. 디렉토리 구조

```
my-workflow/
├── package.json
├── index.js              # CLI 진입점 — 워크플로우 JSON 로드 & 실행
├── lib/
│   ├── engine.js          # LangGraph 실행 엔진 (핵심)
│   ├── providers.js       # Claude CLI + Gemini API 호출
│   └── utils.js           # 템플릿 치환, 정규식 검증
└── workflows/             # 워크플로우 정의 JSON
    ├── debate.json
    ├── code-review.json
    └── research-report.json
```

### 1-3. 전제 조건

| 항목 | 설명 |
|------|------|
| **Node.js** | v18+ (ES Modules, fetch, AbortSignal 사용) |
| **Claude Code CLI** | 아래 인증 가이드 참고 |
| **Gemini API Key** | [Google AI Studio](https://aistudio.google.com/apikey)에서 발급, `GEMINI_API_KEY` 환경변수 |

### 1-4. Claude Code CLI 설치 & OAuth 인증

Claude Code는 Anthropic API 키가 아닌 **OAuth (claude.ai 계정)** 로 인증한다.
`claude.ai` Pro/Max 구독이 있으면 별도 API 크레딧 없이 사용 가능.

#### 설치

```bash
# npm 글로벌 설치
npm install -g @anthropic-ai/claude-code
```

#### 인증 (최초 1회)

```bash
# OAuth 로그인 — 브라우저가 열리고 claude.ai 계정으로 로그인
claude auth login

# SSO 로그인 (조직 계정)
claude auth login --sso

# 이메일 미리 입력
claude auth login --email user@company.com
```

실행하면:
1. 브라우저가 열림 → claude.ai 로그인 페이지
2. 계정으로 로그인 (Google/이메일)
3. "Claude Code에 권한 부여" 승인
4. 터미널에 "Logged in successfully" 표시
5. 토큰이 `~/.claude/` 에 자동 저장됨

#### 인증 상태 확인

```bash
claude auth status
```

출력 예시:
```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "user@company.com",
  "subscriptionType": "max"
}
```

#### 인증 방식 비교

| 방식 | 설정 | 비용 | 추천 |
|------|------|------|------|
| **OAuth (claude.ai)** | `claude auth login` | Pro $20/월, Max $100/월 구독에 포함 | **추천** — 별도 API 비용 없음 |
| **API Key** | `ANTHROPIC_API_KEY` 환경변수 | 토큰 사용량 기반 종량제 | 대량/자동화용 |

이 워크플로우 엔진은 CLI의 `-p` (print) 모드를 사용하므로, OAuth 로그인만 되어 있으면 추가 설정 없이 동작한다.

#### 로그아웃

```bash
claude auth logout
```

#### 동작 확인

```bash
# 간단한 테스트 — 응답이 stdout에 출력되면 정상
echo "Hello" | claude -p --model haiku
```

---

## 2. 라이브러리

```
npm install @langchain/core @langchain/langgraph @langchain/google-genai
```

| 패키지 | 버전 | 역할 |
|--------|------|------|
| `@langchain/langgraph` | ^1.1.5 | StateGraph, Annotation, START/END, MemorySaver — 그래프 실행 엔진 |
| `@langchain/core` | ^1.1.26 | LangChain 공통 인터페이스 (langgraph가 의존) |
| `@langchain/google-genai` | ^2.1.19 | `ChatGoogleGenerativeAI` — Gemini API LangChain 래퍼 |

Claude는 **추가 라이브러리 불필요**. Claude Code CLI (`claude -p`)를 `child_process.spawn`으로 호출한다.
CLI가 OAuth 인증을 자체 관리하므로 API 키가 필요 없다.

---

## 3. 소스 코드

### 3-1. `lib/providers.js` — LLM 프로바이더

```js
// lib/providers.js
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

// ─── Claude: CLI spawn 방식 (OAuth 자동) ───

/**
 * @param {string} prompt
 * @param {object} opts
 * @param {number} opts.timeoutMs - 타임아웃 (기본 120초)
 * @param {string} opts.model - haiku | sonnet | opus
 * @param {string} opts.systemPrompt - 시스템 프롬프트
 * @param {string[]} opts.tools - 허용할 도구 목록 (예: ["WebSearch", "WebFetch"])
 */
export function callClaude(prompt, { timeoutMs = 120000, model = 'sonnet', systemPrompt, tools } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // Claude Code 내부에서 재귀 호출 방지

    // Windows: node.exe로 cli.js 직접 호출 (cmd.exe 인코딩 문제 회피)
    // Mac/Linux: claude 바이너리 직접 호출
    let bin, args;
    if (process.platform === 'win32') {
      const nodeExe = process.execPath;
      const cliJs = join(dirname(nodeExe), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      bin = nodeExe;
      args = [cliJs, '-p', '--model', model];
    } else {
      bin = 'claude';
      args = ['-p', '--model', model];
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // 도구 허용 (WebSearch, WebFetch 등)
    if (tools && tools.length > 0) {
      args.push('--allowedTools', tools.join(','));
      args.push('--permission-mode', 'dontAsk');
    }

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false, // 중요: shell을 거치지 않아야 유니코드 안전
      env
    });

    let stdout = '', stderr = '', done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Claude CLI timed out (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve(stdout.trim());
    });

    // 프롬프트를 stdin으로 전달 (args가 아님 — 길이 제한 없음)
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ─── Gemini: LangChain 래퍼 방식 (API Key) ───

export async function callGemini(prompt, { model = 'gemini-2.0-flash', maxTokens = 8192 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수를 설정하세요.');

  const llm = new ChatGoogleGenerativeAI({ model, apiKey, maxOutputTokens: maxTokens });
  const resp = await llm.invoke([{ role: 'user', content: prompt }]);
  return typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
}
```

**Claude CLI 핵심 포인트:**
- `claude -p` = non-interactive print 모드, stdout에 결과 출력
- `--model haiku|sonnet|opus` 모델 선택
- `--system-prompt "..."` 시스템 프롬프트 전달
- 프롬프트는 **stdin으로 전달** — 길이 제한 없음 (args로 넘기면 OS 제한에 걸림)
- `delete env.CLAUDECODE` — Claude Code 세션 안에서 실행 시 재귀 방지
- OAuth 토큰은 `~/.claude/`에서 CLI가 자동 관리 — 별도 설정 불필요
- Windows에서는 `shell: false` + `node cli.js` 직접 호출 (cmd.exe 유니코드 문제 회피)

**Gemini 핵심 포인트:**
- `GEMINI_API_KEY` 환경변수 또는 `.env` 파일로 관리
- Claude 대비 빠르고 저렴. 순환 워크플로우에 적합
- 모델: `gemini-2.0-flash` (초고속), `gemini-2.5-flash` (균형), `gemini-2.5-pro` (고품질)


### 3-2. `lib/utils.js` — 유틸리티

```js
// lib/utils.js

// {{variable}} 템플릿 → 실제 값으로 치환
export function resolve(template, ctx) {
  if (!template || typeof template !== 'string') return template || '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx[key];
    return val !== undefined ? String(val) : '';
  });
}

// LangGraph state → 일반 객체
export function stateToPlain(state, inputs) {
  const plain = { ...inputs };
  if (state && typeof state === 'object') {
    for (const [k, v] of Object.entries(state)) {
      if (k !== '_lastOutput' && v) plain[k] = v;
    }
  }
  return plain;
}

// 정규식 ReDoS 방지 검증
export function isSafeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) return false;
  // 중첩 수량자 차단: (a+)+, (a*)+, (.+)* → catastrophic backtracking
  if (/(\+|\*|\{)\)(\+|\*|\{|\?)/.test(pattern)) return false;
  return true;
}
```


### 3-3. `lib/engine.js` — LangGraph 실행 엔진

```js
// lib/engine.js
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import { callClaude, callGemini } from './providers.js';
import { resolve, stateToPlain, isSafeRegex } from './utils.js';

/**
 * 워크플로우 JSON 정의를 받아 LangGraph로 실행한다.
 *
 * @param {object} def - 워크플로우 JSON (steps, edges, inputs 등)
 * @param {object} inputs - 사용자 입력 값 { topic: "...", code: "..." }
 * @param {object} opts - { onStep, onRouting, onDone, onError }
 */
export async function runWorkflow(def, inputs = {}, opts = {}) {
  const { onStep, onRouting, onDone, onError } = opts;

  // ─── 1. State 정의: 각 step.outputKey를 채널로 등록 ───

  const channels = {};
  for (const step of def.steps) {
    if (step.outputKey) {
      channels[step.outputKey] = Annotation({
        reducer: (x, y) => y ?? x, // 항상 최신 값으로 덮어씀
        default: () => ''
      });
    }
  }
  // 조건 분기용 내부 채널
  channels._lastOutput = Annotation({
    reducer: (x, y) => y ?? x,
    default: () => ''
  });

  const GraphState = Annotation.Root(channels);
  const builder = new StateGraph(GraphState);

  // ─── 2. 노드 등록 ───

  // step.id와 state 채널명 충돌 방지 → n_ 접두어
  const nid = (id) => `n_${id}`;

  for (const step of def.steps) {
    builder.addNode(nid(step.id), async (state) => {
      const ctx = stateToPlain(state, inputs);
      const res = (s) => resolve(s, ctx);

      const t0 = Date.now();
      onStep?.({ stepId: step.id, status: 'running' });

      // LLM 호출
      const role = step.role ? res(step.role) : '';
      const rawPrompt = res(step.prompt);
      const prompt = role
        ? `[System Instructions]\n${role}\n\n[Task]\n${rawPrompt}`
        : rawPrompt;

      let output;
      const provider = res(step.provider || 'claude');
      const model = res(step.model || 'auto');

      if (provider === 'gemini') {
        const geminiModel = model === 'auto' ? 'gemini-2.0-flash' : model;
        output = await callGemini(prompt, { model: geminiModel, maxTokens: step.maxTokens || 8192 });
      } else {
        const claudeModel = model === 'auto' ? 'sonnet' : model;
        output = await callClaude(prompt, {
          model: claudeModel,
          timeoutMs: step.timeout || 120000,
          tools: step.tools   // ["WebSearch", "WebFetch"] 등 — JSON에서 전달
        });
      }

      const elapsed = Date.now() - t0;
      onStep?.({ stepId: step.id, status: 'done', elapsed, outputLength: output.length });

      const update = {};
      if (step.outputKey) update[step.outputKey] = output;
      update._lastOutput = output;
      return update;
    });
  }

  // ─── 3. 엣지 등록 ───

  for (const edge of def.edges) {
    const from = edge.from === 'START' ? START : Array.isArray(edge.from) ? edge.from : nid(edge.from);

    if (edge.condition) {
      // 조건 분기: _lastOutput에 정규식 매칭
      let cycleCount = 0;
      const maxIter = def.maxIterations || 5;
      if (!isSafeRegex(edge.condition.pattern)) throw new Error(`Unsafe regex: ${edge.condition.pattern}`);
      const regex = new RegExp(edge.condition.pattern, 'i');
      const resolveTarget = (t) => t === 'END' ? END : nid(t);

      const trueArr = Array.isArray(edge.condition.true) ? edge.condition.true : [edge.condition.true];
      const falseArr = Array.isArray(edge.condition.false) ? edge.condition.false : [edge.condition.false];

      const pathMap = {};
      const passKeys = trueArr.map((t, i) => { const k = `pass_${i}`; pathMap[k] = resolveTarget(t); return k; });
      const failKeys = falseArr.map((t, i) => { const k = `fail_${i}`; pathMap[k] = resolveTarget(t); return k; });

      builder.addConditionalEdges(nid(edge.from), (state) => {
        cycleCount++;
        if (cycleCount > maxIter) {
          onRouting?.({ from: edge.from, forced: true, iteration: cycleCount });
          return passKeys; // 강제 통과
        }
        const output = state._lastOutput || '';
        const matched = regex.test(output);
        onRouting?.({ from: edge.from, matched, iteration: cycleCount, maxIterations: maxIter });
        return matched ? passKeys : failKeys;
      }, pathMap);

    } else {
      // 직선/병렬 엣지
      const sources = Array.isArray(edge.from)
        ? edge.from.map(f => f === 'START' ? START : nid(f))
        : [edge.from === 'START' ? START : nid(edge.from)];
      const targets = Array.isArray(edge.to)
        ? edge.to.map(t => t === 'END' ? END : nid(t))
        : [edge.to === 'END' ? END : nid(edge.to)];

      for (const src of sources) {
        for (const tgt of targets) {
          builder.addEdge(src, tgt);
        }
      }
    }
  }

  // ─── 4. 컴파일 & 스트리밍 실행 ───

  const compiled = builder.compile({ checkpointer: new MemorySaver() });
  const runId = `run-${Date.now()}`;

  try {
    const stream = await compiled.stream({}, {
      streamMode: 'updates',
      configurable: { thread_id: runId }
    });

    const results = {};
    for await (const chunk of stream) {
      // chunk = { n_stepId: { outputKey: "...", _lastOutput: "..." } }
      for (const [nodeId, update] of Object.entries(chunk)) {
        for (const [key, value] of Object.entries(update)) {
          if (key !== '_lastOutput') results[key] = value;
        }
      }
    }

    onDone?.(results);
    return results;
  } catch (err) {
    onError?.(err);
    throw err;
  }
}
```


### 3-4. `index.js` — CLI 진입점

```js
// index.js
import { readFileSync } from 'node:fs';
import { runWorkflow } from './lib/engine.js';
import * as readline from 'node:readline';

const workflowPath = process.argv[2];
if (!workflowPath) {
  console.error('Usage: node index.js <workflow.json>');
  console.error('  예: node index.js workflows/debate.json');
  process.exit(1);
}

const def = JSON.parse(readFileSync(workflowPath, 'utf8'));
console.log(`\n🔧 Workflow: ${def.name}`);
console.log(`   ${def.description}\n`);

// 사용자 입력 수집
const inputs = {};
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) => new Promise(resolve => rl.question(q, resolve));

for (const input of (def.inputs || [])) {
  const defaultStr = input.default ? ` [${input.default}]` : '';
  const requiredStr = input.required ? ' *' : '';
  let answer;

  if (input.type === 'select') {
    answer = await ask(`${input.label}${requiredStr} (${input.options.join('|')})${defaultStr}: `);
  } else if (input.type === 'textarea') {
    console.log(`${input.label}${requiredStr}: (여러 줄 입력, 빈 줄 2번으로 종료)`);
    const lines = [];
    let emptyCount = 0;
    while (true) {
      const line = await ask('');
      if (line === '') { emptyCount++; if (emptyCount >= 2) break; }
      else { emptyCount = 0; }
      lines.push(line);
    }
    answer = lines.join('\n').trim();
  } else {
    answer = await ask(`${input.label}${requiredStr}${defaultStr}: `);
  }

  inputs[input.key] = answer || input.default || '';
}
rl.close();

console.log('\n─── 실행 시작 ───\n');

try {
  const results = await runWorkflow(def, inputs, {
    onStep: ({ stepId, status, elapsed, outputLength }) => {
      if (status === 'running') {
        const step = def.steps.find(s => s.id === stepId);
        console.log(`▶ [${step?.name || stepId}] 실행 중... (${step?.provider}:${step?.model})`);
      } else {
        console.log(`✅ [${stepId}] 완료 (${(elapsed / 1000).toFixed(1)}s, ${outputLength}자)\n`);
      }
    },
    onRouting: ({ from, matched, forced, iteration, maxIterations }) => {
      if (forced) console.log(`⚠️  [${from}] 최대 반복(${iteration}) 도달, 강제 통과`);
      else console.log(`🔀 [${from}] 조건 ${matched ? '매칭 ✓' : '미매칭 ✗'} (${iteration}/${maxIterations})`);
    },
    onDone: (results) => {
      console.log('\n─── 최종 결과 ───\n');
      for (const [key, value] of Object.entries(results)) {
        console.log(`\n━━━ ${key} ━━━\n`);
        console.log(value);
      }
    },
    onError: (err) => {
      console.error(`\n❌ 오류: ${err.message}`);
    }
  });
} catch (err) {
  console.error(`\n❌ 실행 실패: ${err.message}`);
  process.exit(1);
}
```

---

## 4. 워크플로우 JSON 스키마

```jsonc
{
  "id": "my-workflow",           // 영문+숫자+하이픈/언더스코어
  "name": "워크플로우 이름",
  "description": "설명",
  "maxIterations": 3,            // 순환 최대 반복 (조건 분기용, 무한루프 방지)

  "inputs": [                    // 사용자 입력 필드
    { "key": "topic", "label": "주제", "type": "text", "required": true },
    { "key": "depth", "label": "깊이", "type": "select", "options": ["brief", "detailed"], "default": "detailed" },
    { "key": "code",  "label": "코드", "type": "textarea", "required": true }
  ],

  "steps": [
    {
      "id": "step1",             // 고유 ID
      "name": "표시 이름",
      "type": "llm",             // llm 만 지원 (shell, http 확장 가능)
      "role": "시스템 역할",      // LLM에 전달되는 persona 지시
      "provider": "claude",      // claude | gemini
      "model": "sonnet",         // claude: haiku|sonnet|opus
                                 // gemini: gemini-2.0-flash|gemini-2.5-flash|gemini-2.5-pro
      "timeout": 120000,         // ms (기본 120초, Claude CLI 전용)
      "maxTokens": 8192,         // 최대 출력 토큰 (Gemini 전용)
      "tools": ["WebSearch", "WebFetch"],  // Claude CLI 도구 허용 (선택)
      "prompt": "{{topic}}에 대해 분석해줘.\n이전: {{prev_output}}",
      "outputKey": "analysis"    // 상태에 저장 → 다른 step에서 {{analysis}}로 참조
    }
  ],

  "edges": [
    // (A) 직선
    { "from": "START", "to": "step1" },
    { "from": "step1", "to": "step2" },

    // (B) 병렬 (fan-out)
    { "from": "START", "to": ["stepA", "stepB"] },

    // (C) 합류 (fan-in) — 둘 다 끝나야 다음으로
    { "from": ["stepA", "stepB"], "to": "stepC" },

    // (D) 조건 분기 — _lastOutput에 정규식 매칭
    {
      "from": "reviewer",
      "condition": {
        "pattern": "SCORE:\\s*([89]|10)\\b",
        "true": "END",
        "false": "fixer"
      }
    },

    // (E) 조건에서 병렬 재실행
    {
      "from": "judge",
      "condition": {
        "pattern": "VERDICT:\\s*RESOLVED",
        "true": "synthesizer",
        "false": ["pro", "con"]
      }
    },

    // 종료
    { "from": "final", "to": "END" }
  ]
}
```

### 템플릿 변수 `{{key}}`

- 사용자 입력: `{{topic}}`, `{{code}}` 등 (inputs의 key)
- 이전 스텝 출력: `{{analysis}}`, `{{review}}` 등 (step의 outputKey)
- 존재하지 않으면 빈 문자열로 치환 (에러 아님 — 첫 라운드에서 이전 결과가 없어도 안전)

### 조건 분기 패턴

| 패턴 | 정규식 | 용도 |
|------|--------|------|
| 점수 통과 | `SCORE:\\s*([89]\|10)\\b` | 리뷰 8점 이상 |
| 심판 판정 | `VERDICT:\\s*RESOLVED` | 토론 해결 |
| 신뢰도 | `CONFIDENCE:\\s*HIGH` | 팩트체크 통과 |
| 승인 | `APPROVED` | 단순 승인/거절 |

규칙:
- `"true"` = 매칭됨 → 이 노드로 이동
- `"false"` = 매칭 안 됨 → 이 노드로 이동
- 배열 가능: `"false": ["pro", "con"]` → 병렬 재실행
- `maxIterations` 초과 시 강제 `"true"` 경로

---

## 5. 워크플로우 예제

### 5-1. 토론 (병렬 + 순환)

```
        ┌──→ 찬성 ──┐
START ──┤            ├──→ 심판 ──→ RESOLVED? ──→ 종합 ──→ END
        └──→ 반대 ──┘       ↑           │
                             └── CONTINUE ┘
```

```json
{
  "id": "debate",
  "name": "Multi-Agent Debate",
  "description": "찬성 ↔ 반대 논쟁 → 심판 판정. 미결시 재논쟁.",
  "maxIterations": 3,
  "inputs": [
    { "key": "topic", "label": "토론 주제", "type": "text", "required": true }
  ],
  "steps": [
    {
      "id": "pro", "name": "찬성", "type": "llm",
      "role": "열정적인 찬성 논객. 구체적 근거와 사례.",
      "provider": "gemini", "model": "gemini-2.5-flash", "timeout": 180000,
      "prompt": "## 주제\n{{topic}}\n\n{{con_argument}}\n\n찬성 논거 3가지 + 반박 + 결론.",
      "outputKey": "pro_argument"
    },
    {
      "id": "con", "name": "반대", "type": "llm",
      "role": "냉철한 반대 논객. 허점을 파고드는 반박.",
      "provider": "gemini", "model": "gemini-2.5-flash", "timeout": 180000,
      "prompt": "## 주제\n{{topic}}\n\n## 찬성\n{{pro_argument}}\n\n반박 + 반대 논거 3가지 + 결론.",
      "outputKey": "con_argument"
    },
    {
      "id": "judge", "name": "심판", "type": "llm",
      "role": "공정한 심판. 마지막에 VERDICT:RESOLVED 또는 VERDICT:CONTINUE.",
      "provider": "gemini", "model": "gemini-2.5-flash", "timeout": 180000,
      "prompt": "## 찬성\n{{pro_argument}}\n\n## 반대\n{{con_argument}}\n\n평가 후 VERDICT 선언.",
      "outputKey": "judgment"
    },
    {
      "id": "synthesizer", "name": "종합", "type": "llm",
      "role": "균형 잡힌 분석가.",
      "provider": "gemini", "model": "gemini-2.5-flash", "timeout": 180000,
      "prompt": "## 찬성\n{{pro_argument}}\n## 반대\n{{con_argument}}\n## 판정\n{{judgment}}\n\n종합 보고서.",
      "outputKey": "conclusion"
    }
  ],
  "edges": [
    { "from": "START", "to": ["pro", "con"] },
    { "from": ["pro", "con"], "to": "judge" },
    { "from": "judge", "condition": { "pattern": "VERDICT:\\s*RESOLVED", "true": "synthesizer", "false": ["pro", "con"] } },
    { "from": "synthesizer", "to": "END" }
  ]
}
```


### 5-2. 코드 리뷰 + 자동 수정 (순환)

```
START → 분석가 → 리뷰어 → SCORE 8+? → END
                    ↑          │
                    └── 수정가 ←┘
```

```json
{
  "id": "code-review",
  "name": "Code Review + Auto-Fix",
  "maxIterations": 3,
  "inputs": [
    { "key": "code", "label": "코드", "type": "textarea", "required": true },
    { "key": "language", "label": "언어", "type": "text", "default": "auto-detect" }
  ],
  "steps": [
    {
      "id": "analyzer", "name": "분석가", "type": "llm",
      "role": "시니어 아키텍트. 구조/패턴/복잡도 분석.",
      "provider": "claude", "model": "sonnet",
      "prompt": "{{language}} 코드:\n```\n{{code}}\n```\n\n분석해줘.",
      "outputKey": "analysis"
    },
    {
      "id": "reviewer", "name": "리뷰어", "type": "llm",
      "role": "까다로운 리뷰어. 마지막 줄에 반드시 SCORE:N (1-10).",
      "provider": "claude", "model": "sonnet",
      "prompt": "분석:\n{{analysis}}\n코드:\n```\n{{code}}\n```\n{{fix_suggestion}}\n\n리뷰 + SCORE:N. 8+ 통과.",
      "outputKey": "review"
    },
    {
      "id": "fixer", "name": "수정가", "type": "llm",
      "role": "리뷰 지적사항 전부 수정.",
      "provider": "claude", "model": "sonnet",
      "prompt": "리뷰:\n{{review}}\n코드:\n```\n{{code}}\n```\n\n수정된 전체 코드.",
      "outputKey": "fix_suggestion"
    }
  ],
  "edges": [
    { "from": "START", "to": "analyzer" },
    { "from": "analyzer", "to": "reviewer" },
    { "from": "reviewer", "condition": { "pattern": "SCORE:\\s*([89]|10)\\b", "true": "END", "false": "fixer" } },
    { "from": "fixer", "to": "reviewer" }
  ]
}
```


### 5-3. 리서치 리포트 (팩트체크 순환)

```
START → 리서처 → 팩트체커 → HIGH? → 작성자 → 편집자 → END
                    ↑          │
                    └── 심층 ←─┘
```

```json
{
  "id": "research-report",
  "name": "Research & Report",
  "maxIterations": 2,
  "inputs": [
    { "key": "topic", "label": "주제", "type": "text", "required": true },
    { "key": "depth", "label": "깊이", "type": "select", "options": ["brief", "detailed", "comprehensive"], "default": "detailed" }
  ],
  "steps": [
    {
      "id": "researcher", "name": "리서처", "type": "llm",
      "provider": "claude", "model": "sonnet",
      "prompt": "주제: {{topic}} (깊이: {{depth}})\n{{additional_research}}\n\n핵심 포인트 5-7개 + 근거.",
      "outputKey": "research"
    },
    {
      "id": "fact_checker", "name": "팩트체커", "type": "llm",
      "role": "엄격한 팩트체커. 마지막에 CONFIDENCE:HIGH 또는 CONFIDENCE:LOW.",
      "provider": "gemini", "model": "gemini-2.0-flash",
      "prompt": "리서치:\n{{research}}\n\n정확성 검증 + CONFIDENCE 판정.",
      "outputKey": "fact_check"
    },
    {
      "id": "deep_researcher", "name": "심층 조사", "type": "llm",
      "provider": "claude", "model": "sonnet",
      "prompt": "리서치:\n{{research}}\n팩트체크:\n{{fact_check}}\n\n부족한 부분 보완.",
      "outputKey": "additional_research"
    },
    {
      "id": "writer", "name": "작성자", "type": "llm",
      "provider": "claude", "model": "sonnet",
      "prompt": "리서치:\n{{research}}\n팩트체크:\n{{fact_check}}\n\n{{depth}} 수준 리포트 작성.",
      "outputKey": "draft"
    },
    {
      "id": "editor", "name": "편집자", "type": "llm",
      "provider": "gemini", "model": "gemini-2.0-flash",
      "prompt": "초안:\n{{draft}}\n\n논리 흐름, 문법, 가독성 편집.",
      "outputKey": "final_report"
    }
  ],
  "edges": [
    { "from": "START", "to": "researcher" },
    { "from": "researcher", "to": "fact_checker" },
    { "from": "fact_checker", "condition": { "pattern": "CONFIDENCE:\\s*HIGH", "true": "writer", "false": "deep_researcher" } },
    { "from": "deep_researcher", "to": "fact_checker" },
    { "from": "writer", "to": "editor" },
    { "from": "editor", "to": "END" }
  ]
}
```

### 5-4. 사업계획서 멀티 에이전트 리뷰 (병렬 분석 → 찬반 논쟁 → 통합)

6명의 전문가가 병렬 분석 → 낙관론자 vs 비관론자가 논쟁 → 심판 판정 → 통합 보고서.
웹 검색으로 실시간 시장 데이터/경쟁사 정보를 반영한다.

```
        ┌── 시장 분석가 (웹검색) ─┐
        ├── 재무 분석가 ──────────┤
        ├── 경쟁사 분석가 (웹검색) ┤         ┌→ 낙관론자 ─┐
START ──┼── 고객/기술 심사관 ─────┼──→ 종합 ─┤            ├→ 심판 → RESOLVED? → 최종 → END
        ├── 팀/리스크 분석가 ─────┤         └→ 비관론자 ─┘     ↑         │
        └── 투자자 시뮬레이터 ────┘                              └─ CONTINUE ┘
```

**포인트:**
- `"tools": ["WebSearch", "WebFetch"]` — Claude가 웹 검색을 수행 (시장/경쟁사 분석에 실시간 데이터)
- **Phase 1**: 6명이 병렬 분석 (각자 전문 영역)
- **Phase 2**: 종합 후 낙관론자 vs 비관론자가 **찬반 논쟁** (서로의 논거를 반박)
- **Phase 3**: 심판이 RESOLVED/CONTINUE 판정. 미결 시 재논쟁 (최대 2회)
- **Phase 4**: 최종 통합 보고서

```json
{
  "id": "business-plan-review",
  "name": "사업계획서 멀티 에이전트 리뷰",
  "description": "6명 병렬 분석 → 낙관 vs 비관 논쟁 → 심판 → 최종 보고서.",
  "maxIterations": 2,
  "inputs": [
    { "key": "plan", "label": "사업계획서 전문", "type": "textarea", "required": true },
    { "key": "context", "label": "추가 맥락 (업종, 단계, 목적 등)", "type": "text", "default": "" }
  ],
  "steps": [
    {
      "id": "market", "name": "시장 분석가", "type": "llm",
      "role": "10년차 시장조사 전문가. TAM/SAM/SOM, 트렌드, 타이밍을 냉정하게 평가. 웹 검색으로 최신 시장 데이터를 반드시 조사해라.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "tools": ["WebSearch", "WebFetch"],
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n웹에서 관련 시장 규모, 트렌드, 보고서를 검색한 뒤 분석:\n1)TAM/SAM/SOM 타당성 (검색 근거 포함) 2)시장 트렌드와 타이밍 3)진입 장벽 4)고객 세그먼트.\n각 항목에 [강점] [약점] [개선 제안].",
      "outputKey": "market_review"
    },
    {
      "id": "financial", "name": "재무 분석가", "type": "llm",
      "role": "VC 출신 재무 분석가. 매출 추정, 비용 구조, BEP를 숫자로 검증. 낙관적 추정에 가차없이 지적.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n분석: 1)매출 추정 근거와 현실성 2)비용/번레이트 3)BEP 시점 4)자금 조달 계획 5)유닛 이코노믹스(CAC, LTV, LTV/CAC).\n숫자 없거나 근거 약한 부분 구체적으로 지적.\n각 항목에 [강점] [약점] [개선 제안].",
      "outputKey": "financial_review"
    },
    {
      "id": "competitor", "name": "경쟁사 분석가", "type": "llm",
      "role": "전략 컨설턴트. '경쟁사 없음' 주장을 절대 액면 그대로 안 받음. 웹 검색으로 실제 경쟁사를 찾아라.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "tools": ["WebSearch", "WebFetch"],
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n웹에서 동종/유사 서비스, 경쟁사를 검색한 뒤 분석:\n1)경쟁사/대안재 누락 여부 2)차별화의 실질성 3)경쟁 우위 지속성 4)포지셔닝.\n각 항목에 [강점] [약점] [개선 제안].",
      "outputKey": "competitor_review"
    },
    {
      "id": "product", "name": "고객/기술 심사관", "type": "llm",
      "role": "CTO 겸 UX 리서처. 고객 페인포인트, PMF, 기술 스택, 개발 로드맵을 동시에 평가.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n분석:\n[고객] 1)페인포인트 구체성 2)PMF 검증 여부 3)고객 획득 전략 4)가격/WTP\n[기술] 5)기술 스택 적절성 6)로드맵 현실성 7)MVP 범위 8)확장성.\n각 항목에 [강점] [약점] [개선 제안].",
      "outputKey": "product_review"
    },
    {
      "id": "team_risk", "name": "팀/리스크 분석가", "type": "llm",
      "role": "조직 컨설턴트 겸 리스크 매니저. 팀 역량과 사업 리스크를 교차 분석. 최악의 시나리오를 먼저 생각.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n분석:\n[팀] 1)도메인 전문성 2)역할 갭 3)실행 이력 4)채용 계획\n[리스크] 5)핵심 리스크(시장/기술/규제/팀/자금) 6)확률×영향도 7)누락된 리스크 8)Exit 전략.\n각 항목에 [강점/리스크] [현재 대응] [개선 제안].",
      "outputKey": "team_risk_review"
    },
    {
      "id": "investor", "name": "투자자 시뮬레이터", "type": "llm",
      "role": "시드~시리즈A VC 심사역. 투자 결정 관점에서 사업계획서의 설득력을 판단.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 맥락\n{{context}}\n\n수행: 1)투자 매력도(1-10점, 근거) 2)IR 미팅 까다로운 질문 5개 3)각 질문의 현재 답변 가능 여부 4)추가 필요 자료.\n최종: INVEST / PASS / CONDITIONAL 판정 + 근거.",
      "outputKey": "investor_review"
    },
    {
      "id": "summary", "name": "1차 종합", "type": "llm",
      "role": "전략 컨설턴트. 6명의 분석을 요약 정리. 핵심 쟁점과 의견 차이를 도출.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 원본\n{{plan}}\n\n## 시장\n{{market_review}}\n## 재무\n{{financial_review}}\n## 경쟁\n{{competitor_review}}\n## 고객/기술\n{{product_review}}\n## 팀/리스크\n{{team_risk_review}}\n## 투자자\n{{investor_review}}\n\n6명의 분석을 종합:\n1. 전문가 간 공통된 강점 3가지\n2. 전문가 간 공통된 약점 3가지\n3. 의견이 갈리는 핵심 쟁점 3가지 (누가 어떤 입장인지)\n4. 투자자 판정 요약\n\n이 종합을 바탕으로 낙관론자와 비관론자가 논쟁할 예정이다.",
      "outputKey": "first_summary"
    },
    {
      "id": "optimist", "name": "낙관론자", "type": "llm",
      "role": "열정적인 사업 옹호자. 이 사업의 잠재력과 강점을 최대한 부각하고, 비관론자의 우려를 논리적으로 반박한다. 단, 근거 없는 낙관은 금물.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 6명 전문가 종합\n{{first_summary}}\n\n{{pessimist_arg}}\n\n## 지시사항\n이 사업의 **성공 가능성** 관점에서 논거를 펼쳐라.\n\n1. 핵심 강점과 기회 3가지 — 각각 구체적 근거/사례\n2. 위에 비관론이 있다면, 각각 반박\n3. 이 사업이 성공할 수 있는 이유를 한 문단으로 결론\n\n반드시 실제 논거를 작성해라.",
      "outputKey": "optimist_arg"
    },
    {
      "id": "pessimist", "name": "비관론자", "type": "llm",
      "role": "냉철한 Devil's Advocate. 사업의 치명적 결함과 실패 시나리오를 가차없이 지적. 낙관론자의 논거를 날카롭게 반박.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서\n{{plan}}\n\n## 6명 전문가 종합\n{{first_summary}}\n\n## 낙관론자 주장\n{{optimist_arg}}\n\n## 지시사항\n이 사업의 **실패 리스크** 관점에서 논거를 펼쳐라.\n\n1. 낙관론자의 각 논거를 구체적으로 반박\n2. 치명적 약점과 리스크 3가지 — 각각 최악 시나리오 포함\n3. 이 사업이 실패할 수 있는 이유를 한 문단으로 결론\n\n반드시 실제 논거를 작성해라.",
      "outputKey": "pessimist_arg"
    },
    {
      "id": "judge", "name": "심판", "type": "llm",
      "role": "공정한 심판. 낙관/비관 양측의 논거를 객관적으로 평가. 핵심 쟁점이 충분히 다뤄졌는지 판정. 마지막에 VERDICT:RESOLVED 또는 VERDICT:CONTINUE.",
      "provider": "claude", "model": "sonnet", "timeout": 180000,
      "prompt": "## 사업계획서 요약\n{{first_summary}}\n\n## 낙관론자\n{{optimist_arg}}\n\n## 비관론자\n{{pessimist_arg}}\n\n## 지시사항\n양측의 논거를 분석:\n1. 각 측의 가장 설득력 있는 논거\n2. 각 측의 가장 약한 논거\n3. 추가 논쟁이 필요한 미해결 쟁점이 있는지\n\n마지막 줄에 반드시:\n- VERDICT:RESOLVED — 충분히 논의됨, 결론 도출 가능\n- VERDICT:CONTINUE — 핵심 쟁점이 남아 있어 추가 논쟁 필요",
      "outputKey": "debate_judgment"
    },
    {
      "id": "final", "name": "최종 보고서", "type": "llm",
      "role": "맥킨지 출신 전략 컨설턴트. 모든 분석과 논쟁을 종합해 편향 없는 최종 보고서 도출.",
      "provider": "claude", "model": "opus", "timeout": 300000,
      "prompt": "## 원본 사업계획서\n{{plan}}\n\n## 6명 전문가 종합\n{{first_summary}}\n\n## 낙관론자 최종 입장\n{{optimist_arg}}\n\n## 비관론자 최종 입장\n{{pessimist_arg}}\n\n## 심판 판정\n{{debate_judgment}}\n\n---\n\n최종 보고서:\n\n### 1. 종합 평가 (한 문단)\n\n### 2. 핵심 강점 Top 5\n어떤 전문가/논쟁에서 나온 것인지 출처 표시.\n\n### 3. 치명적 약점 Top 5\n즉시 보완 필요. 비관론자의 지적 중 유효한 것 포함.\n\n### 4. 개선 액션 플랜 (우선순위순)\n| 순위 | 항목 | 담당 영역 | 난이도 | 기대 효과 |\n\n### 5. 찬반 논쟁 핵심 정리\n낙관/비관 양측의 핵심 대립점과 결론.\n\n### 6. 사업계획서 보완 시 추가해야 할 섹션/데이터\n\n### 7. 최종 등급\nA (투자 준비 완료) / B (보완 후 투자 가능) / C (근본적 재설계 필요)\n근거와 함께 판정.",
      "outputKey": "final_report"
    }
  ],
  "edges": [
    { "from": "START", "to": ["market", "financial", "competitor", "product", "team_risk", "investor"] },
    { "from": ["market", "financial", "competitor", "product", "team_risk", "investor"], "to": "summary" },
    { "from": "summary", "to": ["optimist", "pessimist"] },
    { "from": ["optimist", "pessimist"], "to": "judge" },
    { "from": "judge", "condition": { "pattern": "VERDICT:\\s*RESOLVED", "true": "final", "false": ["optimist", "pessimist"] } },
    { "from": "final", "to": "END" }
  ]
}
```

---

## 6. 실행

```bash
# Gemini 키 설정
export GEMINI_API_KEY=AIzaSy...

# 토론 실행
node index.js workflows/debate.json

# 코드 리뷰 실행
node index.js workflows/code-review.json

# 리서치 리포트
node index.js workflows/research-report.json

# 사업계획서 리뷰
node index.js workflows/business-plan-review.json
```

---

## 7. Provider 비교

| Provider | Model | 속도 | 비용 | 인증 | 추천 용도 |
|----------|-------|------|------|------|-----------|
| claude | haiku | 빠름 | 저렴 | OAuth (CLI) | 팩트체크, 편집, 분류 |
| claude | sonnet | 보통 | 중간 | OAuth (CLI) | 리뷰, 분석, 리서치 |
| claude | opus | 느림 | 비쌈 | OAuth (CLI) | 코드 생성, 심층 분석 |
| gemini | gemini-2.0-flash | 매우 빠름 | 매우 저렴 | API Key | 토론, 분류, 요약 |
| gemini | gemini-2.5-flash | 빠름 | 저렴 | API Key | 범용 (토론, 리서치) |
| gemini | gemini-2.5-pro | 보통 | 중간 | API Key | 고품질 분석 |

**팁:**
- 순환 워크플로우(토론, 리뷰)는 **Gemini flash** — 여러 번 호출되므로 속도/비용 중요
- 1회성 심층 분석은 **Claude sonnet/opus** — 품질 중요
- Claude는 CLI spawn이라 cold start 있음. Gemini는 HTTP API라 즉시 응답
- 혼합 사용 가능: 분석은 Claude, 팩트체크/편집은 Gemini

---

## 8. 웹 UI (Vanilla JS + Node.js)

CLI 대신 브라우저에서 워크플로우를 실행/모니터링하는 웹 UI.
프레임워크 없이 Vanilla JS + ES Modules + Node.js HTTP 서버 + SSE 스트리밍.

### 8-1. 스펙

| 항목 | 선택 |
|------|------|
| **프론트엔드** | Vanilla JS ES Modules (프레임워크 없음) |
| **백엔드** | Node.js `http` 모듈 (자체 라우터) |
| **빌드 도구** | 없음 — ES 모듈 직접 서빙 |
| **스타일** | CSS 변수 + 다크 테마 |
| **마크다운** | `marked` (CDN or vendor) |
| **스트리밍** | Server-Sent Events (SSE) |

### 8-2. 디렉토리 구조

```
my-workflow/
├── package.json
├── server.js              # HTTP 서버 + API 라우트 + 정적 파일 서빙
├── lib/
│   ├── engine.js           # LangGraph 엔진 (그대로)
│   ├── providers.js        # Claude CLI + Gemini (그대로)
│   └── utils.js            # 템플릿 치환 (그대로)
├── workflows/              # 워크플로우 JSON (그대로)
├── public/
│   ├── index.html          # SPA 단일 HTML
│   ├── style.css           # 스타일
│   └── js/
│       └── app.js          # 프론트엔드 ES Module
└── vendor/
    └── marked.min.js       # 마크다운 렌더러
```

### 8-3. 핵심 코드

#### `server.js` — HTTP 서버

```js
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { runWorkflow } from './lib/engine.js';

const PORT = 3847;
const __dir = import.meta.dirname;
const WORKFLOWS_DIR = join(__dir, 'workflows');
const PUBLIC_DIR = join(__dir, 'public');
const VENDOR_DIR = join(__dir, 'vendor');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ─── API: 워크플로우 목록 ───
  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      const def = JSON.parse(readFileSync(join(WORKFLOWS_DIR, f), 'utf8'));
      return { id: def.id, name: def.name, description: def.description, file: f, inputs: def.inputs, steps: def.steps.length };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  // ─── API: 워크플로우 실행 (SSE) ───
  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { workflowFile, inputs } = JSON.parse(body);
    const defPath = join(WORKFLOWS_DIR, workflowFile);
    if (!existsSync(defPath)) {
      res.writeHead(404);
      return res.end('Workflow not found');
    }
    const def = JSON.parse(readFileSync(defPath, 'utf8'));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await runWorkflow(def, inputs, {
        onStep:    (info) => send('step', info),
        onRouting: (info) => send('routing', info),
        onDone:    (results) => send('done', results),
        onError:   (err) => send('error', { message: err.message })
      });
    } catch (err) {
      send('error', { message: err.message });
    }
    return res.end();
  }

  // ─── 정적 파일 서빙 ───
  let filePath;
  if (url.pathname.startsWith('/vendor/')) {
    filePath = join(VENDOR_DIR, url.pathname.slice(8));
  } else {
    filePath = join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  }

  if (existsSync(filePath)) {
    const mime = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    return res.end(readFileSync(filePath));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
```

#### `public/index.html`

```html
<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workflow Runner</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/vendor/marked.min.js"></script>
</head>
<body>
  <header>
    <h1>Workflow Runner</h1>
  </header>

  <main id="app">
    <!-- 워크플로우 목록 -->
    <section id="workflow-list"></section>

    <!-- 실행 패널 (숨김) -->
    <section id="run-panel" class="hidden">
      <button id="btn-back">&larr; 목록</button>
      <h2 id="wf-name"></h2>
      <p id="wf-desc"></p>
      <form id="input-form"></form>
      <button id="btn-run">실행</button>

      <div id="progress" class="hidden"></div>
      <div id="results"></div>
    </section>
  </main>

  <script type="module" src="/js/app.js"></script>
</body>
</html>
```

#### `public/js/app.js` — 프론트엔드

```js
// ─── 상태 ───
let workflows = [];
let currentWf = null;
let inputValues = {};

// ─── DOM ───
const $list     = document.getElementById('workflow-list');
const $panel    = document.getElementById('run-panel');
const $name     = document.getElementById('wf-name');
const $desc     = document.getElementById('wf-desc');
const $form     = document.getElementById('input-form');
const $btnRun   = document.getElementById('btn-run');
const $btnBack  = document.getElementById('btn-back');
const $progress = document.getElementById('progress');
const $results  = document.getElementById('results');

// ─── 초기화 ───
async function init() {
  workflows = await fetch('/api/workflows').then(r => r.json());
  renderList();
}

// ─── 워크플로우 목록 ───
function renderList() {
  $list.classList.remove('hidden');
  $panel.classList.add('hidden');

  $list.innerHTML = workflows.map(wf => `
    <div class="card" data-id="${wf.id}" data-file="${wf.file}">
      <h3>${wf.name}</h3>
      <p>${wf.description}</p>
      <span class="badge">${wf.steps}개 에이전트</span>
    </div>
  `).join('');

  $list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openWorkflow(card.dataset.id, card.dataset.file));
  });
}

// ─── 워크플로우 열기 → 입력 폼 자동 생성 ───
function openWorkflow(id, file) {
  currentWf = workflows.find(w => w.id === id);
  if (!currentWf) return;
  currentWf._file = file;
  inputValues = {};

  $list.classList.add('hidden');
  $panel.classList.remove('hidden');
  $progress.classList.add('hidden');
  $results.innerHTML = '';

  $name.textContent = currentWf.name;
  $desc.textContent = currentWf.description;

  // 입력 폼 생성
  $form.innerHTML = (currentWf.inputs || []).map(inp => {
    const req = inp.required ? '<span class="req">*</span>' : '';
    if (inp.type === 'textarea') {
      return `<label>${inp.label}${req}<textarea data-key="${inp.key}" rows="8">${inp.default || ''}</textarea></label>`;
    }
    if (inp.type === 'select') {
      const opts = (inp.options || []).map(o => `<option value="${o}">${o}</option>`).join('');
      return `<label>${inp.label}${req}<select data-key="${inp.key}">${opts}</select></label>`;
    }
    return `<label>${inp.label}${req}<input data-key="${inp.key}" value="${inp.default || ''}"></label>`;
  }).join('');
}

// ─── 실행 (SSE 스트리밍) ───
async function run() {
  // 입력 수집
  $form.querySelectorAll('[data-key]').forEach(el => {
    inputValues[el.dataset.key] = el.value;
  });

  $btnRun.disabled = true;
  $btnRun.textContent = '실행 중...';
  $progress.classList.remove('hidden');
  $progress.innerHTML = '';
  $results.innerHTML = '';

  const resp = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowFile: currentWf._file, inputs: inputValues })
  });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let eventType = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7);
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        handleEvent(eventType, data);
      }
    }
  }

  $btnRun.disabled = false;
  $btnRun.textContent = '실행';
}

// ─── SSE 이벤트 핸들러 ───
function handleEvent(event, data) {
  if (event === 'step') {
    let row = $progress.querySelector(`[data-step="${data.stepId}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'step-row';
      row.dataset.step = data.stepId;
      $progress.appendChild(row);
    }
    if (data.status === 'running') {
      row.innerHTML = `<span class="dot running"></span> ${data.stepId} <span class="dim">실행 중...</span>`;
    } else {
      row.innerHTML = `<span class="dot done"></span> ${data.stepId} <span class="dim">${(data.elapsed / 1000).toFixed(1)}s</span>`;
    }
  }

  if (event === 'routing') {
    const row = document.createElement('div');
    row.className = 'step-row routing';
    row.textContent = data.forced
      ? `⚠ ${data.from} 최대 반복 도달, 강제 통과`
      : `↪ ${data.from} 조건 ${data.matched ? '매칭' : '미매칭'} (${data.iteration}/${data.maxIterations})`;
    $progress.appendChild(row);
  }

  if (event === 'done') {
    for (const [key, value] of Object.entries(data)) {
      const section = document.createElement('div');
      section.className = 'result-card';
      section.innerHTML = `<h3>${key}</h3><div class="md">${marked.parse(value)}</div>`;
      $results.appendChild(section);
    }
  }

  if (event === 'error') {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = data.message;
    $results.appendChild(err);
  }
}

// ─── 이벤트 바인딩 ───
$btnRun.addEventListener('click', run);
$btnBack.addEventListener('click', renderList);

init();
```

### 8-4. 실행

```bash
npm start    # node server.js
# http://localhost:3847
```

**구조 요약:**
- 프레임워크/번들러 제로 — HTML + ES Modules 직접 서빙
- `lib/`, `workflows/` — CLI 버전과 **동일 코드 재사용**
- SSE로 `onStep`, `onRouting`, `onDone` 이벤트 실시간 스트리밍
- 워크플로우 JSON의 `inputs`에서 입력 폼 자동 생성
- `marked.js`로 결과 마크다운 렌더링
