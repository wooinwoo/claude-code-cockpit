import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { IS_WIN } from './platform.js';

const TMUX_PATHS = ['/usr/bin/tmux', '/bin/tmux'];

export function durableTerminalsAvailable({
  isWin = IS_WIN,
  env = process.env,
  exists = existsSync,
} = {}) {
  return !isWin && env.COCKPIT_DURABLE_TERMINALS !== '0' && TMUX_PATHS.some(exists);
}

function tmuxBin(exists = existsSync) {
  return TMUX_PATHS.find(exists) || 'tmux';
}

function validateId(id) {
  const value = String(id || '');
  if (!/^[a-f0-9]{24}$/.test(value)) throw new Error('Invalid durable terminal id');
  return value;
}

function socketName(id) {
  return `cockpit-${validateId(id)}`;
}

export function durableTerminalExists(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    exec(tmuxBin(exists), ['-L', socketName(id), 'has-session', '-t', 'main'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function ensureDurableTerminal({ id, cwd, env, exec = execFileSync, exists = existsSync }) {
  const socket = socketName(id);
  const bin = tmuxBin(exists);
  const resumed = durableTerminalExists(id, { exec, exists });
  if (!resumed) {
    exec(bin, ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-c', cwd], { stdio: 'ignore', env });
    exec(bin, ['-L', socket, 'set-option', '-g', 'status', 'off'], { stdio: 'ignore', env });
  }
  return {
    id: validateId(id),
    resumed,
    shell: bin,
    args: ['-L', socket, 'attach-session', '-t', 'main'],
    cwd,
    env,
  };
}

export function durableTerminalCwd(id, { exec = execFileSync, exists = existsSync } = {}) {
  try {
    return exec(tmuxBin(exists), ['-L', socketName(id), 'display-message', '-p', '-t', 'main', '#{pane_current_path}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function killDurableTerminal(id, { exec = execFileSync, exists = existsSync } = {}) {
  exec(tmuxBin(exists), ['-L', socketName(id), 'kill-server'], { stdio: 'ignore' });
  return true;
}
