'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routingFeedback = require('../src/services/routing-feedback');
const routingBridge = require('../src/services/rlhf/routing-bridge');
const metrics = require('../src/services/rlhf/metrics');
const { PROVIDER_FAIL_MESSAGE } = require('../src/services/ai/generate-sse-close');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('provider_failure and ttfb_abort are first-class negatives in routing-feedback', () => {
  routingFeedback.reset();
  for (let i = 0; i < 6; i += 1) {
    routingFeedback.recordOutcome({ intent: 'chat', difficulty: 'medium', model: 'grok-4.6', outcome: 'provider_failure' });
  }
  assert.ok(routingFeedback.penaltyFor({ intent: 'chat', difficulty: 'medium', model: 'grok-4.6' }) > 0);
  routingFeedback.reset();
  for (let i = 0; i < 6; i += 1) {
    routingFeedback.recordOutcome({ intent: 'chat', difficulty: 'medium', model: 'slow', outcome: 'ttfb_abort' });
  }
  assert.ok(routingFeedback.penaltyFor({ intent: 'chat', difficulty: 'medium', model: 'slow' }) > 0);
  routingFeedback.reset();
});

test('routing bridge maps generate failure codes to implicit outcomes and counts them', () => {
  routingFeedback.reset();
  metrics.reset();
  const a = routingBridge.recordFromProviderFailure({
    code: 'connection_unavailable', model: 'grok-4.6', intent: 'chat', difficulty: { bucket: 'medium' },
  });
  assert.deepEqual(a, { recorded: true, outcome: 'provider_failure' });
  const b = routingBridge.recordFromProviderFailure({ code: 'ttfb_abort', model: 'grok-4.6', intent: 'chat', difficulty: 'medium' });
  assert.deepEqual(b, { recorded: true, outcome: 'ttfb_abort' });
  const c = routingBridge.recordFromProviderFailure({ code: 'provider_fallback', model: 'x', intent: 'chat' });
  assert.equal(c.outcome, 'provider_failure');
  const stats = routingFeedback.getStats('chat', 'medium', 'grok-4.6');
  assert.equal(stats.attempts, 2);
  assert.equal(stats.negatives, 2);
  // No model → nothing to attribute, but the counter still sees the failure.
  const none = routingBridge.recordFromProviderFailure({ code: 'connection_unavailable' });
  assert.equal(none.recorded, false);
  assert.equal(none.outcome, 'provider_failure');
  assert.doesNotThrow(() => routingBridge.recordFromProviderFailure(null));
  const snap = metrics.snapshot();
  assert.equal(snap.implicit.total, 5);
  assert.equal(snap.implicit.byKind.provider_failure, 4);
  assert.equal(snap.implicit.byKind.ttfb_abort, 1);
  assert.equal(snap.implicit.byCode.connection_unavailable, 2);
  assert.equal(snap.implicit.lastCode, 'provider_failure');
  const prom = metrics.toPrometheusText();
  assert.match(prom, /sira_rlhf_implicit_signals_total 5/);
  assert.match(prom, /sira_rlhf_implicit_signal_kind\{kind="ttfb_abort"\} 1/);
  assert.match(prom, /sira_rlhf_implicit_signal_code\{code="connection_unavailable"\} 2/);
  routingFeedback.reset();
  metrics.reset();
});

test('generateStream reports a pinned-model empty completion through onProviderFailure', async () => {
  const service = require('../src/services/ai-service');
  const prevKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  const frames = [];
  const failures = [];
  const emptyStream = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { reasoning_content: 'pensando…' } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          },
        }),
      },
    },
  };
  try {
    const out = await service.generateStream({
      provider: 'xAI',
      model: 'grok-4.6',
      client: emptyStream,
      messages: [{ role: 'user', content: 'dame la web en local' }],
      res: { write: (chunk) => { frames.push(String(chunk)); return true; } },
      qualityGuard: false,
      skipDoneSentinel: true,
      onProviderFailure: (info) => failures.push(info),
    });
    // #716 classifies EMPTY_COMPLETION as E_PROVIDER (not bare «Conexión»).
    // #717 still records the implicit RLHF signal with that classified code.
    assert.equal(out, PROVIDER_FAIL_MESSAGE);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'E_PROVIDER');
    assert.equal(failures[0].provider, 'xAI');
    assert.equal(failures[0].model, 'grok-4.6');
    assert.equal(failures[0].reason, 'EMPTY_COMPLETION');
    assert.equal(failures[0].partial, false);
    assert.match(frames.join('\n'), /E_PROVIDER/);
  } finally {
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;
  }
});

test('a throwing onProviderFailure never changes the user-facing outcome', async () => {
  const service = require('../src/services/ai-service');
  const prevKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  const failingClient = {
    chat: { completions: { create: async () => { const e = new Error('boom'); e.status = 503; throw e; } } },
  };
  try {
    const out = await service.generateStream({
      provider: 'xAI',
      model: 'grok-4.6',
      client: failingClient,
      messages: [{ role: 'user', content: 'hola' }],
      res: { write: () => true },
      qualityGuard: false,
      skipDoneSentinel: true,
      onProviderFailure: () => { throw new Error('telemetry down'); },
    });
    assert.equal(out, PROVIDER_FAIL_MESSAGE);
  } finally {
    if (prevKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevKey;
  }
});

test('generate route feeds provider failures and TTFB aborts into the RLHF bridge', () => {
  const route = read('src/routes/ai.js');
  assert.match(route, /onProviderFailure: \(info\) =>/);
  assert.match(route, /recordFromProviderFailure\(\{/);
  assert.match(route, /__ttfbAbortedAt != null \? 'ttfb_abort'/);
  assert.match(route, /generateLog\.warn\('rlhf\.implicit_signal'/);
  const obs = read('src/services/ai/generate-request-observability.js');
  assert.match(obs, /'rlhf\.implicit_signal',/);
  const svc = read('src/services/ai-service.js');
  for (const code of ['partial_stream', 'provider_fallback']) {
    assert.match(svc, new RegExp(`reportProviderFailure\\('${code}'\\)`));
  }
  assert.match(svc, /reportProviderFailure\(error\)/);
});
