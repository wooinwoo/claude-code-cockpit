!macro NSIS_HOOK_PREINSTALL
  ; Stop the current shell and the legacy Cockpit shell so packaged resources
  ; can be replaced. Persistent state lives outside $INSTDIR and is preserved.
  nsExec::Exec 'taskkill /IM Praetorium.exe /F'
  Pop $0
  nsExec::Exec 'taskkill /IM Cockpit.exe /F'
  Pop $0
  ; Stop only the standalone node process that owns Praetorium's fixed port.
  nsExec::Exec 'cmd /C "for /f "tokens=5" %a in (''netstat -ano ^| findstr :3847 ^| findstr LISTENING'') do taskkill /PID %a /F"'
  Pop $0
  Sleep 1000
  Delete /REBOOTOK "$INSTDIR\node_modules\node-pty\prebuilds\win32-x64\conpty.node"
!macroend
