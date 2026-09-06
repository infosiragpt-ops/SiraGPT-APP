import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { calculateAttemptBudget } from '../src/modules/doc-sandbox/queue/attempt-budget';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Pure policy inputs only. No simulated repository, storage, validator, engine,
// clock or SDK; these assertions do not claim durable quota/ledger enforcement.
const limits = Object.freeze({ maxTokens: 1000, maxTurns: 20 });
const unused = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0, costExact: true });
const snapshot = (overrides: Partial<Parameters<typeof calculateAttemptBudget>[0]> = {}) => ({
  usage: {}, costReservations: [], maxCostUsd: '5.00000000', costUsd: '0.00000000',
  tokenBudget: 1000, ...overrides,
});
const isQuota = (error: unknown): boolean => error instanceof DocSandboxError
  && error.code === 'E_QUOTA' && error.status === 429;

test('first attempt receives the admitted budget and an exact empty usage baseline', () => {
  assert.deepEqual(calculateAttemptBudget(snapshot(), limits), {
    baseUsage: unused, previousTurns: 0, remainingUsd: 5, remainingTokens: 1000, remainingTurns: 20,
  });
});

test('resume subtracts every token category, prior turns, paid cost and pending reservations', () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10,
    costUsd: 1, costExact: false, turns: 3 };
  const result = calculateAttemptBudget(snapshot({ usage, costUsd: '1.25000000', costReservations: [
    { reservedUsd: '0.50000000', actualUsd: null },
    { reservedUsd: '0.25000000', actualUsd: null },
    { reservedUsd: '4.00000000', actualUsd: '1.25000000' },
  ] }), limits);
  assert.deepEqual(result, { baseUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20,
    cacheWriteTokens: 10, costUsd: 1, costExact: false }, previousTurns: 3,
    remainingUsd: 3, remainingTokens: 820, remainingTurns: 17 });
});

test('effective token limit is the smaller of the admitted and current processor limits', () => {
  const usage = { ...unused, inputTokens: 100 };
  for (const [admitted, configured, remaining] of [[700, 1000, 600], [1000, 700, 600], [700, 700, 600]]) {
    assert.equal(calculateAttemptBudget(snapshot({ usage, tokenBudget: admitted! }),
      { ...limits, maxTokens: configured! }).remainingTokens, remaining);
  }
});

test('settled reservations, including zero-cost settlement, are not double charged', () => {
  assert.equal(calculateAttemptBudget(snapshot({ costUsd: '1.50000000', costReservations: [
    { reservedUsd: '4.00000000', actualUsd: '0.00000000' },
    { reservedUsd: '4.00000000', actualUsd: '1.50000000' },
  ] }), limits).remainingUsd, 3.5);
});

test('reservations remain charged across attempts without an attempt-specific filter', () => {
  const costReservations = Object.freeze([
    Object.freeze({ requestId: 'earlier-attempt', attempt: 1, reservedUsd: '2.00000000', actualUsd: null }),
    Object.freeze({ requestId: 'current-attempt', attempt: 2, reservedUsd: '0.50000000', actualUsd: null }),
  ]);
  assert.equal(calculateAttemptBudget(snapshot({ costReservations }), limits).remainingUsd, 2.5);
});

test('decimal subtraction preserves existing Number arithmetic without new rounding policy', () => {
  const result = calculateAttemptBudget(snapshot({ maxCostUsd: '0.30000000', costUsd: '0.10000000',
    costReservations: [{ reservedUsd: '0.10000000', actualUsd: null }] }), limits);
  assert.equal(result.remainingUsd, 0.3 - 0.1 - 0.1);
  assert.notEqual(result.remainingUsd, 0.1);
  assert.equal(calculateAttemptBudget(snapshot({ maxCostUsd: '0.00000001' }), limits).remainingUsd, 0.00000001);
});

test('zero or negative remaining money rejects with the existing quota error and status', () => {
  for (const input of [snapshot({ maxCostUsd: '0' }), snapshot({ costUsd: '5' }), snapshot({ costUsd: '6' }),
    snapshot({ costUsd: '3', costReservations: [{ reservedUsd: '2', actualUsd: null }] }),
    snapshot({ costReservations: [{ reservedUsd: '6', actualUsd: null }] })]) {
    assert.throws(() => calculateAttemptBudget(input, limits), isQuota);
  }
});

test('cache token consumption alone can exhaust the token budget', () => {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    for (const consumed of [1000, 1001]) {
      assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, [field]: consumed } }), limits), isQuota);
    }
  }
  assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, inputTokens: 300,
    outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 200 } }), limits), isQuota);
});

test('a smaller admitted budget is exhausted even when processor limits have headroom', () => {
  assert.throws(() => calculateAttemptBudget(snapshot({ tokenBudget: 100,
    usage: { ...unused, inputTokens: 100 } }), limits), isQuota);
});

test('previous successful turns consume the same fixed budget across retries', () => {
  for (const turns of [0, 1, 19]) {
    const result = calculateAttemptBudget(snapshot({ usage: { ...unused, turns } }), limits);
    assert.equal(result.previousTurns, turns);
    assert.equal(result.remainingTurns, 20 - turns);
  }
  for (const turns of [20, 21, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, turns } }), limits), isQuota);
  }
});

test('legacy absent or invalid turn metadata keeps the existing zero-turn fallback', () => {
  // Behavior-preserving extraction, not a new validation policy for historical
  // metadata. The usage counters themselves still pass the schema below.
  for (const turns of [undefined, null, '3', false, {}, [], -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = calculateAttemptBudget(snapshot({ usage: { ...unused, turns } }), limits);
    assert.equal(result.previousTurns, 0);
    assert.equal(result.remainingTurns, 20);
  }
});

test('unknown historical cost refuses a new attempt even if monetary headroom is positive', () => {
  for (const costExact of [false, true]) {
    assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, costUsd: null, costExact } }), limits), isQuota);
  }
});

test('known estimated historical cost remains allowed and keeps its exactness flag', () => {
  const result = calculateAttemptBudget(snapshot({ usage: { ...unused, costUsd: 2, costExact: false }, costUsd: '2' }), limits);
  assert.equal(result.baseUsage.costExact, false);
  assert.equal(result.baseUsage.costUsd, 2);
  assert.equal(result.remainingUsd, 3);
});

test('nonempty incomplete usage retains a schema error instead of silently resetting quotas', () => {
  for (const usage of [{ turns: 3 }, { ...unused, inputTokens: undefined }, { ...unused, costExact: undefined }]) {
    assert.throws(() => calculateAttemptBudget(snapshot({ usage }), limits), ZodError);
  }
});

test('invalid historical token counters retain the schema error type', () => {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, '12', null]) {
      assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, [field]: value } }), limits), ZodError);
    }
  }
});

test('invalid usage money and cost exactness retain schema validation before quota arithmetic', () => {
  for (const costUsd of [-1, NaN, Infinity, '1']) {
    assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, costUsd }, maxCostUsd: '0' }), limits), ZodError);
  }
  for (const costExact of [null, 'false', 0]) {
    assert.throws(() => calculateAttemptBudget(snapshot({ usage: { ...unused, costExact } }), limits), ZodError);
  }
});

test('calculation neither mutates durable inputs nor shares its parsed usage object', () => {
  const usage = Object.freeze({ ...unused, inputTokens: 25, turns: 2, extraMetadata: 'preserve in caller' });
  const input = Object.freeze(snapshot({ usage, costReservations: Object.freeze([
    Object.freeze({ reservedUsd: '1', actualUsd: null }),
  ]) }));
  const before = structuredClone(input);
  const result = calculateAttemptBudget(input, limits);
  assert.deepEqual(input, before);
  assert.notEqual(result.baseUsage, usage);
  assert.equal(Object.hasOwn(result.baseUsage, 'turns'), false);
  assert.equal(Object.hasOwn(result.baseUsage, 'extraMetadata'), false);
  result.baseUsage.inputTokens = 900;
  assert.equal(input.usage.inputTokens, 25);
  assert.equal(calculateAttemptBudget(input, limits).baseUsage.inputTokens, 25);
});

test('empty usage defaults are freshly allocated for each attempt', () => {
  const first = calculateAttemptBudget(snapshot(), limits);
  first.baseUsage.costUsd = null;
  assert.deepEqual(calculateAttemptBudget(snapshot(), limits).baseUsage, unused);
});
