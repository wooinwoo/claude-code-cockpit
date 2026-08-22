// ─── Briefing & Smart Notification Service ───
// Phase 2: Smart Notifications (urgent/info 2-level)
// Phase 3: Morning Briefing (daily snapshot diff)

/**
 * @typedef {Object} Alert
 * @property {'urgent'|'info'} level
 * @property {string} projectId
 * @property {string} type - e.g. 'session_stuck', 'ci_failure', 'cost_exceeded'
 * @property {string} message
 */

/**
 * @typedef {Object} BriefingItem
 * @property {string} projectId
 * @property {string[]} changes
 * @property {boolean} needsAttention
 */

/**
 * @typedef {Object} Briefing
 * @property {string} date
 * @property {BriefingItem[]} items
 * @property {{yesterday: number, today: number, weekly: number}} cost
 * @property {number} attentionCount
 * @property {number} totalProjects
 * @property {boolean} hasPreviousSnapshot
 */

/**
 * @typedef {Object} AlertPrefs
 * @property {boolean} enabled
 * @property {string[]} disabledProjects
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

// m3: Use local date instead of UTC to avoid timezone mismatch
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots');
const ALERTS_PATH = join(DATA_DIR, 'alerts.json');

// Ensure directories
try { mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch { /* dir may already exist */ }

// ── Alert Types ──
// urgent (red): CI failure, session error loop, cost budget exceeded
// info (grey): PR merged, session complete, build success

/**
 * Check conditions and generate alerts.
 * Called by poller on each cycle.
 * @param {Object<string, {session?: Object, git?: Object, cicd?: Object}>} projectStates
 * @param {{today?: {apiEquivCost: number}}|null} costData
 * @param {*} cicdCache
 * @returns {Alert[]}
 */
export function checkAlerts(projectStates, costData, _cicdCache) {
  const alerts = [];
  const now = Date.now();

  for (const [projectId, state] of Object.entries(projectStates)) {
    const session = state.session;
    const _git = state.git;
    const cicd = state.cicd;

    // Urgent: Session stuck in error loop (busy > 5 min with no progress)
    if (session?.state === 'busy' && session.lastActivity) {
      const age = now - new Date(session.lastActivity).getTime();
      if (age > 300000 && age < 360000) { // fire once around 5-min mark
        alerts.push({ level: 'urgent', projectId, type: 'session_stuck',
          message: `${projectId}: Session busy for ${Math.round(age / 60000)}min — may be stuck` });
      }
    }

    // Urgent: CI/CD failure
    if (cicd?.runs) {
      const recentFails = cicd.runs.filter(r => r.conclusion === 'failure' && r.status === 'completed');
      if (recentFails.length > 0) {
        const latest = recentFails[0];
        const age = now - new Date(latest.updated_at || latest.created_at).getTime();
        if (age < 600000) { // within last 10 min
          alerts.push({ level: 'urgent', projectId, type: 'ci_failure',
            message: `${projectId}: CI failed — ${latest.name || 'workflow'}` });
        }
      }
    }
  }

  // Urgent: Cost budget exceeded (daily > $10)
  if (costData?.today?.apiEquivCost > 10) {
    alerts.push({ level: 'urgent', projectId: '_global', type: 'cost_exceeded',
      message: `Daily cost $${costData.today.apiEquivCost.toFixed(2)} exceeded $10 budget` });
  }

  return alerts;
}

/**
 * Save daily snapshot for morning briefing comparison.
 * Called once per day (server start or first access).
 * @param {Object<string, {session?: Object, git?: Object, prs?: Object}>} projectStates
 * @param {{today?: {apiEquivCost: number}, week?: {apiEquivCost: number}}|null} costData
 */
export function saveDailySnapshot(projectStates, costData) {
  const today = localDateStr();
  const snapshotPath = join(SNAPSHOT_DIR, `${today}.json`);

  // Don't overwrite if already saved today
  if (existsSync(snapshotPath)) return;

  const snapshot = {
    date: today,
    timestamp: new Date().toISOString(),
    projects: {}
  };

  for (const [projectId, state] of Object.entries(projectStates)) {
    snapshot.projects[projectId] = {
      session: state.session?.state || 'no_data',
      branch: state.git?.branch || null,
      uncommitted: state.git?.uncommittedCount || 0,
      lastCommit: state.git?.recentCommits?.[0]?.message || null,
      prCount: state.prs?.prs?.length || 0,
    };
  }

  snapshot.cost = {
    daily: costData?.today?.apiEquivCost || 0,
    weekly: costData?.week?.apiEquivCost || 0,
  };

  const tmp = snapshotPath + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, snapshotPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* tmp already removed */ }
  }
}

/**
 * Generate morning briefing by comparing today vs yesterday snapshot.
 * @param {Object<string, {session?: Object, git?: Object, cicd?: Object, prs?: Object}>} currentStates
 * @param {{today?: {apiEquivCost: number}, week?: {apiEquivCost: number}}|null} costData
 * @returns {Briefing}
 */
export function generateBriefing(currentStates, costData) {
  const today = localDateStr();
  const yesterday = localDateStr(new Date(Date.now() - 86400000));
  const yesterdayPath = join(SNAPSHOT_DIR, `${yesterday}.json`);

  let prevSnapshot = null;
  try {
    if (existsSync(yesterdayPath)) {
      prevSnapshot = JSON.parse(readFileSync(yesterdayPath, 'utf8'));
    }
  } catch { /* no previous snapshot available */ }

  const items = [];
  const attention = []; // projects needing attention (sorted to top)

  for (const [projectId, state] of Object.entries(currentStates)) {
    const prev = prevSnapshot?.projects?.[projectId];
    const changes = [];

    // New commits since yesterday
    if (state.git?.recentCommits?.length) {
      const commitMsg = state.git.recentCommits[0].message;
      if (!prev || prev.lastCommit !== commitMsg) {
        changes.push(`new commits (latest: ${commitMsg})`);
      }
    }

    // CI status change
    if (state.cicd?.runs?.length) {
      const latestRun = state.cicd.runs[0];
      if (latestRun.conclusion === 'failure') {
        attention.push(projectId);
        changes.push(`CI FAILED: ${latestRun.name || 'workflow'}`);
      } else if (latestRun.conclusion === 'success') {
        changes.push('CI passed');
      }
    }

    // PR changes
    const prCount = state.prs?.prs?.length || 0;
    const prevPrCount = prev?.prCount || 0;
    if (prCount !== prevPrCount) {
      changes.push(`PRs: ${prevPrCount} → ${prCount}`);
    }

    // Uncommitted changes
    const uncommitted = state.git?.uncommittedCount || 0;
    if (uncommitted > 5) {
      attention.push(projectId);
      changes.push(`${uncommitted} uncommitted files`);
    }

    // Session state
    if (state.session?.state === 'busy') {
      attention.push(projectId);
      changes.push('Session currently active');
    }

    if (changes.length > 0) {
      items.push({ projectId, changes, needsAttention: attention.includes(projectId) });
    }
  }

  // Cost summary
  const costSummary = {
    yesterday: prevSnapshot?.cost?.daily || 0,
    today: costData?.today?.apiEquivCost || 0,
    weekly: costData?.week?.apiEquivCost || 0,
  };

  // Sort: attention items first
  items.sort((a, b) => (b.needsAttention ? 1 : 0) - (a.needsAttention ? 1 : 0));

  return {
    date: today,
    items,
    cost: costSummary,
    attentionCount: new Set(attention).size,
    totalProjects: Object.keys(currentStates).length,
    hasPreviousSnapshot: !!prevSnapshot,
  };
}

/** @returns {AlertPrefs} */
export function getAlertPrefs() {
  try {
    if (existsSync(ALERTS_PATH)) return JSON.parse(readFileSync(ALERTS_PATH, 'utf8'));
  } catch { /* malformed JSON or file inaccessible */ }
  return { enabled: true, disabledProjects: [] };
}

/** @param {AlertPrefs} prefs */
export function saveAlertPrefs(prefs) {
  const tmp = ALERTS_PATH + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8');
    renameSync(tmp, ALERTS_PATH);
  } catch {
    try { unlinkSync(tmp); } catch { /* tmp already removed */ }
  }
}
