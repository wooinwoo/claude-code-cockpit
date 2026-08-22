import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorService } from '../../lib/director-service.js';

function runtime(overrides = {}) {
  return {
    chat: async () => ({ stdout: 'done' }),
    listTasks: async () => [],
    dispatch: async () => ({ json: { spawned: 0 } }),
    createObjective: async () => ({ json: { id: 'task-1' } }),
    ...overrides,
  };
}

function service(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'director-service-'));
  return new DirectorService({
    runtime: opts.runtime || runtime(),
    stateFile: join(dir, 'directors.json'),
    projectsRoot: 'C:\\projects',
    getProjects: opts.getProjects || (() => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }]),
  });
}

describe('DirectorService', () => {
  it('creates three project Director slots and one Skill Director', () => {
    const svc = service();
    const directors = svc.listDirectors();
    assert.equal(directors.filter(d => d.kind === 'project').length, 3);
    assert.equal(directors.filter(d => d.kind === 'skill').length, 1);
    assert.equal(directors[0].projectId, 'alpha');
    assert.equal(directors[1].status, 'unassigned');
  });

  it('limits the owner console to three project Directors', () => {
    const svc = service({ getProjects: () => Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      path: `C:\\projects\\project-${index + 1}`,
    })) });
    assert.equal(svc.listDirectors().filter(d => d.kind === 'project').length, 3);
  });

  it('persists registry state atomically', () => {
    const svc = service();
    const parsed = JSON.parse(readFileSync(svc.stateFile, 'utf8'));
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.directors.length, 4);
  });

  it('recovers queued and running Director turns after a process restart', () => {
    const first = service();
    const state = JSON.parse(readFileSync(first.stateFile, 'utf8'));
    state.directors[0].status = 'running';
    state.runs.push({
      id: 'interrupted-run', directorId: 'project-director-1', status: 'running',
      prompt: 'keep going', output: '', error: null, createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), completedAt: null,
    });
    writeFileSync(first.stateFile, JSON.stringify(state), 'utf8');

    const restarted = new DirectorService({
      runtime: runtime(), stateFile: first.stateFile, projectsRoot: 'C:\\projects',
      getProjects: () => [{ id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' }],
    });
    assert.equal(restarted.getDirector('project-director-1').status, 'idle');
    assert.equal(restarted.getRun('interrupted-run').status, 'failed');
    assert.match(restarted.getRun('interrupted-run').error, /previous Praetorium shutdown/);
    assert.ok(restarted.getRun('interrupted-run').completedAt);
  });

  it('dispatches an adaptive number of ready tasks', async () => {
    let dispatched = null;
    const svc = service({ runtime: runtime({
      listTasks: async () => [
        { status: 'ready' }, { status: 'ready' }, { status: 'ready' }, { status: 'running' },
      ],
      dispatch: async ({ max }) => { dispatched = max; return { json: { spawned: max } }; },
    }) });
    const result = await svc.tickDirector('project-director-1');
    assert.ok(dispatched >= 1 && dispatched <= 3);
    assert.equal(result.spawned, dispatched);
  });

  it('ticks project boards independently when one board is slow', async () => {
    let releaseFirst;
    const firstBoard = new Promise(resolve => { releaseFirst = resolve; });
    const listed = [];
    const svc = service({
      getProjects: () => [
        { id: 'alpha', name: 'Alpha', path: 'C:\\projects\\alpha' },
        { id: 'beta', name: 'Beta', path: 'C:\\projects\\beta' },
      ],
      runtime: runtime({
        listTasks: async ({ board }) => {
          listed.push(board);
          if (board === 'alpha') await firstBoard;
          return [];
        },
      }),
    });
    const ticking = svc.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(listed.includes('beta'));
    releaseFirst();
    await ticking;
  });

  it('runs a Director chat asynchronously and returns durable output', async () => {
    const svc = service({ runtime: runtime({ chat: async () => ({ stdout: 'director result', sessionId: 'session-123' }) }) });
    const run = svc.submitMessage('project-director-1', 'ship it');
    assert.equal(run.status, 'queued');
    await new Promise(resolve => setTimeout(resolve, 30));
    const completed = svc.getRun(run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output, 'director result');
    assert.equal(svc.getDirector('project-director-1').sessionId, null);
    assert.equal(svc.getDirector('project-director-1').lastSessionId, 'session-123');
  });

  it('uses fresh sessions with bounded prior-turn handoff context', async () => {
    const seen = [];
    const svc = service({ runtime: runtime({
      chat: async ({ session, prompt }) => {
        seen.push({ session, prompt });
        return { stdout: 'ok', sessionId: 'audit-session' };
      },
    }) });
    const first = svc.submitMessage('project-director-1', 'first');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(svc.getRun(first.id).status, 'completed');
    const second = svc.submitMessage('project-director-1', 'second');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(svc.getRun(second.id).status, 'completed');
    assert.equal(seen[0].session, null);
    assert.equal(seen[0].prompt, 'first');
    assert.equal(seen[1].session, null);
    assert.match(seen[1].prompt, /PRAETORIUM FRESH-SESSION HANDOFF/);
    assert.match(seen[1].prompt, /OWNER:\nfirst/);
    assert.match(seen[1].prompt, /DIRECTOR:\nok/);
    assert.match(seen[1].prompt, /CURRENT OWNER MESSAGE\]\n\nsecond/);
  });
});
