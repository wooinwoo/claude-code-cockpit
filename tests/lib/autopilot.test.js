import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { init, decide, setMode, getStatus, resetSession, buildBriefing } from '../../lib/autopilot.js';

const bash = (command) => ({ tool: 'Bash', input: { command } });

describe('autopilot engine', () => {
  beforeEach(() => { resetSession(); });

  it('auto action → approve without asking', async () => {
    let asked = false;
    init({ askHuman: async () => { asked = true; return 'approve'; }, mode: 'unattended' });
    const r = await decide(bash('ls -la'));
    assert.strictEqual(r.decision, 'approve');
    assert.strictEqual(r.action, 'auto');
    assert.strictEqual(asked, false);
  });

  it('block action → deny without asking', async () => {
    let asked = false;
    init({ askHuman: async () => { asked = true; return 'approve'; }, mode: 'unattended' });
    const r = await decide(bash('rm -rf / --no-preserve-root'));
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(asked, false);
  });

  it('escalate + human approves → approve', async () => {
    init({ askHuman: async () => 'approve', mode: 'unattended' });
    const r = await decide(bash('aws s3api delete-bucket --bucket prod'));
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.decision, 'approve');
  });

  it('escalate + human denies → deny', async () => {
    init({ askHuman: async () => 'deny', mode: 'unattended' });
    const r = await decide(bash('git push origin HEAD:prod'));
    assert.strictEqual(r.decision, 'deny');
  });

  it('escalate + human channel throws/times out → deny (fail safe)', async () => {
    init({ askHuman: async () => { throw new Error('timeout'); }, mode: 'unattended' });
    const r = await decide(bash('terraform destroy -auto-approve'));
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(getStatus().metrics.timedOut, 1);
  });

  it('review in attended mode → ask (hand back to Claude Code prompt)', async () => {
    init({ askHuman: async () => 'approve', mode: 'attended' });
    const r = await decide(bash('git pull'));
    assert.strictEqual(r.action, 'review');
    assert.strictEqual(r.decision, 'ask');
  });

  it('review in unattended mode → escalates to phone', async () => {
    let asked = false;
    init({ askHuman: async () => { asked = true; return 'approve'; } });
    setMode('unattended');
    const r = await decide(bash('git pull'));
    assert.strictEqual(r.action, 'review');
    assert.strictEqual(asked, true);
    assert.strictEqual(r.decision, 'approve');
  });

  it('unattended escalate with no channel → deny (fail safe)', async () => {
    init({ askHuman: null, mode: 'unattended' });
    const r = await decide(bash('aws ec2 terminate-instances --instance-ids i-0'));
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.decision, 'deny');
  });

  it('attended escalate with no channel → ask (hand to screen)', async () => {
    init({ askHuman: null, mode: 'attended' });
    const r = await decide(bash('aws s3api delete-bucket --bucket x'));
    assert.strictEqual(r.decision, 'ask');
  });

  it('tracks metrics and builds a briefing', async () => {
    resetSession();
    init({ askHuman: async () => 'deny', mode: 'unattended' });
    await decide(bash('ls'));                                   // auto
    await decide(bash('npm test'));                             // auto
    await decide(bash('rm -rf /'));                             // block
    await decide(bash('aws s3 rm s3://x --recursive'));         // escalate → deny
    const m = getStatus().metrics;
    assert.strictEqual(m.auto, 2);
    assert.strictEqual(m.block, 1);
    assert.strictEqual(m.asked, 1);
    assert.strictEqual(m.denied, 1);
    const b = buildBriefing();
    assert.strictEqual(b.ran, 2);
    assert.strictEqual(b.blocked, 1);
    assert.ok(b.summary.includes('오토파일럿 브리핑'));
    assert.ok(b.notable.length >= 2); // block + escalate recorded
  });
});
