import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adaptiveWorkerLimit } from './hermes-runtime.js';

const PROJECT_DIRECTOR_COUNT = 3;
const TERMINAL_TASK_STATES = new Set(['done', 'blocked', 'archived']);
const DIRECTOR_HANDOFF_TURNS = 8;
const DIRECTOR_HANDOFF_CHARS = 24000;

function slug(value, fallback) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return clean || fallback;
}

function now() { return new Date().toISOString(); }

function defaultState(projects = []) {
  const directors = [];
  for (let i = 0; i < PROJECT_DIRECTOR_COUNT; i++) {
    const project = projects[i] || null;
    const n = i + 1;
    directors.push({
      id: `project-director-${n}`,
      profile: `project-director-${n}`,
      kind: 'project',
      name: project ? `${project.name || project.id} Director` : `Project Director ${n}`,
      projectId: project?.id || null,
      cwd: project?.path ? resolve(project.path) : null,
      board: slug(project?.id, `project-${n}`),
      session: `owner-project-${n}`,
      sessionId: null,
      lastSessionId: null,
      status: project ? 'idle' : 'unassigned',
      lastRunId: null,
      lastSummary: '',
    });
  }
  directors.push({
    id: 'skill-director', profile: 'skill-director', kind: 'skill', name: 'Skill Director',
    projectId: null, cwd: null, board: 'skill-governance', session: 'owner-skill-director',
    sessionId: null,
    lastSessionId: null,
    status: 'idle', lastRunId: null, lastSummary: '',
  });
  return { schema: 1, directors, runs: [], updatedAt: now() };
}

export class DirectorService extends EventEmitter {
  constructor({ runtime, stateFile, projectsRoot, getProjects = () => [] } = {}) {
    super();
    if (!runtime) throw new Error('DirectorService requires a runtime');
    if (!stateFile) throw new Error('DirectorService requires a stateFile');
    this.runtime = runtime;
    this.stateFile = stateFile;
    this.projectsRoot = resolve(projectsRoot || process.cwd());
    this.getProjects = getProjects;
    this.boardLocks = new Set();
    this.timer = null;
    this.state = this._load();
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector && !skillDirector.cwd) skillDirector.cwd = this.projectsRoot;
    this._recoverInterruptedRuns();
    this.syncProjects();
  }

  _load() {
    try {
      if (existsSync(this.stateFile)) {
        const data = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        if (data?.schema === 1 && Array.isArray(data.directors) && Array.isArray(data.runs)) return data;
      }
    } catch { /* recover from a partial/corrupt file with a fresh registry */ }
    return defaultState(this.getProjects());
  }

  _save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.state.updatedAt = now();
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.stateFile);
  }

  _recoverInterruptedRuns() {
    const interruptedAt = now();
    let changed = false;
    for (const run of this.state.runs) {
      if (!['queued', 'running'].includes(run.status)) continue;
      run.status = 'failed';
      run.error = 'Interrupted by a previous Praetorium shutdown; submit again to start a fresh Director turn.';
      run.completedAt = interruptedAt;
      changed = true;
    }
    for (const director of this.state.directors) {
      if (director.status !== 'running') continue;
      director.status = director.kind === 'project' && !director.projectId ? 'unassigned' : 'idle';
      changed = true;
    }
    if (changed) this._save();
  }

  syncProjects() {
    const projects = this.getProjects().filter(p => p?.path && isAbsolute(resolve(p.path)));
    const desired = defaultState(projects).directors;
    const previous = new Map(this.state.directors.map(d => [d.id, d]));
    this.state.directors = desired.map(d => ({ ...d, ...(previous.get(d.id) || {}), ...(
      d.kind === 'project' ? { name: d.name, projectId: d.projectId, cwd: d.cwd, board: d.board, status: d.projectId ? (previous.get(d.id)?.status === 'running' ? 'running' : 'idle') : 'unassigned' } : {}
    ) }));
    const skillDirector = this.state.directors.find(d => d.id === 'skill-director');
    if (skillDirector && !skillDirector.cwd) skillDirector.cwd = this.projectsRoot;
    this._save();
    return this.listDirectors();
  }

  listDirectors() {
    return this.state.directors.map(d => ({ ...d }));
  }

  getDirector(id) {
    return this.state.directors.find(d => d.id === id) || null;
  }

  listRuns({ directorId, limit = 50 } = {}) {
    return this.state.runs.filter(r => !directorId || r.directorId === directorId).slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  getRun(id) { return this.state.runs.find(r => r.id === id) || null; }

  submitMessage(directorId, prompt) {
    const director = this.getDirector(directorId);
    if (!director) throw new Error('Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    if (!String(prompt || '').trim()) throw new Error('Prompt is required');
    if (director.status === 'running') throw new Error('Director is already running');

    const run = {
      id: randomUUID(), directorId, kind: 'chat', status: 'queued', prompt: String(prompt),
      output: '', error: null, createdAt: now(), startedAt: null, completedAt: null,
    };
    this.state.runs.push(run);
    director.lastRunId = run.id;
    director.status = 'running';
    this._save();
    queueMicrotask(() => this._executeChat(run.id));
    return { ...run };
  }

  _contextualPrompt(run) {
    const history = this.state.runs
      .filter(item => item.id !== run.id && item.directorId === run.directorId && item.status === 'completed')
      .slice(-DIRECTOR_HANDOFF_TURNS)
      .map(item => `OWNER:\n${item.prompt}\n\nDIRECTOR:\n${item.output || '(no textual response)'}`);
    if (!history.length) return run.prompt;

    let handoff = history.join('\n\n---\n\n');
    if (handoff.length > DIRECTOR_HANDOFF_CHARS) handoff = handoff.slice(-DIRECTOR_HANDOFF_CHARS);
    return [
      '[PRAETORIUM FRESH-SESSION HANDOFF]',
      'The following is bounded prior owner/director context. Preserve durable decisions, but re-check live repository and board state before acting.',
      handoff,
      '[CURRENT OWNER MESSAGE]',
      run.prompt,
    ].join('\n\n');
  }

  async _executeChat(runId) {
    const run = this.getRun(runId);
    const director = run && this.getDirector(run.directorId);
    if (!run || !director) return;
    run.status = 'running';
    run.startedAt = now();
    this._save();
    this.emit('run', { ...run });
    try {
      await this.runtime.ensureBoard?.({ profile: director.profile, board: director.board, cwd: director.cwd, name: director.name });
      const result = await this.runtime.chat({
        profile: director.profile, session: null, cwd: director.cwd,
        board: director.board, prompt: this._contextualPrompt(run),
        onOutput: ({ channel, text }) => {
          if (channel === 'stdout') run.output = (run.output + text).slice(-5 * 1024 * 1024);
          this.emit('output', { runId, directorId: director.id, channel, text });
        },
      });
      // Hermes v0.20.5 can stall before inference when resuming a Codex
      // app-server session. Every Director turn is intentionally fresh; the
      // bounded handoff above retains decisions without unbounded model context.
      director.sessionId = null;
      if (result.sessionId) director.lastSessionId = result.sessionId;
      run.output = result.stdout;
      run.status = 'completed';
      director.lastSummary = result.stdout.slice(-2000);
      director.status = 'idle';
      await this.tickDirector(director.id);
    } catch (err) {
      run.status = 'failed';
      run.error = err.message;
      run.output = err.result?.stdout || '';
      director.status = 'error';
    } finally {
      run.completedAt = now();
      this._save();
      this.emit('run', { ...run });
    }
  }

  async createObjective(directorId, { title, body }) {
    const director = this.getDirector(directorId);
    if (!director || director.kind !== 'project') throw new Error('Project Director not found');
    if (!director.cwd) throw new Error('Director has no assigned project directory');
    await this.runtime.ensureBoard?.({ profile: director.profile, board: director.board, cwd: director.cwd, name: director.name });
    const result = await this.runtime.createObjective({
      profile: director.profile, board: director.board, cwd: director.cwd, title, body,
    });
    await this.tickDirector(directorId);
    return result.json || { output: result.stdout };
  }

  async getBoard(directorId) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd) return [];
    await this.runtime.ensureBoard?.({ profile: director.profile, board: director.board, cwd: director.cwd, name: director.name });
    return this.runtime.listTasks({ profile: director.profile, board: director.board, cwd: director.cwd });
  }

  async tickDirector(directorId, requestedMax = null) {
    const director = this.getDirector(directorId);
    if (!director || !director.cwd || this.boardLocks.has(director.board)) return { skipped: true };
    this.boardLocks.add(director.board);
    try {
      await this.runtime.ensureBoard?.({ profile: director.profile, board: director.board, cwd: director.cwd, name: director.name });
      const tasks = await this.runtime.listTasks({ profile: director.profile, board: director.board, cwd: director.cwd });
      const ready = tasks.filter(t => ['ready', 'todo'].includes(t.status)).length;
      const running = tasks.filter(t => t.status === 'running').length;
      const max = requestedMax == null ? adaptiveWorkerLimit({ ready, running }) : Math.max(0, Math.min(12, Number(requestedMax) || 0));
      if (max <= 0) return { ready, running, spawned: 0, tasks };
      const result = await this.runtime.dispatch({ profile: director.profile, board: director.board, cwd: director.cwd, max });
      return { ready, running, spawned: result.json?.spawned ?? null, dispatch: result.json, tasks };
    } finally {
      this.boardLocks.delete(director.board);
    }
  }

  async tick() {
    // Boards are independent failure domains. A missing/slow repository in
    // slot 1 must never stall dispatch for slots 2 and 3.
    const eligible = this.state.directors.filter(director => director.kind === 'project' && director.cwd);
    const results = await Promise.all(eligible.map(async director => {
      try { return { directorId: director.id, ...(await this.tickDirector(director.id)) }; }
      catch (err) { return { directorId: director.id, error: err.message }; }
    }));
    this.emit('tick', results);
    return results;
  }

  startScheduler(intervalMs = 10000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => this.emit('error', err)), Math.max(5000, intervalMs));
    this.timer.unref?.();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary() {
    const runs = this.state.runs;
    return {
      localOnly: true,
      directors: this.listDirectors(),
      activeRuns: runs.filter(r => ['queued', 'running'].includes(r.status)).length,
      recentRuns: this.listRuns({ limit: 20 }),
      terminalTaskStates: [...TERMINAL_TASK_STATES],
    };
  }
}

export const _test = { defaultState, slug };
