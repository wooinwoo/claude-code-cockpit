// ─── Docs Module: Documentation-style notes with sidebar tree & TOC ───
import { app } from './state.js';
import { esc, showToast, simpleMarkdown } from './utils.js';

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
    const notes = await fetch('/api/notes').then(r => r.json());
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
    const note = await fetch(`/api/notes/${id}`).then(r => r.json());
    if (note.error) throw new Error(note.error);
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
  if (main.dataset.delegated2) return;
  main.dataset.delegated2 = '1';
  main.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'edit-doc': enterEditMode(); break;
      case 'view-doc': exitEditMode(); break;
      case 'delete-note': deleteCurrentNote(); break;
      case 'md-insert': mdInsert(btn.dataset.before, btn.dataset.after); break;
    }
  });
}

function enterEditMode() {
  _mode = 'edit';
  const main = document.getElementById('notes-editor');
  if (main) main.dataset.delegated2 = '';
  renderDocEdit(app._currentNote || {});
}

async function exitEditMode() {
  if (app._notesDirty) await saveCurrentNote();
  _mode = 'view';
  const main = document.getElementById('notes-editor');
  if (main) main.dataset.delegated2 = '';
  if (app._activeNoteId) {
    const note = await fetch(`/api/notes/${app._activeNoteId}`).then(r => r.json());
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
  // Smooth scroll
  toc.addEventListener('click', e => {
    const link = e.target.closest('.docs-toc-link');
    if (link) {
      e.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
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
    await fetch(`/api/notes/${app._activeNoteId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    app._notesDirty = false;
    app._notesSaveState = 'saved';
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
  } catch { /* retry on next change */ }
}

function updateSaveStatus() {
  const el = document.getElementById('docs-save-status');
  if (!el) return;
  if (app._notesSaveState === 'saving') { el.textContent = 'Saving...'; el.className = 'docs-save-status saving'; }
  else if (app._notesSaveState === 'saved') { el.textContent = 'Saved'; el.className = 'docs-save-status saved'; }
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
    const note = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Page', content: '' })
    }).then(r => r.json());
    app.notesList.unshift({ id: note.id, title: note.title, project: '', tags: [], updatedAt: note.updatedAt, createdAt: note.createdAt, preview: '' });
    app._activeNoteId = note.id;
    app._currentNote = note;
    _mode = 'edit';
    renderSidebar();
    const main = document.getElementById('notes-editor');
    if (main) main.dataset.delegated2 = '';
    renderDocEdit(note);
    setTimeout(() => { const t = document.getElementById('docs-edit-title'); if (t) { t.focus(); t.select(); } }, 50);
  } catch (err) { showToast('Failed to create page', 'error'); }
}

// ─── Delete ───
export async function deleteCurrentNote() {
  if (!app._activeNoteId) return;
  if (!confirm('Delete this page?')) return;
  try {
    await fetch(`/api/notes/${app._activeNoteId}`, { method: 'DELETE' });
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

// ─── Search ───
export function searchNotes(query) {
  const items = document.querySelectorAll('.docs-item');
  const sections = document.querySelectorAll('.docs-section');
  const q = query.toLowerCase();
  if (!q) {
    items.forEach(i => i.style.display = '');
    sections.forEach(s => s.style.display = '');
    return;
  }
  items.forEach(item => {
    const label = item.querySelector('.docs-item-label')?.textContent.toLowerCase() || '';
    item.style.display = label.includes(q) ? '' : 'none';
  });
  sections.forEach(sec => {
    const visible = sec.querySelectorAll('.docs-item:not([style*="display: none"])').length;
    sec.style.display = visible ? '' : 'none';
    if (visible) sec.classList.add('open');
  });
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
