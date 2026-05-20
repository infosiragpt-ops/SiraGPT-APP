'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tokenBudget = require('../src/services/ai/token-budget');

const stubUsage = {
    calculateTextTokens(text) { return Math.ceil(String(text || '').length / 4); },
};

test('estimateInputTokens uses injected usageService', () => {
    const n = tokenBudget.estimateInputTokens('hello world', 'gpt-4o-mini', stubUsage);
    assert.ok(n > 0);
});

test('contextWindowFor knows common models', () => {
    assert.equal(tokenBudget.contextWindowFor('gpt-4o'), 128_000);
    assert.equal(tokenBudget.contextWindowFor('claude-sonnet-4.5'), 200_000);
    assert.equal(tokenBudget.contextWindowFor('anthropic/claude-sonnet-4.5'), 200_000);
    assert.equal(tokenBudget.contextWindowFor('gpt-3.5-turbo'), 16_000);
});

test('contextWindowFor heuristic for unknown family', () => {
    assert.equal(tokenBudget.contextWindowFor('gemini-future'), 1_000_000);
    assert.equal(tokenBudget.contextWindowFor('totally-unknown-model'), 16_000);
});

test('estimateCost reports input/output/total USD', () => {
    const c = tokenBudget.estimateCost('gpt-4o', 1_000_000, 1_000_000);
    assert.ok(c.inputUSD > 0);
    assert.ok(c.outputUSD > 0);
    assert.equal(c.totalUSD, c.inputUSD + c.outputUSD);
});

test('pricingFor resolves provider-prefixed Anthropic slugs', () => {
    const bare = tokenBudget.pricingFor('claude-sonnet-4.5');
    const prefixed = tokenBudget.pricingFor('anthropic/claude-sonnet-4.5');
    assert.deepEqual(prefixed, bare);
});

test('suggestLongerContextModel picks a viable larger model', () => {
    const suggested = tokenBudget.suggestLongerContextModel(150_000);
    assert.ok(suggested);
    assert.ok(tokenBudget.contextWindowFor(suggested) >= 150_000);
});

test('preflight returns ok=true under quota and within window', async () => {
    const r = await tokenBudget.preflight({
        userId: null,
        model: 'gpt-4o-mini',
        prompt: 'hola',
        contextMessages: [],
        usageService: stubUsage,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.ok(r.estimatedInputTokens > 0);
    assert.ok(r.contextWindow > 0);
});

test('preflight flags 413 context_overflow when prompt exceeds window', async () => {
    // ~30k tokens at 4 chars/token — fits in 128k models but not in
    // gpt-3.5-turbo's 16k window. Forces 413 and triggers a suggestion.
    const hugePrompt = 'x'.repeat(120_000);
    const r = await tokenBudget.preflight({
        userId: null,
        model: 'gpt-3.5-turbo',
        prompt: hugePrompt,
        contextMessages: [],
        usageService: stubUsage,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 413);
    assert.equal(r.reason, 'context_overflow');
    assert.ok(r.suggestedModel, 'should suggest a long-context model');
});

test('preflight fails open on internal error', async () => {
    const badUsage = { calculateTextTokens() { throw new Error('boom'); } };
    const r = await tokenBudget.preflight({
        userId: null,
        model: 'gpt-4o-mini',
        prompt: 'hi',
        usageService: badUsage,
    });
    // estimator falls back to char heuristic; should still succeed
    assert.equal(r.ok, true);
});

test('preflight returns 402 cost_cap_exceeded when explicit maxCostUSD < estimated', async () => {
    // gpt-4o input is $2.50 / 1M tokens; ~25k input tokens ≈ $0.0625.
    // A cap of $0.0001 must trigger the 402 cost_cap_exceeded branch.
    const r = await tokenBudget.preflight({
        userId: null,
        model: 'gpt-4o',
        prompt: 'x'.repeat(100_000),
        usageService: stubUsage,
        maxCostUSD: 0.0001,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 402);
    assert.equal(r.reason, 'cost_cap_exceeded');
    assert.equal(r.maxCostUSD, 0.0001);
    assert.ok(r.estimatedCostUSD > 0.0001);
});

test('preflight uses env SIRAGPT_MAX_COST_PER_REQUEST_USD when no override', async () => {
    process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD = '0.00005';
    try {
        const r = await tokenBudget.preflight({
            userId: null,
            model: 'gpt-4o',
            prompt: 'x'.repeat(50_000),
            usageService: stubUsage,
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'cost_cap_exceeded');
        assert.equal(r.status, 402);
    } finally {
        delete process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD;
    }
});

test('preflight default cap of $5 lets normal requests through', async () => {
    delete process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD;
    const r = await tokenBudget.preflight({
        userId: null,
        model: 'gpt-4o-mini',
        prompt: 'hello',
        usageService: stubUsage,
    });
    assert.equal(r.ok, true);
});

test('preflight maxCostUSD <= 0 disables the cap explicitly', async () => {
    process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD = '0.00005';
    try {
        const r = await tokenBudget.preflight({
            userId: null,
            model: 'gpt-4o',
            prompt: 'x'.repeat(50_000),
            usageService: stubUsage,
            maxCostUSD: 0, // explicit disable
        });
        assert.equal(r.ok, true);
        assert.equal(r.reason, 'ok');
    } finally {
        delete process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD;
    }
});

test('_resolveMaxCostUSD priority: override > env > default $5', () => {
    delete process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD;
    assert.equal(tokenBudget._resolveMaxCostUSD(null), 5);
    process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD = '2.5';
    assert.equal(tokenBudget._resolveMaxCostUSD(null), 2.5);
    assert.equal(tokenBudget._resolveMaxCostUSD(1.25), 1.25);
    assert.equal(tokenBudget._resolveMaxCostUSD(0), null);
    delete process.env.SIRAGPT_MAX_COST_PER_REQUEST_USD;
});

test('preflight returns 402 when quota exhausted', async () => {
    process.env.USER_MONTHLY_QUOTA_USD = '0.0001';
    const fakePrisma = {
        apiUsage: { aggregate: async () => ({ _sum: { cost: 0.001 } }) },
    };
    try {
        const r = await tokenBudget.preflight({
            userId: 'u1',
            model: 'gpt-4o',
            prompt: 'hola mundo',
            usageService: stubUsage,
            prisma: fakePrisma,
        });
        assert.equal(r.ok, false);
        assert.equal(r.status, 402);
        assert.equal(r.reason, 'quota_exhausted');
        assert.equal(r.remainingQuota, 0);
        assert.ok(r.breakdown);
    } finally {
        delete process.env.USER_MONTHLY_QUOTA_USD;
    }
});
