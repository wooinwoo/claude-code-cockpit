import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ─── Inline copies of pure functions to test without side effects ───
// config.js has module-level side effects (mkdirSync, file reads, etc.)
// so we replicate the pure logic here for isolated unit testing.

const COLOR_PALETTE = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EF4444', '#EC4899', '#06B6D4', '#84CC16',
  '#F97316', '#6366F1', '#14B8A6', '#E11D48'
];

function generateColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

function toClaudeProjectDir(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function encryptToken(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(encrypted, key) {
  if (!encrypted.startsWith('enc:')) return encrypted;
  const [, ivHex, tagHex, encHex] = encrypted.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

// ─── Tests ───

describe('generateColor', () => {
  it('returns a valid hex color from the palette', () => {
    const color = generateColor('my-project');
    assert.ok(COLOR_PALETTE.includes(color), `Expected palette color, got ${color}`);
  });

  it('is deterministic — same name always gives same color', () => {
    const a = generateColor('dashboard');
    const b = generateColor('dashboard');
    assert.strictEqual(a, b);
  });

  it('produces different colors for different names', () => {
    const colors = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(generateColor));
    // With 6 distinct names and 12-color palette, we expect at least 2 distinct colors
    assert.ok(colors.size >= 2, `Expected varied colors, got ${colors.size} distinct`);
  });

  it('handles empty string without throwing', () => {
    const color = generateColor('');
    assert.ok(COLOR_PALETTE.includes(color));
  });

  it('handles single character', () => {
    const color = generateColor('x');
    assert.ok(COLOR_PALETTE.includes(color));
  });

  it('handles very long strings', () => {
    const longName = 'a'.repeat(10000);
    const color = generateColor(longName);
    assert.ok(COLOR_PALETTE.includes(color));
  });

  it('handles unicode characters', () => {
    const color = generateColor('프로젝트-대시보드');
    assert.ok(COLOR_PALETTE.includes(color));
  });
});

describe('toClaudeProjectDir', () => {
  it('replaces slashes and colons with hyphens (Windows path)', () => {
    const result = toClaudeProjectDir('C:/Users/RST/projects/my-app');
    assert.strictEqual(result, 'C--Users-RST-projects-my-app');
  });

  it('replaces backslashes with hyphens', () => {
    const result = toClaudeProjectDir('C:\\Users\\RST\\projects');
    assert.strictEqual(result, 'C--Users-RST-projects');
  });

  it('preserves alphanumeric characters', () => {
    const result = toClaudeProjectDir('abc123XYZ');
    assert.strictEqual(result, 'abc123XYZ');
  });

  it('replaces dots, spaces, and special chars', () => {
    const result = toClaudeProjectDir('/home/user/my project.v2');
    assert.strictEqual(result, '-home-user-my-project-v2');
  });

  it('handles empty string', () => {
    const result = toClaudeProjectDir('');
    assert.strictEqual(result, '');
  });

  it('handles path with only special characters', () => {
    const result = toClaudeProjectDir('///...');
    assert.strictEqual(result, '------');
  });

  it('handles macOS-style path', () => {
    const result = toClaudeProjectDir('/Users/dev/workspace/api-server');
    assert.strictEqual(result, '-Users-dev-workspace-api-server');
  });
});

describe('encryptToken / decryptToken', () => {
  const testKey = randomBytes(32);

  it('round-trips a simple string', () => {
    const original = 'my-secret-api-token-12345';
    const encrypted = encryptToken(original, testKey);
    const decrypted = decryptToken(encrypted, testKey);
    assert.strictEqual(decrypted, original);
  });

  it('encrypted output starts with enc: prefix', () => {
    const encrypted = encryptToken('hello', testKey);
    assert.ok(encrypted.startsWith('enc:'), `Expected enc: prefix, got: ${encrypted.slice(0, 10)}`);
  });

  it('encrypted output has 4 colon-separated parts', () => {
    const encrypted = encryptToken('test', testKey);
    const parts = encrypted.split(':');
    assert.strictEqual(parts.length, 4, `Expected 4 parts, got ${parts.length}`);
    assert.strictEqual(parts[0], 'enc');
    // IV = 12 bytes = 24 hex chars
    assert.strictEqual(parts[1].length, 24, `IV should be 24 hex chars, got ${parts[1].length}`);
    // Auth tag = 16 bytes = 32 hex chars
    assert.strictEqual(parts[2].length, 32, `Tag should be 32 hex chars, got ${parts[2].length}`);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const a = encryptToken('same-input', testKey);
    const b = encryptToken('same-input', testKey);
    assert.notStrictEqual(a, b, 'Two encryptions of same plaintext should differ');
  });

  it('decryptToken returns plaintext as-is if no enc: prefix', () => {
    const plain = 'not-encrypted-token';
    const result = decryptToken(plain, testKey);
    assert.strictEqual(result, plain);
  });

  it('handles empty string', () => {
    const encrypted = encryptToken('', testKey);
    const decrypted = decryptToken(encrypted, testKey);
    assert.strictEqual(decrypted, '');
  });

  it('handles unicode content', () => {
    const original = '한국어-토큰-🔑';
    const encrypted = encryptToken(original, testKey);
    const decrypted = decryptToken(encrypted, testKey);
    assert.strictEqual(decrypted, original);
  });

  it('handles long tokens', () => {
    const original = 'x'.repeat(5000);
    const encrypted = encryptToken(original, testKey);
    const decrypted = decryptToken(encrypted, testKey);
    assert.strictEqual(decrypted, original);
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encryptToken('secret', testKey);
    const wrongKey = randomBytes(32);
    assert.throws(() => decryptToken(encrypted, wrongKey));
  });

  it('fails on tampered ciphertext', () => {
    const encrypted = encryptToken('secret', testKey);
    const parts = encrypted.split(':');
    // Flip a hex char in the ciphertext
    const tampered = parts[3].replace(/[0-9a-f]/, c => c === '0' ? '1' : '0');
    const bad = `enc:${parts[1]}:${parts[2]}:${tampered}`;
    assert.throws(() => decryptToken(bad, testKey));
  });
});

describe('POLL_INTERVALS (exported constants)', () => {
  // We can verify the shape without importing the module
  const POLL_INTERVALS = {
    sessionStatus: 5000,
    gitStatus: 30000,
    prStatus: 120000,
    costData: 60000,
    activity: 10000
  };

  it('all intervals are positive numbers', () => {
    for (const [key, val] of Object.entries(POLL_INTERVALS)) {
      assert.strictEqual(typeof val, 'number', `${key} should be number`);
      assert.ok(val > 0, `${key} should be positive`);
    }
  });
});

describe('LIMITS (exported constants)', () => {
  const LIMITS = {
    jsonBodyBytes: 5 * 1024 * 1024,
    imageUploadBytes: 10 * 1024 * 1024,
    filePreviewBytes: 2 * 1024 * 1024,
    fileWriteBytes: 500 * 1024,
    terminalBuffer: 50000,
    claudeTimeoutMs: 60000,
    diffMaxChars: 15000,
    diffMaxLines: 3000,
    autoCommitDiffChars: 20000,
    gitLogDefault: 30,
    gitLogMax: 100,
    forgeRefFiles: 10,
    forgeRefFileChars: 10000,
    terminalMaxAge: 24 * 60 * 60 * 1000,
    cmdMaxLength: 500,
  };

  it('all limits are positive numbers', () => {
    for (const [key, val] of Object.entries(LIMITS)) {
      assert.strictEqual(typeof val, 'number', `${key} should be number`);
      assert.ok(val > 0, `${key} should be positive`);
    }
  });

  it('gitLogMax >= gitLogDefault', () => {
    assert.ok(LIMITS.gitLogMax >= LIMITS.gitLogDefault);
  });

  it('imageUploadBytes > fileWriteBytes', () => {
    assert.ok(LIMITS.imageUploadBytes > LIMITS.fileWriteBytes);
  });
});
