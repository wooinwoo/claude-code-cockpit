// ─── Docs Module: Documentation-style notes with sidebar tree & TOC ───
import { app } from './state.js';
import { esc, showToast, simpleMarkdown, fetchJson, postJson } from './utils.js';
import { registerClickActions, registerInputActions } from './actions.js';

let _mode = 'view'; // 'view' | 'edit'

// ─── Init ───
export function initNotes() {
  if (app._notesInitialized) return;
  app._notesInitialized = true;
  loadNotesList();
}

// ─── Data ───
async function loadNotesList() {
  try {
    const notes = await fetchJson('/api/notes');
    app.notesList = Array.isArray(notes) ? notes : [];
    renderSidebar();
    if (!app._activeNoteId && app.notesList.length) selectNote(app.notesList[0].id);
    else if (app._activeNoteId) selectNote(app._activeNoteId);
    else renderEmpty();
  } catch (err) { showToast('Failed to load docs: ' + err.message, 'error'); }
}

// ─── Sidebar Tree ───
function renderSidebar() {
  const el = document.getElementById('notes-sidebar-list');
  if (!el) return;
  if (!app.notesList.length) {
    el.innerHTML = '<div class="docs-nav-empty">No pages yet<br><span>Click + to create</span></div>';
    return;
  }
  // Group by project (section)
  const sections = {};
  const uncategorized = [];
  for (const n of app.notesList) {
    if (n.project) {
      if (!sections[n.project]) sections[n.project] = [];
      sections[n.project].push(n);
    } else {
      uncategorized.push(n);
    }
  }
  let html = '';
  const sectionNames = Object.keys(sections).sort();
  for (const sec of sectionNames) {
    const items = sections[sec];
    const isOpen = items.some(n => n.id === app._activeNoteId);
    html += `<div class="docs-section${isOpen ? ' open' : ''}">
      <div class="docs-section-head" data-action="toggle-section">
        <svg class="docs-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        <span class="docs-section-label">${esc(sec)}</span>
        <span class="docs-section-count">${items.length}</span>
      </div>
      <div class="docs-section-items">${items.map(n => docItem(n)).join('')}</div>
    </div>`;
  }
  if (uncategorized.length) {
    if (sectionNames.length) {
      html += `<div class="docs-section open">
        <div class="docs-section-head" data-action="toggle-section">
          <svg class="docs-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          <span class="docs-section-label">General</span>
          <span class="docs-section-count">${uncategorized.length}</span>
        </div>
        <div class="docs-section-items">${uncategorized.map(n => docItem(n)).join('')}</div>
      </div>`;
    } else {
      html += uncategorized.map(n => docItem(n)).join('');
    }
  }
  el.innerHTML = html;
  // Delegate clicks
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const secHead = e.target.closest('[data-action="toggle-section"]');
      if (secHead) { secHead.parentElement.classList.toggle('open'); return; }
      const item = e.target.closest('[data-action="select-note"]');
      if (item) selectNote(item.dataset.id);
    });
  }
}

function docItem(n) {
  const active = n.id === app._activeNoteId ? ' active' : '';
  return `<div class="docs-item${active}" data-action="select-note" data-id="${esc(n.id)}">
    <svg class="docs-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <span class="docs-item-label">${esc(n.title || 'Untitled')}</span>
  </div>`;
}

// ─── Select Note ───
export async function selectNote(id) {
  if (app._notesDirty && app._activeNoteId) await saveCurrentNote();
  app._activeNoteId = id;
  _mode = 'view';
  renderSidebar();
  const main = document.getElementById('notes-editor');
  if (!main) return;
  main.innerHTML = '<div class="docs-loading"><div class="docs-loading-spinner"></div>Loading...</div>';
  try {
    const note = await fetchJson(`/api/notes/${id}`);
    app._currentNote = note;
    renderDocView(note);
  } catch (err) {
    main.innerHTML = `<div class="docs-empty"><div class="docs-empty-title">Failed to load</div><div class="docs-empty-sub">${esc(err.message)}</div></div>`;
  }
}

// ─── Document View (read mode) ───
function renderDocView(note) {
  const main = document.getElementById('notes-editor');
  if (!main) return;
  const renderedContent = simpleMarkdown(note.content || '*No content yet. Click Edit to start writing.*');
  main.innerHTML = `
    <div class="docs-content-wrap">
      <div class="docs-toolbar">
        <div class="docs-breadcrumb">
          ${note.project ? `<span class="docs-bc-section">${esc(note.project)}</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>` : ''}
          <span class="docs-bc-page">${esc(note.title || 'Untitled')}</span>
        </div>
        <div class="docs-toolbar-actions">
          <button class="docs-action-btn" data-action="export-note" title="Export as .md">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="docs-action-btn" data-action="edit-doc" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>Edit</span>
          </button>
          <button class="docs-action-btn danger" data-action="delete-note" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
      <article class="docs-article" id="docs-article">
        <h1 class="docs-article-title">${esc(note.title || 'Untitled')}</h1>
        <div class="docs-article-meta">
          ${note.project ? `<span class="docs-meta-tag">${esc(note.project)}</span>` : ''}
          <span class="docs-meta-date">${note.updatedAt ? 'Updated ' + formatDate(note.updatedAt) : ''}</span>
        </div>
        <div class="docs-article-body">${renderedContent}</div>
      </article>
    </div>`;
  // Build TOC from headings in the rendered content
  buildToc();
  // Delegate
  delegateMain(main);
}

// ─── Edit Mode ───
function renderDocEdit(note) {
  const main = document.getElementById('notes-editor');
  if (!main) return;
  const projOptions = (app.projectList || []).map(p =>
    `<option value="${esc(p.name)}" ${note.project === p.name ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  main.innerHTML = `
    <div class="docs-content-wrap">
      <div class="docs-toolbar">
        <div class="docs-breadcrumb">
          <span class="docs-bc-page docs-bc-editing">Editing</span>
        </div>
        <div class="docs-toolbar-actions">
          <span class="docs-save-status" id="docs-save-status"></span>
          <button class="docs-action-btn primary" data-action="view-doc" title="Done editing">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
            <span>Done</span>
          </button>
        </div>
      </div>
      <div class="docs-edit-form">
        <input class="docs-edit-title" id="docs-edit-title" value="${esc(note.title)}" placeholder="Page title..." data-field="title">
        <div class="docs-edit-meta-row">
          <label class="docs-edit-label">Section</label>
          <select class="docs-edit-select" id="docs-edit-project" data-field="project">
            <option value="">None</option>
            ${projOptions}
          </select>
          <input class="docs-edit-section-input" id="docs-edit-section-custom" placeholder="Or type new section..." value="${note.project && !(app.projectList || []).some(p => p.name === note.project) ? esc(note.project) : ''}">
        </div>
        <div class="docs-edit-md-bar">
          <button class="docs-md-btn" title="Bold" data-action="md-insert" data-before="**" data-after="**"><b>B</b></button>
          <button class="docs-md-btn" title="Italic" data-action="md-insert" data-before="*" data-after="*"><em>I</em></button>
          <button class="docs-md-btn" title="Code" data-action="md-insert" data-before="\`" data-after="\`"><code>&lt;&gt;</code></button>
          <span class="docs-md-sep"></span>
          <button class="docs-md-btn" title="Heading 2" data-action="md-insert" data-before="\\n## " data-after="">H2</button>
          <button class="docs-md-btn" title="Heading 3" data-action="md-insert" data-before="\\n### " data-after="">H3</button>
          <span class="docs-md-sep"></span>
          <button class="docs-md-btn" title="Bullet list" data-action="md-insert" data-before="\\n- " data-after="">&#8226;</button>
          <button class="docs-md-btn" title="Numbered list" data-action="md-insert" data-before="\\n1. " data-after="">1.</button>
          <button class="docs-md-btn" title="Link" data-action="md-insert" data-before="[" data-after="](url)">&#128279;</button>
          <button class="docs-md-btn" title="Code block" data-action="md-insert" data-before="\\n\`\`\`\\n" data-after="\\n\`\`\`">{}</button>
        </div>
        <textarea class="docs-edit-textarea" id="docs-edit-textarea" placeholder="Write in markdown...">${esc(note.content || '')}</textarea>
        <div class="docs-edit-statusbar">
          <span id="docs-edit-status-info"></span>
          <span>Markdown · Ctrl+S to save</span>
        </div>
      </div>
    </div>`;
  clearToc();
  app._notesDirty = false;
  // Events
  const ta = document.getElementById('docs-edit-textarea');
  if (ta) {
    ta.addEventListener('input', onDocChange);
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentNote(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); mdInsert('**', '**'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); mdInsert('*', '*'); }
      // Tab → indent
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart, end = ta.selectionEnd;
        ta.setRangeText('  ', start, end, 'end');
        onDocChange();
      }
    });
    updateWordCount();
  }
  // Section input override
  const customSec = document.getElementById('docs-edit-section-custom');
  if (customSec) customSec.addEventListener('input', () => {
    document.getElementById('docs-edit-project').value = '';
    onDocChange();
  });
  const projSel = document.getElementById('docs-edit-project');
  if (projSel) projSel.addEventListener('change', () => {
    const custom = document.getElementById('docs-edit-section-custom');
    if (custom) custom.value = '';
    onDocChange();
  });
  document.getElementById('docs-edit-title')?.addEventListener('input', onDocChange);
  delegateMain(main);
  ta?.focus();
}

function delegateMain(main) {
  // Use onclick to avoid listener stacking on mode switches
  main.onclick = e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'edit-doc': enterEditMode(); break;
      case 'view-doc': exitEditMode(); break;
      case 'delete-note': deleteCurrentNote(); break;
      case 'export-note': exportNote(); break;
      case 'md-insert': mdInsert(btn.dataset.before, btn.dataset.after); break;
    }
  };
}

function enterEditMode() {
  _mode = 'edit';
  renderDocEdit(app._currentNote || {});
}

async function exitEditMode() {
  if (app._notesDirty) await saveCurrentNote();
  _mode = 'view';
  if (app._activeNoteId) {
    const note = await fetchJson(`/api/notes/${app._activeNoteId}`);
    app._currentNote = note;
    renderDocView(note);
  }
}

// ─── TOC ───
function buildToc() {
  const toc = document.getElementById('docs-toc');
  if (!toc) return;
  const article = document.getElementById('docs-article');
  if (!article) { toc.innerHTML = ''; return; }
  const headings = article.querySelectorAll('h1, h2, h3');
  if (headings.length < 2) { toc.innerHTML = ''; return; }
  let html = '<div class="docs-toc-title">On this page</div><ul class="docs-toc-list">';
  headings.forEach((h, i) => {
    const id = 'docs-heading-' + i;
    h.id = id;
    const level = parseInt(h.tagName[1]);
    const indent = level > 1 ? ` docs-toc-l${level}` : '';
    html += `<li class="docs-toc-item${indent}"><a href="#${id}" class="docs-toc-link">${esc(h.textContent)}</a></li>`;
  });
  html += '</ul>';
  toc.innerHTML = html;
  // Smooth scroll (onclick = replace, not addEventListener = stack)
  toc.onclick = e => {
    const link = e.target.closest('.docs-toc-link');
    if (link) {
      e.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
}

function clearToc() {
  const toc = document.getElementById('docs-toc');
  if (toc) toc.innerHTML = '';
}

// ─── Save ───
function onDocChange() {
  app._notesDirty = true;
  app._notesSaveState = null;
  updateSaveStatus();
  updateWordCount();
  if (app._notesSaveTimer) clearTimeout(app._notesSaveTimer);
  app._notesSaveTimer = setTimeout(saveCurrentNote, 1500);
}

// Keep backward compat export
export function onNoteChange() { onDocChange(); }

async function saveCurrentNote() {
  if (!app._activeNoteId || !app._notesDirty) return;
  const titleEl = document.getElementById('docs-edit-title');
  const textEl = document.getElementById('docs-edit-textarea');
  if (!titleEl || !textEl) return;
  const projEl = document.getElementById('docs-edit-project');
  const customEl = document.getElementById('docs-edit-section-custom');
  const project = customEl?.value.trim() || projEl?.value || '';
  const updates = { title: titleEl.value, content: textEl.value, project };
  try {
    app._notesSaveState = 'saving';
    updateSaveStatus();
    await postJson(`/api/notes/${app._activeNoteId}`, updates, { method: 'PUT' });
    app._notesDirty = false;
    app._notesSaveState = 'saved';
    app._notesSaveFailCount = 0;
    updateSaveStatus();
    app._currentNote = { ...app._currentNote, ...updates };
    setTimeout(() => { if (app._notesSaveState === 'saved') { app._notesSaveState = null; updateSaveStatus(); } }, 2000);
    const idx = app.notesList.findIndex(n => n.id === app._activeNoteId);
    if (idx !== -1) {
      app.notesList[idx].title = updates.title;
      app.notesList[idx].project = updates.project;
      app.notesList[idx].preview = updates.content.slice(0, 120);
      app.notesList[idx].updatedAt = Date.now();
      renderSidebar();
    }
  } catch {
    app._notesSaveFailCount = (app._notesSaveFailCount || 0) + 1;
    app._notesSaveState = 'error';
    updateSaveStatus();
    if (app._notesSaveFailCount >= 3) {
      showToast('Failed to save note after multiple attempts', 'error');
    } else {
      // Retry with exponential backoff: 3s, 6s
      const delay = 3000 * app._notesSaveFailCount;
      if (app._notesSaveTimer) clearTimeout(app._notesSaveTimer);
      app._notesSaveTimer = setTimeout(saveCurrentNote, delay);
    }
  }
}

function updateSaveStatus() {
  const el = document.getElementById('docs-save-status');
  if (!el) return;
  if (app._notesSaveState === 'saving') { el.textContent = 'Saving...'; el.className = 'docs-save-status saving'; }
  else if (app._notesSaveState === 'saved') { el.textContent = 'Saved'; el.className = 'docs-save-status saved'; }
  else if (app._notesSaveState === 'error') { el.textContent = 'Save failed — retrying...'; el.className = 'docs-save-status error'; }
  else if (app._notesDirty) { el.textContent = 'Unsaved'; el.className = 'docs-save-status unsaved'; }
  else { el.textContent = ''; el.className = 'docs-save-status'; }
}

function updateWordCount() {
  const ta = document.getElementById('docs-edit-textarea');
  const el = document.getElementById('docs-edit-status-info');
  if (!ta || !el) return;
  const text = ta.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  el.textContent = `${words} words · ${chars} chars`;
}

// ─── Create ───
export async function createNewNote() {
  try {
    const note = await postJson('/api/notes', { title: 'New Page', content: '' });
    app.notesList.unshift({ id: note.id, title: note.title, project: '', tags: [], updatedAt: note.updatedAt, createdAt: note.createdAt, preview: '' });
    app._activeNoteId = note.id;
    app._currentNote = note;
    _mode = 'edit';
    renderSidebar();
    renderDocEdit(note);
    setTimeout(() => { const t = document.getElementById('docs-edit-title'); if (t) { t.focus(); t.select(); } }, 50);
  } catch { showToast('Failed to create page', 'error'); }
}

// ─── Delete ───
export async function deleteCurrentNote() {
  if (!app._activeNoteId) return;
  if (!confirm('Delete this page?')) return;
  try {
    await fetchJson(`/api/notes/${app._activeNoteId}`, { method: 'DELETE' });
    app.notesList = app.notesList.filter(n => n.id !== app._activeNoteId);
    app._activeNoteId = null;
    app._notesDirty = false;
    app._currentNote = null;
    renderSidebar();
    if (app.notesList.length) selectNote(app.notesList[0].id);
    else renderEmpty();
    showToast('Page deleted');
  } catch { showToast('Failed to delete', 'error'); }
}

// ─── Search (title + content preview) ───
export function searchNotes(query) {
  const items = document.querySelectorAll('.docs-item');
  const sections = document.querySelectorAll('.docs-section');
  const q = query.toLowerCase();
  if (!q) {
    items.forEach(i => { i.style.display = ''; const badge = i.querySelector('.docs-search-match'); if (badge) badge.remove(); });
    sections.forEach(s => s.style.display = '');
    return;
  }
  items.forEach(item => {
    const label = item.querySelector('.docs-item-label')?.textContent.toLowerCase() || '';
    const noteId = item.dataset.id;
    const note = app.notesList.find(n => n.id === noteId);
    const preview = (note?.preview || note?.content || '').toLowerCase();
    const titleMatch = label.includes(q);
    const contentMatch = preview.includes(q);
    item.style.display = (titleMatch || contentMatch) ? '' : 'none';
    // Show content match indicator
    let badge = item.querySelector('.docs-search-match');
    if (contentMatch && !titleMatch) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'docs-search-match'; item.appendChild(badge); }
      badge.textContent = 'content';
    } else if (badge) { badge.remove(); }
  });
  sections.forEach(sec => {
    const visible = sec.querySelectorAll('.docs-item:not([style*="display: none"])').length;
    sec.style.display = visible ? '' : 'none';
    if (visible) sec.classList.add('open');
  });
}

// ─── Export ───
function exportNote() {
  const note = app._currentNote;
  if (!note) return;
  // In edit mode, use current textarea/title values instead of stale note data
  const title = (_mode === 'edit' ? document.getElementById('docs-edit-title')?.value : null) ?? note.title ?? 'Untitled';
  const body = (_mode === 'edit' ? document.getElementById('docs-edit-textarea')?.value : null) ?? note.content ?? '';
  const content = `# ${title}\n\n${body}`;
  const blob = new Blob([content], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (title || 'note').replace(/[^a-zA-Z0-9가-힣_-]/g, '_') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Note exported');
}

// ─── Markdown Insert ───
export function mdInsert(before, after) {
  const ta = document.getElementById('docs-edit-textarea');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  ta.setRangeText(before + sel + after, start, end, 'end');
  ta.focus();
  onDocChange();
}

// ─── Backward compat exports ───
export function switchNoteTab() {}

// ─── Helpers ───
function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString('ko-KR');
}

function renderEmpty() {
  const main = document.getElementById('notes-editor');
  if (main) main.innerHTML = `<div class="docs-empty">
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-3)" stroke-width="1"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/></svg>
    <div class="docs-empty-title">Documentation</div>
    <div class="docs-empty-sub">Click + to create your first page</div>
  </div>`;
  clearToc();
}

// ═══════════════════════════════════════════════════════
// AI Document Generator (기획팀 전용)
// ═══════════════════════════════════════════════════════

const DOC_TEMPLATES = [
  // 기획팀 (plan_teamlead)
  { id: 'prd',       label: 'PRD (제품 요구사항)',   icon: '📋', team: 'plan', agent: 'plan_teamlead', prompt: 'PRD(제품 요구사항 문서)를 작성해줘. 기능 개요, 사용자 스토리, 요구사항 목록, 수용 기준 포함.' },
  { id: 'meeting',   label: '회의록',              icon: '📝', team: 'plan', agent: 'plan_teamlead', prompt: '회의록을 작성해줘. 참석자, 안건, 논의 내용, 결정 사항, 액션 아이템 형식으로.' },
  { id: 'sprint',    label: '스프린트 보고서',       icon: '📊', team: 'plan', agent: 'plan_teamlead', prompt: '스프린트 보고서를 작성해줘. 완료 항목, 진행 중, 이슈, 다음 스프린트 계획 포함.' },
  { id: 'proposal',  label: '기획서',              icon: '💡', team: 'plan', agent: 'plan_teamlead', prompt: '기획서를 작성해줘. 배경, 목적, 기대효과, 구현 방안, 일정 포함.' },
  // 마케팅팀 (mkt_teamlead)
  { id: 'release',   label: '릴리즈 노트',          icon: '🚀', team: 'marketing', agent: 'mkt_teamlead', prompt: '릴리즈 노트를 작성해줘. 새 기능, 개선사항, 버그 수정, 알려진 이슈 포함. GIT_LOG로 최근 커밋 확인해서 반영해.' },
  { id: 'announce',  label: '공지사항',             icon: '📢', team: 'marketing', agent: 'mkt_teamlead', prompt: '서비스 공지사항을 작성해줘. 제목, 내용, 영향 범위, 일정 포함. 사용자 친화적 톤으로.' },
  { id: 'changelog', label: '변경사항 요약',        icon: '📰', team: 'marketing', agent: 'mkt_teamlead', prompt: '최근 변경사항을 요약하는 문서를 작성해줘. 변경 내용, 영향 범위, 마이그레이션 가이드 포함.' },
  { id: 'landing',   label: '랜딩페이지 카피',      icon: '🎯', team: 'marketing', agent: 'mkt_teamlead', prompt: '랜딩페이지 카피를 작성해줘. 헤드라인, 서브카피, CTA, 주요 기능 설명 포함. 전환율을 고려한 카피라이팅으로.' },
  // 디자인팀 (design_teamlead)
  { id: 'styleguide', label: '스타일 가이드',        icon: '🎨', team: 'design', agent: 'design_teamlead', prompt: '프로젝트의 스타일 가이드 문서를 작성해줘. 색상 팔레트, 타이포그래피, 간격/레이아웃 규칙, 컴포넌트 스타일 패턴 포함. GLOB으로 CSS 파일을 찾아서 현재 사용 중인 스타일을 분석해.' },
  { id: 'cssaudit',   label: 'CSS 감사 보고서',      icon: '🔍', team: 'design', agent: 'design_teamlead', prompt: 'CSS 코드를 감사해줘. GLOB으로 CSS/SCSS 파일을 찾고 READ로 분석해서, 중복 스타일, 미사용 변수, 일관성 문제, 접근성(대비율/폰트크기), 반응형 이슈를 보고서로 작성해.' },
  // 공통
  { id: 'free',      label: '자유 형식',            icon: '✏️', team: 'plan', agent: 'plan_teamlead', prompt: '' },
];

let _aiGenState = null; // { convId, noteId, status }
let _aiGenSSE = false;

function openAiDocGen() {
  const main = document.getElementById('notes-editor');
  if (!main) return;

  main.innerHTML = `
    <div class="docs-content-wrap">
      <div class="docs-toolbar">
        <div class="docs-breadcrumb">
          <span class="docs-bc-page">AI 문서 생성</span>
        </div>
        <div class="docs-toolbar-actions">
          <button class="docs-action-btn" data-action="close-ai-gen" title="닫기">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span>닫기</span>
          </button>
        </div>
      </div>
      <div class="ai-gen-body">
        <div class="ai-gen-section">
          <div class="ai-gen-label">템플릿 선택</div>
          <div class="ai-gen-templates" id="ai-gen-templates">
            ${DOC_TEMPLATES.map(t => {
              const teamColors = { plan: '#f59e0b', marketing: '#f97316', design: '#ec4899' };
              const teamLabels = { plan: '기획', marketing: '마케팅', design: '디자인' };
              const teamColor = teamColors[t.team] || '#6366f1';
              const teamLabel = teamLabels[t.team] || t.team;
              return `
              <button class="ai-gen-tpl ${t.id === 'free' ? 'active' : ''}" data-action="select-ai-tpl" data-tpl="${t.id}">
                <span class="ai-gen-tpl-icon">${t.icon}</span>
                <span class="ai-gen-tpl-label">${esc(t.label)}</span>
                <span class="ai-gen-tpl-team" style="background:${teamColor}">${teamLabel}</span>
              </button>`;
            }).join('')}
          </div>
        </div>
        <div class="ai-gen-section">
          <div class="ai-gen-label">문서 제목</div>
          <input class="ai-gen-input" id="ai-gen-title" placeholder="예: v2.0 릴리즈 PRD" maxlength="100">
        </div>
        <div class="ai-gen-section">
          <div class="ai-gen-label">설명 / 추가 지시</div>
          <textarea class="ai-gen-textarea" id="ai-gen-desc" placeholder="어떤 문서를 만들지 설명해주세요...&#10;예: 결제 시스템 리팩토링에 대한 PRD. 현재 PG사 연동 구조와 문제점, 새 아키텍처 제안 포함." rows="4"></textarea>
        </div>
        <div class="ai-gen-section">
          <div class="ai-gen-label">프로젝트 (선택)</div>
          <select class="ai-gen-select" id="ai-gen-project">
            <option value="">없음</option>
            ${(app.projectList || []).map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <button class="ai-gen-submit" id="ai-gen-submit" data-action="submit-ai-gen">
          기획팀에 문서 작성 요청
        </button>
        <div class="ai-gen-progress" id="ai-gen-progress" style="display:none">
          <div class="ai-gen-progress-bar"><div class="ai-gen-progress-fill" id="ai-gen-fill"></div></div>
          <div class="ai-gen-progress-label" id="ai-gen-status">기획팀 배정 중...</div>
        </div>
      </div>
    </div>`;
  clearToc();
  _selectedTpl = 'free';

  // Bind template selection and main actions
  const mainEl = main;
  mainEl.onclick = e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'select-ai-tpl': selectAiTpl(btn.dataset.tpl); break;
      case 'submit-ai-gen': submitAiGen(); break;
      case 'close-ai-gen': renderEmpty(); break;
    }
  };

  // Bind SSE listeners for live document generation
  if (!_aiGenSSE) {
    _aiGenSSE = true;
    for (const evt of ['agent:response', 'agent:done', 'agent:error', 'agent:tool', 'agent:thinking']) {
      document.addEventListener(evt, e => onAiGenEvent(evt, e.detail));
    }
  }

  document.getElementById('ai-gen-title')?.focus();
}

let _selectedTpl = 'free';
function selectAiTpl(tplId) {
  _selectedTpl = tplId;
  document.querySelectorAll('.ai-gen-tpl').forEach(el =>
    el.classList.toggle('active', el.dataset.tpl === tplId)
  );
  const tpl = DOC_TEMPLATES.find(t => t.id === tplId);
  // Auto-fill title hint
  const titleEl = document.getElementById('ai-gen-title');
  if (titleEl && !titleEl.value && tpl && tpl.id !== 'free') {
    titleEl.placeholder = `예: ${tpl.label} 제목`;
  }
  // Update submit button label with team
  const submitBtn = document.getElementById('ai-gen-submit');
  if (submitBtn && tpl) {
    const teamNames = { plan: '기획팀', marketing: '마케팅팀', design: '디자인팀' };
    submitBtn.textContent = `${teamNames[tpl.team] || '기획팀'}에 문서 작성 요청`;
  }
}

async function submitAiGen() {
  const titleEl = document.getElementById('ai-gen-title');
  const descEl = document.getElementById('ai-gen-desc');
  const projEl = document.getElementById('ai-gen-project');
  const submitBtn = document.getElementById('ai-gen-submit');
  const progressEl = document.getElementById('ai-gen-progress');

  const title = titleEl?.value.trim() || '새 문서';
  const desc = descEl?.value.trim();
  const project = projEl?.value || '';
  const tpl = DOC_TEMPLATES.find(t => t.id === _selectedTpl);

  if (!desc && _selectedTpl === 'free') {
    descEl?.focus();
    showToast('설명을 입력해주세요', 'error');
    return;
  }

  // Build prompt for plan team agent
  const tplPrompt = tpl?.prompt || '';
  const fullPrompt = `노트에 문서를 작성해줘.
제목: "${title}"
${tplPrompt ? `템플릿: ${tplPrompt}` : ''}
${desc ? `상세 설명: ${desc}` : ''}
${project ? `프로젝트: ${project}` : ''}

작성이 끝나면 반드시 COCKPIT 도구로 노트에 저장해야 해. NOTE_ID는 아래에 알려줄게.
저장 방법: {"tool":"COCKPIT","argument":"note-update:NOTE_ID\\n여기부터 마크다운 전체 내용"}
argument 첫 줄 = "note-update:NOTE_ID", 두 번째 줄(\\n 이후)부터 본문 전체. 내용이 아무리 길어도 argument 하나에 전부 담아야 해.
내용 없이 제목만 저장하거나 WRITE 도구로 파일에 쓰면 안 됨. 반드시 COCKPIT:note-update로만 저장.`;

  // Disable submit, show progress
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '생성 중...'; }
  if (progressEl) progressEl.style.display = '';

  const teamNames = { plan: '기획팀', marketing: '마케팅팀', design: '디자인팀' };
  const teamName = teamNames[tpl?.team] || '기획팀';

  try {
    // Create a new note first
    const note = await postJson('/api/notes', { title, content: '(AI 생성 중...)', project });
    app.notesList.unshift({ id: note.id, title, project, updatedAt: note.updatedAt, preview: '' });
    renderSidebar();

    // Create conversation and send to plan team agent
    const conv = await postJson('/api/agent/conversations', {});
    _aiGenState = { convId: conv.id, noteId: note.id, status: 'generating' };

    // Route to appropriate team agent
    const agentId = tpl?.agent || 'plan_teamlead';
    const msgWithNoteId = fullPrompt + `\n\nNOTE_ID: ${note.id}`;
    await postJson('/api/agent/chat', { convId: conv.id, message: msgWithNoteId, agentId });

    updateAiGenStatus(`${teamName} 문서 작성 중...`, 20);
  } catch (err) {
    showToast('AI 문서 생성 실패: ' + err.message, 'error');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = `${teamName}에 문서 작성 요청`; }
    if (progressEl) progressEl.style.display = 'none';
    _aiGenState = null;
  }
}

function updateAiGenStatus(label, pct) {
  const statusEl = document.getElementById('ai-gen-status');
  const fillEl = document.getElementById('ai-gen-fill');
  if (statusEl) statusEl.textContent = label;
  if (fillEl) fillEl.style.width = pct + '%';
}

async function onAiGenEvent(evt, data) {
  if (!_aiGenState || !data) return;
  if (data.convId && data.convId !== _aiGenState.convId) return;

  switch (evt) {
    case 'agent:thinking': {
      const tpl = DOC_TEMPLATES.find(t => t.id === _selectedTpl);
      const teamLabel = { plan: '기획팀', marketing: '마케팅팀', design: '디자인팀' }[tpl?.team] || '에이전트';
      updateAiGenStatus(`${teamLabel} 사고 중... (${data.iteration || ''})`, 30 + Math.min((data.iteration || 0) * 10, 40));
      break;
    }
    case 'agent:tool':
      if (data.tool === 'COCKPIT' || data.tool === 'WRITE') {
        updateAiGenStatus('문서 작성 중...', 70);
      } else {
        updateAiGenStatus(`${data.tool} 도구 사용 중...`, 50);
      }
      break;
    case 'agent:response':
      updateAiGenStatus('문서 생성 완료!', 100);
      // Fetch the note content (agent wrote via WRITE tool → notes-service captured it,
      // or we parse it from the response)
      await finalizeAiGenNote(data.content);
      break;
    case 'agent:done':
      if (_aiGenState?.status === 'generating') {
        // Response might have come before done
        await finalizeAiGenNote();
      }
      break;
    case 'agent:error': {
      updateAiGenStatus('생성 실패: ' + (data.error || ''), 0);
      const errBtn = document.getElementById('ai-gen-submit');
      const errTpl = DOC_TEMPLATES.find(t => t.id === _selectedTpl);
      const errTeam = { plan: '기획팀', marketing: '마케팅팀', design: '디자인팀' }[errTpl?.team] || '기획팀';
      if (errBtn) { errBtn.disabled = false; errBtn.textContent = `${errTeam}에 문서 작성 요청`; }
      _aiGenState = null;
      break;
    }
  }
}

async function finalizeAiGenNote(responseContent) {
  if (!_aiGenState) return;
  const { noteId } = _aiGenState;
  _aiGenState.status = 'done';

  // Try to load the note — agent may have written via COCKPIT or WRITE
  // If content is still placeholder, extract from agent response
  try {
    const note = await fetchJson(`/api/notes/${noteId}`);
    let content = note.content || '';

    // If agent didn't write to the note directly, extract markdown from response
    if (content === '(AI 생성 중...)' && responseContent) {
      // Try to extract markdown content from agent's response
      content = responseContent;
      await postJson(`/api/notes/${noteId}`, { content }, { method: 'PUT' });
    }

    // Update local state
    app._activeNoteId = noteId;
    app._currentNote = { ...note, content };
    renderSidebar();
    renderDocView({ ...note, content });
    showToast('문서 생성 완료');
  } catch (err) {
    showToast('문서 로드 실패: ' + err.message, 'error');
  }

  _aiGenState = null;
}

// ─── Action Registration ───
registerClickActions({
  'create-new-note': createNewNote,
  'open-ai-doc-gen': openAiDocGen,
});
registerInputActions({
  'search-notes': (el) => searchNotes(el.value),
});
