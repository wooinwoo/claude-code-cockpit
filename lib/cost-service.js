/**
 * @typedef {Object} TokenUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 */

/**
 * @typedef {Object} DailyUsageEntry
 * @property {string} date - ISO date string (YYYY-MM-DD)
 * @property {number} totalCost
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} totalTokens
 * @property {number} messages
 * @property {number} sessions
 * @property {number} toolCalls
 * @property {Array<{modelName: string, cost: number, outputTokens: number}>} modelBreakdowns
 */

/**
 * @typedef {Object} UsageResult
 * @property {{date: string, outputTokens: number, inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, messages: number, sessions: number, toolCalls: number, apiEquivCost: number, models: Object}} today
 * @property {{outputTokens: number, messages: number, apiEquivCost: number, models: Object, resetAt: string}} week
 * @property {DailyUsageEntry[]} daily
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATS_CACHE_PATH, CLAUDE_PROJECTS_DIR } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_CACHE_PATH = join(__dirname, '..', 'cost-cache.json');

// ── Pricing (per 1M tokens, USD) ──
const PRICING = {
  'claude-opus-4-6':           { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-5-20251101':  { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5-20250929':{ input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.8,output: 4,  cacheWrite: 1,     cacheRead: 0.08 },
};
const DEFAULT_PRICING = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };

/**
 * Calculate API cost for a given model and token usage.
 * @param {string} model - Claude model identifier
 * @param {TokenUsage} usage
 * @returns {number} Cost in USD
 */
function calcCost(model, usage) {
  const p = PRICING[model] || DEFAULT_PRICING;
  const M = 1_000_000;
  return (
    (usage.input_tokens || 0) / M * p.input +
    (usage.output_tokens || 0) / M * p.output +
    (usage.cache_creation_input_tokens || 0) / M * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) / M * p.cacheRead
  );
}

/**
 * Parse a single JSONL session file for token usage entries.
 * @param {string} filePath
 * @param {string} [sinceDate] - ISO date string to filter entries after
 * @returns {Promise<Array<{date: string, model: string, usage: TokenUsage}>>}
 */
async function parseSessionFile(filePath, sinceDate) {
  const entries = [];
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg?.usage || !msg?.model) continue;
        const ts = obj.timestamp || msg.timestamp;
        if (!ts) continue;
        const date = ts.slice(0, 10);
        if (sinceDate && date < sinceDate) continue;
        entries.push({ date, model: msg.model, usage: msg.usage });
      } catch { /* malformed JSON line, skip */ }
    }
  } catch { /* session file not found or inaccessible */ }
  return entries;
}

/**
 * Get session JSONL files modified after a given timestamp.
 * @param {number} sinceTs - Unix timestamp in ms
 * @returns {string[]} Array of file paths
 */
function getSessionFilesModifiedAfter(sinceTs) {
  const files = [];
  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const proj of projects) {
      const projDir = `${CLAUDE_PROJECTS_DIR}/${proj}`;
      try {
        const sessions = readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
        for (const s of sessions) {
          const fp = `${projDir}/${s}`;
          try {
            const st = statSync(fp);
            if (st.mtimeMs >= sinceTs) files.push(fp);
          } catch { /* file inaccessible, skip */ }
        }
      } catch { /* session dir inaccessible */ }
    }
  } catch { /* projects dir inaccessible */ }
  return files;
}

// ── Persistent cost cache ──
function loadCostCache() {
  try {
    if (existsSync(COST_CACHE_PATH)) return JSON.parse(readFileSync(COST_CACHE_PATH, 'utf8'));
  } catch { /* malformed JSON or file inaccessible */ }
  return { daily: {} };
}

function saveCostCache(cache) {
  const tmp = COST_CACHE_PATH + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    renameSync(tmp, COST_CACHE_PATH);
  } catch {
    try { unlinkSync(tmp); } catch { /* tmp already removed */ }
  }
}

function aggregateEntries(entries) {
  const dailyMap = new Map();
  for (const e of entries) {
    if (!dailyMap.has(e.date)) dailyMap.set(e.date, { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, models: {} });
    const day = dailyMap.get(e.date);
    const cost = calcCost(e.model, e.usage);
    day.cost += cost;
    day.inputTokens += (e.usage.input_tokens || 0);
    day.outputTokens += (e.usage.output_tokens || 0);
    day.cacheRead += (e.usage.cache_read_input_tokens || 0);
    day.cacheWrite += (e.usage.cache_creation_input_tokens || 0);
    const mName = e.model.replace('claude-', '').replace(/-\d{8}$/, '');
    if (!day.models[mName]) day.models[mName] = { cost: 0, outputTokens: 0 };
    day.models[mName].cost += cost;
    day.models[mName].outputTokens += (e.usage.output_tokens || 0);
  }
  return dailyMap;
}

// ── In-memory cache ──
let _memCache = { result: null, timestamp: 0 };
const MEM_CACHE_TTL = 30_000;

// ── Incremental file tracking: skip re-parsing unchanged files ──
const _fileSizeCache = new Map(); // filePath → { size, entries }
let _fileSizeCacheDate = ''; // reset when date changes

// ── Build activity map from stats-cache ──
function getActivityMap() {
  const statsCache = getStatsCache();
  const map = new Map();
  if (statsCache?.dailyActivity) {
    for (const a of statsCache.dailyActivity) {
      map.set(a.date, { messages: a.messageCount || 0, sessions: a.sessionCount || 0, toolCalls: a.toolCallCount || 0 });
    }
  }
  return map;
}

/**
 * Compute token usage and cost data (today, week, 30-day history).
 * Results are cached in memory for 30s.
 * @returns {Promise<UsageResult>}
 */
async function computeUsage() {
  if (_memCache.result && Date.now() - _memCache.timestamp < MEM_CACHE_TTL) {
    return _memCache.result;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const costCache = loadCostCache();

  // Reset incremental cache on date change
  if (_fileSizeCacheDate !== todayStr) { _fileSizeCache.clear(); _fileSizeCacheDate = todayStr; }

  // Only parse files modified since midnight today
  const todayStart = new Date(todayStr + 'T00:00:00').getTime();
  const files = getSessionFilesModifiedAfter(todayStart);

  let allEntries = [];
  for (const fp of files) {
    try {
      const sz = statSync(fp).size;
      const cached = _fileSizeCache.get(fp);
      if (cached && cached.size === sz) { allEntries = allEntries.concat(cached.entries); continue; }
      const entries = await parseSessionFile(fp, todayStr);
      _fileSizeCache.set(fp, { size: sz, entries });
      allEntries = allEntries.concat(entries);
    } catch {
      const entries = await parseSessionFile(fp, todayStr);
      allEntries = allEntries.concat(entries);
    }
  }

  // Aggregate today's token data
  const todayMap = aggregateEntries(allEntries);
  const todayData = todayMap.get(todayStr);
  if (todayData) {
    costCache.daily[todayStr] = {
      cost: todayData.cost, inputTokens: todayData.inputTokens,
      outputTokens: todayData.outputTokens, cacheRead: todayData.cacheRead,
      cacheWrite: todayData.cacheWrite, models: todayData.models
    };
  }

  // Fill history from stats-cache.json (dailyModelTokens)
  const statsCache = getStatsCache();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceStr = thirtyDaysAgo.toISOString().slice(0, 10);

  if (statsCache?.dailyModelTokens) {
    for (const entry of statsCache.dailyModelTokens) {
      if (entry.date < sinceStr) continue;
      if (costCache.daily[entry.date]) continue;
      const models = {};
      let totalCost = 0;
      for (const [model, outTokens] of Object.entries(entry.tokensByModel || {})) {
        const p = PRICING[model] || DEFAULT_PRICING;
        const est = outTokens / 1_000_000 * p.output;
        const mName = model.replace('claude-', '').replace(/-\d{8}$/, '');
        models[mName] = { cost: est, outputTokens: outTokens };
        totalCost += est;
      }
      costCache.daily[entry.date] = {
        cost: totalCost,
        outputTokens: Object.values(entry.tokensByModel || {}).reduce((s, v) => s + v, 0),
        inputTokens: 0, cacheRead: 0, cacheWrite: 0, models, estimated: true
      };
    }
  }

  saveCostCache(costCache);

  // Activity data (messages, sessions, toolCalls)
  const activityMap = getActivityMap();

  // Build 30-day array
  const daily = Object.entries(costCache.daily)
    .filter(([date]) => date >= sinceStr)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => {
      const act = activityMap.get(date) || { messages: 0, sessions: 0, toolCalls: 0 };
      return {
        date, totalCost: d.cost || 0,
        inputTokens: d.inputTokens || 0, outputTokens: d.outputTokens || 0,
        cacheReadTokens: d.cacheRead || 0, cacheCreationTokens: d.cacheWrite || 0,
        totalTokens: (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0),
        messages: act.messages, sessions: act.sessions, toolCalls: act.toolCalls,
        modelBreakdowns: Object.entries(d.models || {}).map(([name, m]) => ({ modelName: name, cost: m.cost || 0, outputTokens: m.outputTokens || 0 }))
      };
    });

  // Today summary
  const todayEntry = daily.find(d => d.date === todayStr) || { outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0, messages: 0, sessions: 0, toolCalls: 0, modelBreakdowns: [] };

  // Week summary (Mon-Sun)
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now); monday.setDate(now.getDate() - dayOfWeek + 1); monday.setHours(0, 0, 0, 0);
  const mondayStr = monday.toISOString().slice(0, 10);
  const weekEntries = daily.filter(d => d.date >= mondayStr);
  const weekModels = {};
  let weekOut = 0, weekMsg = 0, weekCost = 0;
  for (const d of weekEntries) {
    weekOut += d.outputTokens;
    weekMsg += d.messages;
    weekCost += d.totalCost;
    for (const m of d.modelBreakdowns) {
      if (!weekModels[m.modelName]) weekModels[m.modelName] = { outputTokens: 0, apiCost: 0 };
      weekModels[m.modelName].outputTokens += m.outputTokens;
      weekModels[m.modelName].apiCost += m.cost;
    }
  }

  // Reset times
  const nextMonday = new Date(now); nextMonday.setDate(now.getDate() + (8 - dayOfWeek) % 7 || 7); nextMonday.setHours(0, 0, 0, 0);

  const todayModels = {};
  for (const m of todayEntry.modelBreakdowns) {
    todayModels[m.modelName] = { outputTokens: m.outputTokens, apiCost: m.cost };
  }

  const result = {
    today: {
      date: todayStr,
      outputTokens: todayEntry.outputTokens,
      inputTokens: todayEntry.inputTokens,
      cacheReadTokens: todayEntry.cacheReadTokens,
      cacheCreationTokens: todayEntry.cacheCreationTokens,
      messages: todayEntry.messages,
      sessions: todayEntry.sessions,
      toolCalls: todayEntry.toolCalls,
      apiEquivCost: todayEntry.totalCost,
      models: todayModels
    },
    week: {
      outputTokens: weekOut,
      messages: weekMsg,
      apiEquivCost: weekCost,
      models: weekModels,
      resetAt: nextMonday.toISOString()
    },
    daily
  };

  _memCache = { result, timestamp: Date.now() };
  return result;
}

// ── Public API ──

export { computeUsage, calcCost, aggregateEntries, PRICING, DEFAULT_PRICING };

/**
 * Load stats-cache.json from disk.
 * @returns {Object|null}
 */
export function getStatsCache() {
  try {
    if (!existsSync(STATS_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(STATS_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}
