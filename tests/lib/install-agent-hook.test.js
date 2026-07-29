import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mergeHookConfig } from '../../scripts/install-agent-hook.mjs';

const execFileAsync = promisify(execFile);
const installer = fileURLToPath(new URL('../../scripts/install-agent-hook.mjs', import.meta.url));

test('agent hook installer preserves existing hooks and is idempotent', () => {
  const orca = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'orca-hook' }] }] } };
  const once = mergeHookConfig(structuredClone(orca), 'codex', '/cockpit-hook.sh');
  const twice = mergeHookConfig(structuredClone(once), 'codex', '/cockpit-hook.sh');
  assert.equal(twice.hooks.SessionStart[0].hooks[0].command, 'orca-hook');
  assert.equal(twice.hooks.SessionStart.filter(group => group.hooks.some(hook => hook.command.includes('/cockpit-hook.sh'))).length, 1);
  assert.equal(Object.keys(twice.hooks).length, 9);
  const claude = mergeHookConfig({}, 'claude', '/cockpit-hook.sh');
  assert.ok(claude.hooks.Notification);
  assert.equal(claude.hooks.SessionEnd, undefined);
  assert.throws(() => mergeHookConfig({ hooks: [] }, 'codex'), /hooks must be/);
  assert.throws(() => mergeHookConfig({}, 'other'), /kind must be/);
});

test('agent hook installer writes a backup and does not duplicate entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-hooks-'));
  const path = join(dir, 'hooks.json');
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'orca-hook' }] }] } }, null, 2);
  await writeFile(path, original);
  await execFileAsync(process.execPath, [installer, 'codex', path]);
  await execFileAsync(process.execPath, [installer, 'codex', path]);
  const installed = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(`${path}.cockpit-backup`, 'utf8')), JSON.parse(original));
  assert.equal(installed.hooks.SessionStart[0].hooks[0].command, 'orca-hook');
  assert.equal(installed.hooks.SessionStart.filter(group => group.hooks.some(hook => hook.command.includes('cockpit-agent-hook.sh'))).length, 1);
});

test('agent hook installer leaves invalid JSON untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-hooks-invalid-'));
  const path = join(dir, 'hooks.json');
  await writeFile(path, '{broken');
  await assert.rejects(execFileAsync(process.execPath, [installer, 'codex', path]));
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
