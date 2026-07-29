import { app, notify } from './state.js';
import { esc, fetchJson } from './utils.js';
import { filterCicdByProject } from './cicd.js';
import { getAgentAttentionForTerm, getAgentKind, getAgentState, getOperationalState, getReleaseGate, getWallSummary } from './agent-wall-state.js';

let timer;
let opsTimer;
let decisions = [];
let agentEvents = [];
const ciByProject = new Map();
const ciFetchedAt = new Map();
const popout = new URLSearchParams(location.search).get('agent-wall') === 'popout';
let mode = localStorage.getItem('cockpit-agent-wall-mode') || 'grid';

if (popout) document.body.classList.add('agent-wall-popout');

function tail(xterm) {
  const buf = xterm.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buf.length - 5); i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true).trim();
    if (line) lines.push(line);
  }
  return lines.slice(-3).join('\n') || '출력을 기다리는 중…';
}

function agentState(term, output) {
  return getAgentState({
    exited: term.exited,
    lastOutputAt: term.lastOutputAt,
    output,
    projectState: app.state.projects.get(term.projectId)?.session?.state,
  });
}

function freshness(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
  if (!ts) return 'No output yet';
  if (seconds < 10) return 'Active now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function tileHTML({ termId, term, kind, output, state, attention, gate, branch }) {
  const stateLabel = state === 'busy' ? 'Working' : state === 'waiting' ? 'Needs input' : state === 'done' ? 'Done' : 'Idle';
  return `<article class="agent-tile ${esc(state)}">
    <button class="agent-tile-main" data-term-id="${esc(termId)}" title="터미널로 이동">
      <span class="agent-tile-head"><span class="agent-tile-dot"></span><span class="agent-tile-name">${esc(term.label)}</span><span class="agent-tile-kind">${kind}</span><span class="agent-tile-state">${stateLabel}</span></span>
      <span class="agent-tile-meta"><span>${esc(branch || 'No branch')}</span><span>${freshness(term.lastOutputAt)}</span></span>
      <pre class="agent-tile-output">${esc(output)}</pre>
    </button>
    <span class="agent-tile-signals">${attention ? `<span class="agent-signal attention">${attention.decision === 'ask' ? 'Approval needed' : 'Blocked'}</span>` : ''}<span class="agent-gate-reason">${esc(gate.reason)}</span><button class="agent-signal gate ${esc(gate.state)}" data-gate-project="${esc(term.projectId)}" data-gate-target="${esc(gate.target)}" title="${esc(gate.reason)}">${esc(gate.label)}</button></span>
  </article>`;
}

function kanbanHTML(agents) {
  const groups = [
    ['Working', agents.filter(a => a.state === 'busy')],
    ['Waiting', agents.filter(a => a.state === 'waiting')],
    ['Done', agents.filter(a => a.state !== 'busy' && a.state !== 'waiting')],
  ];
  return groups.map(([label, items]) => `<section class="agent-kanban-col">
    <div class="agent-kanban-head"><span>${label}</span><span>${items.length}</span></div>
    <div class="agent-kanban-list">${items.length ? items.map(tileHTML).join('') : '<div class="agent-kanban-empty">No agents</div>'}</div>
  </section>`).join('');
}

function setMode(next) {
  mode = next === 'kanban' ? 'kanban' : 'grid';
  localStorage.setItem('cockpit-agent-wall-mode', mode);
  document.querySelectorAll('[data-agent-wall-action="mode"]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
  render();
}

function setDocked(on) {
  const panels = document.getElementById('term-panels');
  const dock = document.getElementById('agent-terminal-dock');
  const stage = document.getElementById('agent-wall-stage');
  if (!panels || !dock || !stage) return;
  if (on) dock.appendChild(panels);
  else restoreTerminalPanels();
  stage.classList.toggle('docked', on);
  document.querySelector('[data-agent-wall-action="dock"]')?.classList.toggle('active', on);
  notify('renderLayout');
  setTimeout(() => notify('fitAllTerminals'), 100);
}

export function restoreTerminalPanels() {
  const panels = document.getElementById('term-panels');
  const home = document.getElementById('term-panels-home');
  if (panels && home && panels.previousElementSibling !== home) home.after(panels);
  document.getElementById('agent-wall-stage')?.classList.remove('docked');
  document.querySelector('[data-agent-wall-action="dock"]')?.classList.remove('active');
}

function setupEvents(wall) {
  if (wall.dataset.ready) return;
  wall.dataset.ready = '1';
  wall.addEventListener('click', e => {
    const gate = e.target.closest('[data-gate-project]');
    if (gate) {
      e.stopPropagation();
      const target = gate.dataset.gateTarget;
      if (target === 'terminal') {
        app.activeTermId = gate.closest('.agent-tile')?.querySelector('[data-term-id]')?.dataset.termId;
        notify('switchView', 'terminal');
      } else if (target === 'changes') {
        notify('switchView', 'diff');
        const select = document.getElementById('diff-project');
        if (select) select.value = gate.dataset.gateProject;
        notify('loadDiff');
      } else if (target === 'pr') {
        notify('switchView', 'pr');
      } else {
        notify('switchView', 'cicd');
        filterCicdByProject(gate.dataset.gateProject);
      }
      return;
    }
    const tile = e.target.closest('[data-term-id]');
    if (!tile || !app.termMap.has(tile.dataset.termId)) return;
    if (popout && window.opener) {
      window.opener.postMessage({ type: 'cockpit-open-terminal', termId: tile.dataset.termId }, location.origin);
      window.opener.focus();
      return;
    }
    app.activeTermId = tile.dataset.termId;
    if (!document.getElementById('agent-wall-stage')?.classList.contains('docked')) notify('switchView', 'terminal');
    notify('renderLayout');
    setTimeout(() => notify('fitAllTerminals'), 100);
  });
  document.getElementById('agent-wall-section')?.addEventListener('click', e => {
    const button = e.target.closest('[data-agent-wall-action]');
    if (!button) return;
    if (button.dataset.agentWallAction === 'mode') setMode(button.dataset.mode);
    if (button.dataset.agentWallAction === 'dock') setDocked(!document.getElementById('agent-wall-stage')?.classList.contains('docked'));
    if (button.dataset.agentWallAction === 'popout') window.open(`${location.pathname}?agent-wall=popout`, 'cockpit-agent-wall', 'popup,width=1100,height=760');
    if (button.dataset.agentWallAction === 'focus') {
      (wall.querySelector('.agent-tile.waiting [data-term-id]') || wall.querySelector('.agent-signal.gate.hold'))?.click();
    }
  });
}

function render() {
  const wall = document.getElementById('agent-wall');
  const section = document.getElementById('agent-wall-section');
  if (!wall || !section) return;
  const detected = [];
  for (const [termId, term] of app.termMap) {
    if (term.exited) continue;
    const output = tail(term.xterm);
    const kind = term.agentScanKnown
      ? getAgentKind(term.agentCommand || '', '')
      : getAgentKind(term.agentCommand || term.command || '', output);
    if (!kind) continue;
    detected.push({ termId, term, kind, output });
  }
  const projectCounts = new Map();
  for (const { term } of detected) projectCounts.set(term.projectId, (projectCounts.get(term.projectId) || 0) + 1);
  const agents = detected.map(({ termId, term, kind, output }) => {
    const project = app.projectList.find(p => p.id === term.projectId);
    const hook = agentEvents.find(event => event.termId === termId);
    const attention = getAgentAttentionForTerm({ hook, decisions, projectPath: project?.path, projectAgentCount: projectCounts.get(term.projectId) });
    const rawState = hook?.state === 'busy' ? 'busy' : hook?.state === 'done' ? 'done' : agentState(term, output);
    const projectState = app.state.projects.get(term.projectId);
    const gate = getReleaseGate({ git: projectState?.git, prs: projectState?.prs?.prs, runs: ciByProject.get(term.projectId), attention });
    const state = getOperationalState(rawState, gate.state, attention);
    return { termId, term, kind, output, state, attention, gate, hook, branch: projectState?.git?.branch };
  }).sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention))
    || ['waiting', 'busy', 'idle', 'done'].indexOf(a.state) - ['waiting', 'busy', 'idle', 'done'].indexOf(b.state));
  section.style.display = agents.length || popout ? '' : 'none';
  const live = agents.filter(agent => agent.hook).length;
  const scanned = agents.length - live;
  document.getElementById('agent-wall-count').textContent = agents.length
    ? `${agents.length} online · ${live ? `${live} live hooks` : ''}${live && scanned ? ' · ' : ''}${scanned ? `${scanned} terminal scan` : ''}`
    : '';
  const summary = getWallSummary(agents);
  document.getElementById('agent-wall-summary').innerHTML = `
    <span><b>${summary.working}</b> working</span>
    <span class="${summary.waiting ? 'attention' : ''}"><b>${summary.waiting}</b> needs input</span>
    <span class="${summary.hold ? 'danger' : ''}"><b>${summary.hold}</b> release hold</span>
    <span class="${summary.ready ? 'ready' : ''}"><b>${summary.ready}</b> ready</span>`;
  document.querySelector('[data-agent-wall-action="focus"]').hidden = !summary.waiting && !summary.hold;
  wall.classList.toggle('kanban', mode === 'kanban');
  wall.innerHTML = agents.length ? (mode === 'kanban' ? kanbanHTML(agents) : agents.map(tileHTML).join('')) : '<div class="agent-kanban-empty">No Claude or Codex agents running</div>';
  document.querySelectorAll('[data-agent-wall-action="mode"]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
  setupEvents(wall);
}

export function updateAgentWall() {
  if (!opsTimer) {
    const refreshOps = async () => {
      fetchJson('/api/supervisor/recent?n=30', { timeoutMs: 3000 })
        .then(data => { decisions = Array.isArray(data) ? data : []; render(); })
        .catch(() => {});
      fetchJson('/api/supervisor/agents', { timeoutMs: 3000 })
        .then(data => { agentEvents = Array.isArray(data) ? data : []; render(); })
        .catch(() => {});
      const projectIds = [...new Set([...app.termMap.values()]
        .filter(t => !t.exited && (t.agentScanKnown
          ? getAgentKind(t.agentCommand || '', '')
          : getAgentKind(t.agentCommand || t.command || '', tail(t.xterm))))
        .map(t => t.projectId))];
      await Promise.all(projectIds.filter(id => Date.now() - (ciFetchedAt.get(id) || 0) > 30_000).map(async id => {
        ciFetchedAt.set(id, Date.now());
        const branch = app.state.projects.get(id)?.git?.branch;
        const query = new URLSearchParams({ limit: '20', ...(branch ? { branch } : {}) });
        try { ciByProject.set(id, await fetchJson(`/api/cicd/runs/${encodeURIComponent(id)}?${query}`, { timeoutMs: 10_000 })); }
        catch { ciByProject.set(id, null); }
      }));
      render();
    };
    refreshOps();
    opsTimer = setInterval(refreshOps, 5000);
  }
  if (timer) return;
  timer = setTimeout(() => { timer = null; render(); }, 250);
}

window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.data?.type !== 'cockpit-open-terminal' || !app.termMap.has(e.data.termId)) return;
  app.activeTermId = e.data.termId;
  notify('switchView', 'terminal');
  notify('renderLayout');
});
