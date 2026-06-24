'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const fb = require('../src/services/routing-feedback');
const orch = require('../src/services/reasoning-orchestrator');

beforeEach(() => fb.reset());

describe('signatureFor', () => {
  test('canonical, lowercased, pipe-joined', () => {
    assert.equal(fb.signatureFor({ intent: 'Code', difficulty: 'Complex', model: 'GPT-4o' }), 'code|complex|gpt-4o');
  });
  test('accepts a difficulty object', () => {
    assert.equal(fb.signatureFor({ intent: 'x', difficulty: { bucket: 'moderate' }, model: 'm' }), 'x|moderate|m');
  });
  test('missing parts → unknown', () => {
    assert.equal(fb.signatureFor({}), 'unknown|unknown|unknown');
  });
});

describe('recordOutcome + penalty', () => {
  test('no penalty below MIN_SAMPLES', () => {
    for (let i = 0; i < fb.MIN_SAMPLES - 1; i += 1) {
      fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'weak', outcome: 'regenerated' });
    }
    assert.equal(fb.penaltyFor({ intent: 'code', difficulty: 'complex', model: 'weak' }), 0);
  });

  test('accumulates penalty for repeated negatives', () => {
    for (let i = 0; i < 10; i += 1) {
      fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'weak', outcome: 'regenerated' });
    }
    const p = fb.penaltyFor({ intent: 'code', difficulty: 'complex', model: 'weak' });
    assert.ok(p > 0, `expected penalty, got ${p}`);
    assert.ok(p <= fb.MAX_PENALTY);
  });

  test('positives offset negatives', () => {
    for (let i = 0; i < 6; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'mixed', outcome: 'regenerated' });
    for (let i = 0; i < 6; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'mixed', outcome: 'high_faithfulness' });
    // net negatives ≈ 0 → penalty 0
    assert.equal(fb.penaltyFor({ intent: 'code', difficulty: 'complex', model: 'mixed' }), 0);
  });

  test('unknown outcome / missing model ignored', () => {
    fb.recordOutcome({ intent: 'a', difficulty: 'b', model: 'm', outcome: 'banana' });
    fb.recordOutcome({ intent: 'a', difficulty: 'b', model: null, outcome: 'regenerated' });
    assert.equal(fb.size(), 0);
  });

  test('never throws on garbage', () => {
    assert.doesNotThrow(() => fb.recordOutcome(null));
    assert.doesNotThrow(() => fb.recordOutcome({}));
  });
});

describe('getModelPenalties', () => {
  test('returns penalised models under a (intent,difficulty)', () => {
    for (let i = 0; i < 10; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'weak', outcome: 'low_faithfulness' });
    for (let i = 0; i < 10; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'strong', outcome: 'high_faithfulness' });
    const map = fb.getModelPenalties({ intent: 'code', difficulty: 'complex' });
    assert.ok(map.weak > 0);
    assert.equal(map.strong, undefined); // no penalty → omitted
  });

  test('scopes by signature prefix', () => {
    for (let i = 0; i < 10; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'weak', outcome: 'regenerated' });
    const other = fb.getModelPenalties({ intent: 'chat', difficulty: 'trivial' });
    assert.deepEqual(other, {});
  });
});

describe('snapshot / load / reset', () => {
  test('round-trips state', () => {
    for (let i = 0; i < 8; i += 1) fb.recordOutcome({ intent: 'code', difficulty: 'complex', model: 'weak', outcome: 'regenerated' });
    const snap = fb.snapshot();
    fb.reset();
    assert.equal(fb.size(), 0);
    fb.load(snap);
    assert.ok(fb.penaltyFor({ intent: 'code', difficulty: 'complex', model: 'weak' }) > 0);
  });
});

// ── Orchestrator integration ────────────────────────────────────────────────
const fakeCatalog = (() => {
  const C = {
    'cheap-mini': { id: 'cheap-mini', provider: 'openai', plans: ['FREE', 'PRO'], capabilities: { reasoning: 0.6, code: 0.6, tools: 0.7, vision: 0.7, long_context: 0.6 } },
    'bad-strong': { id: 'bad-strong', provider: 'openrouter', plans: ['FREE', 'PRO'], capabilities: { reasoning: 0.99, code: 0.95, tools: 0.95, vision: 0.94, long_context: 0.92 } },
    'good-strong': { id: 'good-strong', provider: 'openrouter', plans: ['FREE', 'PRO'], capabilities: { reasoning: 0.95, code: 0.92, tools: 0.9, vision: 0.9, long_context: 0.9 } },
  };
  return {
    getModel: (id) => (C[id] ? { ...C[id] } : null),
    isPlanEligible: () => true,
    select: () => ({ model: C['bad-strong'], score: 99, alternatives: [{ id: 'good-strong', score: 95 }], rationale: 'picked bad-strong' }),
  };
})();

describe('orchestrator — penalty-aware routing', () => {
  const hard = 'Analiza detalladamente, compara paso a paso y demuestra formalmente '.repeat(20);
  const base = { prompt: hard, contextSize: 50000, userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'escalate' };

  test('no penalties → escalates to the (high-penalty-in-reality) top model', () => {
    const r = orch.routeModel({ ...base }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'bad-strong');
  });

  test('penaltyProvider deprioritizes the bad model to a better alternative', () => {
    const penaltyProvider = () => ({ 'bad-strong': 0.5, 'good-strong': 0.0 });
    const r = orch.routeModel({ ...base, penaltyProvider }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'good-strong');
    assert.match(r.reason, /deprioritized/);
  });

  test('precomputed modelPenalties also works + decide threads it', () => {
    const d = orch.decide({ ...base, modelPenalties: { 'bad-strong': 0.6, 'good-strong': 0.05 } }, { catalogRouter: fakeCatalog });
    assert.equal(d.routing.selectedModel, 'good-strong');
  });

  test('low penalty (below threshold) does not reroute', () => {
    const r = orch.routeModel({ ...base, modelPenalties: { 'bad-strong': 0.1 } }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'bad-strong');
  });

  test('all alternatives bad → falls back to keeping the user model', () => {
    const r = orch.routeModel({ ...base, modelPenalties: { 'bad-strong': 0.6, 'good-strong': 0.6 } }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'cheap-mini');
    assert.equal(r.changed, false);
  });
});
