import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWslPath, toWinPath } from './wsl-utils.js';

const execFileAsync = promisify(execFile);

export async function getGitHubPRs(project) {
  try {
    const wsl = parseWslPath(project.path);

    let result;
    if (wsl) {
      // gh CLI inside WSL
      result = await execFileAsync('wsl', [
        '-d', wsl.distro, '--cd', wsl.linuxPath,
        'gh', 'pr', 'list', '--json', 'number,title,state,headRefName,author,updatedAt,reviewDecision,isDraft', '--limit', '5'
      ], { cwd: process.env.SYSTEMROOT || 'C:\\Windows', timeout: 15000 });
    } else {
      result = await execFileAsync('gh', [
        'pr', 'list', '--json', 'number,title,state,headRefName,author,updatedAt,reviewDecision,isDraft', '--limit', '5'
      ], { cwd: toWinPath(project.path), timeout: 15000 });
    }

    const prs = JSON.parse(result.stdout || '[]');
    return {
      projectId: project.id,
      prs: prs.map(pr => ({
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        author: pr.author?.login || 'unknown',
        updatedAt: pr.updatedAt,
        reviewDecision: pr.reviewDecision || 'PENDING',
        isDraft: pr.isDraft
      }))
    };
  } catch (err) {
    console.warn(`[GitHub] Failed to fetch PRs for ${project.name}:`, err.message);
    return { projectId: project.id, prs: [] };
  }
}
