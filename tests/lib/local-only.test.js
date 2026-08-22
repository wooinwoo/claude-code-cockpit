import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_BIND_ADDRESS,
  isIgnoredBindRequest,
  isLoopbackAddress,
  isLoopbackHost,
  parseHostHeader,
  resolveBindAddress,
} from '../../lib/local-only.js';

describe('local-only network policy', () => {
  it('always binds to IPv4 loopback regardless of an environment override', () => {
    assert.equal(resolveBindAddress(), '127.0.0.1');
    assert.equal(resolveBindAddress('127.0.0.1'), '127.0.0.1');
    assert.equal(resolveBindAddress('0.0.0.0'), '127.0.0.1');
    assert.equal(resolveBindAddress('192.168.1.20'), '127.0.0.1');
    assert.equal(resolveBindAddress('100.64.0.8'), '127.0.0.1');
    assert.equal(resolveBindAddress('::'), '127.0.0.1');
    assert.equal(LOCAL_BIND_ADDRESS, '127.0.0.1');
  });

  it('reports obsolete bind overrides while accepting only the enforced value', () => {
    assert.equal(isIgnoredBindRequest(), false);
    assert.equal(isIgnoredBindRequest('127.0.0.1'), false);
    assert.equal(isIgnoredBindRequest('0.0.0.0'), true);
    assert.equal(isIgnoredBindRequest('localhost'), true);
  });

  it('accepts canonical loopback Host headers with optional ports', () => {
    for (const host of ['localhost', 'LOCALHOST:3847', '127.0.0.1:3847', '[::1]:3847', '::1']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it('rejects LAN, wildcard, Tailscale, DNS, forwarded, and malformed hosts', () => {
    for (const host of [
      '0.0.0.0:3847',
      '192.168.1.20:3847',
      '100.64.0.8:3847',
      'workstation.tail123.ts.net:3847',
      'example.com',
      'localhost.evil.test',
      'localhost:3847, example.com',
      'user@localhost:3847',
      '[::1]evil',
      '',
    ]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });

  it('returns null for malformed Host headers', () => {
    assert.equal(parseHostHeader('[::1'), null);
    assert.equal(parseHostHeader('localhost:not-a-port'), null);
    assert.equal(parseHostHeader(null), null);
  });

  it('accepts only loopback socket peer addresses', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of ['0.0.0.0', '192.168.1.20', '100.64.0.8', '::ffff:192.168.1.20', '']) {
      assert.equal(isLoopbackAddress(address), false, address);
    }
  });
});
