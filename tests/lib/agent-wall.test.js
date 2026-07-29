import test from 'node:test';
import assert from 'node:assert/strict';
import { getAgentAttention, getAgentAttentionForTerm, getAgentKind, getAgentState, getOperationalState, getReleaseGate, getWallSummary } from '../../js/agent-wall-state.js';
import { getAgentEvents, recordAgentEvent } from '../../lib/supervisor-service.js';

test('Agent Wall classifies agent and operational state', () => {
  assert.equal(getAgentKind('codex --full-auto', ''), 'Codex');
  assert.equal(getAgentKind('', 'Claude Code'), 'Claude');
  assert.equal(getAgentState({ output: 'Waiting for input', now: 10_000 }), 'waiting');
  assert.equal(getAgentState({ output: 'running tests', lastOutputAt: 9_000, now: 10_000 }), 'busy');
  assert.equal(getAgentState({ exited: true, output: '', now: 10_000 }), 'done');

  const now = Date.now();
  const decisions = [
    { cwd: '/work/other', decision: 'ask', ts: new Date(now).toISOString() },
    { cwd: '/work/app/packages/web', decision: 'block', ts: new Date(now).toISOString() },
  ];
  assert.equal(getAgentAttention(decisions, '/work/app', now)?.decision, 'block');
  assert.equal(getAgentAttention(decisions, '/work/missing', now), null);
  assert.equal(getAgentAttention([{ cwd: '/work/app', decision: 'deny', ts: new Date(now - 11 * 60_000).toISOString() }], '/work/app', now), null);
  assert.equal(getAgentAttention([...decisions, { cwd: '/work/app', decision: 'approve', ts: new Date(now).toISOString() }], '/work/app', now), null);
  assert.equal(getAgentAttentionForTerm({ decisions, projectPath: '/work/app', projectAgentCount: 2, now }), null);
  assert.equal(getAgentAttentionForTerm({ hook: { state: 'waiting', reason: 'Approve', updatedAt: now }, decisions, projectPath: '/work/app', projectAgentCount: 2, now })?.reason, 'Approve');
  assert.equal(getOperationalState('idle', 'hold', null), 'waiting');
  assert.equal(getOperationalState('done', 'hold', null), 'waiting');
  assert.equal(getOperationalState('busy', 'hold', null), 'busy');
  assert.deepEqual(getWallSummary([
    { state: 'busy', gate: { state: 'hold' } },
    { state: 'waiting', gate: { state: 'ready' } },
  ]), { total: 2, working: 1, waiting: 1, hold: 1, ready: 1 });

  const git = { branch: 'main', uncommittedCount: 0, recentCommits: [{ hash: 'abc1234' }] };
  const passed = [{ workflowName: 'test', headBranch: 'main', headSha: 'abc123456789', status: 'completed', conclusion: 'success', createdAt: new Date(now).toISOString() }];
  assert.deepEqual(getReleaseGate({ git, runs: passed }), { state: 'ready', label: 'READY', reason: 'Clean, current commit CI passed', target: 'cicd' });
  assert.deepEqual(getReleaseGate({ git: { ...git, uncommittedCount: 1 }, runs: passed }), { state: 'hold', label: 'HOLD', reason: '1 uncommitted changes', target: 'changes' });
  assert.equal(getReleaseGate({ git, runs: [{ ...passed[0], conclusion: 'failure' }] }).state, 'hold');
  assert.equal(getReleaseGate({ git, runs: [{ ...passed[0], headSha: 'different' }] }).state, 'unknown');
  assert.equal(getReleaseGate({ git, runs: passed, prs: [{ branch: 'main', state: 'OPEN', reviewDecision: 'PENDING' }] }).target, 'pr');

  recordAgentEvent({ session_id: 'agent-wall-test', term_id: 'term-1', agent_kind: 'codex', cwd: '/work/app', hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.deepEqual(getAgentEvents().find(e => e.sessionId === 'agent-wall-test'), {
    sessionId: 'agent-wall-test', termId: 'term-1', type: 'PermissionRequest', state: 'waiting', kind: 'codex', cwd: '/work/app', reason: 'Bash', updatedAt: getAgentEvents().find(e => e.sessionId === 'agent-wall-test').updatedAt,
  });
  recordAgentEvent({ session_id: 'agent-wall-test', term_id: 'term-1', hook_event_name: 'PostToolUse' });
  assert.equal(getAgentEvents().find(e => e.sessionId === 'agent-wall-test').state, 'busy');
  recordAgentEvent({ session_id: 'agent-wall-test-2', term_id: 'term-1', hook_event_name: 'SessionStart' });
  assert.equal(getAgentEvents().filter(e => e.termId === 'term-1').length, 1);
  recordAgentEvent({ session_id: 'agent-wall-test-2', term_id: 'term-1', hook_event_name: 'SubagentStop' });
  assert.equal(getAgentEvents().find(e => e.termId === 'term-1').state, 'busy');
});
