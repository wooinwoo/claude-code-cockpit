import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calcCost, aggregateEntries, PRICING, DEFAULT_PRICING } from '../../lib/cost-service.js';

describe('PRICING constants', () => {
  it('should have expected models', () => {
    assert.ok(PRICING['claude-opus-4-6']);
    assert.ok(PRICING['claude-opus-4-5-20251101']);
    assert.ok(PRICING['claude-sonnet-4-5-20250929']);
    assert.ok(PRICING['claude-haiku-4-5-20251001']);
  });

  it('should have all required price fields per model', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      assert.strictEqual(typeof p.input, 'number', `${model} missing input`);
      assert.strictEqual(typeof p.output, 'number', `${model} missing output`);
      assert.strictEqual(typeof p.cacheWrite, 'number', `${model} missing cacheWrite`);
      assert.strictEqual(typeof p.cacheRead, 'number', `${model} missing cacheRead`);
    }
  });

  it('DEFAULT_PRICING should match opus pricing', () => {
    const opus = PRICING['claude-opus-4-6'];
    assert.deepStrictEqual(DEFAULT_PRICING, opus);
  });
});

describe('calcCost', () => {
  it('should return 0 for zero usage', () => {
    const cost = calcCost('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    assert.strictEqual(cost, 0);
  });

  it('should return 0 for empty usage object', () => {
    const cost = calcCost('claude-opus-4-6', {});
    assert.strictEqual(cost, 0);
  });

  it('should calculate input token cost for opus', () => {
    // opus input: $15 per 1M tokens
    const cost = calcCost('claude-opus-4-6', { input_tokens: 1_000_000 });
    assert.strictEqual(cost, 15);
  });

  it('should calculate output token cost for opus', () => {
    // opus output: $75 per 1M tokens
    const cost = calcCost('claude-opus-4-6', { output_tokens: 1_000_000 });
    assert.strictEqual(cost, 75);
  });

  it('should calculate cache write cost for opus', () => {
    // opus cacheWrite: $18.75 per 1M tokens
    const cost = calcCost('claude-opus-4-6', { cache_creation_input_tokens: 1_000_000 });
    assert.strictEqual(cost, 18.75);
  });

  it('should calculate cache read cost for opus', () => {
    // opus cacheRead: $1.5 per 1M tokens
    const cost = calcCost('claude-opus-4-6', { cache_read_input_tokens: 1_000_000 });
    assert.strictEqual(cost, 1.5);
  });

  it('should sum all token types correctly', () => {
    const cost = calcCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    // 15 + 75 + 18.75 + 1.5 = 110.25
    assert.strictEqual(cost, 110.25);
  });

  it('should use sonnet pricing for sonnet model', () => {
    // sonnet: input=3, output=15, cacheWrite=3.75, cacheRead=0.3
    const cost = calcCost('claude-sonnet-4-5-20250929', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    assert.strictEqual(cost, 3 + 15);
  });

  it('should use haiku pricing for haiku model', () => {
    // haiku: input=0.8, output=4, cacheWrite=1, cacheRead=0.08
    const cost = calcCost('claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    assert.strictEqual(cost, 0.8 + 4 + 1 + 0.08);
  });

  it('should fall back to DEFAULT_PRICING for unknown model', () => {
    const cost = calcCost('unknown-model-xyz', { output_tokens: 1_000_000 });
    // DEFAULT_PRICING output = 75
    assert.strictEqual(cost, 75);
  });

  it('should handle fractional token counts', () => {
    // 500 input tokens on opus: 500 / 1M * 15 = 0.0075
    const cost = calcCost('claude-opus-4-6', { input_tokens: 500 });
    assert.strictEqual(cost, 0.0075);
  });

  it('should handle missing usage fields gracefully', () => {
    const cost = calcCost('claude-opus-4-6', { input_tokens: 1_000_000 });
    // Only input_tokens, rest default to 0
    assert.strictEqual(cost, 15);
  });

  it('should scale linearly with token count', () => {
    const cost1 = calcCost('claude-opus-4-6', { output_tokens: 100_000 });
    const cost2 = calcCost('claude-opus-4-6', { output_tokens: 200_000 });
    assert.strictEqual(cost2, cost1 * 2);
  });
});

describe('aggregateEntries', () => {
  it('should return empty map for no entries', () => {
    const result = aggregateEntries([]);
    assert.strictEqual(result.size, 0);
  });

  it('should group entries by date', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { input_tokens: 1000, output_tokens: 500 } },
      { date: '2026-03-02', model: 'claude-opus-4-6', usage: { input_tokens: 2000, output_tokens: 1000 } },
    ];
    const result = aggregateEntries(entries);
    assert.strictEqual(result.size, 2);
    assert.ok(result.has('2026-03-01'));
    assert.ok(result.has('2026-03-02'));
  });

  it('should sum tokens within the same date', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { input_tokens: 1000, output_tokens: 500 } },
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { input_tokens: 3000, output_tokens: 1500 } },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    assert.strictEqual(day.inputTokens, 4000);
    assert.strictEqual(day.outputTokens, 2000);
  });

  it('should sum cache tokens', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 200 } },
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { cache_read_input_tokens: 300, cache_creation_input_tokens: 400 } },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    assert.strictEqual(day.cacheRead, 400);
    assert.strictEqual(day.cacheWrite, 600);
  });

  it('should accumulate cost correctly', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { output_tokens: 1_000_000 } },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    assert.strictEqual(day.cost, 75); // opus output: $75/1M
  });

  it('should track model breakdowns', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { output_tokens: 1_000_000 } },
      { date: '2026-03-01', model: 'claude-haiku-4-5-20251001', usage: { output_tokens: 1_000_000 } },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    // model names have 'claude-' stripped and date suffix stripped
    assert.ok(day.models['opus-4-6']);
    assert.ok(day.models['haiku-4-5']);
    assert.strictEqual(day.models['opus-4-6'].outputTokens, 1_000_000);
    assert.strictEqual(day.models['haiku-4-5'].outputTokens, 1_000_000);
    assert.strictEqual(day.models['opus-4-6'].cost, 75);
    assert.strictEqual(day.models['haiku-4-5'].cost, 4);
  });

  it('should merge same model entries in model breakdown', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { output_tokens: 500_000 } },
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { output_tokens: 500_000 } },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    assert.strictEqual(day.models['opus-4-6'].outputTokens, 1_000_000);
    assert.strictEqual(day.models['opus-4-6'].cost, 75);
  });

  it('should handle entries with missing usage fields', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: {} },
    ];
    const result = aggregateEntries(entries);
    const day = result.get('2026-03-01');
    assert.strictEqual(day.cost, 0);
    assert.strictEqual(day.inputTokens, 0);
    assert.strictEqual(day.outputTokens, 0);
    assert.strictEqual(day.cacheRead, 0);
    assert.strictEqual(day.cacheWrite, 0);
  });

  it('should handle multiple dates with multiple models', () => {
    const entries = [
      { date: '2026-03-01', model: 'claude-opus-4-6', usage: { output_tokens: 100_000 } },
      { date: '2026-03-01', model: 'claude-sonnet-4-5-20250929', usage: { output_tokens: 200_000 } },
      { date: '2026-03-02', model: 'claude-haiku-4-5-20251001', usage: { output_tokens: 300_000 } },
    ];
    const result = aggregateEntries(entries);
    assert.strictEqual(result.size, 2);

    const day1 = result.get('2026-03-01');
    assert.strictEqual(day1.outputTokens, 300_000);
    // opus: 100k/1M * 75 = 7.5, sonnet: 200k/1M * 15 = 3.0
    const expectedCost1 = 7.5 + 3.0;
    assert.ok(Math.abs(day1.cost - expectedCost1) < 1e-10);

    const day2 = result.get('2026-03-02');
    assert.strictEqual(day2.outputTokens, 300_000);
    // haiku: 300k/1M * 4 = 1.2
    assert.ok(Math.abs(day2.cost - 1.2) < 1e-10);
  });
});
