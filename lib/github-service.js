import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWslPath, toWinPath } from './wsl-utils.js';
import { IS_WIN } from './platform.js';

const execFileAsync = promisify(execFile);

const PR_LIST_FIELDS = 'number,title,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup';

function ghExec(project, args, timeout = 15000) {
  const wsl = parseWslPath(project.path);
  if (wsl) {
    return execFileAsync('wsl', ['-d', wsl.distro, '--cd', wsl.linuxPath, 'gh', ...args],
      { cwd: process.env.SYSTEMROOT || 'C:\\Windows', timeout });
  }
  return execFileAsync('gh', args, { cwd: IS_WIN ? toWinPath(project.path) : project.path, timeout });
}

function mapPR(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    author: pr.author?.login || 'unknown',
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
    reviewDecision: pr.reviewDecision || 'PENDING',
    isDraft: pr.isDraft,
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changedFiles: pr.changedFiles || 0,
    labels: (pr.labels || []).map(l => l.name || l),
    url: pr.url,
    mergeable: pr.mergeable,
    checks: (pr.statusCheckRollup || []).map(c => ({
      name: c.name || c.context,
      status: c.status || c.state,
      conclusion: c.conclusion,
    })),
  };
}

export async function getGitHubPRs(project, state = 'open') {
  try {
    const args = ['pr', 'list', '--json', PR_LIST_FIELDS, '--limit', '20'];
    if (state === 'all') args.push('--state', 'all');
    else if (state === 'merged') args.push('--state', 'merged');
    else if (state === 'closed') args.push('--state', 'closed');
    const result = await ghExec(project, args);
    const prs = JSON.parse(result.stdout || '[]');
    return { projectId: project.id, prs: prs.map(mapPR) };
  } catch (err) {
    console.warn(`[GitHub] Failed to fetch PRs for ${project.name}:`, err.message);
    return { projectId: project.id, prs: [] };
  }
}

export async function getGitHubPRDetail(project, prNumber) {
  const result = await ghExec(project, [
    'pr', 'view', String(prNumber), '--json',
    'number,title,body,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup,reviews,comments,files,commits'
  ], 20000);
  const pr = JSON.parse(result.stdout || '{}');
  return {
    ...mapPR(pr),
    body: pr.body || '',
    reviews: (pr.reviews || []).map(r => ({
      author: r.author?.login || 'unknown',
      state: r.state,
      body: r.body || '',
      submittedAt: r.submittedAt,
    })),
    comments: (pr.comments || []).map(c => ({
      author: c.author?.login || 'unknown',
      body: c.body || '',
      createdAt: c.createdAt,
    })),
    files: (pr.files || []).map(f => ({
      path: f.path,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    })),
    commits: (pr.commits || []).length,
  };
}

export async function getPRDiff(project, prNumber) {
  const result = await ghExec(project, ['pr', 'diff', String(prNumber)], 30000);
  return result.stdout || '';
}

export async function approvePR(project, prNumber, body) {
  await ghExec(project, ['pr', 'review', String(prNumber), '--approve', ...(body ? ['--body', body] : [])]);
  return { ok: true };
}

export async function requestChangesPR(project, prNumber, body) {
  await ghExec(project, ['pr', 'review', String(prNumber), '--request-changes', '--body', body || 'Changes requested']);
  return { ok: true };
}

export async function commentPR(project, prNumber, body) {
  await ghExec(project, ['pr', 'comment', String(prNumber), '--body', body]);
  return { ok: true };
}

export async function mergePR(project, prNumber, method = 'squash') {
  const flag = method === 'rebase' ? '--rebase' : method === 'merge' ? '--merge' : '--squash';
  await ghExec(project, ['pr', 'merge', String(prNumber), flag, '--delete-branch']);
  return { ok: true };
}
