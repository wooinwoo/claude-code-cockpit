import { gitExec } from './wsl-utils.js';

/**
 * @typedef {Object} GitCommit
 * @property {string} hash - Short commit hash
 * @property {string} message - Commit message
 * @property {string} ago - Relative time string (e.g. "2 hours ago")
 */

/**
 * @typedef {Object} GitStatusResult
 * @property {string} projectId
 * @property {string} branch
 * @property {number} uncommittedCount
 * @property {Array<{status: string, file: string}>} uncommittedFiles
 * @property {number} uncommittedTotal
 * @property {GitCommit[]} recentCommits
 * @property {Array<{path: string, branch: string}>} worktrees
 * @property {string} remoteUrl
 * @property {number} stashCount
 */

/**
 * @typedef {Object} BranchesResult
 * @property {string} current
 * @property {string[]} local
 * @property {string[]} remote
 */

// Per-project adaptive timeout: starts at 10s, adjusts based on actual response times
const projectTimeouts = new Map(); // projectPath → { avg: ms, timeouts: count }
const DEFAULT_TIMEOUT = 10000;
const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

function getTimeout(projectPath) {
  const entry = projectTimeouts.get(projectPath);
  if (!entry) return DEFAULT_TIMEOUT;
  // 2.5x average + buffer for slow ops, clamped to [MIN, MAX]
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.round(entry.avg * 2.5 + 1000)));
}

function recordTiming(projectPath, ms) {
  const entry = projectTimeouts.get(projectPath) || { avg: DEFAULT_TIMEOUT / 2, timeouts: 0 };
  // Exponential moving average (α = 0.3)
  entry.avg = Math.round(entry.avg * 0.7 + ms * 0.3);
  entry.timeouts = Math.max(0, entry.timeouts - 1); // decay timeout count on success
  projectTimeouts.set(projectPath, entry);
}

function recordTimeout(projectPath) {
  const entry = projectTimeouts.get(projectPath) || { avg: DEFAULT_TIMEOUT / 2, timeouts: 0 };
  entry.timeouts++;
  // Bump average up on timeout to increase future timeout allowance
  entry.avg = Math.min(MAX_TIMEOUT, Math.round(entry.avg * 1.5));
  projectTimeouts.set(projectPath, entry);
}

async function git(projectPath, args) {
  const timeout = getTimeout(projectPath);
  const start = Date.now();
  try {
    const { stdout } = await gitExec(projectPath, args, { timeout });
    recordTiming(projectPath, Date.now() - start);
    return stdout.trim();
  } catch (err) {
    if (err.killed) recordTimeout(projectPath); // timed out
    return '';
  }
}

/**
 * @param {{id: string, path: string}} project
 * @returns {Promise<GitStatusResult>}
 */
export async function getGitStatus(project) {
  const results = await Promise.allSettled([
    git(project.path, ['branch', '--show-current']),
    git(project.path, ['status', '--porcelain']),
    git(project.path, ['log', '--oneline', '-5', '--format=%h|%s|%cr']),
    git(project.path, ['worktree', 'list', '--porcelain']),
    git(project.path, ['stash', 'list', '--format=%h']),
  ]);
  const [branch, status, log, worktreeRaw, stashRaw] = results.map(r => r.status === 'fulfilled' ? r.value : '');

  const statusLines = status ? status.split('\n').filter(Boolean) : [];
  const commits = log ? log.split('\n').filter(Boolean).map(line => {
    const [hash, ...rest] = line.split('|');
    return { hash, message: rest[0] || '', ago: rest[1] || '' };
  }) : [];

  const worktrees = [];
  if (worktreeRaw) {
    let current = {};
    for (const line of worktreeRaw.split('\n')) {
      if (line.startsWith('worktree ')) current.path = line.slice(9).replace(/\\/g, '/');
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === '') { if (current.path) worktrees.push(current); current = {}; }
    }
    if (current.path) worktrees.push(current);
  }

  // GitHub URL from remote
  const remoteRaw = await git(project.path, ['remote', 'get-url', 'origin']);
  let remoteUrl = '';
  if (remoteRaw) {
    remoteUrl = remoteRaw
      .replace(/\.git$/, '')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  }

  return {
    projectId: project.id,
    branch: branch || 'unknown',
    uncommittedCount: statusLines.length,
    uncommittedFiles: statusLines.slice(0, 10).map(l => ({
      status: l.substring(0, 2).trim(),
      file: l.substring(3)
    })),
    uncommittedTotal: statusLines.length,
    recentCommits: commits,
    worktrees: worktrees.filter(w => w.branch),
    remoteUrl,
    stashCount: stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0,
  };
}

/**
 * @param {{id: string, path: string}} project
 * @returns {Promise<BranchesResult>}
 */
export async function getBranches(project) {
  const [local, remote, currentBranch] = await Promise.all([
    git(project.path, ['branch', '--format=%(refname:short)']),
    git(project.path, ['branch', '-r', '--format=%(refname:short)']),
    git(project.path, ['branch', '--show-current'])
  ]);
  return {
    current: currentBranch || '',
    local: local ? local.split('\n').filter(Boolean) : [],
    remote: remote ? remote.split('\n').filter(Boolean).filter(b => !b.includes('/HEAD')) : []
  };
}
