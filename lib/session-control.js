import { spawn } from 'node:child_process';
import { parseWslPath, toWinPath } from './wsl-utils.js';

// MINOR-9: Validate model and prompt to prevent cmd metachar injection
const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus']);
function sanitizeForCmd(s) {
  if (!s || typeof s !== 'string') return '';
  // Remove cmd metacharacters that could break out of arguments
  return s.replace(/[&|<>^;`$(){}\r\n"]/g, '').slice(0, 500);
}

export function startSession(project, options = {}) {
  const claudeArgs = [];
  if (options.resume) claudeArgs.push('--continue');
  if (options.model && VALID_MODELS.has(options.model)) claudeArgs.push('--model', options.model);
  if (options.prompt) claudeArgs.push('-p', sanitizeForCmd(options.prompt));

  const wsl = parseWslPath(project.path);

  let wtArgs;
  if (wsl) {
    // WSL project: open Windows Terminal with WSL tab, run claude inside WSL
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '--title', sanitizeForCmd(project.name),
      'wsl', '-d', wsl.distro, '--cd', wsl.linuxPath, '--', 'claude', ...claudeArgs];
  } else {
    const winPath = toWinPath(project.path);
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '-d', winPath, '--title', sanitizeForCmd(project.name), 'claude', ...claudeArgs];
  }

  const child = spawn('cmd', wtArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  return { launched: true, projectId: project.id };
}

export function resumeSession(project, sessionId) {
  const claudeArgs = sessionId
    ? ['--resume', sessionId]
    : ['--continue'];

  const wsl = parseWslPath(project.path);

  let wtArgs;
  if (wsl) {
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '--title', sanitizeForCmd(project.name),
      'wsl', '-d', wsl.distro, '--cd', wsl.linuxPath, '--', 'claude', ...claudeArgs];
  } else {
    const winPath = toWinPath(project.path);
    wtArgs = ['/c', 'start', 'wt', '-w', '0', 'nt', '-d', winPath, '--title', sanitizeForCmd(project.name), 'claude', ...claudeArgs];
  }

  const child = spawn('cmd', wtArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  return { launched: true, projectId: project.id };
}
