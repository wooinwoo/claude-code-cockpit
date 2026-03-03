# Cockpit

여러 프로젝트의 Claude Code 세션, Git 상태, GitHub PR, 비용을 한 화면에서 모니터링하고 관리하는 로컬 대시보드.
Tauri 데스크탑 앱 (Windows/macOS) + PWA 모바일 지원.

```
http://localhost:3847
LAN: http://<PC IP>:3847
```

---

## 설치 가이드

### Windows

```powershell
# 필수
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudio.2022.BuildTools

# 권장
winget install Microsoft.PowerShell
winget install GitHub.cli
winget install Tailscale.Tailscale

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude  # OAuth 로그인
```

### macOS

```bash
# 필수
brew install node git

# 권장
brew install gh
brew install --cask tailscale

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude  # OAuth 로그인
```

> macOS는 Xcode Command Line Tools 필요: `xcode-select --install`

### 실행

```bash
cd dashboard
npm install
node server.js
```

또는 **데스크탑 앱**:
- Windows: `Cockpit_x.x.x_x64-setup.exe` (NSIS 인스톨러)
- macOS: `Cockpit_x.x.x_aarch64.dmg`

### 모바일 접속

같은 WiFi에서 `http://<PC의 IP>:3847` 접속. 헤더의 **Mobile Connect** 버튼으로 QR 코드 확인.

### Windows 자동 시작 (선택)

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
```

해제: `schtasks /delete /tn ClaudeCodeDashboard /f`

---

## 주요 기능

### Overview 탭
- **프로젝트 카드** — 세션 상태 (active/idle/none), 브랜치, 모델, uncommitted, 최근 커밋, PR 상태 실시간 표시
- **검색 & 필터** — 이름/스택/상태(All/Active/Idle) 필터링
- **카드 정렬** — 이름순, 활성도순, 최근활동순, 미커밋순 (드롭다운, localStorage 저장)
- **프로젝트 핀** — 별표로 즐겨찾기, 핀된 프로젝트 앞 정렬
- **Cost & Usage** — 오늘/이번 주/전체 토큰 사용량, 모델별 비용 추정, Chart.js 차트
- **Dev Server** — 프로젝트별 개발 서버 시작/중지, stdout에서 포트 자동 감지
- **IDE 연동** — VS Code, Cursor, Windsurf, Antigravity, Zed 원클릭 실행
- **GitHub PR** — 열린 PR 목록 (리뷰 상태, draft 여부)

### Terminal 탭
- **Multi-terminal** — 여러 프로젝트의 터미널을 탭으로 관리, 가로/세로 분할
- **Tab Bar** — 빠른 전환, 가운데 클릭으로 닫기, 드래그로 순서 변경
- **Branch/Worktree Picker** — 터미널 생성 시 브랜치나 worktree 경로 선택
- **Search** — Ctrl+F로 터미널 출력 내 검색
- **Font Size** — 터미널 글꼴 크기 조절 (+/-)
- **Export** — 터미널 출력을 TXT 파일로 내보내기
- **세션 복원** — 서버 재시작 시 터미널 세션 자동 복원
- **모바일 UI** — 탭 바 + 퀵 액션 바 (Esc, Tab, ^C, ^D 등) + 스와이프 전환

### Changes 탭
- **2-Column Diff View** — 파일 사이드바 + 파일별 접기/펼치기 가능한 diff 패널
- **Syntax Highlighting** — 정규식 기반 구문 하이라이팅 (JS/TS, Python, CSS, HTML, JSON, Rust, Go, Java, Shell 등 15+ 언어)
- **Staged/Unstaged** — 컬러 인디케이터 (인디고=staged, 옐로우=unstaged)
- **Line Numbers** — old/new 라인넘버 거터
- **Stage/Unstage/Discard** — 파일 단위 Git 스테이징 관리
- **수동 커밋** — 메시지 입력 후 직접 커밋 + Push
- **AI 커밋 메시지** — Haiku가 변경사항 분석 후 커밋 메시지 자동 생성
- **Git Operations** — Pull, Fetch, Stash, Stash Pop, Stash List, Branch Create/Delete

### AI Auto Commit
Claude Haiku가 `git status` + `git diff`를 분석해서 관련 파일을 논리적 커밋으로 자동 그룹핑.

1. "AI Commit" 버튼 → Haiku가 변경사항 분석 (3~5초)
2. 커밋 플랜: 커밋별 메시지 + 파일 목록 + 이유
3. 사용자가 수정: 메시지 편집, 파일 드래그 앤 드롭, 커밋 추가/삭제
4. "Commit All" → 순차 실행 (프로그레스 바)
5. "Push" 버튼으로 원격 푸시

> AI는 `claude -p --model haiku` CLI로 호출 — 별도 API 키 불필요, OAuth 인증 활용

### AI Agent 탭
- **Gemini 채팅** — Gemini 2.0 Flash / 2.5 Pro 모델 선택
- **9-Tool 에이전트** — BASH, READ, WRITE, EDIT, GLOB, GREP, GIT_DIFF, GIT_LOG, OPEN 도구 자동 실행
- **Agentic Loop** — 도구 호출 → 결과 피드백 → 다음 도구 자동 실행 (최대 25회)
- **음성 입력** — 웨이크워드 감지 + Web Speech API
- **TTS** — Edge TTS 음성 합성 (볼륨/속도/피치 조절)
- **대화 이력** — 멀티턴 대화, 이력 저장/로드

### Notes 탭
- **마크다운 뷰어/에디터** — 프로젝트별 노트 관리
- **사이드바 트리** — 계층적 노트 탐색
- **목차(TOC)** — 자동 생성

### Jira 탭
- **이슈 목록/보드/타임라인** — Jira REST API 연동
- **드래그 앤 드롭** — 이슈 상태 전환
- **스프린트 관리** — 보드별 스프린트 조회

### CI/CD 탭
- **GitHub Actions** — 파이프라인 상태 모니터링
- **워크플로우 실행/중지** — 직접 트리거

### Workflows 탭
- **커스텀 자동화** — JSON 기반 워크플로우 정의
- **스케줄링** — 예약 실행
- **실행 이력** — 상세 로그 조회

### Forge 탭
- **AI 코드 생성** — 프리셋 기반 코드 생성
- **안전 샌드박스** — .env, .git, node_modules 등 보호
- **실행 이력** — 생성 결과 적용/검토

### Port Manager 탭
- **시스템 포트 스캔** — 리스닝 포트 + 프로세스 정보
- **Dev Server 태깅** — 프로젝트 소유 포트 자동 표시
- **프로세스 Kill** — PID 기반 프로세스 종료
- **5초 자동 갱신** — 실시간 모니터링

### API Tester 탭
- **HTTP 요청 프록시** — GET/POST/PUT/DELETE 등 모든 메서드
- **요청 저장** — 재사용 가능한 요청 CRUD
- **헤더/바디 편집** — JSON 바디, 커스텀 헤더

### System Monitor
- **CPU 사용률** — 300ms 샘플링
- **메모리** — 전체/사용/여유
- **디스크** — 드라이브별 사용량
- **Top 프로세스** — 메모리 상위 15개

---

## Desktop App (Tauri)

Tauri 2로 패키징된 네이티브 데스크탑 앱.

| 플랫폼 | 인스톨러 | 비고 |
|--------|----------|------|
| Windows | NSIS `.exe` | WebView2 사용 |
| macOS | `.dmg` | 최소 macOS 11.0 |

- **자동 서버 관리** — 앱 시작 시 Node.js 서버 자동 기동, 종료 시 정리
- **네이티브 알림** — Windows 토스트 / macOS 알림 센터
- **인스톨러 빌드** — `npm run build`

---

## Mobile / PWA

- **LAN 접근** — `0.0.0.0:3847` 바인딩, 같은 네트워크에서 접근 가능
- **QR 코드** — Mobile Connect 버튼 → QR + URL (토큰 기반 인증)
- **PWA** — manifest.json + Service Worker, 홈 화면 설치 가능
- **반응형** — 카드/터미널/diff 모바일 최적화
- **Tailscale** — 외부 네트워크에서도 WireGuard E2E 암호화로 안전 접근

---

## Notifications

3단계 알림 시스템:
1. **네이티브 알림** — Windows 토스트 / macOS 알림 센터 / Linux notify-send
2. **Audio Chime** (브라우저) — Web Audio API 2-tone 차임
3. **Title Flash** (백그라운드 탭) — 탭 제목 깜빡임

프로젝트별 알림 ON/OFF 설정 가능 (알림 버튼 우클릭)

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+1 | Overview 탭 |
| Ctrl+2 | Terminal 탭 |
| Ctrl+3 | Changes 탭 |
| Ctrl+4 | README 탭 |
| Ctrl+K | Command Palette |
| Ctrl+T | 새 터미널 |
| Ctrl+W | 터미널 닫기 |
| Ctrl+F | 터미널 내 검색 |
| Ctrl+Tab | 다음 터미널 |
| Ctrl+Shift+Tab | 이전 터미널 |
| E | Diff 전체 펼치기 |
| C | Diff 전체 접기 |
| R | Diff 새로고침 |
| ? | 단축키 도움말 |

---

## Architecture

```
Browser / Tauri WebView        Node.js Server (port 3847)
┌──────────────────┐   HTTP   ┌─────────────────────────────┐
│ index.html       │◄────────►│ server.js (라우터, WS, SSE)  │
│ style.css        │   SSE    │   ├─ routes/                 │
│ js/              │◄─────────│   │  ├─ system.js            │
│  main.js         │   WS     │   │  ├─ git.js               │
│  dashboard.js    │◄────────►│   │  ├─ projects.js          │
│  terminal.js     │          │   │  ├─ sessions.js          │
│  diff.js         │          │   │  ├─ agent.js             │
│  agent.js        │          │   │  ├─ forge.js             │
│  notes.js        │          │   │  ├─ jira.js              │
│  ports.js        │          │   │  ├─ workflows.js         │
│  modals.js       │          │   │  ├─ notes.js             │
│  state.js        │          │   │  ├─ cicd.js              │
│  highlight.js    │          │   │  ├─ ports.js             │
│  utils.js        │          │   │  ├─ pr.js                │
│ vendor/          │          │   │  └─ api-tester.js        │
│  xterm.js        │          │   └─ lib/                    │
│  chart.js        │          │      ├─ platform.js          │
└──────────────────┘          │      ├─ config.js            │
                              │      ├─ claude-data.js       │
                              │      ├─ git-service.js       │
                              │      ├─ github-service.js    │
                              │      ├─ cost-service.js      │
                              │      ├─ agent-service.js     │
                              │      ├─ forge-service.js     │
                              │      ├─ jira-service.js      │
                              │      ├─ cicd-service.js      │
                              │      ├─ workflows-service.js │
                              │      ├─ notes-service.js     │
                              │      ├─ monitor-service.js   │
                              │      ├─ ports-service.js     │
                              │      ├─ session-control.js   │
                              │      ├─ batch-service.js     │
                              │      ├─ briefing-service.js  │
                              │      ├─ notify.js            │
                              │      ├─ poller.js            │
                              │      ├─ wsl-utils.js         │
                              │      └─ qr.js                │
                              └──────────┬──────────────────┘
                                         │
                    ┌────────────────────┬┴──────────────────┐
                ~/.claude/           git CLI          claude CLI
                (세션/비용)        (status/diff)     (AI commit)
```

### Tech Stack

| 영역 | 기술 |
|------|------|
| 서버 | Node.js (순수 `http` 모듈, 프레임워크 없음) |
| 프론트엔드 | Vanilla JS ES Modules (빌드 도구 없음) |
| 터미널 | `node-pty` (서버) + `xterm.js` WebGL (클라이언트) |
| WebSocket | `ws` |
| 실시간 | Server-Sent Events (SSE) |
| AI (커밋) | Claude CLI (`claude -p --model haiku`) via OAuth |
| AI (에이전트) | Gemini 2.0 Flash / 2.5 Pro (Google AI API) |
| AI (코드생성) | Forge — 멀티모델 코드 생성 엔진 |
| TTS | Edge TTS (`msedge-tts`) |
| 데스크탑 | Tauri 2 (Rust, Windows + macOS) |
| 차트 | Chart.js 4.4.7 |
| 이슈트래커 | Jira REST API |
| CI/CD | GitHub Actions API |

### Frontend Modules

| Module | 역할 |
|--------|------|
| main.js | 엔트리포인트, 초기화, 이벤트 위임, 키보드 단축키 |
| dashboard.js | 프로젝트 카드, SSE 연결, 비용 차트, 알림 |
| terminal.js | 터미널 생성/분할/탭 관리, WS I/O, 모바일 UI |
| diff.js | Git diff 렌더링, 스테이징, 커밋, stash, 브랜치 |
| agent.js | Gemini 채팅, 음성 입력, TTS, 도구 실행 |
| notes.js | 마크다운 뷰어/에디터, 노트 트리 |
| ports.js | 포트 스캔 UI, 프로세스 kill |
| highlight.js | 정규식 기반 구문 하이라이팅 |
| modals.js | 다이얼로그, 커맨드 팔레트, 설정 패널 |
| state.js | 전역 상태 (`app` 객체), pub/sub, localStorage |
| utils.js | XSS 방지(`esc`), 토스트, 시간 포맷, 마크다운 |

### Server Lib Modules

| Module | 역할 |
|--------|------|
| platform.js | 크로스 플랫폼 헬퍼 (셸, 프로세스 kill, URL/폴더 열기, IDE 경로) |
| config.js | 설정 관리 (projects.json, API keys, 포트) |
| claude-data.js | Claude 세션/대화 데이터 파서 |
| git-service.js | git 명령어 래퍼 (WSL 투명 지원) |
| github-service.js | GitHub API (PR 조회) |
| cost-service.js | 토큰 사용량/비용 추적 |
| agent-service.js | Gemini API 클라이언트, 9-Tool 에이전트 시스템 |
| forge-service.js | AI 코드 생성 서비스 |
| jira-service.js | Jira REST API 클라이언트 |
| cicd-service.js | GitHub Actions API |
| workflows-service.js | 워크플로우 엔진 |
| notes-service.js | 노트 CRUD (파일시스템) |
| monitor-service.js | CPU/메모리/디스크/프로세스 모니터링 |
| ports-service.js | 포트 스캔 + 프로세스 관리 |
| session-control.js | Claude 세션 시작/재개 (터미널 앱 실행) |
| batch-service.js | 배치 명령 실행 (다중 프로젝트 동시) |
| briefing-service.js | 일일 브리핑/알림 생성 |
| notify.js | 네이티브 알림 (Windows/macOS/Linux) |
| poller.js | 주기적 데이터 폴링 + SSE 브로드캐스트 |
| wsl-utils.js | WSL 경로 변환, WSL 프로젝트 지원 |
| qr.js | QR 코드 SVG 생성 |

---

## 크로스 플랫폼

`lib/platform.js`에서 OS별 분기를 중앙 관리:

| 기능 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 기본 셸 | pwsh / powershell | zsh / bash | bash |
| 알림 | PowerShell WinRT Toast | osascript | notify-send |
| URL 열기 | `cmd /c start` | `open` | `xdg-open` |
| 폴더 열기 | `explorer /select` | `open -R` | `xdg-open` |
| 프로세스 kill | `taskkill /T /F` | `kill -SIGTERM` | `kill -SIGTERM` |
| 포트 스캔 | `netstat -ano` | `lsof -iTCP` | `lsof` / `ss` |
| 디스크 정보 | `wmic` | `df -k` | `df -k` |
| 프로세스 목록 | PowerShell `Get-Process` | `ps -eo` | `ps -eo` |
| Claude 세션 | Windows Terminal | Terminal.app (AppleScript) | gnome-terminal / konsole |
| IDE (Zed) | `%LOCALAPPDATA%/Programs/Zed/bin/zed.exe` | `/Applications/Zed.app/Contents/MacOS/cli` | `zed` |
| Firefox Dev | `%ProgramFiles%/Firefox Developer Edition/firefox.exe` | `/Applications/Firefox Developer Edition.app/.../firefox` | `firefox-developer-edition` |

---

## 프로젝트 등록

### UI에서 등록
Overview 탭 설정(톱니바퀴) → "Add Project" 또는 "Discover"로 자동 검색

### 직접 편집
`projects.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "C:/_project/service/my-project",
      "stack": "react-next",
      "color": "#3B82F6",
      "devCmd": "npm run dev"
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | 자동 | 프로젝트 고유 ID |
| `name` | O | 표시 이름 |
| `path` | O | 프로젝트 루트 경로 |
| `stack` | X | `react-next` \| `nestjs` 등 |
| `color` | 자동 | 카드 색상 |
| `devCmd` | X | 개발 서버 명령어 |
| `github` | X | GitHub 레포 (`owner/repo`) — PR/CI 연동 |

---

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

---

## 보안

- **LAN 토큰 인증** — localhost 외 접근 시 토큰 필요 (자동 생성, 쿠키 저장)
- **localhost 무인증** — 로컬 접근은 토큰 불필요
- **경로 검증** — 등록된 프로젝트 내부 경로만 파일 접근 허용
- **IDE 화이트리스트** — code, cursor, windsurf, antigravity, zed만 허용
- **API Tester** — localhost에서만 실행 가능
- **포트 킬** — 보호 PID (0, 4, 자기 자신) 거부
- **Forge** — .env, .git, node_modules, 크리덴셜 파일 쓰기 차단
- **환경 변수 불필요** — Claude OAuth는 CLI가 자체 관리
