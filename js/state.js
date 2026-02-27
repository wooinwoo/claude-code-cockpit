// ─── Shared Mutable State ───
// All modules import `app` and read/write properties directly.

const _themeManual = !!localStorage.getItem('dl-theme');

export const app = {
  // Core data
  state: { projects: new Map(), costs: null, usage: null, connected: false },
  projectList: [],
  prevSessionStates: new Map(),

  // WebSocket
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

  // SSE
  _sseBackoff: 1000,
  _sseReconnTimer: null,
  _sseConnectedAt: 0,

  // WS
  _wsBackoff: 1000,
  _wsReconnTimer: null,
  _wsConnectedAt: 0,

  // Diff
  _diffAbort: null,
  _diffDebounceTimer: null,
  _diffStagedCount: 0,
  _acPlan: null,
  _acExecuting: false,
  _acDragFile: null,
  _acBranchInfo: null,

  // Branch picker
  _branchData: null,
  _selectedBranch: null,

  // Command palette
  _cmdActiveIdx: 0,
  _cmdFiltered: [],

  // Project filter
  _projectStatusFilter: 'all',
  _projectTagFilter: '',
  _cardSortBy: localStorage.getItem('dl-card-sort') || 'name',

  // Cards
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

  // Discover
  _discoverData: [],
  _discoverSelected: new Set(),

  // Notification filter
  _notifFilter: JSON.parse(localStorage.getItem('dl-notif-filter') || '{}'),

  // Favicon
  _faviconLink: null,

  // Git action locks
  _gitActionLocks: new Set(),

  // Fit debounce
  fitDebounce: null,

  // CI/CD
  cicdRuns: [],
  cicdWorkflows: [],
  _cicdProject: null,
  _cicdLoading: false,
  _cicdInitialized: false,
  _cicdDetailRun: null,
  _cicdPollTimer: null,

  // Monitor
  monitorStats: null,
  _monitorTimer: null,
  _monitorInitialized: false,
  _monitorPaused: false,

  // Notes
  notesList: [],
  _activeNoteId: null,
  _notesInitialized: false,
  _notesDirty: false,
  _notesSaveTimer: null,
  _notesSaveState: null, // null | 'saving' | 'saved'

  // Logs
  logsFiles: [],
  logsContent: null,
  _logsProject: null,
  _logsActiveFile: null,
  _logsInitialized: false,
  _logsFilter: 'all',
  _logsFollowMode: true,
  _logsRefreshTimer: null,

  // Jira
  jiraIssues: [],
  jiraSprints: [],
  jiraBoards: [],
  jiraConfig: null,
  _jiraView: localStorage.getItem('dl-jira-view') || 'list',
  _jiraFilter: { project: '', sprint: '', status: '', search: '' },
  _jiraLoading: false,
  _jiraDetailKey: null,
  _jiraInitialized: false,

  // Workflows
  workflowDefs: [],
  workflowRuns: [],
  _activeWorkflowDefId: null,
  _activeWorkflowRunId: null,
  _workflowsInit: false,
};

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
