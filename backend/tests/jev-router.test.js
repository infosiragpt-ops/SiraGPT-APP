'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_JEV_MODEL_ID,
  getJevRouterConfig,
  isJevRouterEnabled,
  isFlashTierModel,
  isProTierModel,
  flashToProModelId,
  buildJudgePrompt,
  parseDecisionContent,
  judgeTierEscalation,
  refineRoutingWithJev,
} = require('../src/services/ai/jev-router');

const ENV_ON = { SIRAGPT_JEV_ROUTER: '1', OPENROUTER_API_KEY: 'sk-or-test' };
const ENV_SHADOW = { SIRAGPT_JEV_ROUTER: 'shadow', OPENROUTER_API_KEY: 'sk-or-test' };

function fetchWithContent(content, { capture } = {}) {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
      capture.body = JSON.parse(init.body);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

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

test('jev-router: config + enablement', async (t) => {
  await t.test('disabled by default (no flag)', () => {
    assert.equal(getJevRouterConfig({ OPENROUTER_API_KEY: 'k' }).mode, 'off');
    assert.equal(isJevRouterEnabled({ OPENROUTER_API_KEY: 'k' }), false);
  });

  await t.test('flag on without OPENROUTER_API_KEY stays disabled', () => {
    assert.equal(isJevRouterEnabled({ SIRAGPT_JEV_ROUTER: '1' }), false);
  });

  await t.test('on / shadow modes parse and defaults hold', () => {
    const on = getJevRouterConfig(ENV_ON);
    assert.equal(on.mode, 'on');
    assert.equal(on.configured, true);
    assert.equal(on.modelId, DEFAULT_JEV_MODEL_ID);
    assert.equal(getJevRouterConfig(ENV_SHADOW).mode, 'shadow');
    assert.equal(isJevRouterEnabled(ENV_ON), true);
  });

  await t.test('timeout and confidence clamp to sane ranges', () => {
    const cfg = getJevRouterConfig({ ...ENV_ON, SIRAGPT_JEV_TIMEOUT_MS: '5', SIRAGPT_JEV_MIN_CONFIDENCE: '9' });
    assert.equal(cfg.timeoutMs, 250);
    assert.equal(cfg.minConfidence, 1);
  });
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
});

test('jev-router: decision parsing', async (t) => {
  await t.test('bare word and prose', () => {
    assert.deepEqual(parseDecisionContent('pro'), { choice: 'pro', confidence: null });
    assert.deepEqual(parseDecisionContent('Flash.'), { choice: 'flash', confidence: null });
    assert.equal(parseDecisionContent('no decision here'), null);
    assert.equal(parseDecisionContent(''), null);
  });

  await t.test('last mention wins when prose names both tiers', () => {
    assert.equal(parseDecisionContent('Between flash and pro, I choose pro').choice, 'pro');
    assert.equal(parseDecisionContent('pro seems tempting but flash suffices').choice, 'flash');
  });

  await t.test('JSON shapes, fenced or bare, with confidence', () => {
    assert.deepEqual(
      parseDecisionContent('{"choice":"pro","confidence":0.83}'),
      { choice: 'pro', confidence: 0.83 },
    );
    assert.deepEqual(
      parseDecisionContent('```json\n{"answers":[{"value":"flash","confidence":0.9}]}\n```'),
      { choice: 'flash', confidence: 0.9 },
    );
    assert.deepEqual(
      parseDecisionContent('{"tier":"pro","probability":1.7}'),
      { choice: 'pro', confidence: null },
    );
  });
});

test('jev-router: judgeTierEscalation', async (t) => {
  await t.test('sends the Jev model id, auth header and temperature 0', async () => {
    const capture = {};
    const result = await judgeTierEscalation(
      { prompt: 'refactor my backend', contextChars: 120, attachmentsCount: 1 },
      { env: ENV_ON, fetchImpl: fetchWithContent('pro', { capture }) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'pro');
    assert.match(String(capture.url), /\/chat\/completions$/);
    assert.equal(capture.body.model, DEFAULT_JEV_MODEL_ID);
    assert.equal(capture.body.temperature, 0);
    assert.equal(capture.init.headers.Authorization, 'Bearer sk-or-test');
    assert.match(capture.body.messages[0].content, /refactor my backend/);
  });

  await t.test('truncates oversized prompts in the judge message', () => {
    const content = buildJudgePrompt({ prompt: 'x'.repeat(10_000) });
    assert.ok(content.length < 6000);
  });

  await t.test('http error → ok:false with status reason', async () => {
    const result = await judgeTierEscalation({ prompt: 'q' }, {
      env: ENV_ON,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'http_500' });
  });

  await t.test('timeout aborts and reports timeout', async () => {
    const result = await judgeTierEscalation({ prompt: 'q' }, {
      env: { ...ENV_ON, SIRAGPT_JEV_TIMEOUT_MS: '250' },
      fetchImpl: (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    });
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'timeout' });
  });

  await t.test('unparseable content and thrown fetch fail closed', async () => {
    const junk = await judgeTierEscalation({ prompt: 'q' }, {
      env: ENV_ON,
      fetchImpl: fetchWithContent('¯\\_(ツ)_/¯'),
    });
    assert.equal(junk.ok, false);
    assert.equal(junk.reason, 'unparseable');
    const thrown = await judgeTierEscalation({ prompt: 'q' }, {
      env: ENV_ON,
      fetchImpl: async () => { throw new Error('boom'); },
    });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.reason, 'fetch_failed');
  });

  await t.test('never calls fetch when unconfigured', async () => {
    let called = false;
    const result = await judgeTierEscalation({ prompt: 'q' }, {
      env: { SIRAGPT_JEV_ROUTER: '1' },
      fetchImpl: async () => { called = true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
    assert.equal(called, false);
  });
});

test('jev-router: refineRoutingWithJev', async (t) => {
  const ctx = (overrides = {}) => ({
    prompt: 'audita este contrato y arma un plan de riesgos',
    contextChars: 500,
    attachmentsCount: 0,
    hasImages: false,
    pickerLocked: false,
    currentModel: 'deepseek-v4-flash',
    reachableModelIds: null,
    language: 'es',
    ...overrides,
  });

  await t.test('escalates flash→pro on a pro verdict', async () => {
    const routing = baseRouting();
    const { routing: refined, jev } = await refineRoutingWithJev(routing, ctx(), {
      env: ENV_ON,
      fetchImpl: fetchWithContent('{"choice":"pro","confidence":0.91}'),
    });
    assert.equal(refined.shouldApply, true);
    assert.equal(refined.action, 'escalate');
    assert.equal(refined.selectedModel, 'deepseek-v4-pro');
    assert.equal(refined.selectedProvider, null);
    assert.match(refined.reason, /^jev:escalate/);
    assert.equal(jev.applied, true);
    // Original routing object stays untouched (new object returned).
    assert.equal(routing.shouldApply, false);
  });

  await t.test('keeps flash on a flash verdict', async () => {
    const routing = baseRouting();
    const { routing: refined, jev } = await refineRoutingWithJev(routing, ctx(), {
      env: ENV_ON,
      fetchImpl: fetchWithContent('flash'),
    });
    assert.equal(refined, routing);
    assert.equal(jev.applied, false);
  });

  await t.test('vetoes a heuristic pro escalation on a flash verdict', async () => {
    const routing = baseRouting({
      selectedModel: 'deepseek/deepseek-v4-pro',
      changed: true,
      action: 'escalate',
      shouldApply: true,
    });
    const { routing: refined, jev } = await refineRoutingWithJev(routing, ctx(), {
      env: ENV_ON,
      fetchImpl: fetchWithContent('flash'),
    });
    assert.equal(refined.shouldApply, false);
    assert.equal(refined.action, 'keep');
    assert.equal(refined.selectedModel, 'deepseek-v4-flash');
    assert.equal(refined.reason, 'jev:veto_escalation');
    assert.equal(jev.applied, true);
  });

  await t.test('never vetoes an escalation to a non-Sira target', async () => {
    const routing = baseRouting({
      selectedModel: 'gpt-4o',
      changed: true,
      action: 'escalate',
      shouldApply: true,
    });
    const { routing: refined } = await refineRoutingWithJev(routing, ctx(), {
      env: ENV_ON,
      fetchImpl: fetchWithContent('flash'),
    });
    assert.equal(refined, routing);
    assert.equal(refined.shouldApply, true);
  });

  await t.test('shadow mode judges and logs but never mutates routing', async () => {
    const routing = baseRouting();
    const { routing: refined, jev } = await refineRoutingWithJev(routing, ctx({ pickerLocked: true }), {
      env: ENV_SHADOW,
      fetchImpl: fetchWithContent('pro'),
    });
    assert.equal(refined, routing);
    assert.equal(jev.ok, true);
    assert.equal(jev.applied, false);
    assert.equal(jev.reason, 'shadow_escalate');
  });

  await t.test('active mode skips the network call when the picker is locked', async () => {
    let called = false;
    const { routing: refined, jev } = await refineRoutingWithJev(baseRouting(), ctx({ pickerLocked: true }), {
      env: ENV_ON,
      fetchImpl: async () => { called = true; },
    });
    assert.equal(called, false);
    assert.equal(jev.reason, 'picker_locked');
    assert.equal(refined.shouldApply, false);
  });

  await t.test('skips images, non-flash current models and empty prompts without fetching', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; };
    const images = await refineRoutingWithJev(baseRouting(), ctx({ hasImages: true }), { env: ENV_ON, fetchImpl });
    assert.equal(images.jev.reason, 'has_images');
    const pro = await refineRoutingWithJev(baseRouting(), ctx({ currentModel: 'deepseek-v4-pro' }), { env: ENV_ON, fetchImpl });
    assert.equal(pro.jev.reason, 'not_flash_tier');
    const empty = await refineRoutingWithJev(baseRouting(), ctx({ prompt: '  ' }), { env: ENV_ON, fetchImpl });
    assert.equal(empty.jev.reason, 'empty_prompt');
    assert.equal(called, false);
  });

  await t.test('low confidence below the threshold does not apply', async () => {
    const { routing: refined, jev } = await refineRoutingWithJev(baseRouting(), ctx(), {
      env: { ...ENV_ON, SIRAGPT_JEV_MIN_CONFIDENCE: '0.8' },
      fetchImpl: fetchWithContent('{"choice":"pro","confidence":0.5}'),
    });
    assert.equal(refined.shouldApply, false);
    assert.equal(jev.reason, 'low_confidence');
  });

  await t.test('respects the reachable-model set', async () => {
    const { routing: refined, jev } = await refineRoutingWithJev(
      baseRouting(),
      ctx({ reachableModelIds: new Set(['deepseek-v4-flash']) }),
      { env: ENV_ON, fetchImpl: fetchWithContent('pro') },
    );
    assert.equal(refined.shouldApply, false);
    assert.equal(jev.reason, 'target_unreachable');
  });

  await t.test('fail-open: judge errors leave the routing untouched', async () => {
    const routing = baseRouting();
    const { routing: refined, jev } = await refineRoutingWithJev(routing, ctx(), {
      env: ENV_ON,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(refined, routing);
    assert.equal(jev.ok, false);
    assert.equal(jev.applied, false);
  });

  await t.test('mode off returns a null jev report (no log noise)', async () => {
    const { jev } = await refineRoutingWithJev(baseRouting(), ctx(), {
      env: { OPENROUTER_API_KEY: 'k' },
      fetchImpl: fetchWithContent('pro'),
    });
    assert.equal(jev, null);
  });
});
