// ─── Cross-Platform Helpers ───
import { execFile, execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// ─── Process tree kill ───
export function killProcessTree(pid) {
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 3000 }, () => {});
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
  }
}

// ─── Open URL in default browser ───
export function openUrl(url) {
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (IS_MAC) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ─── Open URL synchronously (for agent tool use) ───
export function openUrlSync(url) {
  if (IS_WIN) {
    execFileSync('cmd', ['/c', 'start', '', url], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
  } else if (IS_MAC) {
    execFileSync('open', [url], { timeout: 5000, stdio: 'ignore' });
  } else {
    execFileSync('xdg-open', [url], { timeout: 5000, stdio: 'ignore' });
  }
}

// ─── Open folder with file selected ───
export function openFolder(filePath) {
  if (IS_WIN) {
    spawn('explorer', ['/select,', filePath], { detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  } else if (IS_MAC) {
    spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Linux: open containing directory
    const dir = filePath.replace(/\/[^/]+$/, '') || '/';
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ─── Default shell detection ───
let _shellCache = null;

export function getShell() {
  if (_shellCache) return _shellCache;
  if (IS_WIN) {
    try {
      execFileSync('where', ['pwsh.exe'], { stdio: 'ignore', timeout: 3000 });
      _shellCache = 'pwsh.exe';
    } catch {
      _shellCache = 'powershell.exe';
    }
  } else {
    // macOS defaults to zsh, Linux usually bash
    const userShell = process.env.SHELL || '';
    if (userShell.endsWith('/zsh')) _shellCache = 'zsh';
    else if (userShell.endsWith('/fish')) _shellCache = 'fish';
    else _shellCache = 'bash';
  }
  return _shellCache;
}

// ─── IDE binary path ───
export function getIdeBin(ide) {
  if (ide === 'zed') {
    if (IS_WIN) return join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed', 'bin', 'zed.exe');
    if (IS_MAC) return '/Applications/Zed.app/Contents/MacOS/cli';
    return 'zed'; // Linux: assume in PATH
  }
  // VS Code, Cursor, Windsurf, Antigravity — .cmd wrapper on Windows, bare name elsewhere
  if (IS_WIN) return `${ide}.cmd`;
  return ide;
}

// ─── IDE spawn options ───
export function getIdeSpawnOpts() {
  return {
    detached: true,
    stdio: 'ignore',
    shell: IS_WIN, // .cmd wrappers need shell on Windows
    windowsHide: true
  };
}

// ─── Firefox Developer Edition binary path ───
export function getFirefoxDevBin() {
  if (IS_WIN) return join(process.env.ProgramFiles || 'C:\\Program Files', 'Firefox Developer Edition', 'firefox.exe');
  if (IS_MAC) return '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox';
  return 'firefox-developer-edition'; // Linux: assume in PATH
}
