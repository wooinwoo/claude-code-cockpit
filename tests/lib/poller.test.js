import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Poller } from '../../lib/poller.js';

describe('Poller', () => {
  let poller;

  beforeEach(() => {
    poller = new Poller();
  });

  afterEach(() => {
    poller.stop();
  });

  describe('constructor', () => {
    it('initializes with empty cache', () => {
      assert.strictEqual(poller.cache.size, 0);
    });

    it('initializes with empty sseClients', () => {
      assert.strictEqual(poller.sseClients.size, 0);
    });

    it('initializes with empty intervalMap', () => {
      assert.strictEqual(poller.intervalMap.size, 0);
    });

    it('initializes with speed multiplier 1', () => {
      assert.strictEqual(poller._speedMultiplier, 1);
    });

    it('initializes with empty errorCounts', () => {
      assert.strictEqual(poller.errorCounts.size, 0);
    });
  });

  describe('getCached', () => {
    it('returns null for unknown key', () => {
      assert.strictEqual(poller.getCached('unknown'), null);
    });

    it('returns data for cached key', () => {
      poller.cache.set('test', { data: { value: 42 }, raw: '{"value":42}', timestamp: Date.now(), ttl: 10000 });
      assert.deepStrictEqual(poller.getCached('test'), { value: 42 });
    });
  });

  describe('getAllCached', () => {
    it('returns empty object when no matches', () => {
      assert.deepStrictEqual(poller.getAllCached('proj:'), {});
    });

    it('returns matching entries with prefix stripped', () => {
      poller.cache.set('proj:abc', { data: { id: 'abc' } });
      poller.cache.set('proj:def', { data: { id: 'def' } });
      poller.cache.set('other:xyz', { data: { id: 'xyz' } });

      const result = poller.getAllCached('proj:');
      assert.deepStrictEqual(result, { abc: { id: 'abc' }, def: { id: 'def' } });
    });

    it('does not return non-matching prefixes', () => {
      poller.cache.set('other:xyz', { data: { id: 'xyz' } });
      const result = poller.getAllCached('proj:');
      assert.strictEqual(Object.keys(result).length, 0);
    });
  });

  describe('setSpeed', () => {
    it('sets speed multiplier', () => {
      poller.setSpeed(3);
      assert.strictEqual(poller._speedMultiplier, 3);
    });

    it('clamps minimum to 1', () => {
      poller.setSpeed(0.5);
      assert.strictEqual(poller._speedMultiplier, 1);
    });

    it('clamps maximum to 10', () => {
      poller.setSpeed(20);
      assert.strictEqual(poller._speedMultiplier, 10);
    });

    it('accepts exact boundary value 1', () => {
      poller.setSpeed(1);
      assert.strictEqual(poller._speedMultiplier, 1);
    });

    it('accepts exact boundary value 10', () => {
      poller.setSpeed(10);
      assert.strictEqual(poller._speedMultiplier, 10);
    });
  });

  describe('broadcast', () => {
    it('formats SSE message correctly', () => {
      let written = '';
      const fakeRes = {
        writableEnded: false,
        destroyed: false,
        write(msg) { written = msg; }
      };
      poller.sseClients.add(fakeRes);

      poller.broadcast('test-event', { hello: 'world' });
      assert.strictEqual(written, 'event: test-event\ndata: {"hello":"world"}\n\n');
    });

    it('removes dead clients (writableEnded)', () => {
      const deadRes = { writableEnded: true, destroyed: false, write() {} };
      poller.sseClients.add(deadRes);
      assert.strictEqual(poller.sseClients.size, 1);

      poller.broadcast('evt', {});
      assert.strictEqual(poller.sseClients.size, 0);
    });

    it('removes dead clients (destroyed)', () => {
      const deadRes = { writableEnded: false, destroyed: true, write() {} };
      poller.sseClients.add(deadRes);

      poller.broadcast('evt', {});
      assert.strictEqual(poller.sseClients.size, 0);
    });

    it('removes clients that throw on write', () => {
      const badRes = {
        writableEnded: false, destroyed: false,
        write() { throw new Error('broken pipe'); }
      };
      poller.sseClients.add(badRes);

      poller.broadcast('evt', {});
      assert.strictEqual(poller.sseClients.size, 0);
    });

    it('writes to multiple live clients', () => {
      const messages = [];
      const mkRes = () => ({
        writableEnded: false, destroyed: false,
        write(msg) { messages.push(msg); }
      });
      poller.sseClients.add(mkRes());
      poller.sseClients.add(mkRes());

      poller.broadcast('evt', { x: 1 });
      assert.strictEqual(messages.length, 2);
    });
  });

  describe('addClient / removeClient', () => {
    it('adds a client to sseClients', () => {
      const res = {};
      poller.addClient(res);
      assert.strictEqual(poller.sseClients.size, 1);
    });

    it('removes a client from sseClients', () => {
      const res = {};
      poller.addClient(res);
      poller.removeClient(res);
      assert.strictEqual(poller.sseClients.size, 0);
    });

    it('evicts oldest client when limit (50) is reached', () => {
      const clients = [];
      for (let i = 0; i < 50; i++) {
        const c = { id: i, end() { this.ended = true; } };
        clients.push(c);
        poller.addClient(c);
      }
      assert.strictEqual(poller.sseClients.size, 50);

      const newClient = { id: 50, end() {} };
      poller.addClient(newClient);
      assert.strictEqual(poller.sseClients.size, 50);
      assert.strictEqual(clients[0].ended, true);
    });
  });

  describe('register / unregister', () => {
    it('register calls fetchFn immediately and caches result', async () => {
      const fetchFn = mock.fn(async () => ({ status: 'ok' }));
      poller.register('test', fetchFn, 60000, 'test-event');

      // Wait for immediate poll
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(fetchFn.mock.calls.length, 1);
      assert.deepStrictEqual(poller.getCached('test'), { status: 'ok' });
    });

    it('unregister clears cache and timers', async () => {
      poller.register('test', async () => ({}), 60000, 'evt');
      await new Promise(r => setTimeout(r, 50));

      poller.unregister('test');
      assert.strictEqual(poller.getCached('test'), null);
      assert.strictEqual(poller.intervalMap.has('test'), false);
      assert.strictEqual(poller.errorCounts.has('test'), false);
    });

    it('register resets error count on successful fetch', async () => {
      poller.errorCounts.set('test', 5);
      poller.register('test', async () => ({ ok: true }), 60000, 'evt');
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(poller.errorCounts.get('test'), 0);
    });

    it('register increments error count on fetch failure', async () => {
      poller.register('fail', async () => { throw new Error('network'); }, 60000, 'evt');
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(poller.errorCounts.get('fail'), 1);
    });
  });

  describe('stop', () => {
    it('clears all intervals', async () => {
      poller.register('a', async () => ({}), 60000, 'a');
      poller.register('b', async () => ({}), 60000, 'b');
      await new Promise(r => setTimeout(r, 50));

      poller.stop();
      assert.strictEqual(poller.intervalMap.size, 0);
    });
  });
});
