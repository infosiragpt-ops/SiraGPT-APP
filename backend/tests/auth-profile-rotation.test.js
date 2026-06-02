'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    listProfiles,
    classifyAuthError,
    shouldRotate,
    rotateProfiles,
    maskKey,
    _basesFor,
} = require('../src/services/ai/auth-profile-rotation');

test('maskKey never leaks more than first 3 + last 4 chars', () => {
    assert.equal(maskKey('sk-proj-abcdef1234567890WXYZ'), 'sk-…WXYZ');
    assert.equal(maskKey('short'), '***');
    assert.equal(maskKey(''), '');
    assert.equal(maskKey(null), '');
});

test('_basesFor maps known providers and aliases', () => {
    assert.deepEqual(_basesFor('openai'), ['OPENAI']);
    assert.deepEqual(_basesFor('claude'), ['ANTHROPIC']);
    assert.ok(_basesFor('gemini').includes('GEMINI'));
    assert.ok(_basesFor('google').includes('GOOGLE_AI'));
    // unknown provider → sanitized single base
    assert.deepEqual(_basesFor('Some New Provider!'), ['SOME_NEW_PROVIDER_']);
});

test('listProfiles collects primary + numbered + comma-list and de-dupes', () => {
    const env = {
        OPENAI_API_KEY: 'sk-primary-0001',
        OPENAI_API_KEY_2: 'sk-second-0002',
        OPENAI_API_KEY_3: 'sk-third-00003',
        OPENAI_API_KEYS: 'sk-list-a-0004, sk-list-b-0005 , sk-primary-0001',
    };
    const profiles = listProfiles('openai', env);
    assert.deepEqual(profiles.map(p => p.key), [
        'sk-primary-0001', 'sk-second-0002', 'sk-third-00003', 'sk-list-a-0004', 'sk-list-b-0005',
    ]);
    // ids are stable + non-secret, masked present
    assert.equal(profiles[0].id, 'openai:1');
    assert.equal(profiles[1].id, 'openai:2');
    assert.ok(profiles[0].masked && !profiles[0].masked.includes('primary'));
    assert.equal(profiles[0].source, 'OPENAI_API_KEY');
});

test('listProfiles de-dupes a key shared across provider env bases', () => {
    const env = { GEMINI_API_KEY: 'g-shared-123456', GOOGLE_API_KEY: 'g-shared-123456' };
    const profiles = listProfiles('gemini', env);
    assert.equal(profiles.length, 1, 'identical key across bases counts once');
});

test('listProfiles returns empty when no keys configured', () => {
    assert.deepEqual(listProfiles('openai', {}), []);
});

test('classifyAuthError distinguishes auth / rate_limit / quota / null', () => {
    assert.equal(classifyAuthError({ status: 401 }), 'auth');
    assert.equal(classifyAuthError({ status: 403 }), 'auth');
    assert.equal(classifyAuthError({ message: 'Invalid API key provided' }), 'auth');
    assert.equal(classifyAuthError({ code: 'invalid_api_key' }), 'auth');
    assert.equal(classifyAuthError({ status: 429 }), 'rate_limit');
    assert.equal(classifyAuthError({ message: 'Rate limit reached' }), 'rate_limit');
    assert.equal(classifyAuthError({ message: 'You exceeded your current quota' }), 'quota');
    assert.equal(classifyAuthError({ status: 402 }), 'quota');
    assert.equal(classifyAuthError({ status: 500 }), null, '5xx is not an auth error');
    assert.equal(classifyAuthError({ status: 400 }), null);
    assert.equal(classifyAuthError({ name: 'AbortError' }), null);
    assert.equal(classifyAuthError(null), null);
    assert.equal(shouldRotate({ status: 401 }), true);
    assert.equal(shouldRotate({ status: 500 }), false);
});

test('rotateProfiles uses first key on success', async () => {
    const env = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2' };
    const used = [];
    const r = await rotateProfiles('openai', async (p) => { used.push(p.key); return 'ok'; }, { env });
    assert.equal(r.result, 'ok');
    assert.equal(r.profileUsed, 'openai:1');
    assert.equal(r.attempts, 1);
    assert.deepEqual(used, ['k1']);
    assert.equal(r.rotations.length, 0);
});

test('rotateProfiles rotates to next key on 401 then succeeds', async () => {
    const env = { OPENAI_API_KEY: 'bad', OPENAI_API_KEY_2: 'good' };
    const rotations = [];
    const r = await rotateProfiles('openai', async (p) => {
        if (p.key === 'bad') { const e = new Error('Invalid API key'); e.status = 401; throw e; }
        return 'served-by-' + p.key;
    }, { env, onRotate: (e) => rotations.push(e) });
    assert.equal(r.result, 'served-by-good');
    assert.equal(r.profileUsed, 'openai:2');
    assert.equal(r.attempts, 2);
    assert.equal(r.rotations.length, 1);
    assert.equal(r.rotations[0].reason, 'auth');
    assert.equal(r.rotations[0].from, 'openai:1');
    assert.equal(r.rotations[0].to, 'openai:2');
    assert.equal(rotations.length, 1);
    // masked, not raw, in the rotation event
    assert.ok(!JSON.stringify(r.rotations[0]).includes('bad') || r.rotations[0].fromMasked === '***');
});

test('rotateProfiles rethrows non-auth error immediately without rotating', async () => {
    const env = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2' };
    const tried = [];
    await assert.rejects(
        rotateProfiles('openai', async (p) => {
            tried.push(p.key);
            const e = new Error('server blew up'); e.status = 500; throw e;
        }, { env }),
        /server blew up/,
    );
    assert.deepEqual(tried, ['k1'], 'must not burn a second key on a non-auth error');
});

test('rotateProfiles exhausts the whole pool then rethrows last error', async () => {
    const env = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2', OPENAI_API_KEY_3: 'k3' };
    const tried = [];
    await assert.rejects(
        rotateProfiles('openai', async (p) => {
            tried.push(p.key);
            const e = new Error('rate limited'); e.status = 429; throw e;
        }, { env }),
        /rate limited/,
    );
    assert.deepEqual(tried, ['k1', 'k2', 'k3']);
});

test('rotateProfiles with no configured keys does a single ambient attempt', async () => {
    let sawProfile = 'unset';
    const r = await rotateProfiles('openai', async (p) => { sawProfile = p; return 'ambient'; }, { env: {} });
    assert.equal(r.result, 'ambient');
    assert.equal(r.profileUsed, null);
    assert.equal(r.attempts, 1);
    assert.equal(sawProfile, null, 'ambient attempt receives null profile');
});

test('rotateProfiles honors maxProfiles cap', async () => {
    const env = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2', OPENAI_API_KEY_3: 'k3' };
    const tried = [];
    await assert.rejects(
        rotateProfiles('openai', async (p) => {
            tried.push(p.key);
            const e = new Error('unauthorized'); e.status = 403; throw e;
        }, { env, maxProfiles: 2 }),
        /unauthorized/,
    );
    assert.deepEqual(tried, ['k1', 'k2'], 'maxProfiles=2 stops after two keys');
});

test('rotateProfiles rejects when attempt is not a function', async () => {
    await assert.rejects(() => rotateProfiles('openai', null, { env: {} }), /attempt must be a function/);
});
