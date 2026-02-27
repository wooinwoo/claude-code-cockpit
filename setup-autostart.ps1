# Claude Code Dashboard - Register auto-start on Windows login
# Run this script once as Administrator to enable auto-start

$taskName = "ClaudeCodeDashboard"
$batPath = "C:\_project\template\wiw_claude-code\dashboard\autostart.bat"

# Remove existing task if present
schtasks /delete /tn $taskName /f 2>$null

# Create task: runs on user logon, normal priority, hidden window
schtasks /create `
  /tn $taskName `
  /tr $batPath `
  /sc ONLOGON `
  /rl HIGHEST `
  /f

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n  Auto-start registered!" -ForegroundColor Green
  Write-Host "  Task name: $taskName"
  Write-Host "  Dashboard will start automatically on next login.`n"
} else {
  Write-Host "`n  Failed to register. Run as Administrator.`n" -ForegroundColor Red
}

# To remove auto-start later:
# schtasks /delete /tn ClaudeCodeDashboard /f
