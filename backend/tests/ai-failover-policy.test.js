'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    failoverChain,
    resolveWithFallback,
    _isRetryable,
} = require('../src/services/ai/failover-policy');

test('failoverChain returns gpt-4.1 → gpt-4o → claude-sonnet chain', () => {
    const chain = failoverChain('gpt-4.1');
    assert.equal(chain[0], 'gpt-4.1');
    assert.ok(chain.includes('gpt-4o'));
    assert.ok(chain.includes('claude-sonnet-4.5'));
});

test('failoverChain heuristic for unknown gemini model', () => {
    const chain = failoverChain('gemini-future-xl');
    assert.equal(chain[0], 'gemini-future-xl');
    assert.ok(chain.length > 1);
});

test('failoverChain honors env override', () => {
    process.env.FAILOVER_CHAIN_GPT_4O = 'gpt-4o,gpt-3.5-turbo,gemini-2.5-flash';
    try {
        const chain = failoverChain('gpt-4o');
        assert.deepEqual(chain, ['gpt-4o', 'gpt-3.5-turbo', 'gemini-2.5-flash']);
    } finally {
        delete process.env.FAILOVER_CHAIN_GPT_4O;
    }
});

test('failoverChain falls back to default cross-provider chain when null', () => {
    const chain = failoverChain(null);
    assert.ok(Array.isArray(chain));
    assert.ok(chain.length >= 1);
});

test('_isRetryable detects 5xx, 429, network errors', () => {
    assert.equal(_isRetryable({ status: 500 }), true);
    assert.equal(_isRetryable({ status: 503 }), true);
    assert.equal(_isRetryable({ status: 429 }), true);
    assert.equal(_isRetryable({ status: 408 }), true);
    assert.equal(_isRetryable({ status: 400 }), false);
    assert.equal(_isRetryable({ status: 401 }), false);
    assert.equal(_isRetryable({ message: 'fetch failed: socket hang up' }), true);
    assert.equal(_isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(_isRetryable({ name: 'AbortError' }), false);
    assert.equal(_isRetryable(null), false);
});

test('resolveWithFallback returns primary on first success', async () => {
    const attempts = [];
    const r = await resolveWithFallback('gpt-4.1', {
        attempt: async (m) => { attempts.push(m); return 'ok-' + m; },
    });
    assert.equal(r.result, 'ok-gpt-4.1');
    assert.equal(r.modelUsed, 'gpt-4.1');
    assert.equal(r.attempts, 1);
    assert.equal(r.failovers.length, 0);
    assert.deepEqual(attempts, ['gpt-4.1']);
});

test('resolveWithFallback falls over on 5xx → uses next model', async () => {
    const tried = [];
    const failovers = [];
    const r = await resolveWithFallback('gpt-4.1', {
        attempt: async (m) => {
            tried.push(m);
            if (m === 'gpt-4.1') {
                const e = new Error('upstream 503'); e.status = 503; throw e;
            }
            return 'ok-' + m;
        },
        onFailover: (ev) => failovers.push(ev),
    });
    assert.equal(r.modelUsed, 'gpt-4o');
    assert.equal(tried[0], 'gpt-4.1');
    assert.equal(tried[1], 'gpt-4o');
    assert.equal(failovers.length, 1);
    assert.equal(failovers[0].from, 'gpt-4.1');
    assert.equal(failovers[0].to, 'gpt-4o');
});

test('resolveWithFallback short-circuits on non-retryable error', async () => {
    const tried = [];
    await assert.rejects(
        resolveWithFallback('gpt-4.1', {
            attempt: async (m) => {
                tried.push(m);
                const e = new Error('bad request'); e.status = 400; throw e;
            },
        }),
        /bad request/,
    );
    assert.equal(tried.length, 1, 'should not retry on 400');
});

test('resolveWithFallback uses breaker.execute when provided', async () => {
    const breakerCalls = [];
    const stubBreaker = (name) => ({
        execute: async (fn) => { breakerCalls.push(name); return fn(); },
    });
    const r = await resolveWithFallback('gpt-4o', {
        attempt: async (m) => 'r-' + m,
        getBreaker: stubBreaker,
    });
    assert.equal(r.result, 'r-gpt-4o');
    assert.equal(breakerCalls[0], 'gpt-4o');
});

test('resolveWithFallback honors circuit-open: skip without counting retries', async () => {
    const tried = [];
    const r = await resolveWithFallback('gpt-4.1', {
        attempt: async (m) => {
            tried.push(m);
            if (m === 'gpt-4.1') {
                const e = new Error('open'); e.name = 'CircuitBreakerError'; throw e;
            }
            return m;
        },
    });
    assert.equal(r.modelUsed, 'gpt-4o');
    assert.equal(r.failovers[0].reason, 'circuit_open');
});

test('resolveWithFallback rejects when no attempt function passed', async () => {
    await assert.rejects(() => resolveWithFallback('gpt-4o', {}), /attempt/);
});

test('resolveWithFallback default path is unchanged (no profileUsed rotation)', async () => {
    const r = await resolveWithFallback('gpt-4o', { attempt: async (m) => 'r-' + m });
    assert.equal(r.result, 'r-gpt-4o');
    assert.equal(r.profileUsed, null, 'no rotation requested → profileUsed stays null');
});

test('resolveWithFallback rotateAuth retries sibling key before switching model', async () => {
    const authEnv = { OPENAI_API_KEY: 'bad-key', OPENAI_API_KEY_2: 'good-key' };
    const tried = [];
    const r = await resolveWithFallback('gpt-4o', {
        rotateAuth: true,
        providerOf: () => 'openai',
        authEnv,
        attempt: async (model, meta) => {
            tried.push({ model, key: meta.profile && meta.profile.key });
            if (meta.profile && meta.profile.key === 'bad-key') {
                const e = new Error('Invalid API key'); e.status = 401; throw e;
            }
            return 'served';
        },
    });
    assert.equal(r.result, 'served');
    assert.equal(r.modelUsed, 'gpt-4o', 'recovered on same model via key rotation — no model failover');
    assert.equal(r.profileUsed, 'openai:2');
    assert.equal(r.failovers.length, 0, 'auth rotation must not register a model failover');
    assert.deepEqual(tried.map(t => t.key), ['bad-key', 'good-key']);
});

test('resolveWithFallback rotateAuth falls over to next model when whole key pool is auth-dead', async () => {
    const authEnv = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2' };
    const r = await resolveWithFallback('gpt-4o', {
        rotateAuth: true,
        providerOf: (model) => (model.startsWith('gpt') ? 'openai' : 'google'),
        authEnv,
        attempt: async (model) => {
            if (model === 'gpt-4o') { const e = new Error('401 unauthorized'); e.status = 401; throw e; }
            return 'fallback-' + model;
        },
    });
    assert.notEqual(r.modelUsed, 'gpt-4o');
    assert.ok(r.failovers.length >= 1, 'exhausted key pool then failed over to a different model');
});
