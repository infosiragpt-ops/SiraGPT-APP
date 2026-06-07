'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const avail = require('../src/services/model-availability');
const orch = require('../src/services/reasoning-orchestrator');

describe('providerKeyPresent', () => {
  test('true only when a provider key is set', () => {
    assert.equal(avail.providerKeyPresent('openai', { OPENAI_API_KEY: 'sk-x' }), true);
    assert.equal(avail.providerKeyPresent('openai', {}), false);
    assert.equal(avail.providerKeyPresent('google', { GOOGLE_API_KEY: 'g' }), true); // fallback key
    assert.equal(avail.providerKeyPresent('unknown', { X: '1' }), false);
  });
  test('blank key counts as absent', () => {
    assert.equal(avail.providerKeyPresent('openai', { OPENAI_API_KEY: '   ' }), false);
  });
});

describe('isReachable', () => {
  const env = { OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' };
  test('reachable when key present and not aspirational', () => {
    assert.equal(avail.isReachable('gpt-4o', 'openai', { env }), true);
  });
  test('unreachable for aspirational id by default', () => {
    assert.equal(avail.isReachable('openai/gpt-5.5', 'openrouter', { env }), false);
  });
  test('unreachable when provider key missing', () => {
    assert.equal(avail.isReachable('gpt-4o', 'openai', { env: {} }), false);
  });
  test('allowlist restricts to listed ids', () => {
    const e = { ...env, SIRAGPT_AUTO_ROUTING_ALLOWLIST: 'gpt-4o,gemini-2.5-pro' };
    assert.equal(avail.isReachable('gpt-4o', 'openai', { env: e }), true);
    assert.equal(avail.isReachable('gpt-4o-mini', 'openai', { env: e }), false); // not allowlisted
  });
  test('custom blocklist overrides default aspirational set', () => {
    const e = { ...env, SIRAGPT_AUTO_ROUTING_BLOCKLIST: 'gpt-4o' };
    assert.equal(avail.isReachable('gpt-4o', 'openai', { env: e }), false);
    assert.equal(avail.isReachable('openai/gpt-5.5', 'openrouter', { env: e }), true); // no longer blocked
  });
});

describe('reachableModelIds + resolveReachable', () => {
  const catalog = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'openai/gpt-5.5', provider: 'openrouter' },
    { id: 'gemini-2.5-pro', provider: 'google' },
    { id: 'deepseek-v4-flash', provider: 'deepseek' },
  ];
  test('reachableModelIds keeps only configured, non-aspirational models', () => {
    const env = { OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }; // no google/deepseek keys
    const set = avail.reachableModelIds(catalog, { env });
    assert.ok(set.has('gpt-4o'));
    assert.ok(!set.has('openai/gpt-5.5')); // aspirational
    assert.ok(!set.has('gemini-2.5-pro')); // no google key
    assert.ok(!set.has('deepseek-v4-flash')); // no deepseek key
  });
  test('resolveReachable prefers reachable, falls to alternatives, else null', () => {
    const env = { OPENAI_API_KEY: 'k' };
    const lookup = (id) => catalog.find((m) => m.id === id) || null;
    // preferred reachable
    assert.equal(avail.resolveReachable('gpt-4o', [], lookup, { env }), 'gpt-4o');
    // preferred unreachable → first reachable alt
    assert.equal(avail.resolveReachable('gemini-2.5-pro', [{ id: 'gpt-4o' }], lookup, { env }), 'gpt-4o');
    // nothing reachable → null
    assert.equal(avail.resolveReachable('gemini-2.5-pro', [{ id: 'deepseek-v4-flash' }], lookup, { env }), null);
  });
});

// ── Orchestrator integration: reachability filtering in routeModel ──────────
const fakeCatalog = (() => {
  const C = {
    'cheap-mini': { id: 'cheap-mini', provider: 'openai', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'low', latency_tier: 'fast', languages: ['es', 'en'], capabilities: { reasoning: 0.6, code: 0.6, tools: 0.7, vision: 0.7, long_context: 0.6 } },
    'top-aspirational': { id: 'top-aspirational', provider: 'openrouter', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'high', latency_tier: 'normal', languages: ['es', 'en'], capabilities: { reasoning: 0.99, code: 0.95, tools: 0.95, vision: 0.94, long_context: 0.92 } },
    'top-real': { id: 'top-real', provider: 'openrouter', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'high', latency_tier: 'normal', languages: ['es', 'en'], capabilities: { reasoning: 0.95, code: 0.92, tools: 0.9, vision: 0.9, long_context: 0.9 } },
  };
  function getModel(id) { return C[id] ? { ...C[id] } : null; }
  function isPlanEligible() { return true; }
  function select() {
    // Always recommends the strongest (aspirational) model + a real alternative.
    return {
      model: C['top-aspirational'],
      score: 99,
      alternatives: [{ id: 'top-real', score: 95 }],
      rationale: 'picked top-aspirational',
    };
  }
  return { select, getModel, isPlanEligible };
})();

describe('routeModel — reachability filtering', () => {
  const hard = 'Analiza detalladamente, compara paso a paso y demuestra formalmente '.repeat(20);
  const base = { prompt: hard, contextSize: 50000, userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'escalate' };

  test('no reachableModelIds → unchanged (backward compatible): escalates to aspirational', () => {
    const r = orch.routeModel({ ...base }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'top-aspirational');
    assert.equal(r.changed, true);
  });

  test('with reachable set excluding the target → reroutes to reachable alternative', () => {
    const r = orch.routeModel({ ...base, reachableModelIds: new Set(['cheap-mini', 'top-real']) }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'top-real');
    assert.equal(r.changed, true);
    assert.match(r.reason, /reroute_reachable/);
  });

  test('with no reachable target → keeps user model', () => {
    const r = orch.routeModel({ ...base, reachableModelIds: new Set(['cheap-mini']) }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'cheap-mini');
    assert.equal(r.changed, false);
    assert.equal(r.shouldApply, false);
    assert.match(r.reason, /no_reachable_target/);
  });

  test('accepts an array (not just a Set) for reachableModelIds', () => {
    const r = orch.routeModel({ ...base, reachableModelIds: ['cheap-mini', 'top-real'] }, { catalogRouter: fakeCatalog });
    assert.equal(r.selectedModel, 'top-real');
  });

  test('decide() threads reachableModelIds through', () => {
    const d = orch.decide({ ...base, reachableModelIds: new Set(['cheap-mini', 'top-real']) }, { catalogRouter: fakeCatalog });
    assert.equal(d.routing.selectedModel, 'top-real');
  });
});
