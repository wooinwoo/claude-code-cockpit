import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgentProcess } from '../../lib/process-agent.js';

function proc(entries) {
  return path => {
    const match = path.match(/^\/proc\/(\d+)\/(?:task\/\1\/children|(comm|cmdline))$/);
    if (!match || !entries[match[1]]) throw new Error('missing proc entry');
    if (path.endsWith('/children')) return entries[match[1]].children || '';
    return entries[match[1]][match[2]] || '';
  };
}

test('detectAgentProcess finds Claude and Codex below a PTY shell', () => {
  assert.deepEqual(detectAgentProcess(10, proc({
    10: { comm: 'bash\n', cmdline: 'bash\0', children: '11' },
    11: { comm: 'claude\n', cmdline: 'claude\0--resume\0', children: '' },
  })), { available: true, kind: 'claude' });
  assert.deepEqual(detectAgentProcess(20, proc({
    20: { comm: 'bash\n', cmdline: 'bash\0', children: '21' },
    21: { comm: 'MainThread\n', cmdline: 'node\0/home/u/bin/codex\0', children: '22' },
    22: { comm: 'codex\n', cmdline: '/vendor/codex\0', children: '' },
  })), { available: true, kind: 'codex' });
  assert.deepEqual(detectAgentProcess(30, proc({
    30: { comm: 'bash\n', cmdline: 'bash\0', children: '' },
  })), { available: true, kind: null });
});

test('detectAgentProcess finds opencode below a PTY shell', () => {
  // opencode는 node 래퍼(comm=MainThread) 아래 바이너리로 뜨는 경우도 있다
  assert.deepEqual(detectAgentProcess(40, proc({
    40: { comm: 'bash\n', cmdline: 'bash\0', children: '41' },
    41: { comm: 'opencode\n', cmdline: '/usr/local/bin/opencode\0', children: '' },
  })), { available: true, kind: 'opencode' });
  assert.deepEqual(detectAgentProcess(50, proc({
    50: { comm: 'bash\n', cmdline: 'bash\0', children: '51' },
    51: { comm: 'MainThread\n', cmdline: 'node\0/home/u/.opencode/bin/opencode\0', children: '' },
  })), { available: true, kind: 'opencode' });
});
