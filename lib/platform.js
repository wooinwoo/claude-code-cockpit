// ─── Cross-Platform Helpers ───
import { execFile, execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

/** @type {boolean} */
export const IS_WIN = process.platform === 'win32';
/** @type {boolean} */
export const IS_MAC = process.platform === 'darwin';
/** @type {boolean} */
export const IS_WSL = process.platform === 'linux' && !!process.env.WSL_DISTRO_NAME;

// On WSL prefer wslview (opens in Windows host browser); fall back to xdg-open.
const LINUX_OPENERS = IS_WSL ? ['wslview', 'xdg-open'] : ['xdg-open'];

function spawnLinuxOpener(args) {
  for (const bin of LINUX_OPENERS) {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => { /* missing binary; next attempt or give up */ });
      child.unref();
      return true;
    } catch { /* try next */ }
  }
  return false;
}

function execLinuxOpener(args) {
  for (const bin of LINUX_OPENERS) {
    try {
      execFileSync(bin, args, { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/**
 * Detached fire-and-forget spawn that swallows ENOENT-style errors.
 * Without this, a missing binary surfaces as an uncaughtException that
 * kills the process via the global handler.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
export function safeSpawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.on('error', () => { /* missing binary or spawn failure — ignore */ });
  child.unref();
  return child;
}

// ─── Process tree kill ───
/** @param {number} pid */
export function killProcessTree(pid) {
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 3000 }, () => {});
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
}

// ─── Open URL in default browser ───
/** @param {string} url */
export function openUrl(url) {
  if (IS_WIN) {
    safeSpawnDetached('cmd', ['/c', 'start', '', url], { windowsHide: true });
  } else if (IS_MAC) {
    safeSpawnDetached('open', [url]);
  } else {
    spawnLinuxOpener([url]);
  }
}

// ─── Open URL synchronously (for agent tool use) ───
/** @param {string} url */
export function openUrlSync(url) {
  if (IS_WIN) {
    execFileSync('cmd', ['/c', 'start', '', url], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
  } else if (IS_MAC) {
    execFileSync('open', [url], { timeout: 5000, stdio: 'ignore' });
  } else {
    execLinuxOpener([url]);
  }
}

// ─── Open folder with file selected ───
/** @param {string} filePath */
export function openFolder(filePath) {
  if (IS_WIN) {
    safeSpawnDetached('explorer', ['/select,', filePath], { shell: false, windowsHide: true });
  } else if (IS_MAC) {
    safeSpawnDetached('open', ['-R', filePath]);
  } else {
    // Linux: open containing directory
    const dir = filePath.replace(/\/[^/]+$/, '') || '/';
    spawnLinuxOpener([dir]);
  }
}

// ─── Default shell detection ───
let _shellCache = null;

/** @returns {string} Shell executable name (e.g. 'pwsh.exe', 'zsh', 'bash') */
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
/**
 * @param {string} ide - IDE name (e.g. 'zed', 'code', 'cursor')
 * @returns {string} Full path or command name for the IDE binary
 */
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
/** @returns {import('node:child_process').SpawnOptions} */
export function getIdeSpawnOpts() {
  return {
    detached: true,
    stdio: 'ignore',
    shell: IS_WIN, // .cmd wrappers need shell on Windows
    windowsHide: true
  };
}

// ─── Firefox Developer Edition binary path ───
/** @returns {string} */
export function getFirefoxDevBin() {
  if (IS_WIN) return join(process.env.ProgramFiles || 'C:\\Program Files', 'Firefox Developer Edition', 'firefox.exe');
  if (IS_MAC) return '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox';
  return 'firefox-developer-edition'; // Linux: assume in PATH
}
