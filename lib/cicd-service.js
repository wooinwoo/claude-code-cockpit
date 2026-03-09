// ─── CI/CD Service: GitHub Actions via gh CLI ───
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWslPath, toWinPath } from './wsl-utils.js';
import { IS_WIN } from './platform.js';

const execFileAsync = promisify(execFile);

// Cache
const _cache = new Map();
const CACHE_TTL = 60_000; // 1 min

function cached(key, fn) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return Promise.resolve(e.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

export function clearCache() { _cache.clear(); }

async function gh(args, cwd) {
  const opts = { timeout: 30_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true };
  try {
    const wsl = parseWslPath(cwd);
    if (wsl) {
      const { stdout } = await execFileAsync('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'gh', ...args], {
        ...opts, cwd: process.env.SYSTEMROOT || 'C:\\Windows'
      });
      return stdout.trim();
    }
    const { stdout } = await execFileAsync('gh', args, { ...opts, cwd: IS_WIN ? toWinPath(cwd) : cwd });
    return stdout.trim();
  } catch (err) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

// ─── Workflow Runs ───
export async function getWorkflowRuns(projectPath, { workflow, status, limit = 30 } = {}) {
  const args = ['run', 'list', '--json', 'databaseId,name,displayTitle,headBranch,status,conclusion,event,createdAt,updatedAt,url,workflowName', '-L', String(limit)];
  if (workflow) args.push('-w', workflow);
  if (status) args.push('-s', status);
  return cached(`runs:${projectPath}:${workflow || ''}:${status || ''}`, async () => {
    const raw = await gh(args, projectPath);
    if (!raw) return [];
    return JSON.parse(raw);
  });
}

// ─── Single Run Detail ───
export async function getRunDetail(projectPath, runId) {
  const raw = await gh(['run', 'view', String(runId), '--json', 'databaseId,name,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,updatedAt,url,workflowName,jobs'], projectPath);
  return JSON.parse(raw);
}

// ─── Run Jobs ───
export async function getRunJobs(projectPath, runId) {
  const raw = await gh(['run', 'view', String(runId), '--json', 'jobs'], projectPath);
  const data = JSON.parse(raw);
  return data.jobs || [];
}

// ─── Run Logs ───
export async function getRunLogs(projectPath, runId) {
  try {
    const raw = await gh(['run', 'view', String(runId), '--log'], projectPath);
    return raw;
  } catch {
    return '(No logs available)';
  }
}

// ─── Rerun ───
export async function rerunWorkflow(projectPath, runId, { failed = false } = {}) {
  const args = ['run', 'rerun', String(runId)];
  if (failed) args.push('--failed');
  await gh(args, projectPath);
  _cache.delete(`runs:${projectPath}:`);
  return { success: true };
}

// ─── Cancel ───
export async function cancelRun(projectPath, runId) {
  await gh(['run', 'cancel', String(runId)], projectPath);
  _cache.delete(`runs:${projectPath}:`);
  return { success: true };
}

// ─── List Workflows ───
export async function getWorkflows(projectPath) {
  return cached(`workflows:${projectPath}`, async () => {
    const raw = await gh(['workflow', 'list', '--json', 'id,name,state'], projectPath);
    if (!raw) return [];
    return JSON.parse(raw);
  });
}
