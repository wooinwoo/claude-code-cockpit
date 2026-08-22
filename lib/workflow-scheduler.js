// ─── Workflow Scheduler: preset-based recurring workflow execution ───
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULES_FILE = join(__dirname, '..', 'workflow-schedules.json');
const CHECK_INTERVAL = 60_000; // check every 60s

let _schedules = [];
let _startRun = null;
let _poller = null;
let _timer = null;

// ─── Public API ───

export function init(poller, startRunFn) {
  _poller = poller;
  _startRun = startRunFn;
  _schedules = loadFromDisk();
  // Recompute nextRunAt for all schedules (in case time drifted while app was off)
  for (const s of _schedules) {
    if (s.enabled && (!s.nextRunAt || s.nextRunAt < Date.now())) {
      // Missed run — will fire on first check
    }
  }
  _timer = setInterval(checkSchedules, CHECK_INTERVAL);
  // Run first check after 5s (let server finish startup)
  setTimeout(checkSchedules, 5000);
  console.log(`[Scheduler] Loaded ${_schedules.length} schedule(s), ${_schedules.filter(s => s.enabled).length} active`);
}

export function listSchedules() {
  return _schedules.map(s => ({ ...s }));
}

export function getSchedule(id) {
  return _schedules.find(s => s.id === id) || null;
}

export function addSchedule({ workflowId, workflowName, inputs, preset, hour, day }) {
  const id = randomBytes(6).toString('hex');
  const sched = {
    id,
    workflowId,
    workflowName: workflowName || workflowId,
    inputs: inputs || {},
    preset: preset || 'weekly',   // daily | weekly | monthly
    hour: hour ?? 9,              // 0-23
    day: day ?? 1,                // weekly: 0-6 (Sun-Sat), monthly: 1-28
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: Date.now()
  };
  sched.nextRunAt = computeNextRun(sched);
  _schedules.push(sched);
  saveToDisk();
  broadcast('schedule:update', { action: 'added', schedule: sched });
  return sched;
}

export function updateSchedule(id, updates) {
  const sched = _schedules.find(s => s.id === id);
  if (!sched) return null;
  const allowed = ['preset', 'hour', 'day', 'enabled', 'inputs'];
  for (const key of allowed) {
    if (updates[key] !== undefined) sched[key] = updates[key];
  }
  sched.nextRunAt = computeNextRun(sched);
  saveToDisk();
  broadcast('schedule:update', { action: 'updated', schedule: { ...sched } });
  return { ...sched };
}

export function removeSchedule(id) {
  const idx = _schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  const removed = _schedules.splice(idx, 1)[0];
  saveToDisk();
  broadcast('schedule:update', { action: 'removed', id: removed.id });
  return true;
}

// ─── Scheduler Core ───

function checkSchedules() {
  const now = Date.now();
  for (const sched of _schedules) {
    if (!sched.enabled) continue;
    if (!sched.nextRunAt) { sched.nextRunAt = computeNextRun(sched); continue; }
    if (sched.nextRunAt > now) continue;

    // Due! Fire the workflow
    console.log(`[Scheduler] Firing "${sched.workflowName}" (${sched.id})`);
    sched.lastRunAt = now;
    sched.nextRunAt = computeNextRun(sched);
    saveToDisk();

    if (_startRun) {
      _startRun(sched.workflowId, sched.inputs).then(result => {
        broadcast('schedule:fired', { scheduleId: sched.id, runId: result?.runId, workflowName: sched.workflowName });
      }).catch(err => {
        console.error(`[Scheduler] Failed to fire "${sched.workflowName}":`, err.message);
        broadcast('schedule:error', { scheduleId: sched.id, error: err.message });
      });
    }
  }
}

// ─── Next Run Computation ───

function computeNextRun(sched) {
  if (!sched.enabled) return null;
  const now = new Date();
  const h = sched.hour ?? 9;

  if (sched.preset === 'daily') {
    const next = new Date(now);
    next.setHours(h, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (sched.preset === 'weekly') {
    const targetDay = sched.day ?? 1; // 0=Sun, 1=Mon, ..., 6=Sat
    const next = new Date(now);
    next.setHours(h, 0, 0, 0);
    let daysAhead = targetDay - next.getDay();
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && next.getTime() <= now.getTime()) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
    return next.getTime();
  }

  if (sched.preset === 'monthly') {
    const targetDate = Math.min(sched.day ?? 1, 28);
    let next = new Date(now.getFullYear(), now.getMonth(), targetDate, h, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next = new Date(now.getFullYear(), now.getMonth() + 1, targetDate, h, 0, 0, 0);
    }
    return next.getTime();
  }

  // Fallback: daily
  return computeNextRun({ ...sched, preset: 'daily' });
}

// ─── Persistence ───

function loadFromDisk() {
  try {
    if (!existsSync(SCHEDULES_FILE)) return [];
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch { return []; }
}

function saveToDisk() {
  try {
    writeFileSync(SCHEDULES_FILE, JSON.stringify(_schedules, null, 2));
  } catch (err) { console.warn('[Scheduler] Save failed:', err.message); }
}

function broadcast(event, data) {
  if (_poller) _poller.broadcast(event, data);
}
