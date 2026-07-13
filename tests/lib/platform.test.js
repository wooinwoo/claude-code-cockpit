import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IS_WIN, IS_MAC, getIdeBin, getIdeSpawnOpts, getFirefoxDevBin, getShell } from '../../lib/platform.js';

describe('platform', () => {
  describe('IS_WIN / IS_MAC constants', () => {
    it('IS_WIN is a boolean', () => {
      assert.strictEqual(typeof IS_WIN, 'boolean');
    });

    it('IS_MAC is a boolean', () => {
      assert.strictEqual(typeof IS_MAC, 'boolean');
    });

    it('IS_WIN matches process.platform', () => {
      assert.strictEqual(IS_WIN, process.platform === 'win32');
    });

    it('IS_MAC matches process.platform', () => {
      assert.strictEqual(IS_MAC, process.platform === 'darwin');
    });

    it('IS_WIN and IS_MAC are not both true', () => {
      assert.strictEqual(IS_WIN && IS_MAC, false);
    });
  });

  describe('getIdeBin', () => {
    it('returns a string for zed', () => {
      const result = getIdeBin('zed');
      assert.strictEqual(typeof result, 'string');
      assert.ok(result.length > 0);
    });

    it('zed on Windows includes zed.exe', () => {
      if (IS_WIN) {
        assert.ok(getIdeBin('zed').endsWith('zed.exe'));
      }
    });

    it('zed on macOS returns MacOS cli path', () => {
      if (IS_MAC) {
        assert.strictEqual(getIdeBin('zed'), '/Applications/Zed.app/Contents/MacOS/cli');
      }
    });

    it('code returns code.cmd on Windows', () => {
      if (IS_WIN) {
        assert.strictEqual(getIdeBin('code'), 'code.cmd');
      }
    });

    it('code returns code on non-Windows', () => {
      if (!IS_WIN) {
        assert.strictEqual(getIdeBin('code'), 'code');
      }
    });

    it('cursor returns cursor.cmd on Windows', () => {
      if (IS_WIN) {
        assert.strictEqual(getIdeBin('cursor'), 'cursor.cmd');
      }
    });

    it('cursor returns cursor on non-Windows', () => {
      if (!IS_WIN) {
        assert.strictEqual(getIdeBin('cursor'), 'cursor');
      }
    });

    it('appends .cmd suffix on Windows for generic IDE', () => {
      if (IS_WIN) {
        assert.strictEqual(getIdeBin('windsurf'), 'windsurf.cmd');
        assert.strictEqual(getIdeBin('antigravity'), 'antigravity.cmd');
      }
    });

    it('returns bare name on non-Windows for generic IDE', () => {
      if (!IS_WIN) {
        assert.strictEqual(getIdeBin('windsurf'), 'windsurf');
      }
    });

    it('zed on Windows includes LOCALAPPDATA path', () => {
      if (IS_WIN) {
        const result = getIdeBin('zed');
        assert.ok(result.includes('Programs'));
        assert.ok(result.includes('Zed'));
      }
    });
  });

  describe('getFirefoxDevBin', () => {
    it('returns a string', () => {
      assert.strictEqual(typeof getFirefoxDevBin(), 'string');
    });

    it('contains firefox on all platforms', () => {
      assert.ok(getFirefoxDevBin().toLowerCase().includes('firefox'));
    });

    it('returns .exe path on Windows', () => {
      if (IS_WIN) {
        assert.ok(getFirefoxDevBin().endsWith('firefox.exe'));
      }
    });

    it('returns app bundle path on macOS', () => {
      if (IS_MAC) {
        assert.ok(getFirefoxDevBin().includes('/Applications/'));
      }
    });

    it('returns bare command on Linux', () => {
      if (!IS_WIN && !IS_MAC) {
        assert.strictEqual(getFirefoxDevBin(), 'firefox-developer-edition');
      }
    });
  });

  describe('getShell', () => {
    it('returns a string', () => {
      assert.strictEqual(typeof getShell(), 'string');
    });

    it('returns powershell variant on Windows', () => {
      if (IS_WIN) {
        const shell = getShell();
        assert.ok(shell === 'pwsh.exe' || shell === 'powershell.exe', `Unexpected shell: ${shell}`);
      }
    });

    it('returns a Unix shell on non-Windows', () => {
      if (!IS_WIN) {
        const shell = getShell();
        assert.ok(['zsh', 'bash', 'fish'].includes(shell), `Unexpected shell: ${shell}`);
      }
    });

    it('returns same value on repeated calls (caching)', () => {
      const first = getShell();
      const second = getShell();
      assert.strictEqual(first, second);
    });
  });

  describe('getIdeSpawnOpts', () => {
    it('returns an object', () => {
      assert.strictEqual(typeof getIdeSpawnOpts(), 'object');
    });

    it('has detached: true', () => {
      assert.strictEqual(getIdeSpawnOpts().detached, true);
    });

    it('has stdio: ignore', () => {
      assert.strictEqual(getIdeSpawnOpts().stdio, 'ignore');
    });

    it('has windowsHide: true', () => {
      assert.strictEqual(getIdeSpawnOpts().windowsHide, true);
    });

    it('shell matches IS_WIN', () => {
      assert.strictEqual(getIdeSpawnOpts().shell, IS_WIN);
    });
  });
});
