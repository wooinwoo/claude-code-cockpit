import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appData = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
const defaultBoardFile = join(appData, 'cockpit', '.cockpit-board.json');
const packagedRoot = join(__dirname, '..');
const legacyBoardFile = process.env.COCKPIT_LEGACY_BOARD_FILE
  || (existsSync(join(packagedRoot, 'package.json')) ? join(packagedRoot, '.cockpit-board.json') : null);
export const BOARD_FILE = process.env.COCKPIT_BOARD_FILE || defaultBoardFile;
let migrationError = null;

class BoardError extends Error {
  constructor(message, code, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BoardError';
    this.code = code;
  }
}

function emptyBoard() {
  return {
    schemaVersion: 2,
    note: { content: '', updatedAt: 0 },
    notes: [],
    checklists: [],
    tasks: [],
    nextNoteNumber: 1,
    nextChecklistNumber: 1,
    nextTaskNumber: 1,
    revision: 0,
    updatedAt: 0,
  };
}

function cleanText(value, limit, field) {
  if (typeof value !== 'string') throw new BoardError(`${field} must be a string`, 'BOARD_VALIDATION');
  const text = value.trim();
  if (!text) throw new BoardError(`${field} is required`, 'BOARD_VALIDATION');
  return text.slice(0, limit);
}

function normalizeBoard(input) {
  const source = input && typeof input === 'object' ? input : {};
  const now = Date.now();
  const legacyNote = {
    id: 'N-0001',
    title: 'Memo 1',
    content: typeof source.note?.content === 'string' ? source.note.content.slice(0, 12_000) : '',
    createdAt: Number(source.note?.updatedAt) || now,
    updatedAt: Number(source.note?.updatedAt) || 0,
  };
  const notes = [];
  const seenNotes = new Set();
  let highestNote = 0;
  const noteSource = Array.isArray(source.notes) ? source.notes : [legacyNote];
  for (const item of noteSource) {
    const match = /^N-(\d{4,})$/.exec(String(item?.id || ''));
    if (!match || seenNotes.has(item.id)) continue;
    seenNotes.add(item.id);
    highestNote = Math.max(highestNote, Number(match[1]));
    notes.push({
      id: item.id,
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Memo ${Number(match[1])}`).slice(0, 80),
      content: typeof item.content === 'string' ? item.content.slice(0, 12_000) : '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  const checklists = [];
  const seenChecklists = new Set();
  let highestChecklist = 0;
  const checklistSource = Array.isArray(source.checklists)
    ? source.checklists
    : [{ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 }];
  for (const item of checklistSource) {
    const match = /^C-(\d{4,})$/.exec(String(item?.id || ''));
    if (!match || seenChecklists.has(item.id)) continue;
    seenChecklists.add(item.id);
    highestChecklist = Math.max(highestChecklist, Number(match[1]));
    checklists.push({
      id: item.id,
      title: (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Checklist ${Number(match[1])}`).slice(0, 80),
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  if (!checklists.length && Array.isArray(source.tasks) && source.tasks.some(item => item?.text)) {
    checklists.push({ id: 'C-0001', title: 'Checklist 1', createdAt: now, updatedAt: 0 });
    seenChecklists.add('C-0001');
    highestChecklist = 1;
  }
  const defaultChecklistId = checklists[0]?.id || '';
  const seen = new Set();
  let highest = 0;
  const tasks = [];
  for (const item of Array.isArray(source.tasks) ? source.tasks : []) {
    const match = /^T-(\d{4,})$/.exec(String(item?.id || ''));
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 500) : '';
    if (!match || !text || seen.has(item.id)) continue;
    seen.add(item.id);
    highest = Math.max(highest, Number(match[1]));
    tasks.push({
      id: item.id,
      text,
      done: item.done === true,
      checklistId: seenChecklists.has(item.checklistId) ? item.checklistId : defaultChecklistId,
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    });
  }
  const primaryNote = notes[0] || { content: '', updatedAt: 0 };
  return {
    schemaVersion: 2,
    // Kept as a projection of the first memo for older CLI clients.
    note: { content: primaryNote.content, updatedAt: primaryNote.updatedAt },
    notes,
    checklists,
    tasks,
    nextNoteNumber: Math.max(highestNote + 1, Number(source.nextNoteNumber) || 1),
    nextChecklistNumber: Math.max(highestChecklist + 1, Number(source.nextChecklistNumber) || 1),
    nextTaskNumber: Math.max(highest + 1, Number(source.nextTaskNumber) || 1),
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: Number(source.updatedAt) || 0,
  };
}

function snapshot(board) {
  return structuredClone(board);
}

function storageError(action, error) {
  if (error instanceof BoardError) return error;
  return new BoardError(`Unable to ${action} Cockpit board: ${error.message}`, 'BOARD_STORAGE', error);
}

function readBoard(filePath) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyBoard();
    throw storageError('read', error);
  }
  try { return normalizeBoard(JSON.parse(raw)); }
  catch (error) {
    throw new BoardError(`Cockpit board is corrupt JSON: ${error.message}`, 'BOARD_CORRUPT', error);
  }
}

function persistBoard(filePath, board) {
  const directory = dirname(filePath);
  const temp = join(directory, `.${fileURLToPath(import.meta.url).split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
    if (process.platform !== 'win32') {
      const directoryFd = openSync(directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* temp did not exist */ }
    throw storageError('write', error);
  }
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function withFileLock(filePath, mutate) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 3000;
  mkdirSync(dirname(filePath), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw storageError('lock', error);
      if (Date.now() >= deadline) throw new BoardError('Cockpit board is busy; try again', 'BOARD_BUSY');
      Atomics.wait(lockWait, 0, 0, 20);
    }
  }
  try {
    const current = readBoard(filePath);
    const mutation = mutate(snapshot(current));
    if (!mutation) return null;
    mutation.board.revision = current.revision + 1;
    mutation.board.updatedAt = Date.now();
    persistBoard(filePath, mutation.board);
    return mutation.result(mutation.board);
  } finally {
    try { rmdirSync(lockPath); } catch { /* lock cleanup is best effort */ }
  }
}

if (!process.env.COCKPIT_BOARD_FILE && legacyBoardFile && !existsSync(BOARD_FILE) && existsSync(legacyBoardFile)) {
  try {
    withFileLock(BOARD_FILE, current => {
      if (current.revision || current.updatedAt || current.note.content || current.tasks.length) return null;
      const legacy = readBoard(legacyBoardFile);
      return { board: legacy, result: saved => snapshot(saved) };
    });
  } catch (error) {
    migrationError = storageError('migrate', error);
  }
}

export function createBoardService(filePath = BOARD_FILE) {
  const ensureReady = () => {
    if (filePath === BOARD_FILE && migrationError) throw migrationError;
  };
  const mutate = change => {
    ensureReady();
    return withFileLock(filePath, change);
  };
  return {
    getBoard: () => {
      ensureReady();
      return snapshot(readBoard(filePath));
    },
    replaceBoard(value) {
      return mutate(() => {
        const next = normalizeBoard(value);
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    replaceBoardIfRevision(value, expectedRevision) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new BoardError('revision must be a non-negative integer', 'BOARD_VALIDATION');
      }
      return mutate(current => {
        if (current.revision !== expectedRevision) {
          throw new BoardError('Cockpit board changed on another client', 'BOARD_CONFLICT');
        }
        const next = normalizeBoard(value);
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    updateBoardNote(content) {
      if (typeof content !== 'string') throw new BoardError('content must be a string', 'BOARD_VALIDATION');
      return mutate(next => {
        const now = Date.now();
        const note = next.notes[0] || {
          id: `N-${String(next.nextNoteNumber++).padStart(4, '0')}`,
          title: 'Memo 1',
          content: '',
          createdAt: now,
          updatedAt: 0,
        };
        if (!next.notes.length) next.notes.push(note);
        note.content = content.slice(0, 12_000);
        note.updatedAt = now;
        next.note = { content: note.content, updatedAt: note.updatedAt };
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    appendBoardNote(content) {
      const extra = cleanText(content, 12_000, 'content');
      return mutate(next => {
        const now = Date.now();
        const note = next.notes[0] || {
          id: `N-${String(next.nextNoteNumber++).padStart(4, '0')}`,
          title: 'Memo 1',
          content: '',
          createdAt: now,
          updatedAt: 0,
        };
        if (!next.notes.length) next.notes.push(note);
        const separator = note.content ? '\n' : '';
        if (note.content.length + separator.length + extra.length > 12_000) {
          throw new BoardError('content exceeds the 12000 character note limit', 'BOARD_VALIDATION');
        }
        note.content = `${note.content}${separator}${extra}`;
        note.updatedAt = now;
        next.note = { content: note.content, updatedAt: note.updatedAt };
        return { board: next, result: saved => snapshot(saved) };
      });
    },
    addBoardTask(text, checklistId) {
      const clean = cleanText(text, 500, 'text');
      return mutate(next => {
        const now = Date.now();
        let checklist = checklistId && next.checklists.find(item => item.id === checklistId);
        if (checklistId && !checklist) throw new BoardError('checklist not found', 'BOARD_VALIDATION');
        if (!checklist) checklist = next.checklists[0];
        if (!checklist) {
          checklist = {
            id: `C-${String(next.nextChecklistNumber++).padStart(4, '0')}`,
            title: 'Checklist 1',
            createdAt: now,
            updatedAt: 0,
          };
          next.checklists.push(checklist);
        }
        const task = {
          id: `T-${String(next.nextTaskNumber++).padStart(4, '0')}`,
          text: clean,
          done: false,
          checklistId: checklist.id,
          createdAt: now,
          updatedAt: now,
        };
        next.tasks.push(task);
        return { board: next, result: saved => ({ board: snapshot(saved), task: { ...task } }) };
      });
    },
    updateBoardTask(id, updates = {}) {
      return mutate(next => {
        const task = next.tasks.find(item => item.id === id);
        if (!task) return null;
        if (updates.text !== undefined) task.text = cleanText(updates.text, 500, 'text');
        if (updates.done !== undefined) task.done = updates.done === true;
        task.updatedAt = Date.now();
        return { board: next, result: saved => ({ board: snapshot(saved), task: { ...task } }) };
      });
    },
    deleteBoardTask(id) {
      return mutate(next => {
        const index = next.tasks.findIndex(item => item.id === id);
        if (index < 0) return null;
        const [task] = next.tasks.splice(index, 1);
        return { board: next, result: saved => ({ board: snapshot(saved), task }) };
      });
    },
  };
}

const service = createBoardService();
export const getBoard = service.getBoard;
export const replaceBoard = service.replaceBoard;
export const replaceBoardIfRevision = service.replaceBoardIfRevision;
export const updateBoardNote = service.updateBoardNote;
export const appendBoardNote = service.appendBoardNote;
export const addBoardTask = service.addBoardTask;
export const updateBoardTask = service.updateBoardTask;
export const deleteBoardTask = service.deleteBoardTask;
