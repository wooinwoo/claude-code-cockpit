import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DELEGATE_HEARTBEAT_TTL_MS = 15_000;
export const DELEGATE_STATUS_DIR = join(tmpdir(), `cockpit-delegates-${process.getuid?.() ?? 'user'}`);

export function isValidDelegateStatus(event) {
  return Boolean(event && typeof event === 'object' && !Array.isArray(event)
    && /^[a-zA-Z0-9-]{1,80}$/.test(event.runId || '')
    && ['running', 'heartbeat', 'done'].includes(event.state)
    && (!event.model || (typeof event.model === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(event.model)))
    && (!event.termId || (typeof event.termId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(event.termId)))
    && (!event.cwd || (typeof event.cwd === 'string' && event.cwd.length <= 2000))
    && (event.updatedAt === undefined || (Number.isFinite(event.updatedAt) && event.updatedAt > 0)));
}

export function touchDelegatedRun(runs, run, now = Date.now()) {
  const value = { ...run, updatedAt: now };
  runs.set(run.runId, value);
  return value;
}

export function finishDelegatedRun(runs, runId) {
  return runs.delete(runId);
}

export function activeDelegatedRun(runs, projectId, now = Date.now(), ttlMs = DELEGATE_HEARTBEAT_TTL_MS) {
  let active = null;
  for (const [runId, run] of runs) {
    if (now - run.updatedAt > ttlMs) {
      runs.delete(runId);
      continue;
    }
    if (run.projectId === projectId && (!active || run.updatedAt > active.updatedAt)) active = run;
  }
  return active;
}

export function withDelegatedRun(session, run) {
  if (!run) return session;
  return {
    ...session,
    state: 'busy',
    model: run.model || session.model,
    delegated: true,
    delegateRunId: run.runId,
  };
}
