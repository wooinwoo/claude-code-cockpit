# Cockpit 기능 로드맵

> 시니어 프롬프트 엔지니어 관점 분석 기반
> 작성일: 2026-02-21

---

## 현재 상태

Cockpit = Claude Code 멀티 프로젝트 통합 대시보드 (22개+ 프로젝트)

### 기존 탭

Overview / Terminal / Changes / README / Jira / CI/CD / Notes / Workflows / Agent

### 아키텍처 강점

- 프레임워크 제로 (raw node:http, 순수 DOM)
- 실시간 3중 통신 (SSE + WebSocket + HTTP)
- Git 동시성 제어 (withGitLock, 프로미스 체인 직렬화)
- 적응형 폴링 (탭 비활성 감속, git 타임아웃 EMA)
- 선언적 멀티에이전트 워크플로우 엔진 (LangGraph.js)

### 프롬프트 엔지니어링 강점

- 에이전트: 페르소나 기반 + XML 구조화 + 커스텀 도구 프로토콜
- AI 커밋: few-shot JSON 포맷 + 인간-인-더-루프 (D&D 파일 재배치)
- 워크플로우: 선언적 JSON 정의 + regex 조건 분기 + 사이클 제어
- debate.json: adversarial 멀티에이전트 패턴 (찬/반/심판)

---

## 확정 로드맵

### Phase 1: 세션 타임라인 — 최우선

> Claude Code 세션의 블랙박스를 연다.

**문제:** "이 프로젝트 아까 뭐 했더라?" 매번 기억 안 남.

**구현:**

```
[bid-ai-site] 오늘 세션 타임라인

14:02  세션 시작
14:03  Read server.js
14:05  Edit handleAuth() — 버그 수정
14:08  Bash npm test → 2개 실패
14:12  Edit test/auth.test.js — 테스트 수정
14:13  Bash npm test → 전부 통과
14:15  Bash git commit → feat: add auth handler

파일 변경: server.js (+42 -13), test/auth.test.js (+28 -5)
토큰: 45,230 / 비용: $1.82
```

**2단계 설계:**
- Level 1 (자동, 무비용): tool_use/result 로그만 파싱 → 타임라인 렌더링. 이것만으로 "뭐 했는지"는 파악 가능
- Level 2 (수동, 유비용): 버튼 누르면 LLM이 세션을 자연어로 요약

**설계 원칙:**
- Overview 프로젝트 카드에서 클릭으로 진입
- 큰 JSONL은 스트리밍 파싱 + 캐싱
- 세션 목록에서 날짜별 필터링

**구현 기반:** `lib/claude-data.js` JSONL 파싱 확장
**난이도:** 중 | **새 인프라:** 없음

---

### Phase 2: 스마트 알림

> 22개 프로젝트 중 지금 봐야 하는 것만 알려준다.

**문제:** 전부 일일이 확인해야 함. 중요한 거 놓침.

**알림 레벨 (2단계만):**
- 긴급 (빨강): CI 실패, 세션 에러 루프, 비용 예산 초과
- 정보 (회색): PR 머지 완료, 세션 완료, 빌드 성공

**설계 원칙:**
- 2단계 초과 금지. 중간 레벨 만들지 않음
- 프로젝트별 알림 on/off 필수
- 기존 폴러 변경 감지에 조건 분기만 추가

**하지 말 것:**
- "3일째 세션 안 열림" 같은 오지랖 알림
- 알림 종류 5개 이상 확장
- 모든 프로젝트 알림 강제 활성화

**구현 기반:** `lib/poller.js` 조건 추가 + `lib/notify.js` 활용
**난이도:** 하 | **새 인프라:** 없음

---

### Phase 3: 아침 브리핑

> 매일 아침 "어제 뭐 터졌지" 1초만에 파악.

**문제:** 22개 프로젝트 상태를 하나하나 확인하는 게 매일 아침 귀찮음.

**구현:**
- 서버 시작 / 매일 첫 접속 시 자동 생성
- 프로젝트별 상태 변화 (새 커밋, CI 결과, PR 변동, 세션 상태)
- 비용 일간/주간 집계
- 주의 필요 프로젝트를 상단으로 자동 정렬

**설계 원칙:**
- 별도 화면/탭 만들지 않음 → 안 보게 됨
- Overview 탭 상단에 접을 수 있는 배너로 표시
- 우선순위는 규칙 기반 (CI 실패 > 충돌 > 세션 죽음). LLM 호출 안 함
- LLM 요약은 선택 사항 (버튼 트리거)

**구현 기반:** 폴러 데이터 스냅샷 저장 (전날 vs 오늘 diff) + `lib/cost-service.js` 일별 집계
**난이도:** 중 | **새 인프라:** 스냅샷 JSON 1개

---

### Phase 4: 에이전트 스킬 시스템 (AgentSkills)

> 에이전트 도구 3개 고정 → 플러그인 확장 가능하게.

**문제:** 현재 에이전트 도구가 BASH(읽기전용), READ, SEARCH 3개 고정. 확장성 없음.

**구현:**
```
스킬 예시:
- git-status-all    전체 프로젝트 git 상태 조회
- cost-report       비용 리포트 생성
- ci-diagnose       CI 실패 원인 분석
- pr-summary        PR 변경사항 요약
- session-recap     Claude 세션 회고 요약

에이전트한테: "비용 리포트 뽑아줘"
→ cost-report 스킬 호출
→ lib/cost-service.js 데이터 가져와서 정리
→ 결과 반환
```

**설계 원칙:**
- 스킬 = 미니 워크플로우. 기존 워크플로우 엔진 위에 구축
- 스킬 정의는 JSON (워크플로우와 동일 포맷)
- `skills/` 디렉토리에 파일 추가하면 자동 등록
- 에이전트 시스템 프롬프트에 사용 가능한 스킬 목록 동적 주입

**안전장치:**
- 스킬도 읽기 전용 원칙 유지 (쓰기 스킬은 별도 승인 플래그)
- 스킬 실행 로그 전부 저장

**구현 기반:** `lib/agent-service.js` 도구 확장 + `lib/workflows-service.js` 재활용
**난이도:** 중 | **새 인프라:** `skills/` 디렉토리 + 스킬 JSON 파일들

---

### Phase 5: 멀티 프로젝트 일괄 명령

> 22개에 같은 작업 반복하는 노가다 제거.

**문제:** git pull, lint, audit 같은 걸 프로젝트마다 하나씩 해야 함.

**구현:**
- 화이트리스트 명령만 허용 (git pull, git status, npm audit 등)
- 프로젝트 선택 (전체 / 체크박스)
- 순차 실행이 기본 (병렬 옵션 별도)
- 결과 실시간 나열 (성공 초록 / 실패 빨강)

**안전장치:**
- 커스텀 명령 입력 불가 (또는 dry-run 강제)
- 파괴적 명령 (reset, clean, force push) 절대 불가
- 동시 실행 프로젝트 수 제한 (기본 3개)
- 실행 전 확인 다이얼로그 필수
- 실행 로그 전부 저장

**구현 기반:** `lib/git-service.js` 멀티 타겟 + 터미널 인프라 재활용
**난이도:** 중 | **새 인프라:** 화이트리스트 설정 JSON

---

### Phase 6: 프로젝트 간 컨텍스트 공유 — 보류

**현실적 제약:** Claude Code 세션에 외부에서 컨텍스트 주입하는 API가 없음.

**축소 구현 (가능한 범위):**
- 프로젝트 A 최근 변경 diff → 클립보드 복사
- 프로젝트 간 CLAUDE.md 동기화 UI
- 공유 프롬프트 스니펫 라이브러리

**재검토 조건:** Claude Code가 외부 세션 제어 API를 공개할 때
**상태:** 보류

---

## Forge — 자율 개발 엔진 (독립 탭)

> Workflows 탭 = 범용 멀티에이전트 파이프라인 (개인 도구)
> Forge 탭 = 코드 생산 + 품질 검증이 합쳐진 자율 개발 공장

### 컨셉

입력 하나 넣으면 설계→구현→검증→통합이 자동으로 돌아가는 코드 생산 파이프라인.
기존 프로젝트 코드베이스 위에서 동작하며, feature branch에서 격리 실행.

```
[입력]
"cost-service.js에 일별 집계 기능 추가해줘"
+ 대상 프로젝트 선택
+ 참고할 기존 코드 첨부 (선택)

        ↓ 전부 자동

[Phase A: 설계]
Architect  → 기존 코드 분석 + 구현 계획 + 인터페이스 설계
Critic     → 설계 공격 (안 되는 이유, 놓친 케이스)
Architect  → 방어 + 수정
→ 확정된 설계서

[Phase B: 구현] (순차 — 의존성 기반)
Builder A  → 백엔드 (API 계약이 기준점)
Builder B  → 프론트엔드 (Builder A 산출물 참조)
Builder C  → 테스트 (Builder A+B 산출물 기반)
→ 단일 스택이면 해당 Builder만 기동

[Phase C: 검증] (품질 — 적대적)
Attacker   → 코드 공격 (버그, 보안, 엣지케이스)
Builder    → 방어 + 수정
Attacker   → 재공격
→ 공격 통과할 때까지 반복 (새 이슈 0개 or 비용 상한 시 자동 종료)

[Phase D: 통합]
Integrator → 전체 코드 합성 + 정합성 확인
→ 최종 결과물

[출력]
완성된 코드 + 테스트 + 발견된 이슈 리스트 + diff
→ [diff 보기] [프로젝트에 적용] [PR 생성]
```

### 기존 프로젝트 통합 — 실행 가능성 분석

Forge가 실제 프로젝트 코드베이스 위에서 동작하기 위해 필요한 것과 현재 상태:

**이미 있는 것 (70% 준비됨):**

| 필요 기능 | 현재 상태 | 사용하는 모듈 |
|---|---|---|
| 프로젝트 목록/경로 조회 | 있음 | `projects.json`, `/api/projects` |
| 프로젝트 파일 읽기 | 있음 | `/api/file?path=` (2MB 제한, 경로 검증) |
| Git 상태/diff/log | 있음 | 전체 git read API |
| Feature branch 생성 | 있음 | `POST /api/projects/:id/git/create-branch` |
| Branch 전환 | 있음 | `POST /api/projects/:id/git/checkout` |
| 파일 스테이징 | 있음 | `POST /api/projects/:id/git/stage` |
| 커밋 | 있음 | `POST /api/projects/:id/git/commit` |
| Push / PR 생성 | 있음 | `POST /api/projects/:id/push` + gh CLI |
| Stash 저장/복원 | 있음 | 전체 stash API |
| 쉘 명령 실행 | 있음 | `workflows-service.js` shell 노드 (제한 없음) |
| 멀티스텝 LLM 파이프라인 | 있음 | `workflows-service.js` LangGraph 엔진 |
| 실시간 진행 표시 | 있음 | SSE `poller.broadcast()` |
| Git 동시성 제어 | 있음 | `withGitLock()` per-project |
| AI 커밋 메시지 생성 | 있음 | `POST /api/projects/:id/generate-commit-msg` |
| 비용 추적 | 있음 | `lib/cost-service.js` |

**새로 만들어야 하는 것 (30%):**

| 필요 기능 | 우선순위 | 난이도 | 상세 |
|---|---|---|---|
| 파일 쓰기 API | 긴급 | 낮음 | `POST /api/projects/:id/files/write` — 경로 검증 재활용 |
| 파일 생성/삭제 API | 긴급 | 낮음 | 위와 유사, `mkdir -p` 포함 |
| Diff 적용 API | 높음 | 중간 | unified diff → `git apply` |
| Forge 오케스트레이터 | 높음 | 중간 | `lib/forge-service.js` — 브랜치 관리 + 롤백 + 파이프라인 조율 |
| 테스트 러너 연동 | 높음 | 중간 | `npm test` 실행 + 결과 파싱 → LLM 피드백 |
| 프로젝트 파일 트리 API | 중간 | 낮음 | 디렉토리 재귀 스캔 (구조 파악용) |
| Forge 워크플로우 템플릿 | 중간 | 중간 | JSON 정의 2~3개 (기능 추가, 버그 수정, 테스트 추가) |
| 비용 예산 시스템 | 중간 | 중간 | Phase별/전체 토큰 상한 + 자동 중단 |

### 안전 모델: Feature Branch 격리

```
Forge 실행 흐름 (안전장치):

1. STASH — 현재 작업 보존
   POST /api/projects/:id/git/stash
   (dirty 상태면 자동 실행)

2. BRANCH — 격리된 브랜치 생성
   POST /api/projects/:id/git/create-branch
   네이밍: forge/<task>-<timestamp>
   ※ main/master에서 분기

3. EXECUTE — Forge 파이프라인 실행
   모든 파일 변경은 forge 브랜치에서만
   단위별 커밋 (설계, 구현, 수정 각각)
   테스트 실행 후 결과 피드백

4-A. 성공 시:
   → 브랜치 push
   → PR 생성 (gh CLI)
   → 원래 브랜치로 복귀
   → stash pop

4-B. 실패 시:
   → git reset --hard (브랜치 시작점으로)
   → forge 브랜치 삭제
   → 원래 브랜치로 복귀
   → stash pop
   → 실패 리포트 반환

5. NEVER — main/master 직접 수정 절대 불가
```

**이게 안전한 이유:**
- git API가 이미 main/master 삭제 차단 (server.js line 983)
- `withGitLock()`이 동시 git 작업 방지
- stash/restore가 기존 작업 보호
- feature branch라 전부 되돌리기 가능
- 사용자가 "적용" 버튼 누르기 전까지 원본 코드 안 건드림

### 리스크와 대응

| 리스크 | 심각도 | 대응 |
|---|---|---|
| 워크플로우 shell 노드에 명령 필터 없음 | 높음 | Forge 전용 제한된 shell executor 생성. 파일 쓰기, 테스트, 린트만 허용 |
| LLM이 악성 코드 생성 | 높음 | 파일 쓰기를 프로젝트 루트 내로 제한. `.env`, 인증 파일, CI 설정 쓰기 차단 |
| Forge가 working tree 오염 | 높음 | 항상 stash 먼저 + 전용 브랜치 + 패닉 버튼 (reset + 브랜치 삭제 + stash pop) |
| Forge 실행 중 사용자가 같은 프로젝트 수정 | 중간 | 프로젝트 레벨 "forge lock" 표시. 대시보드에 "Forge 실행 중" 인디케이터 |
| 토큰 비용 폭발 | 중간 | Phase별 토큰 상한 + 전체 작업 달러 상한 ($5 기본) + 상한 도달 시 자동 중단 |
| Builder 간 인터페이스 불일치 | 중간 | Phase A에서 인터페이스/타입 확정 → Builder들은 계약 준수. 함수 시그니처를 설계서에 고정 |
| 컨텍스트 윈도우 한계 | 중간 | 스코프 제한 강제: 파일 1~3개 수준 기능 단위. UI에서 가이드 |

### 모델 선택 — 역할별 멀티 모델 지원

기존 `workflows-service.js`가 Claude (CLI) + Google Gemini (LangChain) 둘 다 지원.
Forge 각 역할에 다른 모델을 배정해서 비용/품질 최적화.

**사용 가능 모델:**
- Claude Opus 4.6 — 최고 품질, 복잡한 설계/구현
- Claude Sonnet 4.6 — 균형, 코드 생성 주력
- Claude Haiku 4.5 — 빠르고 저렴, 단순 작업
- Gemini 2.5 Pro — Sonnet급 품질, 더 저렴
- Gemini 2.0 Flash — 초저렴, 패턴 매칭/단순 검증

**프리셋:**

```
💰 절약 모드    전부 Gemini Flash           ~$0.05/회
⚖️ 균형 모드    핵심=Sonnet, 나머지=Flash    ~$0.15/회  (기본값)
🎯 품질 모드    핵심=Opus, 나머지=Sonnet     ~$2.00/회
🔧 커스텀       역할별 직접 선택
```

**균형 모드 기본 매핑:**

| 역할 | 모델 | 이유 |
|---|---|---|
| Architect | Sonnet | 설계는 품질 중요 |
| Critic | Gemini Flash | 공격/반박은 빠르고 싸게 |
| Builder (로직) | Sonnet | 코드 생성은 품질 중요 |
| Builder (테스트) | Gemini Flash | 테스트 생성은 패턴 기반 |
| Builder (타입) | Haiku | 타입 정의는 단순 |
| Attacker | Gemini Flash | 패턴 매칭이라 충분 |
| Integrator | Haiku | 합치기만 하면 됨 |

**비용 상한선 (필수):**
- 1회 실행 상한: $3.00 (기본)
- 일일 상한: $10.00 (기본)
- 상한 도달 시 → 현재까지 결과 반환 + 자동 중단
- Phase별 토큰 상한 설정 가능

**구현 기반:** `workflows-service.js` 스텝별 `model` 필드 이미 지원. 프리셋 UI + 역할-모델 매핑 설정만 추가.

### 대상 프레임워크

Forge는 범용이 아니라 아래 스택 전용으로 설계. 프롬프트가 프레임워크별 컨벤션을 하드코딩.

| 구분 | 스택 | 테스트 |
|---|---|---|
| 프론트엔드 | React / Next.js (App Router) | Jest + React Testing Library |
| 백엔드 | NestJS | Jest + supertest |
| 공통 | TypeScript, ESLint, Prettier | — |

**자동 감지:** `package.json`의 dependencies로 프레임워크 판별
- `next` → Next.js 모드
- `@nestjs/core` → NestJS 모드
- 둘 다 있으면 → 모노레포, 경로 기반 분리

### 프롬프트 엔지니어링 — 데이터 흐름

```
[사용자 입력]
  task: "상품 상세 페이지에 리뷰 섹션 추가"
  project: bid-ai-site (Next.js)
  files: [components/ProductDetail.tsx, api/products.ts]

        ↓ Forge 오케스트레이터가 자동 수집

[자동 컨텍스트]
  package.json     → 프레임워크 감지 (next 14 + react 18)
  tsconfig.json    → 경로 alias (@/)
  .eslintrc        → 코딩 스타일
  파일 트리         → 관련 파일 추가 탐색

═══════════════════════════════════════════

[Phase A: 설계]

  Architect
    IN:  task + 기존 코드 + 프레임워크 정보
    OUT: 설계서 {
      summary,
      files_to_modify: [{ path, changes }],
      files_to_create: [{ path, purpose }],
      interfaces: [{ name, signature, types }],
      component_tree (React) or module_structure (Nest)
    }

  Critic
    IN:  설계서 + 기존 코드
    OUT: 공격 [{ id, severity, description, evidence }]

  Architect (방어)
    IN:  설계서 + 공격 목록
    OUT: 수정된 설계서 + 응답 [{ id, action: accepted|rejected, reason }]

═══════════════════════════════════════════

[Phase B: 구현] (순차 — 의존성 체인)

  오케스트레이터가 프레임워크 감지 결과로 Builder 조합+순서 결정:
    단일 스택 (React만)  → React Builder → Test Builder
    단일 스택 (Nest만)   → Nest Builder → Test Builder
    풀스택 (둘 다)       → Nest Builder → React Builder → Test Builder (순차)

  풀스택 순서 근거:
    1. Nest Builder가 먼저 API 엔드포인트 + DTO + 응답 타입 생산
    2. React Builder가 Nest 산출물을 참조하여 실제 API 호출 코드 작성
       → 설계서의 인터페이스 계약 + 실제 구현 코드 양쪽 참조 가능
    3. Test Builder가 양쪽 코드를 모두 보고 테스트 작성

  Nest Builder (1번째)
    IN:  확정 설계서 + 기존 백엔드 코드
    OUT: { new_files, edits }

  React Builder (2번째)
    IN:  확정 설계서 + 기존 프론트 코드 + Nest Builder 산출물
    OUT: { new_files, edits }

  Test Builder (3번째)
    IN:  확정 설계서 + React Builder 산출물 + Nest Builder 산출물
    OUT: { new_files, edits }

  === 순차 빌더 핸드오프 프로토콜 ===

  오케스트레이터가 Builder 간 데이터를 넘기는 방식:

  handoff_data 구조:
  {
    "design_doc": { ... },          // 확정 설계서 (공통)
    "reference_files": [...],        // 기존 프로젝트 코드 (공통)
    "prior_builder_output": {        // 이전 Builder 산출물 (누적)
      "nest": {                      // Nest Builder가 생산한 것
        "new_files": [...],          // 신규 파일 전체 내용
        "edits": [...],              // 기존 파일 편집 블록
        "applied_snapshot": [...]    // edits 적용 후 파일 상태 (오케스트레이터가 미리 적용)
      },
      "react": { ... }              // React Builder 산출물 (Test Builder에게 전달 시)
    }
  }

  컨텍스트 윈도우 관리:
    → 이전 Builder의 new_files는 전체 내용을 전달 (신규 파일이라 참조 필수)
    → 이전 Builder의 edits는 applied_snapshot으로 전달 (편집 블록보다 읽기 쉬움)
    → applied_snapshot = 오케스트레이터가 edits를 적용한 후의 파일 전체 내용
    → 참고 파일이 10개 이상이면: 설계서에 명시된 파일만 전달 (나머지 제외)
    → 전체 토큰이 모델 컨텍스트의 60% 초과 시:
      - 기존 코드에서 변경 대상이 아닌 파일을 제거
      - applied_snapshot에서 변경된 함수/클래스만 추출

  === 실패 처리 ===

  Builder 실패 케이스별 대응:

  1. JSON 파싱 실패 (Builder 출력이 깨진 JSON)
     → 1회 재시도 (포맷 재안내 + 이전 출력의 에러 위치 명시)
     → 2회 실패 → 해당 Builder 스킵, Integrator에게 실패 보고
     → UI에 "Nest Builder 출력 파싱 실패" 경고 표시

  2. Builder 타임아웃 (120초 기본, 설정 가능)
     → 스트리밍 중이면 30초 추가 대기
     → 최종 타임아웃 → 부분 출력이 있으면 그것을 사용
     → 출력 없으면 → 해당 Builder 스킵

  3. 앞 Builder 실패 후 뒤 Builder 동작
     → Nest Builder 실패 시: React Builder는 설계서만 보고 작업
       (prior_builder_output.nest가 빈 객체)
       설계서의 인터페이스 계약만으로도 API 호출 코드 작성 가능
     → React + Nest 둘 다 실패: Test Builder 스킵 (테스트 대상 코드 없음)
     → Phase B 전체 실패: Phase C 스킵 → Phase D에서 실패 리포트 생성

  4. 비용 상한 도달
     → 현재 Builder까지의 산출물로 Phase B 종료
     → 이후 Builder는 실행하지 않음
     → Phase C로 진행 (부분 코드라도 검증은 수행)

═══════════════════════════════════════════

[Phase C: 검증] (사이클 반복)

  Attacker
    IN:  전체 구현 코드 + 테스트 + 설계서 + 사이클 번호
    OUT: 이슈 [{ id, severity, title, scenario, expected, actual }]

  담당 Builder (방어) — 이슈의 파일 경로로 자동 라우팅
    프론트 이슈 → React Builder가 방어
    백엔드 이슈 → Nest Builder가 방어
    테스트 이슈 → Test Builder가 방어
    IN:  코드 + 이슈 목록
    OUT: 수정 코드 + 응답 [{ id, action: fixed|rebutted, detail }]

═══════════════════════════════════════════

[Phase D: 통합]

  Integrator
    IN:  전체 산출물 (코드 + 테스트 + 설계서 + 이슈 이력)
    OUT: 최종 파일 + diff + 요약
```

### 프롬프트 엔지니어링 — 수렴 규칙

적대적 검증이 무한루프에 빠지지 않기 위한 장치.
하드캡 없음. 자동 수렴.

**종료 조건 (어느 하나라도 충족하면 Phase D로 진행):**

| 조건 | 설명 |
|---|---|
| 새 이슈 0개 | Attacker가 유효 이슈를 못 찾음 → 통과 |
| 비용 상한 도달 | Phase C 예산 소진 → 현재까지 결과로 통합 |
| 동일 이슈 재제출 | 이전 사이클에서 rebutted된 이슈와 동일 → 루프 감지, 종료 |

**심각도 에스컬레이션:**

| 사이클 | 유효 심각도 | 비고 |
|---|---|---|
| 1 | HIGH + MED + LOW | 전부 유효 |
| 2 | HIGH + MED | LOW 자동 필터 |
| 3+ | HIGH만 | 계속 HIGH만 보다가 → 못 찾으면 종료 조건 1로 자동 종료 |

**이슈 품질 기준:**

```
유효한 이슈 (Attacker가 제출 가능):
  ✅ 구체적 입력 + 구체적 결과 + 왜 문제인지
  ✅ "getDailyCost(null)이 undefined 반환. 캐시 키가 'daily:null:null'로 오염"
  ✅ "ReviewSection에서 reviews가 빈 배열일 때 'No reviews' 대신 빈 화면"

무효한 이슈 (자동 필터):
  ❌ 추상적: "에러 핸들링이 부족할 수 있음"
  ❌ 측정 불가: "성능이 느릴 수 있음"
  ❌ 범위 밖: "다른 파일에서 이 함수를 잘못 쓸 수 있음"
  ❌ 취향: "이 변수명은 더 나은 이름이 있을 것 같음"
```

**Builder 방어 규칙:**

```
수정 (fixed):
  → 이슈 인정 + 코드 변경 + 변경 사유
  → 변경은 최소 범위 (해당 이슈만 수정, 주변 리팩토링 금지)

반박 (rebutted):
  → 기존 코드베이스 근거 제시 필수
  → "기존 getMonthlyCost도 동일 패턴이므로 일관성 유지"
  → 근거 없는 반박은 무효 → 수정으로 강제 전환

판단 기준:
  → 각 이슈를 독립적으로 판단 (전부 fixed도, 전부 rebutted도 가능)
  → 중요한 건 판단의 근거가 있는지이지, 비율이 아님
```

**Builder 방어 — 오케스트레이터 검증 로직:**

```
Builder 응답 수신 후 자동 검증:

1. 응답 완전성 검증
   → Attacker가 보낸 이슈 ID 전부에 대해 response가 있는지
   → 누락된 이슈 ID → 해당 이슈는 자동 fixed 처리 (Builder가 무시한 건 수용으로 간주)

2. rebuttal 품질 검증 (action: "rebutted"인 항목만)
   → evidence 필드가 비어있거나 10자 미만 → 약한 반박
   → evidence에 파일 경로(file:line) 또는 설계서 참조가 없음 → 약한 반박
   → 약한 반박 감지 시:
     a. 1회차: Builder에게 재요청 ("이슈 A2의 반박 근거가 불충분합니다.
        기존 코드의 구체적 위치를 명시하거나, fixed로 변경하세요.")
     b. 재요청 후에도 약한 반박 → 자동으로 fixed 전환
        (코드 변경은 오케스트레이터가 직접 못 함 → Integrator에게 위임)

3. fixed 품질 검증
   → code_change 필드에 before/after가 있는지
   → after가 before와 동일하면 → 실질 변경 없음 → 재요청
   → updated_files에 해당 파일의 편집 블록이 있는지

4. 다음 사이클 준비
   → rebutted된 이슈 목록을 rebutted_issues에 추가
   → fixed된 이슈의 코드 변경을 현재 코드에 반영
   → 반영된 코드를 Attacker의 다음 사이클 입력으로 사용
```

**Builder 방어 — 좋은 반박 vs 나쁜 반박 예시:**

```
이슈: "getDailyCost(null)이 에러를 던지지 않고 undefined를 반환"

✅ 좋은 반박:
{
  "issue_id": "A1",
  "action": "rebutted",
  "detail": "기존 cost-service.js의 모든 조회 함수가 동일 패턴 사용",
  "evidence": "getMonthlyCost(line 89), getSessionCost(line 142) 모두
    잘못된 입력에 undefined를 반환하고 호출부에서 처리.
    getDailyCost만 에러를 던지면 일관성 깨짐.
    기존 패턴: if (!param) return undefined; (line 89, 142, 201)"
}
→ 오케스트레이터: evidence에 파일:라인 참조 3개 → 유효한 반박

❌ 나쁜 반박 (자동 전환됨):
{
  "issue_id": "A1",
  "action": "rebutted",
  "detail": "null 체크는 불필요하다고 판단합니다",
  "evidence": ""
}
→ 오케스트레이터: evidence 비어있음 → 약한 반박 → 재요청 1회

❌ 재요청 후에도 나쁜 반박:
{
  "issue_id": "A1",
  "action": "rebutted",
  "detail": "호출부에서 처리하면 되는 문제입니다",
  "evidence": "일반적으로 그렇게 합니다"
}
→ 오케스트레이터: 구체적 파일 참조 없음 → fixed로 자동 전환
   → Integrator에게 "A1 이슈: Builder가 방어 실패, 수정 필요" 전달
```

**Attacker → Builder 이슈 라우팅 상세:**

```
Attacker 이슈의 domain 필드 기반 라우팅:

  domain: "react" → React Builder에게 전달
  domain: "nest"  → Nest Builder에게 전달
  domain: "test"  → Test Builder에게 전달

  domain 결정 기준 (Attacker가 판단):
    → code_ref의 파일 경로 기반
    → src/components/, src/app/, src/hooks/ → react
    → src/modules/, src/controllers/, src/services/ → nest
    → *.test.ts, *.spec.ts → test
    → 애매한 경우 (shared types 등) → 설계서의 files_to_modify 매핑 참조

  라우팅 실패 (domain이 없거나 잘못된 값):
    → 오케스트레이터가 code_ref의 파일 경로로 자동 판별
    → 판별 불가 → Integrator에게 직접 전달

  같은 Builder에게 여러 이슈가 갈 때:
    → 한번에 묶어서 전달 (API 호출 1회)
    → Builder는 모든 이슈를 한 응답에서 처리
```

**Critic 리뷰 규칙 (Phase A):**

```
체크리스트 기반 리뷰:
  → 아래 6개 카테고리를 반드시 전부 검토하고, 각 카테고리에 대해
    PASS(문제 없음) 또는 FAIL(구체적 결함) 판정을 출력
  → 전부 PASS여도 유효 (결함 없으면 0개 보고가 정답)
  → FAIL 판정에는 반드시 구체적 시나리오 포함

검토 카테고리:
  1. 엣지케이스 — null, 빈 배열, 에러 상태 처리 누락
  2. 기존 코드 일관성 — 프로젝트 기존 패턴과 불일치
  3. 타입 안전성 — any, 타입 단언, 제네릭 누락
  4. 모듈 경계 — 의존성 방향, 순환 참조, 책임 분리
  5. 테스트 가능성 — 외부 의존성 직접 호출, mock 불가 구조
  6. UI 상태 (React) / 에러 필터 (Nest) — 로딩/에러/빈 상태
```

**Critic 오케스트레이터 검증 로직:**

```
Critic 응답 수신 후 오케스트레이터가 자동 검증:

1. 구조 검증
   → JSON 파싱 성공 여부
   → checklist 배열에 6개 카테고리 전부 존재 여부
   → 각 항목의 verdict가 "PASS" 또는 "FAIL" 중 하나인지
   → FAIL 항목에 attacks 배열이 있는지

2. 품질 검증 (FAIL 항목만)
   → severity가 HIGH | MED | LOW 중 하나인지
   → scenario 필드가 비어있지 않은지
   → evidence 필드가 비어있지 않은지
   → scenario에 금지어 포함 여부: "might", "could", "maybe", "possibly"
     → 포함 시 해당 attack을 자동 제거 (vague issue 필터)

3. 재시도 조건
   → 6개 카테고리 중 누락 있으면 → 1회 재시도 (누락 카테고리 명시)
   → JSON 파싱 실패 → 1회 재시도 (포맷 재안내)
   → 2회 연속 실패 → Critic 스킵, 설계서를 그대로 확정
     (Critic이 설계를 못 깨면 설계가 괜찮다는 신호로 취급)

4. Architect에게 전달
   → FAIL verdict의 attacks만 필터링하여 Architect 방어에 전달
   → 전부 PASS면 → Phase A 즉시 종료, 설계서 확정
```

**Critic 출력 예시 (정상):**

```json
{
  "checklist": [
    {
      "category": "EDGE_CASES",
      "verdict": "FAIL",
      "attacks": [
        {
          "id": "C1",
          "severity": "HIGH",
          "description": "getDailyCost에 date가 undefined일 때 캐시 키 오염",
          "scenario": "getDailyCost('proj-1', undefined) 호출 시 캐시 키가 'daily:proj-1:undefined'로 저장. 이후 정상 호출에서도 오염된 캐시가 반환됨",
          "evidence": "기존 getMonthlyCost(line 89)는 if (!month) return null로 early return. 설계서에 date 검증 누락"
        }
      ]
    },
    {
      "category": "CODEBASE_CONSISTENCY",
      "verdict": "PASS"
    },
    {
      "category": "TYPE_SAFETY",
      "verdict": "PASS"
    },
    {
      "category": "MODULE_BOUNDARIES",
      "verdict": "PASS"
    },
    {
      "category": "TESTABILITY",
      "verdict": "FAIL",
      "attacks": [
        {
          "id": "C2",
          "severity": "MED",
          "description": "날짜 계산 로직이 Date.now()에 직접 의존",
          "scenario": "getDailyCost의 '오늘' 판단이 Date.now() 직접 호출. 테스트에서 날짜를 고정할 수 없어 시간대별로 테스트 결과가 달라짐",
          "evidence": "기존 코드에서 getSessionCost(line 142)는 dateProvider를 주입받음"
        }
      ]
    },
    {
      "category": "UI_STATES",
      "verdict": "PASS"
    }
  ]
}
```

**Critic 출력 예시 (전부 PASS — 유효한 결과):**

```json
{
  "checklist": [
    {"category": "EDGE_CASES", "verdict": "PASS"},
    {"category": "CODEBASE_CONSISTENCY", "verdict": "PASS"},
    {"category": "TYPE_SAFETY", "verdict": "PASS"},
    {"category": "MODULE_BOUNDARIES", "verdict": "PASS"},
    {"category": "TESTABILITY", "verdict": "PASS"},
    {"category": "UI_STATES", "verdict": "PASS"}
  ]
}
→ 오케스트레이터: attacks 0개 → Phase A 즉시 종료, 설계서 확정
```

### 프롬프트 엔지니어링 — 역할별 시스템 프롬프트

#### Architect

```
<system>
You are a senior software architect. Your job is to analyze the existing
codebase and create an implementation plan for the requested feature.

FRAMEWORK: {{framework}} (auto-detected)
PROJECT: {{project_name}}

RULES:
1. NEVER invent new patterns. Study the existing code and follow its conventions exactly.
   - If the project uses barrel exports → you use barrel exports
   - If the project uses specific naming (e.g., use-*.ts for hooks) → follow it
   - If the project has a specific folder structure → respect it

2. Output a DESIGN DOCUMENT in this exact JSON format:
{
  "summary": "one-line description of the change",
  "files_to_modify": [
    {"path": "src/...", "changes": "description of what changes and why"}
  ],
  "files_to_create": [
    {"path": "src/...", "purpose": "why this file is needed"}
  ],
  "interfaces": [
    {"name": "functionOrComponentName", "signature": "full TypeScript signature", "jsdoc": "brief doc"}
  ],
  "dependencies": ["package-name (reason)"],
  "{{framework_specific}}": {}
}

3. For Next.js projects, include:
   - "component_tree": component hierarchy with server/client boundary markers
   - Whether new files are Server Components or Client Components ('use client')
   - Data fetching strategy (RSC async, useQuery, SWR — match existing pattern)

4. For NestJS projects, include:
   - "module_structure": which module owns this feature
   - Controller → Service → Repository layering
   - DTO definitions with class-validator decorators

5. Keep scope SMALL. If the task requires more than 5 files, split into sub-tasks and note them.

6. Pin down interfaces precisely. Builders will code to these contracts.
   Every function signature must include parameter types and return types.
</system>

<context>
TASK: {{task_description}}
REFERENCE FILES:
{{#each reference_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
FILE TREE:
{{file_tree}}
</context>
```

#### Critic

```
<system>
You are a thorough design reviewer. Your job is to systematically check
the Architect's design against a quality checklist and report ONLY
real issues you can prove with concrete scenarios.

YOUR MISSION: Check every category. Report what you find — even if it's nothing.

CHECKLIST (you MUST evaluate ALL 6 categories):
1. EDGE CASES — null, empty, error state handling
2. CODEBASE CONSISTENCY — does the design follow existing project patterns?
3. TYPE SAFETY — any, unknown, missing generics, loose type assertions
4. MODULE BOUNDARIES — dependency direction, circular refs, responsibility separation
5. TESTABILITY — hard to mock dependencies, tightly coupled logic
6. UI STATES (React) / ERROR FILTERS (Nest) — loading, error, empty states

RULES:
1. For each category, output either:
   - PASS: "Checked. No issues found." (this is a valid and expected outcome)
   - FAIL: concrete flaw with severity, scenario, and evidence

2. Each FAIL MUST include:
   - severity: HIGH | MED | LOW
   - description: what's wrong
   - scenario: concrete example of how it breaks
   - evidence: reference to existing code that contradicts the design

3. QUALITY GATE — your output is rejected if:
   - You skip any of the 6 categories
   - Any FAIL is vague ("might cause issues", "could be problematic")
   - You invent issues that don't have concrete evidence
   - You report a FAIL without a testable scenario

4. It is PERFECTLY FINE to report 0 flaws if the design is clean.
   Fabricating issues is worse than finding none.

OUTPUT FORMAT:
{
  "checklist": [
    {"category": "EDGE_CASES", "verdict": "PASS"},
    {"category": "CODEBASE_CONSISTENCY", "verdict": "FAIL", "attacks": [
      {
        "id": "C1",
        "severity": "HIGH",
        "description": "...",
        "scenario": "When X happens, Y breaks because Z",
        "evidence": "In existing file A.tsx line ~N, the pattern is P, but design uses Q"
      }
    ]},
    ...
  ]
}
</system>

<context>
DESIGN DOCUMENT:
{{design_doc}}
EXISTING CODE:
{{#each reference_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
</context>
```

#### Architect (방어)

```
<system>
The Critic has attacked your design. Review each attack and respond.

For each attack, you MUST either:
- ACCEPT: Amend your design. Show the specific change.
- REJECT: Provide concrete evidence from the existing codebase.
  "I disagree" without evidence = automatic accept.

Then output your AMENDED design document (same JSON format as before).

RULES:
1. Evaluate each attack independently. All accepted, all rejected, or any mix is valid
   — as long as every decision has evidence-based reasoning.
2. Rejections must cite existing code: "In {{file}}:{{line}}, the same pattern is used"
3. Accepted attacks must result in visible changes to the design doc.
</system>
```

#### React Builder

```
<system>
You are a senior React/Next.js developer. Implement ONLY the frontend
portion of the feature as specified in the design document.

FRAMEWORK: Next.js (App Router)
LANGUAGE: TypeScript (strict mode)

RULES:
1. Follow the DESIGN DOCUMENT interfaces EXACTLY.
   Do not rename, reorder parameters, or change return types.

2. Match existing code style:
   - Import style (named vs default, ordering)
   - Naming conventions (PascalCase for components, camelCase for hooks)
   - File structure (one component per file, or colocated)
   - Error handling pattern (error boundary, try-catch in server actions)

3. Server Components by default. Only add 'use client' when necessary
   (event handlers, hooks, browser APIs).

4. Use the project's existing data fetching pattern (don't mix SWR and React Query).

5. Follow the project's CSS approach (Tailwind, CSS Modules, styled-components).

6. If this is a fullstack task, your code MUST call the API interfaces
   defined in the design document. Do NOT implement backend logic.
   Import types from shared type files specified in the design doc.

7. Output format depends on whether the file is NEW or EXISTING:
   - NEW files (files_to_create in design doc): Output COMPLETE file content.
     Every new file must be copy-pasteable and runnable.
   - EXISTING files (files_to_modify in design doc): Output EDIT BLOCKS only.
     Each edit block specifies an anchor (existing code to locate) and the replacement.
     Do NOT reproduce the entire file — only the changed sections.

OUTPUT FORMAT:
{
  "new_files": [
    {"path": "src/...", "content": "full file content", "type": "component"}
  ],
  "edits": [
    {
      "path": "src/existing-file.tsx",
      "changes": [
        {
          "anchor": "lines of existing code to locate (5+ lines for uniqueness)",
          "replacement": "new code replacing the anchor",
          "description": "what this change does"
        }
      ]
    }
  ]
}
</system>

<context>
DESIGN DOCUMENT:
{{final_design_doc}}
EXISTING CODE:
{{#each reference_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
{{#if nest_builder_output}}
BACKEND API (produced by Nest Builder — call these endpoints):
{{#each nest_builder_output.files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
{{/if}}
</context>
```

#### Nest Builder

```
<system>
You are a senior NestJS developer. Implement ONLY the backend
portion of the feature as specified in the design document.

FRAMEWORK: NestJS
LANGUAGE: TypeScript (strict mode)

RULES:
1. Follow the DESIGN DOCUMENT interfaces EXACTLY.
   Do not rename, reorder parameters, or change return types.

2. Match existing code style:
   - Import style (named vs default, ordering)
   - Naming conventions (camelCase, PascalCase for classes)
   - Module registration pattern
   - Error handling pattern (exception filters, HttpException)

3. Follow existing module registration pattern.

4. Use existing pipe/guard patterns for validation.

5. Match existing response format (envelope pattern, raw, etc.).

6. DTO definitions must use class-validator decorators matching existing patterns.

7. If this is a fullstack task, your API endpoints MUST match the interfaces
   defined in the design document exactly. The React Builder is coding to these contracts.

8. Output format depends on whether the file is NEW or EXISTING:
   - NEW files: Output COMPLETE file content.
   - EXISTING files: Output EDIT BLOCKS only (anchor + replacement).

OUTPUT FORMAT:
{
  "new_files": [
    {"path": "src/...", "content": "full file content", "type": "controller"}
  ],
  "edits": [
    {
      "path": "src/existing-file.ts",
      "changes": [
        {
          "anchor": "lines of existing code to locate (5+ lines for uniqueness)",
          "replacement": "new code replacing the anchor",
          "description": "what this change does"
        }
      ]
    }
  ]
}
</system>

<context>
DESIGN DOCUMENT:
{{final_design_doc}}
EXISTING CODE:
{{#each reference_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
</context>
```

#### Test Builder

```
<system>
You are a senior QA engineer specializing in test automation.
Write tests for the code produced by the React and Nest Builders.

LANGUAGE: TypeScript (strict mode)
TEST RUNNER: Jest

RULES:
1. You receive the IMPLEMENTATION FILES from other Builders.
   Write tests that verify their code works correctly.

2. For React components:
   - Use React Testing Library (render, screen, userEvent)
   - Test user interactions, not implementation details
   - Test loading/error/empty states
   - Mock API calls, not internal functions

3. For NestJS:
   - Controller unit tests (mock service)
   - Service unit tests (mock repository/external deps)
   - E2E tests with supertest for API endpoints

4. Follow existing test patterns:
   - File naming (*.test.ts or *.spec.ts — match project convention)
   - Mock patterns (jest.mock, factory functions)
   - Setup/teardown patterns (beforeEach, afterAll)

5. Cover these scenarios at minimum:
   - Happy path
   - Empty/null inputs
   - Error states
   - Edge cases from the design document

6. Test files are almost always NEW files. Output COMPLETE test files.
   If adding tests to an existing test file, use EDIT BLOCKS.

OUTPUT FORMAT:
{
  "new_files": [
    {"path": "src/...", "content": "full test file", "type": "unit_test"},
    {"path": "src/...", "content": "full test file", "type": "e2e_test"}
  ],
  "edits": [
    {
      "path": "src/existing.test.ts",
      "changes": [
        {
          "anchor": "existing describe block or import section",
          "replacement": "updated section with new tests added",
          "description": "what tests were added"
        }
      ]
    }
  ]
}
</system>

<context>
DESIGN DOCUMENT:
{{final_design_doc}}
IMPLEMENTATION FILES:
{{#each implementation_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
EXISTING TESTS:
{{#each existing_test_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
</context>
```

#### Attacker

```
<system>
You are a QA engineer trying to BREAK this code before it ships.
Your job is to find bugs, not to review code quality.

CYCLE: {{cycle_number}}
MINIMUM SEVERITY: {{min_severity}}

{{#if cycle_1}}Find ALL issues: HIGH, MED, LOW{{/if}}
{{#if cycle_2}}Only report HIGH and MED. LOW issues are filtered.{{/if}}
{{#if cycle_gte_3}}Only report HIGH. If nothing HIGH → output empty array.{{/if}}

PREVIOUSLY REBUTTED ISSUES (do NOT re-submit these):
{{#each rebutted_issues}}
- {{this.id}}: {{this.title}}
{{/each}}
If you have no NEW issues above minimum severity, output: { "issues": [] }

ATTACK VECTORS (try ALL of these):
1. Null/undefined inputs to every function
2. Empty arrays/objects where data is expected
3. Concurrent calls / race conditions
4. Error propagation (does a DB error reach the user as 500 or crash?)
5. Type coercion traps (string "0" vs number 0)
6. Missing cleanup (event listeners, subscriptions, timers)
7. React-specific: missing keys, stale closures, hydration mismatch
8. Nest-specific: missing validation decorators, unguarded endpoints

RULES:
1. Each issue MUST have a concrete scenario. NOT "this could break" but:
   "Calling getDailyCost(undefined, '2024-01-01') returns {undefined: ...}
    because line 148 does not check for null projectId"

2. You MUST reference specific lines or logic from the code.

3. FAILURE CONDITIONS:
   - Vague issues ("might have issues") → rejected
   - Style-only issues ("rename this variable") → rejected
   - Out-of-scope issues ("another module might...") → rejected
   - No concrete input/output scenario → rejected

OUTPUT FORMAT:
{
  "issues": [
    {
      "id": "A1",
      "severity": "HIGH",
      "domain": "react|nest|test",
      "title": "short description",
      "scenario": "When calling X with Y, Z happens",
      "expected": "should return/throw/render ...",
      "actual": "instead returns/throws/renders ...",
      "code_ref": "file:line — the specific code that causes this"
    }
  ]
}
NOTE: "domain" field is used by the orchestrator to route each issue
to the correct Builder for defense (React Builder, Nest Builder, or Test Builder).
</system>

<context>
IMPLEMENTATION:
{{#each code_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
TESTS:
{{#each test_files}}
--- {{this.path}} ---
{{this.content}}
{{/each}}
DESIGN DOCUMENT:
{{final_design_doc}}
</context>
```

#### Builder 방어 (React / Nest / Test 공통)

이슈의 `domain` 필드에 따라 오케스트레이터가 담당 Builder에게 라우팅.
각 Builder는 자기 도메인 이슈만 받음.

```
<system>
The Attacker found issues in YOUR code ({{domain}} domain).
For each issue, you MUST either:

FIX: Change the code. Show the exact change.
REBUT: Prove the issue is invalid with evidence from the existing codebase.
  "I disagree" without evidence = automatic fix.

RULES:
1. Evaluate each issue independently on its own merit.
   All fixed, all rebutted, or any mix — all are valid outcomes.
   What matters is that every decision has evidence-based reasoning.

2. Fixes must be MINIMAL. Don't refactor surrounding code.
   Change only what's needed to address the specific issue.

3. Rebuttals must cite evidence:
   "In existing {{file}}:{{line}}, the same pattern is used without this check"
   "The design document specifies this behavior in interfaces[N]"

OUTPUT FORMAT:
{
  "responses": [
    {
      "issue_id": "A1",
      "action": "fixed",
      "detail": "Added null check at line 148",
      "code_change": { "file": "...", "before": "...", "after": "..." }
    },
    {
      "issue_id": "A2",
      "action": "rebutted",
      "detail": "Existing getMonthlyCost in cost-service.ts:89 uses identical pattern",
      "evidence": "code snippet from existing file"
    }
  ],
  "updated_files": [
    {
      "path": "src/...",
      "is_new": false,
      "changes": [
        {
          "anchor": "existing code to locate",
          "replacement": "fixed code",
          "description": "what was fixed"
        }
      ]
    }
  ]
}
</system>
```

#### Integrator

```
<system>
You are the final gatekeeper. Merge all artifacts into deployable code.

YOUR CHECKLIST:
1. All files from ALL Builders (React + Nest + Test, latest versions after attack/defense)
2. API contracts match between React and Nest code (request/response types align)
3. All tests pass conceptually (no conflicting logic)
4. Interfaces match between files (imports resolve, types align)
5. No leftover debug code, TODOs, or commented-out blocks
6. Export/import consistency (barrel files updated if project uses them)
7. Shared types are in a single source of truth (not duplicated across front/back)

OUTPUT FORMAT:
{
  "final_files": [
    {"path": "src/...", "content": "complete file", "action": "create|modify"}
  ],
  "summary": "one paragraph of what was built and key decisions",
  "unresolved": ["any issues that were rebutted but still concerning"],
  "test_command": "npm test -- --testPathPattern=..."
}

If you find inconsistencies between files, FIX THEM silently.
Do not send back to Builder. Just fix and note in summary.
</system>
```

### 프롬프트 엔지니어링 — 편집 블록 적용 알고리즘

Builder들이 기존 파일을 수정할 때 "전체 파일 재출력" 대신 "편집 블록"을 사용한다.
오케스트레이터가 이 편집 블록을 실제 파일에 적용하는 알고리즘.

**편집 블록 구조:**

```json
{
  "path": "src/lib/cost-service.js",
  "changes": [
    {
      "anchor": "function getMonthlyCost(projectId, month) {\n  const cacheKey = `monthly:${projectId}:${month}`;\n  const cached = costCache.get(cacheKey);",
      "replacement": "function getMonthlyCost(projectId, month) {\n  if (!projectId || !month) return null;\n  const cacheKey = `monthly:${projectId}:${month}`;\n  const cached = costCache.get(cacheKey);",
      "description": "getMonthlyCost에 null 파라미터 early return 추가"
    }
  ]
}
```

**적용 알고리즘 (오케스트레이터):**

```
editBlock 적용 순서:

1. 파일 읽기
   → GET /api/file?path={projectRoot}/{editBlock.path}
   → 파일 내용을 originalContent에 저장

2. anchor 매칭 (각 change마다)
   a. 정확 매칭 시도
      → originalContent.indexOf(change.anchor)
      → 매칭되면 해당 위치의 anchor를 replacement로 치환

   b. 정확 매칭 실패 시 → 퍼지 매칭
      → anchor의 각 줄에서 앞뒤 공백 제거 후 재시도 (들여쓰기 차이 허용)
      → 여전히 실패 → anchor를 줄 단위로 쪼개서 첫 줄 + 마지막 줄로 범위 탐색

   c. 퍼지 매칭도 실패 시
      → 해당 change를 failed_edits에 기록
      → 나머지 changes는 계속 적용 시도

3. 충돌 감지
   → 같은 파일에 대해 여러 Builder가 편집 블록을 제출한 경우
   → 각 anchor의 문자 위치 범위를 계산
   → 범위가 겹치면 → 충돌 (conflict)
   → 충돌 시: Integrator에게 두 변경을 함께 전달하여 수동 병합 위임

4. 적용 순서
   → 같은 파일 내 여러 changes는 파일 끝→시작 순서로 적용
     (앞의 변경이 뒤 anchor의 위치를 밀어내는 것 방지)
   → 다른 파일 간에는 순서 무관

5. 결과
   → 성공한 edits: 파일에 즉시 적용 (POST /api/projects/:id/files/write)
   → 실패한 edits: Integrator에게 failed_edits로 전달
     → Integrator가 전체 파일 컨텍스트를 보고 직접 수정
```

**편집 블록 예시 (React Builder → 기존 컴포넌트 수정):**

```json
{
  "path": "src/components/ProductDetail.tsx",
  "changes": [
    {
      "anchor": "export default function ProductDetail({ product }: Props) {\n  return (\n    <div className=\"product-detail\">\n      <h1>{product.name}</h1>\n      <p>{product.description}</p>",
      "replacement": "export default function ProductDetail({ product }: Props) {\n  return (\n    <div className=\"product-detail\">\n      <h1>{product.name}</h1>\n      <p>{product.description}</p>\n      <ReviewSection productId={product.id} />",
      "description": "ProductDetail에 ReviewSection 컴포넌트 삽입"
    },
    {
      "anchor": "import { formatPrice } from '@/utils/format';",
      "replacement": "import { formatPrice } from '@/utils/format';\nimport { ReviewSection } from './ReviewSection';",
      "description": "ReviewSection import 추가"
    }
  ]
}
```

**anchor 작성 규칙 (Builder 프롬프트에 포함):**

```
1. anchor는 최소 3줄, 권장 5줄 이상으로 작성 (유일성 보장)
2. anchor 내용은 기존 파일의 코드를 정확히 복사 (공백, 줄바꿈 포함)
3. 한 파일에서 같은 anchor가 2군데 이상 매칭되면 적용 실패
   → 더 넓은 범위를 anchor에 포함하여 유일하게 만들 것
4. 변경 범위를 최소화: 수정하려는 줄 + 위아래 컨텍스트 줄만 포함
5. 파일 전체를 anchor로 잡지 말 것 (그럴 바에는 new_files 사용)
```

**Integrator의 편집 블록 처리:**

```
Integrator는 편집 블록이 아닌 최종 complete file을 출력함.
이유: Integrator 시점에서는 모든 Builder의 변경이 합쳐져야 하므로
      편집 블록 간 충돌 해소 + 정합성 확인이 필요.

Integrator 입력:
  → 각 Builder의 new_files (완전한 신규 파일)
  → 각 Builder의 edits (편집 블록)
  → 오케스트레이터가 edits를 임시 적용한 결과 파일
  → failed_edits (적용 실패한 블록)

Integrator 출력:
  → final_files: 전부 complete file content + action(create|modify)
  → 오케스트레이터가 최종 파일을 프로젝트에 기록
```

### 적정 스코프 가이드

| 스코프 | Forge 적합? | 이유 |
|---|---|---|
| 함수 1개 추가 | 아니오 | 과잉. Claude Code에서 직접 하는 게 빠름 |
| 파일 1~3개 수준 기능 | **적합** | 설계→구현→검증 파이프라인의 가치가 나옴 |
| 모듈 전체 리팩토링 | 주의 | 컨텍스트 한계. 파일별로 나눠서 여러 Forge 실행 |
| 시스템 전체 변경 | 아니오 | 컨텍스트 폭발. Agent Teams 영역 |

### PRD — 화면 설계

#### 화면 1: 작업 입력

```
┌─────────────────────────────────────────────────────────────┐
│ Forge                          [$0.00]  [⚖️ 균형]  [+ 새 작업] │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  작업 없음   │  새 Forge 작업                                  │
│            │                                                │
│            │  프로젝트                                       │
│            │  ┌────────────────────────────────┐            │
│            │  │ bid-ai-site                ▼  │            │
│            │  └────────────────────────────────┘            │
│            │                                                │
│            │  작업 설명                                       │
│            │  ┌────────────────────────────────┐            │
│            │  │ cost-service.js에 일별 집계     │            │
│            │  │ 기능 추가. getDailyCost 형태로   │            │
│            │  │ 기존 getMonthlyCost와 동일       │            │
│            │  │ 패턴으로 구현.                   │            │
│            │  └────────────────────────────────┘            │
│            │                                                │
│            │  참고 파일 (선택)                                 │
│            │  ┌────────────────────────────────┐            │
│            │  │ 📄 lib/cost-service.js    [✕]  │            │
│            │  │ 📄 lib/cost-service.test  [✕]  │            │
│            │  │          [+ 파일 추가]          │            │
│            │  └────────────────────────────────┘            │
│            │                                                │
│            │  모드                                           │
│            │  ┌────────┐ ┌────────┐ ┌────────┐             │
│            │  │⚡ 빠른  │ │⚖️ 기본 │ │🎯 꼼꼼  │             │
│            │  │ ~$0.08 │ │ ~$0.15 │ │ ~$1.00 │             │
│            │  │설계생략 │ │ 4단계  │ │병렬+꼼꼼│             │
│            │  └────────┘ └────────┘ └────────┘             │
│            │                                                │
│            │  모델 프리셋 [⚖️ 균형 ▼]   [상세 설정 ▶]         │
│            │  비용 상한  [$3.00  ]                            │
│            │                                                │
│            │              [🔥 Forge 시작]                    │
│            │                                                │
└────────────┴────────────────────────────────────────────────┘
```

- 프로젝트 드롭다운: `projects.json` 기반
- 참고 파일: `/api/file` 로 내용 로드 → LLM 컨텍스트에 주입
- 모드 선택: 빠른(설계 스킵) / 기본(4단계) / 꼼꼼(병렬+수렴까지)
- 상세 설정: 역할별 모델 매핑 직접 수정

**상세 설정 펼침:**

```
  모델 상세 설정
  ┌──────────────────────────────────────┐
  │ Architect      [Claude Sonnet 4.6  ▼] │
  │ Critic         [Gemini 2.0 Flash  ▼] │
  │ React Builder  [Claude Sonnet 4.6  ▼] │
  │ Nest Builder   [Claude Sonnet 4.6  ▼] │
  │ Test Builder   [Claude Haiku 4.5  ▼] │
  │ Attacker       [Gemini 2.0 Flash  ▼] │
  │ Integrator     [Claude Haiku 4.5  ▼] │
  │                                       │
  │ 검증: 자동 수렴 (새 이슈 0개 시 종료)   │
  │                        [프리셋 저장]   │
  └──────────────────────────────────────┘
```

#### 화면 2: 실행 중

```
┌─────────────────────────────────────────────────────────────┐
│ Forge                          [$0.12]  [⚖️ 균형]  [+ 새 작업] │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│ ● 실행중    │ 일별 집계 기능 추가               bid-ai-site    │
│  일별 집계  │ forge/daily-cost-20260221-143022               │
│  0:42      │                                                │
│            │ ┌Phase A──┐ ┌Phase B──┐ ┌Phase C─┐ ┌Phase D─┐ │
│ ○ 대기     │ │✅ 설계   │→│▶ 구현   │→│○ 검증  │→│○ 통합  │ │
│  PR 요약   │ │18초     │ │0:24... │ │        │ │        │ │
│            │ └─────────┘ └────────┘ └────────┘ └────────┘ │
│            │                                                │
│            │ Phase B: 구현                                   │
│            │ ┌──────────────────────────────────┐           │
│            │ │ Builder (Sonnet)         ███░ 70% │           │
│            │ │ getDailyCost() 작성 중...         │           │
│            │ └──────────────────────────────────┘           │
│            │                                                │
│            │ 실시간 로그                       [자동 스크롤]  │
│            │ ┌──────────────────────────────────┐           │
│            │ │ 14:30  Architect                  │           │
│            │ │  기존 cost-service.js 분석 완료    │           │
│            │ │  getMonthlyCost 패턴 기반 설계     │           │
│            │ │                                   │           │
│            │ │ 14:30  Critic                     │           │
│            │ │  날짜 경계 처리 누락 지적           │           │
│            │ │  타임존 이슈 가능성 제기            │           │
│            │ │                                   │           │
│            │ │ 14:30  Architect                   │           │
│            │ │  UTC 기준 통일 + 타임존 파라미터    │           │
│            │ │  설계 확정 ✅                      │           │
│            │ │                                   │           │
│            │ │ 14:31  Builder (Sonnet)            │           │
│            │ │  getDailyCost() 구현 시작          │           │
│            │ │  기존 캐시 구조 재활용...           │           │
│            │ └──────────────────────────────────┘           │
│            │                                                │
│            │ [⏸ 일시정지]  [⏹ 중단 (결과 반환)]              │
│            │                                                │
└────────────┴────────────────────────────────────────────────┘
```

- 상단 파이프라인 바: 4단계 진행 상태 한눈에 확인
- 좌측 사이드바: 작업 목록 + 실행 시간 + 비용 실시간
- 실시간 로그: SSE로 에이전트별 발언 스트리밍
- 역할별 아이콘/색상 구분 (Architect=파랑, Critic=빨강, Builder=초록, Attacker=주황)
- 중단 버튼: 현재까지 결과 반환 + 브랜치 정리

#### 화면 3: 검증 Phase

```
│ Phase C: 검증                       사이클 2/3     │
│                                                    │
│ ┌─ Attacker (Gemini Flash) ──────────────────┐     │
│ │                                            │     │
│ │ 🔴 이슈 #1 [높음]                           │     │
│ │ getDailyCost()에서 date가 undefined일 때     │     │
│ │ 캐시 키가 "undefined"로 저장됨               │     │
│ │                                            │     │
│ │ 🟡 이슈 #2 [중간]                           │     │
│ │ 날짜 범위가 미래일 때 빈 배열 대신             │     │
│ │ 에러를 던지는 게 나음                         │     │
│ │                                            │     │
│ │ ✅ 이슈 #3 [해결됨] — 사이클 1에서 수정       │     │
│ │ 캐시 만료 시간 미설정                         │     │
│ │                                            │     │
│ └────────────────────────────────────────────┘     │
│                                                    │
│ ┌─ Builder 방어 (Sonnet) ────────────────────┐     │
│ │ #1 수정: null check + early return 추가     │     │
│ │ #2 반박: 에러는 과잉, 빈 배열이 호출부 편의  │     │
│ └────────────────────────────────────────────┘     │
```

- 이슈 카드: 심각도별 색상 (높음=빨강, 중간=노랑, 해결=초록)
- 사이클 카운터: 현재/최대 표시
- Builder 방어: 수정 또는 반박 사유 표시
- 이전 사이클 이슈도 접힌 상태로 보관

#### 화면 4: 완료

```
┌─────────────────────────────────────────────────────────────┐
│ Forge                          [$0.18]  [⚖️ 균형]  [+ 새 작업] │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│ ✅ 완료     │ 일별 집계 기능 추가               bid-ai-site    │
│  일별 집계  │ forge/daily-cost-20260221         1분 32초      │
│  $0.18     │                                                │
│            │ ┌Phase A──┐ ┌Phase B──┐ ┌Phase C─┐ ┌Phase D─┐ │
│ ○ 대기     │ │✅ 설계   │→│✅ 구현   │→│✅ 검증  │→│✅ 통합  │ │
│  PR 요약   │ │18초     │ │31초     │ │34초    │ │9초     │ │
│            │ └─────────┘ └────────┘ └────────┘ └────────┘ │
│            │                                                │
│            │ 결과 요약                                       │
│            │ ┌──────────────────────────────────┐           │
│            │ │ 파일 변경                         │           │
│            │ │ 📄 lib/cost-service.js   +87 -12 │           │
│            │ │ 📄 lib/cost-service.test +142    │           │
│            │ │                                  │           │
│            │ │ 검증 결과                         │           │
│            │ │ 이슈: 3개 (해결 3 / 미해결 0)      │           │
│            │ │ 사이클: 2/3 (2회차 통과)           │           │
│            │ │                                  │           │
│            │ │ 비용 내역                         │           │
│            │ │ Architect (Sonnet)     $0.05     │           │
│            │ │ Critic (Flash)         $0.01     │           │
│            │ │ Builder (Sonnet)       $0.07     │           │
│            │ │ Attacker (Flash)       $0.02     │           │
│            │ │ Integrator (Haiku)     $0.01     │           │
│            │ │ 합계: $0.18 / 38,420 토큰         │           │
│            │ └──────────────────────────────────┘           │
│            │                                                │
│            │ ┌────────┐ ┌────────┐ ┌──────────┐            │
│            │ │📋 Diff  │ │📝 로그  │ │🔍 이슈    │            │
│            │ └────────┘ └────────┘ └──────────┘            │
│            │                                                │
│            │ [프로젝트에 적용]  [PR 생성]  [브랜치 삭제]       │
│            │                                                │
└────────────┴────────────────────────────────────────────────┘
```

- 결과 요약: 파일 변경, 검증 결과, 비용 내역 한눈에
- 3개 탭: Diff(코드 변경) / 로그(전체 대화) / 이슈(발견+해결 내역)
- 액션 버튼 3개: 적용(merge to current branch) / PR 생성(gh CLI) / 삭제(cleanup)

#### 화면 5: Diff 뷰 (Changes 탭 재활용)

```
│ Diff — forge/daily-cost-20260221                    │
│                                                     │
│ 📄 lib/cost-service.js                   +87 -12   │
│ ┌───────────────────────────────────────────────┐   │
│ │ 142   function getMonthlyCost(projectId) {    │   │
│ │ 143     // 기존 코드...                        │   │
│ │ 144   }                                       │   │
│ │ 145                                           │   │
│ │+146   function getDailyCost(projectId, date,  │   │
│ │+147     options = {}) {                       │   │
│ │+148     const { timezone = 'UTC' } = options; │   │
│ │+149     if (!projectId || !date) return null;  │   │
│ │+150                                           │   │
│ │+151     const cacheKey =                      │   │
│ │+152       `daily:${projectId}:${date}`;       │   │
│ │+153     const cached = costCache.get(cacheKey);│   │
│ │+154     if (cached) return cached;             │   │
│ │ ...                                           │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ 📄 lib/cost-service.test.js              +142       │
│ ┌───────────────────────────────────────────────┐   │
│ │+ 1   describe('getDailyCost', () => {         │   │
│ │+ 2     test('정상 일별 비용 반환', () => {      │   │
│ │ ...                                           │   │
│ └───────────────────────────────────────────────┘   │
```

- 기존 Changes 탭의 `js/diff.js` + `js/highlight.js` 그대로 재활용
- 파일별 접기/펼치기
- 라인 단위 syntax highlighting

#### UI 컴포넌트 재활용 비율

| 컴포넌트 | 출처 | 비고 |
|---|---|---|
| 좌측 사이드바 (작업 목록) | Jira 탭 이슈 목록 패턴 | 레이아웃 동일 |
| 실시간 로그 | CI/CD 탭 로그 뷰어 | 스트리밍 렌더링 |
| Diff 뷰 | Changes 탭 diff 뷰어 | 그대로 재활용 |
| Syntax highlighting | `js/highlight.js` | 그대로 재활용 |
| 토스트 알림 | `js/utils.js` | 완료/에러 알림 |
| 다이얼로그 | `js/modals.js` | 확인/설정 팝업 |
| SSE 연결 | `js/dashboard.js` | 실시간 데이터 |
| **새로 만드는 것** | | |
| 파이프라인 진행 바 | 신규 | Phase A→B→C→D 시각화 |
| 검증 이슈 카드 | 신규 | 심각도별 색상 + 상태 |
| 작업 입력 폼 | 신규 | 프로젝트 선택 + 모드 + 모델 |
| 모델 프리셋 셀렉터 | 신규 | 드롭다운 + 역할별 매핑 |
| 비용 breakdown | 신규 | 역할별 비용 내역 |

재활용 ~60% / 신규 ~40%

### Forge 풀빌드 스코프

단계 나누지 않음. 한번에 전부 구현.

```
[파이프라인]
  4단계: 설계(Architect+Critic) → 구현(Builder) → 검증(Attacker⇄Builder) → 통합
  적대적 검증 자동 수렴 (심각도 에스컬레이션 + 새 이슈 0개 시 종료)

[Builder 순차]
  Nest Builder    → 백엔드 코드 (API 계약 구현)
  React Builder   → 프론트엔드 코드 (Nest 산출물 참조)
  Test Builder    → 테스트 코드 (양쪽 산출물 기반)
  단일 스택 작업 → 해당 Builder만 기동
  풀스택 작업    → Nest → React → Test 순차 실행
  순차 이유: 뒤 Builder가 앞 Builder 산출물을 참조하여 실제 코드 기반으로 작업

[인프라]
  Feature Branch 격리 + stash 보호
  파일 읽기/쓰기/생성/삭제 API
  테스트 자동 실행 + 결과 피드백 루프
  멀티 모델 프리셋 (절약/균형/품질/커스텀)
  비용 상한 (Phase별 + 전체)
  Diff 뷰 + PR 생성

[학습 루프] (v1: 저장만, 주입은 보류)

  === 저장 구조 ===

  data/forge-history/
  ├── index.json                          ← 전체 인덱스 (프로젝트별 요약)
  ├── bid-ai-site/
  │   ├── index.json                      ← 프로젝트별 인덱스
  │   ├── task-20260221-143022.json       ← 개별 실행 결과
  │   └── task-20260222-091500.json
  └── cockpit-dashboard/
      ├── index.json
      └── task-20260222-103000.json

  === 개별 실행 결과 스키마 ===

  task-{timestamp}.json:
  {
    "taskId": "task-20260221-143022",
    "projectId": "bid-ai-site",
    "timestamp": "2026-02-21T14:30:22Z",
    "task_description": "cost-service.js에 일별 집계 기능 추가",
    "framework": "next",                   // 감지된 프레임워크
    "mode": "balanced",                    // 사용 모드

    "design": {
      "architect_model": "claude-sonnet-4-6",
      "critic_attacks_count": 2,           // Critic이 찾은 이슈 수
      "critic_pass_count": 4,              // PASS 카테고리 수
      "architect_accepted": 1,             // 수용한 공격 수
      "architect_rejected": 1              // 반박한 공격 수
    },

    "build": {
      "builders_used": ["nest", "test"],   // 기동된 Builder 목록
      "files_created": 2,
      "files_modified": 1,
      "total_lines_added": 229,
      "total_lines_removed": 12
    },

    "verification": {
      "total_cycles": 2,
      "termination_reason": "no_new_issues", // no_new_issues | cost_limit | duplicate
      "issues": [
        {
          "id": "A1",
          "severity": "HIGH",
          "domain": "nest",
          "title": "getDailyCost(null)에서 캐시 키 오염",
          "resolution": "fixed",           // fixed | rebutted
          "cycle_found": 1,
          "cycle_resolved": 1
        },
        {
          "id": "A2",
          "severity": "MED",
          "domain": "nest",
          "title": "미래 날짜에 빈 배열 대신 에러",
          "resolution": "rebutted",
          "cycle_found": 1,
          "cycle_resolved": 1,
          "rebuttal_evidence": "getMonthlyCost:89 동일 패턴"
        }
      ],
      "issue_stats": {
        "total": 3,
        "fixed": 2,
        "rebutted": 1,
        "by_severity": { "HIGH": 1, "MED": 1, "LOW": 1 }
      }
    },

    "cost": {
      "total_usd": 0.18,
      "total_tokens": 38420,
      "by_role": {
        "architect": { "usd": 0.05, "tokens": 12000, "model": "claude-sonnet-4-6" },
        "critic": { "usd": 0.01, "tokens": 3200, "model": "gemini-2.0-flash" },
        "nest_builder": { "usd": 0.07, "tokens": 15000, "model": "claude-sonnet-4-6" },
        "test_builder": { "usd": 0.02, "tokens": 4800, "model": "claude-haiku-4-5" },
        "attacker": { "usd": 0.02, "tokens": 2420, "model": "gemini-2.0-flash" },
        "integrator": { "usd": 0.01, "tokens": 1000, "model": "claude-haiku-4-5" }
      }
    },

    "result": {
      "status": "success",               // success | partial | failed
      "branch": "forge/daily-cost-20260221-143022",
      "pr_url": null,                     // PR 생성했으면 URL
      "applied": true,                    // 프로젝트에 적용했는지
      "duration_seconds": 92
    }
  }

  === 프로젝트 인덱스 스키마 ===

  data/forge-history/{projectId}/index.json:
  {
    "projectId": "bid-ai-site",
    "total_runs": 5,
    "last_run": "2026-02-22T09:15:00Z",
    "stats": {
      "success_rate": 0.8,               // 5건 중 4건 성공
      "avg_cost_usd": 0.22,
      "avg_cycles": 1.8,
      "avg_duration_seconds": 95,
      "common_issue_categories": [        // 빈도순 상위 5개
        { "pattern": "null_check_missing", "count": 3 },
        { "pattern": "cache_key_collision", "count": 2 }
      ],
      "rebuttal_success_rate": 0.4        // 반박 중 최종 수용된 비율
    },
    "runs": [
      { "taskId": "task-20260221-143022", "description": "일별 집계", "status": "success" },
      { "taskId": "task-20260222-091500", "description": "PR 요약 기능", "status": "success" }
    ]
  }

  === API 엔드포인트 ===

  GET  /api/forge/history/:projectId          → 프로젝트 인덱스 반환
  GET  /api/forge/history/:projectId/:taskId  → 개별 실행 결과 반환
  GET  /api/forge/history/stats               → 전체 프로젝트 통합 통계

  → 별도 생성 API는 없음. 오케스트레이터가 Forge 완료 시 자동 기록.
  → 삭제 API도 없음. 히스토리는 축적 전용.

  === v1 스코프 (이번 빌드) ===

  구현하는 것:
    - Forge 완료 시 위 스키마로 JSON 파일 자동 저장
    - 인덱스 파일 자동 갱신
    - 결과 화면에서 히스토리 목록 조회 (읽기 전용)
    - 3개 API 엔드포인트

  구현하지 않는 것:
    - 프롬프트 주입 ({{project_history}} 슬롯만 선언)
    - 패턴 추출 알고리즘 (common_issue_categories는 단순 카운팅만)
    - 크로스 프로젝트 학습 (프로젝트별 독립)

  === 프롬프트 주입 활성화 기준 (v2, 이번 빌드에 미포함) ===

  활성화 조건:
    → 해당 프로젝트의 실행 히스토리 10건 이상
    → common_issue_categories에 count 3 이상인 패턴 존재

  활성화 시 주입 위치:
    → Architect 프롬프트에: "이 프로젝트에서 자주 발견되는 이슈: {{common_issues}}"
    → Attacker 프롬프트에: "이 프로젝트의 과거 이슈 패턴: {{past_patterns}}"
    → Builder 프롬프트에: "이 프로젝트의 반박 성공 패턴: {{rebuttal_patterns}}"

  주입 데이터 형식:
    → 최대 5개 패턴, 각 패턴당 1줄 요약 (토큰 절약)
    → 예: "null_check_missing (3회): 조회 함수에 null 파라미터 체크 누락이 반복됨"

[Agent Teams 연동] (인터페이스만, 구현 보류)

  === FileExecutor 인터페이스 정의 ===

  /**
   * Forge가 파일 시스템을 조작할 때 사용하는 추상 인터페이스.
   * v1은 LocalFileExecutor (HTTP API 호출),
   * 향후 AgentTeamsExecutor로 교체 가능.
   */
  interface FileExecutor {
    // 파일 쓰기 (기존 파일 덮어쓰기)
    writeFile(projectId, path, content): Promise<ExecutorResult>

    // 파일 생성 (부모 디렉토리 자동 생성)
    createFile(projectId, path, content): Promise<ExecutorResult>

    // 파일 삭제
    deleteFile(projectId, path): Promise<ExecutorResult>

    // 쉘 명령 실행 (테스트 러너, 린트 등)
    runCommand(projectId, cmd, cwd?): Promise<CommandResult>

    // 여러 파일 일괄 적용 (트랜잭션)
    applyBatch(projectId, operations[]): Promise<BatchResult>
  }

  ExecutorResult:
  {
    success: boolean,
    path: string,
    error?: string        // 실패 시 에러 메시지
  }

  CommandResult:
  {
    success: boolean,
    stdout: string,
    stderr: string,
    exitCode: number,
    duration_ms: number
  }

  BatchResult:
  {
    success: boolean,
    results: ExecutorResult[],
    rolled_back: boolean   // 부분 실패 시 롤백 여부
  }

  === 에러 타입 ===

  FILE_NOT_FOUND      — writeFile 대상이 존재하지 않음
  PATH_OUTSIDE_ROOT   — 프로젝트 루트 밖 경로 접근 시도
  PERMISSION_DENIED   — .env, credentials 등 보호 파일 수정 시도
  DISK_FULL           — 디스크 공간 부족
  LOCK_CONFLICT       — 다른 Forge 작업이 같은 프로젝트에서 실행 중
  COMMAND_TIMEOUT     — runCommand가 타임아웃 초과 (기본 60초)
  COMMAND_BLOCKED     — 화이트리스트에 없는 명령 실행 시도

  === v1: LocalFileExecutor 구현 매핑 ===

  LocalFileExecutor가 기존 Cockpit API를 호출하는 매핑:

  writeFile(projectId, path, content)
    → POST /api/projects/{projectId}/files/write
      body: { path, content }
      ※ 신규 API (server.js에 추가 필요)

  createFile(projectId, path, content)
    → POST /api/projects/{projectId}/files/create
      body: { path, content, mkdir: true }
      ※ 신규 API (mkdir -p 포함)

  deleteFile(projectId, path)
    → DELETE /api/projects/{projectId}/files/{path}
      ※ 신규 API

  runCommand(projectId, cmd, cwd)
    → 기존 workflows-service.js의 shell 노드 재활용
      ※ 단, Forge 전용 화이트리스트 적용:
        허용: npm test, npm run lint, npx tsc --noEmit, git add, git commit
        차단: rm -rf, git push --force, npm publish, curl, wget 등
      ※ 타임아웃: 60초 (테스트는 120초)

  applyBatch(projectId, operations[])
    → 순차 실행 + 실패 시 롤백
    → 롤백 = git checkout -- {변경된 파일들}
    → 신규 생성 파일은 git clean -f로 제거
    → 롤백 후 BatchResult.rolled_back = true

  === 안전장치 ===

  모든 FileExecutor 구현이 공통으로 지켜야 할 규칙:

  1. 경로 검증: projectRoot 밖 경로 차단 (path traversal 방지)
     → path.resolve(projectRoot, inputPath)가 projectRoot로 시작하는지
  2. 파일 보호: 아래 패턴의 파일은 쓰기/삭제 차단
     → .env*, credentials*, *.pem, *.key, .git/*, node_modules/*
     → package-lock.json, yarn.lock (의존성 변경 방지)
  3. 크기 제한: 단일 파일 쓰기 최대 500KB (LLM이 생성한 코드 기준 충분)
  4. 로깅: 모든 파일 조작을 forge 실행 로그에 기록

  === AgentTeamsExecutor (미구현, 인터페이스만 예약) ===

  향후 Claude Code Agent Teams API가 공개되면:
    → FileExecutor 인터페이스를 구현하는 AgentTeamsExecutor 생성
    → Forge 설정에서 executor: "local" | "agent-teams" 선택 가능
    → 오케스트레이터는 executor 종류를 모름 (인터페이스만 호출)

  예상 차이점:
    → Local: HTTP API → 파일 직접 쓰기
    → Agent Teams: Claude Code 세션에 명령 전달 → 세션이 파일 조작
    → Agent Teams 장점: Claude Code의 코드 이해력 활용 가능
    → Agent Teams 단점: API 호출 오버헤드, 비용 추가

  지금 구현하지 않는 이유:
    → API 스펙 미공개 (2026-02 기준)
    → 인터페이스 추측으로 만들면 실제 API와 불일치 확률 높음
    → LocalFileExecutor만으로 Forge 전체 기능이 동작함
    → API 나오면 AgentTeamsExecutor 클래스 하나만 추가하면 됨
```

### Claude Code Agent Teams와의 관계

| | Agent Teams | Forge |
|---|---|---|
| 목적 | 큰 작업 분업 (생산성) | 코드 품질 검증 + 자동 생산 |
| 관계 | 협력 (같은 편) | 적대적 검증 내장 |
| 실행 환경 | CLI 터미널 / tmux | 웹 대시보드 |
| Windows 지원 | split pane 안 됨 | 됨 (웹 기반) |
| 비용 예측 | 불가 (세션 기반) | 가능 (파이프라인 고정) |
| 결과물 | 실제 파일 변경 | 검증된 코드 + diff + PR |
| 관계 | 상호 보완. 대체가 아님 | 어댑터 패턴으로 연동 준비 |

---

## 기존 개선 사항 (기능 추가 전 해결 권장)

### 보안

| 우선순위 | 항목 | 상세 |
|---|---|---|
| 긴급 | Jira 토큰 평문 노출 | jira-config.json에 API 토큰 그대로 저장. 암호화 또는 OS 키체인으로 전환 |
| 높음 | HTTPS 미지원 | LAN 통신이 평문. Jira 토큰, git 작업이 암호화 없이 전송 |
| 높음 | 에이전트 명령 차단 방식 | 블랙리스트(위험 명령 차단) → 화이트리스트(허용 명령만)로 전환 |

### 코드 품질

| 우선순위 | 항목 | 상세 |
|---|---|---|
| 높음 | server.js 모놀리스 | 1,844줄 단일 파일 → 라우트별 분리 |
| 높음 | style.css 비대 | 194KB 단일 CSS → 모듈화 또는 전처리기 도입 |
| 높음 | app.js 데드코드 | 195KB, js/main.js가 실제 엔트리포인트면 제거 대상 |
| 중간 | TypeScript | ~500KB JS 코드베이스에 타입 없음. 점진적 전환 검토 |
| 중간 | 테스트 부재 | git/쉘 실행하는 도구인데 테스트 0개. 핵심 로직부터 추가 |

### 프롬프트 엔지니어링

| 우선순위 | 항목 | 상세 |
|---|---|---|
| 높음 | 도구 호출 방식 | @@TOOL:TYPE@@ 딜리미터 파싱 → Claude 네이티브 tool_use API 전환. 안정성 대폭 향상 |
| 중간 | 프롬프트 하드코딩 | 코드에 직접 박혀있음 → 별도 파일/디렉토리로 분리 |
| 중간 | 출력 포맷 검증 | 워크플로우 LLM이 포맷 안 지켰을 때 fallback/retry 로직 없음 |

---

## 실행 순서

```
[대시보드 기능 강화]
Phase 1  세션 타임라인       ████████░░  JSONL 파싱 확장 + UI
Phase 2  스마트 알림         ████░░░░░░  폴러 조건 분기
Phase 3  아침 브리핑         ██████░░░░  스냅샷 diff + 배너 UI
Phase 4  에이전트 스킬       ████████░░  워크플로우 엔진 위에 구축
Phase 5  일괄 명령           ████████░░  안전장치 설계가 핵심
Phase 6  컨텍스트 공유       ░░░░░░░░░░  보류 (외부 API 대기)

[Forge — 자율 개발 엔진] (풀빌드)
Forge  전체 구현             ██████████  파이프라인 + 병렬 Builder + 학습 + Agent Teams 어댑터
```

Forge 전제 조건:
- 파일 쓰기/생성/삭제 API 추가 (server.js)
- `lib/forge-service.js` 신규 생성
- Forge 워크플로우 템플릿 JSON
- `data/forge-history/` 학습 데이터 디렉토리

---

## 검토 후 기각된 아이디어

### OpenClaw Heartbeat (자동 순찰) — 기각

30분마다 LLM이 "할 일 있나?" 판단하는 방식.
- 기각 사유: 폴러가 이미 5~30초마다 상태 체크 중. LLM 판단 레이어를 얹으면 비용만 늘고 폴러+규칙 기반으로 동일 효과 가능. Haiku라도 하루 48회 × 22개 프로젝트 컨텍스트 = 비용 낭비.
- 대안: Phase 2(스마트 알림) + Phase 3(아침 브리핑)의 규칙 기반 자동화로 대체.

### OpenClaw 메시징 연동 (Telegram/Discord 봇) — 기각

대시보드를 메신저로 조작하는 방식.
- 기각 사유: Cockpit은 로컬 도구. 메신저 봇은 외부 서버 또는 ngrok 필요 → 로컬 철학과 충돌. 이미 PWA로 모바일 접근 가능. 채널 어댑터 유지보수 비용 대비 ROI 안 나옴. OpenClaw은 메시징이 유일한 UI라 필수였지만, Cockpit은 이미 UI가 있음.

### OpenClaw 장기 기억 (사용자 선호 학습) — 기각

에이전트가 사용자 패턴을 학습하는 방식.
- 기각 사유: 사용자 1명인 로컬 도구에 학습 시스템은 과잉. "bid-ai-site 우선순위 높게 봄" → 핀 기능으로 해결. "Opus 비용 신경 씀" → 예산 설정으로 해결. 설정 JSON으로 되는 걸 LLM 메모리로 풀 이유 없음.

### 프롬프트 플레이그라운드 — 보류

멀티 모델 동시 비교, 프롬프트 버전 관리, 자동 평가 루프.
- 보류 사유: 프롬프트 엔지니어 전용 기능. 일반 개발자에겐 수동 작업이라 안 쓰게 됨. 자동 eval pipeline까지 가면 가치 있지만 개발 규모가 큼.
- 재검토 조건: Phase 4(에이전트 스킬) 완성 후 스킬 프롬프트 최적화 필요성이 생길 때.

---

## 브레인스토밍 (미검증)

> 추후 논의 필요. 우선순위 미정.

**비용 인텔리전스** — 프로젝트별/모델별/일별 트렌드, 예산 경고, 커밋당 ROI
**워크플로우 비주얼 에디터** — JSON 대신 노드 그래프 D&D, import/export
**세션 에러 자동 복구** — 에러 루프 감지 → 재시작 또는 대안 제안 (세션 제어 API 필요)
**프로젝트 헬스 스코어** — .git/node_modules 크기, CI 성공률, 세션 빈도 종합 점수

---

## 메인 세션 핸드오프 가이드

> 이 문서를 읽고 구현을 시작하는 Claude Code 세션을 위한 가이드.

### 절대 규칙

1. **코드 작성 전에 반드시 plan mode 진입**
2. **사용자 승인 없이 구현 시작하지 않음**
3. **한 번에 하나의 Phase만 작업**

### 구현 절차

```
Step 1: 이 문서 읽기
  → 전체 로드맵, Forge PRD, 기각된 아이디어 모두 파악

Step 2: 사용자와 작업 대상 선택
  → "어떤 Phase부터 시작할까요?" 물어보기
  → 사용자가 선택한 Phase에 집중

Step 3: Plan Mode 진입
  → EnterPlanMode 호출
  → 관련 코드 탐색 (server.js, lib/, js/ 등)
  → 기존 코드 패턴 파악 (프레임워크 제로, 순수 DOM, SSE 등)
  → 구현 계획 작성:
     - 수정할 파일 목록
     - 새로 만들 파일 (최소화)
     - API 엔드포인트 설계
     - UI 변경 범위
     - 안전장치 / 엣지케이스

Step 4: 사용자와 플랜 리뷰
  → ExitPlanMode로 플랜 제출
  → 사용자 피드백 반영
  → 승인될 때까지 반복

Step 5: 구현
  → 승인된 플랜대로만 구현
  → 스코프 변경 시 다시 사용자 확인
  → 완료 후 동작 확인

Step 6: 다음 Phase
  → Step 2로 돌아가기
```

### 코드베이스 핵심 규칙

이 프로젝트는 의도적으로 프레임워크를 사용하지 않음. 구현 시 반드시 지켜야 할 것:

- **서버**: raw `node:http` — Express/Koa 도입 금지
- **프론트**: 순수 DOM — React/Vue 도입 금지
- **CSS**: 단일 style.css — Tailwind/CSS-in-JS 도입 금지
- **통신**: SSE + WebSocket + HTTP 혼합 — 새 프로토콜 추가 금지
- **상태**: 전역 객체 (`projectStates`, `sessionStates`) — 상태 라이브러리 도입 금지
- **파일**: `lib/` (서버 모듈), `js/` (프론트 모듈), `workflows/` (JSON 정의)

### Phase별 시작점

| Phase | 먼저 읽을 파일 | 핵심 모듈 |
|---|---|---|
| 1. 세션 타임라인 | `lib/claude-data.js` | JSONL 파싱 |
| 2. 스마트 알림 | `lib/poller.js`, `lib/notify.js` | 폴링 + 알림 |
| 3. 아침 브리핑 | `lib/cost-service.js` | 스냅샷 diff |
| 4. 에이전트 스킬 | `lib/agent-service.js`, `lib/workflows-service.js` | 워크플로우 엔진 |
| 5. 일괄 명령 | `lib/git-service.js`, 터미널 인프라 | 멀티 타겟 실행 |
| Forge v1 | `lib/workflows-service.js`, `server.js` (git API) | 파이프라인 + 파일 쓰기 |

### 주의사항

- `server.js`는 1,844줄 모놀리스. 읽을 때 전체를 한번에 읽지 말고 섹션별로 탐색
- `app.js` (195KB)는 레거시 가능성 있음. `js/main.js`가 실제 엔트리포인트
- `style.css` (194KB)도 비대함. 기존 클래스명 규칙 파악 후 따라갈 것
- `workflows-service.js`의 shell 노드는 명령 필터가 없음 — Forge 구현 시 별도 제한 필수
- git 작업 시 반드시 `withGitLock()` 패턴 사용
