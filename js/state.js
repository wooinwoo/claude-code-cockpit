// ─── Shared Mutable State ───
// All modules import `app` and read/write properties directly.
// Feature-specific state is grouped into namespace objects.
// A Proxy provides backward compatibility: `app.cicdRuns` → `app.cicd.runs`.

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
  layoutRoot: null,
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
  currentTheme: _themeManual
    ? localStorage.getItem('dl-theme')
    : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
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
