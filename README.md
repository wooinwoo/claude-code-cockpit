# Cockpit

여러 프로젝트의 Claude Code 세션, Git 상태, GitHub PR, 사용량을 한 화면에서 모니터링하고 관리하는 로컬 대시보드.
Tauri 데스크탑 앱 + PWA 모바일 지원.

```
http://localhost:3847
LAN: http://<PC IP>:3847
```

---

## 설치 가이드

### 1. 필수 설치 (Required)

| 프로그램 | 용도 | 설치 명령 (winget) |
|----------|------|-------------------|
| **Node.js 20+** | 서버 런타임 | `winget install OpenJS.NodeJS.LTS` |
| **Git** | 버전 관리 | `winget install Git.Git` |
| **Claude Code CLI** | AI 세션 관리 | `npm install -g @anthropic-ai/claude-code` |
| **Visual Studio Build Tools** | node-pty 네이티브 빌드 | `winget install Microsoft.VisualStudio.2022.BuildTools` |

> Claude Code CLI 설치 후 `claude` 명령어로 OAuth 로그인 필요

### 2. 권장 설치 (Recommended)

| 프로그램 | 용도 | 설치 명령 |
|----------|------|----------|
| **PowerShell 7** | 터미널 `&&` 연산자 지원 | `winget install Microsoft.PowerShell` |
| **GitHub CLI** | PR 목록 연동 | `winget install GitHub.cli` |
| **Tailscale** | 외부 네트워크 안전 접근 | `winget install Tailscale.Tailscale` |

### 3. 원클릭 설치 (PowerShell 관리자)

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

### 4. 앱 실행

```bash
# 소스에서 실행
cd dashboard
npm install
node server.js
```

또는 **데스크탑 앱**: `Cockpit_1.0.0_x64-setup.exe` 인스톨러 실행

### 5. 모바일 접속

같은 WiFi에서 `http://<PC의 IP>:3847` 접속
헤더의 **Mobile Connect** 버튼으로 QR 코드 확인

### 6. Windows 자동 시작 (선택)

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
- **IDE 연동** — VS Code, Cursor, Windsurf, Antigravity 원클릭 실행
- **GitHub PR** — 열린 PR 목록 (리뷰 상태, draft 여부)

### Terminal 탭
- **Multi-terminal** — 여러 프로젝트의 터미널을 탭으로 관리, 가로/세로 분할
- **Tab Bar** — 빠른 전환, 가운데 클릭으로 닫기, 드래그로 순서 변경
- **Branch/Worktree Picker** — 터미널 생성 시 브랜치나 worktree 경로 선택
- **Search** — Ctrl+F로 터미널 출력 내 검색
- **Font Size** — 터미널 글꼴 크기 조절 (+/-)
- **Export** — 터미널 출력을 TXT 파일로 내보내기
- **세션 복원** — 서버 재시작 시 터미널 세션 자동 복원
- **모바일 전용 UI** — 탭 바 + 퀵 액션 바 (Esc, Tab, ^C, ^D 등) + 스와이프 전환

### Changes 탭
- **2-Column Diff View** — 파일 사이드바 + 파일별 접기/펼치기 가능한 diff 패널
- **Syntax Highlighting** — 정규식 기반 구문 하이라이팅 (JS/TS, Python, CSS, HTML, JSON, Rust, Go, Java, Shell 등 15+ 언어)
- **Staged/Unstaged** — 컬러 인디케이터 (인디고=staged, 옐로우=unstaged)
- **Line Numbers** — old/new 라인넘버 거터
- **Stage/Unstage/Discard** — 파일 단위 Git 스테이징 관리
- **수동 커밋** — 메시지 입력 후 직접 커밋 + Push
- **AI 커밋 메시지** — Haiku가 변경사항 분석 → 커밋 메시지 자동 생성
- **Git Operations** — Pull, Fetch, Stash, Stash Pop, Stash List, Branch Create/Delete

### AI Auto Commit
Claude Haiku가 `git status` + `git diff`를 분석해서 관련 파일을 논리적 커밋으로 자동 그룹핑.

1. "AI Commit" 버튼 → Haiku가 변경사항 분석 (3~5초)
2. 커밋 플랜: 커밋별 메시지 + 파일 목록 + 이유
3. 사용자가 수정: 메시지 편집, 파일 드래그 앤 드롭, 커밋 추가/삭제
4. "Commit All" → 순차 실행 (프로그레스 바)
5. "Push" 버튼으로 원격 푸시

> AI는 `claude -p --model haiku` CLI로 호출 — 별도 API 키 불필요, OAuth 인증 활용

---

## Desktop App (Tauri)

Tauri로 패키징된 네이티브 Windows 데스크탑 앱.

- **자동 서버 관리** — 앱 시작 시 Node.js 서버 자동 기동, 종료 시 정리
- **Windows 토스트 알림** — 세션 상태 변경 시 WinRT 네이티브 토스트
- **인스톨러** — NSIS 기반 `Cockpit_x.x.x_x64-setup.exe`

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
1. **WinRT Toast** (데스크탑) — Windows 네이티브 토스트
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
Browser / Tauri        Node.js Server (port 3847)
┌─────────────┐  HTTP  ┌──────────────────────────┐
│ index.html  │◄──────►│ server.js                │
│ style.css   │  SSE   │  ├─ lib/config.js         │
│ js/         │◄───────│  ├─ lib/claude-data.js    │
│  main.js    │  WS    │  ├─ lib/git-service.js    │
│  dashboard  │◄──────►│  ├─ lib/github-service.js │
│  terminal   │        │  ├─ lib/cost-service.js   │
│  diff       │        │  ├─ lib/session-control.js│
│  highlight  │        │  ├─ lib/notify.js         │
│  modals     │        │  ├─ lib/qr.js             │
│  state      │        │  └─ lib/poller.js         │
│  utils      │        └──────────┬────────────────┘
│ xterm.js    │                   │
│ Chart.js    │     ┌─────────────┼──────────────┐
└─────────────┘     │             │              │
                ~/.claude/    git CLI      claude CLI
                (세션/비용)  (status/diff)  (AI commit)
```

### Tech Stack
| 영역 | 기술 |
|------|------|
| 서버 | Node.js (순수 `http` 모듈, 프레임워크 없음) |
| 프론트엔드 | ES 모듈 (빌드 도구 없음) |
| 터미널 | `node-pty` (서버) + `xterm.js` WebGL (클라이언트) |
| WebSocket | `ws` |
| 실시간 | Server-Sent Events (SSE) |
| AI | Claude CLI (`claude -p --model haiku`) via OAuth |
| 데스크탑 | Tauri 2 (Rust) |
| 차트 | Chart.js |

### Frontend Modules
| Module | 역할 |
|--------|------|
| main.js | 엔트리포인트, 초기화, 이벤트 바인딩 |
| dashboard.js | 프로젝트 카드, 사용량, 차트, 알림 |
| terminal.js | 터미널 생성/분할/탭 관리, 모바일 UI |
| diff.js | Git diff 렌더링, 스테이징, 커밋, stash |
| highlight.js | 정규식 기반 구문 하이라이팅 |
| modals.js | 다이얼로그, 커맨드 팔레트, 설정 |
| state.js | 전역 상태, localStorage 연동 |
| utils.js | 공통 유틸리티 함수 |

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

---

## 보안

- **LAN 토큰 인증** — localhost 외 접근 시 토큰 필요 (자동 생성, 쿠키 저장)
- **localhost 무인증** — 로컬 접근은 토큰 불필요
- **쓰기 API 존재** — `git commit`, `git push`, `discard` 등 포함
- **환경 변수 불필요** — Claude OAuth는 CLI가 자체 관리
