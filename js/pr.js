// ─── Pull Requests Module ───
import { app } from './state.js';
import { esc, showToast, timeAgo, fetchJson, fetchText, postJson } from './utils.js';
import { registerClickActions, registerChangeActions, registerInputActions } from './actions.js';

let _prList = [];
let _prFilter = { project: '', status: 'all', search: '' };
let _prLoading = false;
let _prInitialized = false;
let _prDetailData = null;

// ─── Init ───
export function initPR() {
  if (_prInitialized) return;
  _prInitialized = true;
  populateProjectFilter();
  loadAllPRs();
}

function populateProjectFilter() {
  const sel = document.getElementById('pr-project-filter');
  if (!sel || sel.dataset.populated) return;
  sel.dataset.populated = '1';
  sel.innerHTML = '<option value="">All Projects</option>' +
    app.projectList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}

// ─── Load ───
async function loadAllPRs() {
  if (_prLoading) return;
  _prLoading = true;
  const content = document.getElementById('pr-content');
  if (content) content.innerHTML = '<div class="pr-loading">Loading pull requests...</div>';
  try {
    const data = await fetchJson(`/api/prs?state=${_prFilter.status}`);
    _prList = data.prs || [];
    renderPRList();
    renderPRSummary();
  } catch (e) {
    if (content) content.innerHTML = `<div class="pr-empty"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><div class="pre-title">Failed to load PRs</div><div class="pre-sub">${esc(e.message)}</div></div>`;
  }
  _prLoading = false;
}

// ─── Filter ───
function getFilteredPRs() {
  let prs = [..._prList];
  if (_prFilter.project) prs = prs.filter(p => p.projectId === _prFilter.project);
  const q = _prFilter.search?.toLowerCase();
  if (q) prs = prs.filter(p => p.title.toLowerCase().includes(q) || `#${p.number}`.includes(q) || p.author.toLowerCase().includes(q) || p.branch.toLowerCase().includes(q));
  return prs;
}

// ─── Summary ───
function renderPRSummary() {
  const bar = document.getElementById('pr-summary');
  if (!bar) return;
  const total = _prList.length;
  const open = _prList.filter(p => p.state === 'OPEN').length;
  const merged = _prList.filter(p => p.state === 'MERGED').length;
  const closed = _prList.filter(p => p.state === 'CLOSED').length;
  bar.innerHTML = `<span class="prs-stat"><span class="prs-num">${total}</span> total</span>`
    + (open ? `<span class="prs-stat"><span class="prs-num prs-pending">${open}</span> open</span>` : '')
    + (merged ? `<span class="prs-stat"><span class="prs-num prs-merged">${merged}</span> merged</span>` : '')
    + (closed ? `<span class="prs-stat"><span class="prs-num prs-closed">${closed}</span> closed</span>` : '');
}

// ─── Render List ───
function renderPRList() {
  const el = document.getElementById('pr-content');
  if (!el) return;
  const prs = getFilteredPRs();
  if (!prs.length) {
    el.innerHTML = '<div class="pr-empty"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7.5" cy="4.5" r="2.5"/><path d="M7.5 7v10"/><circle cx="7.5" cy="19.5" r="2.5"/><circle cx="16.5" cy="4.5" r="2.5"/><path d="M16.5 7v3a3 3 0 01-3 3h-6"/></svg><div class="pre-title">No pull requests</div><div class="pre-sub">No open PRs match the current filters</div></div>';
    return;
  }

  el.innerHTML = prs.map(pr => {
    const reviewCls = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending';
    const reviewLabel = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes' : 'Review';
    const checksOk = pr.checks?.length ? pr.checks.every(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success') : null;
    const checksBadge = checksOk === null ? '' : checksOk ? '<span class="pr-check pr-check-ok" title="Checks passed">&#10003;</span>' : '<span class="pr-check pr-check-fail" title="Checks failed">&#10007;</span>';
    return `<div class="pr-row" data-action="show-pr-detail" data-project="${esc(pr.projectId)}" data-number="${pr.number}">
      <div class="pr-row-left">
        <span class="pr-review-badge pr-rv-${reviewCls}">${reviewLabel}</span>
        <div class="pr-row-main">
          <div class="pr-row-title">
            <span class="pr-proj-tag">${esc(pr.projectName)}</span>
            <span class="pr-number">#${pr.number}</span>
            <span class="pr-title-text">${esc(pr.title)}</span>
            ${pr.labels?.length ? pr.labels.slice(0, 2).map(l => `<span class="pr-label">${esc(l)}</span>`).join('') : ''}
          </div>
          <div class="pr-row-meta">
            <span class="pr-branch" title="${esc(pr.branch)} → ${esc(pr.baseBranch || 'main')}">${esc(pr.branch)}</span>
            <span class="pr-author">${esc(pr.author)}</span>
            <span class="pr-stats">+${pr.additions} -${pr.deletions}</span>
            <span class="pr-files">${pr.changedFiles} files</span>
            ${checksBadge}
          </div>
        </div>
      </div>
      <div class="pr-row-right">
        <span class="pr-updated">${timeAgo(pr.updatedAt)}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── PR Detail Panel ───
async function showPRDetail(projectId, prNumber) {
  const panel = document.getElementById('pr-detail');
  panel.innerHTML = '<div class="pr-loading">Loading PR details...</div>';
  panel.classList.add('open');
  try {
    const pr = await fetchJson(`/api/projects/${projectId}/prs/${prNumber}`);
    _prDetailData = { projectId, ...pr };
    renderPRDetail(projectId, pr);
  } catch (e) {
    panel.innerHTML = `<div class="pr-detail-head"><button class="prd-close" data-action="close-pr-detail"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="pr-detail-body"><div class="pr-empty"><div class="pre-title">Failed</div><div class="pre-sub">${esc(e.message)}</div></div></div>`;
  }
}

function renderPRDetail(projectId, pr) {
  const panel = document.getElementById('pr-detail');
  const reviewCls = pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending';
  const reviewLabel = pr.isDraft ? 'Draft' : pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes Requested' : 'Pending Review';

  const checksHtml = pr.checks?.length ? `<div class="prd-checks">${pr.checks.map(c => {
    const icon = c.conclusion === 'SUCCESS' || c.conclusion === 'success' ? '&#10003;' : c.conclusion === 'FAILURE' || c.conclusion === 'failure' ? '&#10007;' : '&#8230;';
    const cls = c.conclusion === 'SUCCESS' || c.conclusion === 'success' ? 'ok' : c.conclusion === 'FAILURE' || c.conclusion === 'failure' ? 'fail' : 'pending';
    return `<span class="prd-check prd-check-${cls}">${icon} ${esc(c.name)}</span>`;
  }).join('')}</div>` : '';

  const filesHtml = pr.files?.length ? `<div class="prd-files"><h4>Changed Files (${pr.files.length})</h4><div class="prd-file-list">${pr.files.map(f => {
    const total = f.additions + f.deletions;
    const addPct = total ? (f.additions / total * 100) : 0;
    return `<div class="prd-file"><span class="prd-file-path">${esc(f.path)}</span><span class="prd-file-stats"><span class="prd-add">+${f.additions}</span><span class="prd-del">-${f.deletions}</span><span class="prd-file-bar"><span class="prd-bar-add" style="width:${addPct}%"></span></span></span></div>`;
  }).join('')}</div></div>` : '';

  const reviewsHtml = pr.reviews?.length ? `<div class="prd-reviews"><h4>Reviews</h4>${pr.reviews.map(r => {
    const cls = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'commented';
    return `<div class="prd-review"><span class="prd-rv-badge prd-rv-${cls}">${r.state === 'APPROVED' ? 'Approved' : r.state === 'CHANGES_REQUESTED' ? 'Changes' : 'Commented'}</span><span class="prd-rv-author">${esc(r.author)}</span><span class="prd-rv-time">${timeAgo(r.submittedAt)}</span>${r.body ? `<div class="prd-rv-body">${esc(r.body)}</div>` : ''}</div>`;
  }).join('')}</div>` : '';

  const commentsHtml = pr.comments?.length ? `<div class="prd-comments"><h4>Comments (${pr.comments.length})</h4>${pr.comments.map(c =>
    `<div class="prd-comment"><div class="prd-comment-head"><span class="prd-comment-author">${esc(c.author)}</span><span class="prd-comment-time">${timeAgo(c.createdAt)}</span></div><div class="prd-comment-body">${esc(c.body)}</div></div>`
  ).join('')}</div>` : '';

  panel.innerHTML = `<div class="pr-detail-head">
    <div class="prd-head-left">
      <span class="pr-review-badge pr-rv-${reviewCls}">${reviewLabel}</span>
      <span class="prd-number">#${pr.number}</span>
      <span class="prd-branch">${esc(pr.branch)} → ${esc(pr.baseBranch || 'main')}</span>
    </div>
    <div class="prd-head-right">
      <button class="prd-open-gh" data-action="open-pr-github" data-url="${esc(pr.url)}" title="Open in GitHub">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>
      <button class="prd-close" data-action="close-pr-detail">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>
  <div class="pr-detail-body">
    <div class="prd-title">${esc(pr.title)}</div>
    <div class="prd-meta">
      <span>by <strong>${esc(pr.author)}</strong></span>
      <span>${timeAgo(pr.createdAt)}</span>
      <span class="prd-stat-badge">+${pr.additions} -${pr.deletions}</span>
      <span>${pr.changedFiles} files, ${pr.commits} commits</span>
      ${pr.mergeable === 'MERGEABLE' ? '<span class="prd-mergeable">Mergeable</span>' : pr.mergeable === 'CONFLICTING' ? '<span class="prd-conflict">Conflicts</span>' : ''}
    </div>
    ${pr.labels?.length ? `<div class="prd-labels">${pr.labels.map(l => `<span class="pr-label">${esc(l)}</span>`).join('')}</div>` : ''}
    ${checksHtml}
    <div class="prd-actions">
      ${pr.state === 'OPEN' ? `
        ${pr.reviewDecision !== 'APPROVED' ? `<button class="btn prd-btn prd-btn-approve" data-action="pr-approve" data-project="${esc(projectId)}" data-number="${pr.number}">Approve</button>` : ''}
        <button class="btn prd-btn prd-btn-changes" data-action="pr-request-changes" data-project="${esc(projectId)}" data-number="${pr.number}">Request Changes</button>
        ${pr.reviewDecision === 'APPROVED' && pr.mergeable !== 'CONFLICTING' ? `<button class="btn prd-btn prd-btn-merge" data-action="pr-merge" data-project="${esc(projectId)}" data-number="${pr.number}">Merge</button>` : ''}
      ` : ''}
      <button class="btn prd-btn prd-btn-diff" data-action="pr-view-diff" data-project="${esc(projectId)}" data-number="${pr.number}">View Diff</button>
    </div>
    ${pr.body ? `<div class="prd-description">${simpleMarkdown(pr.body)}</div>` : ''}
    ${filesHtml}
    ${reviewsHtml}
    ${commentsHtml}
    ${pr.state === 'OPEN' ? `<div class="prd-comment-form">
      <textarea id="pr-comment-input" class="prd-comment-textarea" placeholder="Leave a comment..." rows="3"></textarea>
      <button class="btn prd-btn prd-btn-comment" data-action="pr-comment" data-project="${esc(projectId)}" data-number="${pr.number}">Comment</button>
    </div>` : ''}
  </div>`;
}

function simpleMarkdown(text) {
  return esc(text)
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

// ─── Actions ───
async function handleApprove(el) {
  try {
    await postJson(`/api/projects/${el.dataset.project}/prs/${el.dataset.number}/approve`, {});
    showToast('PR approved', 'success');
    showPRDetail(el.dataset.project, el.dataset.number);
    loadAllPRs();
  } catch (e) { showToast('Approve failed: ' + e.message, 'error'); }
}

async function handleRequestChanges(el) {
  const body = prompt('Comment for changes requested:');
  if (!body) return;
  try {
    await postJson(`/api/projects/${el.dataset.project}/prs/${el.dataset.number}/request-changes`, { body });
    showToast('Changes requested', 'success');
    showPRDetail(el.dataset.project, el.dataset.number);
    loadAllPRs();
  } catch (e) { showToast('Failed: ' + e.message, 'error'); }
}

async function handleMerge(el) {
  if (!confirm(`Merge PR #${el.dataset.number}?`)) return;
  try {
    await postJson(`/api/projects/${el.dataset.project}/prs/${el.dataset.number}/merge`, { method: 'squash' });
    showToast('PR merged!', 'success');
    closePRDetail();
    loadAllPRs();
  } catch (e) { showToast('Merge failed: ' + e.message, 'error'); }
}

async function handleViewDiff(el) {
  const panel = document.getElementById('pr-detail');
  const existing = panel.querySelector('.prd-diff-view');
  if (existing) { existing.remove(); return; }
  const btn = el;
  btn.textContent = 'Loading...';
  try {
    const diff = await fetchText(`/api/projects/${el.dataset.project}/prs/${el.dataset.number}/diff`);
    const diffEl = document.createElement('div');
    diffEl.className = 'prd-diff-view';
    diffEl.innerHTML = `<h4>Diff</h4><pre class="prd-diff-pre">${esc(diff)}</pre>`;
    panel.querySelector('.pr-detail-body').appendChild(diffEl);
    btn.textContent = 'Hide Diff';
  } catch (e) {
    showToast('Failed to load diff', 'error');
    btn.textContent = 'View Diff';
  }
}

async function handleComment(el) {
  const input = document.getElementById('pr-comment-input');
  const body = input?.value?.trim();
  if (!body) return showToast('Comment cannot be empty', 'error');
  el.disabled = true;
  el.textContent = 'Posting...';
  try {
    await postJson(`/api/projects/${el.dataset.project}/prs/${el.dataset.number}/comment`, { body });
    showToast('Comment posted', 'success');
    showPRDetail(el.dataset.project, el.dataset.number);
  } catch (e) {
    showToast('Failed to post comment: ' + e.message, 'error');
    el.disabled = false;
    el.textContent = 'Comment';
  }
}

function closePRDetail() {
  _prDetailData = null;
  document.getElementById('pr-detail')?.classList.remove('open');
}

function openPRGitHub(el) {
  postJson('/api/open-url', { url: el.dataset.url });
}

// ─── Action Registration ───
registerClickActions({
  'show-pr-detail': (el) => showPRDetail(el.dataset.project, el.dataset.number),
  'close-pr-detail': closePRDetail,
  'refresh-prs': () => { _prLoading = false; loadAllPRs(); },
  'pr-approve': handleApprove,
  'pr-request-changes': handleRequestChanges,
  'pr-merge': handleMerge,
  'pr-view-diff': handleViewDiff,
  'pr-comment': handleComment,
  'open-pr-github': openPRGitHub,
});
registerChangeActions({
  'pr-project-filter': (el) => { _prFilter.project = el.value; renderPRList(); },
  'pr-status-filter': (el) => { _prFilter.status = el.value; _prLoading = false; _prInitialized = true; loadAllPRs(); },
});
registerInputActions({
  'pr-search': (el) => { _prFilter.search = el.value; renderPRList(); },
});
