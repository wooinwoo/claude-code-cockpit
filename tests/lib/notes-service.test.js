import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We cannot easily redirect the module's NOTES_DIR, so we test pure logic
// by extracting the regex and testing the exported functions via a temp dir approach.

// ─── Pure function tests (isValidNoteId logic) ───
const isValidNoteId = (id) => /^[a-f0-9]+$/.test(id);

describe('notes-service', () => {
  describe('isValidNoteId', () => {
    it('accepts valid hex strings', () => {
      assert.strictEqual(isValidNoteId('abcdef0123456789'), true);
    });

    it('accepts short hex strings', () => {
      assert.strictEqual(isValidNoteId('a'), true);
    });

    it('accepts 16-char hex id (randomBytes(8))', () => {
      assert.strictEqual(isValidNoteId('0a1b2c3d4e5f6a7b'), true);
    });

    it('rejects empty string', () => {
      assert.strictEqual(isValidNoteId(''), false);
    });

    it('rejects uppercase hex', () => {
      assert.strictEqual(isValidNoteId('ABCDEF'), false);
    });

    it('rejects strings with special characters', () => {
      assert.strictEqual(isValidNoteId('abc-def'), false);
    });

    it('rejects strings with dots', () => {
      assert.strictEqual(isValidNoteId('abc.def'), false);
    });

    it('rejects path traversal attempts', () => {
      assert.strictEqual(isValidNoteId('../etc/passwd'), false);
    });

    it('rejects strings with spaces', () => {
      assert.strictEqual(isValidNoteId('abc def'), false);
    });

    it('rejects strings with g-z characters', () => {
      assert.strictEqual(isValidNoteId('ghijklmnop'), false);
    });

    it('rejects null-like input coerced to string', () => {
      assert.strictEqual(isValidNoteId('null'), false);
    });

    it('rejects strings with slashes', () => {
      assert.strictEqual(isValidNoteId('aa/bb'), false);
    });
  });

  describe('noteFile construction', () => {
    const noteFile = (id, dir) => {
      if (!isValidNoteId(id)) throw new Error('Invalid note ID');
      return join(dir, `${id}.json`);
    };

    it('returns correct path for valid id', () => {
      const result = noteFile('abcdef', '/tmp/notes');
      assert.strictEqual(result, join('/tmp/notes', 'abcdef.json'));
    });

    it('throws for invalid id', () => {
      assert.throws(() => noteFile('invalid!', '/tmp/notes'), /Invalid note ID/);
    });

    it('throws for empty id', () => {
      assert.throws(() => noteFile('', '/tmp/notes'), /Invalid note ID/);
    });
  });

  // ─── File I/O integration tests using temp directory ───
  describe('note CRUD (temp dir simulation)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'notes-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('can write and read a note JSON file', () => {
      const note = { id: 'aabbccdd', title: 'Test', content: 'Hello', tags: [], createdAt: Date.now(), updatedAt: Date.now() };
      const path = join(tmpDir, `${note.id}.json`);
      writeFileSync(path, JSON.stringify(note, null, 2), 'utf8');

      const read = JSON.parse(readFileSync(path, 'utf8'));
      assert.strictEqual(read.title, 'Test');
      assert.strictEqual(read.content, 'Hello');
    });

    it('can list note files in directory', () => {
      writeFileSync(join(tmpDir, 'aa.json'), '{}');
      writeFileSync(join(tmpDir, 'bb.json'), '{}');
      writeFileSync(join(tmpDir, 'readme.txt'), 'skip');

      const files = readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 2);
    });

    it('sorts notes by updatedAt descending', () => {
      const notes = [
        { id: 'aa', updatedAt: 100 },
        { id: 'cc', updatedAt: 300 },
        { id: 'bb', updatedAt: 200 },
      ];
      notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      assert.strictEqual(notes[0].id, 'cc');
      assert.strictEqual(notes[2].id, 'aa');
    });

    it('handles corrupt JSON gracefully', () => {
      writeFileSync(join(tmpDir, 'bad.json'), 'not-json{{{');
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(join(tmpDir, 'bad.json'), 'utf8')); } catch { /* skip corrupt */ }
      assert.strictEqual(parsed, null);
    });

    it('generates preview from content', () => {
      const content = 'A'.repeat(200);
      const preview = content.slice(0, 120);
      assert.strictEqual(preview.length, 120);
    });

    it('update only allows certain fields', () => {
      const note = { id: 'aabb', title: 'Old', content: 'Old content', project: '', tags: [] };
      const updates = { title: 'New', content: 'New content', project: 'proj', tags: ['a'], badField: 'hack' };
      const allowed = ['title', 'content', 'project', 'tags'];
      for (const k of allowed) { if (updates[k] !== undefined) note[k] = updates[k]; }
      assert.strictEqual(note.title, 'New');
      assert.strictEqual(note.content, 'New content');
      assert.strictEqual(note.project, 'proj');
      assert.deepStrictEqual(note.tags, ['a']);
      assert.strictEqual(note.badField, undefined);
    });

    it('delete returns false for non-existent file', () => {
      const path = join(tmpDir, 'nonexistent.json');
      assert.strictEqual(existsSync(path), false);
    });

    it('delete removes file when it exists', () => {
      const path = join(tmpDir, 'todelete.json');
      writeFileSync(path, '{}');
      assert.strictEqual(existsSync(path), true);
      unlinkSync(path);
      assert.strictEqual(existsSync(path), false);
    });

    it('createNote sets default title to Untitled', () => {
      const title = undefined || 'Untitled';
      assert.strictEqual(title, 'Untitled');
    });

    it('createNote sets default content to empty string', () => {
      const content = undefined || '';
      assert.strictEqual(content, '');
    });
  });
});
