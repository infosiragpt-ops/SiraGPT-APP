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
const health = require('../src/services/ai/provider-key-health');

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

// --- keyHealth integration (opt-in; default-off path covered above) ---

test('keyHealth: a cooling key is tried last', async () => {
    health._reset();
    const env = { OPENAI_API_KEY: 'k1', OPENAI_API_KEY_2: 'k2', OPENAI_API_KEY_3: 'k3' };
    // Pre-cool k2 so it should drift to the back of the rotation order.
    health.recordFailure(health.fingerprint('k2'), 'auth', 0);
    const tried = [];
    await assert.rejects(
        rotateProfiles('openai', async (p) => {
            tried.push(p.key);
            const e = new Error('429'); e.status = 429; throw e;
        }, { env, keyHealth: true, now: 1_000 }),
        /429/,
    );
    assert.deepEqual(tried, ['k1', 'k3', 'k2'], 'cooled k2 is attempted only after the healthy keys');
});

test('keyHealth: success clears a previously-cooling key', async () => {
    health._reset();
    health.recordFailure(health.fingerprint('k1'), 'auth', 0);
    assert.equal(health.isInCooldown(health.fingerprint('k1'), 1_000), true);
    const r = await rotateProfiles('openai', async () => 'ok', {
        env: { OPENAI_API_KEY: 'k1' }, keyHealth: true, now: 1_000,
    });
    assert.equal(r.result, 'ok');
    assert.equal(health.isInCooldown(health.fingerprint('k1'), 1_000), false, 'success cleared the cooldown');
});

test('keyHealth: failures are recorded with cooldown', async () => {
    health._reset();
    await assert.rejects(
        rotateProfiles('openai', async () => { const e = new Error('quota'); e.status = 402; throw e; },
            { env: { OPENAI_API_KEY: 'soloKey' }, keyHealth: true, now: 0 }),
        /quota/,
    );
    const st = health.statusOf(health.fingerprint('soloKey'), 0);
    assert.equal(st.healthy, false);
    assert.equal(st.lastReason, 'quota');
    assert.ok(st.cooldownMsLeft > 0);
});

test('default path (no keyHealth) does NOT touch the health store', async () => {
    health._reset();
    await rotateProfiles('openai', async () => 'ok', { env: { OPENAI_API_KEY: 'untrackedKey' } });
    assert.equal(health.snapshot(0).tracked, 0, 'health store untouched without opts.keyHealth');
});

test('listProfiles attaches a stable fingerprint per key', () => {
    const profiles = listProfiles('openai', { OPENAI_API_KEY: 'abc', OPENAI_API_KEY_2: 'def' });
    assert.match(profiles[0].fingerprint, /^[0-9a-f]{12}$/);
    assert.notEqual(profiles[0].fingerprint, profiles[1].fingerprint);
    assert.equal(profiles[0].fingerprint, health.fingerprint('abc'));
});
