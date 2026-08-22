import { spawn } from 'node:child_process';
import { cpus, homedir, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const REMOTE_ENV_PREFIX = /^(?:API_SERVER_|WEBHOOK_|GATEWAY_|RELAY_|TELEGRAM_|DISCORD_|SLACK_|WHATSAPP_|MATRIX_|MATTERMOST_|SIGNAL_|IMESSAGE_|EMAIL_|QQ_|LINE_|DINGTALK_|WECOM_|MSTEAMS_|MS_TEAMS_)/i;

function assertSafeId(value, label) {
  if (!SAFE_ID.test(value || '')) throw new Error(`Invalid ${label}`);
}

function parseLastJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Hermes may print a short preamble. */ }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

function parseChatOutput(text) {
  let sessionId = null;
  const output = String(text || '').split(/\r?\n/).filter(line => {
    const match = line.trim().match(/^(?:session_id:\s*|SESSION_ID=)([a-z0-9_-]+)$/i);
    if (!match) return true;
    sessionId = match[1];
    return false;
  }).join('\n').trim();
  return { sessionId, output };
}

function localOnlyEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !REMOTE_ENV_PREFIX.test(key)));
  return {
    ...env,
    API_SERVER_ENABLED: 'false',
    WEBHOOK_ENABLED: 'false',
    GATEWAY_ALLOW_ALL_USERS: 'false',
    WHATSAPP_ENABLED: 'false',
  };
}

function hermesRootFromExecutable(executable) {
  const executableDir = dirname(resolve(executable));
  const container = basename(executableDir).toLowerCase();
  if (container === 'scripts') return resolve(executableDir, '..', '..', '..');
  if (container === 'bin') return resolve(executableDir, '..', '..');
  throw new Error('Hermes executable must be inside hermes-agent/venv/Scripts or hermes-agent/bin');
}

export function adaptiveWorkerLimit({ ready = 0, running = 0, cpuCount = cpus().length, memoryBytes = totalmem() } = {}) {
  if (ready <= 0) return 0;
  const cpuBudget = Math.max(2, Math.floor(Math.max(1, cpuCount) * 0.75));
  const memoryBudget = Math.max(2, Math.floor(memoryBytes / (3 * 1024 ** 3)));
  const capacity = Math.max(0, Math.min(12, cpuBudget, memoryBudget) - Math.max(0, running));
  return Math.min(ready, capacity);
}

export class HermesRuntime {
  constructor({
    hermesBin = process.env.HERMES_BIN || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'hermes-agent', 'bin', 'hermes.exe'),
    spawnImpl = spawn,
    timeoutMs = 90 * 60 * 1000,
  } = {}) {
    this.hermesBin = hermesBin;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }

  run(args, { cwd, board, input = null, timeoutMs = this.timeoutMs, onOutput = null } = {}) {
    if (!Array.isArray(args) || !args.length) return Promise.reject(new Error('Hermes arguments are required'));
    if (cwd && !isAbsolute(cwd)) return Promise.reject(new Error('Hermes cwd must be absolute'));

    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.hermesBin, args, {
        cwd: cwd || process.cwd(),
        env: {
          ...localOnlyEnv(),
          // Hermes' `--in` selects skill sources; it does not become the
          // Codex app-server thread cwd. Pin the actual project directory so
          // one Director cannot accidentally receive write scope over every
          // project under C:\projects.
          ...(cwd ? {
            TERMINAL_CWD: cwd,
            // Consumed by the pinned Hermes bridge before Codex app-server
            // creates its thread. This wins over a profile's static
            // terminal.cwd and keeps each Director inside its own project.
            PRAETORIUM_PROJECT_CWD: cwd,
          } : {}),
          ...(board ? {
            HERMES_KANBAN_BOARD: board,
            // Praetorium's pinned Hermes bridge consumes this exact DB path
            // to grant only the active board directory as an additional
            // Codex writable root. No full-access sandbox is used.
            HERMES_KANBAN_DB: join(hermesRootFromExecutable(this.hermesBin), 'kanban', 'boards', board, 'kanban.db').replaceAll('\\', '/'),
          } : {}),
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const append = (channel, chunk) => {
        const text = chunk.toString('utf8');
        if (channel === 'stdout') stdout = (stdout + text).slice(-MAX_CAPTURE_BYTES);
        else stderr = (stderr + text).slice(-MAX_CAPTURE_BYTES);
        onOutput?.({ channel, text });
      };
      child.stdout?.on('data', chunk => append('stdout', chunk));
      child.stderr?.on('data', chunk => append('stderr', chunk));
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim(), json: parseLastJson(stdout) };
        if (code === 0) resolve(result);
        else reject(Object.assign(new Error(stderr.trim() || `Hermes exited with code ${code}`), { result }));
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(Object.assign(new Error(`Hermes timed out after ${timeoutMs}ms`), { code: 'HERMES_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();

      if (input !== null) child.stdin?.end(String(input));
      else child.stdin?.end();
    });
  }

  async chat({ profile, session = null, cwd, board, prompt, onOutput }) {
    assertSafeId(profile, 'profile');
    if (session) assertSafeId(session, 'session');
    if (!String(prompt || '').trim()) return Promise.reject(new Error('Prompt is required'));
    const args = [
      '-p', profile,
      'chat', '--query-file', '-', '--quiet',
      '--in', cwd,
      '--skills', profile === 'skill-director' ? 'skill-director' : 'project-director',
      '--source', 'tool',
      '--max-turns', '500',
      '--run-budget', '5400',
    ];
    if (session) args.push('--resume', session, '--no-restore-cwd');

    // Hermes v0.20.5 can leave the first request to a newly-created named
    // `--continue --create-if-missing` session waiting indefinitely before the
    // model call. Start normally, capture Hermes' real session ID, and resume
    // that ID on later owner messages instead.
    const result = await this.run(args, { cwd, board, input: prompt, onOutput });
    const parsed = parseChatOutput(result.stdout);
    const stderrMeta = parseChatOutput(result.stderr);
    if (!parsed.output) {
      throw Object.assign(new Error('Hermes Director returned no output; the local Codex runtime did not complete a valid turn.'), { result });
    }
    return {
      ...result,
      rawStdout: result.stdout,
      stdout: parsed.output,
      sessionId: parsed.sessionId || stderrMeta.sessionId || session || null,
    };
  }

  kanban({ profile, board, args, cwd, timeoutMs = 120000 }) {
    assertSafeId(profile, 'profile');
    assertSafeId(board, 'board');
    return this.run(['-p', profile, 'kanban', '--board', board, ...args], { cwd, board, timeoutMs });
  }

  async ensureBoard({ profile, board, cwd, name = board }) {
    assertSafeId(profile, 'profile');
    assertSafeId(board, 'board');
    const listed = await this.run(['-p', profile, 'kanban', 'boards', 'list', '--json'], { cwd, timeoutMs: 120000 });
    const boards = Array.isArray(listed.json) ? listed.json : listed.json?.boards || [];
    if (!boards.some(item => (item.slug || item.id) === board)) {
      await this.run([
        '-p', profile, 'kanban', 'boards', 'create', board,
        '--name', String(name).slice(0, 100), '--default-workdir', cwd,
      ], { cwd, timeoutMs: 120000 });
    }
    await this.kanban({ profile, board, cwd, args: ['init'] });
  }

  async listTasks({ profile, board, cwd }) {
    const result = await this.kanban({ profile, board, cwd, args: ['list', '--json'] });
    const payload = result.json;
    if (Array.isArray(payload)) return payload;
    return payload?.tasks || [];
  }

  dispatch({ profile, board, cwd, max }) {
    const limit = Math.max(1, Math.min(12, Number(max) || 1));
    return this.kanban({ profile, board, cwd, args: ['dispatch', '--max', String(limit), '--json'] });
  }

  createObjective({ profile, board, cwd, title, body }) {
    return this.kanban({
      profile,
      board,
      cwd,
      args: [
        'create', String(title).slice(0, 160),
        '--body', String(body || ''),
        '--assignee', profile,
        '--workspace', `dir:${cwd}`,
        '--created-by', 'owner-console',
        '--skill', 'project-director',
        '--goal', '--goal-max-turns', '20',
        '--json',
      ],
    });
  }
}

export const _test = { parseLastJson, parseChatOutput, assertSafeId, localOnlyEnv, hermesRootFromExecutable };
