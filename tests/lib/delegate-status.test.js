import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeDelegatedRun,
  finishDelegatedRun,
  isValidDelegateStatus,
  touchDelegatedRun,
  withDelegatedRun,
} from '../../lib/delegate-status.js';

test('delegate status validates HTTP and file heartbeat payloads', () => {
  assert.equal(isValidDelegateStatus({ runId: 'run-1', state: 'running', cwd: '/repo' }), true);
  assert.equal(isValidDelegateStatus({ runId: 'run-1', state: 'heartbeat', updatedAt: Date.now() }), true);
  assert.equal(isValidDelegateStatus({ runId: '../bad', state: 'running' }), false);
  assert.equal(isValidDelegateStatus(null), false);
});

test('delegated run keeps project session busy until heartbeat expires', () => {
  const runs = new Map();
  touchDelegatedRun(runs, { runId: 'run-1', projectId: 'project-1', model: 'sonnet' }, 1000);

  const active = activeDelegatedRun(runs, 'project-1', 10_000, 15_000);
  assert.equal(active.runId, 'run-1');
  assert.deepEqual(withDelegatedRun({ projectId: 'project-1', state: 'idle', model: null }, active), {
    projectId: 'project-1',
    state: 'busy',
    model: 'sonnet',
    delegated: true,
    delegateRunId: 'run-1',
  });

  assert.equal(activeDelegatedRun(runs, 'project-1', 16_001, 15_000), null);
  assert.equal(runs.size, 0);
});

test('finishing one run preserves another active run for the project', () => {
  const runs = new Map();
  touchDelegatedRun(runs, { runId: 'run-1', projectId: 'project-1' }, 1000);
  touchDelegatedRun(runs, { runId: 'run-2', projectId: 'project-1' }, 2000);
  finishDelegatedRun(runs, 'run-2');
  assert.equal(activeDelegatedRun(runs, 'project-1', 3000)?.runId, 'run-1');
});
