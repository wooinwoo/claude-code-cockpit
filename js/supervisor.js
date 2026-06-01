// ─── Supervisor View: 권한 결정 이력 타임라인 ───
// /api/supervisor/recent (결정 피드) + /api/supervisor/status (대기 개수)
import { app } from './state.js';
import { esc, timeAgo, fetchJson } from './utils.js';

let _filter = 'all';          // all | approve | block | ask
let _decisions = [];          // 최근 결정 (최신 우선)
let _status = { pending: 0 }; // 대기 개수

const DECISION_META = {
  approve: { label: '승인', cls: 'ok' },
  block:   { label: '차단', cls: 'block' },
  ask:     { label: '질문', cls: 'ask' },
};

// input 객체 → 사람이 읽을 한 줄 요약
function summarizeInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  try { return JSON.stringify(input); } catch { return ''; }
}

// cwd → 등록된 프로젝트 이름, 없으면 마지막 경로 조각
function projectLabel(cwd) {
  if (!cwd) return '';
  const p = app.projectList?.find(pr => pr.path && cwd.startsWith(pr.path));
  if (p) return p.name;
  return cwd.split('/').filter(Boolean).pop() || cwd;
}

async function fetchData() {
  const headers = app.token ? { 'X-Token': app.token } : {};
  const [recent, status] = await Promise.all([
    fetchJson('/api/supervisor/recent?n=80', { headers }).catch(() => []),
    fetchJson('/api/supervisor/status', { headers }).catch(() => ({ pending: 0 })),
  ]);
  _decisions = Array.isArray(recent) ? recent.slice().reverse() : []; // 최신이 위로
  _status = status && typeof status.pending === 'number' ? status : { pending: 0 };
}

function render() {
  const feed = document.getElementById('sv-feed');
  if (!feed) return;

  // 필터 pill 카운트 + active
  const counts = { all: _decisions.length, approve: 0, block: 0, ask: 0 };
  for (const d of _decisions) { if (counts[d.decision] !== undefined) counts[d.decision]++; }
  document.querySelectorAll('.sv-filter').forEach(btn => {
    const k = btn.dataset.filter;
    btn.classList.toggle('active', k === _filter);
    const c = btn.querySelector('.sv-filter-count');
    if (c) c.textContent = counts[k] ?? 0;
  });

  // 대기 상태
  const pendEl = document.getElementById('sv-pending');
  if (pendEl) {
    const n = _status.pending || 0;
    pendEl.textContent = n > 0 ? `대기 ${n}건` : '대기 없음';
    pendEl.classList.toggle('active', n > 0);
  }

  const rows = _decisions.filter(d => _filter === 'all' || d.decision === _filter);
  if (!rows.length) {
    feed.innerHTML = `<li class="sv-empty">표시할 결정이 없어요${_filter !== 'all' ? ` (필터: ${esc(_filter)})` : ''}.</li>`;
    return;
  }

  feed.innerHTML = rows.map(d => {
    const m = DECISION_META[d.decision] || { label: d.decision || '?', cls: 'ask' };
    const conf = typeof d.confidence === 'number' ? ` · ${Math.round(d.confidence * 100)}%` : '';
    const proj = projectLabel(d.cwd);
    const cmd = summarizeInput(d.input);
    return (
      `<li class="sv-row sv-${m.cls}">` +
        `<span class="sv-dot" aria-hidden="true"></span>` +
        `<div class="sv-main">` +
          `<div class="sv-line1">` +
            `<span class="sv-decision">${esc(m.label)}</span>` +
            `<span class="sv-tool">${esc(d.tool || '?')}</span>` +
            `<span class="sv-policy">${esc(d.policy || '')}${conf}</span>` +
            `<span class="sv-time">${esc(timeAgo(d.ts))}</span>` +
          `</div>` +
          (cmd ? `<code class="sv-cmd">${esc(cmd)}</code>` : '') +
          ((proj || d.reasoning)
            ? `<div class="sv-meta">${proj ? `<span class="sv-proj">${esc(proj)}</span>` : ''}${d.reasoning ? `<span class="sv-reason">${esc(d.reasoning)}</span>` : ''}</div>`
            : '') +
        `</div>` +
      `</li>`
    );
  }).join('');
}

export async function initSupervisor() {
  const feed = document.getElementById('sv-feed');
  if (feed && !_decisions.length) feed.innerHTML = `<li class="sv-empty">불러오는 중...</li>`;
  try {
    await fetchData();
    render();
  } catch (e) {
    if (feed) feed.innerHTML = `<li class="sv-empty">불러오기 실패: ${esc(e?.message || String(e))} <button class="btn" data-action="supervisor-refresh">다시 시도</button></li>`;
  }
}

export function refreshSupervisor() { return initSupervisor(); }

export function setSupervisorFilter(decision) {
  _filter = ['approve', 'block', 'ask'].includes(decision) ? decision : 'all';
  render();
}
