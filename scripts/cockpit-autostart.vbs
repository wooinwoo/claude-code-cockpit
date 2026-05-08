' Cockpit Dashboard — Windows login auto-start (WSL backend)
'
' Drop this file in:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
'
' On user login, fires up WSL Ubuntu and runs `node server.js` in
' the background. Hidden (no console window flash). Logs to
' /tmp/cockpit.log inside WSL.
'
' If port 3847 is already taken, the new instance dies immediately
' on EADDRINUSE — no harm done.

Dim shell : Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d Ubuntu --cd /home/rst010/projects/personal/claude-code-cockpit -- bash -ilc ""node server.js >> /tmp/cockpit.log 2>&1""", 0, False
