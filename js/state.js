// ─── Shared Mutable State ───
// All modules import `app` and read/write properties directly.
// Feature-specific state is grouped into namespace objects.
// A Proxy provides backward compatibility: `app.cicdRuns` → `app.cicd.runs`.

import { normalizeTerminalGroupLayout } from './terminal-group-layout.js';

const _themeManual = !!localStorage.getItem('dl-theme');

const _app = {
  // ─── Core (flat — used across many modules) ───
  state: { projects: new Map(), costs: null, usage: null, connected: false },
  projectList: [],
  prevSessionStates: new Map(),
  ws: null,

  // Terminal
  termMap: new Map(),
  activeTermId: null,
  sessionOrder: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dl-terminal-session-order') || '[]');
      return Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
    } catch { return []; }
  })(),
  terminalPairs: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dl-terminal-pairs') || '[]');
      return Array.isArray(saved) ? saved.filter(pair => pair && Array.isArray(pair.termIds)) : [];
    } catch { return []; }
  })(),
  pairSourceTermId: '',
  layoutRoot: null,
  terminalFocusMode: true,
  draggedTermId: null,
  writeBuffers: new Map(),

  // Dev servers
  devServerState: [],
  _knownPorts: new Set(),
  _devStartTimeouts: new Map(),

  // UI state
  pinnedProjects: new Set(JSON.parse(localStorage.getItem('dl-pinned') || '[]')),
  notifyEnabled: localStorage.getItem('dl-notify') !== 'false',
  chartPeriod: parseInt(localStorage.getItem('dl-chart-period') || '30'),
  termFontSize: parseInt(localStorage.getItem('dl-term-font-size') || '13'),
  viewZoom: JSON.parse(localStorage.getItem('dl-view-zoom') || '{}'),
  currentTheme: _themeManual
    ? localStorage.getItem('dl-theme')
    : 'dark',
  _themeManual,

  // Charts
  dailyChart: null,
  modelChart: null,

  // SSE reconnect
  _sseBackoff: 1000,
  _sseReconnTimer: null,
  _sseConnectedAt: 0,

  // WS reconnect
  _wsBackoff: 1000,
  _wsReconnTimer: null,
  _wsConnectedAt: 0,

  // Project filter
  _projectStatusFilter: 'all',
  _projectTagFilter: '',
  _cardSortBy: localStorage.getItem('dl-card-sort') || 'name',
  _renderedCardIds: [],

  // Terminal headers
  _headCache: new Map(),
  _termHeaderTimer: null,

  // Clock
  _clockTimer: null,

  // Usage
  usageTimer: null,
  _usageLastUpdated: null,
  _usageRetryCount: 0,

  // Context menu
  _ctxMenu: null,

  // Folder picker
  fpCurrentDir: null,

  // Error log
  _errorLog: [],

  // Notification filter
  _notifFilter: JSON.parse(localStorage.getItem('dl-notif-filter') || '{}'),

  // Favicon
  _faviconLink: null,

  // Git action locks
  _gitActionLocks: new Set(),

  // Fit debounce
  fitDebounce: null,

  // ─── Feature Namespaces ───
  diff: {
    abort: null,
    debounceTimer: null,
    stagedCount: 0,
    acPlan: null,
    acExecuting: false,
    acDragFile: null,
    acBranchInfo: null,
    branchData: null,
    selectedBranch: null,
  },

  cmd: {
    activeIdx: 0,
    filtered: [],
  },

  discover: {
    data: [],
    selected: new Set(),
  },

  cicd: {
    runs: [],
    workflows: [],
    project: null,
    loading: false,
    initialized: false,
    detailRun: null,
    pollTimer: null,
  },

  ports: {
    data: [],
    timer: null,
    initialized: false,
    paused: false,
    search: '',
    devOnly: false,
    sortCol: 'port',
    sortAsc: true,
  },

  apiTester: {
    requests: [],
    activeId: null,
    initialized: false,
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: '',
    bodyType: 'none',
    configTab: 'params',
    response: null,
    loading: false,
    swagger: null,
    swaggerBaseUrl: '',
    sidebarMode: 'requests',
    swaggerFilter: '',
    swaggerExcluded: new Set(),
    autoTest: { running: false, results: [], progress: { current: 0, total: 0, passed: 0, failed: 0 } },
    aiAnalysis: null,
    aiAnalyzing: false,
    detectedAuth: null,
    authConfig: {},
    aiScenarios: null,
    reviewedPlan: null,
  },

  notes: {
    list: [],
    activeId: null,
    initialized: false,
    dirty: false,
    saveTimer: null,
    saveState: null, // null | 'saving' | 'saved'
  },

  jira: {
    issues: [],
    sprints: [],
    boards: [],
    config: null,
    view: localStorage.getItem('dl-jira-view') || 'list',
    filter: { project: '', sprint: '', status: '', search: '' },
    loading: false,
    detailKey: null,
    initialized: false,
  },

  wf: {
    defs: [],
    runs: [],
    activeDefId: null,
    activeRunId: null,
    init: false,
  },

  quickBar: {
    visible: JSON.parse(localStorage.getItem('dl-quick-bar-visible') || 'false'),
    customCmds: JSON.parse(localStorage.getItem('dl-quick-cmds') || '[]'),
  },
};

// ─── Backward-Compat Map: old flat name → [namespace, key] ───
const COMPAT_MAP = {
  // Diff
  _diffAbort: ['diff', 'abort'],
  _diffDebounceTimer: ['diff', 'debounceTimer'],
  _diffStagedCount: ['diff', 'stagedCount'],
  _acPlan: ['diff', 'acPlan'],
  _acExecuting: ['diff', 'acExecuting'],
  _acDragFile: ['diff', 'acDragFile'],
  _acBranchInfo: ['diff', 'acBranchInfo'],
  _branchData: ['diff', 'branchData'],
  _selectedBranch: ['diff', 'selectedBranch'],
  // Command palette
  _cmdActiveIdx: ['cmd', 'activeIdx'],
  _cmdFiltered: ['cmd', 'filtered'],
  // Discover
  _discoverData: ['discover', 'data'],
  _discoverSelected: ['discover', 'selected'],
  // CI/CD
  cicdRuns: ['cicd', 'runs'],
  cicdWorkflows: ['cicd', 'workflows'],
  _cicdProject: ['cicd', 'project'],
  _cicdLoading: ['cicd', 'loading'],
  _cicdInitialized: ['cicd', 'initialized'],
  _cicdDetailRun: ['cicd', 'detailRun'],
  _cicdPollTimer: ['cicd', 'pollTimer'],
  // Ports
  portsData: ['ports', 'data'],
  _portsTimer: ['ports', 'timer'],
  _portsInitialized: ['ports', 'initialized'],
  _portsPaused: ['ports', 'paused'],
  // Notes
  notesList: ['notes', 'list'],
  _activeNoteId: ['notes', 'activeId'],
  _notesInitialized: ['notes', 'initialized'],
  _notesDirty: ['notes', 'dirty'],
  _notesSaveTimer: ['notes', 'saveTimer'],
  _notesSaveState: ['notes', 'saveState'],
  // Jira
  jiraIssues: ['jira', 'issues'],
  jiraSprints: ['jira', 'sprints'],
  jiraBoards: ['jira', 'boards'],
  jiraConfig: ['jira', 'config'],
  _jiraView: ['jira', 'view'],
  _jiraFilter: ['jira', 'filter'],
  _jiraLoading: ['jira', 'loading'],
  _jiraDetailKey: ['jira', 'detailKey'],
  _jiraInitialized: ['jira', 'initialized'],
  // Workflows
  workflowDefs: ['wf', 'defs'],
  workflowRuns: ['wf', 'runs'],
  _activeWorkflowDefId: ['wf', 'activeDefId'],
  _activeWorkflowRunId: ['wf', 'activeRunId'],
  _workflowsInit: ['wf', 'init'],
};

export const app = new Proxy(_app, {
  get(target, prop, receiver) {
    const mapping = COMPAT_MAP[prop];
    if (mapping) return target[mapping[0]][mapping[1]];
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value) {
    const mapping = COMPAT_MAP[prop];
    if (mapping) { target[mapping[0]][mapping[1]] = value; return true; }
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    if (prop in COMPAT_MAP) return true;
    return prop in target;
  },
});

export function getOrderedTerminalIds() {
  const liveIds = [...app.termMap.keys()];
  const live = new Set(liveIds);
  const ordered = [...new Set(app.sessionOrder.filter(id => live.has(id)))];
  for (const id of liveIds) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export function getOrderedTerminalEntries() {
  return getOrderedTerminalIds().map(id => [id, app.termMap.get(id)]);
}

export function setTerminalOrder(ids) {
  const live = new Set(app.termMap.keys());
  const ordered = [...new Set(ids.filter(id => live.has(id)))];
  for (const id of live) if (!ordered.includes(id)) ordered.push(id);
  app.sessionOrder = ordered;
  try { localStorage.setItem('dl-terminal-session-order', JSON.stringify(ordered)); } catch { /* storage unavailable */ }
  return ordered;
}

export function remapTerminalOrder(idMap) {
  app.sessionOrder = [...new Set(app.sessionOrder.map(id => idMap[id] || id))];
  try { localStorage.setItem('dl-terminal-session-order', JSON.stringify(app.sessionOrder)); } catch { /* storage unavailable */ }
  return app.sessionOrder;
}

function persistTerminalPairs() {
  try { localStorage.setItem('dl-terminal-pairs', JSON.stringify(app.terminalPairs)); } catch { /* storage unavailable */ }
}

export function getTerminalPairs() {
  const live = new Set(app.termMap.keys());
  const order = new Map(getOrderedTerminalIds().map((id, index) => [id, index]));
  const used = new Set();
  const pairs = [];
  for (const pair of app.terminalPairs) {
    const termIds = [...new Set(pair.termIds)]
      .filter(id => live.has(id) && !used.has(id))
      .sort((first, second) => order.get(first) - order.get(second));
    if (termIds.length < 2) continue;
    termIds.forEach(id => used.add(id));
    const layout = normalizeTerminalGroupLayout(pair.layout || pair.direction, termIds.length);
    pairs.push({ termIds, layout, direction: layout === 'rows' ? 'v' : 'h' });
  }
  // 상태 비저장 뷰 — app.terminalPairs 원본은 보존하고 live 필터 결과만 반환.
  // 페이지 로드 직후(termMap이 WS 'terminals'로 채워지기 전) 읽기 접근이 메모리
  // 원본까지 비우면, 서버 재시작 후 idMap remap이 빈 상태에서 출발해 그룹이
  // 영구 소실된다. 저장은 명시적 편집(pair/unpair/layout/remap) 시에만.
  return pairs;
}

export function getTerminalPair(termId) {
  return getTerminalPairs().find(pair => pair.termIds.includes(termId)) || null;
}

export function pairTerminals(firstId, secondId, direction = 'h') {
  if (!app.termMap.has(firstId) || !app.termMap.has(secondId) || firstId === secondId) return null;
  const pairs = getTerminalPairs();
  const firstGroup = pairs.find(pair => pair.termIds.includes(firstId));
  const secondGroup = pairs.find(pair => pair.termIds.includes(secondId));
  if (firstGroup && firstGroup === secondGroup) return firstGroup;
  const order = new Map(getOrderedTerminalIds().map((id, index) => [id, index]));
  const termIds = [...new Set([
    ...(firstGroup?.termIds || [firstId]),
    ...(secondGroup?.termIds || [secondId]),
  ])].sort((first, second) => order.get(first) - order.get(second));
  app.terminalPairs = pairs.filter(pair => pair !== firstGroup && pair !== secondGroup);
  const layout = normalizeTerminalGroupLayout(firstGroup?.layout || secondGroup?.layout || direction, termIds.length);
  const pair = { termIds, layout, direction: layout === 'rows' ? 'v' : 'h' };
  app.terminalPairs.push(pair);
  persistTerminalPairs();
  return pair;
}

export function unpairTerminal(termId) {
  const before = getTerminalPairs();
  const group = before.find(pair => pair.termIds.includes(termId));
  if (!group) return false;
  const remaining = group.termIds.filter(id => id !== termId);
  app.terminalPairs = before.filter(pair => pair !== group);
  if (remaining.length >= 2) {
    const layout = normalizeTerminalGroupLayout(group.layout, remaining.length);
    app.terminalPairs.push({ termIds: remaining, layout, direction: layout === 'rows' ? 'v' : 'h' });
  }
  persistTerminalPairs();
  return true;
}

export function setTerminalPairDirection(termId, direction) {
  return setTerminalGroupLayout(termId, direction === 'v' ? 'rows' : 'cols');
}

export function setTerminalGroupLayout(termId, layout) {
  const pair = getTerminalPair(termId);
  if (!pair) return null;
  pair.layout = normalizeTerminalGroupLayout(layout, pair.termIds.length);
  pair.direction = pair.layout === 'rows' ? 'v' : 'h';
  app.terminalPairs = app.terminalPairs.map(item => item.termIds.some(id => pair.termIds.includes(id)) ? pair : item);
  persistTerminalPairs();
  return pair;
}

export function remapTerminalPairs(idMap) {
  app.terminalPairs = app.terminalPairs.map(pair => ({
    termIds: pair.termIds.map(id => idMap[id] || id),
    layout: normalizeTerminalGroupLayout(pair.layout || pair.direction, pair.termIds.length),
    direction: pair.direction === 'v' ? 'v' : 'h',
  }));
  persistTerminalPairs();
  return app.terminalPairs;
}

// ─── Pub/Sub ───
const _subscribers = new Map();

export function subscribe(key, fn) {
  if (!_subscribers.has(key)) _subscribers.set(key, new Set());
  _subscribers.get(key).add(fn);
  return () => _subscribers.get(key).delete(fn);
}

export function notify(key, value) {
  const subs = _subscribers.get(key);
  if (subs) for (const fn of subs) { try { fn(value); } catch (e) { console.error('[State]', key, e); } }
}
