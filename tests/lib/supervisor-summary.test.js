import { describe, it } from 'node:test';
import assert from 'node:assert';
import { summaryGate, beginSummary, endSummary, getSummaries, recordAgentEvent } from '../../lib/supervisor-service.js';

describe('supervisor summary gate', () => {
  it('첫 요약은 항상 허용', () => {
    assert.equal(summaryGate('t-first', 100), true);
  });

  it('pending 중에는 재호출 차단, 60초 지나면 재시도 허용', () => {
    const now = 1_000_000;
    beginSummary('t-pending', 100, now);
    assert.equal(summaryGate('t-pending', 200, now + 5_000), false);
    assert.equal(summaryGate('t-pending', 200, now + 61_000), true);
  });

  it('새 출력이 없으면(mark 동일) 차단', () => {
    const now = 1_000_000;
    beginSummary('t-same', 100, now);
    endSummary('t-same', '테스트 수정 중', now);
    assert.equal(summaryGate('t-same', 100, now + 120_000), false);
  });

  it('새 출력이 있어도 최소 간격(20초) 전에는 차단', () => {
    const now = 1_000_000;
    beginSummary('t-interval', 100, now);
    endSummary('t-interval', '빌드 중', now);
    assert.equal(summaryGate('t-interval', 200, now + 10_000), false);
    assert.equal(summaryGate('t-interval', 200, now + 21_000), true);
  });

  it('endSummary 가 null 이면 이전 요약 유지', () => {
    const now = 1_000_000;
    beginSummary('t-keep', 100, now);
    endSummary('t-keep', '리팩토링 중', now);
    beginSummary('t-keep', 200, now + 30_000);
    endSummary('t-keep', null, now + 31_000);
    assert.equal(getSummaries(now + 31_000)['t-keep'].text, '리팩토링 중');
  });

  it('30분 지난 요약은 getSummaries 에서 제거', () => {
    const now = 1_000_000;
    beginSummary('t-old', 100, now);
    endSummary('t-old', '옛날 작업 중', now);
    assert.ok(getSummaries(now)['t-old']);
    assert.equal(getSummaries(now + 31 * 60_000)['t-old'], undefined);
  });

  it('새 에이전트 세션은 같은 터미널의 이전 요약을 지운다', () => {
    const now = Date.now();
    beginSummary('t-reset', 100, now);
    endSummary('t-reset', '이전 작업 중', now);
    recordAgentEvent({ term_id: 't-reset', session_id: 's-reset', hook_event_name: 'SessionStart' });
    assert.equal(getSummaries()['t-reset'], undefined);
  });
});
