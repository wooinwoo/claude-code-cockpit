// ─── Logs Service: Project log file discovery & tailing ───
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

// Common log file patterns
const LOG_PATTERNS = [
  '*.log', '*.log.*',
  'logs/**', 'log/**',
  '.next/server/*.log',
  'npm-debug.log*', 'yarn-error.log',
  'tmp/*.log',
];

const LOG_EXTENSIONS = new Set(['.log', '.err', '.out']);
const LOG_NAMES = new Set(['debug.log', 'error.log', 'access.log', 'app.log', 'server.log', 'npm-debug.log', 'yarn-error.log']);

// ─── Discover Log Files ───
export async function discoverLogFiles(projectPath, maxDepth = 3) {
  const results = [];
  await walk(projectPath, projectPath, 0, maxDepth, results);
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, 50); // cap at 50 files
}

async function walk(base, dir, depth, maxDepth, results) {
  if (depth > maxDepth) return;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue;
        if (['logs', 'log', 'tmp'].includes(e.name) || depth < 2) {
          await walk(base, full, depth + 1, maxDepth, results);
        }
      } else if (isLogFile(e.name)) {
        try {
          const s = await stat(full);
          if (s.size > 0 && s.size < 100 * 1024 * 1024) { // skip >100MB
            results.push({ path: full, name: e.name, relative: relative(base, full), size: s.size, mtime: s.mtimeMs });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* permission denied etc */ }
}

function isLogFile(name) {
  if (LOG_NAMES.has(name)) return true;
  const ext = extname(name);
  if (LOG_EXTENSIONS.has(ext)) return true;
  if (name.match(/\.log\.\d+$/)) return true;
  return false;
}

// ─── Read Log Tail ───
export async function readLogTail(filePath, lines = 500) {
  if (!existsSync(filePath)) return { error: 'File not found', lines: [] };
  const raw = await readFile(filePath, 'utf8');
  const allLines = raw.split('\n');
  const tail = allLines.slice(-lines);
  return { path: filePath, name: basename(filePath), totalLines: allLines.length, lines: tail };
}

// ─── Read Log with Offset ───
export async function readLogRange(filePath, offset = 0, limit = 200) {
  if (!existsSync(filePath)) return { error: 'File not found', lines: [] };
  const raw = await readFile(filePath, 'utf8');
  const allLines = raw.split('\n');
  const slice = allLines.slice(offset, offset + limit);
  return { path: filePath, totalLines: allLines.length, offset, lines: slice };
}

// ─── Parse Log Level ───
export function parseLogLevels(lines) {
  const counts = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('err]') || lower.includes('[error')) counts.error++;
    else if (lower.includes('warn') || lower.includes('[warn')) counts.warn++;
    else if (lower.includes('info') || lower.includes('[info')) counts.info++;
    else if (lower.includes('debug') || lower.includes('[debug')) counts.debug++;
    else counts.other++;
  }
  return counts;
}
