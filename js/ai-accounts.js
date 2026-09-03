import { app, notify } from './state.js';
import { registerClickActions } from './actions.js';
import { esc, fetchJson, showToast } from './utils.js';

let loading = false;

function remaining(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

function resetLabel(value) {
  if (!value) return '초기화 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '초기화 정보 없음';
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
  if (minutes < 60) return `${minutes}분 후`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후`;
  return `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 후`;
}

function populateProjects() {
  const select = document.getElementById('ai-account-project');
  if (!select) return;
  const previous = select.value;
  const activeProject = app.termMap.get(app.activeTermId)?.projectId || '__home__';
  select.innerHTML = `<option value="__home__">홈 디렉터리</option>${app.projectList.map(project =>
    `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}`;
  select.value = [...select.options].some(option => option.value === previous) ? previous : activeProject;
}

function metric(label, value, resetAt, tone) {
  const known = Number.isFinite(value);
  const width = known ? Math.max(0, Math.min(100, value)) : 0;
  return `<div class="ai-account-metric">
    <div><span>${label}</span><strong>${remaining(value)}</strong></div>
    <div class="ai-account-meter" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${known ? `aria-valuenow="${Math.round(width)}"` : 'aria-valuetext="정보 없음"'}>
      <span class="${tone}" style="width:${width}%"></span>
    </div>
    <small>${esc(resetLabel(resetAt))}</small>
  </div>`;
}

function render(data) {
  const list = document.getElementById('ai-account-list');
  const status = document.getElementById('ai-accounts-status');
  if (!list || !status) return;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const ready = accounts.filter(account => account.state === 'ready').length;
  status.textContent = accounts.length
    ? `${data.runtime} · ${accounts.length}개 계정 · ${ready}개 실행 가능`
    : `${data.runtime || '로컬'} · 연결된 AI Account Hub 프로필이 없습니다.`;
  if (!accounts.length) {
    list.innerHTML = `<div class="ai-accounts-empty"><strong>계정을 찾지 못했습니다.</strong><span>Windows 또는 WSL의 .codex-account-launcher/profiles.json을 확인하세요.</span></div>`;
    return;
  }
  list.innerHTML = accounts.map(account => {
    const canOpen = account.state === 'ready';
    const stateLabel = account.state === 'ready' ? '사용 가능' : account.state === 'warning' ? '확인 필요' : '로그인 필요';
    return `<article class="ai-account-row ${esc(account.provider)}">
      <div class="ai-account-identity">
        <span class="ai-account-mark" aria-hidden="true">${account.provider === 'claude' ? 'C' : 'X'}</span>
        <div><h2>${esc(account.name)}</h2><p>${esc(account.email || account.provider)}</p></div>
      </div>
      <div class="ai-account-meta">
        <span>${esc(account.provider === 'claude' ? 'Claude Code' : 'Codex')}</span>
        ${account.plan ? `<span>${esc(account.plan)}</span>` : ''}
        <span>${esc(account.bridge)}</span>
      </div>
      <div class="ai-account-limits">
        ${metric('주간 잔여량', account.weeklyRemaining, account.weeklyResetAt, 'weekly')}
        ${metric('5시간 잔여량', account.sessionRemaining, account.sessionResetAt, 'session')}
      </div>
      <div class="ai-account-action">
        <span class="ai-account-state ${esc(account.state)}"><i></i>${stateLabel}</span>
        <button class="btn primary" type="button" data-action="open-ai-account-terminal" data-account-id="${esc(account.id)}" ${canOpen ? '' : 'disabled'}>터미널 열기</button>
      </div>
    </article>`;
  }).join('');
}

export async function initAiAccounts() {
  populateProjects();
  if (loading) return;
  loading = true;
  const status = document.getElementById('ai-accounts-status');
  if (status) status.textContent = '계정 정보를 불러오는 중…';
  try {
    render(await fetchJson('/api/ai-accounts'));
  } catch (error) {
    if (status) status.textContent = error.message || '계정 정보를 불러오지 못했습니다.';
    const list = document.getElementById('ai-account-list');
    if (list) list.innerHTML = '';
  } finally {
    loading = false;
  }
}

function openAccountTerminal(button) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    showToast('터미널 서버가 연결되지 않았습니다.', 'error');
    return;
  }
  const projectId = document.getElementById('ai-account-project')?.value || '__home__';
  app.ws.send(JSON.stringify({
    type: 'create', projectId, accountId: button.dataset.accountId, cols: 120, rows: 30,
  }));
  notify('switchView', 'terminal');
  showToast('선택한 계정으로 새 터미널을 여는 중…', 'info');
}

registerClickActions({
  'refresh-ai-accounts': initAiAccounts,
  'open-ai-account-terminal': openAccountTerminal,
});
