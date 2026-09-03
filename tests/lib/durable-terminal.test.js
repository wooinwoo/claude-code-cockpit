import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durableTerminalCwd, durableTerminalExists, durableTerminalsAvailable, ensureDurableTerminal, killDurableTerminal,
} from '../../lib/durable-terminal.js';

test('durable terminal availability is opt-out and requires tmux on Unix', () => {
  assert.equal(durableTerminalsAvailable({ isWin: true, exists: () => true }), false);
  assert.equal(durableTerminalsAvailable({ isWin: false, env: { COCKPIT_DURABLE_TERMINALS: '0' }, exists: () => true }), false);
  assert.equal(durableTerminalsAvailable({ isWin: false, env: {}, exists: path => path === '/usr/bin/tmux' }), true);
});

test('creates once, then reattaches the same isolated tmux server', () => {
  const calls = [];
  let present = false;
  const exec = (_bin, args) => {
    calls.push(args);
    if (args.includes('has-session') && !present) throw new Error('missing');
    if (args.includes('new-session')) present = true;
    if (args.includes('display-message')) return '/work/project\n';
  };
  const options = { id: 'a'.repeat(24), cwd: '/work/project', env: { TERM: 'xterm-256color' }, exec, exists: () => true };
  const created = ensureDurableTerminal(options);
  const resumed = ensureDurableTerminal(options);
  assert.equal(created.resumed, false);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(created.args, ['-L', `cockpit-${'a'.repeat(24)}`, 'attach-session', '-t', 'main']);
  assert.equal(calls.filter(args => args.includes('new-session')).length, 1);
  assert.equal(durableTerminalExists(options.id, { exec, exists: () => true }), true);
  assert.equal(durableTerminalCwd(options.id, { exec, exists: () => true }), '/work/project');
  assert.equal(killDurableTerminal(options.id, { exec, exists: () => true }), true);
});

test('rejects client-controlled tmux identifiers', () => {
  assert.throws(() => ensureDurableTerminal({ id: 'bad;name', cwd: '/tmp', env: {}, exec() {}, exists: () => true }), /Invalid durable terminal id/);
});

test('surfaces tmux stop failures instead of orphaning a hidden process', () => {
  assert.throws(
    () => killDurableTerminal('b'.repeat(24), { exec() { throw new Error('denied'); }, exists: () => true }),
    /denied/,
  );
});
