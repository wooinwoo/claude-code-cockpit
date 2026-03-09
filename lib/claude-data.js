/**
 * @typedef {Object} SessionState
 * @property {string} projectId
 * @property {'no_data'|'no_sessions'|'idle'|'busy'|'waiting'} state
 * @property {string|null} sessionId
 * @property {string|null} lastActivity - ISO timestamp
 * @property {string|null} model - Short model name (e.g. "opus-4-5")
 * @property {number} [sessionCount]
 */

/**
 * @typedef {Object} SessionInfo
 * @property {string} sessionId
 * @property {string} lastModified - ISO timestamp
 * @property {number} sizeKB
 */

/**
 * @typedef {Object} ActivityEntry
 * @property {string} command
 * @property {string} project - Project basename
 * @property {string} projectPath
 * @property {string} sessionId
 * @property {string} timestamp - ISO timestamp
 */

/**
 * @typedef {Object} DiscoveredProject
 * @property {string} path
 * @property {string} name
 * @property {boolean} hasGit
 * @property {number} sessionCount
 * @property {string|null} lastActivity - ISO timestamp
 * @property {boolean} [wsl]
 * @property {string} [distro]
 */

/**
 * @typedef {Object} SessionMessage
 * @property {'user'|'assistant'} role
 * @property {string} content
 * @property {Array<{name: string, input: string}>} [tools]
 * @property {string} [model]
 * @property {string} [ts]
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {string} ts - ISO timestamp
 * @property {'tool'|'commit'} type
 * @property {string} [name] - Tool name
 * @property {string} [detail]
 * @property {string} [action]
 * @property {string} [id] - Tool use ID
 */

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { CLAUDE_PROJECTS_DIR, HISTORY_PATH, CLAUDE_DIR, toClaudeProjectDir } from './config.js';

/**
 * Read last N lines from a file efficiently (reads from end).
 * @param {string} filePath
 * @param {number} [numLines=5]
 * @returns {string[]}
 */
function readLastLines(filePath, numLines = 5) {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return [];
    const fd = openSync(filePath, 'r');
    const bufSize = Math.min(st.size, 16384);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, Math.max(0, st.size - bufSize));
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-numLines);
  } catch {
    return [];
  }
}

/**
 * Parse a single JSONL line safely
 */
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Get the Claude project directory path for a project
 */
function getProjectJsonlDir(projectPath) {
  const dirName = toClaudeProjectDir(projectPath);
  const fullPath = join(CLAUDE_PROJECTS_DIR, dirName);
  if (existsSync(fullPath)) return fullPath;

  // Claude's drive letter casing varies (C vs c) — try case-insensitive match
  try {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
    const dirNameLower = dirName.toLowerCase();
    const exact = dirs.find(d => d.toLowerCase() === dirNameLower);
    if (exact) return join(CLAUDE_PROJECTS_DIR, exact);

    // Fallback: partial match on project basename
    const baseName = projectPath.split('/').pop().toLowerCase();
    const partial = dirs.find(d => d.toLowerCase().endsWith(baseName));
    if (partial) return join(CLAUDE_PROJECTS_DIR, partial);
  } catch { /* ignore */ }

  return null;
}

/**
 * Detect session state for a project based on JSONL file activity.
 * @param {{id: string, path: string}} project
 * @returns {SessionState}
 */
export function detectSessionState(project) {
  const dir = getProjectJsonlDir(project.path);
  if (!dir) return { projectId: project.id, state: 'no_data', sessionId: null, lastActivity: null, model: null };

  let files;
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const st = statSync(join(dir, f));
        return { name: f, sessionId: f.replace('.jsonl', ''), mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { projectId: project.id, state: 'no_data', sessionId: null, lastActivity: null, model: null };
  }

  if (files.length === 0) {
    return { projectId: project.id, state: 'no_sessions', sessionId: null, lastActivity: null, model: null };
  }

  const latest = files[0];
  const ageMs = Date.now() - latest.mtime;
  const lastActivity = new Date(latest.mtime).toISOString();

  // Read last few lines to determine state
  const lastLines = readLastLines(join(dir, latest.name), 3);
  let lastEntry = null;
  let model = null;
  for (let i = lastLines.length - 1; i >= 0; i--) {
    const parsed = parseJsonLine(lastLines[i]);
    if (parsed) {
      lastEntry = parsed;
      if (parsed.message?.model) {
        model = parsed.message.model
          .replace('claude-', '')
          .replace(/-\d{8}$/, '');
      }
      break;
    }
  }

  let state = 'idle';
  if (ageMs < 15000) {
    state = 'busy';
  } else if (ageMs < 300000) {
    state = lastEntry?.type === 'assistant' ? 'waiting' : 'idle';
  }

  return {
    projectId: project.id,
    state,
    sessionId: latest.sessionId,
    lastActivity,
    model,
    sessionCount: files.length
  };
}

/**
 * Get list of sessions for a project.
 * @param {{id: string, path: string}} project
 * @param {number} [limit=10]
 * @returns {SessionInfo[]}
 */
export function getProjectSessions(project, limit = 10) {
  const dir = getProjectJsonlDir(project.path);
  if (!dir) return [];

  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const st = statSync(join(dir, f));
        return {
          sessionId: f.replace('.jsonl', ''),
          lastModified: new Date(st.mtimeMs).toISOString(),
          sizeKB: Math.round(st.size / 1024)
        };
      })
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get recent activity across all projects from history.jsonl.
 * Uses efficient tail-read instead of loading entire file.
 * @param {number} [limit=30]
 * @returns {ActivityEntry[]}
 */
export function getRecentActivity(limit = 30) {
  // Read from end of file efficiently
  const lines = readLastLines(HISTORY_PATH, limit * 3);
  const entries = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonLine(lines[i]);
    if (entry && entry.project) {
      entries.push({
        command: entry.display || '',
        project: entry.project.replace(/\\/g, '/').split('/').pop(),
        projectPath: entry.project.replace(/\\/g, '/'),
        sessionId: entry.sessionId,
        timestamp: new Date(entry.timestamp).toISOString()
      });
      if (entries.length >= limit) break;
    }
  }

  return entries;
}

/**
 * Discover all projects Claude Code has been used with.
 * Reads ~/.claude/projects dirs + history.jsonl for real paths.
 * @param {string[]} [existingPaths] - Already-registered project paths to exclude
 * @returns {DiscoveredProject[]}
 */
export function discoverProjects(existingPaths) {
  const existingSet = new Set((existingPaths || []).map(p => p.replace(/\\/g, '/').toLowerCase()));
  const discovered = new Map(); // path → info

  // 1. Read history.jsonl for all unique project paths
  try {
    if (existsSync(HISTORY_PATH)) {
      const content = readFileSync(HISTORY_PATH, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const entry = parseJsonLine(line);
        if (entry?.project) {
          const p = entry.project.replace(/\\/g, '/');
          const key = p.toLowerCase();
          if (!existingSet.has(key) && !discovered.has(key)) {
            discovered.set(key, { path: p, name: p.split('/').pop(), source: 'history' });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Scan ~/.claude/projects directories, extract cwd from JSONL files
  try {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dirName of dirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
      try {
        const st = statSync(dirPath);
        if (!st.isDirectory()) continue;
      } catch { continue; }

      // Check if this dir already matches a discovered path
      const dirNameLower = dirName.toLowerCase();
      const alreadyFound = [...discovered.values()].some(d => {
        const encoded = d.path.replace(/\\/g, '/').replace(/[^a-zA-Z0-9]/g, '-');
        return encoded.toLowerCase() === dirNameLower;
      });
      if (alreadyFound) continue;

      // Also check existing projects
      const alreadyExisting = [...existingSet].some(p => {
        const encoded = p.replace(/[^a-zA-Z0-9]/g, '-');
        return encoded === dirNameLower;
      });
      if (alreadyExisting) continue;

      // Read most recent JSONL file to extract cwd
      try {
        const files = readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: statSync(join(dirPath, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          let foundCwd = false;
          const lines = readLastLines(join(dirPath, files[0].name), 20);
          for (const line of lines) {
            const entry = parseJsonLine(line);
            if (entry?.cwd) {
              const p = entry.cwd.replace(/\\/g, '/');
              const key = p.toLowerCase();
              if (!existingSet.has(key) && !discovered.has(key)) {
                discovered.set(key, { path: p, name: p.split('/').pop(), source: 'session', sessionCount: files.length });
              }
              foundCwd = true;
              break;
            }
          }
          // If no cwd found from tail, try reading from the start
          if (!foundCwd) {
            const firstLines = readFirstLines(join(dirPath, files[0].name), 20);
            for (const line of firstLines) {
              const entry = parseJsonLine(line);
              if (entry?.cwd) {
                const p = entry.cwd.replace(/\\/g, '/');
                const key = p.toLowerCase();
                if (!existingSet.has(key) && !discovered.has(key)) {
                  discovered.set(key, { path: p, name: p.split('/').pop(), source: 'session', sessionCount: files.length });
                }
                break;
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // 3. Scan WSL distributions for Claude projects
  try {
    const wslOutput = execSync('wsl -l -q', { encoding: 'utf16le', timeout: 5000, windowsHide: true }).trim();
    const distros = wslOutput.split('\n').map(d => d.trim().replace(/\0/g, '')).filter(Boolean);
    for (const distro of distros) {
      // Find WSL home directories
      const wslBase = `\\\\wsl$\\${distro}`;
      const homePath = join(wslBase, 'home');
      try { if (!statSync(homePath).isDirectory()) continue; } catch { continue; }
      const users = readdirSync(homePath);
      for (const user of users) {
        const wslClaudeProjects = join(homePath, user, '.claude', 'projects');
        try { if (!statSync(wslClaudeProjects).isDirectory()) continue; } catch { continue; }
        const dirs = readdirSync(wslClaudeProjects);
        for (const dirName of dirs) {
          const dirPath = join(wslClaudeProjects, dirName);
          try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
          // Read most recent JSONL to extract cwd
          try {
            const files = readdirSync(dirPath)
              .filter(f => f.endsWith('.jsonl'))
              .map(f => ({ name: f, mtime: statSync(join(dirPath, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
              const lines = readLastLines(join(dirPath, files[0].name), 20);
              for (const line of lines) {
                const entry = parseJsonLine(line);
                if (entry?.cwd) {
                  // WSL path: /home/user/project → \\wsl$\distro\home\user\project
                  const wslWinPath = `\\\\wsl$\\${distro}${entry.cwd.replace(/\//g, '\\')}`;
                  const p = wslWinPath.replace(/\\/g, '/');
                  const key = p.toLowerCase();
                  if (!existingSet.has(key) && !discovered.has(key)) {
                    discovered.set(key, {
                      path: p, name: entry.cwd.split('/').pop(),
                      source: 'wsl', distro, wslPath: entry.cwd,
                      sessionCount: files.length
                    });
                  }
                  break;
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* WSL not available or error — skip */ }

  // 4. Enrich with metadata: check if path exists, has .git, session count
  const results = [];
  for (const [, info] of discovered) {
    const path = info.path;
    const winPath = path.replace(/\//g, '\\');
    let pathExists = false;
    let hasGit = false;
    try {
      statSync(winPath);
      pathExists = true;
      try { statSync(join(winPath, '.git')); hasGit = true; } catch { /* not a git repo */ }
    } catch { /* path does not exist */ }

    if (!pathExists || !hasGit) continue; // Skip non-existent paths and non-git projects

    // Get session count + last activity from claude projects dir
    let sessionCount = info.sessionCount || 0;
    let lastActivity = null;
    const dir = getProjectJsonlDir(path);
    if (dir) {
      try {
        const jsonls = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        if (!sessionCount) sessionCount = jsonls.length;
        if (jsonls.length > 0) {
          const stats = jsonls.map(f => statSync(join(dir, f)).mtimeMs);
          lastActivity = new Date(Math.max(...stats)).toISOString();
        }
      } catch { /* session dir inaccessible */ }
    }

    results.push({
      path,
      name: info.name + (info.distro ? ` (WSL: ${info.distro})` : ''),
      hasGit,
      sessionCount,
      lastActivity,
      ...(info.distro ? { wsl: true, distro: info.distro } : {})
    });
  }

  // Sort: most recent activity first, then by name
  results.sort((a, b) => {
    if (a.lastActivity && b.lastActivity) return new Date(b.lastActivity) - new Date(a.lastActivity);
    if (a.lastActivity) return -1;
    if (b.lastActivity) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Read session conversation messages from JSONL file.
 * @param {{id: string, path: string}} project
 * @param {string} sessionId
 * @param {number} [limit=200]
 * @returns {Promise<SessionMessage[]>}
 */
export async function readSessionMessages(project, sessionId, limit = 200) {
  const dir = getProjectJsonlDir(project.path);
  if (!dir) return [];

  const filePath = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];

  const messages = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const entry = parseJsonLine(line);
    if (!entry) continue;

    if (entry.type === 'user') {
      const raw = entry.message?.content;
      const text = typeof raw === 'string' ? raw
        : Array.isArray(raw) ? raw.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
      if (text) messages.push({ role: 'user', content: text.slice(0, 3000), ts: entry.timestamp });
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      const textParts = [];
      const tools = [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'text' && b.text) textParts.push(b.text);
          else if (b.type === 'tool_use') tools.push({ name: b.name, input: JSON.stringify(b.input || {}).slice(0, 500) });
        }
      } else if (typeof blocks === 'string') {
        textParts.push(blocks);
      }
      if (textParts.length || tools.length) {
        messages.push({
          role: 'assistant',
          content: textParts.join('\n').slice(0, 5000),
          tools: tools.length ? tools : undefined,
          model: entry.message?.model?.replace('claude-', '').replace(/-\d{8}$/, ''),
          ts: entry.timestamp
        });
      }
    }
  }

  return messages.slice(-limit);
}

/**
 * Get session timeline -- parse JSONL into tool_use events with timestamps.
 * Level 1: automatic, zero-cost (pure JSONL parsing).
 * @param {{id: string, path: string}} project
 * @param {string} sessionId
 * @returns {Promise<{events: TimelineEvent[], summary: {sessionStart: string, sessionEnd: string, model: string|null, messageCount: number, tokens: {input: number, output: number, cacheRead: number, cacheWrite: number}, cost: number, filesChanged: Array<{path: string, fullPath: string}>}|null}>}
 */
export async function getSessionTimeline(project, sessionId) {
  const dir = getProjectJsonlDir(project.path);
  if (!dir) return { events: [], summary: null };

  const filePath = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return { events: [], summary: null };

  const events = [];
  const filesTouched = new Map(); // path → { adds, removes }
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let model = null;
  let sessionStart = null;
  let sessionEnd = null;
  let messageCount = 0;

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const entry = parseJsonLine(line);
    if (!entry) continue;

    const ts = entry.timestamp || entry.message?.timestamp;
    if (ts) {
      if (!sessionStart) sessionStart = ts;
      sessionEnd = ts;
    }

    // Track token usage
    if (entry.message?.usage) {
      const u = entry.message.usage;
      totalInputTokens += u.input_tokens || 0;
      totalOutputTokens += u.output_tokens || 0;
      totalCacheRead += u.cache_read_input_tokens || 0;
      totalCacheWrite += u.cache_creation_input_tokens || 0;
    }
    if (entry.message?.model && !model) {
      model = entry.message.model.replace('claude-', '').replace(/-\d{8}$/, '');
    }

    if (entry.type === 'user') messageCount++;

    // Extract tool_use from assistant messages
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use') {
          const ev = { ts, type: 'tool', name: block.name, id: block.id };
          // Extract meaningful info from tool input
          if (block.name === 'Read' || block.name === 'read_file') {
            ev.detail = block.input?.file_path || block.input?.path || '';
          } else if (block.name === 'Edit' || block.name === 'edit_file') {
            ev.detail = block.input?.file_path || block.input?.path || '';
            ev.action = 'edit';
          } else if (block.name === 'Write' || block.name === 'write_to_file') {
            ev.detail = block.input?.file_path || block.input?.path || '';
            ev.action = 'write';
          } else if (block.name === 'Bash' || block.name === 'execute_command') {
            ev.detail = (block.input?.command || '').slice(0, 120);
          } else if (block.name === 'Grep' || block.name === 'search_files') {
            ev.detail = block.input?.pattern || block.input?.query || '';
          } else if (block.name === 'Glob') {
            ev.detail = block.input?.pattern || '';
          } else if (block.name === 'Task') {
            ev.detail = block.input?.description || '';
          } else {
            ev.detail = JSON.stringify(block.input || {}).slice(0, 100);
          }
          events.push(ev);
        } else if (block.type === 'text' && block.text) {
          // Check for commit messages
          const commitMatch = block.text.match(/git commit.*-m\s+["']([^"']+)/);
          if (commitMatch) {
            events.push({ ts, type: 'commit', detail: commitMatch[1] });
          }
        }
      }
    }

    // Extract tool_result for file change tracking
    if (entry.type === 'tool_result' || (entry.type === 'user' && Array.isArray(entry.message?.content))) {
      const blocks = entry.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            // Try to detect file changes from result text
            const diffMatch = block.content.match(/([+-]\d+)\s+lines?/);
            if (diffMatch) {
              const lastToolEvent = [...events].reverse().find(e => e.type === 'tool' && e.id === block.tool_use_id);
              if (lastToolEvent?.detail) {
                const existing = filesTouched.get(lastToolEvent.detail) || { adds: 0, removes: 0 };
                filesTouched.set(lastToolEvent.detail, existing);
              }
            }
          }
        }
      }
    }
  }

  // Build file changes from edit/write events
  for (const ev of events) {
    if ((ev.action === 'edit' || ev.action === 'write') && ev.detail) {
      if (!filesTouched.has(ev.detail)) filesTouched.set(ev.detail, { action: ev.action });
    }
  }

  // Calculate cost
  const PRICING = {
    'opus': { input: 15, output: 75 },
    'sonnet': { input: 3, output: 15 },
    'haiku': { input: 0.8, output: 4 },
  };
  const modelKey = (model || '').split('-')[0];
  const pricing = PRICING[modelKey] || PRICING['opus'];
  const M = 1_000_000;
  const cost = totalInputTokens / M * pricing.input + totalOutputTokens / M * pricing.output;

  return {
    events: events.slice(0, 500), // cap for large sessions
    summary: {
      sessionStart, sessionEnd, model, messageCount,
      tokens: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
      cost: Math.round(cost * 100) / 100,
      filesChanged: [...filesTouched.entries()].map(([path, info]) => ({ path: path.split('/').pop() || path.split('\\').pop() || path, fullPath: path, ...info }))
    }
  };
}

/**
 * Read first N lines from a file
 */
function readFirstLines(filePath, numLines = 20) {
  try {
    const fd = openSync(filePath, 'r');
    const bufSize = Math.min(statSync(filePath).size, 32768);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, 0);
    closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(0, numLines);
  } catch { return []; }
}

/**
 * Get usage facet for a session from Claude's usage-data directory.
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSessionFacet(sessionId) {
  const facetsDir = join(CLAUDE_DIR, 'usage-data', 'facets');
  if (!existsSync(facetsDir)) return null;

  try {
    const files = readdirSync(facetsDir);
    for (const f of files) {
      const st = statSync(join(facetsDir, f));
      const fd = openSync(join(facetsDir, f), 'r');
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      closeSync(fd);
      const data = JSON.parse(buf.toString('utf8'));
      if (data.session_id === sessionId) return data;
    }
  } catch { /* ignore */ }
  return null;
}
