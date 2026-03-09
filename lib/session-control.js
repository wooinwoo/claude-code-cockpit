/**
 * @typedef {Object} SessionProject
 * @property {string} id
 * @property {string} name
 * @property {string} path
 */

/**
 * @typedef {Object} StartSessionOptions
 * @property {boolean} [resume] - Continue last session
 * @property {'haiku'|'sonnet'|'opus'} [model]
 * @property {string} [prompt] - Initial prompt text
 */

import { spawn } from 'node:child_process';
import { parseWslPath, toWinPath } from './wsl-utils.js';
import { IS_WIN, IS_MAC } from './platform.js';

// MINOR-9: Validate model and prompt to prevent cmd metachar injection
const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus']);
function sanitizeForCmd(s) {
  if (!s || typeof s !== 'string') return '';
  // Remove cmd metacharacters that could break out of arguments
  return s.replace(/[&|<>^;`$(){}\r\n"]/g, '').slice(0, 500);
}

function launchClaude(project, claudeArgs) {
  if (IS_WIN) {
    return launchClaudeWindows(project, claudeArgs);
  } else if (IS_MAC) {
    return launchClaudeMac(project, claudeArgs);
  } else {
    return launchClaudeLinux(project, claudeArgs);
  }
}

function launchClaudeWindows(project, claudeArgs) {
  const wsl = parseWslPath(project.path);
  let wtArgs;
  if (wsl) {
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '--title', sanitizeForCmd(project.name),
      'wsl', '-d', wsl.distro, '--cd', wsl.linuxPath, '--', 'claude', ...claudeArgs];
  } else {
    const winPath = toWinPath(project.path);
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '-d', winPath, '--title', sanitizeForCmd(project.name), 'claude', ...claudeArgs];
  }
  const child = spawn('cmd', wtArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function launchClaudeMac(project, claudeArgs) {
  const safePath = project.path.replace(/'/g, "'\\''");
  const argsStr = claudeArgs.map(a => a.replace(/'/g, "'\\''")).join(' ');
  const script = `tell application "Terminal"
  activate
  do script "cd '${safePath}' && claude ${argsStr}"
end tell`;
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  child.unref();
}

function launchClaudeLinux(project, claudeArgs) {
  // Try common terminal emulators in order
  const argsStr = claudeArgs.join(' ');
  const cmd = `cd '${project.path.replace(/'/g, "'\\''")}' && claude ${argsStr}`;
  // gnome-terminal, konsole, xterm as fallback chain
  const child = spawn('sh', ['-c',
    `if command -v gnome-terminal >/dev/null 2>&1; then gnome-terminal -- bash -c '${cmd}; exec bash'; ` +
    `elif command -v konsole >/dev/null 2>&1; then konsole -e bash -c '${cmd}; exec bash'; ` +
    `elif command -v xterm >/dev/null 2>&1; then xterm -e bash -c '${cmd}; exec bash'; ` +
    `else echo "No terminal emulator found"; fi`
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Start a new Claude CLI session in a terminal window.
 * @param {SessionProject} project
 * @param {StartSessionOptions} [options]
 * @returns {{launched: boolean, projectId: string}}
 */
export function startSession(project, options = {}) {
  const claudeArgs = [];
  if (options.resume) claudeArgs.push('--continue');
  if (options.model && VALID_MODELS.has(options.model)) claudeArgs.push('--model', options.model);
  if (options.prompt) claudeArgs.push('-p', sanitizeForCmd(options.prompt));

  launchClaude(project, claudeArgs);
  return { launched: true, projectId: project.id };
}

/**
 * Resume an existing Claude CLI session by ID.
 * @param {SessionProject} project
 * @param {string} [sessionId] - Session ID to resume; if omitted, continues last session
 * @returns {{launched: boolean, projectId: string}}
 */
export function resumeSession(project, sessionId) {
  const claudeArgs = sessionId
    ? ['--resume', sessionId]
    : ['--continue'];

  launchClaude(project, claudeArgs);
  return { launched: true, projectId: project.id };
}
