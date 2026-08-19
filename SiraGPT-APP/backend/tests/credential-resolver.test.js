'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createCredentialResolver,
  envSource,
  mapSource,
  functionSource,
  DEFAULT_TTL_MS,
} = require('../src/services/credentials/credential-resolver');

describe('source helpers', () => {
  test('envSource returns env value or null', () => {
    const s = envSource({ K: 'v', EMPTY: '' });
    assert.equal(s('K'), 'v');
    assert.equal(s('EMPTY'), null);
    assert.equal(s('MISSING'), null);
    assert.equal(s(''), null);
    assert.equal(s._sourceLabel, 'env');
  });

  test('mapSource returns map value or null', () => {
    const s = mapSource({ A: 'one' });
    assert.equal(s('A'), 'one');
    assert.equal(s('B'), null);
  });

  test('functionSource wraps with a label', () => {
    const s = functionSource((n) => `f:${n}`, 'vault');
    assert.equal(s('x'), 'f:x');
    assert.equal(s._sourceLabel, 'vault');
  });

  test('functionSource rejects non-function', () => {
    assert.throws(() => functionSource('nope'), TypeError);
  });
});

describe('createCredentialResolver — construction', () => {
  test('rejects when no sources provided', () => {
    assert.throws(() => createCredentialResolver({}), TypeError);
    assert.throws(() => createCredentialResolver({ sources: [] }), TypeError);
  });

  test('default TTL exposed', () => {
    const r = createCredentialResolver({ sources: [envSource({})] });
    assert.equal(r.snapshot().ttlMs, DEFAULT_TTL_MS);
  });
});

describe('createCredentialResolver — resolution chain', () => {
  test('walks sources in order; first non-empty wins', async () => {
    const r = createCredentialResolver({
      sources: [mapSource({}), mapSource({ K: 'a' }), mapSource({ K: 'b' })],
    });
    assert.equal(await r.resolve('K'), 'a');
  });

  test('returns null when nothing resolves', async () => {
    const r = createCredentialResolver({ sources: [mapSource({})] });
    assert.equal(await r.resolve('K'), null);
  });

  test('handles invalid name gracefully', async () => {
    const r = createCredentialResolver({ sources: [mapSource({})] });
    assert.equal(await r.resolve(''), null);
    assert.equal(await r.resolve(null), null);
  });

  test('async source is awaited', async () => {
    const r = createCredentialResolver({
      sources: [functionSource(async (n) => (n === 'X' ? 'async-v' : null), 'async-vault')],
    });
    assert.equal(await r.resolve('X'), 'async-v');
  });

  test('throwing source falls through', async () => {
    const r = createCredentialResolver({
      sources: [
        functionSource(() => { throw new Error('vault down'); }, 'broken'),
        mapSource({ K: 'fallback' }),
      ],
    });
    assert.equal(await r.resolve('K'), 'fallback');
  });
});

describe('createCredentialResolver — TTL cache', () => {
  test('cache hit avoids re-walking sources within TTL', async () => {
    let calls = 0;
    const r = createCredentialResolver({
      sources: [functionSource(() => { calls += 1; return 'v'; }, 'count')],
      ttlMs: 60_000,
      now: () => 0,
    });
    await r.resolve('K'); await r.resolve('K'); await r.resolve('K');
    assert.equal(calls, 1);
    assert.equal(r.snapshot().hits, 2);
    assert.equal(r.snapshot().misses, 1);
  });

  test('TTL expiry forces a re-walk', async () => {
    let calls = 0;
    let t = 0;
    const r = createCredentialResolver({
      sources: [functionSource(() => { calls += 1; return 'v'; }, 'count')],
      ttlMs: 100,
      now: () => t,
    });
    await r.resolve('K');
    t = 200;
    await r.resolve('K');
    assert.equal(calls, 2);
  });
});

describe('createCredentialResolver — rotation', () => {
  test('rotate(name) evicts only the named entry', async () => {
    let v = 'old';
    const r = createCredentialResolver({
      sources: [functionSource(() => v, 'live')],
      ttlMs: 60_000, now: () => 0,
    });
    await r.resolve('K');
    v = 'new';
    assert.equal(await r.resolve('K'), 'old'); // cached
    assert.equal(r.rotate('K'), true);
    assert.equal(await r.resolve('K'), 'new'); // rebuilt
    assert.equal(r.rotate('UNKNOWN'), false);
  });

  test('rotateAll() clears entire cache', async () => {
    const r = createCredentialResolver({
      sources: [mapSource({ A: '1', B: '2' })],
      ttlMs: 60_000, now: () => 0,
    });
    await r.resolve('A'); await r.resolve('B');
    assert.equal(r.rotateAll(), 2);
    assert.equal(r.snapshot().entries, 0);
  });
});

describe('createCredentialResolver — sync variant', () => {
  test('resolveSync skips async sources but uses sync ones', () => {
    const r = createCredentialResolver({
      sources: [
        functionSource(async () => 'async-v', 'async'),
        mapSource({ K: 'sync-v' }),
      ],
    });
    assert.equal(r.resolveSync('K'), 'sync-v');
  });

  test('resolveSync returns null when only async sources match', () => {
    const r = createCredentialResolver({
      sources: [functionSource(async () => 'async-v', 'async')],
    });
    assert.equal(r.resolveSync('K'), null);
  });
});

describe('createCredentialResolver — sinks', () => {
  test('onResolve fires with hit=true for cached, false for fresh', async () => {
    const events = [];
    const r = createCredentialResolver({
      sources: [mapSource({ K: 'v' })],
      ttlMs: 60_000, now: () => 0,
      onResolve: (e) => events.push(e),
    });
    await r.resolve('K');
    await r.resolve('K');
    assert.equal(events.length, 2);
    assert.equal(events[0].hit, false);
    assert.equal(events[1].hit, true);
    assert.equal(events[0].source, 'map');
  });

  test('onMiss fires when nothing resolves', async () => {
    const misses = [];
    const r = createCredentialResolver({
      sources: [mapSource({})],
      onMiss: (e) => misses.push(e.name),
    });
    await r.resolve('NOPE');
    assert.deepEqual(misses, ['NOPE']);
  });

  test('throwing sinks do not break resolution', async () => {
    const r = createCredentialResolver({
      sources: [mapSource({ K: 'v' })],
      onResolve: () => { throw new Error('s'); },
      onMiss: () => { throw new Error('m'); },
    });
    assert.equal(await r.resolve('K'), 'v');
    assert.equal(await r.resolve('MISSING'), null);
  });
});
