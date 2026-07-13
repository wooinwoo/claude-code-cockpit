import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Extracted pure functions from claude-data.js ───

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLastLines(filePath, numLines = 5) {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return [];
    const fd = openSync(filePath, 'r');
    const bufSize = Math.min(st.size, 16384);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, Math.max(0, st.size - bufSize));
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-numLines);
  } catch {
    return [];
  }
}

function readFirstLines(filePath, numLines = 20) {
  try {
    const fd = openSync(filePath, 'r');
    const bufSize = Math.min(statSync(filePath).size, 32768);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, 0);
    closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(0, numLines);
  } catch { return []; }
}

// toClaudeProjectDir from config.js
function toClaudeProjectDir(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Model name cleanup
function cleanModelName(model) {
  if (!model) return null;
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

// Parse user message content
function parseUserContent(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

// Parse assistant message blocks
function parseAssistantBlocks(blocks) {
  const textParts = [];
  const tools = [];
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b.type === 'text' && b.text) textParts.push(b.text);
      else if (b.type === 'tool_use') tools.push({ name: b.name, input: JSON.stringify(b.input || {}).slice(0, 500) });
    }
  } else if (typeof blocks === 'string') {
    textParts.push(blocks);
  }
  return { textParts, tools };
}

describe('claude-data', () => {
  describe('parseJsonLine', () => {
    it('parses valid JSON', () => {
      assert.deepStrictEqual(parseJsonLine('{"a":1}'), { a: 1 });
    });

    it('returns null for invalid JSON', () => {
      assert.strictEqual(parseJsonLine('not json'), null);
    });

    it('returns null for empty string', () => {
      assert.strictEqual(parseJsonLine(''), null);
    });

    it('parses JSON array', () => {
      assert.deepStrictEqual(parseJsonLine('[1,2,3]'), [1, 2, 3]);
    });

    it('parses nested objects', () => {
      const result = parseJsonLine('{"type":"user","message":{"content":"hello"}}');
      assert.strictEqual(result.type, 'user');
      assert.strictEqual(result.message.content, 'hello');
    });

    it('returns null for partial JSON', () => {
      assert.strictEqual(parseJsonLine('{"a":'), null);
    });
  });

  describe('readLastLines', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'claude-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads last N lines from a file', () => {
      const path = join(tmpDir, 'test.jsonl');
      writeFileSync(path, 'line1\nline2\nline3\nline4\nline5\n');
      const result = readLastLines(path, 3);
      assert.deepStrictEqual(result, ['line3', 'line4', 'line5']);
    });

    it('returns all lines if fewer than N', () => {
      const path = join(tmpDir, 'test.jsonl');
      writeFileSync(path, 'line1\nline2\n');
      const result = readLastLines(path, 5);
      assert.deepStrictEqual(result, ['line1', 'line2']);
    });

    it('returns empty array for empty file', () => {
      const path = join(tmpDir, 'empty.jsonl');
      writeFileSync(path, '');
      assert.deepStrictEqual(readLastLines(path), []);
    });

    it('returns empty array for non-existent file', () => {
      assert.deepStrictEqual(readLastLines(join(tmpDir, 'nope.jsonl')), []);
    });

    it('handles single line file', () => {
      const path = join(tmpDir, 'single.jsonl');
      writeFileSync(path, '{"type":"user"}');
      const result = readLastLines(path, 1);
      assert.deepStrictEqual(result, ['{"type":"user"}']);
    });
  });

  describe('readFirstLines', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'claude-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads first N lines from a file', () => {
      const path = join(tmpDir, 'test.jsonl');
      writeFileSync(path, 'line1\nline2\nline3\nline4\nline5\n');
      const result = readFirstLines(path, 3);
      assert.deepStrictEqual(result, ['line1', 'line2', 'line3']);
    });

    it('returns empty array for non-existent file', () => {
      assert.deepStrictEqual(readFirstLines(join(tmpDir, 'nope.jsonl')), []);
    });
  });

  describe('toClaudeProjectDir', () => {
    it('encodes simple path', () => {
      assert.strictEqual(toClaudeProjectDir('C:/project/foo'), 'C--project-foo');
    });

    it('encodes path with backslashes', () => {
      assert.strictEqual(toClaudeProjectDir('C:\\project\\bar'), 'C--project-bar');
    });

    it('preserves alphanumeric chars', () => {
      assert.strictEqual(toClaudeProjectDir('abc123'), 'abc123');
    });

    it('replaces dots and dashes', () => {
      assert.strictEqual(toClaudeProjectDir('my-project.v2'), 'my-project-v2');
    });

    it('encodes spaces', () => {
      assert.strictEqual(toClaudeProjectDir('my project'), 'my-project');
    });
  });

  describe('cleanModelName', () => {
    it('strips claude- prefix', () => {
      assert.strictEqual(cleanModelName('claude-3-5-sonnet'), '3-5-sonnet');
    });

    it('strips date suffix', () => {
      assert.strictEqual(cleanModelName('claude-3-5-sonnet-20241022'), '3-5-sonnet');
    });

    it('returns null for null input', () => {
      assert.strictEqual(cleanModelName(null), null);
    });

    it('returns null for undefined', () => {
      assert.strictEqual(cleanModelName(undefined), null);
    });

    it('handles model without claude prefix', () => {
      assert.strictEqual(cleanModelName('3-5-sonnet-20241022'), '3-5-sonnet');
    });
  });

  describe('parseUserContent', () => {
    it('returns string content as-is', () => {
      assert.strictEqual(parseUserContent('hello world'), 'hello world');
    });

    it('joins text blocks from array', () => {
      const blocks = [
        { type: 'text', text: 'part1' },
        { type: 'image', data: 'binary' },
        { type: 'text', text: 'part2' }
      ];
      assert.strictEqual(parseUserContent(blocks), 'part1\npart2');
    });

    it('returns empty string for non-string/non-array', () => {
      assert.strictEqual(parseUserContent(42), '');
      assert.strictEqual(parseUserContent(null), '');
      assert.strictEqual(parseUserContent(undefined), '');
    });

    it('returns empty string for empty array', () => {
      assert.strictEqual(parseUserContent([]), '');
    });

    it('filters out non-text blocks', () => {
      const blocks = [{ type: 'image', data: 'x' }];
      assert.strictEqual(parseUserContent(blocks), '');
    });
  });

  describe('parseAssistantBlocks', () => {
    it('extracts text parts from blocks', () => {
      const blocks = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' }
      ];
      const { textParts, tools } = parseAssistantBlocks(blocks);
      assert.deepStrictEqual(textParts, ['Hello', 'World']);
      assert.strictEqual(tools.length, 0);
    });

    it('extracts tool_use blocks', () => {
      const blocks = [
        { type: 'tool_use', name: 'Read', input: { file_path: '/test.js' } },
        { type: 'text', text: 'done' }
      ];
      const { textParts, tools } = parseAssistantBlocks(blocks);
      assert.strictEqual(textParts.length, 1);
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].name, 'Read');
    });

    it('handles string content', () => {
      const { textParts } = parseAssistantBlocks('plain text');
      assert.deepStrictEqual(textParts, ['plain text']);
    });

    it('handles empty array', () => {
      const { textParts, tools } = parseAssistantBlocks([]);
      assert.strictEqual(textParts.length, 0);
      assert.strictEqual(tools.length, 0);
    });

    it('truncates tool input to 500 chars', () => {
      const bigInput = { data: 'x'.repeat(1000) };
      const blocks = [{ type: 'tool_use', name: 'Write', input: bigInput }];
      const { tools } = parseAssistantBlocks(blocks);
      assert.ok(tools[0].input.length <= 500);
    });

    it('handles null/undefined gracefully', () => {
      const { textParts, tools } = parseAssistantBlocks(null);
      assert.strictEqual(textParts.length, 0);
      assert.strictEqual(tools.length, 0);
    });
  });
});

