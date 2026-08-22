!macro NSIS_HOOK_PREINSTALL
  ; Stop only Praetorium and its child Node process before replacing packaged
  ; resources. Unrelated applications and port owners are never touched.
  nsExec::Exec 'taskkill /IM Praetorium.exe /T /F'
  Pop $0
  Sleep 1000
!macroend
