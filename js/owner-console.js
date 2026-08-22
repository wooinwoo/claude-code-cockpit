const MAX_PROJECTS = 3;

const state = {
  summary: null,
  projects: [],
  selectedId: 'project-director-1',
  board: [],
  timer: null,
};

const $ = id => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatText(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function toast(message, kind = 'info') {
  const root = $('toast');
  root.textContent = message;
  root.className = `toast visible ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { root.className = 'toast'; }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function selectedDirector() {
  return state.summary?.directors?.find(director => director.id === state.selectedId) || null;
}

function statusLabel(status) {
  return ({ idle: '대기', running: '작업 중', unassigned: '미배정', error: '확인 필요' })[status] || status;
}

function renderDirectors() {
  if (!state.summary) return;
  $('owner-director-list').innerHTML = state.summary.directors.map(director => `
    <button class="director-card ${director.id === state.selectedId ? 'active' : ''}" data-director="${escapeHtml(director.id)}" type="button">
      <span class="director-avatar">${director.kind === 'skill' ? 'S' : director.id.split('-').at(-1)}</span>
      <span class="director-copy">
        <strong>${escapeHtml(director.name)}</strong>
        <small>${escapeHtml(director.projectId || (director.kind === 'skill' ? '공용 역량 체계' : '프로젝트를 배정하세요'))}</small>
      </span>
      <span class="director-status status-${escapeHtml(director.status)}">${escapeHtml(statusLabel(director.status))}</span>
    </button>`).join('');

  document.querySelectorAll('[data-director]').forEach(button => {
    button.addEventListener('click', () => selectDirector(button.dataset.director));
  });
}

function renderHeader() {
  const director = selectedDirector();
  if (!director) return;
  $('owner-chat-title').textContent = director.name;
  $('owner-chat-subtitle').textContent = director.kind === 'skill'
    ? '공용 스킬·검증 체계·조직 학습을 관리합니다.'
    : director.cwd ? `${director.cwd} · ${director.board}` : '프로젝트를 배정하면 활성화됩니다.';
  const available = Boolean(director.cwd) && director.status !== 'running';
  $('owner-message-input').disabled = !available;
  $('owner-message-input').placeholder = director.cwd
    ? '목표와 판단 기준을 Director에게 전달…'
    : '먼저 프로젝트를 배정하세요.';
  $('owner-send-btn').disabled = !available;
  $('owner-dispatch-btn').disabled = !director.cwd || director.kind !== 'project';
}

function renderRuns() {
  const root = $('owner-chat-stream');
  const runs = (state.summary?.recentRuns || [])
    .filter(run => run.directorId === state.selectedId)
    .slice()
    .reverse();
  if (!runs.length) {
    root.innerHTML = '<div class="empty-state"><strong>Director가 준비됐습니다.</strong><span>목표를 한 문장으로 주면 계획·위임·검증·수정 루프를 구성합니다.</span></div>';
    return;
  }
  root.innerHTML = runs.map(run => `
    <article class="message owner-message"><div class="message-label">Owner</div><div>${formatText(run.prompt)}</div></article>
    <article class="message director-message ${run.status === 'failed' ? 'failed' : ''}">
      <div class="message-label">Director · ${escapeHtml(run.status)}</div>
      <div>${run.output ? formatText(run.output) : run.error ? formatText(run.error) : '<span class="thinking">판단하고 작업을 배정하는 중…</span>'}</div>
    </article>`).join('');
  root.scrollTop = root.scrollHeight;
}

function taskGroup(task) {
  if (task.status === 'running') return 'running';
  if (task.status === 'blocked' || task.status === 'review') return 'attention';
  if (task.status === 'done' || task.status === 'archived') return 'done';
  return 'queued';
}

function renderBoard() {
  const groups = { running: [], attention: [], queued: [], done: [] };
  for (const task of state.board) groups[taskGroup(task)].push(task);
  const labels = { running: '실행 중', attention: '판단 필요', queued: '대기', done: '완료' };
  $('owner-task-board').innerHTML = Object.entries(groups).map(([key, tasks]) => `
    <section class="task-column">
      <header><span>${labels[key]}</span><b>${tasks.length}</b></header>
      <div>${tasks.slice(0, 12).map(task => `
        <article class="task-card task-${key}"><strong>${escapeHtml(task.title || task.id)}</strong><span>${escapeHtml(task.assignee || 'unassigned')}</span></article>
      `).join('') || '<div class="column-empty">없음</div>'}</div>
    </section>`).join('');
  $('owner-attention-list').innerHTML = groups.attention.length
    ? groups.attention.map(task => `<article><strong>${escapeHtml(task.title || task.id)}</strong><span>${formatText(task.result || task.blocked_reason || task.status)}</span></article>`).join('')
    : '<div class="column-empty">Owner에게 올라온 결정이 없습니다.</div>';
}

async function loadBoard() {
  const director = selectedDirector();
  if (!director?.cwd || director.kind !== 'project') {
    state.board = [];
    renderBoard();
    return;
  }
  try {
    const result = await api(`/api/directors/${encodeURIComponent(director.id)}/board`);
    state.board = result.tasks || [];
  } catch (error) {
    state.board = [];
    console.warn('[Praetorium] board:', error.message);
  }
  renderBoard();
}

async function loadConsole({ quiet = false } = {}) {
  try {
    state.summary = await api('/api/directors');
    if (!state.summary.directors.some(director => director.id === state.selectedId)) {
      state.selectedId = state.summary.directors[0]?.id;
    }
    renderDirectors();
    renderHeader();
    renderRuns();
    await loadBoard();
    $('connection-state').className = 'connection-state online';
    $('connection-state').lastElementChild.textContent = '로컬 연결';
  } catch (error) {
    $('connection-state').className = 'connection-state offline';
    $('connection-state').lastElementChild.textContent = '연결 끊김';
    if (!quiet) toast(error.message, 'error');
  }
}

async function selectDirector(id) {
  state.selectedId = id;
  renderDirectors();
  renderHeader();
  renderRuns();
  await loadBoard();
}

async function sendMessage() {
  const input = $('owner-message-input');
  const prompt = input.value.trim();
  if (!prompt) return;
  try {
    await api(`/api/directors/${encodeURIComponent(state.selectedId)}/messages`, {
      method: 'POST', body: JSON.stringify({ prompt }),
    });
    input.value = '';
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function dispatchNow() {
  try {
    const result = await api(`/api/directors/${encodeURIComponent(state.selectedId)}/dispatch`, {
      method: 'POST', body: '{}',
    });
    toast(`배치 완료 · ${result.spawned ?? 0}개 시작`, 'success');
    await loadConsole({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

function renderProjects() {
  $('project-capacity').textContent = `${state.projects.length} / ${MAX_PROJECTS}`;
  $('project-list').innerHTML = state.projects.length ? state.projects.map((project, index) => `
    <article class="project-row">
      <span class="project-slot">${index + 1}</span>
      <span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.path)}</small></span>
      <button type="button" data-remove-project="${escapeHtml(project.id)}">제거</button>
    </article>`).join('') : '<div class="project-empty">배정된 프로젝트가 없습니다.</div>';
  document.querySelectorAll('[data-remove-project]').forEach(button => {
    button.addEventListener('click', () => removeProject(button.dataset.removeProject));
  });
  $('add-project-btn').disabled = state.projects.length >= MAX_PROJECTS;
  $('discover-projects-btn').disabled = state.projects.length >= MAX_PROJECTS;
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
}

async function addProject() {
  const name = $('project-name').value.trim();
  const path = $('project-path').value.trim();
  if (!name || !path) return toast('이름과 절대 경로를 입력하세요.', 'error');
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, path }) });
    $('project-name').value = '';
    $('project-path').value = '';
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast('Director에 프로젝트를 배정했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function removeProject(id) {
  try {
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast('프로젝트 배정을 제거했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function discoverProjects() {
  try {
    const result = await api('/api/projects/discover', { method: 'POST', body: '{}' });
    await Promise.all([loadProjects(), loadConsole({ quiet: true })]);
    toast(result.added ? `${result.added}개 프로젝트를 자동 배정했습니다.` : '새 프로젝트를 찾지 못했습니다.', result.added ? 'success' : 'info');
  } catch (error) { toast(error.message, 'error'); }
}

function initTheme() {
  const saved = localStorage.getItem('praetorium-theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('praetorium-theme', next);
  });
}

function init() {
  initTheme();
  $('owner-send-btn').addEventListener('click', sendMessage);
  $('owner-message-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
  });
  $('owner-refresh-btn').addEventListener('click', () => loadConsole());
  $('owner-dispatch-btn').addEventListener('click', dispatchNow);
  $('project-settings-btn').addEventListener('click', async () => {
    await loadProjects();
    $('project-dialog').showModal();
  });
  $('add-project-btn').addEventListener('click', addProject);
  $('discover-projects-btn').addEventListener('click', discoverProjects);
  loadConsole();
  state.timer = setInterval(() => loadConsole({ quiet: true }), 4000);
}

init();

export const _test = { statusLabel, taskGroup };
