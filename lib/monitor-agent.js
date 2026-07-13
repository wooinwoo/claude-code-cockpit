// ═══════════════════════════════════════════════════════
// Agent Monitor — Proactive Background Monitoring
// Scans terminals, CI/CD, Jira for issues and alerts user
// ═══════════════════════════════════════════════════════

let _poller = null;
let _cockpit = null;
let _getProjects = null;
let _getJiraConfig = null;
let _triggerReview = null; // callback: (agentId, prompt, metadata) => Promise<void>

// Alert dedup — Map<alertKey, { timestamp, dismissed }>
const _alertHistory = new Map();
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 min
const SCAN_INTERVAL = 30 * 1000; // 30 sec
const REVIEW_COOLDOWN = 5 * 60 * 1000; // 5 min between AI reviews per project
const IDLE_THRESHOLD = 10 * 60 * 1000; // 10 min no terminal activity

// Per-terminal: track last scanned buffer length to only scan new data
const _termScanOffsets = new Map();

// Per-Jira: track last known issue update timestamps
let _lastJiraScan = 0;
const _knownJiraIssues = new Map(); // issueKey → { status, updated }

// Active alerts for API access
const _activeAlerts = new Map();

// Report storage — persisted reviews/reports from AI agents
const _reports = [];
const MAX_REPORTS = 50;

// Git monitoring state
const _lastGitState = new Map(); // projectId → { uncommittedCount, lastCommitHash, ts }
const _lastReviewTime = new Map(); // projectId → timestamp of last AI review

// Idle monitoring state
const _lastTermActivity = new Map(); // termId → timestamp of last buffer change
let _lastIdleNag = 0; // global idle nag cooldown

// Error patterns for terminal scanning
const TERMINAL_ERROR_PATTERNS = [
  { pattern: /\b(ENOENT|EACCES|EPERM|EADDRINUSE)\b/i, level: 'error', type: 'node-error' },
  { pattern: /\b(segfault|SIGSEGV|SIGABRT|SIGKILL)\b/i, level: 'error', type: 'crash' },
  { pattern: /\b(FATAL|panic|OOM|OutOfMemory|heap out of memory)\b/i, level: 'error', type: 'fatal' },
  { pattern: /npm ERR!/i, level: 'error', type: 'npm-error' },
  { pattern: /\bFAIL\b.*test|Tests?:.*\d+\s+failed/i, level: 'warning', type: 'test-fail' },
  { pattern: /Traceback \(most recent call last\)/i, level: 'error', type: 'python-error' },
  { pattern: /Unhandled\s+(promise\s+)?rejection/i, level: 'error', type: 'unhandled-rejection' },
  { pattern: /TypeError|ReferenceError|SyntaxError/i, level: 'error', type: 'js-error' },
  { pattern: /BUILD FAILED|Build failed|Compilation failed/i, level: 'error', type: 'build-fail' },
  { pattern: /error TS\d+:/i, level: 'error', type: 'ts-error' },
  { pattern: /\[ERROR\]\s+.{5,}/i, level: 'warning', type: 'generic-error' },
];

// Strip ANSI escape codes
function stripAnsi(s) {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

function makeAlertKey(source, type, id) {
  return `${source}:${type}:${id}`;
}

function isDuplicate(key) {
  const prev = _alertHistory.get(key);
  if (!prev) return false;
  if (prev.dismissed) return true; // user dismissed, don't re-alert
  return (Date.now() - prev.timestamp) < ALERT_COOLDOWN;
}

function recordAlert(key) {
  _alertHistory.set(key, { timestamp: Date.now(), dismissed: false });
}

function broadcastAlert(alert) {
  _activeAlerts.set(alert.id, alert);
  _poller?.broadcast('agent:proactive', alert);
}

// ─── Terminal Scanning ───

function scanTerminals() {
  const alerts = [];
  const terms = _cockpit?.listTerminals?.() || [];
  const projects = _cockpit?.getProjects?.() || [];
  const projMap = Object.fromEntries(projects.map(p => [p.id, p.name]));

  for (const term of terms) {
    const buf = _cockpit?.readTerminalBuffer?.(term.termId);
    if (!buf) continue;

    // Track offset on raw buffer length (before ANSI stripping) to avoid drift
    const prevOffset = _termScanOffsets.get(term.termId) || 0;
    if (buf.length <= prevOffset) continue;
    _termScanOffsets.set(term.termId, buf.length);

    const rawNew = buf.slice(prevOffset);
    const newData = stripAnsi(rawNew);

    for (const { pattern, level, type } of TERMINAL_ERROR_PATTERNS) {
      const match = newData.match(pattern);
      if (!match) continue;

      const key = makeAlertKey('terminal', type, term.termId);
      if (isDuplicate(key)) continue;
      recordAlert(key);

      // Extract context around the match
      const idx = newData.indexOf(match[0]);
      const start = Math.max(0, idx - 100);
      const end = Math.min(newData.length, idx + match[0].length + 200);
      const context = newData.slice(start, end).trim();

      alerts.push({
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        _alertKey: key,
        source: 'terminal',
        level,
        title: `터미널 ${type} 감지`,
        detail: context.slice(0, 300),
        context: {
          termId: term.termId,
          projectId: term.projectId,
          projectName: projMap[term.projectId] || term.projectId,
          command: term.command || '(shell)',
        },
        suggestedAction: `터미널에서 ${type} 에러가 감지됐어영. 분석할까여?`,
        suggestedPrompt: `Terminal ${term.termId} (project: ${projMap[term.projectId] || term.projectId}) has a ${type} error:\n\n${context.slice(0, 500)}\n\nAnalyze this error and suggest a fix.`,
        timestamp: Date.now(),
      });
      break; // one alert per terminal per scan
    }
  }

  // Clean up offsets for dead terminals
  const activeIds = new Set(terms.map(t => t.termId));
  for (const id of _termScanOffsets.keys()) {
    if (!activeIds.has(id)) _termScanOffsets.delete(id);
  }

  return alerts;
}

// ─── CI/CD Scanning ───

async function scanCicd() {
  const alerts = [];
  const projects = _getProjects?.() || [];

  for (const proj of projects) {
    if (!proj.github) continue;
    const cached = _poller?.getCached?.('cicd:' + proj.id);
    if (!cached?.runs?.length) continue;

    const latestRun = cached.runs[0];
    if (latestRun.conclusion !== 'failure') continue;

    const key = makeAlertKey('cicd', 'failure', `${proj.id}:${latestRun.id}`);
    if (isDuplicate(key)) continue;
    recordAlert(key);

    alerts.push({
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      _alertKey: key,
      source: 'cicd',
      level: 'error',
      title: `CI/CD 실패: ${proj.name}`,
      detail: `${latestRun.name || 'workflow'} — ${latestRun.conclusion} (${latestRun.head_branch || '?'})`,
      context: {
        projectId: proj.id,
        projectName: proj.name,
        runId: latestRun.id,
        url: latestRun.html_url || '',
        workflow: latestRun.name,
        branch: latestRun.head_branch,
      },
      suggestedAction: `${proj.name}의 CI/CD가 실패했어영. 로그 분석할까여?`,
      suggestedPrompt: `CI/CD pipeline "${latestRun.name}" failed for project ${proj.name} (branch: ${latestRun.head_branch}). Run ID: ${latestRun.id}. Analyze the failure using the CICD tool and suggest fixes.`,
      timestamp: Date.now(),
    });
  }

  return alerts;
}

// ─── Jira Scanning ───

async function scanJira() {
  const alerts = [];
  if (!_getJiraConfig) return alerts;
  const config = _getJiraConfig();
  if (!config?.url || !config?.email || !config?.token) return alerts;

  // Only scan every 2 minutes (Jira API is slower)
  if (Date.now() - _lastJiraScan < 120000) return alerts;
  _lastJiraScan = Date.now();

  try {
    const jira = await import('./jira-service.js');
    const issues = await jira.getMyIssues(config, { maxResults: 15 });

    for (const issue of issues) {
      const key = issue.key;
      const prev = _knownJiraIssues.get(key);
      const currentStatus = issue.fields?.status?.name || '';
      const updated = issue.fields?.updated || '';

      if (prev) {
        // Check for status change
        if (prev.status !== currentStatus) {
          const alertKey = makeAlertKey('jira', 'status-change', `${key}:${currentStatus}`);
          if (!isDuplicate(alertKey)) {
            recordAlert(alertKey);
            alerts.push({
              id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              _alertKey: alertKey,
              source: 'jira',
              level: 'info',
              title: `Jira 상태 변경: ${key}`,
              detail: `${issue.fields?.summary || key}: ${prev.status} → ${currentStatus}`,
              context: { issueKey: key, from: prev.status, to: currentStatus },
              suggestedAction: `${key} 이슈 상태가 바뀌었어영 (${prev.status} → ${currentStatus}). 확인할까여?`,
              suggestedPrompt: `Jira issue ${key} "${issue.fields?.summary}" status changed from "${prev.status}" to "${currentStatus}". Show me the issue details using the JIRA tool.`,
              timestamp: Date.now(),
            });
          }
        }

        // Check for new comments (updated time changed but status didn't)
        if (prev.updated !== updated && prev.status === currentStatus) {
          const alertKey = makeAlertKey('jira', 'updated', `${key}:${updated}`);
          if (!isDuplicate(alertKey)) {
            recordAlert(alertKey);
            alerts.push({
              id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              _alertKey: alertKey,
              source: 'jira',
              level: 'info',
              title: `Jira 업데이트: ${key}`,
              detail: `${issue.fields?.summary || key} — 새 업데이트 있음`,
              context: { issueKey: key },
              suggestedAction: `${key} 이슈에 업데이트가 있어영. 확인할까여?`,
              suggestedPrompt: `Jira issue ${key} "${issue.fields?.summary}" was updated. Show me the latest details using the JIRA tool.`,
              timestamp: Date.now(),
            });
          }
        }
      }

      _knownJiraIssues.set(key, { status: currentStatus, updated });
    }

    // Check sprint deadline proximity
    try {
      const sprints = await jira.getAllActiveSprints(config);
      for (const sprint of sprints) {
        if (!sprint.endDate) continue;
        const remaining = new Date(sprint.endDate) - Date.now();
        const hoursLeft = remaining / (1000 * 60 * 60);

        if (hoursLeft > 0 && hoursLeft < 24) {
          const alertKey = makeAlertKey('jira', 'sprint-deadline', sprint.id);
          if (!isDuplicate(alertKey)) {
            recordAlert(alertKey);
            alerts.push({
              id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              _alertKey: alertKey,
              source: 'jira',
              level: 'warning',
              title: `스프린트 마감 임박`,
              detail: `"${sprint.name}" — ${Math.round(hoursLeft)}시간 남음`,
              context: { sprintId: sprint.id, sprintName: sprint.name, hoursLeft: Math.round(hoursLeft) },
              suggestedAction: `스프린트 "${sprint.name}"이 ${Math.round(hoursLeft)}시간 뒤 마감이에영! 현황 확인할까여?`,
              suggestedPrompt: `Sprint "${sprint.name}" ends in ${Math.round(hoursLeft)} hours. Show me the sprint status and remaining issues using the JIRA tool.`,
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch { /* sprint check is optional */ }
  } catch (err) {
    // Jira might not be configured or network issue — silently skip
    if (err.message?.includes('401') || err.message?.includes('403')) {
      console.warn('[Monitor] Jira auth failed, skipping scan');
    }
  }

  return alerts;
}

// ─── Git Change Monitoring ───

function scanGitChanges() {
  const alerts = [];
  const projects = _getProjects?.() || [];

  for (const proj of projects) {
    const cached = _poller?.getCached?.('git:' + proj.id);
    if (!cached) continue;

    const prev = _lastGitState.get(proj.id);
    const currentCount = (cached.stagedFiles?.length || 0) + (cached.unstagedFiles?.length || 0);
    const currentHash = cached.recentCommits?.[0]?.hash || '';

    if (!prev) {
      _lastGitState.set(proj.id, { uncommittedCount: currentCount, lastCommitHash: currentHash, ts: Date.now() });
      continue;
    }

    // Detect new commit
    if (currentHash && currentHash !== prev.lastCommitHash) {
      const key = makeAlertKey('git', 'new-commit', `${proj.id}:${currentHash}`);
      if (!isDuplicate(key)) {
        recordAlert(key);
        const commitMsg = cached.recentCommits?.[0]?.message || '';
        alerts.push({
          id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          _alertKey: key,
          source: 'git',
          level: 'info',
          title: `새 커밋: ${proj.name}`,
          detail: `${currentHash.slice(0, 7)} — ${commitMsg.slice(0, 80)}`,
          context: { projectId: proj.id, projectName: proj.name, hash: currentHash, message: commitMsg },
          suggestedAction: `${proj.name}에 새 커밋이 올라왔어영. 리뷰할까여?`,
          suggestedPrompt: `Review the latest commit in ${proj.name}: ${currentHash.slice(0, 7)} "${commitMsg}". Use GIT_LOG and GIT_DIFF to analyze the changes and give feedback.`,
          timestamp: Date.now(),
        });

        // Trigger AI commit review (dev_gwajang — CI/code review specialist)
        triggerReviewIfReady(proj.id, 'dev_gwajang', {
          type: 'commit-review',
          prompt: `${proj.name} 프로젝트에 새 커밋이 올라왔어. 커밋 해시: ${currentHash.slice(0, 7)}, 메시지: "${commitMsg}". GIT_DIFF로 변경 내용을 확인하고 코드 리뷰를 간결하게 해줘. 문제 있으면 지적하고, 괜찮으면 짧게 칭찬해.`,
          projectId: proj.id,
          projectName: proj.name,
        });
      }
    }

    // Detect significant uncommitted changes (increase by 3+ files)
    if (currentCount >= 3 && currentCount > prev.uncommittedCount + 2) {
      const key = makeAlertKey('git', 'uncommitted', `${proj.id}:${currentCount}`);
      if (!isDuplicate(key)) {
        recordAlert(key);
        const fileNames = [...(cached.stagedFiles || []), ...(cached.unstagedFiles || [])].slice(0, 5).map(f => f.file || f.name || f).join(', ');
        alerts.push({
          id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          _alertKey: key,
          source: 'git',
          level: 'info',
          title: `변경사항 증가: ${proj.name}`,
          detail: `${currentCount}개 파일 변경 — ${fileNames}`,
          context: { projectId: proj.id, projectName: proj.name, fileCount: currentCount },
          suggestedAction: `${proj.name}에 ${currentCount}개 파일 변경됐어영. 확인해볼까여?`,
          suggestedPrompt: `${proj.name} has ${currentCount} uncommitted changes. Files: ${fileNames}. Use GIT_DIFF to review the changes and suggest if they should be committed.`,
          timestamp: Date.now(),
        });

        // Trigger AI diff review (dev_bujang — senior dev)
        triggerReviewIfReady(proj.id, 'dev_bujang', {
          type: 'diff-review',
          prompt: `${proj.name} 프로젝트에 ${currentCount}개 파일이 변경되었어. GIT_DIFF:${proj.path}로 변경 내용 확인하고 간결하게 리뷰해줘. 잘한 부분, 주의할 부분, 개선 제안 각각 1-2줄.`,
          projectId: proj.id,
          projectName: proj.name,
        });
      }
    }

    _lastGitState.set(proj.id, { uncommittedCount: currentCount, lastCommitHash: currentHash, ts: Date.now() });
  }

  return alerts;
}

// ─── Idle Detection ───

function scanIdle() {
  const alerts = [];
  const terms = _cockpit?.listTerminals?.() || [];
  const now = Date.now();

  // Update activity timestamps
  for (const term of terms) {
    const buf = _cockpit?.readTerminalBuffer?.(term.termId);
    if (!buf) continue;
    const prev = _lastTermActivity.get(term.termId);
    if (!prev || buf.length !== prev.bufLen) {
      _lastTermActivity.set(term.termId, { bufLen: buf.length, ts: now });
    }
  }

  // Check if ALL terminals are idle
  if (terms.length === 0) return alerts;
  const allIdle = terms.every(t => {
    const act = _lastTermActivity.get(t.termId);
    return act && (now - act.ts) > IDLE_THRESHOLD;
  });

  if (allIdle && (now - _lastIdleNag) > 30 * 60 * 1000) { // 30min cooldown
    _lastIdleNag = now;
    const idleMin = Math.round(IDLE_THRESHOLD / 60000);
    const nags = [
      '뭐해 일해.',
      '터미널이 멈춰있는뎅.. 쉬는 거야?',
      '혹시 퇴근한 거 아니지?',
      '코드 한 줄이라도 써봐.',
      '자리 비운 거면 잠금이라도 걸어둬.',
    ];
    const nag = nags[Math.floor(Math.random() * nags.length)];
    alerts.push({
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      _alertKey: makeAlertKey('idle', 'nag', 'global'),
      source: 'idle',
      level: 'warning',
      title: nag,
      detail: `${idleMin}분 이상 터미널 활동 없음`,
      context: {},
      suggestedAction: '',
      suggestedPrompt: '',
      timestamp: now,
    });
  }

  // Clean up dead terminals
  const activeIds = new Set(terms.map(t => t.termId));
  for (const id of _lastTermActivity.keys()) {
    if (!activeIds.has(id)) _lastTermActivity.delete(id);
  }

  return alerts;
}

// ─── AI Review Trigger ───

function triggerReviewIfReady(projectId, agentId, metadata) {
  if (!_triggerReview) return;
  const lastReview = _lastReviewTime.get(projectId) || 0;
  if (Date.now() - lastReview < REVIEW_COOLDOWN) return;
  _lastReviewTime.set(projectId, Date.now());

  // Fire-and-forget: triggers agentChat which sends SSE events
  // Frontend (company.js) captures agent:response and creates report via onEv_captureReport
  _triggerReview(agentId, metadata.prompt, metadata).catch(err => {
    console.warn(`[Monitor] Review trigger failed for ${agentId}:`, err.message);
  });
}

// ─── Report Management ───

function _addReport(report) {
  const entry = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    ...report,
    timestamp: Date.now(),
    dismissed: false,
  };
  _reports.unshift(entry);
  if (_reports.length > MAX_REPORTS) _reports.length = MAX_REPORTS;
  _poller?.broadcast('monitor:report', entry);
  return entry;
}

// ─── Main Check Cycle ───

async function checkAll() {
  try {
    const termAlerts = scanTerminals();
    const cicdAlerts = await scanCicd();
    const jiraAlerts = await scanJira();
    const gitAlerts = scanGitChanges();
    const idleAlerts = scanIdle();
    const allAlerts = [...termAlerts, ...cicdAlerts, ...jiraAlerts, ...gitAlerts, ...idleAlerts];

    for (const alert of allAlerts) {
      broadcastAlert(alert);
    }

    // Clean up old alert history (older than 30 min)
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, val] of _alertHistory) {
      if (val.timestamp < cutoff) _alertHistory.delete(key);
    }

    // Clean up old active alerts (older than 10 min)
    const activeCutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, alert] of _activeAlerts) {
      if (alert.timestamp < activeCutoff) _activeAlerts.delete(id);
    }
  } catch (err) {
    console.warn('[Monitor] Check cycle error:', err.message);
  }
}

// ─── Public API ───

export function init(poller, cockpitServices, getProjects, extras = {}) {
  _poller = poller;
  _cockpit = cockpitServices;
  _getProjects = getProjects;
  _getJiraConfig = extras.getJiraConfig || null;
  _triggerReview = extras.triggerReview || null;

  // Start background scanning
  setInterval(checkAll, SCAN_INTERVAL);
  // First scan after 10 seconds (let everything initialize)
  setTimeout(checkAll, 10000);
  console.log('[Monitor] Agent monitor started (interval: 30s)');
}

export function getActiveAlerts() {
  return [..._activeAlerts.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function getReports() {
  return _reports.filter(r => !r.dismissed);
}

export function getAllReports() {
  return [..._reports];
}

export function dismissReport(reportId) {
  const r = _reports.find(x => x.id === reportId);
  if (r) r.dismissed = true;
  return { dismissed: !!r };
}

export function dismissAlert(alertId) {
  const alert = _activeAlerts.get(alertId);
  if (!alert) return { dismissed: false };
  _activeAlerts.delete(alertId);
  // Mark in history as dismissed to prevent re-alerting
  if (alert._alertKey) {
    _alertHistory.set(alert._alertKey, { timestamp: Date.now(), dismissed: true });
  }
  return { dismissed: true };
}

export function clearAllAlerts() {
  _activeAlerts.clear();
  return { cleared: true };
}
