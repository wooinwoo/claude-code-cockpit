// ─── WSL Utilities: centralized WSL detection & command routing ───
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const WSL_RE = /^\/\/wsl[\$.](?:localhost)?\/([^/]+)(\/.*)/i;

/**
 * Detect if a path is a WSL path and extract distro + Linux path.
 * Supports: //wsl$/distro/path, //wsl.localhost/distro/path, \\wsl$\distro\path
 * @param {string} projectPath
 * @returns {{ distro: string, linuxPath: string } | null}
 */
export function parseWslPath(projectPath) {
  const normalized = (projectPath || '').replace(/\\/g, '/');
  const match = normalized.match(WSL_RE);
  if (!match) return null;
  return { distro: match[1], linuxPath: match[2] };
}

/**
 * @param {string} projectPath
 * @returns {boolean}
 */
export function isWslPath(projectPath) {
  return WSL_RE.test((projectPath || '').replace(/\\/g, '/'));
}

/**
 * Convert to Windows-style backslash path.
 * @param {string} p
 * @returns {string}
 */
export function toWinPath(p) {
  return (p || '').replace(/\//g, '\\');
}

/**
 * Execute git command for a project, routing through WSL if needed.
 * For WSL: `wsl -d distro --cd /linux/path git <args>`
 * For native: `git -C <winPath> <args>`
 * @param {string} projectPath
 * @param {string[]} args - Git subcommand and arguments
 * @param {import('node:child_process').ExecFileOptions} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
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

  const cwd = IS_WIN ? toWinPath(projectPath) : projectPath;
  return execFileAsync('git', ['-C', cwd, ...args], merged);
}

/**
 * Execute a shell command for a project, routing through WSL if needed.
 * For WSL: `wsl -d distro --cd /linux/path sh -c "cmd"`
 * For native Win: `cmd /c "cmd"` with cwd=winPath
 * For native Unix: `sh -c "cmd"` with cwd=path
 * @param {string} projectPath
 * @param {string} cmd - Shell command string
 * @param {import('node:child_process').ExecFileOptions} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
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

  const cwd = IS_WIN ? toWinPath(projectPath) : projectPath;
  return execFileAsync(
    IS_WIN ? 'cmd' : 'sh',
    IS_WIN ? ['/c', cmd] : ['-c', cmd],
    { ...merged, cwd }
  );
}

/**
 * Spawn a long-running process for a project, routing through WSL if needed.
 * Returns the child process (not a promise).
 * @param {string} projectPath
 * @param {string} cmd - Shell command string
 * @param {import('node:child_process').SpawnOptions} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnForProject(projectPath, cmd, opts = {}) {
  const wsl = parseWslPath(projectPath);

  if (wsl) {
    return nodeSpawn('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'sh', '-c', cmd], {
      ...opts,
      cwd: process.env.SYSTEMROOT || 'C:\\Windows'
    });
  }

  const cwd = IS_WIN ? toWinPath(projectPath) : projectPath;
  return nodeSpawn(cmd, [], { ...opts, cwd, shell: true });
}

/**
 * Sanitize search pattern to prevent command injection.
 * Strips shell metacharacters and limits length.
 * @param {string} pattern
 * @returns {string}
 */
function sanitizeSearchPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';
  // Remove null bytes and control chars, limit length
  return pattern.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

/**
 * Search files in a project, using grep (WSL/Linux) or findstr (Windows).
 * Pattern is passed as a fixed-string argument (-F flag) to prevent regex injection.
 * @param {string} projectPath
 * @param {string} pattern - Search text (fixed string, not regex)
 * @param {import('node:child_process').ExecFileOptions} [opts]
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
