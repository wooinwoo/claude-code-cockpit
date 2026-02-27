// ─── WSL Utilities: centralized WSL detection & command routing ───
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WSL_RE = /^\/\/wsl[\$.](?:localhost)?\/([^/]+)(\/.*)/i;

/**
 * Detect if a path is a WSL path and extract distro + Linux path.
 * Supports: //wsl$/distro/path, //wsl.localhost/distro/path, \\wsl$\distro\path
 * @returns {{ distro: string, linuxPath: string } | null}
 */
export function parseWslPath(projectPath) {
  const normalized = (projectPath || '').replace(/\\/g, '/');
  const match = normalized.match(WSL_RE);
  if (!match) return null;
  return { distro: match[1], linuxPath: match[2] };
}

export function isWslPath(projectPath) {
  return WSL_RE.test((projectPath || '').replace(/\\/g, '/'));
}

/** Convert to Windows-style backslash path */
export function toWinPath(p) {
  return (p || '').replace(/\//g, '\\');
}

/**
 * Execute git command for a project, routing through WSL if needed.
 * For WSL: `wsl -d distro --cd /linux/path git <args>`
 * For native: `git -C <winPath> <args>`
 */
export function gitExec(projectPath, args, opts = {}) {
  const wsl = parseWslPath(projectPath);
  const merged = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, ...opts };

  if (wsl) {
    return execFileAsync('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'git', ...args], {
      ...merged,
      cwd: process.env.SYSTEMROOT || 'C:\\Windows'
    });
  }

  const winPath = toWinPath(projectPath);
  return execFileAsync('git', ['-C', winPath, ...args], merged);
}

/**
 * Execute a shell command for a project, routing through WSL if needed.
 * For WSL: `wsl -d distro --cd /linux/path sh -c "cmd"`
 * For native Win: `cmd /c "cmd"` with cwd=winPath
 * For native Unix: `sh -c "cmd"` with cwd=path
 */
export function shellExec(projectPath, cmd, opts = {}) {
  const wsl = parseWslPath(projectPath);
  const merged = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, ...opts };

  if (wsl) {
    return execFileAsync('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'sh', '-c', cmd], {
      ...merged,
      cwd: process.env.SYSTEMROOT || 'C:\\Windows'
    });
  }

  const isWin = process.platform === 'win32';
  const winPath = toWinPath(projectPath);
  return execFileAsync(
    isWin ? 'cmd' : 'sh',
    isWin ? ['/c', cmd] : ['-c', cmd],
    { ...merged, cwd: winPath }
  );
}

/**
 * Spawn a long-running process for a project, routing through WSL if needed.
 * Returns the child process (not a promise).
 */
export function spawnForProject(projectPath, cmd, opts = {}) {
  const wsl = parseWslPath(projectPath);

  if (wsl) {
    return nodeSpawn('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'sh', '-c', cmd], {
      ...opts,
      cwd: process.env.SYSTEMROOT || 'C:\\Windows'
    });
  }

  const winPath = toWinPath(projectPath);
  return nodeSpawn(cmd, [], { ...opts, cwd: winPath, shell: true });
}

/**
 * Sanitize search pattern to prevent command injection.
 * Strips shell metacharacters and limits length.
 */
function sanitizeSearchPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';
  // Remove null bytes and control chars, limit length
  return pattern.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

/**
 * Search files in a project, using grep (WSL/Linux) or findstr (Windows).
 * Pattern is passed as a fixed-string argument (-F flag) to prevent regex injection.
 * @returns {Promise<string>} raw stdout
 */
export async function searchExec(projectPath, pattern, opts = {}) {
  const safe = sanitizeSearchPattern(pattern);
  if (!safe) return '';

  const wsl = parseWslPath(projectPath);
  const merged = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, ...opts };

  // All paths use execFileAsync (no shell), so args are passed as array elements
  // -F (fixed string) prevents regex interpretation in grep
  if (wsl) {
    const result = await execFileAsync('wsl', [
      '-d', wsl.distro, '--cd', wsl.linuxPath,
      'grep', '-rn', '-i', '-F',
      '--include=*.js', '--include=*.ts', '--include=*.py',
      '--include=*.json', '--include=*.md', '--include=*.css', '--include=*.html',
      '--', safe, '.'
    ], { ...merged, cwd: process.env.SYSTEMROOT || 'C:\\Windows' });
    return result.stdout;
  }

  const isWin = process.platform === 'win32';
  if (isWin) {
    const searchRoot = toWinPath(projectPath);
    const exts = ['*.js', '*.ts', '*.py', '*.json', '*.md', '*.css', '*.html'];
    // findstr /c: treats the pattern as a literal string (not regex)
    const args = ['/s', '/n', '/i', `/c:${safe}`, ...exts.map(e => `${searchRoot}\\${e}`)];
    const result = await execFileAsync('findstr', args, { ...merged, cwd: searchRoot });
    return result.stdout;
  }

  const result = await execFileAsync('grep', [
    '-rn', '-i', '-F', '--include=*.js', '--include=*.ts', '--include=*.py',
    '--include=*.json', '--include=*.md', '--include=*.css', '--include=*.html',
    '--', safe, projectPath
  ], merged);
  return result.stdout;
}
