export function getAgentKind(command, text) {
  const value = `${command} ${text}`.toLowerCase();
  if (/\bcodex\b/.test(value)) return 'Codex';
  if (/\bclaude\b/.test(value)) return 'Claude';
  return null;
}

export function getAgentState({ exited, lastOutputAt, output, projectState, now = Date.now() }) {
  if (exited) return 'done';
  if (/\b(approve|permission|confirm|continue\?|waiting for input)\b/i.test(output)) return 'waiting';
  if (now - (lastOutputAt || 0) < 4000) return 'busy';
  return projectState === 'busy' || projectState === 'waiting' ? projectState : 'idle';
}

export function getAgentAttention(decisions, projectPath, now = Date.now()) {
  const root = String(projectPath || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  if (!root) return null;
  const latest = [...decisions].reverse().find(d => {
    const cwd = String(d.cwd || '').replace(/\\/g, '/').toLowerCase();
    const ts = new Date(d.ts).getTime();
    return (cwd === root || cwd.startsWith(`${root}/`))
      && Number.isFinite(ts) && now - ts < 10 * 60_000;
  });
  return latest && ['ask', 'block', 'deny'].includes(latest.decision) ? latest : null;
}

export function getAgentAttentionForTerm({ hook, decisions, projectPath, projectAgentCount, now = Date.now() }) {
  if (hook?.state === 'waiting') return { decision: 'ask', reason: hook.reason, ts: hook.updatedAt };
  return projectAgentCount === 1 ? getAgentAttention(decisions, projectPath, now) : null;
}

export function getOperationalState(agentState, gateState, attention) {
  if (attention || (agentState !== 'busy' && gateState === 'hold')) return 'waiting';
  return agentState;
}

export function getWallSummary(agents) {
  return {
    total: agents.length,
    working: agents.filter(agent => agent.state === 'busy').length,
    waiting: agents.filter(agent => agent.state === 'waiting').length,
    hold: agents.filter(agent => agent.gate.state === 'hold').length,
    ready: agents.filter(agent => agent.gate.state === 'ready').length,
  };
}

export function getReleaseGate({ git, prs = [], runs, attention }) {
  if (attention) return { state: 'hold', label: 'HOLD', reason: attention.decision === 'ask' ? 'Approval needed' : 'Blocked by policy', target: 'terminal' };
  if (!git) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'Git status unavailable', target: 'changes' };
  if (git.uncommittedCount) return { state: 'hold', label: 'HOLD', reason: `${git.uncommittedCount} uncommitted changes`, target: 'changes' };

  const head = git.recentCommits?.[0]?.hash;
  if (!head || !Array.isArray(runs)) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'CI status unavailable', target: 'cicd' };
  const sameCommit = runs.filter(r => r.headBranch === git.branch && r.headSha && (r.headSha.startsWith(head) || head.startsWith(r.headSha)));
  if (!sameCommit.length) return { state: 'unknown', label: 'NO EVIDENCE', reason: 'No CI run for current commit', target: 'cicd' };

  const latestByWorkflow = [...sameCommit]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter((run, i, all) => all.findIndex(x => (x.workflowName || x.name) === (run.workflowName || run.name)) === i);
  if (latestByWorkflow.some(r => r.status === 'queued' || r.status === 'in_progress')) return { state: 'checking', label: 'CHECKING', reason: 'CI is running', target: 'cicd' };
  if (latestByWorkflow.some(r => r.conclusion !== 'success')) return { state: 'hold', label: 'HOLD', reason: 'Current commit CI did not pass', target: 'cicd' };

  const pr = prs.find(p => p.branch === git.branch && p.state === 'OPEN');
  if (pr?.isDraft) return { state: 'hold', label: 'HOLD', reason: 'Pull request is draft', target: 'pr' };
  if (pr?.mergeable === 'CONFLICTING') return { state: 'hold', label: 'HOLD', reason: 'Pull request has conflicts', target: 'pr' };
  if (pr?.reviewDecision !== undefined && pr.reviewDecision !== 'APPROVED') return { state: 'hold', label: 'HOLD', reason: pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review pending', target: 'pr' };
  if (pr?.checks?.some(c => !['SUCCESS', 'success'].includes(c.conclusion))) return { state: 'hold', label: 'HOLD', reason: 'Pull request checks did not pass', target: 'pr' };
  return { state: 'ready', label: 'READY', reason: pr ? 'Clean, reviewed, current commit CI passed' : 'Clean, current commit CI passed', target: 'cicd' };
}
