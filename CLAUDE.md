# Cockpit Dashboard

Claude Code 프로젝트 관리 대시보드. Tauri (Rust + WebView2) 데스크톱 앱으로 패키징되어 있음.

## 아키텍처

```
Tauri Shell (cockpit.exe)
  └─ WebView2 (index.html + ES Modules)
       ↕ HTTP/WS
  └─ Node.js Server (server.js, port 3847)
       ├─ node-pty (터미널 멀티플렉서)
       ├─ SSE (프로젝트 상태 폴링)
       ├─ WebSocket (터미널 I/O)
       └─ lib/ (서비스 모듈들)
```

- **프론트엔드**: Vanilla JS ES Modules, 프레임워크 없음. `<script type="module" src="js/main.js">`
- **백엔드**: Node.js, 의존성 최소 (ws, node-pty만). 자체 라우터 (`addRoute(method, pattern, handler)`)
- **빌드 도구 없음**: 번들러/트랜스파일러 없이 ES 모듈 직접 서빙. CDN 안 쓰고 `vendor/` 로컬 번들.

## 핵심 배포 규칙

### 이중 파일 시스템

소스 디렉토리와 실행 디렉토리가 **다름**:

| 용도 | 경로 |
|------|------|
| **소스 (개발)** | `c:/_project/template/wiw_claude-code/dashboard/` |
| **실행 (Cockpit 앱)** | `C:/Users/RST/AppData/Local/Cockpit/` |

- `cockpit.exe`는 `C:/Users/RST/AppData/Local/Cockpit/`에서 `server.js`를 실행
- `__dirname`이 Cockpit 디렉토리를 가리킴
- **파일 수정 후 반드시 Cockpit 디렉토리에도 복사해야 반영됨**
- `server.js` 변경 시 앱 재시작 필요 (프론트엔드 파일은 `Cache-Control: no-store`라 새로고침만으로 반영)

### 배포 절차

```bash
SRC="c:/_project/template/wiw_claude-code/dashboard"
DST="C:/Users/RST/AppData/Local/Cockpit"
cp "$SRC/파일명" "$DST/파일명"
```

서버 변경 시:
```bash
taskkill //F //IM cockpit.exe; sleep 2; start "" "$DST/cockpit.exe"
```

**중요: 사용자 확인 없이 앱 재시작하지 말 것.** 작업 중 끊김 발생.

## 프로젝트 구조

```
dashboard/
├── index.html          # SPA 단일 HTML (모든 뷰, 다이얼로그, 모달 포함)
├── style.css           # 전체 CSS (6200+ lines, CSS 변수 기반 테마)
├── server.js           # Node.js HTTP/WS 서버 (2000+ lines, 100+ API 라우트)
├── app.js              # 레거시 단일 파일 (사용 안 함, js/ 모듈로 분리됨)
├── js/                 # 프론트엔드 ES 모듈
│   ├── main.js         # 진입점, 초기화, 키보드 단축키, 이벤트 위임
│   ├── state.js        # 중앙 상태 객체 (app), pub/sub
│   ├── utils.js        # esc(), showToast(), timeAgo(), simpleMarkdown()
│   ├── dashboard.js    # Overview 탭: 프로젝트 카드, SSE, 차트, 통계
│   ├── terminal.js     # Terminal 탭: xterm.js, 분할 패널, WS I/O
│   ├── diff.js         # Changes 탭: git diff, 스테이징, 자동커밋, 브랜치
│   ├── jira.js         # Jira 탭: 이슈 목록/보드/타임라인, 드래그드롭
│   ├── agent.js        # AI 에이전트: Gemini 채팅, 음성입력, TTS, 도구 실행
│   ├── notes.js        # Notes 탭: 마크다운 문서 뷰어/에디터
│   ├── modals.js       # 모든 다이얼로그, 설정 패널, 커맨드 팔레트
│   ├── cicd.js         # CI/CD 탭: GitHub Actions 파이프라인
│   ├── forge.js        # Forge: AI 코드 생성
│   ├── workflows.js    # Workflows: 커스텀 자동화
│   ├── highlight.js    # diff 구문 강조
│   ├── logs.js         # 로그 뷰어
│   └── monitor.js      # 시스템 모니터
├── lib/                # 서버 서비스 모듈
│   ├── agent-service.js    # Gemini API 클라이언트, 에이전트 도구 시스템 (98KB)
│   ├── forge-service.js    # AI 코드 생성 서비스 (57KB)
│   ├── claude-data.js      # Claude 세션/대화 데이터 파서
│   ├── jira-service.js     # Jira REST API 클라이언트
│   ├── cost-service.js     # 토큰 사용량/비용 추적
│   ├── config.js           # 설정 관리 (projects.json, API keys)
│   ├── git-service.js      # git 명령어 래퍼
│   ├── github-service.js   # GitHub API (PR)
│   ├── cicd-service.js     # GitHub Actions API
│   ├── workflows-service.js # 워크플로우 엔진
│   ├── briefing-service.js # 일일 브리핑 생성
│   ├── batch-service.js    # 배치 작업 실행
│   ├── notes-service.js    # 노트 CRUD (파일시스템)
│   ├── poller.js           # 주기적 데이터 폴링
│   ├── session-control.js  # Claude 세션 시작/재개
│   ├── notify.js           # 알림 시스템
│   ├── monitor-service.js  # 시스템 리소스 모니터
│   ├── logs-service.js     # 로그 파일 파서
│   ├── wsl-utils.js        # WSL 경로 변환
│   └── qr.js               # QR 코드 생성 (모바일 접속)
├── vendor/             # 로컬 번들 라이브러리
│   ├── xterm.min.js, xterm.css
│   ├── addon-fit.min.js, addon-webgl.min.js, ...
│   └── chart.min.js        # Chart.js 4.4.7
├── src-tauri/          # Tauri 빌드 (Rust)
│   └── target/release/ # 빌드 산출물 (소스와 동일 구조 복사본)
├── notes/              # 노트 마크다운 파일 저장소
├── workflows/          # 워크플로우 정의 JSON
├── defaults/           # 기본 설정 파일
└── scripts/            # 유틸리티 스크립트
```

## 프론트엔드 패턴

### 상태 관리
```javascript
// js/state.js - 단일 뮤터블 객체
import { app } from './state.js';
app.projectList = [...];
app.devServerState = [...];
// pub/sub: subscribe('projects', fn), notify('projects', value)
```

### 이벤트 위임
모든 클릭 이벤트는 `data-action` 속성으로 처리. `main.js`의 단일 `document.addEventListener('click')` 핸들러:
```html
<button data-action="open-settings">Settings</button>
<button data-action="open-ide" data-id="proj1" data-ide="zed">Zed</button>
```
```javascript
// main.js
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  switch (el.dataset.action) {
    case 'open-settings': openSettingsPanel(); break;
    case 'open-ide': openIDE(el.dataset.id, el.dataset.ide); break;
  }
});
```
새 액션 추가 시: HTML에 `data-action`, main.js switch에 case 추가, 함수 import.

### 실시간 통신
- **SSE** (`/api/events`): 프로젝트 상태, git 정보, 세션 상태 폴링 → `dashboard.js:connectSSE()`
- **WebSocket** (port 3847): 터미널 I/O (create, input, resize, kill) → `terminal.js:connectWS()`

### CSS 테마
```css
:root { --bg-1: #0d1117; --text-1: #e6edf3; --accent: #6366f1; ... }
[data-theme="light"] { --bg-1: #ffffff; --text-1: #1f2937; ... }
```
`@media (max-width: 600px)` 블록에 모바일 반응형 스타일 (line 6070+ in style.css).

### 모바일 레이아웃
- 600px 이하: 헤더가 하단 탭 바로 이동
- `.header-right { display: none }` — 설정은 More 메뉴에서 접근
- `setupNavOverflow()`: OVERFLOW_THRESHOLD(5) 이후 탭은 More(⋮) 드롭다운으로

## 서버 API 구조

### 라우팅
```javascript
// server.js - 자체 라우터
addRoute('GET', '/api/projects', handler);
addRoute('POST', '/api/projects/:id/git/commit', handler);
```
`:id` 파라미터 → `req.params.id`, 쿼리 → `req.query`

### 주요 API 그룹
- `/api/projects` — CRUD, git 작업 (diff, stage, commit, push, pull, stash, branch)
- `/api/sessions` — Claude 세션 시작/재개/이력
- `/api/ai` — Gemini API 키 관리, 에이전트 채팅
- `/api/jira` — Jira 이슈, 보드, 스프린트, 상태 전환
- `/api/cicd` — GitHub Actions 파이프라인
- `/api/notes` — 노트 CRUD
- `/api/workflows` — 워크플로우 정의/실행
- `/api/forge` — AI 코드 생성
- `/api/dev-servers` — Dev 서버 시작/중지/상태
- `/api/open-in-ide` — IDE에서 파일 열기 (code, cursor, zed, windsurf, antigravity)
- `/api/open-url` — 브라우저에서 URL 열기 (default, firefox-dev)

### 보안
- CORS: localhost만 허용, LAN 접근 시 토큰 인증
- 파일 경로: `isInsideAnyProject()` — 등록된 프로젝트 내부만 허용
- IDE: whitelist (`known` 배열) — 화이트리스트 외 실행 불가

## AI 에이전트 (Gemini)

- 백엔드: `lib/agent-service.js` — GeminiClient 클래스
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`
- 모델: `gemini-2.0-flash` (기본), `gemini-2.5-pro`
- SSE 스트리밍 응답 → `onStream({type:'text', delta})` 콜백
- 도구 시스템: BASH, READ, WRITE, EDIT, GLOB, GREP, WEATHER 등 — `parseAgentResponse()`에서 도구 호출 파싱 후 실행, 결과를 다시 에이전트에 전달하는 루프

## 로컬 도구 경로

| 도구 | 경로 |
|------|------|
| Zed | `C:\Users\RST\AppData\Local\Programs\Zed\bin\zed.exe` |
| Firefox Dev Edition | `C:\Program Files\Firefox Developer Edition\firefox.exe` |
| VS Code | `code.cmd` (PATH) |
| Cursor | `cursor.cmd` (PATH) |
| Antigravity | `antigravity.cmd` (PATH) |

## 데이터 저장소

| 파일 | 내용 |
|------|------|
| `projects.json` | 프로젝트 목록 (id, name, path, color, devCmd, github, stack) |
| `jira-config.json` | Jira 연결 설정 (url, email, token) |
| `cost-cache.json` | API 비용 캐시 |
| `session-state.json` | 세션 상태 |
| `agent-history.json` | 에이전트 대화 이력 |
| `workflow-runs.json` | 워크플로우 실행 기록 |
| `notes/*.md` | 마크다운 노트 |
| `workflows/*.json` | 워크플로우 정의 |

## 자주 수정하는 파일

| 작업 | 파일 |
|------|------|
| UI 변경/뷰 추가 | `index.html` + 해당 `js/*.js` + `style.css` |
| 새 액션/버튼 | `index.html` (data-action) + `js/main.js` (switch case) |
| API 라우트 추가 | `server.js` (`addRoute()`) |
| 서비스 로직 | `lib/*.js` |
| 모바일 반응형 | `style.css` (`@media (max-width: 600px)` 블록, line 6070+) |
| 프로젝트 카드 버튼 | `js/dashboard.js:cardHTML()` (line ~570) |
| 터미널 우클릭 메뉴 | `js/terminal.js:showTermCtxMenu()` (line ~580) |
| 설정 패널 | `js/modals.js:openSettingsPanel()` + `index.html #settings-panel` |
