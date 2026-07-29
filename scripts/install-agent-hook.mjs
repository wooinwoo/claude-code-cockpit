#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMON_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];
const EVENTS = {
  codex: [...COMMON_EVENTS, 'SessionEnd'],
  claude: [...COMMON_EVENTS, 'Notification', 'PostToolUseFailure', 'StopFailure', 'TeammateIdle'],
};
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cockpit-agent-hook.sh');

export function mergeHookConfig(config, kind, script = SCRIPT) {
  if (!EVENTS[kind]) throw new Error('kind must be codex or claude');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config root must be a JSON object');
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error('hooks must be a JSON object');
  const hooks = config.hooks ||= {};
  const command = `sh "${script}" ${kind}`;
  for (const event of EVENTS[kind]) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`hooks.${event} must be an array`);
    const groups = hooks[event] ||= [];
    const exists = groups.some(group => group?.hooks?.some(hook => hook?.command === command));
    if (!exists) groups.push({ hooks: [{ type: 'command', command, timeout: 3 }] });
  }
  return config;
}

async function install(kind, configPath) {
  const path = resolve(configPath || (kind === 'codex'
    ? join(homedir(), '.codex', 'hooks.json')
    : join(homedir(), '.claude', 'settings.json')));
  let raw = '{}';
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parsed = JSON.parse(raw);
  const before = JSON.stringify(parsed);
  const config = mergeHookConfig(parsed, kind);
  if (JSON.stringify(config) === before) {
    console.log(`Cockpit ${kind} hooks already installed: ${path}`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  try { await copyFile(path, `${path}.cockpit-backup`); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = `${path}.cockpit-tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  console.log(`Cockpit ${kind} hooks installed: ${path}`);
  if (kind === 'codex') console.log('Run /hooks in Codex and trust the new Cockpit handlers.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const kind = process.argv[2];
  if (!['codex', 'claude'].includes(kind)) {
    console.error('Usage: node scripts/install-agent-hook.mjs <codex|claude> [config-path]');
    process.exitCode = 1;
  } else {
    install(kind, process.argv[3]).catch(error => {
      console.error(`Hook install failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
