'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isFlashTierModel,
  isProTierModel,
  flashToProModelId,
  mapFamilyToTier,
  refineRoutingWithJevJudgement,
} = require('../src/services/ai/jev-router');

function baseRouting(overrides = {}) {
  return {
    mode: 'off',
    userModel: 'deepseek-v4-flash',
    userProvider: 'DeepSeek',
    selectedModel: 'deepseek-v4-flash',
    selectedProvider: 'DeepSeek',
    changed: false,
    action: 'keep',
    reason: 'recommend_only',
    shouldApply: false,
    ...overrides,
  };
}

function judgedWith(family) {
  return {
    judgement: { lane: { choice: 'chat_only' }, modelFamily: family },
    actions: { modelFamily: family },
  };
}

function family(choice, { steer = true, confidence = 0.85, probability = 0.8 } = {}) {
  return { choice, confidence, probability, probabilities: { [choice]: probability }, steer };
}

const CTX = Object.freeze({
  currentModel: 'deepseek-v4-flash',
  hasImages: false,
  reachableModelIds: null,
});

test('jev-router: tier helpers', async (t) => {
  await t.test('flash/pro detection on both id shapes', () => {
    assert.equal(isFlashTierModel('deepseek-v4-flash'), true);
    assert.equal(isFlashTierModel('deepseek/deepseek-v4-flash'), true);
    assert.equal(isFlashTierModel('deepseek-v4-pro'), false);
    assert.equal(isProTierModel('deepseek/deepseek-v4-pro'), true);
    assert.equal(isProTierModel('deepseek-v4-flash'), false);
    assert.equal(isProTierModel('gpt-4o'), false);
  });

  await t.test('flashToProModelId preserves provider shape and honors override', () => {
    assert.equal(flashToProModelId('deepseek-v4-flash', {}), 'deepseek-v4-pro');
    assert.equal(flashToProModelId('deepseek/deepseek-v4-flash', {}), 'deepseek/deepseek-v4-pro');
    assert.equal(
      flashToProModelId('deepseek-v4-flash', { SIRAGPT_JEV_PRO_TARGET: 'deepseek/deepseek-v4-pro' }),
      'deepseek/deepseek-v4-pro',
    );
  });

  await t.test('mapFamilyToTier: reasoning/coding→pro, fast_cheap→flash, rest→null', () => {
    assert.equal(mapFamilyToTier('reasoning'), 'pro');
    assert.equal(mapFamilyToTier('coding'), 'pro');
    assert.equal(mapFamilyToTier('fast_cheap'), 'flash');
    assert.equal(mapFamilyToTier('balanced'), null);
    assert.equal(mapFamilyToTier('vision'), null);
    assert.equal(mapFamilyToTier(''), null);
    assert.equal(mapFamilyToTier(null), null);
  });
});

test('jev-router: refineRoutingWithJevJudgement', async (t) => {
  await t.test('escalates flash→pro on a steered reasoning verdict', () => {
    const routing = baseRouting();
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('reasoning')), CTX, {},
    );
    assert.equal(refined.shouldApply, true);
    assert.equal(refined.action, 'escalate');
    assert.equal(refined.selectedModel, 'deepseek-v4-pro');
    assert.equal(refined.selectedProvider, null);
    assert.match(refined.reason, /^jev:family_reasoning/);
    assert.equal(steering.applied, true);
    assert.equal(steering.reason, 'escalated');
    // Original routing object stays untouched (new object returned).
    assert.equal(routing.shouldApply, false);
  });

  await t.test('coding verdict also escalates; openrouter-shaped id keeps its prefix', () => {
    const { routing: refined } = refineRoutingWithJevJudgement(
      baseRouting({ userModel: 'deepseek/deepseek-v4-flash', selectedModel: 'deepseek/deepseek-v4-flash' }),
      judgedWith(family('coding')),
      { ...CTX, currentModel: 'deepseek/deepseek-v4-flash' },
      {},
    );
    assert.equal(refined.selectedModel, 'deepseek/deepseek-v4-pro');
    assert.equal(refined.shouldApply, true);
  });

  await t.test('advisory only (steer=false) never mutates, but reports the verdict', () => {
    const routing = baseRouting();
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('reasoning', { steer: false })), CTX, {},
    );
    assert.equal(refined, routing);
    assert.equal(steering.applied, false);
    assert.equal(steering.reason, 'advisory');
    assert.equal(steering.family, 'reasoning');
  });

  await t.test('fast_cheap vetoes a heuristic escalation to the pro tier', () => {
    const routing = baseRouting({
      selectedModel: 'deepseek/deepseek-v4-pro',
      changed: true,
      action: 'escalate',
      shouldApply: true,
    });
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('fast_cheap')), CTX, {},
    );
    assert.equal(refined.shouldApply, false);
    assert.equal(refined.action, 'keep');
    assert.equal(refined.selectedModel, 'deepseek-v4-flash');
    assert.equal(refined.reason, 'jev:veto_escalation');
    assert.equal(steering.applied, true);
    assert.equal(steering.reason, 'vetoed_escalation');
  });

  await t.test('never vetoes an escalation to a non-Sira target', () => {
    const routing = baseRouting({
      selectedModel: 'gpt-4o',
      changed: true,
      action: 'escalate',
      shouldApply: true,
    });
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('fast_cheap')), CTX, {},
    );
    assert.equal(refined, routing);
    assert.equal(refined.shouldApply, true);
    assert.equal(steering.reason, 'keep');
  });

  await t.test('fast_cheap with nothing to veto is a no-op', () => {
    const routing = baseRouting();
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('fast_cheap')), CTX, {},
    );
    assert.equal(refined, routing);
    assert.equal(steering.applied, false);
  });

  await t.test('balanced and vision express no tier opinion', () => {
    for (const choice of ['balanced', 'vision']) {
      const routing = baseRouting();
      const { routing: refined, steering } = refineRoutingWithJevJudgement(
        routing, judgedWith(family(choice)), CTX, {},
      );
      assert.equal(refined, routing);
      assert.equal(steering.reason, 'no_tier_opinion');
    }
  });

  await t.test('image turns are left to the vision path', () => {
    const routing = baseRouting();
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('reasoning')), { ...CTX, hasImages: true }, {},
    );
    assert.equal(refined, routing);
    assert.equal(steering.reason, 'has_images');
  });

  await t.test('pro-tier current model has nothing to escalate', () => {
    const routing = baseRouting({ userModel: 'deepseek-v4-pro', selectedModel: 'deepseek-v4-pro' });
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing, judgedWith(family('reasoning')), { ...CTX, currentModel: 'deepseek-v4-pro' }, {},
    );
    assert.equal(refined, routing);
    assert.equal(steering.reason, 'not_flash_tier');
  });

  await t.test('respects the reachable-model set', () => {
    const routing = baseRouting();
    const { routing: refined, steering } = refineRoutingWithJevJudgement(
      routing,
      judgedWith(family('reasoning')),
      { ...CTX, reachableModelIds: new Set(['deepseek-v4-flash']) },
      {},
    );
    assert.equal(refined, routing);
    assert.equal(steering.reason, 'target_unreachable');
  });

  await t.test('missing or malformed judgement is a silent no-op', () => {
    const routing = baseRouting();
    for (const judged of [null, undefined, {}, { actions: {} }, { actions: { modelFamily: { steer: true } } }]) {
      const { routing: refined, steering } = refineRoutingWithJevJudgement(routing, judged, CTX, {});
      assert.equal(refined, routing);
      assert.equal(steering.applied, false);
      assert.equal(steering.reason, 'no_verdict');
      assert.equal(steering.family, null);
    }
  });
});
