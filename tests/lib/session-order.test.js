import test from 'node:test';
import assert from 'node:assert/strict';

test('session order keeps live terminals, appends new ones, and persists reordering', async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  values.set('dl-terminal-pairs', '[{"termIds":["A","B"],"direction":"v"}]');
  const {
    app, getOrderedTerminalIds, getTerminalPair, getTerminalPairs, pairTerminals,
    remapTerminalOrder, remapTerminalPairs, setTerminalOrder, setTerminalPairDirection, unpairTerminal,
  } = await import(`../../js/state.js?session-order=${Date.now()}`);
  app.termMap = new Map([['A', {}], ['B', {}], ['C', {}]]);
  app.sessionOrder = ['C', 'missing', 'A'];

  assert.deepEqual(getOrderedTerminalIds(), ['C', 'A', 'B']);
  assert.deepEqual(getTerminalPair('A'), { termIds: ['A', 'B'], layout: 'rows', direction: 'v' });
  assert.deepEqual(setTerminalOrder(['B', 'B', 'A']), ['B', 'A', 'C']);
  assert.equal(values.get('dl-terminal-session-order'), '["B","A","C"]');

  assert.deepEqual(setTerminalPairDirection('A', 'h'), { termIds: ['B', 'A'], layout: 'cols', direction: 'h' });
  assert.deepEqual(pairTerminals('A', 'C'), { termIds: ['B', 'A', 'C'], layout: 'cols', direction: 'h' });
  assert.equal(unpairTerminal('B'), true);
  assert.deepEqual(getTerminalPairs(), [{ termIds: ['A', 'C'], layout: 'cols', direction: 'h' }]);
  assert.equal(unpairTerminal('C'), true);
  assert.deepEqual(getTerminalPairs(), []);
  assert.deepEqual(pairTerminals('C', 'A'), { termIds: ['A', 'C'], layout: 'cols', direction: 'h' });
  assert.equal(unpairTerminal('A'), true);

  app.termMap.delete('B');
  assert.deepEqual(getOrderedTerminalIds(), ['A', 'C']);

  app.sessionOrder = ['old-C', 'old-A'];
  assert.deepEqual(remapTerminalOrder({ 'old-A': 'new-A', 'old-C': 'new-C' }), ['new-C', 'new-A']);
  assert.equal(values.get('dl-terminal-session-order'), '["new-C","new-A"]');

  app.terminalPairs = [{ termIds: ['old-A', 'old-C'], direction: 'v' }];
  assert.deepEqual(remapTerminalPairs({ 'old-A': 'new-A', 'old-C': 'new-C' }), [{ termIds: ['new-A', 'new-C'], layout: 'rows', direction: 'v' }]);
  assert.equal(values.get('dl-terminal-pairs'), '[{"termIds":["new-A","new-C"],"layout":"rows","direction":"v"}]');
});

test('terminal groups can grow beyond a pair without an arbitrary member cap', async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const { app, pairTerminals } = await import(`../../js/state.js?terminal-group=${Date.now()}`);
  app.termMap = new Map(['A', 'B', 'C', 'D', 'E'].map(id => [id, {}]));
  app.sessionOrder = ['A', 'B', 'C', 'D', 'E'];

  pairTerminals('A', 'B');
  pairTerminals('A', 'C');
  pairTerminals('A', 'D');
  assert.deepEqual(pairTerminals('A', 'E').termIds, ['A', 'B', 'C', 'D', 'E']);
});

test('reading pairs with an empty termMap must not wipe stored groups (server restart window)', async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  values.set('dl-terminal-pairs', '[{"termIds":["old-A","old-B"],"direction":"v"}]');
  const { app, getTerminalPairs, remapTerminalPairs } = await import(`../../js/state.js?restart-window=${Date.now()}`);

  // 페이지 로드 직후 — WS 'terminals' 메시지 도착 전, termMap은 비어 있음
  app.termMap = new Map();
  app.sessionOrder = ['old-A', 'old-B'];
  assert.deepEqual(getTerminalPairs(), []);

  // 읽기 접근이 저장본을 훼손하지 않아야 함
  assert.equal(values.get('dl-terminal-pairs'), '[{"termIds":["old-A","old-B"],"direction":"v"}]');

  // 서버 재시작 복원 — 새 termId로 remap하면 저장된 그룹이 살아나야 함
  remapTerminalPairs({ 'old-A': 'new-A', 'old-B': 'new-B' });
  app.termMap = new Map([['new-A', {}], ['new-B', {}]]);
  assert.deepEqual(getTerminalPairs(), [{ termIds: ['new-A', 'new-B'], layout: 'rows', direction: 'v' }]);
});
