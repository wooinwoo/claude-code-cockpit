import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardService } from '../../lib/board-service.js';

describe('board-service', () => {
  let dir;
  let file;
  let service;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-board-'));
    file = join(dir, 'board.json');
    service = createBoardService(file);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('assigns stable task IDs and persists task state', () => {
    const first = service.addBoardTask('첫 작업');
    const second = service.addBoardTask('둘째 작업');
    assert.equal(first.task.id, 'T-0001');
    assert.equal(second.task.id, 'T-0002');

    const completed = service.updateBoardTask(first.task.id, { done: true });
    assert.equal(completed.task.done, true);
    assert.equal(createBoardService(file).getBoard().tasks[0].done, true);
  });

  it('stores a sticky note and removes a task by ID', () => {
    service.updateBoardNote('잊지 말 것');
    const { task } = service.addBoardTask('삭제할 작업');
    assert.equal(service.deleteBoardTask(task.id).task.id, 'T-0001');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.note.content, '잊지 말 것');
    assert.deepEqual(saved.tasks, []);
  });

  it('rejects empty tasks and returns null for unknown IDs', () => {
    assert.throws(() => service.addBoardTask('   '), /text is required/);
    assert.equal(service.updateBoardTask('T-9999', { done: true }), null);
    assert.equal(service.deleteBoardTask('T-9999'), null);
  });

  it('normalizes imported state and advances the ID sequence', () => {
    service.replaceBoard({
      note: { content: 'memo' },
      tasks: [{ id: 'T-0042', text: 'existing', done: false }],
      nextTaskNumber: 2,
    });
    assert.equal(service.addBoardTask('next').task.id, 'T-0043');
  });

  it('migrates the legacy singleton board into the first memo and checklist', () => {
    service.replaceBoard({
      note: { content: 'legacy memo', updatedAt: 123 },
      tasks: [{ id: 'T-0007', text: 'legacy task', done: false }],
    });
    const saved = service.getBoard();
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.notes[0].id, 'N-0001');
    assert.equal(saved.notes[0].content, 'legacy memo');
    assert.equal(saved.checklists[0].id, 'C-0001');
    assert.equal(saved.tasks[0].checklistId, 'C-0001');
  });

  it('keeps multiple memos and checklist tasks independent', () => {
    service.replaceBoard({
      schemaVersion: 2,
      notes: [
        { id: 'N-0001', title: 'Memo 1', content: 'first' },
        { id: 'N-0002', title: 'Memo 2', content: 'second' },
      ],
      checklists: [
        { id: 'C-0001', title: 'Checklist 1' },
        { id: 'C-0002', title: 'Checklist 2' },
      ],
      tasks: [{ id: 'T-0001', checklistId: 'C-0001', text: 'first list', done: false }],
    });
    const created = service.addBoardTask('second list', 'C-0002');
    const saved = service.getBoard();
    assert.equal(saved.notes[0].content, 'first');
    assert.equal(saved.notes[1].content, 'second');
    assert.equal(created.task.checklistId, 'C-0002');
    assert.deepEqual(saved.tasks.map(task => task.checklistId), ['C-0001', 'C-0002']);
  });

  it('re-reads under a file lock so separate writers do not lose tasks', () => {
    const other = createBoardService(file);
    assert.equal(service.addBoardTask('first').task.id, 'T-0001');
    assert.equal(other.addBoardTask('second').task.id, 'T-0002');
    assert.deepEqual(service.getBoard().tasks.map(task => task.text), ['first', 'second']);
  });

  it('refuses to overwrite corrupt JSON', () => {
    writeFileSync(file, '{not json', 'utf8');
    assert.throws(() => service.getBoard(), /corrupt JSON/);
    assert.throws(() => service.addBoardTask('must not overwrite'), /corrupt JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{not json');
  });

  it('appends notes atomically through the service mutation path', () => {
    service.updateBoardNote('first');
    service.appendBoardNote('second');
    assert.equal(service.getBoard().note.content, 'first\nsecond');
    assert.equal(service.getBoard().revision, 2);
  });

  it('rejects an append that would truncate the new content', () => {
    service.updateBoardNote('x'.repeat(12_000));
    assert.throws(() => service.appendBoardNote('must remain whole'), /12000 character note limit/);
    assert.equal(service.getBoard().note.content.length, 12_000);
    assert.equal(service.getBoard().revision, 1);
  });

  it('imports a local snapshot only when the expected revision still matches', () => {
    const imported = service.replaceBoardIfRevision({
      note: { content: 'offline' },
      tasks: [{ id: 'T-0007', text: 'keep this ID', done: false }],
    }, 0);
    assert.equal(imported.revision, 1);
    assert.equal(imported.tasks[0].id, 'T-0007');
    assert.throws(() => service.replaceBoardIfRevision({ tasks: [] }, 0), error => error.code === 'BOARD_CONFLICT');
    assert.equal(service.getBoard().tasks[0].id, 'T-0007');
  });
});
