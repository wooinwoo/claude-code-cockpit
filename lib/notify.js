import { spawn } from 'node:child_process';
import { IS_WIN, IS_MAC } from './platform.js';

/**
 * Show a native desktop notification (cross-platform).
 * - Windows: PowerShell WinRT toast API
 * - macOS: osascript display notification
 * - Linux: notify-send (fallback: console.log)
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 */
export function showNotification(title, body) {
  try {
    if (IS_WIN) {
      showWindowsToast(title, body);
    } else if (IS_MAC) {
      showMacNotification(title, body);
    } else {
      showLinuxNotification(title, body);
    }
  } catch (err) {
    console.error('[Notify] Failed:', err.message);
  }
}

function showWindowsToast(title, body) {
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$t = [System.Security.SecurityElement]::Escape($env:NT)
$b = [System.Security.SecurityElement]::Escape($env:NB)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($APP_ID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
  const buf = Buffer.from(script, 'utf16le');
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', buf.toString('base64')], {
    windowsHide: true, detached: true, stdio: 'ignore',
    env: { ...process.env, NT: String(title), NB: String(body) }
  });
  ps.unref();
}

function showMacNotification(title, body) {
  const safeTitle = String(title).replace(/"/g, '\\"');
  const safeBody = String(body).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  const ps = spawn('osascript', ['-e', script], {
    detached: true, stdio: 'ignore'
  });
  ps.unref();
}

function showLinuxNotification(title, body) {
  const ps = spawn('notify-send', [String(title), String(body)], {
    detached: true, stdio: 'ignore'
  });
  ps.unref();
  ps.on('error', () => {
    // notify-send not installed — silent fallback
    console.log(`[Notify] ${title}: ${body}`);
  });
}
