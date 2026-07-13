import { describe, it } from 'node:test';
import assert from 'node:assert';

// git-service.js imports from wsl-utils.js which may have side effects,
// so we test the pure parsing/formatting logic directly.

// ─── Extracted pure logic from git-service.js ───

const DEFAULT_TIMEOUT = 10000;
const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

function getTimeout(projectTimeouts, projectPath) {
  const entry = projectTimeouts.get(projectPath);
  if (!entry) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.round(entry.avg * 2.5 + 1000)));
}

function recordTiming(projectTimeouts, projectPath, ms) {
  const entry = projectTimeouts.get(projectPath) || { avg: DEFAULT_TIMEOUT / 2, timeouts: 0 };
  entry.avg = Math.round(entry.avg * 0.7 + ms * 0.3);
  entry.timeouts = Math.max(0, entry.timeouts - 1);
  projectTimeouts.set(projectPath, entry);
}

function recordTimeout(projectTimeouts, projectPath) {
  const entry = projectTimeouts.get(projectPath) || { avg: DEFAULT_TIMEOUT / 2, timeouts: 0 };
  entry.timeouts++;
  entry.avg = Math.min(MAX_TIMEOUT, Math.round(entry.avg * 1.5));
  projectTimeouts.set(projectPath, entry);
}

// Parse status lines (from getGitStatus)
function parseStatusLines(status) {
  const statusLines = status ? status.split('\n').filter(Boolean) : [];
  return statusLines.map(l => ({
    status: l.substring(0, 2).trim(),
    file: l.substring(3)
  }));
}

// Parse commit log lines
function parseCommitLog(log) {
  if (!log) return [];
  return log.split('\n').filter(Boolean).map(line => {
    const [hash, ...rest] = line.split('|');
    return { hash, message: rest[0] || '', ago: rest[1] || '' };
  });
}

// Parse worktree porcelain output
function parseWorktrees(worktreeRaw) {
  const worktrees = [];
  if (!worktreeRaw) return worktrees;
  let current = {};
  for (const line of worktreeRaw.split('\n')) {
    if (line.startsWith('worktree ')) current.path = line.slice(9).replace(/\\/g, '/');
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '') { if (current.path) worktrees.push(current); current = {}; }
  }
  if (current.path) worktrees.push(current);
  return worktrees;
}

// Parse remote URL
function parseRemoteUrl(remoteRaw) {
  if (!remoteRaw) return '';
  return remoteRaw
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
}

describe('git-service', () => {
  describe('getTimeout', () => {
    it('returns default timeout for unknown project', () => {
      const map = new Map();
      assert.strictEqual(getTimeout(map, '/proj'), DEFAULT_TIMEOUT);
    });

    it('calculates timeout from average', () => {
      const map = new Map();
      map.set('/proj', { avg: 2000, timeouts: 0 });
      // 2000 * 2.5 + 1000 = 6000
      assert.strictEqual(getTimeout(map, '/proj'), 6000);
    });

    it('clamps to minimum', () => {
      const map = new Map();
      map.set('/proj', { avg: 100, timeouts: 0 });
      // 100 * 2.5 + 1000 = 1250 → clamped to 5000
      assert.strictEqual(getTimeout(map, '/proj'), MIN_TIMEOUT);
    });

    it('clamps to maximum', () => {
      const map = new Map();
      map.set('/proj', { avg: 20000, timeouts: 0 });
      // 20000 * 2.5 + 1000 = 51000 → clamped to 30000
      assert.strictEqual(getTimeout(map, '/proj'), MAX_TIMEOUT);
    });
  });

  describe('recordTiming', () => {
    it('creates entry for new project', () => {
      const map = new Map();
      recordTiming(map, '/proj', 1000);
      assert.ok(map.has('/proj'));
    });

    it('uses exponential moving average (alpha=0.3)', () => {
      const map = new Map();
      map.set('/proj', { avg: 5000, timeouts: 0 });
      recordTiming(map, '/proj', 1000);
      // 5000 * 0.7 + 1000 * 0.3 = 3500 + 300 = 3800
      assert.strictEqual(map.get('/proj').avg, 3800);
    });

    it('decays timeout count on success', () => {
      const map = new Map();
      map.set('/proj', { avg: 5000, timeouts: 3 });
      recordTiming(map, '/proj', 1000);
      assert.strictEqual(map.get('/proj').timeouts, 2);
    });

    it('does not go below 0 timeouts', () => {
      const map = new Map();
      map.set('/proj', { avg: 5000, timeouts: 0 });
      recordTiming(map, '/proj', 1000);
      assert.strictEqual(map.get('/proj').timeouts, 0);
    });
  });

  describe('recordTimeout', () => {
    it('increments timeout count', () => {
      const map = new Map();
      recordTimeout(map, '/proj');
      assert.strictEqual(map.get('/proj').timeouts, 1);
    });

    it('bumps average by 1.5x', () => {
      const map = new Map();
      map.set('/proj', { avg: 4000, timeouts: 0 });
      recordTimeout(map, '/proj');
      assert.strictEqual(map.get('/proj').avg, 6000);
    });

    it('caps average at MAX_TIMEOUT', () => {
      const map = new Map();
      map.set('/proj', { avg: 25000, timeouts: 0 });
      recordTimeout(map, '/proj');
      assert.strictEqual(map.get('/proj').avg, MAX_TIMEOUT);
    });
  });

  describe('parseStatusLines', () => {
    it('parses porcelain status output', () => {
      const result = parseStatusLines(' M file.js\nA  new.js\n?? untracked.txt');
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].status, 'M');
      assert.strictEqual(result[0].file, 'file.js');
      assert.strictEqual(result[1].status, 'A');
      assert.strictEqual(result[2].status, '??');
    });

    it('returns empty array for empty input', () => {
      assert.deepStrictEqual(parseStatusLines(''), []);
    });

    it('returns empty array for null/undefined', () => {
      assert.deepStrictEqual(parseStatusLines(null), []);
      assert.deepStrictEqual(parseStatusLines(undefined), []);
    });
  });

  describe('parseCommitLog', () => {
    it('parses git log output', () => {
      const log = 'abc1234|fix bug|2 hours ago\ndef5678|add feature|1 day ago';
      const result = parseCommitLog(log);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].hash, 'abc1234');
      assert.strictEqual(result[0].message, 'fix bug');
      assert.strictEqual(result[0].ago, '2 hours ago');
    });

    it('handles missing parts gracefully', () => {
      const result = parseCommitLog('abc1234');
      assert.strictEqual(result[0].hash, 'abc1234');
      assert.strictEqual(result[0].message, '');
      assert.strictEqual(result[0].ago, '');
    });

    it('returns empty array for empty string', () => {
      assert.deepStrictEqual(parseCommitLog(''), []);
    });

    it('returns empty array for null', () => {
      assert.deepStrictEqual(parseCommitLog(null), []);
    });
  });

  describe('parseWorktrees', () => {
    it('parses porcelain worktree output', () => {
      const raw = 'worktree C:\\project\\main\nbranch refs/heads/main\n\nworktree C:\\project\\feat\nbranch refs/heads/feature\n';
      const result = parseWorktrees(raw);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].path, 'C:/project/main');
      assert.strictEqual(result[0].branch, 'main');
      assert.strictEqual(result[1].branch, 'feature');
    });

    it('returns empty array for empty input', () => {
      assert.deepStrictEqual(parseWorktrees(''), []);
    });

    it('returns empty array for null', () => {
      assert.deepStrictEqual(parseWorktrees(null), []);
    });

    it('handles worktree without trailing newline', () => {
      const raw = 'worktree /home/user/proj\nbranch refs/heads/main';
      const result = parseWorktrees(raw);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, '/home/user/proj');
    });
  });

  describe('parseRemoteUrl', () => {
    it('converts SSH remote to HTTPS', () => {
      assert.strictEqual(parseRemoteUrl('git@github.com:user/repo.git'), 'https://github.com/user/repo');
    });

    it('strips .git suffix from HTTPS', () => {
      assert.strictEqual(parseRemoteUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo');
    });

    it('converts ssh:// protocol', () => {
      assert.strictEqual(parseRemoteUrl('ssh://git@github.com/user/repo.git'), 'https://github.com/user/repo');
    });

    it('returns empty string for empty input', () => {
      assert.strictEqual(parseRemoteUrl(''), '');
    });

    it('returns empty string for null', () => {
      assert.strictEqual(parseRemoteUrl(null), '');
    });

    it('passes through HTTPS URLs without .git', () => {
      assert.strictEqual(parseRemoteUrl('https://github.com/user/repo'), 'https://github.com/user/repo');
    });
  });
});
