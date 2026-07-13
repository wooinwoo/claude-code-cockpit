!macro NSIS_HOOK_PREINSTALL
  ; Kill running Cockpit process to release file locks (conpty.node etc.)
  nsExec::Exec 'taskkill /IM Cockpit.exe /F'
  Pop $0
  ; Also kill node.exe listening on Cockpit port 3847 (standalone server mode)
  nsExec::Exec 'cmd /C "for /f "tokens=5" %a in (''netstat -ano ^| findstr :3847 ^| findstr LISTENING'') do taskkill /PID %a /F"'
  Pop $0
  Sleep 1000
  ; Remove native modules that Windows may have locked
  Delete /REBOOTOK "$INSTDIR\node_modules\node-pty\prebuilds\win32-x64\conpty.node"

  IfFileExists "$INSTDIR\projects.json" 0 skip_clean
    MessageBox MB_YESNO|MB_ICONQUESTION "기존 프로젝트 데이터를 초기화할까요?$\n(No를 선택하면 기존 프로젝트가 유지됩니다)" IDYES do_clean IDNO skip_clean
  do_clean:
    Delete "$INSTDIR\projects.json"
    Delete "$INSTDIR\session-state.json"
    Delete "$INSTDIR\cost-cache.json"
    Delete "$INSTDIR\jira-config.json"
  skip_clean:
!macroend
