// ─── Notes Service: Markdown note storage ───

/**
 * @typedef {Object} Note
 * @property {string} id - Hex ID from randomBytes
 * @property {string} title
 * @property {string} content - Markdown content
 * @property {string} project - Associated project ID
 * @property {string[]} tags
 * @property {number} createdAt - Unix timestamp ms
 * @property {number} updatedAt - Unix timestamp ms
 */

/**
 * @typedef {Object} NoteSummary
 * @property {string} id
 * @property {string} title
 * @property {string} project
 * @property {string[]} tags
 * @property {number} updatedAt
 * @property {number} createdAt
 * @property {string} preview - First 120 chars of content
 */

import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(__dirname, '..', 'notes');

// Ensure notes directory
async function ensureDir() {
  if (!existsSync(NOTES_DIR)) await mkdir(NOTES_DIR, { recursive: true });
}

// M4: Strict ID validation — only hex chars (from randomBytes)
function isValidNoteId(id) { return /^[a-f0-9]+$/.test(id); }
function noteFile(id) {
  if (!isValidNoteId(id)) throw new Error('Invalid note ID');
  return join(NOTES_DIR, `${id}.json`);
}

/** @returns {Promise<NoteSummary[]>} */
export async function listNotes() {
  await ensureDir();
  const files = await readdir(NOTES_DIR);
  const notes = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(NOTES_DIR, f), 'utf8');
      const note = JSON.parse(raw);
      notes.push({ id: note.id, title: note.title, project: note.project || '', tags: note.tags || [], updatedAt: note.updatedAt, createdAt: note.createdAt, preview: (note.content || '').slice(0, 120) });
    } catch { /* skip corrupt */ }
  }
  notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return notes;
}

/**
 * @param {string} id - Hex note ID
 * @returns {Promise<Note|null>}
 */
export async function getNote(id) {
  if (!isValidNoteId(id)) return null;
  const path = noteFile(id);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * @param {{title?: string, content?: string, project?: string, tags?: string[]}} params
 * @returns {Promise<Note>}
 */
export async function createNote({ title, content, project, tags }) {
  await ensureDir();
  const id = randomBytes(8).toString('hex');
  const now = Date.now();
  const note = { id, title: title || 'Untitled', content: content || '', project: project || '', tags: tags || [], createdAt: now, updatedAt: now };
  await writeFile(noteFile(id), JSON.stringify(note, null, 2), 'utf8');
  return note;
}

/**
 * @param {string} id - Hex note ID
 * @param {{title?: string, content?: string, project?: string, tags?: string[]}} updates
 * @returns {Promise<Note|null>}
 */
export async function updateNote(id, updates) {
  const note = await getNote(id);
  if (!note) return null;
  const allowed = ['title', 'content', 'project', 'tags'];
  for (const k of allowed) { if (updates[k] !== undefined) note[k] = updates[k]; }
  note.updatedAt = Date.now();
  await writeFile(noteFile(id), JSON.stringify(note, null, 2), 'utf8');
  return note;
}

/**
 * @param {string} id - Hex note ID
 * @returns {Promise<boolean>}
 */
export async function deleteNote(id) {
  if (!isValidNoteId(id)) return false;
  const path = noteFile(id);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
