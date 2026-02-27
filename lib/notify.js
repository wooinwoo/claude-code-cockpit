import { spawn } from 'node:child_process';

/**
 * Show a Windows toast notification via PowerShell.
 * Uses WinRT toast API with PowerShell's registered AUMID (works on Windows 10/11).
 */
export function showNotification(title, body) {
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$t = [System.Security.SecurityElement]::Escape($env:NT)
$b = [System.Security.SecurityElement]::Escape($env:NB)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($APP_ID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
  try {
    const buf = Buffer.from(script, 'utf16le');
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', buf.toString('base64')], {
      windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, NT: String(title), NB: String(body) }
    });
    ps.unref();
  } catch (err) {
    console.error('[Notify] Failed:', err.message);
  }
}
