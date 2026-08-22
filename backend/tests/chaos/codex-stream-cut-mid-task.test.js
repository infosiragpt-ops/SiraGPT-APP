'use strict';

/**
 * Chaos: the provider stream is CUT mid-task (mid-build).
 *
 * A fake OpenAI-compatible client emits real text deltas and then destroys
 * the async iterator without ever sending the terminal frame ([DONE]) — the
 * exact shape of a GCLB 30s cut / provider crash while the agent is writing
 * a file. The unit under test is codex/llm-provider.chatComplete (the same
 * call every agent step makes), and the contracts exercised are its REAL
 * production guarantees:
 *
 *   1. Fail-closed on partial output: once deltas reached the transcript,
 *      chatComplete must NOT failover to another rung (that would splice two
 *      different answers into one build) — it throws immediately, flagged
 *      with `partialResponse: true`.
 *   2. Clean cut BEFORE any delta: the error IS failover-able — the sick
 *      rung is quarantined for FAILOVER_TTL_MS and the next configured rung
 *      answers, so the step survives.
 *   3. Quarantine expiry is injectable (`now`): recovery is proven without
 *      sleeping the real TTL.
 *   4. When EVERY rung is cut, the caller still gets a rejection (first
 *      error) — the step fails loudly instead of hanging.
 *
 * Every await runs under a hard Promise.race watchdog so a regression can
 * never hang the suite. No network: all clients are injected fakes and the
 * anthropic rung is left unconfigured so the real SDK is never loaded.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const llmProvider = require('../../src/services/codex/llm-provider');
const { FAILOVER_TTL_MS } = llmProvider;

/** Hard settle deadline so a hung promise fails the test instead of stalling it. */
async function mustSettle(promise, label, ms = 1000) {
  let timer = null;
  try {
    const outcome = await Promise.race([
      promise.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms);
      }),
    ]);
    assert.equal(outcome.settled, true, `${label} left the caller's promise PENDING past ${ms}ms`);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fake OpenAI-compatible streaming client. `create()` returns an async
 * iterable that yields `chunks` and then either throws `dieWith` or just
 * ENDS early — a destroyed socket never delivers [DONE].
 */
function makeCutStreamClient({ chunks, dieWith = null }) {
  const calls = [];
  const deltasSeen = [];
  return {
    calls,
    deltasSeen,
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          async function* stream() {
            for (const chunk of chunks) {
              deltasSeen.push(chunk.choices?.[0]?.delta?.content || '');
              yield chunk;
            }
            if (dieWith) throw dieWith;
            // Cut shape: iterator ends without the terminal frame.
          }
          return stream();
        },
      },
    },
  };
}

const CHUNK = (text) => ({ id: 'gen-cut', choices: [{ delta: { content: text } }] });
// Two rungs, both mockable (anthropic deliberately unconfigured: loading the
// real @anthropic-ai/sdk would risk a real network call).
const ENV = { NODE_ENV: 'test', OPENROUTER_API_KEY: 'k-or', CEREBRAS_API_KEY: 'k-ce' };

describe('chaos: codex stream cut mid-task', () => {
  before(() => llmProvider.resetQuarantine());
  after(() => llmProvider.resetQuarantine());

  it('cut AFTER visible deltas fails closed: throws partialResponse, never splices a second provider', async () => {
    llmProvider.resetQuarantine();
    const healthy = makeCutStreamClient({ chunks: [CHUNK('respuesta completa del rung sano')] });
    const cut = makeCutStreamClient({
      chunks: [CHUNK('Voy a crear el'), CHUNK(' archivo index…')],
      dieWith: new Error('socket hang up'),
    });

    const transcript = [];
    const outcome = await mustSettle(llmProvider.chatComplete({
      messages: [{ role: 'user', content: 'build the app' }],
      env: ENV,
      onTextDelta: (delta) => { transcript.push(delta); }, // the agent-loop narrative sink
      clients: { openrouter: cut, cerebras: healthy },
    }), 'partial-delta cut');

    assert.equal(outcome.settled, true);
    assert.ok(outcome.error, 'a cut mid-answer must surface an error, not a silent success');
    assert.equal(outcome.error.partialResponse, true, 'emitted deltas must flag partialResponse');
    assert.match(outcome.error.message, /socket hang up/);
    // Fail-closed contract: the healthy rung must NOT be asked to "finish"
    // the half-written answer.
    assert.equal(healthy.calls.length, 0, 'no second answer may be spliced after visible deltas');
    // The deltas really streamed out before the cut.
    assert.deepEqual(cut.deltasSeen, ['Voy a crear el', ' archivo index…']);
  });

  it('cut BEFORE any delta quarantines the sick rung and the next rung answers (step survives)', async () => {
    llmProvider.resetQuarantine();
    const healthy = makeCutStreamClient({ chunks: [CHUNK('respuesta desde el rung sano')] });
    const silentCut = makeCutStreamClient({ chunks: [], dieWith: new Error('ECONNRESET upstream') });

    const transcript = [];
    const outcome = await mustSettle(llmProvider.chatComplete({
      messages: [{ role: 'user', content: 'build the app' }],
      env: ENV,
      onTextDelta: (delta) => { transcript.push(delta); },
      clients: { openrouter: silentCut, cerebras: healthy },
    }), 'silent cut');

    assert.equal(outcome.settled, true);
    assert.ok(!outcome.error, `failover should recover the step, got: ${outcome.error?.message}`);
    assert.equal(outcome.value.content, 'respuesta desde el rung sano');
    assert.equal(outcome.value.usage.provider, 'Cerebras');
    // The surviving rung's answer streamed through the normal delta sink.
    assert.deepEqual(transcript, ['respuesta desde el rung sano']);
    // The sick rung goes to the BACK of the ladder while quarantined.
    assert.deepEqual(
      llmProvider.resolveCandidates({ env: ENV }),
      ['cerebras', 'openrouter'],
      'the cut rung must be quarantined behind healthy ones',
    );
  });

  it('quarantine expires via injected now() — the healed rung serves again (no real sleep)', async () => {
    llmProvider.resetQuarantine();
    const healed = makeCutStreamClient({ chunks: [CHUNK('openrouter recuperado')] });
    const stillSick = makeCutStreamClient({ chunks: [], dieWith: new Error('boom') });

    // Fully-controlled clock so the quarantine deadline is deterministic.
    const t0 = 1_700_000_000_000;
    let clock = t0;
    const now = () => clock;

    // Trip the quarantine on openrouter (cerebras answers, step survives).
    const tripped = await mustSettle(llmProvider.chatComplete({
      messages: [{ role: 'user', content: 'u' }],
      env: ENV,
      now,
      onTextDelta: () => {},
      clients: { openrouter: stillSick, cerebras: makeCutStreamClient({ chunks: [CHUNK('cerebras ok')] }) },
    }), 'trip');
    assert.equal(tripped.value.content, 'cerebras ok');

    // Still inside the TTL window → the sick rung stays behind cerebras.
    clock = t0 + FAILOVER_TTL_MS - 1;
    assert.deepEqual(llmProvider.resolveCandidates({ env: ENV, now }), ['cerebras', 'openrouter']);

    // One tick past the TTL → the healed rung is back at the front…
    clock = t0 + FAILOVER_TTL_MS;
    assert.deepEqual(llmProvider.resolveCandidates({ env: ENV, now }), ['openrouter', 'cerebras']);
    // …and a successful call clears the quarantine entirely.
    const recovered = await mustSettle(llmProvider.chatComplete({
      messages: [{ role: 'user', content: 'u' }],
      env: ENV,
      now,
      onTextDelta: () => {},
      clients: { openrouter: healed },
    }), 'recovered call');
    assert.ok(!recovered.error);
    assert.equal(recovered.value.content, 'openrouter recuperado');
    assert.deepEqual(llmProvider.resolveCandidates({ env: ENV, now }), ['openrouter', 'cerebras']);
  });

  it('EVERY rung cut mid-stream-before-first-delta: the caller gets a rejection, never a hang', async () => {
    llmProvider.resetQuarantine();
    const cutOr = makeCutStreamClient({ chunks: [], dieWith: new Error('ECONNRESET openrouter') });
    const cutCe = makeCutStreamClient({ chunks: [], dieWith: new Error('ECONNRESET cerebras') });

    const outcome = await mustSettle(llmProvider.chatComplete({
      messages: [{ role: 'user', content: 'u' }],
      env: ENV,
      onTextDelta: () => {},
      clients: { openrouter: cutOr, cerebras: cutCe },
    }), 'all rungs cut');

    assert.equal(outcome.settled, true);
    assert.ok(outcome.error, 'with every provider cut the step must fail loudly');
    assert.match(outcome.error.message, /ECONNRESET openrouter/, 'the FIRST error is propagated');
    assert.equal(cutOr.calls.length, 1);
    assert.equal(cutCe.calls.length, 1);
  });
});
