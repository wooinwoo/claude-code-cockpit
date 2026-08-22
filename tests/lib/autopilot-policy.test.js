import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classify, isAutoRunnable } from '../../lib/autopilot-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECISIONS = join(__dirname, '..', '..', 'logs', 'decisions.jsonl');

describe('classify — units', () => {
  const cases = [
    // safe → auto
    ['Read', {}, 'auto'],
    ['Grep', { pattern: 'x' }, 'auto'],
    ['TaskUpdate', {}, 'auto'],
    ['Bash', { command: 'ls -la' }, 'auto'],
    ['Bash', { command: 'git status' }, 'auto'],
    ['Bash', { command: 'npm test' }, 'auto'],
    ['Edit', { file_path: '/home/u/proj/src/app.js' }, 'auto'],
    ['mcp__playwright__browser_navigate', { url: 'http://localhost:3000' }, 'auto'],
    // production / cloud → escalate
    ['Bash', { command: 'aws s3api delete-bucket --bucket example-prod' }, 'escalate'],
    ['Bash', { command: 'aws s3 rm s3://biz.example --recursive' }, 'escalate'],
    ['Bash', { command: 'aws cloudformation delete-stack --stack-name prod' }, 'escalate'],
    ['Bash', { command: 'aws ec2 start-instances --instance-ids i-0abc' }, 'escalate'],
    ['Bash', { command: 'aws rds modify-db-cluster-parameter-group --name x' }, 'escalate'],
    ['Bash', { command: 'git push origin HEAD:prod' }, 'escalate'],
    ['Bash', { command: 'NODE_ENV=production npm run deploy' }, 'escalate'],
    ['Bash', { command: 'npx drizzle-kit migrate --to=production' }, 'escalate'],
    ['Bash', { command: "MYSQL_PWD='x' mysql -h 10.0.0.1 -P 3306 -u admin db" }, 'escalate'],
    ['Bash', { command: 'kubectl delete pod api-7f9' }, 'escalate'],
    ['Bash', { command: 'terraform destroy -auto-approve' }, 'escalate'],
    ['Edit', { file_path: '/home/u/.claude/settings.json' }, 'escalate'],
    // destructive / secret → block
    ['Bash', { command: 'rm -rf / --no-preserve-root' }, 'block'],
    ['Bash', { command: 'sudo rm /tmp/foo' }, 'block'],
    ['Bash', { command: 'npm publish --access public' }, 'block'],
    ['Bash', { command: 'git push --force origin main' }, 'block'],
    ['Edit', { file_path: '/etc/passwd' }, 'block'],
    ['Write', { file_path: '/home/u/.ssh/authorized_keys' }, 'block'],
    ['Edit', { file_path: '/home/u/proj/.env' }, 'block'],
    // unknown → review
    ['Bash', { command: 'git pull' }, 'review'],
    ['Bash', { command: 'some-unknown-binary --do-thing' }, 'review'],
  ];
  for (const [tool, input, expected] of cases) {
    it(`${tool}: ${(input.command || input.file_path || tool).slice(0, 48)} → ${expected}`, () => {
      assert.strictEqual(classify(tool, input).action, expected);
    });
  }

  it('only "auto" is auto-runnable', () => {
    assert.ok(isAutoRunnable('auto'));
    for (const a of ['escalate', 'block', 'review']) assert.ok(!isAutoRunnable(a));
  });
});

// Replay against the real 5,096-decision log. Local-only (gitignored — contains
// production infra names / secrets), so skip gracefully when absent.
describe('replay — 5,096 historical decisions', () => {
  const run = existsSync(DECISIONS) ? it : it.skip;

  // A conservatively-defined "genuinely dangerous" signature: if any of these ever
  // slips through to auto, the autopilot could destroy production unattended.
  // Match real destructive execution, not the word "sudo" mentioned inside an echo string.
  const DANGER_SIG = /\brm\s+-rf?\s+[/~]|\bsudo\s+(rm|chmod|chown|dd|mkfs|systemctl|service|reboot|shutdown)\b|\bnpm\s+(un)?publish\b|\bgit\s+push\s+(--force|-f)\b|\baws\s+\S+\s+(delete|terminate|rm|modify)|\bs3\s+rm\b|delete-bucket|delete-stack|NODE_ENV=production|--to=production|\bMYSQL_PWD=|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bDROP\s+(TABLE|DATABASE)/i;

  function load() {
    const rows = [];
    for (const line of readFileSync(DECISIONS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return rows;
  }

  run('no historically-dangerous command is classified auto (0 false-negatives)', () => {
    const rows = load();
    const leaks = [];
    for (const r of rows) {
      const cmd = r.input?.command || r.input?.file_path || '';
      const dangerous = DANGER_SIG.test(cmd) || r.decision === 'block';
      if (!dangerous) continue;
      const action = classify(r.tool, r.input || {}).action;
      if (action === 'auto') leaks.push({ tool: r.tool, action, snippet: cmd.slice(0, 60) });
    }
    assert.strictEqual(leaks.length, 0, `${leaks.length} dangerous ops leaked to auto: ${JSON.stringify(leaks.slice(0, 3))}`);
  });

  run('deterministic auto-rate beats the old safelist baseline (≥51%)', () => {
    // A pure-rules policy can't match the old 47% LLM tier — the rest go to 'review'
    // (LLM or, unattended, escalate). The win is resolving MORE than safelist alone
    // (2,609/5,096 ≈ 51%) with zero LLM cost and zero danger leaks.
    const rows = load().filter((r) => r.decision === 'approve');
    let auto = 0;
    for (const r of rows) if (classify(r.tool, r.input || {}).action === 'auto') auto++;
    const rate = auto / rows.length;
    assert.ok(rate >= 0.51, `deterministic auto rate ${(rate * 100).toFixed(1)}% < 51% baseline`);
  });

  run('catches most escalations deterministically (no LLM needed)', () => {
    const rows = load().filter((r) => ['ask', 'deny', 'block'].includes(r.decision));
    let caught = 0;
    for (const r of rows) {
      const a = classify(r.tool, r.input || {}).action;
      if (a === 'escalate' || a === 'block') caught++;
    }
    // Informational threshold — most historical non-approvals should be caught by rules.
    const rate = caught / rows.length;
    assert.ok(rate >= 0.5, `deterministic catch rate ${(rate * 100).toFixed(1)}% < 50%`);
  });
});
