import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveWorkerLimit, _test } from '../../lib/hermes-runtime.js';

describe('HermesRuntime helpers', () => {
  it('extracts the last JSON line from Hermes output', () => {
    assert.deepEqual(_test.parseLastJson('notice\n{"ok":true,"spawned":2}\n'), { ok: true, spawned: 2 });
  });

  it('extracts a durable Hermes session ID without leaking it into chat output', () => {
    assert.deepEqual(
      _test.parseChatOutput('session_id: 20260822_171703_6cf842\nPROJECT_READY\n'),
      { sessionId: '20260822_171703_6cf842', output: 'PROJECT_READY' },
    );
    assert.deepEqual(
      _test.parseChatOutput('OWNER_CONSOLE_READY\nSESSION_ID=93890\n'),
      { sessionId: '93890', output: 'OWNER_CONSOLE_READY' },
    );
  });

  it('rejects identifiers that could become CLI option injection', () => {
    assert.throws(() => _test.assertSafeId('--profile', 'profile'), /Invalid profile/);
    assert.doesNotThrow(() => _test.assertSafeId('project-director-1', 'profile'));
  });

  it('adapts parallelism to ready work and available resources', () => {
    assert.equal(adaptiveWorkerLimit({ ready: 0, cpuCount: 16, memoryBytes: 64 * 1024 ** 3 }), 0);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 0, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 6);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 5, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 1);
    assert.equal(adaptiveWorkerLimit({ ready: 20, running: 20, cpuCount: 8, memoryBytes: 64 * 1024 ** 3 }), 0);
  });

  it('strips inherited remote surfaces from Hermes child environments', () => {
    const env = _test.localOnlyEnv({
      PATH: 'safe',
      TELEGRAM_BOT_TOKEN: 'secret',
      GATEWAY_PROXY_URL: 'https://remote.invalid',
      API_SERVER_ENABLED: 'true',
      WHATSAPP_ENABLED: 'true',
    });
    assert.equal(env.PATH, 'safe');
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.GATEWAY_PROXY_URL, undefined);
    assert.equal(env.API_SERVER_ENABLED, 'false');
    assert.equal(env.WHATSAPP_ENABLED, 'false');
  });

  it('derives the narrow Hermes data root used for board sandbox access', () => {
    assert.equal(
      _test.hermesRootFromExecutable('C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'),
      'C:\\Users\\owner\\AppData\\Local\\hermes',
    );
    assert.equal(
      _test.hermesRootFromExecutable('C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\bin\\hermes.exe'),
      'C:\\Users\\owner\\AppData\\Local\\hermes',
    );
  });

  it('rejects a zero-exit Hermes turn that produced no Director answer', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    const { HermesRuntime } = await import('../../lib/hermes-runtime.js');
    const runtime = new HermesRuntime({ spawnImpl: () => {
      queueMicrotask(() => fakeChild.emit('close', 0, null));
      return fakeChild;
    } });
    await assert.rejects(
      runtime.chat({ profile: 'project-director-1', cwd: 'C:\\projects\\alpha', board: 'alpha', prompt: 'work' }),
      /returned no output/,
    );
  });

  it('pins the nested Codex app-server thread to the selected project', async () => {
    const fakeChild = new (await import('node:events')).EventEmitter();
    fakeChild.stdout = new (await import('node:stream')).PassThrough();
    fakeChild.stderr = new (await import('node:stream')).PassThrough();
    fakeChild.stdin = new (await import('node:stream')).PassThrough();
    fakeChild.kill = () => {};
    let spawnOptions;
    const { HermesRuntime } = await import('../../lib/hermes-runtime.js');
    const runtime = new HermesRuntime({
      hermesBin: 'C:\\Users\\owner\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
      spawnImpl: (_command, _args, options) => {
        spawnOptions = options;
        queueMicrotask(() => fakeChild.emit('close', 0, null));
        return fakeChild;
      },
    });

    await runtime.run(['--version'], { cwd: 'C:\\projects\\alpha', board: 'alpha' });

    assert.equal(spawnOptions.cwd, 'C:\\projects\\alpha');
    assert.equal(spawnOptions.env.TERMINAL_CWD, 'C:\\projects\\alpha');
    assert.equal(spawnOptions.env.PRAETORIUM_PROJECT_CWD, 'C:\\projects\\alpha');
  });
});
