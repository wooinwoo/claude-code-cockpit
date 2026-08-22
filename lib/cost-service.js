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
 * @property {boolean} estimated - true if any model that day used a proxy (unpriced family)
 * @property {Array<{modelName: string, cost: number, outputTokens: number, estimated: boolean}>} modelBreakdowns
 */

/**
 * @typedef {Object} UsageResult
 * @property {Object} today
 * @property {Object} week
 * @property {DailyUsageEntry[]} daily
 * @property {string[]} unpricedModels - model ids priced by opus proxy (surfaced to UI)
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATS_CACHE_PATH, CLAUDE_PROJECTS_DIR } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_CACHE_PATH = join(__dirname, '..', 'cost-cache.json');

// ── Pricing (per 1M tokens, USD), resolved by model FAMILY ──
// Root fix: an exact-match table goes stale every model release — the 4.5→4.8 gap
// silently priced sonnet-4-6 at the opus fallback (5× over). Resolving by family
// means future opus-4-9 / sonnet-4-7 price correctly with zero table edits.
const TIER = {
  opus:   { input: 15,  output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,   output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 0.8, output: 4,  cacheWrite: 1,     cacheRead: 0.08 },
};
// Exact overrides win over family match — populate only when a price is known precisely.
const PRICING = {};
// Proxy for unknown families (e.g. fable / mythos, positioned at or above opus).
const DEFAULT_PRICING = TIER.opus;

// Model ids we could not price precisely (unknown family) — surfaced to the UI as estimates.
const _unpricedModels = new Set();

/**
 * Resolve pricing for a model, flagging when it's an opus-proxy estimate.
 * @param {string} model
 * @returns {{p: {input:number,output:number,cacheWrite:number,cacheRead:number}, estimated: boolean}}
 */
function resolvePricing(model) {
  if (PRICING[model]) return { p: PRICING[model], estimated: false };
  const m = String(model).toLowerCase();
  if (m.includes('haiku'))  return { p: TIER.haiku,  estimated: false };
  if (m.includes('sonnet')) return { p: TIER.sonnet, estimated: false };
  if (m.includes('opus'))   return { p: TIER.opus,   estimated: false };
  _unpricedModels.add(model);
  return { p: DEFAULT_PRICING, estimated: true };
}

/**
 * Calculate API-equivalent cost for a given model and token usage.
 * @param {string} model
 * @param {TokenUsage} usage
 * @returns {number} Cost in USD
 */
function calcCost(model, usage) {
  const { p } = resolvePricing(model);
  const M = 1_000_000;
  return (
    (usage.input_tokens || 0) / M * p.input +
    (usage.output_tokens || 0) / M * p.output +
    (usage.cache_creation_input_tokens || 0) / M * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) / M * p.cacheRead
  );
}

/**
 * Parse a JSONL session file into per-assistant-message usage entries.
 * Each entry carries a dedup key so that one assistant response — which Claude Code
 * logs across several "usage" lines (one per content block, with the usage TOTAL
 * repeated on each) — collapses to a single billed message downstream.
 * @param {string} filePath
 * @param {string} [sinceDate] - ISO date (YYYY-MM-DD); entries strictly before are dropped
 * @returns {Promise<Array<{date:string, model:string, usage:TokenUsage, key:string, sessionId:string, toolCalls:number}>>}
 */
async function parseSessionFile(filePath, sinceDate) {
  const entries = [];
  const sessionId = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg?.usage || !msg?.model) continue;
        // Skip synthetic/placeholder models (e.g. "<synthetic>") — Claude Code injects
        // these locally; they're not real billed API turns, so they must not count
        // toward cost, messages, or the unpriced-model estimate flag.
        if (String(msg.model).startsWith('<')) continue;
        const ts = obj.timestamp || msg.timestamp;
        if (!ts) continue;
        const date = ts.slice(0, 10);
        if (sinceDate && date < sinceDate) continue;
        // Same assistant message spread over multiple content-block lines → one key.
        const key = msg.id ? `${msg.id}:${obj.requestId || ''}` : `${filePath}#${entries.length}`;
        let toolCalls = 0;
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) if (c && c.type === 'tool_use') toolCalls++;
        }
        entries.push({ date, model: msg.model, usage: msg.usage, key, sessionId, toolCalls });
      } catch { /* malformed JSON line, skip */ }
    }
  } catch { /* session file not found or inaccessible */ }
  return entries;
}

/**
 * Get session JSONL files modified after a given timestamp.
 * @param {number} sinceTs - Unix timestamp in ms (0 = all files)
 * @returns {string[]}
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

/**
 * Collapse entries that share a dedup key (keep first occurrence).
 * @template {{key:string}} T
 * @param {T[]} entries
 * @returns {T[]}
 */
function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (e.key && seen.has(e.key)) continue;   // keyless entries are always kept (unique)
    if (e.key) seen.add(e.key);
    out.push(e);
  }
  return out;
}

/**
 * Aggregate usage entries into a per-date map. Dedups by message key first, so
 * callers may pass raw multi-file concatenations. Also derives activity
 * (messages / sessions / tool calls) directly from the JSONL — no stats-cache.
 * @param {Array<{date:string, model:string, usage:TokenUsage, key:string, sessionId:string, toolCalls:number}>} entries
 * @returns {Map<string, Object>}
 */
function aggregateEntries(entries) {
  const deduped = dedupeEntries(entries);
  const dailyMap = new Map();
  const sessionsByDate = new Map(); // date → Set(sessionId)
  for (const e of deduped) {
    if (!dailyMap.has(e.date)) {
      dailyMap.set(e.date, { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, messages: 0, toolCalls: 0, sessions: 0, estimated: false, models: {} });
    }
    const day = dailyMap.get(e.date);
    const { estimated } = resolvePricing(e.model);
    const cost = calcCost(e.model, e.usage);
    day.cost += cost;
    day.inputTokens += (e.usage.input_tokens || 0);
    day.outputTokens += (e.usage.output_tokens || 0);
    day.cacheRead += (e.usage.cache_read_input_tokens || 0);
    day.cacheWrite += (e.usage.cache_creation_input_tokens || 0);
    day.messages += 1;
    day.toolCalls += (e.toolCalls || 0);
    if (estimated) day.estimated = true;
    if (!sessionsByDate.has(e.date)) sessionsByDate.set(e.date, new Set());
    if (e.sessionId) sessionsByDate.get(e.date).add(e.sessionId);
    const mName = e.model.replace('claude-', '').replace(/-\d{8}$/, '');
    if (!day.models[mName]) day.models[mName] = { cost: 0, outputTokens: 0, estimated };
    day.models[mName].cost += cost;
    day.models[mName].outputTokens += (e.usage.output_tokens || 0);
  }
  for (const [date, set] of sessionsByDate) dailyMap.get(date).sessions = set.size;
  return dailyMap;
}

// ── In-memory cache ──
let _memCache = { result: null, timestamp: 0 };
const MEM_CACHE_TTL = 30_000;

// ── Incremental file tracking: skip re-parsing unchanged files ──
const _fileSizeCache = new Map(); // filePath → { size, entries }
let _fileSizeCacheDate = ''; // reset when the local date changes

/** Local (not UTC) YYYY-MM-DD — KST 00:00–09:00 usage must not fall to the previous day. */
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute token usage and cost (today, week, 30-day history). Cached in memory 30s.
 * Today is parsed incrementally from session files; history comes from the persistent
 * cache (rebuild it with recomputeAll after a pricing/dedup change).
 * @returns {Promise<UsageResult>}
 */
async function computeUsage() {
  if (_memCache.result && Date.now() - _memCache.timestamp < MEM_CACHE_TTL) {
    return _memCache.result;
  }

  const now = new Date();
  const todayStr = localDateStr(now);
  const costCache = loadCostCache();

  // Reset incremental cache on date change
  if (_fileSizeCacheDate !== todayStr) { _fileSizeCache.clear(); _fileSizeCacheDate = todayStr; }

  // Only parse files modified since local midnight today
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
      allEntries = allEntries.concat(await parseSessionFile(fp, todayStr));
    }
  }

  // Aggregate today (dedup happens inside aggregateEntries)
  const todayMap = aggregateEntries(allEntries);
  const todayData = todayMap.get(todayStr);
  if (todayData) {
    costCache.daily[todayStr] = {
      cost: todayData.cost, inputTokens: todayData.inputTokens, outputTokens: todayData.outputTokens,
      cacheRead: todayData.cacheRead, cacheWrite: todayData.cacheWrite,
      messages: todayData.messages, sessions: todayData.sessions, toolCalls: todayData.toolCalls,
      estimated: todayData.estimated, models: todayData.models,
    };
    saveCostCache(costCache);
  }

  // 30-day window (local date)
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceStr = localDateStr(thirtyDaysAgo);

  const daily = Object.entries(costCache.daily)
    .filter(([date]) => date >= sinceStr)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date, totalCost: d.cost || 0,
      inputTokens: d.inputTokens || 0, outputTokens: d.outputTokens || 0,
      cacheReadTokens: d.cacheRead || 0, cacheCreationTokens: d.cacheWrite || 0,
      totalTokens: (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0),
      messages: d.messages || 0, sessions: d.sessions || 0, toolCalls: d.toolCalls || 0,
      estimated: !!d.estimated,
      modelBreakdowns: Object.entries(d.models || {}).map(([name, m]) => ({ modelName: name, cost: m.cost || 0, outputTokens: m.outputTokens || 0, estimated: !!m.estimated })),
    }));

  const todayEntry = daily.find(d => d.date === todayStr) ||
    { outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0, messages: 0, sessions: 0, toolCalls: 0, estimated: false, modelBreakdowns: [] };

  // Week (Mon–Sun, local)
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now); monday.setDate(now.getDate() - dayOfWeek + 1); monday.setHours(0, 0, 0, 0);
  const mondayStr = localDateStr(monday);
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

  const nextMonday = new Date(now); nextMonday.setDate(now.getDate() + ((8 - dayOfWeek) % 7 || 7)); nextMonday.setHours(0, 0, 0, 0);

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
      estimated: todayEntry.estimated,
      models: todayModels,
    },
    week: {
      outputTokens: weekOut,
      messages: weekMsg,
      apiEquivCost: weekCost,
      models: weekModels,
      resetAt: nextMonday.toISOString(),
    },
    daily,
    unpricedModels: [..._unpricedModels],
  };

  _memCache = { result, timestamp: Date.now() };
  return result;
}

/**
 * Rebuild the persistent daily cache from ALL surviving session files, with dedup
 * and current family pricing. One-shot repair for history that was saved under the
 * old double-counting bug / stale pricing table.
 * @returns {Promise<{days:number, files:number}>}
 */
async function recomputeAll() {
  const files = getSessionFilesModifiedAfter(0);
  let all = [];
  for (const fp of files) all = all.concat(await parseSessionFile(fp));
  const map = aggregateEntries(all);
  const cache = { daily: {} };
  for (const [date, d] of map) {
    cache.daily[date] = {
      cost: d.cost, inputTokens: d.inputTokens, outputTokens: d.outputTokens,
      cacheRead: d.cacheRead, cacheWrite: d.cacheWrite,
      messages: d.messages, sessions: d.sessions, toolCalls: d.toolCalls,
      estimated: d.estimated, models: d.models,
    };
  }
  saveCostCache(cache);
  _memCache = { result: null, timestamp: 0 };
  return { days: Object.keys(cache.daily).length, files: files.length };
}

/**
 * Turn today's raw cost data into actionable insight: per-session attribution,
 * burn rate, and an honest upper-bound on what a cheaper model mix could have saved.
 * The savings figure is a hypothetical ceiling (opus output re-priced at sonnet),
 * NOT a claim that the work could actually have used sonnet — labelled as such.
 * @returns {Promise<object>}
 */
export async function getCostInsights() {
  const now = new Date();
  const todayStr = localDateStr(now);
  const todayStart = new Date(todayStr + 'T00:00:00').getTime();

  const files = getSessionFilesModifiedAfter(todayStart);
  let all = [];
  for (const fp of files) all = all.concat(await parseSessionFile(fp, todayStr));
  const deduped = dedupeEntries(all).filter((e) => e.date === todayStr);

  const sessions = new Map();
  const models = new Map();
  let todayCost = 0, opusOut = 0;
  for (const e of deduped) {
    const cost = calcCost(e.model, e.usage);
    const out = e.usage.output_tokens || 0;
    todayCost += cost;
    const s = sessions.get(e.sessionId) || { sessionId: e.sessionId, cost: 0, outputTokens: 0, messages: 0 };
    s.cost += cost; s.outputTokens += out; s.messages += 1;
    sessions.set(e.sessionId, s);
    const mName = e.model.replace('claude-', '').replace(/-\d{8}$/, '');
    const mo = models.get(mName) || { model: mName, cost: 0, outputTokens: 0 };
    mo.cost += cost; mo.outputTokens += out;
    models.set(mName, mo);
    if (/opus/i.test(mName)) opusOut += out;
  }

  const hoursElapsed = Math.max((Date.now() - todayStart) / 3_600_000, 0.1);
  const savingsCeiling = (opusOut / 1_000_000) * (TIER.opus.output - TIER.sonnet.output);

  return {
    date: todayStr,
    todayCost,
    burnPerHour: todayCost / hoursElapsed,
    bySession: [...sessions.values()].sort((a, b) => b.cost - a.cost).slice(0, 10),
    byModel: [...models.values()].sort((a, b) => b.cost - a.cost),
    opusOutputTokens: opusOut,
    savingsCeiling,                       // hypothetical: opus output re-priced at sonnet
    savingsNote: 'opus 출력을 sonnet 단가로 환산한 상한(가정). 실제 절감은 작업 난이도에 따라 달라짐',
  };
}

// ── Public API ──
export { computeUsage, calcCost, aggregateEntries, recomputeAll, resolvePricing, PRICING, DEFAULT_PRICING };

/**
 * Load stats-cache.json from disk. Retained for backward compat only — current
 * Claude Code no longer writes this file, so this returns null in practice.
 * Activity metrics now come from the session JSONL (see aggregateEntries).
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
