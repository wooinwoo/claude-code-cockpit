// ─── Sprint Engine: Git-Native Autonomous React Dev Pipeline ───
// AutoBE-inspired: Compiler-Driven Self-Healing + Hierarchical Orchestration
// Phase: Planning → Implementing → Validating → Reviewing → Finalizing
//
// 핵심 원칙:
// 1. 코드가 산출물, git이 DB — Phase간 JSON 전달 없음
// 2. Compiler-Driven Self-Healing — tsc/eslint/build/test 실패 → 에이전트 수정 → 재검증
// 3. 선택적 재처리 — 실패한 파일만 골라서 재시도
// 4. executeCachedBatch 패턴 — Semaphore 기반 병렬 (fail-fast)

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { IS_WIN } from './platform.js';
import { toWinPath } from './wsl-utils.js';
import { detectReactProject, REACT_PRESET } from './sprint-presets.js';
import { AGENT_PROFILES } from './agent-profiles.js';
import { registerWorktreeRoot, unregisterWorktreeRoot } from './agent-tools.js';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_SPRINTS = 4;
const SPRINT_HISTORY_DIR = join(DATA_DIR, 'sprint-history');
try { mkdirSync(SPRINT_HISTORY_DIR, { recursive: true }); } catch { /* ok */ }

// ─── Constants (AutoBE-inspired) ───
const VALIDATION_RETRY = 5;    // 각 검증 단계 최대 재시도
const MAX_VALIDATE_CYCLES = 3; // 전체 검증 사이클
const MAX_REVIEW_ROUNDS = 2;   // 리뷰 루프
const IMPL_SEMAPHORE = 8;      // 병렬 구현 에이전트 동시 실행 (AutoBE: 8~16)

// ─── Dynamic Agent Factory (AutoBE MicroAgentica 패턴) ───
// UNIT 수만큼 에이전트를 동적 생성. 고정 풀 없이 N:N 매핑.
const AGENT_TEMPLATES = [
  { id: 'dev_gwajang', name: '원과장', emoji: '😎', provider: 'gemini', model: 'gemini-2.5-pro' },
  { id: 'dev_daeri', name: '핏대리', emoji: '🔥', provider: 'gemini', model: 'gemini-2.5-flash' },
  { id: 'dev_sawon', name: '콕사원', emoji: '🐣', provider: 'gemini', model: 'gemini-2.5-flash' },
];

function createUnitAgent(unitIndex) {
  const template = AGENT_TEMPLATES[unitIndex % AGENT_TEMPLATES.length];
  // 동적 ID — 같은 템플릿이라도 유닛별 독립 인스턴스
  return {
    ...getProfile(template.id),
    _unitInstance: unitIndex, // 디버깅용
  };
}

// ─── Sprint-scoped project context (워크트리만 포함, 다른 프로젝트 혼동 방지) ───
function buildSprintProjectContext(run) {
  return `\n## Sprint Project Context (스프린트 전용)
⚠️ 이 스프린트에서는 아래 프로젝트만 작업하세요. 다른 프로젝트를 절대 참조하지 마세요.
- **프로젝트 경로**: ${run.worktreePath}
- **브랜치**: ${run.branch}
- **작업**: ${run.task}
- 모든 파일 읽기/쓰기/실행은 반드시 위 경로 안에서만 수행하세요.
- DELEGATE 금지 — 스프린트 엔진이 에이전트 배정을 관리합니다.\n`;
}

// ─── Injected Dependencies ───
let _poller = null;
let _runSubAgentLoop = null;
let _getProjectById = null;
let _gitExec = null;

const _runs = new Map(); // sprintId → SprintRun
const _completionCallbacks = [];

export function onSprintComplete(cb) { _completionCallbacks.push(cb); }

function _fireCompletionCallbacks(run) {
  for (const cb of _completionCallbacks) {
    try { cb(run.sprintId, run.status, run.toJSON()); } catch (e) { console.error('[Sprint] Completion callback error:', e); }
  }
}

export function initSprint({ poller, runSubAgentLoop, getProjectById, gitExec }) {
  _poller = poller;
  _runSubAgentLoop = runSubAgentLoop;
  _getProjectById = getProjectById;
  _gitExec = gitExec;
}

// ══════════════════════════════════════════════════
// SprintRun — ForgeRun 패턴 + git worktree + React preset
// ══════════════════════════════════════════════════

class SprintRun {
  constructor(sprintId, projectId, projectPath, task, preset, toolchain) {
    this.sprintId = sprintId;
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.worktreePath = null;
    this.branch = `sprint/${slugify(task)}-${Date.now().toString(36)}`;
    this.task = task;
    this.preset = preset;
    this.toolchain = toolchain;
    this.baseBranch = 'main'; // detected in setupWorktree (could be dev, main, master, etc.)
    this.status = 'created'; // created→planning→implementing→validating→reviewing→finalizing→done|failed|stopped
    this.phase = null;
    this.plan = null;
    this.changes = [];
    this.validationLog = [];
    this.validationCycles = 0;
    this.reviewResult = null;
    this.log = [];
    this.cost = { total: 0, byRole: {} };
    this.error = null;
    this._stopped = false;
    this._loopState = { aborted: false };
    this.startedAt = Date.now();
    this.endedAt = null;
    this.prUrl = null;
  }

  addLog(role, msg, detail) {
    const entry = { ts: new Date().toISOString(), role, message: msg, detail };
    this.log.push(entry);
    _poller?.broadcast('sprint:log', { sprintId: this.sprintId, ...entry });
  }

  updatePhase(phase, status) {
    this.phase = phase;
    this.status = status || this.status;
    _poller?.broadcast('sprint:phase', { sprintId: this.sprintId, phase, status: this.status });
  }

  trackCost(role, inputTokens, outputTokens, model) {
    const PRICING = {
      'claude-opus-4-6': { input: 15, output: 75 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
      'gemini-2.5-flash': { input: 0.15, output: 0.6 },
      'gemini-2.5-pro': { input: 1.25, output: 10 },
    };
    const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
    const cost = (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
    this.cost.total += cost;
    if (!this.cost.byRole[role]) this.cost.byRole[role] = { usd: 0, tokens: 0, model };
    this.cost.byRole[role].usd += cost;
    this.cost.byRole[role].tokens += inputTokens + outputTokens;
    _poller?.broadcast('sprint:cost', { sprintId: this.sprintId, total: this.cost.total, byRole: this.cost.byRole });
    return cost;
  }

  isStopped() { return this._stopped || this._loopState.aborted; }

  stop() {
    this._stopped = true;
    this._loopState.aborted = true;
    this.status = 'stopped';
    this.endedAt = Date.now();
  }

  toJSON() {
    return {
      sprintId: this.sprintId, projectId: this.projectId,
      branch: this.branch, task: this.task, toolchain: this.toolchain,
      status: this.status, phase: this.phase,
      plan: this.plan ? { complexity: this.plan.complexity } : null,
      changes: this.changes, validationLog: this.validationLog,
      validationCycles: this.validationCycles,
      reviewResult: this.reviewResult ? { hasIssues: !!this.reviewResult.criticalCount } : null,
      log: this.log.slice(-50),
      cost: this.cost, error: this.error,
      startedAt: this.startedAt, endedAt: this.endedAt, prUrl: this.prUrl,
    };
  }
}

// ══════════════════════════════════════════════════
// API Functions
// ══════════════════════════════════════════════════

export async function startSprint({ projectId, task }) {
  const active = [..._runs.values()].filter(r => !['done', 'failed', 'stopped'].includes(r.status));
  if (active.length >= MAX_CONCURRENT_SPRINTS) {
    throw new Error(`Maximum ${MAX_CONCURRENT_SPRINTS} concurrent sprints. Wait for current to complete.`);
  }

  const project = _getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const projectPath = project.path; // Keep forward slashes, toWinPath only for fs/exec cwd

  // Detect React + toolchain
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')); } catch { /* ok */ }
  const detected = detectReactProject(pkg);
  if (!detected) throw new Error('Not a React project (react not found in package.json)');

  const sprintId = `sprint-${Date.now().toString(36)}`;
  const run = new SprintRun(sprintId, projectId, projectPath, task, detected.preset, detected.toolchain);
  _runs.set(sprintId, run);

  _poller?.broadcast('sprint:start', {
    sprintId, projectId, task, toolchain: detected.toolchain,
  });

  // Run pipeline async (non-blocking)
  runPipeline(run).catch(err => {
    console.error('[Sprint] Pipeline error:', err);
    run.status = 'failed';
    run.error = err.message;
    run.endedAt = Date.now();
    _poller?.broadcast('sprint:error', { sprintId, error: err.message });
    saveSprintHistory(run);
    _fireCompletionCallbacks(run);
  });

  return { sprintId, branch: run.branch };
}

export function stopSprint(sprintId) {
  const run = _runs.get(sprintId);
  if (!run) return false;
  run.stop();
  _poller?.broadcast('sprint:stopped', { sprintId });
  saveSprintHistory(run);
  return true;
}

export function getSprintRun(sprintId) {
  const run = _runs.get(sprintId);
  return run ? run.toJSON() : null;
}

export function listSprintRuns() {
  return [..._runs.values()].map(r => r.toJSON());
}

export function getSprintDiff(sprintId) {
  const run = _runs.get(sprintId);
  if (!run || !run.worktreePath) return null;
  return { branch: run.branch, worktreePath: run.worktreePath };
}

// ══════════════════════════════════════════════════
// Pipeline — AutoBE-style Waterfall + Spiral
// ══════════════════════════════════════════════════

async function runPipeline(run) {
  try {
    // Phase 0: Git worktree 생성
    await setupWorktree(run);

    // Phase 1: Planning (김부장/Sonnet)
    run.updatePhase('planning', 'planning');
    await phasePlan(run);
    if (run.isStopped()) return finalize(run, 'stopped');

    // Phase 2: Implementation (원과장/Sonnet)
    run.updatePhase('implementing', 'implementing');
    await phaseImplement(run);
    if (run.isStopped()) return finalize(run, 'stopped');

    // Phase 3: Validation loop (Compiler-Driven Self-Healing)
    run.updatePhase('validating', 'validating');
    await phaseValidate(run);
    if (run.isStopped()) return finalize(run, 'stopped');

    // Phase 4: Review (코드 + 보안 병렬) — trivial 건 스킵
    if (run.plan?.complexity !== 'trivial') {
      run.updatePhase('reviewing', 'reviewing');
      await phaseReview(run);
      if (run.isStopped()) return finalize(run, 'stopped');
    }

    // Phase 5: Finalize — PR 생성
    run.updatePhase('finalizing', 'finalizing');
    await phaseFinalize(run);

    run.status = 'done';
    run.endedAt = Date.now();
    _poller?.broadcast('sprint:done', {
      sprintId: run.sprintId, branch: run.branch,
      changes: run.changes, cost: run.cost, prUrl: run.prUrl,
    });
    _fireCompletionCallbacks(run);
  } catch (e) {
    run.status = 'failed';
    run.error = e.message;
    run.endedAt = Date.now();
    _poller?.broadcast('sprint:error', { sprintId: run.sprintId, error: e.message });
    _fireCompletionCallbacks(run);
  }
  saveSprintHistory(run);
}

function finalize(run, status) {
  run.status = status;
  run.endedAt = Date.now();
  saveSprintHistory(run);
  _fireCompletionCallbacks(run);
}

// ══════════════════════════════════════════════════
// executeBatch — AutoBE의 executeCachedBatch 포팅
// Semaphore 기반 병렬 실행: 워크유닛 N개를 IMPL_SEMAPHORE 동시성으로 처리
// 각 유닛마다 독립 에이전트 spawn, 에이전트 풀에서 라운드로빈 배정
// ══════════════════════════════════════════════════

class Semaphore {
  constructor(max) {
    this._max = max;
    this._current = 0;
    this._queue = [];
  }
  async acquire() {
    if (this._current < this._max) { this._current++; return; }
    await new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._current--;
    if (this._queue.length > 0) {
      this._current++;
      this._queue.shift()();
    }
  }
}

/**
 * executeBatch — AutoBE executeCachedBatch 패턴
 * @param {Array<{id, description, agentId}>} workUnits - 작업 단위 배열
 * @param {SprintRun} run
 * @param {number} concurrency - 동시 실행 수 (default: IMPL_SEMAPHORE)
 * @returns {Array<{unitId, result, error}>} - 원래 순서 유지
 */
async function executeBatch(workUnits, run, concurrency = IMPL_SEMAPHORE) {
  const sem = new Semaphore(concurrency);

  const tasks = workUnits.map((unit, index) => {
    // AutoBE MicroAgentica 패턴: UNIT마다 독립 에이전트 인스턴스
    const profile = unit.agentId ? getProfile(unit.agentId) : createUnitAgent(index);

    return (async () => {
      await sem.acquire();
      if (run.isStopped()) { sem.release(); return { unitId: unit.id, result: null, error: 'stopped' }; }

      run.addLog(profile.id, `작업 시작: ${unit.id}`, unit.files?.join(', ') || '');
      _poller?.broadcast('sprint:agent', {
        sprintId: run.sprintId, agentId: profile.id,
        action: 'impl', unitId: unit.id, index, total: workUnits.length,
      });

      try {
        const convId = `sprint-${run.sprintId}-unit-${index}`;
        const result = await _runSubAgentLoop(convId, {
          id: convId,
          description: unit.description,
        }, profile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 15, sprintMode: true });

        // Fallback commit — if agent didn't commit, engine does it
        try {
          const statusCheck = await execInWorktree(run, 'git status --porcelain');
          if (statusCheck.output.trim()) {
            run.addLog(profile.id, `${unit.id} 미커밋 파일 발견 — 엔진이 대신 커밋`, '');
            await execInWorktree(run, `git add -A`);
            await execInWorktree(run, `git commit -m "feat(${unit.id.toLowerCase()}): ${unit.title || 'implementation'}"`);
            await execInWorktree(run, `git push origin ${run.branch}`);
          }
        } catch (commitErr) {
          run.addLog('system', `${unit.id} 자동 커밋 실패: ${commitErr.message}`, '');
        }

        run.addLog(profile.id, `작업 완료: ${unit.id}`, '');
        sem.release();
        return { unitId: unit.id, result, error: null };
      } catch (err) {
        run.addLog(profile.id, `작업 실패: ${unit.id} — ${err.message}`, '');
        sem.release();
        return { unitId: unit.id, result: null, error: err.message };
      }
    })();
  });

  // 모든 작업 병렬 시작 (세마포어가 동시성 제어)
  return Promise.all(tasks);
}

/**
 * parseWorkUnits — SPRINT_PLAN.md에서 작업 단위 추출
 * 김부장이 아래 포맷으로 작성:
 *
 * ## Work Units
 * ### UNIT-1: Hook 구현
 * - files: src/hooks/useDarkMode.ts, src/hooks/useTheme.ts
 * - type: create
 * - deps: none
 *
 * ### UNIT-2: 컴포넌트 구현
 * - files: src/features/dark-mode/ThemeToggle.tsx
 * - type: create
 * - deps: UNIT-1
 */
function parseWorkUnits(planText) {
  if (!planText || typeof planText !== 'string') return [];

  const units = [];
  // Match ### UNIT-N: title blocks
  const unitRegex = /###\s*UNIT-(\d+)\s*:\s*(.+?)(?=\n###\s*UNIT-|\n##\s|$)/gs;
  let match;

  while ((match = unitRegex.exec(planText)) !== null) {
    const num = match[1];
    const title = match[2].trim();
    const block = match[0];

    // Extract files
    const filesMatch = block.match(/[-*]\s*files?\s*:\s*(.+)/i);
    const files = filesMatch
      ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
      : [];

    // Extract type
    const typeMatch = block.match(/[-*]\s*type\s*:\s*(\w+)/i);
    const type = typeMatch ? typeMatch[1] : 'create';

    // Extract deps
    const depsMatch = block.match(/[-*]\s*deps?\s*:\s*(.+)/i);
    const deps = depsMatch && !/none/i.test(depsMatch[1])
      ? depsMatch[1].split(',').map(d => d.trim()).filter(Boolean)
      : [];

    units.push({ id: `UNIT-${num}`, title, files, type, deps });
  }

  return units;
}

/**
 * 워크유닛을 의존성 기준으로 레이어 분리
 * deps 없는 것 → 1차 병렬, deps 있는 것 → 2차 순차/병렬
 */
function splitByDependency(units) {
  const independent = units.filter(u => u.deps.length === 0);
  const dependent = units.filter(u => u.deps.length > 0);
  return { independent, dependent };
}

// ══════════════════════════════════════════════════
// Phase 1: Planning — 콕사원(스캔) → 김부장(플래닝)
// AutoBE 패턴: 순차 파이프라인 (scenario → plan)
// ══════════════════════════════════════════════════

async function phasePlan(run) {
  // Step 1: 콕사원 — 프로젝트 구조 스캔 (Flash, 빠르고 저렴)
  const scoutProfile = getProfile('dev_sawon');
  run.addLog(scoutProfile.id, '프로젝트 구조 스캔 시작', '');
  _poller?.broadcast('sprint:agent', { sprintId: run.sprintId, agentId: 'dev_sawon', action: 'scan' });

  const scoutConvId = `sprint-${run.sprintId}-scout`;
  const scoutTask = {
    id: scoutConvId,
    description: `[SPRINT SCOUT - 프로젝트 구조 파악]

PROJECT: ${run.worktreePath}

당신은 프로젝트 구조를 빠르게 파악하는 스카우트입니다.

수행할 작업:
1. GLOB src/**/* 로 전체 파일 트리 확인
2. READ package.json — dependencies, devDependencies, scripts 확인
3. READ tsconfig.json (있으면)
4. src/ 아래 주요 디렉토리 구조 파악 (app/, pages/, features/, components/, etc.)
5. 기존 스타일링 방식 확인 (tailwind.config.*, postcss.config.*, CSS modules 등)
6. 기존 상태관리 확인 (zustand store, redux, context 등)
7. 기존 라우팅 확인 (react-router, next.js pages 등)

최종 결과를 아래 포맷으로 출력:
---
PROJECT_STRUCTURE:
- 총 파일 수: N
- 디렉토리 구조: (트리)
- 스택: React + (TypeScript|JavaScript) + (Tailwind|CSS Modules|styled-components) + (Zustand|Redux|Context)
- 빌드: (vite|next|cra)
- 기존 컴포넌트 목록: (주요 .tsx 파일명들)
- 테스트: (vitest|jest|none)
---`,
  };

  const scoutResult = await _runSubAgentLoop(scoutConvId, scoutTask, scoutProfile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 10, sprintMode: true });
  if (run.isStopped()) return;
  run.addLog(scoutProfile.id, '구조 스캔 완료', '');

  // Step 2: 김부장 — 스캔 결과 기반 플래닝
  const planProfile = getProfile('dev_bujang');
  run.addLog(planProfile.id, '플래닝 시작', run.task);

  const convId = `sprint-${run.sprintId}-plan`;
  const task = {
    id: convId,
    description: `[SPRINT PLANNING - REACT/${run.toolchain.toUpperCase()}]
${run.preset.promptRules}

PROJECT: ${run.worktreePath}
TASK: ${run.task}

## 콕사원 스캔 결과:
${typeof scoutResult === 'string' ? scoutResult.slice(0, 3000) : '(스캔 결과 없음)'}

당신은 React 프로젝트의 시니어 아키텍트입니다.
위 스캔 결과를 참고하여 구현 계획을 수립하세요.

추가로 필요한 파일이 있으면 직접 READ하세요.

수행할 작업:
1. 스캔 결과 + 필요시 추가 READ로 정확한 구현 계획 수립
2. complexity 판별: trivial(1-2파일) / small(3-5) / medium(5-10) / large(10+)
3. medium/large → 병렬 구현 가능한 파일 그룹 분리 (AGENT_A / AGENT_B)
4. WRITE로 프로젝트 루트에 SPRINT_PLAN.md 파일 생성

SPRINT_PLAN.md 포맷:
\`\`\`
# Sprint Plan
## Task: {task}
## Complexity: {trivial|small|medium|large}

## Work Units
각 작업을 독립 단위로 분리하세요. 에이전트가 파일 단위로 병렬 처리합니다.
독립적인 작업은 deps: none, 의존 관계가 있으면 deps: UNIT-N 형식으로.

### UNIT-1: {짧은 제목}
- files: src/shared/ui/xxx.tsx, src/shared/lib/yyy.ts
- type: create (또는 modify)
- deps: none

### UNIT-2: {짧은 제목}
- files: src/features/xxx/components/Zzz.tsx
- type: create
- deps: none

### UNIT-3: {짧은 제목}
- files: src/hooks/useXxx.ts
- type: create
- deps: UNIT-1

### UNIT-4: 통합 (마지막)
- files: src/app/App.tsx, src/app/routes.tsx
- type: modify
- deps: UNIT-1, UNIT-2, UNIT-3

## Setup (선택):
- shadcn 컴포넌트 추가: npx shadcn@latest add button card
- 패키지 설치: npm install zustand
\`\`\`

⚠️ 절대 규칙 (반드시 지킬 것):
- SPRINT_PLAN.md를 반드시 WRITE 도구로 생성하세요
- 반드시 "### UNIT-N: 제목" 포맷을 사용하세요 (N은 1부터 순서대로)
- 각 UNIT에 반드시 "- files:", "- type:", "- deps:" 3줄을 포함하세요

⚠️ 병렬 극대화 규칙 (핵심):
- 파일 1~2개 = UNIT 1개. 가능한 잘게 쪼개세요!
- 독립 파일은 반드시 deps: none → 동시에 8개까지 병렬 실행됩니다
- 공유 타입/유틸은 UNIT-1로 먼저, 나머지는 deps: UNIT-1로 병렬
- 예: Hook 3개 → UNIT 3개 (각각 독립), 컴포넌트 5개 → UNIT 5개
- 마지막 통합 UNIT만 모든 이전 UNIT에 deps 걸기
- 목표: 독립 UNIT 최대화, 의존 UNIT 최소화

5. 완료 후: BASH git add SPRINT_PLAN.md && git commit -m "sprint: plan" && git push origin ${run.branch}`,
  };

  const result = await _runSubAgentLoop(convId, task, planProfile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 15, sprintMode: true });

  // Extract complexity and parallel assignment from result
  run.plan = {
    complexity: extractComplexity(result),
    hasParallel: /AGENT_B|핏대리|parallel/i.test(result || ''),
    raw: typeof result === 'string' ? result.slice(0, 5000) : '',
  };

  // Fallback: 김부장이 SPRINT_PLAN.md를 안 만들었으면 raw 텍스트에서 생성
  const planFilePath = IS_WIN
    ? toWinPath(join(run.worktreePath, 'SPRINT_PLAN.md'))
    : join(run.worktreePath, 'SPRINT_PLAN.md');
  if (!existsSync(planFilePath) && run.plan.raw) {
    run.addLog('system', 'SPRINT_PLAN.md 미생성 — raw 텍스트에서 fallback 생성', '');
    try {
      // raw 텍스트에서 plan 부분 추출 (```...``` 또는 # Sprint Plan 이후)
      let planContent = run.plan.raw;
      const fenceMatch = planContent.match(/```(?:markdown)?\s*\n([\s\S]*?)```/);
      if (fenceMatch) planContent = fenceMatch[1];
      else {
        const headerMatch = planContent.match(/(#\s*Sprint Plan[\s\S]*)/i);
        if (headerMatch) planContent = headerMatch[1];
      }
      // UNIT 패턴이 있으면 파일 생성, 없으면 raw 전체를 플랜으로 저장
      const hasUnits = /###\s*UNIT-/i.test(planContent);
      if (!hasUnits && planContent.length > 100) {
        // UNIT 포맷이 아니어도 플랜 텍스트가 있으면 저장 (solo fallback이 참조할 수 있도록)
        planContent = `# Sprint Plan\n## Task: ${run.task}\n## Complexity: ${run.plan.complexity}\n\n${planContent}`;
      }
      if (planContent.length > 50) {
        writeFileSync(planFilePath, planContent, 'utf8');
        try {
          await execInProject(run.worktreePath,
            `git add SPRINT_PLAN.md && git commit -m "sprint: plan for ${run.task}" && git push origin ${run.branch}`);
        } catch { /* ok */ }
        run.addLog('system', `SPRINT_PLAN.md fallback 생성 완료 (units: ${hasUnits})`, '');
      }
    } catch (e) {
      run.addLog('system', `SPRINT_PLAN.md fallback 실패: ${e.message}`, '');
    }
  }

  run.addLog(planProfile.id, `플래닝 완료 (complexity: ${run.plan.complexity}, parallel: ${run.plan.hasParallel})`, '');
}

// ══════════════════════════════════════════════════
// Phase 2: Implementation — executeBatch 동적 에이전트 스폰
// AutoBE 패턴: executeCachedBatch → 워크유닛 N개를 세마포어로 병렬 처리
// 에이전트 풀에서 라운드로빈 배정, 독립 유닛은 동시 실행, 의존 유닛은 순차
// ══════════════════════════════════════════════════

async function phaseImplement(run) {
  // Step 0: Setup — 패키지 설치, shadcn 추가 등
  await phaseImplementSetup(run);
  if (run.isStopped()) return;

  // Step 1: SPRINT_PLAN.md 읽기 → 워크유닛 파싱
  let planText = '';
  try {
    const planPath = join(run.worktreePath, 'SPRINT_PLAN.md');
    planText = readFileSync(planPath, 'utf8');
  } catch {
    // Plan 파일 못 읽으면 fallback to solo
    run.addLog('system', 'SPRINT_PLAN.md 없음 — 단독 구현 fallback', '');
    return phaseImplementSolo(run);
  }

  const units = parseWorkUnits(planText);

  // 워크유닛 없거나 trivial → solo
  if (units.length <= 1 || run.plan?.complexity === 'trivial') {
    run.addLog('system', `워크유닛 ${units.length}개 — 단독 구현`, '');
    return phaseImplementSolo(run);
  }

  // Step 2: 의존성 기준으로 레이어 분리
  const { independent, dependent } = splitByDependency(units);
  run.addLog('system',
    `워크유닛 ${units.length}개 (독립: ${independent.length}, 의존: ${dependent.length}) — executeBatch 시작`,
    `concurrency: ${IMPL_SEMAPHORE}`);

  // Step 3: 독립 유닛 → executeBatch (병렬)
  if (independent.length > 0) {
    const batchUnits = independent.map(unit => ({
      id: unit.id,
      files: unit.files,
      description: buildUnitPrompt(run, unit),
    }));

    const results = await executeBatch(batchUnits, run);
    if (run.isStopped()) return;

    const failed = results.filter(r => r.error && r.error !== 'stopped');
    if (failed.length > 0) {
      run.addLog('system', `⚠️ ${failed.length}개 유닛 실패 — 재시도`, failed.map(f => f.unitId).join(', '));
      // 실패한 유닛만 재시도 (AutoBE separateCorrectionResults 패턴)
      const retryUnits = failed.map(f => {
        const orig = independent.find(u => u.id === f.unitId);
        return { id: orig.id, files: orig.files, description: buildUnitPrompt(run, orig) };
      });
      await executeBatch(retryUnits, run, Math.min(2, IMPL_SEMAPHORE));
    }
  }

  // Step 4: git 동기화 (병렬 에이전트들의 커밋 합치기)
  if (run.isStopped()) return;
  await execInWorktree(run, `git pull origin ${run.branch} --no-edit`);

  // Step 5: 의존 유닛 → executeBatch (의존성 해결된 것부터 순차 레이어)
  if (dependent.length > 0) {
    // 간단한 토포소트: deps가 모두 완료된 것부터 배치
    const completed = new Set(independent.map(u => u.id));
    const remaining = [...dependent];

    while (remaining.length > 0) {
      if (run.isStopped()) return;

      const ready = remaining.filter(u => u.deps.every(d => completed.has(d)));
      if (ready.length === 0) {
        // 순환 의존성 or 미해결 deps → 남은 것 전부 순차
        run.addLog('system', `의존성 미해결 ${remaining.length}개 — 순차 실행`, '');
        for (const unit of remaining) {
          if (run.isStopped()) return;
          await executeBatch([{
            id: unit.id, files: unit.files,
            description: buildUnitPrompt(run, unit),
          }], run, 1);
          completed.add(unit.id);
          await execInWorktree(run, `git pull origin ${run.branch} --no-edit`);
        }
        break;
      }

      const batchUnits = ready.map(unit => ({
        id: unit.id, files: unit.files,
        description: buildUnitPrompt(run, unit),
      }));

      await executeBatch(batchUnits, run);
      for (const u of ready) {
        completed.add(u.id);
        remaining.splice(remaining.indexOf(u), 1);
      }
      await execInWorktree(run, `git pull origin ${run.branch} --no-edit`);
    }
  }

  // Step 6: 통합 에이전트 — 전체 연결 확인
  if (run.isStopped()) return;
  await phaseImplementIntegrate(run);
}

/** Setup — 패키지 설치, shadcn 추가 (Plan의 Setup 섹션) */
async function phaseImplementSetup(run) {
  let planText = '';
  try {
    const planPath = join(run.worktreePath, 'SPRINT_PLAN.md');
    planText = readFileSync(planPath, 'utf8');
  } catch { return; }

  // Extract Setup section commands
  const setupMatch = planText.match(/##\s*Setup[\s\S]*?(?=\n##\s|$)/i);
  if (!setupMatch) return;

  const lines = setupMatch[0].split('\n');
  for (const line of lines) {
    const cmdMatch = line.match(/[-*]\s*(?:shadcn|패키지|npm|npx)\s*.*?:\s*(.+)/i);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      if (/^(npm|npx)\s/.test(cmd)) {
        run.addLog('system', `Setup: ${cmd}`, '');
        await execInWorktree(run, cmd, 120000);
      }
    }
  }
}

/** Solo 구현 — trivial 또는 워크유닛 파싱 실패 시 fallback */
async function phaseImplementSolo(run) {
  const profile = getProfile('dev_gwajang');
  run.addLog(profile.id, '구현 시작 (단독)', '');

  const convId = `sprint-${run.sprintId}-impl`;
  const task = {
    id: convId,
    description: buildImplPrompt(run, '메인 구현자', '계획의 모든 파일을 구현하세요.'),
  };

  await _runSubAgentLoop(convId, task, profile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 15, sprintMode: true });
  run.addLog(profile.id, '구현 완료', '');
}

/** 통합 에이전트 — 병렬 구현 후 전체 연결 확인 */
async function phaseImplementIntegrate(run) {
  const gwajang = getProfile('dev_gwajang');
  run.addLog(gwajang.id, '통합 검증 시작', '');

  await execInWorktree(run, `git pull origin ${run.branch} --no-edit`);

  const convId = `sprint-${run.sprintId}-integrate`;
  const task = {
    id: convId,
    description: `[SPRINT INTEGRATION - REACT/${run.toolchain.toUpperCase()}]
${run.preset.promptRules}

PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}

당신은 병렬 구현된 코드를 통합 검증하는 시니어 개발자입니다.
여러 에이전트가 각각 독립 파일을 구현했습니다. 전체가 잘 연결되는지 확인하세요.

수행할 작업:
1. READ SPRINT_PLAN.md — 전체 계획 확인
2. GLOB src/**/*.{ts,tsx} — 새로 생성된 파일 목록 확인
3. 주요 파일 READ하여 import 경로, 타입, export 일관성 확인
4. app/ 라우팅, 프로바이더 연결이 빠진 부분 있으면 EDIT로 추가
5. 불일치/누락 발견 시 EDIT로 수정
6. BASH git add -A && git commit -m "feat: integrate all units" && git push origin ${run.branch}

중요: 기존 구현을 덮어쓰지 마세요. 연결/통합만 하세요.`,
  };

  await _runSubAgentLoop(convId, task, gwajang, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 15, sprintMode: true });

  // Fallback commit after integration
  try {
    const statusCheck = await execInWorktree(run, 'git status --porcelain');
    if (statusCheck.output.trim()) {
      run.addLog(gwajang.id, '통합 미커밋 파일 — 엔진이 커밋', '');
      await execInWorktree(run, 'git add -A');
      await execInWorktree(run, `git commit -m "feat: integrate all units"`);
      await execInWorktree(run, `git push origin ${run.branch}`);
    }
  } catch (e) {
    run.addLog('system', `통합 커밋 실패: ${e.message}`, '');
  }

  run.addLog(gwajang.id, '통합 완료', '');
}

/** 개별 워크유닛 프롬프트 생성 */
function buildUnitPrompt(run, unit) {
  return `[SPRINT WORK UNIT - REACT/${run.toolchain.toUpperCase()}]
${run.preset.promptRules}

PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}
UNIT: ${unit.id} — ${unit.title}
FILES: ${unit.files.join(', ')}
TYPE: ${unit.type}

당신은 이 워크유닛만 담당하는 React 개발자입니다.
다른 에이전트가 동시에 다른 파일을 작업 중이니, 배정된 파일만 건드리세요.

수행할 작업:
1. READ SPRINT_PLAN.md — 전체 맥락 파악 (이 유닛의 역할 이해)
2. ${unit.type === 'modify' ? '기존 파일 READ → EDIT로 수정' : 'WRITE로 새 파일 생성'}
3. 대상 파일: ${unit.files.join(', ')}
4. 파일 완성 후:
   BASH git add ${unit.files.join(' ')} && git commit -m "feat(${unit.id.toLowerCase()}): ${unit.title}" && git push origin ${run.branch}

규칙:
- TypeScript (.tsx/.ts) 필수
- Tailwind CSS 유틸리티 클래스만
- 200줄 넘으면 분리
- useEffect deps 빠뜨리지 말 것
- 배정 파일 외 수정 금지`;
}

/** Solo 구현 프롬프트 빌더 */
function buildImplPrompt(run, roleName, roleInstruction) {
  return `[SPRINT IMPLEMENTATION - REACT/${run.toolchain.toUpperCase()}]
${run.preset.promptRules}

PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}

당신은 React 프로젝트의 ${roleName}입니다.

수행할 작업:
1. READ SPRINT_PLAN.md 로 계획 확인
2. ${roleInstruction}
3. 파일 하나 완성할 때마다:
   BASH git add <file> && git commit -m "feat: <설명>" && git push origin ${run.branch}
4. React/TypeScript 컨벤션 엄격히 준수 (위 CONVENTIONS 참고)
5. shadcn 컴포넌트 필요시: BASH npx shadcn@latest add <name> --yes
6. 새 패키지 필요시: BASH npm install <package>
7. 완료 후 최종 git push

중요:
- 모든 컴포넌트는 TypeScript (.tsx)
- Tailwind CSS 유틸리티 클래스만 사용
- import 경로는 상대경로 또는 tsconfig paths alias 사용
- 200줄 넘는 컴포넌트는 분리
- useEffect에 dependency array 빠뜨리지 말 것`;
}

// ══════════════════════════════════════════════════
// Phase 3: Validation — Compiler-Driven Self-Healing Loop
// AutoBE의 orchestrateRealizeCorrectCasting 패턴 적용:
//   compile → 실패 → diagnostics 추출 → 에이전트 수정 → 재컴파일
//   성공/실패 분리 → 실패분만 재귀 (life - 1)
// ══════════════════════════════════════════════════

async function phaseValidate(run) {
  const cmds = run.preset.validation[run.toolchain];

  // Get list of files changed by sprint vs base branch
  let changedFiles = '';
  const diffResult = await execInWorktree(run, `git diff --name-only --diff-filter=ACMR origin/${run.baseBranch}...HEAD`);
  if (diffResult.exitCode === 0) {
    changedFiles = diffResult.output
      .split('\n')
      .filter(f => /\.(ts|tsx)$/.test(f.trim()))
      .map(f => f.trim())
      .filter(Boolean)
      .join(' ');
  }

  // Only lint sprint-changed files — NEVER lint entire project (existing errors would block sprint)
  const lintCmd = changedFiles
    ? `npx eslint ${changedFiles} --format json`
    : 'echo "No changed files to lint — skipping"';

  const steps = [
    { name: 'typecheck', cmd: cmds.typecheck, label: 'TypeScript' },
    { name: 'lint', cmd: lintCmd, label: 'ESLint' },
    { name: 'build', cmd: cmds.build, label: 'Build' },
    { name: 'test', cmd: cmds.test, label: 'Test' },
  ];

  for (let cycle = 0; cycle < MAX_VALIDATE_CYCLES; cycle++) {
    if (run.isStopped()) return;
    run.validationCycles = cycle + 1;
    run.addLog('system', `검증 사이클 ${cycle + 1}/${MAX_VALIDATE_CYCLES}`, '');

    let allPassed = true;
    const cycleResults = {};

    for (const step of steps) {
      if (run.isStopped()) return;

      // Run validation command
      const result = await execInWorktree(run, step.cmd);
      const passed = result.exitCode === 0;
      cycleResults[step.name] = { passed, output: result.output };

      _poller?.broadcast('sprint:validate', {
        sprintId: run.sprintId, cycle: cycle + 1,
        command: step.name, label: step.label, passed,
      });

      if (passed) {
        run.addLog('system', `✅ ${step.label} 통과`, '');
        continue;
      }

      allPassed = false;
      run.addLog('system', `❌ ${step.label} 실패 — 에이전트 수정 시작`, result.output.slice(0, 500));

      // Self-healing: 에이전트에게 에러 전달 → 수정 → commit+push → 재실행
      let fixed = false;
      // Escalation: 원과장 → 핏대리 → 김부장 (AutoBE의 에스컬레이션 패턴)
      const agents = cycle === 0
        ? [getProfile('dev_gwajang')]
        : cycle === 1
          ? [getProfile('dev_gwajang'), getProfile('dev_daeri')]
          : [getProfile('dev_gwajang'), getProfile('dev_daeri'), getProfile('dev_bujang')];

      for (const fixAgent of agents) {
        for (let retry = 0; retry < VALIDATION_RETRY; retry++) {
          if (run.isStopped()) return;

          run.addLog(fixAgent.id, `${step.label} 수정 시도 ${retry + 1}/${VALIDATION_RETRY}`, '');

          const fixConvId = `sprint-${run.sprintId}-fix-${step.name}-c${cycle}-r${retry}`;
          const fixTask = {
            id: fixConvId,
            description: `[SPRINT VALIDATION FIX - ${step.label.toUpperCase()}]
PROJECT: ${run.worktreePath}

검증 명령 "${step.cmd}" 실행 결과 에러가 발생했습니다.

에러 출력:
\`\`\`
${result.output.slice(0, 3000)}
\`\`\`

수행할 작업:
1. 에러 분석
2. READ로 관련 파일 확인
3. EDIT로 에러 수정 (최소한의 변경만)
4. BASH git add -A && git commit -m "fix: ${step.label.toLowerCase()} errors" && git push origin ${run.branch}

중요: TypeScript strict 모드, ESLint 규칙 준수. 불필요한 any 타입 금지.`,
          };

          await _runSubAgentLoop(fixConvId, fixTask, fixAgent, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 10, sprintMode: true });

          // Fallback commit after fix
          try {
            const st = await execInWorktree(run, 'git status --porcelain');
            if (st.output.trim()) {
              await execInWorktree(run, 'git add -A');
              await execInWorktree(run, `git commit -m "fix: ${step.label.toLowerCase()} errors"`);
              await execInWorktree(run, `git push origin ${run.branch}`);
            }
          } catch { /* ok */ }

          // 재실행
          const recheck = await execInWorktree(run, step.cmd);
          if (recheck.exitCode === 0) {
            run.addLog(fixAgent.id, `✅ ${step.label} 수정 성공`, '');
            result.output = recheck.output;
            fixed = true;
            break;
          }
          result.output = recheck.output; // 최신 에러로 갱신
        }
        if (fixed) break;
      }

      if (!fixed) {
        run.addLog('system', `⚠️ ${step.label} 수정 실패 — 다음 사이클에서 재시도`, '');
        break; // 현재 사이클 중단, 다음 사이클로
      }
    }

    run.validationLog.push({ cycle: cycle + 1, results: cycleResults, allPassed });

    if (allPassed) {
      run.addLog('system', '✅ 모든 검증 통과', '');
      return;
    }
  }

  run.addLog('system', `⚠️ 검증 ${MAX_VALIDATE_CYCLES}사이클 완료 — 일부 미해결`, '');
}

// ══════════════════════════════════════════════════
// Phase 4: Review — 코드 리뷰 + 보안 리뷰 병렬
// AutoBE의 executeCachedBatch 패턴: 병렬 실행 + fail-fast
// ══════════════════════════════════════════════════

async function phaseReview(run) {
  const reviewerProfile = getProfile('dev_reviewer');
  const securityProfile = getProfile('dev_security');
  run.addLog('system', '코드 리뷰 + 보안 리뷰 시작', '');

  // 병렬 실행 (AutoBE의 Promise.all 패턴)
  const [codeReview, secReview] = await Promise.all([
    // 코드 리뷰
    runReviewAgent(run, {
      id: `sprint-${run.sprintId}-review-code`,
      profile: reviewerProfile,
      description: `[CODE REVIEW - REACT]

React 코드 리뷰 체크리스트:
${run.preset.reviewChecklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}

PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}

수행할 작업:
1. BASH git diff origin/${run.baseBranch}...${run.branch} -- . ':!package-lock.json' ':!node_modules'
2. 변경된 파일 각각 READ
3. 위 체크리스트 기반 코드 리뷰
4. Critical 이슈 발견 시 EDIT로 직접 수정 → BASH git add -A && git commit -m "review: fix code issues" && git push origin ${run.branch}
5. 리뷰 결과를 마지막에 텍스트로 출력 (이슈 수, 수정 수)`,
    }),

    // 보안 리뷰
    runReviewAgent(run, {
      id: `sprint-${run.sprintId}-review-sec`,
      profile: securityProfile,
      description: `[SECURITY REVIEW]

PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}

수행할 작업:
1. BASH git diff origin/${run.baseBranch}...${run.branch} -- . ':!package-lock.json' ':!node_modules'
2. GLOB으로 .env* 파일 확인 → .gitignore에 포함 여부 체크
3. SEARCH로 시크릿 패턴 스캔: API_KEY, password, token, secret, private_key
4. XSS 위험 패턴: dangerouslySetInnerHTML, innerHTML
5. SQL injection, 안전하지 않은 eval 사용 여부
6. 이슈 발견 시 EDIT로 직접 수정 → BASH git add -A && git commit -m "review: fix security issues" && git push origin ${run.branch}
7. 리뷰 결과를 마지막에 텍스트로 출력`,
    }),
  ]);

  run.reviewResult = { code: codeReview, security: secReview, criticalCount: 0 };
  run.addLog('system', '리뷰 완료', '');
}

async function runReviewAgent(run, { id, profile, description }) {
  try {
    return await _runSubAgentLoop(id, { id, description }, profile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 15, sprintMode: true });
  } catch (err) {
    run.addLog(profile.id, `리뷰 에러: ${err.message}`, '');
    return `(리뷰 실패: ${err.message})`;
  }
}

// ══════════════════════════════════════════════════
// Phase 5: Finalize — 최종 검토 + PR 생성
// ══════════════════════════════════════════════════

async function phaseFinalize(run) {
  const profile = getProfile('dev_bujang');
  run.addLog(profile.id, '최종 검토 + PR 생성', '');

  // 김부장 최종 검토 (가벼운 확인)
  const convId = `sprint-${run.sprintId}-finalize`;
  const task = {
    id: convId,
    description: `[FINAL REVIEW - REACT]
PROJECT: ${run.worktreePath}
BRANCH: ${run.branch}

수행할 작업:
1. BASH git diff origin/${run.baseBranch}...${run.branch} --stat
2. 변경 파일 핵심 부분 READ (3개 이내)
3. 치명적 문제 있으면 EDIT로 수정 → git commit+push
4. 최종 승인 여부 판단 출력`,
  };

  await _runSubAgentLoop(convId, task, profile, '', run.task, run._loopState, { projectContext: buildSprintProjectContext(run), maxIter: 10, sprintMode: true });

  // PR 생성 (gh CLI)
  await createPR(run);
  run.addLog(profile.id, '스프린트 완료', run.prUrl || '');
}

async function createPR(run) {
  const title = `[Sprint] ${run.task}`;
  const body = [
    '## Sprint Summary',
    `- **Task**: ${run.task}`,
    `- **Branch**: \`${run.branch}\``,
    `- **Toolchain**: ${run.toolchain}`,
    `- **Complexity**: ${run.plan?.complexity || 'unknown'}`,
    `- **Validation Cycles**: ${run.validationCycles}`,
    `- **Cost**: $${run.cost.total.toFixed(4)}`,
    '',
    '## Changes',
    run.changes.length ? run.changes.map(f => `- ${f}`).join('\n') : '(git diff --stat 참조)',
    '',
    '---',
    '🤖 Generated by Sprint Engine (AutoBE-inspired)',
  ].join('\n');

  try {
    const result = await execInProject(run.projectPath,
      `gh pr create --head ${run.branch} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`);
    // Extract PR URL from output
    const urlMatch = result.output.match(/https:\/\/github\.com\/[^\s]+/);
    run.prUrl = urlMatch ? urlMatch[0] : null;
    run.addLog('system', 'PR 생성 완료', run.prUrl || result.output);
  } catch (err) {
    run.addLog('system', `PR 생성 실패: ${err.message}`, '');
    // PR 생성 실패해도 스프린트 자체는 성공으로 처리
  }
}

// ══════════════════════════════════════════════════
// Git Worktree — 격리된 작업 공간
// ══════════════════════════════════════════════════

async function setupWorktree(run) {
  const projectName = basename(run.projectPath);
  const worktreePathFwd = dirname(run.projectPath) + '/' + `${projectName}-sprint-${run.sprintId}`;

  // Detect base branch FIRST (before worktree creation) — so we can branch from it
  const headRef = await execInProject(run.projectPath,
    'git symbolic-ref refs/remotes/origin/HEAD');
  if (headRef.exitCode === 0) {
    const detected = headRef.output.trim().replace(/^refs\/remotes\/origin\//, '');
    if (detected && !detected.includes('fatal')) run.baseBranch = detected;
  } else {
    const devCheck = await execInProject(run.projectPath, 'git rev-parse --verify origin/dev');
    if (devCheck.exitCode === 0) {
      run.baseBranch = 'dev';
    } else {
      const mainCheck = await execInProject(run.projectPath, 'git rev-parse --verify origin/main');
      if (mainCheck.exitCode === 0) run.baseBranch = 'main';
    }
  }
  run.addLog('system', `기본 브랜치: ${run.baseBranch}`, '');

  // Fetch latest from remote
  await execInProject(run.projectPath, `git fetch origin ${run.baseBranch}`);

  run.addLog('system', `워크트리 생성: ${worktreePathFwd}`, '');

  // Create worktree branching from origin/baseBranch (not local HEAD)
  const wtResult = await execInProject(run.projectPath,
    `git worktree add ${worktreePathFwd} -b ${run.branch} origin/${run.baseBranch}`);

  // Verify worktree was actually created
  const wtNative = IS_WIN ? toWinPath(worktreePathFwd) : worktreePathFwd;
  if (!existsSync(wtNative)) {
    throw new Error(`Worktree creation failed: ${wtResult.output}`);
  }

  // Push branch to remote so agents can push
  try {
    await execInProject(worktreePathFwd,
      `git push -u origin ${run.branch}`);
  } catch { /* remote might not exist, ok */ }

  // npm install (if package.json exists)
  if (existsSync(join(wtNative, 'package.json'))) {
    run.addLog('system', 'npm install 실행 중...', '');
    try {
      await execInProject(worktreePathFwd, 'npm install', 180000);
    } catch (err) {
      run.addLog('system', `npm install 경고: ${err.message}`, '');
    }
  }

  // Store forward-slash path (toWinPath applied only when needed for fs operations)
  run.worktreePath = worktreePathFwd;

  // Register worktree as valid tool root (so relative paths resolve here first)
  registerWorktreeRoot(worktreePathFwd);
  run.addLog('system', `워크트리 루트 등록: ${worktreePathFwd}`, '');
}

async function cleanupWorktree(run) {
  if (!run.worktreePath) return;
  unregisterWorktreeRoot(run.worktreePath);
  try {
    await execInProject(run.projectPath,
      `git worktree remove ${run.worktreePath} --force`);
  } catch { /* ok */ }
}

// ══════════════════════════════════════════════════
// Shell Execution Helpers
// ══════════════════════════════════════════════════

async function execInProject(cwd, cmd, timeout = 60000) {
  const shell = IS_WIN ? 'cmd' : '/bin/sh';
  const args = IS_WIN ? ['/c', cmd] : ['-c', cmd];
  const execCwd = IS_WIN ? toWinPath(cwd) : cwd;

  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd: execCwd, timeout, maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { exitCode: 0, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    return {
      exitCode: err.code || 1,
      output: ((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + (err.message || '')).trim(),
    };
  }
}

async function execInWorktree(run, cmd, timeout = 120000) {
  return execInProject(run.worktreePath, cmd, timeout);
}

// ══════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════

function getProfile(id) {
  // Sprint-specific profiles — Gemini pro for stability (no Claude CLI timeout)
  const sprintOverrides = {
    dev_bujang: { provider: 'gemini', model: 'gemini-2.5-pro', maxIter: 15 },
    dev_gwajang: { provider: 'gemini', model: 'gemini-2.5-pro', maxIter: 15 },
    dev_daeri: { provider: 'gemini', model: 'gemini-2.5-flash', maxIter: 12 },
    dev_sawon: { provider: 'gemini', model: 'gemini-2.5-flash', maxIter: 10 },
    dev_reviewer: {
      id: 'dev_reviewer', name: '이코드', rank: 'Asst.Mgr', team: 'dev', color: '#06b6d4',
      emoji: '🔍', provider: 'gemini', model: 'gemini-2.5-pro', maxIter: 10,
      persona: `너는 콕핏 개발팀의 코드 리뷰어 "이코드"야.
말투: "이 부분 한번 보겠습니다.", "리뷰 코멘트 남기겠습니다.", "여기 개선이 필요합니다."
특징: React 코드 리뷰 전문. 안티패턴 탐지, 성능 최적화 제안, 컨벤션 준수 확인.`,
    },
    dev_security: {
      id: 'dev_security', name: '방보안', rank: 'Asst.Mgr', team: 'dev', color: '#dc2626',
      emoji: '🛡', provider: 'gemini', model: 'gemini-2.5-pro', maxIter: 8,
      persona: `너는 콕핏 개발팀의 보안 리뷰어 "방보안"이야.
말투: "보안 관점에서 짚어보겠습니다.", "이건 위험합니다.", "시큐리티 패치 적용합니다."
특징: 보안 취약점 스캔 전문. OWASP Top 10, 시크릿 노출, XSS/CSRF 탐지.`,
    },
  };

  const base = AGENT_PROFILES[id] || AGENT_PROFILES.dev_gwajang;
  const override = sprintOverrides[id];
  if (!override) return base;
  // Full profile override (dev_reviewer/dev_security) or partial (dev_bujang etc.)
  if (override.id) return override;
  return { ...base, ...override };
}

function slugify(str) {
  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // ASCII only (Korean breaks git branch names)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || 'task';  // fallback if input was all non-ASCII
}

function extractComplexity(text) {
  if (!text || typeof text !== 'string') return 'medium';
  const lower = text.toLowerCase();
  if (/complexity:\s*trivial/i.test(lower)) return 'trivial';
  if (/complexity:\s*small/i.test(lower)) return 'small';
  if (/complexity:\s*large/i.test(lower)) return 'large';
  if (/complexity:\s*medium/i.test(lower)) return 'medium';
  return 'medium';
}

function saveSprintHistory(run) {
  try {
    const filePath = join(SPRINT_HISTORY_DIR, `${run.sprintId}.json`);
    writeFileSync(filePath, JSON.stringify(run.toJSON(), null, 2));
  } catch (err) {
    console.error('[Sprint] Failed to save history:', err.message);
  }
}

export function getSprintHistory() {
  try {
    const files = readdirSync(SPRINT_HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse().slice(0, 20);
    return files.map(f => {
      try { return JSON.parse(readFileSync(join(SPRINT_HISTORY_DIR, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
