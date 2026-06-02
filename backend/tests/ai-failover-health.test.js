'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const route = require('../src/routes/ai-failover-health');
const keyHealth = require('../src/services/ai/provider-key-health');

const SECRET_ENV = {
    OPENAI_API_KEY: 'sk-realsecretvalue1234567890',
    OPENAI_API_KEY_2: 'sk-secondrealsecret0987654321',
    ANTHROPIC_API_KEY: 'sk-ant-supersecretkeymaterial',
};

test('buildFailoverHealthReport lists only configured providers with masked keys', () => {
    const r = route.buildFailoverHealthReport(SECRET_ENV);
    assert.equal(r.ok, true);
    assert.equal(r.service, 'ai-failover');
    assert.equal(r.providersConfigured, 2); // openai + anthropic
    const openai = r.providers.find(p => p.provider === 'openai');
    assert.equal(openai.keyCount, 2);
    assert.equal(openai.keys.length, 2);
    assert.match(openai.keys[0].masked, /^sk-…\d{4}$/);
    assert.equal(openai.keys[0].source, 'OPENAI_API_KEY');
    assert.match(openai.keys[0].fingerprint, /^[0-9a-f]{12}$/);
});

test('buildFailoverHealthReport NEVER leaks raw key material', () => {
    const json = JSON.stringify(route.buildFailoverHealthReport(SECRET_ENV));
    assert.ok(!json.includes('realsecretvalue'), 'raw OPENAI_API_KEY leaked');
    assert.ok(!json.includes('secondrealsecret'), 'raw OPENAI_API_KEY_2 leaked');
    assert.ok(!json.includes('supersecretkeymaterial'), 'raw ANTHROPIC_API_KEY leaked');
});

test('buildFailoverHealthReport includes failover chains for sample models', () => {
    const r = route.buildFailoverHealthReport(SECRET_ENV);
    const gpt4o = r.failoverChains.find(c => c.model === 'gpt-4o');
    assert.ok(gpt4o, 'gpt-4o chain present');
    assert.equal(gpt4o.chain[0], 'gpt-4o');
    assert.ok(gpt4o.chain.length > 1);
});

test('buildFailoverHealthReport includes a key-health snapshot', () => {
    keyHealth._reset();
    const r = route.buildFailoverHealthReport(SECRET_ENV);
    assert.equal(typeof r.keyHealth, 'object');
    assert.equal(r.keyHealth.tracked, 0);
    assert.ok(Array.isArray(r.keyHealth.keys));
});

test('buildFailoverHealthReport reflects env cooldown config (with defaults)', () => {
    const base = route.buildFailoverHealthReport({});
    assert.equal(base.providersConfigured, 0, 'empty env → no providers, no throw');
    assert.equal(base.config.cooldownAuthMs, 300000);
    const tuned = route.buildFailoverHealthReport({ SIRAGPT_KEY_COOLDOWN_AUTH_MS: '999' });
    assert.equal(tuned.config.cooldownAuthMs, 999);
});

test('checkAuth is open when SIRAGPT_DIAG_TOKEN is unset', () => {
    assert.deepEqual(route.checkAuth({ get: () => undefined, query: {} }, {}), { ok: true });
});

test('checkAuth requires a matching token when configured', () => {
    const env = { SIRAGPT_DIAG_TOKEN: 'sekret' };
    assert.equal(route.checkAuth({ get: () => undefined, query: {} }, env).ok, false);
    assert.equal(route.checkAuth({ get: () => 'Bearer sekret', query: {} }, env).ok, true);
    assert.equal(route.checkAuth({ get: () => undefined, query: { token: 'sekret' } }, env).ok, true);
    assert.equal(route.checkAuth({ get: () => 'Bearer wrong', query: {} }, env).ok, false);
});

test('module exports an express router (GET handlers registered)', () => {
    assert.equal(typeof route, 'function'); // express routers are functions
    assert.equal(typeof route.buildRouter, 'function');
    const fresh = route.buildRouter();
    assert.equal(typeof fresh, 'function');
    // router exposes a layer stack with our two GET routes
    const paths = (fresh.stack || []).filter(l => l.route).map(l => l.route.path);
    assert.ok(paths.includes('/health'));
    assert.ok(paths.includes('/'));
});
