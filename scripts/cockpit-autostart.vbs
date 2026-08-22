' Cockpit Dashboard — Windows login auto-start (WSL backend)
'
' [권장] WSL/Linux 에서는 systemd user 서비스가 정석입니다:
'   systemctl --user enable --now cockpit-prod.service
'   loginctl enable-linger $USER      ' 세션 없이도 부팅 시 기동
' 이 VBS 는 systemd 를 쓸 수 없는 환경용 대체 수단입니다.
'
' 사용법:
'   1) 아래 REPO_PATH 를 본인 WSL 내 저장소 경로로 수정
'      (예: /home/<user>/projects/claude-code-cockpit)
'   2) 이 파일을 Startup 폴더에 복사:
'      %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
'
' 로그인 시 WSL Ubuntu 에서 node server.js 를 백그라운드 실행(콘솔 숨김).
' 로그는 WSL 내부 /tmp/cockpit.log. 포트 3847 이 이미 점유면 EADDRINUSE 로
' 새 인스턴스가 즉시 종료 — 무해.

Const REPO_PATH = "/path/to/claude-code-cockpit"   ' ← 본인 경로로 수정

Dim shell : Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d Ubuntu --cd " & REPO_PATH & " -- bash -ilc ""node server.js >> /tmp/cockpit.log 2>&1""", 0, False
