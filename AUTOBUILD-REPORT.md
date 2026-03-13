# AutoBuild 파이프라인 개발 리포트

> 작성: 2026-03-13
> 상태: **진행 중 — F-1 반복 실행/실패, F-2~F-4 미도달**

---

## 1. 개요

### 목표
Cockpit Dashboard에 **AutoBuild** 기능 추가 — AI 에이전트가 프로젝트 빌드 플랜을 자동 생성하고,
git worktree에서 feature 단위로 코드를 구현하는 자동화 파이프라인.

### 구현된 파일들 (신규)

| 파일 | 역할 | 크기 |
|------|------|------|
| `lib/project-plan.js` | AutoBuild 핵심 엔진 — 플랜 생성/실행/검증 파이프라인 | ~1100줄 |
| `lib/sprint-engine.js` | 스프린트 엔진 (기존, AutoBuild에서 일부 참조) | 기존 |
| `lib/sprint-presets.js` | 스프린트 프리셋 | 기존 |
| `routes/project-plan.js` | API 라우트 — generate/approve/execute/stop/list | 신규 |
| `routes/sprint.js` | 스프린트 라우트 | 기존 |
| `js/frontend-team.js` | 프론트엔드 팀 관리 UI | 신규 |
| `css/frontend-team.css` | 프론트엔드 팀 CSS | 신규 |

### 수정된 파일들

| 파일 | 변경 내용 |
|------|-----------|
| `server.js` | project-plan 라우트 등록 (+11줄) |
| `lib/agent-tools.js` | EDIT 도구 라인엔딩 정규화, fuzzy matching (+107줄) |
| `lib/agent-orchestrator.js` | SubAgent 프로필 provider 처리 개선 (+15줄) |
| `lib/agent-profiles.js` | dev 팀 에이전트 프로필 추가 (+16줄) |
| `lib/agent-service.js` | Gemini API 호출 개선 (+14줄) |
| `routes/agent.js` | 에이전트 라우트 미세 조정 |
| `index.html` | AutoBuild UI 탭/패널 추가 (+89줄) |
| `js/main.js` | data-action 핸들러 추가 (+5줄) |
| `js/dashboard.js` | 프로젝트 카드에 AutoBuild 버튼 (+12줄) |
| `js/company.js` | Company 탭 팀 관리 UI (+207줄) |
| `css/company.css` | Company 탭 스타일 (+143줄) |

---

## 2. 아키텍처

### 파이프라인 흐름

```
[사용자] → Generate Plan (AI가 feature 분해)
       → Approve Plan (사용자 검토)
       → Execute Plan (자동 실행)
          ├─ Phase 0: Setup
          │   └─ git worktree 생성 + npm install
          ├─ Phase 1: Feature 실행 (phase별 순차)
          │   ├─ setup phase features (F-1 등)
          │   ├─ core phase features (F-2, F-3 등) — 병렬 가능
          │   ├─ integration phase features (F-4 등)
          │   └─ 각 phase 후 validation + commit
          ├─ Phase 2: Final Validation
          └─ Phase 3: Review + PR 생성
```

### 핵심 컴포넌트

1. **Plan Generator** (`generatePlan`)
   - Gemini 2.5 Pro에게 프로젝트 구조 + 사용자 요구사항 전달
   - Feature 단위 분해 (id, title, description, phase, deps, files, type)
   - 출력: `plan.json` (plan-history/ 디렉토리에 저장)

2. **Pipeline Executor** (`executePlan` → `_runAutoBuildPipeline`)
   - git worktree 생성 (격리된 작업 공간)
   - 각 Feature를 SubAgent가 구현
   - Phase별 순차, Phase 내부는 dependency 기반 병렬 실행
   - Semaphore로 동시 실행 수 제한 (`IMPL_SEMAPHORE = 2`)

3. **SubAgent Loop** (`_runSubAgentLoop` in agent-orchestrator.js)
   - Gemini/Claude 에이전트가 BASH/READ/WRITE/EDIT/GLOB/GREP 도구 사용
   - 최대 `maxIter` 반복 (기본 15)
   - Structured JSON 포맷 (`tool_calls` 배열)

4. **Validation & Heal** (`_validateAndHeal`) — **현재 비활성화**
   - TypeScript 검사, ESLint, Build 순차 실행
   - 실패 시 에이전트가 자동 수정 시도
   - 너무 느려서 현재 스킵 처리

### API 엔드포인트

```
POST /api/project-plan/generate     — 플랜 생성 (AI)
POST /api/project-plan/approve/:id  — 플랜 승인
POST /api/project-plan/execute/:id  — 플랜 실행
POST /api/project-plan/stop/:id     — 실행 중단
GET  /api/project-plan/runs/:id     — 플랜 상태 조회
GET  /api/project-plan/list         — 전체 플랜 목록
```

---

## 3. 테스트 현황 및 발견된 문제들

### 테스트 프로젝트
- **Test AutoBuild** (`C:/_project/side/test-autobuild`)
- React + Vite + TypeScript 프로젝트
- 테스트 요청: "Tailwind CSS + shadcn/ui로 Todo 앱 만들기"
- 생성된 플랜: `plan-mmlj1utt` (4개 Feature)

### Feature 목록

| ID | Title | Phase | Status |
|----|-------|-------|--------|
| F-1 | Setup Environment for Tailwind CSS and shadcn/ui | setup | 반복 실행됨 (완료되지만 검증에서 블로킹) |
| F-2 | Create Core UI Components | core | 미도달 |
| F-3 | Implement Todo Application Logic | core | 미도달 |
| F-4 | Assemble the Todo Application | integration | 미도달 |

### 발견된 문제 (시간순)

#### 문제 1: Plan Generation JSON 파싱 실패 ⚠️ (해결됨)
- **증상**: Gemini가 반환한 JSON에 markdown 코드펜스(```json...```)가 감싸져 있어 파싱 실패
- **원인**: `generatePlan`에서 `JSON.parse()` 직접 호출
- **해결**: 코드펜스 스트리핑 로직 추가

#### 문제 2: Agent Provider 불일치 ⚠️ (해결됨)
- **증상**: SubAgent가 Claude Haiku로 실행됨 (Gemini 의도했는데)
- **원인**: `getProfile(agentKey)`가 `AGENT_PROFILES[template.id]`를 반환 → AGENT_PROFILES에 `provider: 'claude'`로 설정됨
- **해결**: `getProfile()`에서 AGENTS 템플릿의 provider/model 강제 적용
  ```javascript
  // 변경 전
  return AGENT_PROFILES[template.id] || { ... };
  // 변경 후
  return { ...base, provider: template.provider, model: template.model };
  ```

#### 문제 3: EDIT 도구 Structured JSON 포맷 (부분 해결)
- **증상**: Claude Haiku가 EDIT를 `{"tool":"EDIT","argument":"path"}` 형태로 호출 → `file`/`old_content`/`new_content` 누락
- **원인**: Claude의 structured JSON 출력이 EDIT의 multi-field 포맷을 올바르게 생성하지 못함
- **해결**: Gemini로 전환 후 Gemini는 `file`/`old_content`/`new_content` 필드를 올바르게 생성함

#### 문제 4: EDIT OLD_CONTENT 매칭 실패 ⚠️ (해결됨)
- **증상**: Gemini가 EDIT를 호출하면 "OLD_CONTENT 블록이 파일에서 찾을 수 없어영" 에러
- **원인 1**: Windows 파일의 `\r\n` 줄바꿈 vs 에이전트가 보내는 `\n`
- **원인 2**: trailing whitespace 차이
- **해결**: `executeEdit()`에 라인엔딩 정규화 + trimEnd 폴백 추가
  ```javascript
  content = content.replace(/\r\n/g, '\n');
  const oldNorm = oldContent.replace(/\r\n/g, '\n');
  // + trimEnd per line fallback
  ```

#### 문제 5: 상대 경로 사용 (부분 해결)
- **증상**: `../../side/test-autobuild-autobuild-plan-mmlj1utt/file.ts` 같은 상대 경로
- **원인**: 에이전트가 CWD 기준 상대 경로 생성
- **해결**: feature prompt에 "모든 파일 경로는 반드시 절대 경로" 규칙 추가

#### 문제 6: Validation 루프 과다 🔴 (우회함, 근본해결 필요)
- **증상**: `_validateAndHeal`이 setup phase 후 30분+ 블로킹
- **원인**:
  - `VALIDATION_CYCLES=3` × `VALIDATION_MAX_FIX=5` × 3 agent levels = 최대 45회 수정 시도
  - 각 수정 시도가 maxIter=10으로 실행 → 450+ API 호출 가능
  - TypeScript/Build 에러가 있으면 에이전트가 올바르게 수정하지 못하고 반복
- **임시 해결**: validation 전체 스킵 (`await _validateAndHeal(plan)` 주석 처리)
- **근본 해결 필요**:
  - validation을 선택적으로 (setup에선 스킵, final에서만)
  - fix 시도 횟수를 줄이고 (MAX_FIX=1, CYCLES=1)
  - 에이전트에게 에러 context를 더 잘 전달
  - 또는 validation을 별도 단계로 분리 (파이프라인 블로킹하지 않게)

#### 문제 7: Review Phase 블로킹 (우회함)
- **증상**: `REVIEW_ENABLED=true`이면 추가 에이전트 호출
- **해결**: `REVIEW_ENABLED = false`로 설정

#### 문제 8: Dev Server 불안정
- **증상**: 장시간 실행 중 dev server(3848) 프로세스 사망
- **원인**: 메모리 누수 또는 에이전트 API 호출 과다로 인한 OOM
- **해결 필요**: 메모리 모니터링, 에이전트 동시 실행 수 제한

---

## 4. 현재 설정값

```javascript
// lib/project-plan.js
const IMPL_SEMAPHORE = 2;         // 동시 feature 실행 수
const FEATURE_MAX_RETRY = 2;      // Feature 실패 시 재시도 횟수
const VALIDATION_MAX_FIX = 2;     // 검증 실패 시 수정 시도 횟수 (5→2)
const VALIDATION_CYCLES = 1;      // 검증 사이클 수 (3→1)
const REVIEW_ENABLED = false;     // 코드 리뷰 (비활성)

// AGENTS (Gemini 강제)
const AGENTS = {
  architect: { provider: 'gemini', model: 'gemini-2.5-pro' },
  senior:    { provider: 'gemini', model: 'gemini-2.5-pro' },
  mid:       { provider: 'gemini', model: 'gemini-2.5-flash' },
  junior:    { provider: 'gemini', model: 'gemini-2.5-flash' },
};

// Validation: 현재 주석 처리 (phase 후, final 모두 스킵)
```

---

## 5. 테스트 방법

### 환경
- **소스**: `C:/_project/template/dashboard/`
- **실행**: `C:/Users/RST/AppData/Local/Cockpit/` (소스에서 복사)
- **Dev Server**: `c:\tmp\start-devserver.bat` → port 3848
- **Cockpit App**: port 3847 (프로덕션)

### 테스트 절차

```bash
# 1. 파일 배포
SRC="c:/_project/template/dashboard"
DST="C:/Users/RST/AppData/Local/Cockpit"
cp "$SRC/lib/project-plan.js" "$DST/lib/project-plan.js"
cp "$SRC/lib/agent-tools.js" "$DST/lib/agent-tools.js"
cp "$SRC/routes/project-plan.js" "$DST/routes/project-plan.js"
cp "$SRC/server.js" "$DST/server.js"

# 2. 워크트리 정리
cd c:/_project/side/test-autobuild
git worktree prune
git worktree list | grep autobuild | awk '{print $1}' | xargs -I{} git worktree remove {} --force
git branch | grep autobuild | xargs -r git branch -D

# 3. 플랜 리셋 (이미 생성된 플랜 재사용)
node -e "
const fs = require('fs');
const p = '$DST/plan-history/plan-mmlj1utt/plan.json';
const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
plan.status = 'approved';
plan.worktreePath = null; plan.branch = null;
plan.startedAt = null; plan.endedAt = null;
plan.error = null; plan.currentPhase = null;
plan.features.forEach(f => {
  f.status = 'queued'; f.startedAt = null; f.endedAt = null;
  f.error = null; f.retryCount = 0; f.agentId = null; f.agentLog = [];
});
fs.writeFileSync(p, JSON.stringify(plan, null, 2));
"

# 4. Dev Server 시작
# (기존 서버 죽이기)
for pid in $(netstat -ano | grep ':3848' | grep LISTEN | awk '{print $NF}'); do
  taskkill //F //PID $pid
done
powershell -Command "Start-Process 'c:\tmp\start-devserver.bat' -WindowStyle Hidden"
sleep 10

# 5. 실행
curl -X POST http://localhost:3848/api/project-plan/execute/plan-mmlj1utt \
  -H "Content-Type: application/json" -d '{}'

# 6. 모니터링
# 상태 체크
curl -s http://localhost:3848/api/project-plan/runs/plan-mmlj1utt | node -e "..."

# 로그 확인
tail -f c:/tmp/devserver.log | grep "AutoBuild\|SubAgent\|EDIT\|WRITE"

# 7. 중단
curl -X POST http://localhost:3848/api/project-plan/stop/plan-mmlj1utt
```

### 새 플랜 생성 (처음부터)

```bash
# 프로젝트 ID 확인
curl -s http://localhost:3848/api/projects | node -e "..."
# → test-autobuild 프로젝트의 id 확인

# 플랜 생성
curl -X POST http://localhost:3848/api/project-plan/generate \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<ID>","description":"Tailwind CSS + shadcn/ui로 Todo 앱 만들기"}'

# 응답에서 planId 확인 후 승인
curl -X POST http://localhost:3848/api/project-plan/approve/<planId> \
  -H "Content-Type: application/json" -d '{}'

# 실행
curl -X POST http://localhost:3848/api/project-plan/execute/<planId> \
  -H "Content-Type: application/json" -d '{}'
```

---

## 6. 다음 단계 (TODO)

### 즉시 필요
1. **별도 데스크탑에서 E2E 테스트** — AutoBuild 실행 시 CPU/메모리 과다 사용
2. **F-2~F-4 도달 확인** — validation 스킵 후 실제로 모든 feature 완료되는지
3. **생성된 코드 품질 확인** — worktree에 실제로 동작하는 코드가 생성되는지

### 중기 개선
4. **Validation 전략 개선**
   - Phase별 validation on/off 설정
   - Fix 시도를 1회로 줄이고, 실패하면 경고만 남기고 계속 진행
   - 또는 validation을 async로 분리 (파이프라인 블로킹 안 함)
5. **EDIT 도구 안정성**
   - 에이전트가 OLD_CONTENT를 정확히 매칭하지 못하는 경우 fuzzy matching 강화
   - 줄 번호 기반 EDIT 모드 추가 고려
6. **프론트엔드 UI** — AutoBuild 진행상황 실시간 표시 (SSE)
7. **에러 리포팅** — Feature 실패 시 원인 분석 리포트

### 장기
8. **멀티 모델 전략** — setup은 Flash(빠른), core는 Pro(정확한)
9. **증분 실행** — 실패한 feature만 재실행
10. **PR 자동 생성** — 완료 후 GitHub PR 자동 생성

---

## 7. 파일별 주요 변경 상세

### lib/project-plan.js (신규, 핵심)
- `Plan` 클래스: 상태 머신 (draft → approved → running → done/failed/paused)
- `Feature` 클래스: 각 구현 단위
- `generatePlan()`: Gemini 2.5 Pro로 feature 분해
- `executePlan()`: 비동기 파이프라인 시작
- `_runAutoBuildPipeline()`: 메인 파이프라인 (setup → phase execution → validation → commit)
- `_setupWorktree()`: git worktree 생성 + npm install
- `_executeSingleFeature()`: SubAgent로 개별 feature 구현
- `_validateAndHeal()`: TypeScript/ESLint/Build 검증 + 자동 수정 (현재 비활성)
- `_buildFeaturePrompt()`: 에이전트에게 전달할 프롬프트 생성

### lib/agent-tools.js (수정)
- `executeEdit()`: \r\n → \n 정규화, trimEnd 폴백 매칭 추가
- 기존 strict match에서 normalized match로 개선

### lib/agent-orchestrator.js (수정)
- `_runSubAgentLoop()`: SubAgent에서 EDIT/WRITE 빌드 로직 사용
- provider 선택 로직이 profile.provider를 존중하도록 확인

### routes/project-plan.js (신규)
- REST API: generate, approve, execute, stop, list, get
- server.js에서 `setupProjectPlanRoutes(addRoute)` 호출

---

## 8. 알려진 제약사항

1. **Gemini API 비용**: Feature당 ~15 API 호출 × 4 features = ~60 호출/플랜
2. **실행 시간**: F-1만 ~5분, 전체 예상 20~30분 (validation 제외)
3. **메모리**: SubAgent 실행 중 Node.js 메모리 200MB+ 사용
4. **Windows 전용 이슈**: 줄바꿈(\r\n), 경로 구분자(\), taskkill 등
5. **git worktree 정리**: 실패 시 수동 정리 필요 (`git worktree remove --force`)
