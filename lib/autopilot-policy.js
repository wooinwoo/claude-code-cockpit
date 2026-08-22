/**
 * Autopilot policy — deterministic classifier for unattended agent operation.
 *
 * Goal: let Claude Code agents run unsupervised (e.g. overnight) while a human is
 * only pinged for the decisions that actually matter. Derived from 5,096 real
 * supervisor decisions (logs/decisions.jsonl): 98.1% were auto-approved, and the
 * ~2% that were blocked or escalated clustered into clear categories —
 * cloud-resource deletes, production deploys/DB access, force-pushes, secret
 * files, and system-destructive commands.
 *
 * Where the old supervisor sent 47% of calls to an LLM to make this judgment, this
 * table turns the dangerous cases into deterministic rules: instant, free, and
 * validated against every historical decision (see autopilot-policy.test.js).
 *
 * classify() returns one of four actions:
 *   'auto'     — safe to run unattended
 *   'escalate' — reversible-but-risky / production impact → ask a human (phone)
 *   'block'    — irreversible destruction / secret exposure → never auto-run
 *   'review'   — unknown; caller decides (LLM tier, or escalate in unattended mode)
 */

// Read-only / inert tools — always safe.
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebFetch', 'WebSearch',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'ToolSearch',
]);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Secret / system paths — editing these is never auto-approved.
const DANGER_PATHS = [
  /^\/etc\//, /^\/usr\//, /^\/boot\//, /^\/bin\//, /^\/sbin\//, /^\/var\/lib\//,
  /^\/root\//, /\/\.ssh\//, /\/\.aws\//, /\/\.gnupg\//, /\/\.docker\/config\.json$/,
  /\/id_rsa(\.pub)?$/, /\/id_ed25519(\.pub)?$/, /\/\.bash_history$/,
  /\.env(\.|$)/, /\/credentials(\.json)?$/, /\.pem$/, /\.key$/, /\.crt$/,
];

// Sensitive-but-sometimes-legitimate config — escalate rather than block.
const CONFIG_PATHS = [
  /\/\.claude\/settings(\.local)?\.json$/,
  /\/\.claude\/.*\.(json|md)$/,
  /\/lib\/supervisor-service\.js$/,   // the policy modifying itself
  /\/lib\/autopilot-policy\.js$/,
];

// Irreversible destruction / privilege / publish → hard block.
const DANGER_PATTERNS = [
  /\brm\s+-rf?\s+\//, /\brm\s+-rf?\s+~/, /\brm\s+-rf?\s+\$HOME/,
  /:\(\)\s*\{\s*:\|:&\s*\}/, /\bmkfs\./, /\bdd\s+if=.*of=\/dev/, />\s*\/dev\/sd[a-z]/,
  /\bsudo\s+(rm|chmod|chown|dd|mkfs|systemctl|service|reboot|shutdown|halt|poweroff|kill)/,
  /\bsudo\s+-(i|s)\b/, /\bchmod\s+-?R?\s*[0-7]{3,4}\s+\//, /\bchown\s+-?R?\s*root\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/, /\bkill\s+-9\s+1\b/, /\binit\s+[06]\b/,
  /\biptables\s+.*-j\s+DROP/i, /\bufw\s+(disable|delete)\b/i, /\bcrontab\s+-r\b/,
  /\bgit\s+push\s+--force(?!-with-lease)/, /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\s+(origin|HEAD~|[0-9a-f]{7,})/, /\bgit\s+clean\s+-[fdx]+/, /\bgit\s+filter-(branch|repo)/,
  /\bnpm\s+publish\b/, /\bnpm\s+unpublish\b/, /\bnpm\s+install\s+(-g|--global)\b/,
  /\bpnpm\s+(publish|unpublish)\b/, /\byarn\s+publish\b/,
  /\bcurl\s+[^|]*\|\s*(bash|sh|zsh)\b/, /\bwget\s+[^|]*\|\s*(bash|sh|zsh)\b/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)/i, /\bTRUNCATE\s+TABLE/i, /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i,
];

// Production / cloud / deploy impact → escalate to a human (reversible-with-effort,
// or plain risky). These are the cases the old supervisor spent an LLM call to catch.
const ESCALATE_PATTERNS = [
  // Cloud CLIs — mutating verbs only (describe/list/get stay safe)
  /\baws\s+s3\s+rm\b/, /\baws\s+s3\s+(cp|sync)\b[^|]*--delete\b/,
  /\baws\s+\S+\s+(delete|remove|rm|modify|create|put|update|start|stop|terminate|reboot|deregister|disable|detach|revoke|associate|disassociate|rb)\b/i,
  /\bgcloud\s+\S+.*\s(delete|create|update|remove|set)\b/i,
  /\baz\s+\S+\s+(delete|create|update)\b/i,
  /\bkubectl\s+(delete|apply|scale|drain|cordon|uncordon|patch|replace|rollout|set)\b/,
  /\bterraform\s+(destroy|apply)\b/, /\beksctl\s+(delete|create)\b/, /\bhelm\s+(install|upgrade|uninstall|delete|rollback)\b/,
  /\bdoctl\s+\S+\s+delete\b/, /\bflyctl?\s+(deploy|destroy|scale)\b/, /\bvercel\s+(deploy|--prod|rm|remove)\b/,
  // boto3 / cloud SDK mutations inside inline scripts
  /boto3[\s\S]*\.\s*(delete|create|modify|put|update|terminate|stop|disable|remove|reboot|associate|revoke)_?\w*\s*\(/,
  // Production deploy / migrate
  /NODE_ENV=production/, /--to=production\b/, /--env[= ]prod(uction)?\b/,
  /\bnpm\s+run\s+deploy\b/, /\byarn\s+deploy\b/, /\bpnpm\s+(run\s+)?deploy\b/,
  /\bdrizzle-kit\s+(migrate|push)\b/, /\bprisma\s+migrate\s+deploy\b/, /\bknex\s+migrate/,
  /\bserverless\s+deploy\b/, /\bsls\s+deploy\b/, /\bcdk\s+(deploy|destroy)\b/, /\bsam\s+deploy\b/,
  // Production git push (non-force; force is blocked above)
  /\bgit\s+push\b[^\n]*\b(prod|production|release|main|master)\b/,
  /\bgit\s+push\s+\S+\s+\S+:(prod|production|release|main|master)\b/,
  // Remote / production database access
  /\b(mysql|psql|mongo|mongosh|redis-cli|mysqldump|pg_dump|pg_restore)\b[^|]*\s-h\s/,
  /\bMYSQL_PWD=/, /\bPGPASSWORD=/,
  // Service lifecycle (non-sudo systemctl, custom restart scripts)
  /\bsystemctl\s+(--user\s+)?(restart|start|stop|reload)\b/, /\brestart[-_].*prod|prod.*restart/i,
  /\bpm2\s+(restart|reload|stop|delete)\b/, /\bdocker\s+(rm|rmi|prune|stop|kill|system\s+prune)\b/,
  /\bdocker\s+compose\s+(down|rm)\b/,
];

function testAny(patterns, s) {
  return patterns.some((r) => r.test(s));
}

/**
 * Classify a proposed tool call for unattended execution.
 * @param {string} tool - tool name (Bash, Edit, Write, Read, mcp__*, ...)
 * @param {object} [input] - tool input ({ command } for Bash, { file_path } for edits)
 * @returns {{action: 'auto'|'escalate'|'block'|'review', category: string, reason: string}}
 */
export function classify(tool, input = {}) {
  // Read-only tools and browser/inspection MCP tools are inert.
  if (SAFE_TOOLS.has(tool)) {
    return { action: 'auto', category: 'read-only', reason: `${tool} is read-only/inert` };
  }
  if (tool.startsWith('mcp__playwright__') || tool.startsWith('mcp__')) {
    // Browser automation and most MCP tools are local/dev-scoped.
    const risky = /run_code_unsafe|file_upload/.test(tool);
    return risky
      ? { action: 'review', category: 'mcp-risky', reason: `${tool} can execute arbitrary code` }
      : { action: 'auto', category: 'mcp', reason: `${tool} is dev-scoped automation` };
  }

  if (EDIT_TOOLS.has(tool)) {
    const p = input.file_path || input.path || input.notebook_path || '';
    if (DANGER_PATHS.some((r) => r.test(p))) {
      return { action: 'block', category: 'secret-path', reason: `edit to protected path: ${redactPath(p)}` };
    }
    if (CONFIG_PATHS.some((r) => r.test(p))) {
      return { action: 'escalate', category: 'config', reason: `edit to sensitive config: ${redactPath(p)}` };
    }
    return { action: 'auto', category: 'edit-safe', reason: 'edit on ordinary path' };
  }

  if (tool === 'Bash') {
    const cmd = input.command || '';
    if (testAny(DANGER_PATTERNS, cmd)) {
      return { action: 'block', category: 'destructive', reason: 'matches irreversible-danger pattern' };
    }
    if (testAny(ESCALATE_PATTERNS, cmd)) {
      return { action: 'escalate', category: 'production', reason: 'production / cloud / deploy impact' };
    }
    if (SAFE_BASH.test(cmd)) {
      return { action: 'auto', category: 'bash-safe', reason: 'common read-only shell command' };
    }
    return { action: 'review', category: 'bash-unknown', reason: 'no rule matched — needs judgment' };
  }

  // Unknown tool — be conservative.
  return { action: 'review', category: 'unknown-tool', reason: `unclassified tool: ${tool}` };
}

// Read-only / near-safe shell commands (whitelist prefix match).
const SAFE_BASH = /^(ls|pwd|cat|head|tail|echo|jq|find|grep|rg|wc|stat|file|which|env|date|whoami|hostname|uname|tree|du|df|ps|node\s+--version|npm\s+(test|run|ls|outdated|view|info|whoami)|pnpm\s+(test|run|ls|outdated|view|info|why)|yarn\s+(test|run|info|why)|git\s+(status|log|diff|branch|show|fetch|remote))(\s|$)/;

/** Strip a home dir / user from a path for logs. */
function redactPath(p) {
  return String(p).replace(/\/home\/[^/]+/, '~').replace(/\/Users\/[^/]+/, '~');
}

/** True when the action is safe to run without a human in the loop. */
export function isAutoRunnable(action) {
  return action === 'auto';
}

export const _internals = { SAFE_TOOLS, EDIT_TOOLS, DANGER_PATHS, CONFIG_PATHS, DANGER_PATTERNS, ESCALATE_PATTERNS, SAFE_BASH };
