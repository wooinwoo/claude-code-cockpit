import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseWslPath, isWslPath, toWinPath, searchExec } from '../../lib/wsl-utils.js';

// ─── parseWslPath ───────────────────────────────────────────────────────────

describe('parseWslPath', () => {
  it('parses //wsl$/distro/path format', () => {
    const result = parseWslPath('//wsl$/Ubuntu/home/user/project');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/home/user/project' });
  });

  it('parses //wsl.localhost/distro/path format', () => {
    const result = parseWslPath('//wsl.localhost/Ubuntu-22.04/home/user/project');
    assert.deepStrictEqual(result, { distro: 'Ubuntu-22.04', linuxPath: '/home/user/project' });
  });

  it('parses //wsl./distro/path format (dot without localhost)', () => {
    const result = parseWslPath('//wsl./Debian/home/user');
    assert.deepStrictEqual(result, { distro: 'Debian', linuxPath: '/home/user' });
  });

  it('parses backslash-style \\\\wsl$\\distro\\path', () => {
    const result = parseWslPath('\\\\wsl$\\Ubuntu\\home\\user\\project');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/home/user/project' });
  });

  it('parses backslash-style \\\\wsl.localhost\\distro\\path', () => {
    const result = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\code');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/home/user/code' });
  });

  it('is case-insensitive for the wsl prefix', () => {
    const result = parseWslPath('//WSL$/Ubuntu/home/user');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/home/user' });
  });

  it('handles deeply nested linux paths', () => {
    const result = parseWslPath('//wsl$/Ubuntu/home/user/a/b/c/d/e');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/home/user/a/b/c/d/e' });
  });

  it('handles root linux path', () => {
    const result = parseWslPath('//wsl$/Ubuntu/');
    assert.deepStrictEqual(result, { distro: 'Ubuntu', linuxPath: '/' });
  });

  it('returns null for regular Windows paths', () => {
    assert.strictEqual(parseWslPath('C:\\Users\\user\\project'), null);
  });

  it('returns null for regular Unix paths', () => {
    assert.strictEqual(parseWslPath('/home/user/project'), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseWslPath(''), null);
  });

  it('returns null for null input', () => {
    assert.strictEqual(parseWslPath(null), null);
  });

  it('returns null for undefined input', () => {
    assert.strictEqual(parseWslPath(undefined), null);
  });

  it('returns null for path with only distro (no linux path)', () => {
    // //wsl$/Ubuntu has no trailing path component with /
    assert.strictEqual(parseWslPath('//wsl$/Ubuntu'), null);
  });

  it('returns null for non-path strings', () => {
    assert.strictEqual(parseWslPath('hello world'), null);
  });

  it('returns null for http URLs', () => {
    assert.strictEqual(parseWslPath('http://wsl$/Ubuntu/home'), null);
  });
});

// ─── isWslPath ──────────────────────────────────────────────────────────────

describe('isWslPath', () => {
  it('returns true for //wsl$/distro/path', () => {
    assert.strictEqual(isWslPath('//wsl$/Ubuntu/home/user'), true);
  });

  it('returns true for //wsl.localhost/distro/path', () => {
    assert.strictEqual(isWslPath('//wsl.localhost/Ubuntu/home/user'), true);
  });

  it('returns true for backslash-style \\\\wsl$\\distro\\path', () => {
    assert.strictEqual(isWslPath('\\\\wsl$\\Ubuntu\\home\\user'), true);
  });

  it('returns true for //wsl./distro/path', () => {
    assert.strictEqual(isWslPath('//wsl./Debian/home/user'), true);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(isWslPath('//WSL.LOCALHOST/Ubuntu/home'), true);
  });

  it('returns false for regular Windows paths', () => {
    assert.strictEqual(isWslPath('C:\\Users\\user\\project'), false);
  });

  it('returns false for regular Unix paths', () => {
    assert.strictEqual(isWslPath('/home/user/project'), false);
  });

  it('returns false for empty string', () => {
    assert.strictEqual(isWslPath(''), false);
  });

  it('returns false for null', () => {
    assert.strictEqual(isWslPath(null), false);
  });

  it('returns false for undefined', () => {
    assert.strictEqual(isWslPath(undefined), false);
  });

  it('returns false for path with only distro name', () => {
    assert.strictEqual(isWslPath('//wsl$/Ubuntu'), false);
  });

  it('agrees with parseWslPath on WSL paths', () => {
    const wslPaths = [
      '//wsl$/Ubuntu/home',
      '//wsl.localhost/Debian/var/log',
      '\\\\wsl$\\Alpine\\root',
    ];
    for (const p of wslPaths) {
      assert.strictEqual(isWslPath(p), parseWslPath(p) !== null, `Mismatch for: ${p}`);
    }
  });

  it('agrees with parseWslPath on non-WSL paths', () => {
    const nonWslPaths = [
      'C:\\Users\\user',
      '/home/user',
      '',
      null,
      '//wsl$/Ubuntu',
    ];
    for (const p of nonWslPaths) {
      assert.strictEqual(isWslPath(p), parseWslPath(p) !== null, `Mismatch for: ${p}`);
    }
  });
});

// ─── toWinPath ──────────────────────────────────────────────────────────────

describe('toWinPath', () => {
  it('converts forward slashes to backslashes', () => {
    assert.strictEqual(toWinPath('C:/Users/user/project'), 'C:\\Users\\user\\project');
  });

  it('leaves backslash paths unchanged', () => {
    assert.strictEqual(toWinPath('C:\\Users\\user'), 'C:\\Users\\user');
  });

  it('handles mixed slashes', () => {
    assert.strictEqual(toWinPath('C:/Users\\user/project'), 'C:\\Users\\user\\project');
  });

  it('handles root path', () => {
    assert.strictEqual(toWinPath('/'), '\\');
  });

  it('handles empty string', () => {
    assert.strictEqual(toWinPath(''), '');
  });

  it('handles null input', () => {
    assert.strictEqual(toWinPath(null), '');
  });

  it('handles undefined input', () => {
    assert.strictEqual(toWinPath(undefined), '');
  });

  it('handles paths with multiple consecutive slashes', () => {
    assert.strictEqual(toWinPath('C://Users///project'), 'C:\\\\Users\\\\\\project');
  });

  it('handles UNC-style paths', () => {
    assert.strictEqual(toWinPath('//server/share/folder'), '\\\\server\\share\\folder');
  });

  it('handles path with no slashes', () => {
    assert.strictEqual(toWinPath('filename.txt'), 'filename.txt');
  });

  it('handles WSL path conversion', () => {
    assert.strictEqual(
      toWinPath('//wsl$/Ubuntu/home/user'),
      '\\\\wsl$\\Ubuntu\\home\\user'
    );
  });
});

// ─── sanitizeSearchPattern (tested indirectly via searchExec) ───────────────

describe('sanitizeSearchPattern (via searchExec)', () => {
  it('returns empty string for null pattern', async () => {
    const result = await searchExec('/some/path', null);
    assert.strictEqual(result, '');
  });

  it('returns empty string for undefined pattern', async () => {
    const result = await searchExec('/some/path', undefined);
    assert.strictEqual(result, '');
  });

  it('returns empty string for empty string pattern', async () => {
    const result = await searchExec('/some/path', '');
    assert.strictEqual(result, '');
  });

  it('returns empty string for non-string pattern (number)', async () => {
    const result = await searchExec('/some/path', 42);
    assert.strictEqual(result, '');
  });

  it('returns empty string for non-string pattern (object)', async () => {
    const result = await searchExec('/some/path', {});
    assert.strictEqual(result, '');
  });

  it('returns empty string for pattern of only control characters', async () => {
    const result = await searchExec('/some/path', '\x00\x01\x1f');
    assert.strictEqual(result, '');
  });
});
