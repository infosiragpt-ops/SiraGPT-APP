'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/services/agents/misunderstanding-signals');

// Ensure tests start with a clean global buffer.
test.beforeEach(() => M._clearAllForTests());

// ─── detectRegenerateAfterTokens ─────────────────────────────────────

test('regen: positive when regenerate=true and tokens > threshold', () => {
  assert.equal(M.detectRegenerateAfterTokens({ regenerate: true, tokensGenerated: 200 }), true);
});

test('regen: negative when regenerate=false', () => {
  assert.equal(M.detectRegenerateAfterTokens({ regenerate: false, tokensGenerated: 1000 }), false);
});

test('regen: negative when below threshold', () => {
  assert.equal(M.detectRegenerateAfterTokens({ regenerate: true, tokensGenerated: 10, threshold: 50 }), false);
});

test('regen: respects custom threshold', () => {
  assert.equal(M.detectRegenerateAfterTokens({ regenerate: true, tokensGenerated: 30, threshold: 20 }), true);
});

test('regen: handles missing tokensGenerated', () => {
  assert.equal(M.detectRegenerateAfterTokens({ regenerate: true }), false);
});

// ─── detectAbandonedStream ───────────────────────────────────────────

test('abandoned: positive when completed=false and tokens > 5', () => {
  assert.equal(M.detectAbandonedStream({ completed: false, tokensGenerated: 100 }), true);
});

test('abandoned: negative when completed=true', () => {
  assert.equal(M.detectAbandonedStream({ completed: true, tokensGenerated: 100 }), false);
});

test('abandoned: negative when too few tokens (likely initial disconnect)', () => {
  assert.equal(M.detectAbandonedStream({ completed: false, tokensGenerated: 3 }), false);
});

test('abandoned: undefined completed is not enough to flag', () => {
  // Sólo `completed === false` cuenta; undefined no.
  assert.equal(M.detectAbandonedStream({ completed: undefined, tokensGenerated: 100 }), false);
});

// ─── detectCorrectionFollowup ────────────────────────────────────────

test('correction: spanish "no, en español"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'no, en español por favor' }), true);
});

test('correction: spanish "eso no es lo que quería"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'eso no es lo que quería' }), true);
});

test('correction: spanish "no es eso"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'no es eso lo que pedí' }), true);
});

test('correction: spanish "me refería a"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'me refería a la versión anterior' }), true);
});

test('correction: english "that\'s not what I meant"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: "that's not what I wanted" }), true);
});

test('correction: english "in spanish"', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'in spanish please' }), true);
});

test('correction: negative on regular follow-up', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'puedes ampliar el segundo punto?' }), false);
});

test('correction: negative on greeting', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: 'hola' }), false);
});

test('correction: negative on empty', () => {
  assert.equal(M.detectCorrectionFollowup({ currentPrompt: '' }), false);
  assert.equal(M.detectCorrectionFollowup({}), false);
});

// ─── detectNegativeFeedbackWindow ────────────────────────────────────

test('neg-feedback: positive when disliked within window', () => {
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'disliked', msSinceResponse: 30_000 }), true);
});

test('neg-feedback: negative when liked', () => {
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'liked', msSinceResponse: 30_000 }), false);
});

test('neg-feedback: negative when outside window', () => {
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'disliked', msSinceResponse: 120_000 }), false);
});

test('neg-feedback: handles custom window', () => {
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'disliked', msSinceResponse: 90_000, windowMs: 120_000 }), true);
});

test('neg-feedback: negative when invalid elapsed', () => {
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'disliked', msSinceResponse: -10 }), false);
  assert.equal(M.detectNegativeFeedbackWindow({ feedback: 'disliked', msSinceResponse: NaN }), false);
});

// ─── detectManualPromptEdit ──────────────────────────────────────────

test('manual-edit: positive when prompts highly similar within window', () => {
  // Jaccard >= 0.7
  assert.equal(
    M.detectManualPromptEdit({
      currentPrompt: 'genera informe marketing digital 2026',
      previousPrompt: 'genera informe marketing digital',
      msSincePrevious: 10_000,
    }),
    true,
  );
});

test('manual-edit: negative when too different (low Jaccard)', () => {
  assert.equal(
    M.detectManualPromptEdit({
      currentPrompt: 'traduce este texto al inglés',
      previousPrompt: 'genera un gráfico de barras',
      msSincePrevious: 10_000,
    }),
    false,
  );
});

test('manual-edit: negative when outside window', () => {
  assert.equal(
    M.detectManualPromptEdit({
      currentPrompt: 'a b c d e',
      previousPrompt: 'a b c d e f',
      msSincePrevious: 120_000,
    }),
    false,
  );
});

test('manual-edit: uses explicit similarity when provided (overrides Jaccard)', () => {
  // Mismas palabras Jaccard high pero similarity bajo desactiva
  assert.equal(
    M.detectManualPromptEdit({
      currentPrompt: 'foo bar baz',
      previousPrompt: 'foo bar baz',
      msSincePrevious: 5_000,
      similarity: 0.2,
    }),
    false,
  );
});

test('manual-edit: respects custom threshold', () => {
  // Jaccard ~0.5 con threshold 0.5
  assert.equal(
    M.detectManualPromptEdit({
      currentPrompt: 'hola mundo foo bar',
      previousPrompt: 'hola mundo foo baz',
      msSincePrevious: 5_000,
      similarityThreshold: 0.5,
    }),
    true,
  );
});

test('jaccardWords: identical sets → 1', () => {
  assert.equal(M.jaccardWords('hola mundo', 'hola mundo'), 1);
});

test('jaccardWords: disjoint sets → 0', () => {
  assert.equal(M.jaccardWords('uno dos tres', 'cuatro cinco seis'), 0);
});

test('jaccardWords: case + accent insensitive', () => {
  const j = M.jaccardWords('Niño Pájaro', 'nino pajaro');
  assert.ok(j >= 0.9, `expected near-1, got ${j}`);
});

// ─── recordSignal + ring buffer ──────────────────────────────────────

test('record: stores signal in buffer', () => {
  M.recordSignal({ signal: 'correction_followup', userId: 'u1', payload: { x: 1 } });
  const recent = M.getRecentMisunderstandings({ userId: 'u1' });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].signal, 'correction_followup');
});

test('record: rejects unknown signal type', () => {
  const ok = M.recordSignal({ signal: 'totally_made_up', userId: 'u1' });
  assert.equal(ok, false);
  assert.equal(M.getRecentMisunderstandings({ userId: 'u1' }).length, 0);
});

test('record: caps buffer at MAX per user', () => {
  for (let i = 0; i < M.MAX_SIGNALS_PER_USER + 10; i++) {
    M.recordSignal({ signal: 'correction_followup', userId: 'u1' });
  }
  const recent = M.getRecentMisunderstandings({ userId: 'u1' });
  assert.equal(recent.length, M.MAX_SIGNALS_PER_USER);
});

test('record: window filters out old entries', () => {
  M.recordSignal({ signal: 'correction_followup', userId: 'u1' });
  // Backdate the entry
  const buf = M._userBuffers.get('u1');
  buf[0].ts = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
  const recent = M.getRecentMisunderstandings({ userId: 'u1', windowMs: 7 * 24 * 60 * 60 * 1000 });
  assert.equal(recent.length, 0);
});

test('record: handles missing userId gracefully', () => {
  // No throw, no entry created.
  M.recordSignal({ signal: 'correction_followup' });
  assert.equal(M._userBuffers.size, 0);
});

// ─── recordFromContext ────────────────────────────────────────────────

test('context: records multiple signals from single context', () => {
  const recorded = M.recordFromContext({
    userId: 'u1',
    regenerate: true,
    tokensGenerated: 500,
    completed: true,
    currentPrompt: 'no, en español por favor',
  });
  assert.deepEqual(recorded.sort(), ['correction_followup', 'regenerate_after_n_tokens'].sort());
});

test('context: clean turn produces no signals', () => {
  const recorded = M.recordFromContext({
    userId: 'u1',
    regenerate: false,
    tokensGenerated: 500,
    completed: true,
    currentPrompt: 'explica los embeddings',
  });
  assert.deepEqual(recorded, []);
});

test('context: detects negative feedback', () => {
  const recorded = M.recordFromContext({
    userId: 'u1',
    feedback: 'disliked',
    msSinceResponse: 20_000,
  });
  assert.ok(recorded.includes('negative_feedback_in_60s'));
});

test('context: detects manual edit with similarity', () => {
  const recorded = M.recordFromContext({
    userId: 'u1',
    currentPrompt: 'genera informe marketing digital',
    previousPrompt: 'genera informe marketing digital ahora',
    msSincePrevious: 5_000,
  });
  assert.ok(recorded.includes('manual_prompt_edit'));
});

// ─── aggregateByUser / globalSnapshot ─────────────────────────────────

test('aggregate: counts by signal type', () => {
  M.recordSignal({ signal: 'correction_followup', userId: 'u1' });
  M.recordSignal({ signal: 'correction_followup', userId: 'u1' });
  M.recordSignal({ signal: 'regenerate_after_n_tokens', userId: 'u1' });
  const agg = M.aggregateByUser('u1', 60_000);
  assert.equal(agg.total, 3);
  assert.equal(agg.byType.correction_followup, 2);
  assert.equal(agg.byType.regenerate_after_n_tokens, 1);
});

test('aggregate: returns 0 totals for unknown user', () => {
  const agg = M.aggregateByUser('ghost', 60_000);
  assert.equal(agg.total, 0);
  assert.equal(Object.keys(agg.byType).length, 0);
});

test('snapshot: lists users sorted by signal count', () => {
  for (let i = 0; i < 3; i++) M.recordSignal({ signal: 'correction_followup', userId: 'noisy' });
  M.recordSignal({ signal: 'correction_followup', userId: 'quiet' });
  const snap = M.globalSnapshot();
  assert.equal(snap[0].userId, 'noisy');
  assert.equal(snap[0].signals, 3);
});

// ─── Langfuse sink ────────────────────────────────────────────────────

test('langfuse sink: scoreTrace called with traceId', () => {
  const calls = [];
  M.setLangfuseSink({ scoreTrace: (traceId, payload) => calls.push({ traceId, payload }) });
  M.recordSignal({ signal: 'correction_followup', userId: 'u1', traceId: 'trace-xyz' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].traceId, 'trace-xyz');
  assert.equal(calls[0].payload.name, 'misunderstanding.correction_followup');
  M.setLangfuseSink(null);
});

test('langfuse sink: swallows errors', () => {
  M.setLangfuseSink({ scoreTrace: () => { throw new Error('langfuse down'); } });
  // Should not throw
  assert.doesNotThrow(() => M.recordSignal({ signal: 'correction_followup', userId: 'u1', traceId: 't' }));
  M.setLangfuseSink(null);
});

test('langfuse sink: skipped when no traceId provided', () => {
  const calls = [];
  M.setLangfuseSink({ scoreTrace: (traceId, payload) => calls.push({ traceId, payload }) });
  M.recordSignal({ signal: 'correction_followup', userId: 'u1' });
  assert.equal(calls.length, 0);
  M.setLangfuseSink(null);
});
