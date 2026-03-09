// ─── Agent Tools: Tool definitions, execution, parsing ───
import { readFile, access, realpath } from 'node:fs/promises';
import { readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { parseWslPath, shellExec, searchExec, gitExec, toWinPath } from './wsl-utils.js';
import { IS_WIN, openUrlSync } from './platform.js';
import { AGENT_PROFILES, pickAgentByComplexity, getRankLevel, findCommonSuperior } from './agent-profiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───
export const MAX_TOOLS_PER_TURN = 5;
export const TOOL_RESULT_LIMIT = 5000;
const BASH_TIMEOUT = 60000; // 60s — CI/CD and large repo git operations
export const READ_MAX_CHARS = 10000;
const EDIT_MAX_FILE_SIZE = 100000; // 100KB
const EDIT_BACKUP_DIR = join(DATA_DIR, 'agent-backups');

// ─── Injected dependencies (set via initTools) ───
let _getProjectRoots = null;
let _getProjectsMeta = null;
let _getJiraConfig = null;
let _cockpitServices = null;
let _geminiApiKey = null;
let _broadcast = null;
let _GeminiClient = null;

// Lazy-loaded external service modules
let _jiraService = null;
let _cicdService = null;
async function getJiraService() {
  if (!_jiraService) _jiraService = await import('./jira-service.js');
  return _jiraService;
}
async function getCicdService() {
  if (!_cicdService) _cicdService = await import('./cicd-service.js');
  return _cicdService;
}

/** Initialize tool dependencies — called from agent-service init() */
export function initTools({ getProjectRoots, getProjectsMeta, getJiraConfig, cockpitServices, geminiApiKey, broadcast, GeminiClient }) {
  _getProjectRoots = getProjectRoots || null;
  _getProjectsMeta = getProjectsMeta || null;
  _getJiraConfig = getJiraConfig || null;
  _cockpitServices = cockpitServices || null;
  _geminiApiKey = geminiApiKey || null;
  _broadcast = broadcast || (() => {});
  _GeminiClient = GeminiClient || null;
}

export function updateGeminiApiKey(key) {
  _geminiApiKey = key || null;
}

// ═══════════════════════════════════════════════════════
// Path Safety — shared by all tools
// ═══════════════════════════════════════════════════════

/** Get the primary project root (raw, as registered) */
function getPrimaryRoot() {
  const roots = _getProjectRoots ? _getProjectRoots() : [];
  return roots.length ? roots[0] : null;
}

/** Get the primary project root as a Windows-accessible path (for fs operations) */
function getPrimaryRootFs() {
  const root = getPrimaryRoot();
  if (!root) return null;
  return resolve(normalize(IS_WIN ? toWinPath(root) : root));
}

/** Get ALL project roots as Windows-accessible paths */
function getAllRootsFs() {
  const roots = _getProjectRoots ? _getProjectRoots() : [];
  return roots.map(r => resolve(normalize(IS_WIN ? toWinPath(r) : r)));
}

/** Resolve a path (absolute or relative) against project roots and verify it's inside.
 *  M1: Checks ALL registered project roots, not just the first one. */
function resolveAndValidate(inputPath) {
  const allRoots = getAllRootsFs();
  if (!allRoots.length) return { valid: false, resolved: '', error: 'No projects registered' };

  // For absolute paths, check if it falls inside ANY registered root
  if (isAbsolute(inputPath)) {
    const resolved = resolve(normalize(inputPath));
    const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
    for (const rootFs of allRoots) {
      const rootNorm = rootFs.replace(/\\/g, '/').toLowerCase();
      if (resolvedNorm.startsWith(rootNorm + '/') || resolvedNorm === rootNorm) {
        return { valid: true, resolved, root: rootFs };
      }
    }
    return { valid: false, resolved, error: '프로젝트 디렉토리 밖은 접근할 수 없어영.' };
  }

  // For relative paths, resolve against primary root (first)
  const rootFs = allRoots[0];
  const resolved = resolve(rootFs, normalize(inputPath));
  const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
  const rootNorm = rootFs.replace(/\\/g, '/').toLowerCase();

  if (!resolvedNorm.startsWith(rootNorm + '/') && resolvedNorm !== rootNorm) {
    return { valid: false, resolved, error: '프로젝트 디렉토리 밖은 접근할 수 없어영.' };
  }

  return { valid: true, resolved, root: rootFs };
}

// ═══════════════════════════════════════════════════════
// Tool: BASH — hardened
// ═══════════════════════════════════════════════════════

/**
 * Safety filter: allowlist (first word) + blocklist (args) layered approach.
 * M8: Allowlist for command word prevents unknown-command bypass.
 */
// M7: Tightened allowlist — removed executables that can run arbitrary code
const ALLOWED_CMD_WORDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'find', 'grep', 'rg', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'comm',
  'git', 'pwd', 'date', 'which', 'where', 'whoami', 'uname', 'hostname',
  'tree', 'less', 'more', 'strings', 'xxd', 'od', 'sha256sum', 'md5sum',
  'jq', 'yq', 'sed',
]);

function isSafeCommand(cmd) {
  const lower = cmd.toLowerCase().trim();

  // M8: Allowlist gate — first word must be a known safe command
  const firstWord = lower.split(/\s+/)[0].replace(/\.exe$/, '');
  if (!ALLOWED_CMD_WORDS.has(firstWord)) return false;

  // Block: absolute path access to sensitive directories
  if (/\s+\/(?:etc|home|root|usr|var|tmp|opt|mnt|proc|sys|dev|boot)\b/.test(lower)) return false;
  if (/\s+[a-z]:\\/i.test(lower)) return false;  // Windows absolute path

  // Block: shell substitution (command injection via subshells)
  if (/[`]/.test(lower)) return false;              // backtick substitution
  if (/\$\(/.test(lower)) return false;              // $(...) substitution
  if (/\$\{/.test(lower)) return false;              // ${...} variable expansion
  if (/%[a-z]/i.test(lower)) return false;           // %VAR% expansion (Windows cmd.exe)

  // Block: command chaining operators (single & included for cmd.exe)
  if (/[&|;]/.test(lower) && !/\|\|/.test(lower)) {
    // Allow || (fallback pattern like "cmd || echo No matches") but block | & ; &&
    if (/[&;]/.test(lower)) return false;
    if (/\|(?!\|)/.test(lower)) return false; // single pipe
  }
  // Block && always
  if (/&&/.test(lower)) return false;

  // Block: destructive / dangerous operations
  const blocked = [
    /\brm\b/,                        // rm (any form)
    /\brmdir\b/,                     // rmdir
    /\bdel\b/,                       // del (windows)
    /\berase\b/,                     // erase (windows alias for del)
    /\bformat\b/,                    // format
    /\bmkfs\b/,                      // mkfs
    /\bdd\b.*\bif=/,                 // dd if=
    /:\(\)\s*\{/,                    // fork bomb
    /\bshutdown\b/,                  // shutdown
    /\breboot\b/,                    // reboot
    /\bkill\b/,                      // kill
    /\bchmod\b/,                     // chmod
    /\bchown\b/,                     // chown
    /\bnet\s+user\b/,               // net user
    /\breg\s+(delete|add|import)\b/, // registry
    /\bpowershell\b/,               // powershell entirely
    /\bcertutil\b/,                  // certutil (download abuse)
    /\bbitsadmin\b/,                 // bitsadmin (download)
    /\bcurl\b.*-[oO]\b/,            // curl with output file
    /\bwget\b/,                      // wget
    /\bmkdir\b/,                     // mkdir (write op)
    /\btouch\b/,                     // touch (write op)
    /\bmv\b/,                        // mv (rename/move)
    /\bmove\b/,                      // move (windows)
    /\bcopy\b/,                      // copy (windows)
    /\bcp\b/,                        // cp
    /\bren\b/,                       // rename (windows)
    /\brename\b/,                    // rename
    /\bnpm\s+(install|i|ci|uninstall|link|publish|run|exec|start)\b/, // npm write ops
    /\byarn\s+(add|remove|install|run|start)\b/,
    /\bpnpm\s+(add|remove|install|run|start)\b/,
    /\bpip\s+install\b/,
    /\bgit\s+(push|commit|reset|checkout|merge|rebase|stash|clean|rm|branch\s+-[dD])\b/, // git write ops
    /\becho\b.*>/,                   // echo redirect (write)
    /\bprintf\b.*>/,                 // printf redirect
    />/,                             // any output redirect (>file and > file)
    /\bcd\s+[\/\\]/,                 // cd to root
    /\bcd\s+~/,                      // cd to home
    /\bcd\s+\.\./,                   // cd parent (escape scope)
    /\bset\b/,                       // set env vars (windows)
    /\bexport\b/,                    // export env vars (linux)
    // Linux/WSL-specific dangerous operations
    /\bsudo\b/,                      // privilege escalation
    /\bapt(?:-get)?\b/,              // package management
    /\bdpkg\b/,                      // package management
    /\bsystemctl\b/,                 // service management
    /\bservice\b/,                   // service management
    /\btee\b/,                       // file writing via pipe
    /\bbash\s+-c\b/,                 // arbitrary command wrapping
    /\bsh\s+-c\b/,                   // arbitrary command wrapping
    /\bpython[23]?\s+-c\b/,         // arbitrary code execution
    /\bnode\s+-e\b/,                 // arbitrary code execution
    /\bcrontab\b/,                   // scheduled task management
    /\buseradd\b/,                   // user management
    /\busermod\b/,                   // user management
    /\bpasswd\b/,                    // password change
    /\biptables\b/,                  // firewall rules
    /\bmount\b/,                     // filesystem mount
    /\bumount\b/,                    // filesystem unmount
    /\bpkill\b/,                     // process kill (bypasses \bkill\b)
    /\bkillall\b/,                   // kill by name
    /\bln\b/,                        // symlink creation
    /\btruncate\b/,                  // file truncation
    /\bxargs\b/,                     // arbitrary command execution wrapper
    /\beval\b/,                      // shell eval
    /\bexec\b/,                      // shell exec (replace process)
    /\bsource\b/,                    // source/dot scripts
    /\bnc\b/,                        // netcat
    /\bncat\b/,                      // ncat
    /\bsocat\b/,                     // socat
    // M2: sed/awk in-place edit flags — can modify files
    /\bsed\s+.*-i\b/,               // sed -i (in-place edit)
    /\bsed\s+.*--in-place\b/,       // sed --in-place
    /\bawk\s+.*-i\s+inplace\b/,     // awk -i inplace (gawk)
    /\bawk\s+.*inplace\b/,          // awk inplace
  ];

  for (const pattern of blocked) {
    if (pattern.test(lower)) return false;
  }

  return true;
}

async function executeBash(cmd) {
  if (!isSafeCommand(cmd)) return 'Error: 이 명령어는 안전 필터에 차단됐어영. 읽기 전용 명령만 가능해여 (ls, dir, cat, type, git log, git status, git diff 등).';

  const root = getPrimaryRoot();
  if (!root) return 'Error: No projects registered';

  // Route through WSL or native shell depending on project location
  const { stdout, stderr } = await shellExec(root, cmd, {
    timeout: BASH_TIMEOUT,
    env: { ...process.env, CLAUDECODE: undefined }
  });
  return (stdout + stderr).trim() || '(no output)';
}

// ═══════════════════════════════════════════════════════
// Tool: READ — path-validated
// ═══════════════════════════════════════════════════════

async function executeRead(filePath) {
  const check = resolveAndValidate(filePath);
  if (!check.valid) return `Error: ${check.error}`;

  const p = check.resolved;
  try { await access(p); } catch {
    return `File not found: ${filePath}`;
  }

  // Symlink escape guard: resolve to real path and re-validate
  let realP;
  try { realP = await realpath(p); } catch { realP = p; }
  const realNorm = realP.replace(/\\/g, '/').toLowerCase();
  const rootNorm = check.root.replace(/\\/g, '/').toLowerCase();
  if (!realNorm.startsWith(rootNorm + '/') && realNorm !== rootNorm) {
    return 'Error: 심링크가 프로젝트 밖을 가리키고 있어영.';
  }

  const content = await readFile(p, 'utf8');
  if (content.length > READ_MAX_CHARS) {
    return content.slice(0, READ_MAX_CHARS) + `\n...(truncated — 전체 ${content.length}자 중 ${READ_MAX_CHARS}자만 표시)`;
  }
  return content;
}

// ═══════════════════════════════════════════════════════
// Tool: SEARCH — direct findstr/grep, no bash passthrough
// ═══════════════════════════════════════════════════════

async function executeSearch(pattern) {
  const root = getPrimaryRoot();
  if (!root) return 'No projects registered';

  const safePattern = pattern.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!safePattern) return 'Error: 검색어가 비어있어영.';

  let stdout = '';
  try {
    stdout = await searchExec(root, safePattern, { timeout: BASH_TIMEOUT });
  } catch (err) {
    if (err.code === 1 || err.status === 1) return 'No matches found';
    stdout = err.stdout || '';
    if (!stdout) return `Search error: ${err.message}`;
  }

  const wsl = parseWslPath(root);
  const isWin = !wsl && process.platform === 'win32';
  const searchRoot = wsl ? '.' : (isWin ? toWinPath(root) : root);
  const sep = isWin ? '\\' : '/';
  const rootNorm = searchRoot + sep;
  const lines = stdout.split('\n').filter(Boolean).slice(0, 30);
  const relativized = lines.map(line => line.replace(rootNorm, '').replace(searchRoot, '').replace(/^\.\//, ''));
  return relativized.join('\n') || 'No matches found';
}

// ═══════════════════════════════════════════════════════
// Tool: EDIT — file modification with backup
// ═══════════════════════════════════════════════════════

async function executeEdit(rawArg) {
  const lines = rawArg.split('\n');
  const filePath = lines[0].trim();
  if (!filePath) return 'Error: 파일 경로가 필요해영.';

  const check = resolveAndValidate(filePath);
  if (!check.valid) return `Error: ${check.error}`;

  const p = check.resolved;
  try { await access(p); } catch {
    return `Error: File not found: ${filePath}`;
  }

  // Symlink escape guard
  let realP;
  try { realP = await realpath(p); } catch { realP = p; }
  const realNorm = realP.replace(/\\/g, '/').toLowerCase();
  const rootNorm = check.root.replace(/\\/g, '/').toLowerCase();
  if (!realNorm.startsWith(rootNorm + '/') && realNorm !== rootNorm) {
    return 'Error: 심링크가 프로젝트 밖을 가리키고 있어영.';
  }

  let content;
  try { content = await readFile(p, 'utf8'); } catch (err) {
    return `Error: 파일 읽기 실패: ${err.message}`;
  }

  if (content.length > EDIT_MAX_FILE_SIZE) {
    return `Error: 파일이 너무 커영 (${content.length}자). 최대 ${EDIT_MAX_FILE_SIZE}자까지 수정 가능해영.`;
  }

  if (content.slice(0, 1000).includes('\0')) {
    return 'Error: 바이너리 파일은 수정할 수 없어영.';
  }

  const oldMatch = rawArg.match(/OLD_CONTENT\s*\n<<<\n([\s\S]*?)\n>>>/);
  const newMatch = rawArg.match(/NEW_CONTENT\s*\n<<<\n([\s\S]*?)\n>>>/);
  if (!oldMatch || !newMatch) {
    return 'Error: EDIT 형식이 잘못됐어영. OLD_CONTENT\\n<<<\\n...\\n>>>\\nNEW_CONTENT\\n<<<\\n...\\n>>> 블록이 필요해영.';
  }

  const oldContent = oldMatch[1];
  const newContent = newMatch[1];

  if (!content.includes(oldContent)) {
    return 'Error: OLD_CONTENT 블록이 파일에서 찾을 수 없어영. READ로 정확한 내용을 다시 확인해주세영.';
  }
  const occurrences = content.split(oldContent).length - 1;
  if (occurrences > 1) {
    return `Error: OLD_CONTENT가 파일에 ${occurrences}번 나타나영. 더 구체적인 컨텍스트를 포함해주세영.`;
  }

  try {
    mkdirSync(EDIT_BACKUP_DIR, { recursive: true });
    const safeName = filePath.replace(/[/\\:*?"<>|]/g, '_');
    const backupName = `${safeName}_${Date.now()}.bak`;
    const backupPath = join(EDIT_BACKUP_DIR, backupName);
    copyFileSync(p, backupPath);
    if (_broadcast) _broadcast('agent:edit-backup', { file: filePath, backupPath: backupName });
  } catch (err) {
    return `Error: 백업 생성 실패: ${err.message}`;
  }

  const newFileContent = content.replace(oldContent, newContent);

  try {
    writeFileSync(p, newFileContent, 'utf8');
  } catch (err) {
    return `Error: 파일 쓰기 실패: ${err.message}`;
  }

  const linesOld = oldContent.split('\n').length;
  const linesNew = newContent.split('\n').length;
  return `✅ ${filePath} 수정 완료 (${linesOld}줄 → ${linesNew}줄). 백업 생성됨. READ로 결과를 확인해주세영.`;
}

// ═══════════════════════════════════════════════════════
// Tool: GLOB — file pattern matching
// ═══════════════════════════════════════════════════════

const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'venv', 'build', '.cache', 'coverage']);

async function executeGlob(pattern) {
  const root = getPrimaryRoot();
  if (!root) return 'Error: No projects registered';

  const safe = pattern.replace(/\.\.\//g, '').trim();
  if (!safe) return 'Error: 패턴이 비어있어영.';
  if (safe.startsWith('/') || /^[a-zA-Z]:/.test(safe)) {
    return 'Error: 절대 경로 패턴은 사용할 수 없어영. 상대경로를 사용하세영.';
  }

  const wsl = parseWslPath(root);
  if (wsl) {
    const findName = safe.includes('/') ? safe.split('/').pop() : safe;
    const findPath = safe.includes('/') ? safe.substring(0, safe.lastIndexOf('/')) : '.';
    const safeFindName = findName.replace(/["$`\\!;|&(){}]/g, '');
    const safeFindPath = findPath.replace(/[*"$`\\!;|&(){}]/g, '');
    try {
      const { stdout } = await shellExec(root,
        `find ${safeFindPath} -type f -name "${safeFindName}" 2>/dev/null | head -50`,
        { timeout: 15000 });
      const results = stdout.trim().split('\n').filter(Boolean).map(l => l.replace(/^\.\//, ''));
      return results.length ? results.join('\n') : 'No matches found';
    } catch {
      return 'No matches found';
    }
  }

  const rootFs = getPrimaryRootFs();
  if (!rootFs) return 'Error: No projects registered';

  const results = [];
  const queue = [''];
  const maxResults = 50;

  while (queue.length > 0 && results.length < maxResults) {
    const rel = queue.shift();
    const abs = join(rootFs, rel);
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!GLOB_SKIP_DIRS.has(entry.name)) queue.push(entryRel);
      } else if (simpleGlobMatch(entryRel, safe)) {
        results.push(entryRel.replace(/\\/g, '/'));
      }
    }
  }
  return results.length ? results.join('\n') : 'No matches found';
}

/** Simple glob matcher: supports * and ** patterns */
function simpleGlobMatch(filePath, pattern) {
  const re = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*')
    .replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${re}$`).test(filePath);
  } catch {
    return filePath.includes(pattern.replace(/\*/g, ''));
  }
}

// ═══════════════════════════════════════════════════════
// Tool: GIT_DIFF — view changes
// ═══════════════════════════════════════════════════════

async function executeGitDiff(mode) {
  const root = getPrimaryRoot();
  if (!root) return 'Error: No projects registered';

  const m = (mode || 'all').trim().toLowerCase();
  try {
    if (m === 'staged') {
      const { stdout } = await gitExec(root, ['diff', '--cached', '--stat', '-p', '-U3'], { timeout: 15000 });
      return stdout.trim() || 'No staged changes';
    }
    if (m === 'unstaged') {
      const { stdout } = await gitExec(root, ['diff', '--stat', '-p', '-U3'], { timeout: 15000 });
      return stdout.trim() || 'No unstaged changes';
    }
    // 'all' — both
    const staged = await gitExec(root, ['diff', '--cached', '--stat'], { timeout: 15000 });
    const unstaged = await gitExec(root, ['diff', '--stat'], { timeout: 15000 });
    let result = '';
    if (staged.stdout.trim()) result += `== Staged ==\n${staged.stdout.trim()}\n\n`;
    if (unstaged.stdout.trim()) result += `== Unstaged ==\n${unstaged.stdout.trim()}`;
    return result || 'No changes (clean working tree)';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// Tool: GIT_LOG — commit history
// ═══════════════════════════════════════════════════════

async function executeGitLog(arg) {
  const root = getPrimaryRoot();
  if (!root) return 'Error: No projects registered';

  const count = Math.min(Math.max(parseInt(arg) || 10, 1), 50);
  try {
    const { stdout } = await gitExec(root, ['log', '--oneline', '--graph', '--decorate', `-${count}`], { timeout: 15000 });
    return stdout.trim() || 'No commits found';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// Tool: JIRA — issue lookup
// ═══════════════════════════════════════════════════════

async function executeJira(arg) {
  if (!_getJiraConfig) return 'Error: Jira 서비스가 초기화되지 않았어영.';
  const config = _getJiraConfig();
  if (!config || !config.url || !config.email || !config.token) {
    return 'Error: Jira 설정이 안 되어있어영. 설정 탭에서 Jira를 먼저 연결해주세영.';
  }

  const trimmed = arg.trim();
  const jira = await getJiraService();

  function formatIssueList(issues) {
    const header = '| 이슈 | 타입 | 상태 | 우선순위 | 담당 | 요약 | 마감일 | SP |';
    const sep =    '| --- | --- | --- | --- | --- | --- | --- | --- |';
    const rows = issues.map(i => {
      const due = i.dueDate ? i.dueDate.slice(0, 10) : '-';
      const sp = i.storyPoints != null ? i.storyPoints : '-';
      return `| ${i.key} | ${i.type?.name || '-'} | [${i.status?.name || '?'}] | ${i.priority?.name || '-'} | ${i.assignee ? '@' + i.assignee.displayName : '-'} | ${i.summary} | ${due} | ${sp} |`;
    });

    const total = issues.length;
    const byStatus = {};
    issues.forEach(i => { const s = i.status?.name || '기타'; byStatus[s] = (byStatus[s] || 0) + 1; });
    const stats = Object.entries(byStatus).map(([s, c]) => `[${s}] ${c}건`).join(', ');
    const overdue = issues.filter(i => i.dueDate && new Date(i.dueDate) < new Date()).length;

    let result = [header, sep, ...rows].join('\n');
    result += `\n\n총 **${total}건** — ${stats}`;
    if (overdue > 0) result += ` | 마감 초과 **${overdue}건** ⚠️`;
    return result;
  }

  // M3: JQL mode
  if (trimmed.toLowerCase().startsWith('jql:')) {
    const jql = trimmed.slice(4).trim();
    if (!jql) return 'Error: JQL 쿼리가 필요해영.';
    try {
      const issues = await jira.searchIssues(config, jql, { maxResults: 20 });
      if (!issues.length) return `JQL 검색 결과가 없어영: ${jql}`;
      return formatIssueList(issues);
    } catch (err) {
      if (err.message?.includes('searchIssues')) {
        return `Error: JQL 검색 기능을 사용할 수 없어영. search:키워드 를 사용해주세영.`;
      }
      return `Error: ${err.message}`;
    }
  }

  // Search mode
  if (trimmed.toLowerCase().startsWith('search:')) {
    const query = trimmed.slice(7).trim();
    if (!query) return 'Error: 검색어가 필요해영.';
    try {
      let issues;
      try {
        issues = await jira.searchIssues(config, `summary ~ "${query}" OR description ~ "${query}" ORDER BY updated DESC`, { maxResults: 15 });
      } catch {
        issues = await jira.getMyIssues(config, { maxResults: 30 });
        issues = issues.filter(i =>
          (i.summary || '').toLowerCase().includes(query.toLowerCase()) ||
          (i.key || '').toLowerCase().includes(query.toLowerCase())
        );
      }
      if (!issues.length) return `"${query}"로 검색된 이슈가 없어영.`;
      return formatIssueList(issues);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  // Issue key lookup
  if (/^[A-Z]+-\d+$/i.test(trimmed)) {
    try {
      const i = await jira.getIssue(config, trimmed.toUpperCase());
      const due = i.dueDate ? i.dueDate.slice(0, 10) : null;
      const overdue = due && new Date(due) < new Date();
      const updated = i.updated ? new Date(i.updated).toLocaleDateString('ko-KR') : null;

      const lines = [
        `## ${i.key}: ${i.summary}`,
        '',
        `| 항목 | 내용 |`,
        `| --- | --- |`,
        `| 상태 | [${i.status?.name || '?'}] |`,
        `| 타입 | ${i.type?.name || '?'} |`,
        `| 우선순위 | ${i.priority?.name || '?'} |`,
        `| 담당 | ${i.assignee ? '@' + i.assignee.displayName : '미할당'} |`,
        `| 보고자 | ${i.reporter?.displayName || '?'} |`,
      ];
      if (due) lines.push(`| 마감일 | ${due}${overdue ? ' ⚠️ **초과**' : ''} |`);
      if (i.sprint) lines.push(`| 스프린트 | ${i.sprint.name} (${i.sprint.state}) |`);
      if (i.storyPoints != null) lines.push(`| SP | ${i.storyPoints} |`);
      if (i.labels?.length) lines.push(`| 라벨 | ${i.labels.join(', ')} |`);
      if (i.parent) lines.push(`| 상위이슈 | ${i.parent.key} ${i.parent.summary} |`);
      if (updated) lines.push(`| 최종수정 | ${updated} |`);

      if (i.description) {
        const desc = typeof i.description === 'string' ? i.description.slice(0, 600) : '(ADF 형식 — Jira 웹에서 확인)';
        lines.push('', '### 설명', desc);
      }
      return lines.join('\n');
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  return 'Error: 올바른 이슈 키 (예: PROJ-123) 또는 search:검색어 형식을 사용해주세영.';
}

// ═══════════════════════════════════════════════════════
// Tool: CICD — CI/CD control
// ═══════════════════════════════════════════════════════

async function executeCicd(arg) {
  const root = getPrimaryRoot();
  if (!root) return 'Error: No projects registered';

  const cicd = await getCicdService();
  const trimmed = arg.trim().toLowerCase();

  if (trimmed === 'status') {
    try {
      const runs = await cicd.getWorkflowRuns(root, { limit: 10 });
      if (!runs.length) return 'CI/CD 실행 이력이 없어영.';
      return runs.map(r => {
        const status = r.conclusion || r.status;
        const icon = status === 'success' ? '✅' : status === 'failure' ? '❌' : status === 'in_progress' ? '⏳' : '⬜';
        return `${icon} #${r.databaseId} ${r.workflowName || r.name} [${r.headBranch}] ${status} (${r.createdAt})`;
      }).join('\n');
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  if (trimmed.startsWith('detail:')) {
    const runId = trimmed.slice(7).trim();
    if (!runId || !/^\d+$/.test(runId)) return 'Error: 올바른 런 ID가 필요해영 (숫자).';
    try {
      const detail = await cicd.getRunDetail(root, runId);
      const jobs = (detail.jobs || []).map(j => {
        const jStatus = j.conclusion || j.status;
        const icon = jStatus === 'success' ? '✅' : jStatus === 'failure' ? '❌' : '⏳';
        return `  ${icon} ${j.name}: ${jStatus}`;
      }).join('\n');
      return [
        `Run #${detail.databaseId}: ${detail.displayTitle || detail.name}`,
        `워크플로우: ${detail.workflowName}`,
        `브랜치: ${detail.headBranch} (${(detail.headSha || '').slice(0, 7)})`,
        `상태: ${detail.conclusion || detail.status}`,
        `생성: ${detail.createdAt}`,
        jobs ? `\n작업 목록:\n${jobs}` : '',
      ].filter(Boolean).join('\n');
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  if (trimmed.startsWith('rerun:')) {
    const runId = trimmed.slice(6).trim();
    if (!runId || !/^\d+$/.test(runId)) return 'Error: 올바른 런 ID가 필요해영 (숫자).';
    try {
      await cicd.rerunWorkflow(root, runId);
      return `✅ Run #${runId} 재실행을 시작했어영!`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  if (trimmed.startsWith('cancel:')) {
    const runId = trimmed.slice(7).trim();
    if (!runId || !/^\d+$/.test(runId)) return 'Error: 올바른 런 ID가 필요해영 (숫자).';
    try {
      await cicd.cancelRun(root, runId);
      return `✅ Run #${runId} 취소했어영!`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  return 'Error: 올바른 형식을 사용해주세영: status, detail:런ID, rerun:런ID, cancel:런ID';
}

// ═══════════════════════════════════════════════════════
// Tool: OPEN — open URL in default browser
// ═══════════════════════════════════════════════════════

function executeOpen(arg) {
  const url = (arg || '').trim();
  if (!url) return 'Error: URL이 필요해영.';

  let finalUrl = url;
  if (!/^https?:\/\//i.test(finalUrl)) {
    if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
      finalUrl = 'https://' + finalUrl;
    } else {
      return 'Error: https:// 로 시작하는 URL이 필요해영.';
    }
  }

  let parsed;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return 'Error: URL 형식이 올바르지 않아영.';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'Error: http/https 프로토콜만 열 수 있어영.';
  }

  const host = parsed.hostname;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|localhost|\[::1\])/.test(host)) {
    return 'Error: 로컬/내부 네트워크 주소는 열 수 없어영.';
  }

  // YouTube: embed in-app instead of external browser
  if (/youtube\.com|youtu\.be/i.test(parsed.hostname)) {
    let embedUrl = '';
    const vMatch = finalUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    const shortMatch = parsed.hostname === 'youtu.be' && parsed.pathname.slice(1);
    const _searchMatch = finalUrl.match(/search_query=([^&]+)/);

    if (vMatch) {
      embedUrl = `https://www.youtube.com/embed/${vMatch[1]}?autoplay=1`;
    } else if (shortMatch && /^[a-zA-Z0-9_-]{11}$/.test(shortMatch)) {
      embedUrl = `https://www.youtube.com/embed/${shortMatch}?autoplay=1`;
    }

    if (embedUrl) {
      return `@@EMBED:youtube:${embedUrl}@@`;
    }
  }

  const safeUrl = finalUrl.replace(/["'`]/g, '');

  try {
    openUrlSync(safeUrl);
    return `✅ 브라우저에서 열었어영: ${finalUrl}`;
  } catch (err) {
    return `Error: 열기 실패: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// Tool: WRITE — create new file
// ═══════════════════════════════════════════════════════

async function executeWrite(rawArg) {
  const lines = rawArg.split('\n');
  const filePath = lines[0].trim();
  if (!filePath) return 'Error: 파일 경로가 필요해영.';

  const check = resolveAndValidate(filePath);
  if (!check.valid) return `Error: ${check.error}`;

  const p = check.resolved;

  let exists = false;
  try { await access(p); exists = true; } catch { /* good */ }
  if (exists) {
    return 'Error: 파일이 이미 있어영. 기존 파일을 수정하려면 EDIT를 사용하세영.';
  }

  const content = lines.slice(1).join('\n');
  if (!content && content !== '') return 'Error: 파일 내용이 필요해영.';
  if (content.length > EDIT_MAX_FILE_SIZE) {
    return `Error: 내용이 너무 커영 (${content.length}자). 최대 ${EDIT_MAX_FILE_SIZE}자까지 가능해영.`;
  }

  const dir = dirname(p);
  try { mkdirSync(dir, { recursive: true }); } catch { /* may already exist */ }

  try {
    writeFileSync(p, content, 'utf8');
    const lineCount = content.split('\n').length;
    return `✅ ${filePath} 생성 완료 (${lineCount}줄, ${content.length}자).`;
  } catch (err) {
    return `Error: 파일 생성 실패: ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// COCKPIT — Internal dashboard data access
// ═══════════════════════════════════════════════════════

function fmtBytes(b) { if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB'; if (b >= 1e6) return (b / 1e6).toFixed(1) + 'MB'; return (b / 1e3).toFixed(0) + 'KB'; }
function fmtNum(n) { return n != null ? n.toLocaleString('en-US') : '0'; }
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

async function executeCockpit(arg) {
  if (!_cockpitServices) return 'Error: cockpit service not initialized.';
  const trimmed = (arg || '').trim();
  const firstNewline = trimmed.indexOf('\n');
  const firstLine = firstNewline >= 0 ? trimmed.slice(0, firstNewline).trim() : trimmed;
  const extra = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : '';
  const colonIdx = firstLine.indexOf(':');
  const cmd = (colonIdx >= 0 ? firstLine.slice(0, colonIdx) : firstLine).toLowerCase();
  const param = colonIdx >= 0 ? firstLine.slice(colonIdx + 1).trim() : '';

  try {
    switch (cmd) {

      case 'usage': {
        const data = _cockpitServices.poller?.getCached?.('cost:daily') || await _cockpitServices.computeUsage();
        if (!data) return 'No usage data available.';
        const t = data.today || {};
        const w = data.week || {};
        const modelLines = Object.entries(t.models || {}).map(([m, v]) => `  ${m}: $${(v.apiCost || 0).toFixed(3)} (${fmtNum(v.outputTokens)} out)`).join('\n');
        return `[Today ${t.date || ''}]\nOutput: ${fmtNum(t.outputTokens)} | Input: ${fmtNum(t.inputTokens)} | Cache R: ${fmtNum(t.cacheReadTokens)} | Cache W: ${fmtNum(t.cacheCreationTokens)}\nCost: $${(t.apiEquivCost || 0).toFixed(3)} | Messages: ${t.messages || 0} | Sessions: ${t.sessions || 0} | Tools: ${t.toolCalls || 0}\nModels:\n${modelLines || '  (none)'}\n\n[Week]\nCost: $${(w.apiEquivCost || 0).toFixed(3)} | Output: ${fmtNum(w.outputTokens)} | Messages: ${w.messages || 0}\nReset: ${w.resetAt || '?'}`;
      }

      case 'projects': {
        const projects = _cockpitServices.getProjects();
        if (!projects?.length) return 'No projects registered.';
        return `[Projects] ${projects.length}\n` + projects.map((p, i) =>
          `${i + 1}. ${p.name} (${p.id}) — stack: ${p.stack || '?'} — ${p.path}`
        ).join('\n');
      }

      case 'project': {
        if (!param) return 'Error: project ID required. Usage: project:ID';
        const proj = _cockpitServices.getProjectById(param);
        if (!proj) return `Error: project "${param}" not found.`;
        const poller = _cockpitServices.poller;
        const session = poller?.getCached?.('session:' + param);
        const git = poller?.getCached?.('git:' + param);
        const prs = poller?.getCached?.('prs:' + param);
        const cicd = poller?.getCached?.('cicd:' + param);
        const lines = [`[Project: ${proj.name}]`, `Path: ${proj.path}`, `Stack: ${proj.stack || '?'}`];
        if (session) lines.push(`Session: ${session.state || 'unknown'} | Model: ${session.model || '?'} | Last: ${timeAgo(session.lastActivity)}`);
        if (git) {
          lines.push(`Branch: ${git.branch || '?'} | Uncommitted: ${git.uncommittedCount || 0}`);
          if (git.recentCommits?.length) lines.push(`Last commit: ${git.recentCommits[0].message} (${git.recentCommits[0].hash?.slice(0, 7)})`);
        }
        if (prs?.prs?.length) lines.push(`PRs: ${prs.prs.map(pr => `#${pr.number} ${pr.title} [${pr.reviewDecision}]`).join(', ')}`);
        if (cicd?.runs?.length) {
          const r = cicd.runs[0];
          lines.push(`CI/CD: ${r.name || 'workflow'} — ${r.conclusion || r.status} (${timeAgo(r.updated_at || r.created_at)})`);
        }
        return lines.join('\n');
      }

      case 'prs': {
        const poller = _cockpitServices.poller;
        const projects = _cockpitServices.getProjects();
        const allPrs = [];
        for (const p of projects) {
          const cached = param
            ? (p.id === param ? poller?.getCached?.('prs:' + p.id) : null)
            : poller?.getCached?.('prs:' + p.id);
          if (cached?.prs?.length) {
            for (const pr of cached.prs) allPrs.push({ ...pr, project: p.name });
          }
        }
        if (!allPrs.length) return param ? `No PRs for project "${param}".` : 'No PRs across all projects.';
        return `[PRs] ${allPrs.length}\n` + allPrs.map(pr =>
          `#${pr.number} ${pr.title} [${pr.reviewDecision || 'PENDING'}] — ${pr.project} (@${pr.author}) ${pr.isDraft ? '(draft)' : ''}`
        ).join('\n');
      }

      case 'sessions': {
        const poller = _cockpitServices.poller;
        const projects = _cockpitServices.getProjects();
        const lines = [`[Sessions] ${projects.length} projects`];
        for (const p of projects) {
          const s = poller?.getCached?.('session:' + p.id);
          lines.push(`  ${p.name}: ${s?.state || 'no_data'} | Model: ${s?.model || '?'} | Last: ${timeAgo(s?.lastActivity)}`);
        }
        return lines.join('\n');
      }

      case 'notes': {
        const notes = await _cockpitServices.listNotes();
        if (!notes?.length) return 'No notes.';
        return `[Notes] ${notes.length}\n` + notes.map((n, i) =>
          `${i + 1}. [${n.id}] "${n.title}"${n.tags?.length ? ' — tags: ' + n.tags.join(',') : ''}${n.project ? ' — project: ' + n.project : ''} — ${timeAgo(n.updatedAt)}\n   ${n.preview || ''}`
        ).join('\n');
      }

      case 'note': {
        if (!param) return 'Error: note ID required. Usage: note:ID';
        const note = await _cockpitServices.getNote(param);
        if (!note) return `Error: note "${param}" not found.`;
        return `[Note: ${note.title}]\nID: ${note.id} | Created: ${timeAgo(note.createdAt)} | Updated: ${timeAgo(note.updatedAt)}\nTags: ${note.tags?.join(', ') || '(none)'} | Project: ${note.project || '(none)'}\n\n${note.content || '(empty)'}`;
      }

      case 'note-create': {
        if (!param) return 'Error: 제목이 필요합니다. Usage: COCKPIT:note-create:제목';
        const noteContent = extra || '';
        if (!_cockpitServices?.createNote) return 'Error: Note service unavailable.';
        try {
          const newNote = await _cockpitServices.createNote({ title: param, content: noteContent, project: '' });
          return `Note 생성 완료: [${newNote.id}] "${newNote.title}" (${noteContent.length}자)`;
        } catch (e) { return `Error: Note 생성 실패: ${e.message}`; }
      }

      case 'note-update': {
        if (!param) return 'Error: 노트 ID가 필요합니다. Usage: COCKPIT:note-update:ID';
        const updateContent = extra || '';
        if (!_cockpitServices?.updateNote) return 'Error: Note service unavailable.';
        try {
          const updated = await _cockpitServices.updateNote(param, { content: updateContent });
          if (!updated) return `Error: note "${param}" not found.`;
          return `Note 수정 완료: [${updated.id}] "${updated.title}" (${updateContent.length}자)`;
        } catch (e) { return `Error: Note 수정 실패: ${e.message}`; }
      }

      case 'system': {
        const stats = await _cockpitServices.getAllStats();
        if (!stats) return 'System stats unavailable.';
        const lines = [`[System]`];
        lines.push(`CPU: ${stats.cpu}% | Memory: ${stats.memory?.percent}% (${fmtBytes(stats.memory?.used)} / ${fmtBytes(stats.memory?.total)})`);
        if (stats.disk?.length) {
          lines.push(`Disks: ${stats.disk.map(d => `${d.drive} ${d.percent}% (${fmtBytes(d.used)}/${fmtBytes(d.total)})`).join(' | ')}`);
        }
        if (stats.system) {
          lines.push(`Host: ${stats.system.hostname} | ${stats.system.platform} ${stats.system.arch} | Cores: ${stats.system.cpuCores} | Node: ${stats.system.nodeVersion}`);
        }
        if (stats.processes?.length) {
          lines.push(`Top processes:`);
          for (const p of stats.processes.slice(0, 8)) {
            lines.push(`  ${p.ProcessName} (PID ${p.Id}) — CPU: ${p.Cpu}s, Mem: ${p.MemMB}MB`);
          }
        }
        return lines.join('\n');
      }

      case 'briefing': {
        const poller = _cockpitServices.poller;
        const projects = _cockpitServices.getProjects();
        const projectStates = {};
        for (const p of projects) {
          projectStates[p.id] = {
            session: poller?.getCached?.('session:' + p.id),
            git: poller?.getCached?.('git:' + p.id),
            prs: poller?.getCached?.('prs:' + p.id),
            cicd: poller?.getCached?.('cicd:' + p.id),
          };
        }
        const costData = poller?.getCached?.('cost:daily');
        const briefing = _cockpitServices.generateBriefing(projectStates, costData);
        if (!briefing) return 'Briefing generation failed.';
        const lines = [`[Daily Briefing ${briefing.date}] ${briefing.totalProjects} projects, ${briefing.attentionCount} need attention`];
        if (briefing.cost) lines.push(`Cost — Yesterday: $${(briefing.cost.yesterday || 0).toFixed(2)} | Today: $${(briefing.cost.today || 0).toFixed(2)} | Week: $${(briefing.cost.weekly || 0).toFixed(2)}`);
        for (const item of briefing.items || []) {
          lines.push(`${item.needsAttention ? '[!] ' : ''}${item.projectId}: ${item.changes.join(', ')}`);
        }
        if (!briefing.items?.length) lines.push('No notable changes.');
        return lines.join('\n');
      }

      case 'alerts': {
        const poller = _cockpitServices.poller;
        const projects = _cockpitServices.getProjects();
        const projectStates = {};
        for (const p of projects) {
          projectStates[p.id] = {
            session: poller?.getCached?.('session:' + p.id),
            git: poller?.getCached?.('git:' + p.id),
            cicd: poller?.getCached?.('cicd:' + p.id),
          };
        }
        const costData = poller?.getCached?.('cost:daily');
        const alerts = _cockpitServices.checkAlerts(projectStates, costData);
        if (!alerts?.length) return 'No active alerts.';
        return `[Alerts] ${alerts.length}\n` + alerts.map(a =>
          `[${a.level.toUpperCase()}] ${a.message}`
        ).join('\n');
      }

      case 'activity': {
        const activity = _cockpitServices.getRecentActivity();
        if (!activity?.length) return 'No recent activity.';
        return `[Recent Activity] ${activity.length}\n` + activity.slice(0, 15).map(a =>
          `${timeAgo(a.timestamp || a.ts)} — ${a.project || a.projectId || '?'}: ${a.summary || a.message || a.type || '?'}`
        ).join('\n');
      }

      case 'workflows': {
        const defs = await _cockpitServices.listWorkflowDefs();
        if (!defs?.length) return 'No workflows defined.';
        return `[Workflows] ${defs.length}\n` + defs.map((d, i) =>
          `${i + 1}. [${d.id}] "${d.name}" — steps: ${d.steps?.length || 0}${d.description ? ' — ' + d.description : ''}`
        ).join('\n');
      }

      case 'workflow': {
        if (!param) return 'Error: workflow ID required. Usage: workflow:ID';
        const def = await _cockpitServices.getWorkflowDef(param);
        if (!def) return `Error: workflow "${param}" not found.`;
        const lines = [`[Workflow: ${def.name}]`, `ID: ${def.id}`, def.description || ''];
        if (def.steps?.length) {
          lines.push(`Steps (${def.steps.length}):`);
          for (const s of def.steps) lines.push(`  ${s.name} — model: ${s.model || '?'} | type: ${s.type || 'llm'}`);
        }
        return lines.filter(Boolean).join('\n');
      }

      case 'workflow-runs': {
        const runs = await _cockpitServices.listWorkflowRuns();
        if (!runs?.length) return 'No workflow runs.';
        return `[Workflow Runs] ${runs.length}\n` + runs.slice(0, 15).map(r =>
          `[${r.id}] "${r.workflowName || r.workflowId}" — ${r.status} — ${timeAgo(r.startedAt)}${r.error ? ' — ERR: ' + r.error : ''}`
        ).join('\n');
      }

      case 'workflow-run': {
        if (!param) return 'Error: run ID required. Usage: workflow-run:ID';
        const run = await _cockpitServices.getWorkflowRunDetail(param);
        if (!run) return `Error: workflow run "${param}" not found.`;
        const lines = [`[Run: ${run.id}]`, `Workflow: ${run.workflowName || run.workflowId}`, `Status: ${run.status} | Started: ${timeAgo(run.startedAt)}${run.finishedAt ? ' | Finished: ' + timeAgo(run.finishedAt) : ''}`];
        if (run.steps?.length) {
          lines.push(`Steps:`);
          for (const s of run.steps) lines.push(`  ${s.name}: ${s.status}${s.duration ? ' (' + s.duration + 'ms)' : ''}${s.error ? ' ERR: ' + s.error : ''}`);
        }
        return lines.join('\n');
      }

      // ─── Terminal Control ───

      case 'terminals': {
        const terms = _cockpitServices.listTerminals?.() || [];
        if (!terms.length) return '[Terminals] 0 active — no terminals running.';
        const projects = _cockpitServices.getProjects?.() || [];
        const projMap = Object.fromEntries(projects.map(p => [p.id, p.name]));
        return `[Terminals] ${terms.length} active\n` + terms.map((t, i) =>
          `${i + 1}. [${t.termId}] project: ${projMap[t.projectId] || t.projectId} | cmd: ${t.command || '(shell)'}`
        ).join('\n');
      }

      case 'terminal-read': {
        if (!param) return 'Error: terminal ID required. Usage: terminal-read:TERM_ID';
        const buf = _cockpitServices.readTerminalBuffer?.(param);
        if (buf === null) return `Error: terminal "${param}" not found.`;
        const clean = buf.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
        const tail = clean.length > 3000 ? '...(truncated)\n' + clean.slice(-3000) : clean;
        return `[Terminal: ${param}] last output:\n${tail}`;
      }

      case 'terminal-input': {
        const sepIdx = param.indexOf(':');
        if (sepIdx < 0) return 'Error: format is terminal-input:TERM_ID:command. Example: terminal-input:term-123:npm test';
        const termId = param.slice(0, sepIdx).trim();
        const inputCmd = param.slice(sepIdx + 1);
        const ok = _cockpitServices.writeTerminalInput?.(termId, inputCmd + '\r');
        if (!ok) return `Error: terminal "${termId}" not found.`;
        await new Promise(r => setTimeout(r, 1500));
        const outBuf = _cockpitServices.readTerminalBuffer?.(termId) || '';
        const outClean = outBuf.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
        const outTail = outClean.length > 2000 ? '...(truncated)\n' + outClean.slice(-2000) : outClean;
        return `[OK] Sent to ${termId}. Recent output:\n${outTail}`;
      }

      case 'terminal-create': {
        const cSepIdx = param.indexOf(':');
        const projId = cSepIdx >= 0 ? param.slice(0, cSepIdx).trim() : param.trim();
        const initCmd = cSepIdx >= 0 ? param.slice(cSepIdx + 1).trim() : '';
        if (!projId) return 'Error: project ID required. Usage: terminal-create:PROJECT_ID[:command]';
        const newTermId = _cockpitServices.createTerminal?.(projId, initCmd);
        if (!newTermId) return `Error: failed to create terminal for project "${projId}". Check project ID.`;
        await new Promise(r => setTimeout(r, 2000));
        const initBuf = _cockpitServices.readTerminalBuffer?.(newTermId) || '';
        const initClean = initBuf.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
        return `[OK] Created terminal ${newTermId} for project ${projId}${initCmd ? ' with command: ' + initCmd : ''}.\nInitial output:\n${initClean.slice(-1000)}`;
      }

      case 'workflow-start': {
        if (!param) return 'Error: workflow ID required. Usage: workflow-start:WORKFLOW_ID';
        if (!_cockpitServices?.startWorkflowRun) return 'Error: workflow service unavailable.';
        let inputs = {};
        if (extra) {
          try { inputs = JSON.parse(extra); } catch { inputs = {}; }
        }
        try {
          const run = await _cockpitServices.startWorkflowRun(param, inputs);
          return `[OK] Workflow "${param}" started. Run ID: ${run?.id || '(unknown)'}. Status: ${run?.status || 'running'}`;
        } catch (e) { return `Error: workflow start failed — ${e.message}`; }
      }

      case 'git-commit': {
        if (!param) return 'Error: project ID required. Usage: git-commit:PROJECT_ID';
        const commitProj = _cockpitServices?.getProjectById?.(param);
        if (!commitProj) return `Error: project "${param}" not found.`;
        try {
          await gitExec(commitProj.path, ['add', '-A']);
          const msg = extra?.trim() || `auto-commit by agent at ${new Date().toISOString().slice(0, 19)}`;
          const result = await gitExec(commitProj.path, ['commit', '-m', msg]);
          return `[OK] Committed to ${commitProj.name}:\n${result.slice(0, 500)}`;
        } catch (e) { return `Error: git commit failed — ${e.message}`; }
      }

      case 'git-push': {
        if (!param) return 'Error: project ID required. Usage: git-push:PROJECT_ID';
        const pushProj = _cockpitServices?.getProjectById?.(param);
        if (!pushProj) return `Error: project "${param}" not found.`;
        try {
          const result = await gitExec(pushProj.path, ['push']);
          return `[OK] Pushed ${pushProj.name}:\n${result.slice(0, 500)}`;
        } catch (e) { return `Error: git push failed — ${e.message}`; }
      }

      default:
        return `Error: unknown cockpit command "${cmd}". Available: usage, projects, project:ID, prs, prs:ID, sessions, notes, note:ID, note-create:TITLE, note-update:ID, system, briefing, alerts, activity, workflows, workflow:ID, workflow-runs, workflow-run:ID, workflow-start:ID, terminals, terminal-read:ID, terminal-input:ID:cmd, terminal-create:PROJ_ID[:cmd], git-commit:PROJ_ID, git-push:PROJ_ID`;
    }
  } catch (err) {
    return `Error: cockpit ${cmd} failed — ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// WEATHER — fetch weather via Open-Meteo
// ═══════════════════════════════════════════════════════

const WMO_WEATHER_KO = {0:'맑음',1:'대체로 맑음',2:'구름 조금',3:'흐림',45:'안개',48:'짙은 안개',51:'이슬비',53:'이슬비',55:'강한 이슬비',61:'약한 비',63:'비',65:'강한 비',71:'약한 눈',73:'눈',75:'강한 눈',77:'눈알갱이',80:'소나기',81:'강한 소나기',82:'폭우',85:'약한 눈소나기',86:'강한 눈소나기',95:'뇌우',96:'우박 뇌우',99:'강한 우박 뇌우'};
function wmoDesc(code) { return WMO_WEATHER_KO[code] ?? `코드${code}`; }
function windDir(deg) { const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']; return dirs[Math.round(deg/22.5)%16]; }

async function executeWeather(location) {
  if (!location?.trim()) return 'Error: location required. e.g. WEATHER 서울';
  const loc = location.trim();
  try {
    const geoResp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=ko`, { signal: AbortSignal.timeout(5000) });
    const geoData = await geoResp.json();
    const place = geoData.results?.[0];
    if (!place) return `Error: "${loc}" 위치를 찾을 수 없습니다.`;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia/Seoul&forecast_days=3`;
    const wxResp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const wx = await wxResp.json();
    const cur = wx.current || {};
    const areaName = place.name || loc;
    const country = place.country || '';

    const lines = [
      `[Weather: ${areaName}${country ? ', ' + country : ''}]`,
      `${wmoDesc(cur.weather_code)} | ${cur.temperature_2m}°C (체감 ${cur.apparent_temperature}°C)`,
      `습도: ${cur.relative_humidity_2m}% | 풍속: ${cur.wind_speed_10m}km/h ${windDir(cur.wind_direction_10m)} | 강수량: ${cur.precipitation}mm`,
    ];

    const daily = wx.daily;
    if (daily?.time?.length) {
      lines.push('', '[3-Day Forecast]');
      for (let i = 0; i < daily.time.length; i++) {
        lines.push(`${daily.time[i]}: ${daily.temperature_2m_min[i]}~${daily.temperature_2m_max[i]}°C | ${wmoDesc(daily.weather_code[i])}`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: weather fetch failed — ${e.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// DELEGATE — cross-agent task delegation
// ═══════════════════════════════════════════════════════

// This will be set by agent-service after runSubAgentLoop is available
let _runSubAgentLoop = null;

/** Set the sub-agent loop runner (called by agent-service to avoid circular deps) */
export function setSubAgentRunner(fn) {
  _runSubAgentLoop = fn;
}

const MAX_DELEGATE_DEPTH = 3; // A→B→C max, prevents infinite delegation chains

async function executeDelegateTask(arg, context) {
  if (!context?.convId) return 'Error: DELEGATE는 대화 컨텍스트가 필요합니다.';

  // Depth guard — prevent A→B→C→A infinite chains
  const depth = (context.delegateDepth || 0) + 1;
  if (depth > MAX_DELEGATE_DEPTH) {
    return `Error: 위임 깊이 제한 초과 (최대 ${MAX_DELEGATE_DEPTH}단계). 직접 처리하세요.`;
  }

  const lines = (arg || '').split('\n');
  let targetTeam = null, targetAgentId = null, taskDesc = '';
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('team:')) targetTeam = l.slice(5).trim();
    else if (l.startsWith('agent:')) targetAgentId = l.slice(6).trim();
    else if (l.startsWith('task:')) taskDesc = l.slice(5).trim();
    else if (!taskDesc && l) taskDesc = l;
  }

  if (!taskDesc) return 'Error: DELEGATE에 작업 설명(task:)이 필요합니다.';

  let targetProfile = null;
  if (targetAgentId && AGENT_PROFILES[targetAgentId]) {
    targetProfile = AGENT_PROFILES[targetAgentId];
  } else if (targetTeam) {
    targetProfile = pickAgentByComplexity(targetTeam, 'low');
    if (!targetProfile) return `Error: "${targetTeam}" 팀을 찾을 수 없습니다. 가능한 팀: dev, plan, design, admin, marketing`;
  } else {
    return 'Error: DELEGATE에 대상 팀(team:) 또는 에이전트(agent:)가 필요합니다.';
  }

  if (targetProfile.id === context.callerAgentId) {
    return 'Error: 자기 자신에게 위임할 수 없습니다. 직접 처리하세요.';
  }

  // Cycle detection — check if target is already in the delegation chain
  const chain = context.delegateChain || [];
  if (chain.includes(targetProfile.id)) {
    return `Error: 순환 위임 감지 (${[...chain, targetProfile.id].join('→')}). 직접 처리하세요.`;
  }

  const callerProfile = AGENT_PROFILES[context.callerAgentId];
  const callerName = callerProfile?.name || context.callerAgentId;

  console.log(`[DELEGATE] ${callerName} → ${targetProfile.name}(${targetProfile.id}): ${taskDesc.slice(0, 100)}`);

  if (_broadcast) _broadcast('orch:sub-start', {
    convId: context.convId,
    taskId: `delegate-${Date.now()}`,
    taskDesc,
    agentId: targetProfile.id,
    agentName: targetProfile.name,
    agentColor: targetProfile.color,
    delegatedBy: callerName,
  });

  if (!_runSubAgentLoop) return 'Error: sub-agent runner not initialized.';

  try {
    const task = { id: `d-${Date.now()}`, description: taskDesc, assignee: targetProfile.id };
    const depContext = `${callerName}이(가) 위임한 작업입니다.`;
    // Propagate delegation depth and chain for cycle/depth detection
    const delegateState = context.loopState || { aborted: false };
    delegateState._delegateDepth = depth;
    delegateState._delegateChain = [...chain, context.callerAgentId];
    const result = await _runSubAgentLoop(
      context.convId, task, targetProfile,
      depContext,
      taskDesc,
      delegateState
    );

    if (_broadcast) _broadcast('orch:sub-done', {
      convId: context.convId,
      taskId: task.id,
      agentId: targetProfile.id,
      agentName: targetProfile.name,
      result: (result || '').slice(0, 300),
    });

    return `[${targetProfile.name} 응답]\n${result}`;
  } catch (err) {
    if (_broadcast) _broadcast('orch:sub-error', {
      convId: context.convId,
      agentId: targetProfile.id,
      error: err.message,
    });
    return `Error: ${targetProfile.name} 위임 실패 — ${err.message}`;
  }
}

// ═══════════════════════════════════════════════════════
// CONSULT — structured deliberation between agents
// ═══════════════════════════════════════════════════════

/**
 * CONSULT: 다른 에이전트에게 의견을 구하고, 의견 충돌 시 토론 후 합의/상급자 판단.
 *
 * Flow:
 *  1. Target agent evaluates caller's position → agree/disagree + reasoning
 *  2. If disagree → caller gets one counter-round (via LLM)
 *  3. Still disagree → common superior judges
 *
 * Uses Gemini Flash for quick opinion calls (not full agent loop).
 */
async function executeConsult(arg, context) {
  if (!context?.convId) return 'Error: CONSULT는 대화 컨텍스트가 필요합니다.';
  if (!_GeminiClient || !_geminiApiKey) return 'Error: LLM 클라이언트가 초기화되지 않았습니다.';

  const lines = (arg || '').split('\n');
  let targetAgentId = null, topic = '', myView = '', bgContext = '';
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('agent:')) targetAgentId = l.slice(6).trim();
    else if (l.startsWith('topic:')) topic = l.slice(6).trim();
    else if (l.startsWith('my_view:')) myView = l.slice(8).trim();
    else if (l.startsWith('context:')) bgContext = l.slice(8).trim();
    else if (!topic && l) topic = l;
  }

  if (!topic) return 'Error: CONSULT에 주제(topic:)가 필요합니다.';
  if (!targetAgentId || !AGENT_PROFILES[targetAgentId]) {
    return `Error: 대상 에이전트를 찾을 수 없습니다. agent:에이전트ID 형식으로 지정하세요.`;
  }
  if (targetAgentId === context.callerAgentId) {
    return 'Error: 자기 자신에게 의견을 구할 수 없습니다.';
  }

  const caller = AGENT_PROFILES[context.callerAgentId];
  const target = AGENT_PROFILES[targetAgentId];
  const callerName = caller?.name || context.callerAgentId;
  const targetName = target.name;

  console.log(`[CONSULT] ${callerName} ↔ ${targetName}: ${topic.slice(0, 80)}`);

  _broadcast('consult:start', {
    convId: context.convId,
    callerId: context.callerAgentId, callerName,
    targetId: targetAgentId, targetName,
    topic, callerView: myView,
  });

  const gem = new _GeminiClient(_geminiApiKey, 'gemini-2.5-flash');

  // ── Round 1: Target evaluates ──
  const round1Prompt = `너는 ${targetName}(${target.rank}, ${target.team ? target.team + '팀' : '무소속'})이야.
${target.persona}

${callerName}(${caller?.rank || '?'})이(가) 너에게 의견을 구한다:

주제: ${topic}
${callerName}의 견해: ${myView || '(의견 없이 자문 요청)'}
${bgContext ? `배경: ${bgContext}` : ''}

너의 전문 분야 관점에서 평가해. 반드시 아래 JSON으로만 답변:
{"stance":"agree|disagree|partial","reasoning":"왜 그렇게 생각하는지 2-3문장","suggestion":"너의 대안/보완 제안 (동의하면 빈 문자열)"}`;

  let round1Raw;
  try {
    round1Raw = await gem.send('JSON만 출력. 첫 글자 {, 마지막 글자 }.', round1Prompt, { timeoutMs: 15000 });
  } catch (err) {
    return `Error: ${targetName} 응답 실패 — ${err.message}`;
  }

  let round1;
  try {
    let cleaned = round1Raw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    round1 = JSON.parse(cleaned.trim());
  } catch {
    // If JSON parse fails, treat as disagreement with raw text as reasoning
    round1 = { stance: 'partial', reasoning: round1Raw.slice(0, 300), suggestion: '' };
  }

  _broadcast('consult:round', {
    convId: context.convId, round: 1,
    agentId: targetAgentId, agentName: targetName,
    stance: round1.stance,
    reasoning: round1.reasoning,
    suggestion: round1.suggestion,
  });

  console.log(`[CONSULT] R1: ${targetName} stance=${round1.stance}`);

  // ── If agree/partial → done ──
  if (round1.stance === 'agree') {
    const result = `[의견 조율 완료 — 합의]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n결과: ${targetName} 동의\n${round1.reasoning}`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'agreed', decidedBy: null, result });
    return result;
  }

  if (round1.stance === 'partial') {
    const result = `[의견 조율 완료 — 부분 합의]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n${targetName} 의견: ${round1.reasoning}\n보완 제안: ${round1.suggestion || '(없음)'}`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'partial', decidedBy: null, result });
    return result;
  }

  // ── Round 2: Caller counter-argues ──
  const round2Prompt = `너는 ${callerName}(${caller?.rank || '?'})이야.
${caller?.persona || ''}

네가 "${topic}"에 대해 "${myView}" 의견을 냈는데,
${targetName}(${target.rank})이(가) 반박했다:
- 입장: 반대
- 근거: ${round1.reasoning}
- 대안: ${round1.suggestion || '없음'}

${targetName}의 반박을 듣고 나서, 너의 최종 입장을 정해.
반드시 아래 JSON으로만 답변:
{"stance":"accept|insist|revise","reasoning":"왜 그렇게 결정했는지 2-3문장","revised_view":"수정된 의견 (accept/insist면 빈 문자열)"}`;

  let round2Raw;
  try {
    round2Raw = await gem.send('JSON만 출력. 첫 글자 {, 마지막 글자 }.', round2Prompt, { timeoutMs: 15000 });
  } catch {
    // Caller round failed — default to target's view
    const result = `[의견 조율 완료 — ${targetName} 의견 채택]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n${callerName} 원래 의견: ${myView}\n${targetName} 반박: ${round1.reasoning}\n결론: ${callerName} 응답 실패로 ${targetName} 의견 채택\n제안: ${round1.suggestion || round1.reasoning}`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'target_wins', decidedBy: targetName, result });
    return result;
  }

  let round2;
  try {
    let cleaned = round2Raw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    round2 = JSON.parse(cleaned.trim());
  } catch {
    round2 = { stance: 'accept', reasoning: round2Raw.slice(0, 300), revised_view: '' };
  }

  _broadcast('consult:round', {
    convId: context.convId, round: 2,
    agentId: context.callerAgentId, agentName: callerName,
    stance: round2.stance,
    reasoning: round2.reasoning,
  });

  console.log(`[CONSULT] R2: ${callerName} stance=${round2.stance}`);

  // ── If caller accepts or revises → done ──
  if (round2.stance === 'accept') {
    const result = `[의견 조율 완료 — ${callerName} 수용]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n${callerName} 원래 의견: ${myView}\n${targetName} 반박: ${round1.reasoning}\n결론: ${callerName}이(가) ${targetName}의 의견을 수용함\n채택된 방향: ${round1.suggestion || round1.reasoning}`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'caller_accepted', decidedBy: callerName, result });
    return result;
  }

  if (round2.stance === 'revise') {
    const result = `[의견 조율 완료 — 절충안 합의]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n${callerName} 원래 의견: ${myView}\n${targetName} 반박: ${round1.reasoning}\n${callerName} 수정안: ${round2.revised_view || round2.reasoning}\n결론: 양측 의견을 반영한 절충안 도출`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'compromised', decidedBy: null, result });
    return result;
  }

  // ── Round 3: Still insisting → escalate to common superior ──
  const superior = findCommonSuperior(context.callerAgentId, targetAgentId);

  console.log(`[CONSULT] Escalating to ${superior.name}(${superior.id})`);

  _broadcast('consult:escalate', {
    convId: context.convId,
    superiorId: superior.id, superiorName: superior.name,
    callerView: myView, targetView: round1.suggestion || round1.reasoning,
  });

  const judgePrompt = `너는 ${superior.name}(${superior.rank})이야.
${superior.persona}

부하 직원 2명이 의견 충돌로 너에게 판단을 요청했다:

주제: ${topic}

${callerName}(${caller?.rank || '?'}) 의견: ${myView}
- 고집 근거: ${round2.reasoning}

${targetName}(${target.rank}) 의견: ${round1.suggestion || round1.reasoning}
- 반박 근거: ${round1.reasoning}

상급자로서 최종 판단을 내려. 어느 쪽이든 택하거나, 새로운 방향을 제시해도 된다.
반드시 아래 JSON으로만 답변:
{"decision":"caller|target|new","reasoning":"판단 근거 2-3문장","final_direction":"최종 방향/지시사항"}`;

  let judgeRaw;
  try {
    judgeRaw = await gem.send('JSON만 출력. 첫 글자 {, 마지막 글자 }.', judgePrompt, { timeoutMs: 15000 });
  } catch (err) {
    // Judge failed — higher rank wins by default
    const callerRank = getRankLevel(context.callerAgentId);
    const targetRank = getRankLevel(targetAgentId);
    const winner = callerRank >= targetRank ? callerName : targetName;
    const winnerView = callerRank >= targetRank ? myView : (round1.suggestion || round1.reasoning);
    const result = `[의견 조율 완료 — 직급 우선]\n참여: ${callerName}, ${targetName}\n주제: ${topic}\n상급자(${superior.name}) 판단 실패로 직급 높은 쪽(${winner}) 의견 채택\n채택된 방향: ${winnerView}`;
    _broadcast('consult:resolved', { convId: context.convId, outcome: 'rank_default', decidedBy: winner, result });
    return result;
  }

  let judge;
  try {
    let cleaned = judgeRaw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    judge = JSON.parse(cleaned.trim());
  } catch {
    judge = { decision: 'new', reasoning: judgeRaw.slice(0, 300), final_direction: judgeRaw.slice(0, 200) };
  }

  const decisionLabel = judge.decision === 'caller' ? `${callerName} 의견 채택`
    : judge.decision === 'target' ? `${targetName} 의견 채택`
    : '새로운 방향 제시';

  const result = `[의견 조율 완료 — 상급자(${superior.name}) 최종 판단]\n참여: ${callerName}, ${targetName}, ${superior.name}(심판)\n주제: ${topic}\n${callerName} 의견: ${myView}\n${targetName} 의견: ${round1.suggestion || round1.reasoning}\n\n--- 최종 판단 ---\n판정: ${decisionLabel}\n근거: ${judge.reasoning}\n최종 방향: ${judge.final_direction}`;

  _broadcast('consult:resolved', {
    convId: context.convId,
    outcome: 'superior_judged',
    decidedBy: superior.name,
    decision: judge.decision,
    result,
  });

  return result;
}

// ═══════════════════════════════════════════════════════
// Unified tool dispatcher
// ═══════════════════════════════════════════════════════

/** Unified tool dispatcher — context is optional, used by DELEGATE */
export async function executeTool(type, arg, context) {
  switch (type) {
    case 'BASH':     return executeBash(arg);
    case 'READ':     return executeRead(arg);
    case 'SEARCH':   return executeSearch(arg);
    case 'EDIT':     return executeEdit(arg);
    case 'WRITE':    return executeWrite(arg);
    case 'GLOB':     return executeGlob(arg);
    case 'GIT_DIFF': return executeGitDiff(arg);
    case 'GIT_LOG':  return executeGitLog(arg);
    case 'JIRA':     return executeJira(arg);
    case 'CICD':     return executeCicd(arg);
    case 'OPEN':     return executeOpen(arg);
    case 'COCKPIT':  return executeCockpit(arg);
    case 'WEATHER':  return executeWeather(arg);
    case 'DELEGATE': return executeDelegateTask(arg, context);
    case 'CONSULT':  return executeConsult(arg, context);
    default:         return `Error: unknown tool "${type}"`;
  }
}

/** Build EDIT arg string from structured fields */
export function buildEditArg(tc) {
  if (tc.file && tc.oldContent !== undefined && tc.newContent !== undefined) {
    return `${tc.file}\nOLD_CONTENT\n<<<\n${tc.oldContent}\n>>>\nNEW_CONTENT\n<<<\n${tc.newContent}\n>>>`;
  }
  return tc.arg; // fallback: legacy format
}

/** Build WRITE arg string from structured fields */
export function buildWriteArg(tc) {
  if (tc.file && tc.content !== undefined) {
    return `${tc.file}\n${tc.content}`;
  }
  return tc.arg; // fallback: legacy format
}

// ═══════════════════════════════════════════════════════
// Response Parsing
// ═══════════════════════════════════════════════════════

/**
 * Parse agent response — tries JSON first, falls back to legacy regex.
 * Returns { structured, thinking, message, toolCalls, isFinal }
 */
export function parseAgentResponse(text, userMessage = '') {
  // Strip outermost markdown code fences if model wraps JSON in ```
  let cleaned = text.trim();
  if (/^```(?:json)?\s*\n/.test(cleaned) && cleaned.endsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = cleaned.slice(firstNewline + 1, cleaned.length - 3).trim();
  } else {
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
  }

  // Try JSON parsing (structured output)
  const jsonResult = tryParseStructuredJson(cleaned);
  if (jsonResult) return jsonResult;

  // Try extracting embedded JSON from mixed text
  const jsonMatch = text.match(/\{[\s\S]*"thinking"\s*:\s*"[\s\S]*"is_final"\s*:\s*(true|false)[\s\S]*\}/);
  if (jsonMatch) {
    const embedded = tryParseStructuredJson(jsonMatch[0]);
    if (embedded) return embedded;
  }

  // Legacy fallback: regex extraction (@@TOOL:TYPE@@arg@@END@@)
  const toolCalls = [];
  const regex = /@@TOOL:(\w+)@@([\s\S]+?)@@END@@/g;
  let match;
  while ((match = regex.exec(text)) !== null && toolCalls.length < MAX_TOOLS_PER_TURN) {
    toolCalls.push({ type: match[1], arg: match[2].trim(), index: match.index });
  }

  if (toolCalls.length) {
    const textBefore = text.slice(0, toolCalls[0].index).trim();
    const thinkMatch = textBefore.match(/<thinking>([\s\S]*?)<\/thinking>/);
    return {
      structured: false,
      thinking: thinkMatch ? thinkMatch[1].trim() : '',
      message: textBefore.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim(),
      toolCalls: toolCalls.map(tc => ({ type: tc.type, arg: tc.arg })),
      isFinal: false,
    };
  }

  // Plain text fallback
  const plainMessage = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  const implicitTools = detectImplicitTools(plainMessage, userMessage);

  return {
    structured: false,
    thinking: '',
    message: plainMessage,
    toolCalls: implicitTools,
    isFinal: implicitTools.length === 0,
    implicit: implicitTools.length > 0,
  };
}

/** Try parsing a string as structured JSON agent response */
function tryParseStructuredJson(str) {
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed.thinking === 'string' && typeof parsed.is_final === 'boolean') {
      const rawCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
      const validCalls = rawCalls
        .filter(tc => tc && typeof tc.tool === 'string' && tc.tool.trim())
        .slice(0, MAX_TOOLS_PER_TURN)
        .map(tc => ({
          type: tc.tool.toUpperCase(),
          arg: tc.argument != null ? String(tc.argument) : '',
          file: tc.file,
          oldContent: tc.old_content,
          newContent: tc.new_content,
          content: tc.content,
        }));

      return {
        structured: true,
        thinking: parsed.thinking || '',
        message: typeof parsed.message === 'string' ? parsed.message : '',
        toolCalls: validCalls,
        isFinal: parsed.is_final,
      };
    }
  } catch { /* not valid JSON */ }
  return null;
}

/** Detect implicit tool usage from plain text response */
function detectImplicitTools(text, userMessage = '') {
  const tools = [];
  const source = userMessage || text;

  if (/유튜브|youtube|노래|음악|틀어|재생|play|music|lofi|로파이/i.test(source)) {
    const searchTerms = source
      .replace(/[~!?.,…]+/g, '')
      .replace(/유튜브에서|유튜브로|유튜브|youtube에서|youtube/gi, '')
      .replace(/에서|에|를|을|좀|해|줘|드릴|께|영|봐|라|한번|좀|틀어|재생|play/g, '')
      .trim();
    if (searchTerms) {
      const query = encodeURIComponent(searchTerms).replace(/%20/g, '+');
      tools.push({ type: 'OPEN', arg: `https://www.youtube.com/results?search_query=${query}` });
    }
  }
  if (/구글|google|검색해|search/i.test(source) && tools.length === 0) {
    const searchTerms = source.replace(/구글|google|검색|search|해|줘|볼|께|영|에서/gi, '').trim();
    if (searchTerms) {
      const query = encodeURIComponent(searchTerms).replace(/%20/g, '+');
      tools.push({ type: 'OPEN', arg: `https://www.google.com/search?q=${query}` });
    }
  }
  return tools;
}
