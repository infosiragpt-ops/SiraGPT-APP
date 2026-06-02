'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runFailoverDoctor, providerOfModel, KNOWN_PROVIDERS } = require('../src/services/ai/failover-config-doctor');

test('providerOfModel maps known families and returns null for unknown', () => {
    assert.equal(providerOfModel('gpt-4o'), 'openai');
    assert.equal(providerOfModel('o3-mini'), 'openai');
    assert.equal(providerOfModel('claude-sonnet-4.5'), 'anthropic');
    assert.equal(providerOfModel('gemini-2.5-flash'), 'gemini');
    assert.equal(providerOfModel('deepseek-v4-pro'), 'deepseek');
    assert.equal(providerOfModel('llama-3.1-8b'), 'cerebras');
    assert.equal(providerOfModel('mistral-large'), 'mistral');
    assert.equal(providerOfModel('grok-2'), 'xai');
    assert.equal(providerOfModel('moonshotai/kimi-k2.6'), 'openrouter');
    assert.equal(providerOfModel('totally-unknown-model'), null);
    assert.equal(providerOfModel(''), null);
});

test('empty env → error: no providers configured (ok:false)', () => {
    const r = runFailoverDoctor({});
    assert.equal(r.ok, false);
    assert.ok(r.errors >= 1);
    assert.ok(r.findings.some(f => f.code === 'no_providers_configured' && f.level === 'error'));
    assert.deepEqual(r.providersConfigured, []);
});

test('one healthy provider → ok:true, dead-link warnings for unkeyed fallbacks', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'sk-a-1111', OPENAI_API_KEY_2: 'sk-b-2222' });
    assert.equal(r.ok, true, 'warnings must not flip ok');
    assert.equal(r.errors, 0);
    assert.deepEqual(r.providersConfigured, ['openai']);
    const dead = r.findings.filter(f => f.code === 'chain_dead_link');
    assert.ok(dead.length > 0, 'fallback hops to unkeyed providers flagged');
    // every dead link names a real provider + model
    for (const f of dead) {
        assert.equal(f.level, 'warn');
        assert.ok(f.detail.provider && f.detail.model);
        assert.ok(KNOWN_PROVIDERS.includes(f.detail.provider));
    }
});

test('single-key provider yields an info (rotation depth) finding', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'only-one' });
    assert.ok(r.findings.some(f => f.code === 'single_key_no_rotation' && f.level === 'info' && f.detail.provider === 'openai'));
});

test('the same key across two providers raises a warning', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'shared-xyz', ANTHROPIC_API_KEY: 'shared-xyz' });
    const dup = r.findings.find(f => f.code === 'duplicate_key_across_providers');
    assert.ok(dup, 'duplicate key flagged');
    assert.equal(dup.level, 'warn');
    assert.ok(dup.detail.providers.includes('openai') && dup.detail.providers.includes('anthropic'));
});

test('invalid cooldown env is an error that flips ok:false', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'k', SIRAGPT_KEY_COOLDOWN_AUTH_MS: 'abc' });
    assert.equal(r.ok, false);
    const bad = r.findings.find(f => f.code === 'invalid_cooldown');
    assert.ok(bad && bad.level === 'error');
    assert.equal(bad.detail.env, 'SIRAGPT_KEY_COOLDOWN_AUTH_MS');
});

test('valid numeric cooldown env produces no invalid_cooldown finding', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'k', SIRAGPT_KEY_COOLDOWN_AUTH_MS: '120000' });
    assert.ok(!r.findings.some(f => f.code === 'invalid_cooldown'));
});

test('counts (errors/warnings/infos) match the findings array', () => {
    const r = runFailoverDoctor({ OPENAI_API_KEY: 'only-one', SIRAGPT_KEY_COOLDOWN_MAX_MS: '-5' });
    assert.equal(r.errors, r.findings.filter(f => f.level === 'error').length);
    assert.equal(r.warnings, r.findings.filter(f => f.level === 'warn').length);
    assert.equal(r.infos, r.findings.filter(f => f.level === 'info').length);
    assert.equal(r.ok, r.errors === 0);
});
