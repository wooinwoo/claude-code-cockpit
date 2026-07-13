// ─── Batch Command Service ───
// Phase 5: Multi-project batch command execution
// Whitelist-only, sequential by default, with real-time SSE progress

/**
 * @typedef {Object} BatchCommand
 * @property {string} id - Command identifier
 * @property {string} label - Display name
 * @property {string} cmd - Shell command string
 * @property {string} category - 'git' | 'npm' | 'info'
 */

/**
 * @typedef {Object} BatchResult
 * @property {string} projectId
 * @property {string} projectName
 * @property {'success'|'error'} status
 * @property {string} output
 * @property {number} duration - Execution time in ms
 */

/**
 * @typedef {Object} BatchSummary
 * @property {string} batchId
 * @property {string} commandId
 * @property {string} command - Display label
 * @property {number} total
 * @property {number} success
 * @property {number} error
 * @property {BatchResult[]} results
 */

import { gitExec, shellExec } from './wsl-utils.js';

// Strict whitelist — only these commands are allowed
const COMMAND_WHITELIST = [
  { id: 'git-pull', label: 'Git Pull', cmd: 'git pull', category: 'git' },
  { id: 'git-status', label: 'Git Status', cmd: 'git status --short', category: 'git' },
  { id: 'git-fetch', label: 'Git Fetch', cmd: 'git fetch --all', category: 'git' },
  { id: 'git-stash', label: 'Git Stash', cmd: 'git stash', category: 'git' },
  { id: 'git-stash-pop', label: 'Git Stash Pop', cmd: 'git stash pop', category: 'git' },
  { id: 'npm-audit', label: 'NPM Audit', cmd: 'npm audit --omit=dev', category: 'npm' },
  { id: 'npm-outdated', label: 'NPM Outdated', cmd: 'npm outdated', category: 'npm' },
  { id: 'npm-install', label: 'NPM Install', cmd: 'npm install', category: 'npm' },
  { id: 'npm-test', label: 'NPM Test', cmd: 'npm test', category: 'npm' },
  { id: 'npm-lint', label: 'NPM Lint', cmd: 'npm run lint', category: 'npm' },
  { id: 'npm-build', label: 'NPM Build', cmd: 'npm run build', category: 'npm' },
  { id: 'disk-usage', label: 'Disk Usage', cmd: 'du -sh .', category: 'info' },
];

// NEVER allow these (even if user somehow bypasses whitelist)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/, /git\s+push.*--force/, /git\s+reset\s+--hard/,
  /git\s+clean/, /npm\s+publish/, /curl/, /wget/, /eval/, /exec/,
];

let _poller = null;
let _runningBatch = null;
let _batchStopped = false;

/**
 * Initialize batch service with a Poller instance for SSE broadcasts.
 * @param {import('./poller.js').Poller} poller
 */
export function initBatch(poller) {
  _poller = poller;
}

/** @returns {Array<{id: string, label: string, category: string}>} */
export function getWhitelist() {
  return COMMAND_WHITELIST.map(c => ({ id: c.id, label: c.label, category: c.category }));
}

/**
 * Execute a batch command across multiple projects.
 * @param {string} commandId - Whitelist command ID
 * @param {Array<{id: string, name: string, path: string}>} projects - Target projects
 * @param {{parallel?: boolean, maxConcurrent?: number}} [options]
 * @returns {Promise<BatchSummary>}
 */
export async function executeBatch(commandId, projects, options = {}) {
  const cmd = COMMAND_WHITELIST.find(c => c.id === commandId);
  if (!cmd) throw new Error(`Unknown command: ${commandId}`);

  // Double-check against blocked patterns
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(cmd.cmd)) throw new Error('Blocked command');
  }

  if (_runningBatch) throw new Error('Another batch is already running');

  const batchId = Date.now().toString(36);
  const results = [];

  _batchStopped = false;
  _runningBatch = { batchId, commandId, total: projects.length, completed: 0, results };

  _poller?.broadcast('batch:start', { batchId, commandId, command: cmd.label, total: projects.length });

  const execute = async (project) => {
    const startTime = Date.now();
    _poller?.broadcast('batch:progress', {
      batchId, projectId: project.id, projectName: project.name,
      status: 'running', index: results.length
    });

    try {
      let output;
      const isGit = cmd.cmd.startsWith('git ');
      if (isGit) {
        const args = cmd.cmd.replace('git ', '').split(' ');
        output = await gitExec(project.path, args, { timeout: 60000 });
      } else {
        output = await shellExec(project.path, cmd.cmd, { timeout: 120000 });
      }

      const result = {
        projectId: project.id, projectName: project.name,
        status: 'success', output: (output || '').slice(0, 5000),
        duration: Date.now() - startTime
      };
      results.push(result);
      _runningBatch.completed++;

      _poller?.broadcast('batch:progress', { batchId, ...result, index: results.length - 1 });
      return result;
    } catch (err) {
      const result = {
        projectId: project.id, projectName: project.name,
        status: 'error', output: (err.message || '').slice(0, 2000),
        duration: Date.now() - startTime
      };
      results.push(result);
      _runningBatch.completed++;

      _poller?.broadcast('batch:progress', { batchId, ...result, index: results.length - 1 });
      return result;
    }
  };

  try {
    if (options.parallel) {
      const maxConcurrent = Math.min(options.maxConcurrent || 3, 5);
      // C4 fix: proper work queue with atomic index via shift()
      const queue = [...projects]; // copy to avoid mutation
      const workers = Array.from({ length: maxConcurrent }, async () => {
        while (queue.length > 0) {
          const project = queue.shift(); // atomic in single-threaded JS between awaits
          if (project && !_batchStopped) await execute(project);
        }
      });
      await Promise.all(workers);
    } else {
      // Sequential execution
      for (const project of projects) {
        if (_batchStopped) break; // M3: respect stop signal
        await execute(project);
      }
    }
  } finally {
    _runningBatch = null;
  }

  const summary = {
    batchId, commandId, command: cmd.label,
    total: projects.length,
    success: results.filter(r => r.status === 'success').length,
    error: results.filter(r => r.status === 'error').length,
    results,
  };

  _poller?.broadcast('batch:done', summary);
  return summary;
}

/**
 * Stop the currently running batch (running commands finish, no new ones start).
 * @returns {boolean} True if a batch was stopped
 */
export function stopBatch() {
  if (_runningBatch) {
    // M3: Set stop flag — running commands finish, but no new commands start
    _batchStopped = true;
    const batch = _runningBatch;
    // Don't null _runningBatch here — let the finally block handle it to prevent double-run
    _poller?.broadcast('batch:done', { batchId: batch.batchId, stopped: true, results: batch.results });
    return true;
  }
  return false;
}

/** @returns {{batchId: string, commandId: string, total: number, completed: number}|null} */
export function getBatchStatus() {
  if (!_runningBatch) return null;
  return {
    batchId: _runningBatch.batchId,
    commandId: _runningBatch.commandId,
    total: _runningBatch.total,
    completed: _runningBatch.completed,
  };
}
