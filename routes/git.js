import { dirname } from 'node:path';
import { getBranches } from '../lib/git-service.js';

/**
 * Register git operation routes (diff, stage, commit, push, pull, stash, branch).
 * @param {object} ctx - Server context with shared utilities
 * @param {Function} ctx.addRoute - Register an HTTP route: addRoute(method, pattern, handler)
 * @param {Function} ctx.json - Send JSON response: json(res, data, statusCode?)
 * @param {Function} ctx.withProject - Middleware that resolves :id to a project object
 * @param {Function} ctx.readBody - Parse JSON request body: readBody(req) => Promise<object>
 * @param {Function} ctx.rateLimit - Rate-limit check: rateLimit(key, maxPerMin) => boolean
 * @param {Function} ctx.withGitLock - Serialize git operations per project to avoid conflicts
 * @param {Function} ctx.gitExec - Execute a git command in a project directory
 * @param {Function} ctx.toWinPath - Convert forward-slash paths to Windows backslash paths
 * @param {Function} ctx.parseWslPath - Convert WSL paths to Windows paths
 * @param {Function} ctx.spawnForProject - Spawn a child process scoped to a project directory
 * @param {Function} ctx.isValidBranch - Validate a branch name string
 * @param {Function} ctx.isValidStashRef - Validate a stash reference string
 * @param {object} ctx.LIMITS - Shared limit constants (e.g. claudeTimeoutMs)
 * @param {object} ctx.poller - SSE poller for broadcasting events to clients
 * @returns {void}
 */
export function register(ctx) {
  const { addRoute, json, withProject, readBody, rateLimit, withGitLock, gitExec, isValidBranch, isValidStashRef, LIMITS, __dirname, join, spawn, poller } = ctx;

  // ──────────── callClaude — invoke Claude CLI ────────────

  /**
   * callClaude — invoke Claude CLI.
   * @param {string} prompt - User message (stdin)
   * @param {object} opts
   * @param {number} opts.timeoutMs
   * @param {string} opts.model
   * @param {string} opts.systemPrompt - System prompt (separate from user message).
   *   C1: System prompt uses Markdown (no angle brackets), so --system-prompt
   *   works safely on ALL platforms including Windows cmd.exe.
   */
  function callClaude(prompt, { timeoutMs = LIMITS.claudeTimeoutMs, model = 'haiku', systemPrompt } = {}) {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const env = { ...process.env };
      delete env.CLAUDECODE;

      // C2: On Windows, call node + cli.js directly (shell: false) to avoid
      // cmd.exe encoding issues with Korean text and special chars in --system-prompt.
      // With shell: false, Node.js passes args as proper Unicode strings via CreateProcessW.
      let bin, args;
      if (isWin) {
        const nodeExe = process.execPath; // Current node.exe path
        const cliJs = join(dirname(nodeExe), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        bin = nodeExe;
        args = [cliJs, '-p', '--model', model];
      } else {
        bin = 'claude';
        args = ['-p', '--model', model];
      }
      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }
      const child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env
      });
      let stdout = '', stderr = '', done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
        reject(new Error('Claude CLI timed out'));
      }, timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`Failed to run claude CLI: ${err.message}`)); } });
      child.on('close', code => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve(stdout.trim());
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ──────────── Diff ────────────

  addRoute('GET', '/api/projects/:id/diff', withProject(async (req, res, project) => {
    const opts = { timeout: 10000, maxBuffer: 5 * 1024 * 1024 };
    // Parse files + stats directly from diff output (avoids extra git commands)
    const parseDiffFiles = (diffText) => {
      if (!diffText || !diffText.trim()) return [];
      const files = [];
      const chunks = diffText.split(/(?=^diff --git )/m);
      for (const chunk of chunks) {
        if (!chunk.startsWith('diff ')) continue;
        const m = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
        if (!m) continue;
        const file = m[1];
        let status = 'M';
        if (/^new file mode/m.test(chunk)) status = 'A';
        else if (/^deleted file mode/m.test(chunk)) status = 'D';
        else if (/^rename from/m.test(chunk)) status = 'R';
        let additions = 0, deletions = 0;
        for (const line of chunk.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) additions++;
          else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
        }
        files.push({ file, status, additions, deletions });
      }
      return files;
    };
    try {
      const maxLines = 3000;
      const [stagedDiff, unstagedDiff, statusOut] = await Promise.all([
        gitExec(project.path, ['diff', '--cached', '-U3'], opts),
        gitExec(project.path, ['diff', '-U3'], opts),
        gitExec(project.path, ['status', '--porcelain'], opts),
      ]);
      const stagedFiles = parseDiffFiles(stagedDiff.stdout);
      const unstagedFiles = parseDiffFiles(unstagedDiff.stdout);
      // Untracked files (git diff doesn't include them — detect via status)
      const trackedInDiff = new Set([...stagedFiles, ...unstagedFiles].map(f => f.file));
      const statusLines = (statusOut.stdout || '').split('\n').filter(Boolean);
      for (const line of statusLines) {
        const code = line.substring(0, 2);
        const filePath = line.substring(3);
        if (!filePath || trackedInDiff.has(filePath)) continue;
        if (code === '??') {
          // Untracked → show as new file in unstaged
          unstagedFiles.push({ file: filePath, status: '?', additions: 0, deletions: 0 });
        } else if (code.trim() && !trackedInDiff.has(filePath)) {
          // Other statuses missing from diff (e.g. binary, permissions-only)
          const st = code[0] !== ' ' && code[0] !== '?' ? code[0] : code[1];
          unstagedFiles.push({ file: filePath, status: st || 'M', additions: 0, deletions: 0 });
        }
      }
      const truncate = (text) => {
        const lines = text.split('\n');
        if (lines.length <= maxLines) return text;
        return lines.slice(0, maxLines).join('\n') + '\n\n... truncated (' + lines.length + ' total lines) ...';
      };
      json(res, {
        projectId: project.id,
        staged: { diff: truncate(stagedDiff.stdout), files: stagedFiles },
        unstaged: { diff: truncate(unstagedDiff.stdout), files: unstagedFiles }
      });
    } catch {
      json(res, { projectId: project.id, staged: { diff: '', files: [] }, unstaged: { diff: '', files: [] } });
    }
  }));

  // ──────────── Auto Commit (Haiku AI) ────────────

  addRoute('POST', '/api/projects/:id/generate-commit-msg', withProject(async (req, res, project) => {
    const opts = { timeout: 10000, maxBuffer: 5 * 1024 * 1024 };
    const result = await withGitLock(project.id, async () => {
      const [statusOut, diffOut] = await Promise.all([
        gitExec(project.path, ['diff', '--cached', '--stat'], opts),
        gitExec(project.path, ['diff', '--cached', '-U2'], opts),
      ]);
      return { stat: statusOut.stdout.trim(), diff: diffOut.stdout };
    });
    if (!result.stat) return json(res, { error: 'No staged changes' }, 400);
    const diff = result.diff.length > LIMITS.diffMaxChars ? result.diff.slice(0, LIMITS.diffMaxChars) + '\n...(truncated)' : result.diff;
    const commitMsgSystem = `You are a precise git commit message generator. Output ONLY the commit message — no quotes, no markdown fences, no explanation.
Rules:
- Conventional commits: feat:, fix:, refactor:, docs:, style:, chore:, test:
- First line: type(scope): description (max 72 chars)
- Scope = primary module or directory affected
- Describe WHY the change was made, not WHAT changed (the diff shows what)
- If multiple unrelated changes are staged, use the dominant change type
- For complex changes, add a blank line then bullet points for details`;
    const commitMsgUser = `[STAGED_CHANGES]\nStat:\n${result.stat}\n\nDiff:\n${diff}\n[/STAGED_CHANGES]`;
    const message = await callClaude(commitMsgUser, { systemPrompt: commitMsgSystem });
    const clean = message.replace(/^["'`]+|["'`]+$/g, '').replace(/^```\n?|```$/g, '').trim();
    json(res, { message: clean });
  }));

  addRoute('POST', '/api/projects/:id/auto-commit/plan', withProject(async (req, res, project) => {
    if (!rateLimit('autocommit', 5)) return json(res, { error: 'Too many requests — please wait' }, 429);

    const opts = { timeout: 15000, maxBuffer: 5 * 1024 * 1024 };

    const gitResult = await withGitLock(project.id, async () => {
      const [statusOut, stagedDiffOut, unstagedDiffOut] = await Promise.all([
        gitExec(project.path, ['status', '--porcelain'], opts),
        gitExec(project.path, ['diff', '--cached', '-U2'], opts),
        gitExec(project.path, ['diff', '-U2'], opts),
      ]);
      return { status: statusOut.stdout.trim(), stagedDiff: stagedDiffOut.stdout, unstagedDiff: unstagedDiffOut.stdout };
    });

    const status = gitResult.status;
    if (!status) return json(res, { commits: [], message: 'No changes to commit' });

    const allDiff = (gitResult.stagedDiff + '\n' + gitResult.unstagedDiff).trim();
    const diffTruncated = allDiff.length > LIMITS.autoCommitDiffChars;
    const truncatedDiff = diffTruncated ? allDiff.slice(0, LIMITS.autoCommitDiffChars) + '\n...(truncated)' : allDiff;

    // Use model from request body if provided (default haiku)
    const body = await readBody(req).catch(() => ({}));
    const model = body.model || 'haiku';

    const planSystem = `You are a git commit planner. Analyze changed files and group them into logical, atomic commits. Output ONLY valid JSON, no markdown fences.

Rules:
- Group related changes: same feature, same bug fix, same refactor
- Conventional commits: feat: (new feature), fix: (bug fix), refactor: (restructure), docs:, style: (formatting), chore: (deps/config/build), test:
- Concise but descriptive messages in English
- Include ALL files from git status (use file paths from status, not diff headers)
- File paths from status are in column 4+ (after the 2-char status and a space)
- For renamed files (R status), use the new path
- Order: dependencies/config first, then core logic, then UI, then tests
- Prefer fewer commits (2-5) with clear logical grouping over many tiny commits
- If unsure about a file's purpose, group it with nearby directory siblings

Output schema: {"commits":[{"message":"type(scope): description","files":["file1","file2"],"reasoning":"why grouped"}]}

Example:
{"commits":[
  {"message":"feat(auth): add user authentication middleware","files":["src/middleware/auth.ts","src/types/auth.ts"],"reasoning":"All related to the new auth feature"},
  {"message":"chore(deps): update dependencies and config","files":["package.json","package-lock.json"],"reasoning":"Dependency updates"}
]}`;

    const planUser = `${diffTruncated ? 'NOTE: Diff was truncated. Rely on git status for the full file list. Group unknown files by directory/purpose.\n\n' : ''}[GIT_STATUS]\n${status}\n[/GIT_STATUS]\n\n[DIFF]\n${truncatedDiff}\n[/DIFF]`;

    const text = await callClaude(planUser, { model, systemPrompt: planSystem });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return json(res, { error: 'Failed to parse AI response', raw: text }, 500);

    let plan;
    try { plan = JSON.parse(jsonMatch[0]); } catch {
      return json(res, { error: 'Failed to parse commit plan JSON', raw: jsonMatch[0].slice(0, 500) }, 500);
    }
    if (diffTruncated) plan.truncated = true;
    json(res, plan);
  }));

  addRoute('POST', '/api/projects/:id/auto-commit/execute', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const { message, files } = body;
    if (!message || !files?.length) return json(res, { error: 'message and files required' }, 400);

    const opts = { timeout: 10000, maxBuffer: 1024 * 1024 };

    const result = await withGitLock(project.id, async () => {
      await gitExec(project.path, ['reset', 'HEAD'], opts).catch(() => {});
      await gitExec(project.path, ['add', '--', ...files], opts);
      await gitExec(project.path, ['commit', '-m', message], opts);
      const newStatus = await gitExec(project.path, ['status', '--porcelain'], opts).catch(() => ({ stdout: '' }));
      return newStatus.stdout.trim().split('\n').filter(Boolean).length;
    });
    json(res, { success: true, message, files, remaining: result });
  }));

  // ──────────── Git Stage / Unstage / Discard / Commit ────────────

  addRoute('POST', '/api/projects/:id/git/stage', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const files = body.files; // array of file paths, or ['--all']
    if (!files?.length) return json(res, { error: 'files required' }, 400);
    const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
    await withGitLock(project.id, () =>
      files[0] === '--all'
        ? gitExec(project.path, ['add', '-A'], gopts)
        : gitExec(project.path, ['add', '--', ...files], gopts)
    );
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/unstage', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const files = body.files;
    if (!files?.length) return json(res, { error: 'files required' }, 400);
    const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
    await withGitLock(project.id, () =>
      files[0] === '--all'
        ? gitExec(project.path, ['reset', 'HEAD'], gopts)
        : gitExec(project.path, ['reset', 'HEAD', '--', ...files], gopts)
    );
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/discard', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const files = body.files;
    if (!files?.length) return json(res, { error: 'files required' }, 400);
    const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
    await withGitLock(project.id, async () => {
      // Restore tracked files
      await gitExec(project.path, ['checkout', '--', ...files], gopts).catch(() => {});
      // Clean untracked files (batched in single call)
      await gitExec(project.path, ['clean', '-f', '--', ...files], gopts).catch(() => {});
    });
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/commit', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const message = body.message;
    if (!message) return json(res, { error: 'message required' }, 400);
    await withGitLock(project.id, () =>
      gitExec(project.path, ['commit', '-m', message], { timeout: 10000 })
    );
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/checkout', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const branch = body.branch;
    if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
    const gopts = { timeout: 15000, maxBuffer: 1024 * 1024 };
    await withGitLock(project.id, async () => {
      try { await gitExec(project.path, ['switch', branch], gopts); }
      catch { await gitExec(project.path, ['checkout', branch], gopts); }
    });
    json(res, { success: true, branch });
  }));

  // ──────────── Push / Pull / Fetch ────────────

  addRoute('POST', '/api/projects/:id/push', withProject(async (req, res, project) => {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['push'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  }));

  addRoute('POST', '/api/projects/:id/pull', withProject(async (req, res, project) => {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['pull'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  }));

  addRoute('POST', '/api/projects/:id/fetch', withProject(async (req, res, project) => {
    const result = await withGitLock(project.id, () =>
      gitExec(project.path, ['fetch', '--all', '--prune'])
    );
    json(res, { success: true, output: (result.stdout + ' ' + result.stderr).trim() });
  }));

  // ──────────── Stash Operations ────────────

  addRoute('POST', '/api/projects/:id/git/stash', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const gopts = { timeout: 10000, maxBuffer: 1024 * 1024 };
    await withGitLock(project.id, async () => {
      const args = ['stash', 'push', '-m', body.message || `Cockpit stash ${new Date().toLocaleString()}`];
      if (body.includeUntracked) args.push('-u');
      await gitExec(project.path, args, gopts);
    });
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/stash-pop', withProject(async (req, res, project) => {
    const body = await readBody(req);
    if (body.ref && !isValidStashRef(body.ref)) return json(res, { error: 'Invalid stash ref' }, 400);
    await withGitLock(project.id, () => {
      const args = ['stash', 'pop'];
      if (body.ref) args.push(body.ref);
      return gitExec(project.path, args, { timeout: 10000 });
    });
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/stash-apply', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const ref = body.ref || 'stash@{0}';
    if (!isValidStashRef(ref)) return json(res, { error: 'Invalid stash ref' }, 400);
    await withGitLock(project.id, () =>
      gitExec(project.path, ['stash', 'apply', ref], { timeout: 10000 })
    );
    json(res, { success: true });
  }));

  addRoute('POST', '/api/projects/:id/git/stash-drop', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const ref = body.ref || 'stash@{0}';
    if (!isValidStashRef(ref)) return json(res, { error: 'Invalid stash ref' }, 400);
    await withGitLock(project.id, () =>
      gitExec(project.path, ['stash', 'drop', ref], { timeout: 10000 })
    );
    json(res, { success: true });
  }));

  addRoute('GET', '/api/projects/:id/stash-list', withProject(async (req, res, project) => {
    try {
      const { stdout } = await gitExec(project.path, ['stash', 'list', '--format=%gd|%s|%cr'], { timeout: 5000 });
      const stashes = stdout.trim() ? stdout.trim().split('\n').map(line => {
        const [ref, msg, ago] = line.split('|');
        return { ref, message: msg || '', ago: ago || '' };
      }) : [];
      json(res, { projectId: project.id, stashes });
    } catch { json(res, { projectId: project.id, stashes: [] }); }
  }));

  // ──────────── Branch Operations ────────────

  addRoute('POST', '/api/projects/:id/git/create-branch', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const branch = body.branch;
    if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
    await withGitLock(project.id, () =>
      gitExec(project.path, ['checkout', '-b', branch], { timeout: 10000 })
    );
    json(res, { success: true, branch });
  }));

  addRoute('POST', '/api/projects/:id/git/delete-branch', withProject(async (req, res, project) => {
    const body = await readBody(req);
    const branch = body.branch;
    if (!isValidBranch(branch)) return json(res, { error: 'Invalid branch name' }, 400);
    if (['main', 'master'].includes(branch)) return json(res, { error: 'Cannot delete main/master' }, 400);
    await withGitLock(project.id, () =>
      gitExec(project.path, ['branch', '-D', branch], { timeout: 10000 })
    );
    json(res, { success: true, branch });
  }));

  // Git log (commit history)
  addRoute('GET', '/api/projects/:id/git/log', withProject(async (req, res, project) => {
    const limit = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '30'), 100);
    try {
      const { stdout } = await gitExec(project.path, [
        'log', `--max-count=${limit}`,
        '--format=%H|%h|%an|%ae|%ar|%s'
      ], { timeout: 10000, maxBuffer: 1024 * 512 });
      const commits = stdout.trim() ? stdout.trim().split('\n').map(line => {
        const [hash, short, author, email, ago, ...msgParts] = line.split('|');
        return { hash, short, author, email, ago, message: msgParts.join('|') };
      }) : [];
      json(res, { projectId: project.id, commits });
    } catch { json(res, { projectId: project.id, commits: [] }); }
  }));

  // Branches + worktrees for terminal creation
  addRoute('GET', '/api/projects/:id/branches', withProject(async (req, res, project) => {
    const branches = await getBranches(project);
    const gitData = poller.getCached(`git:${project.id}`);
    json(res, { ...branches, worktrees: gitData?.worktrees || [] });
  }));
}
