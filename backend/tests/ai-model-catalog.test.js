'use strict';

/**
 * Tests for services/ai-model-catalog.js — the in-memory serving layer behind
 * `GET /api/ai/models` (per-scope snapshot, single-flight, invalidation,
 * boot warm-up). Everything runs with a fake Prisma client; no DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AiModelCatalogSnapshot,
  buildPickerWhereClause,
  pickerScopeKey,
  loadPickerRows,
  invalidateAiModelCatalog,
  warmAiModelCatalog,
  resolveTtlMs,
  isSnapshotDisabled,
  DEFAULT_TTL_MS,
  PICKER_SELECT,
} = require('../src/services/ai-model-catalog');
const { globalLRU } = require('../src/middleware/response-cache');

function fakePrisma(rowsByScope = {}, options = {}) {
  const calls = [];
  return {
    calls,
    aiModel: {
      async findMany(args) {
        calls.push(args);
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        if (options.failTimes && calls.length <= options.failTimes) throw new Error('db down');
        const type = args?.where?.type;
        const key = type == null ? 'ALL' : typeof type === 'string' ? type : 'TEXT_IMAGE';
        return (rowsByScope[key] || []).map((row) => ({ ...row }));
      },
    },
  };
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

// ── scope + where-clause contract ──────────────────────────────────────────

test('buildPickerWhereClause keeps the historical route semantics', () => {
  assert.deepEqual(buildPickerWhereClause(''), { isActive: true });
  assert.deepEqual(buildPickerWhereClause('VIDEO'), { isActive: true, type: 'VIDEO' });
  assert.deepEqual(buildPickerWhereClause('MUSIC'), { isActive: true, type: 'MUSIC' });
  // VOICE is the Voz chip alias for the Admin-active AUDIO (TTS) rows.
  assert.deepEqual(buildPickerWhereClause('VOICE'), { isActive: true, type: 'AUDIO' });
  assert.deepEqual(buildPickerWhereClause('audio'), { isActive: true, type: 'AUDIO' });
  // TEXT and IMAGE share one read (legacy rows of either type are curated in JS).
  assert.deepEqual(buildPickerWhereClause('TEXT'), { isActive: true, type: { in: ['TEXT', 'IMAGE'] } });
  assert.deepEqual(buildPickerWhereClause('IMAGE'), { isActive: true, type: { in: ['TEXT', 'IMAGE'] } });
});

test('pickerScopeKey collapses aliases onto one snapshot entry', () => {
  assert.equal(pickerScopeKey(''), 'ALL');
  assert.equal(pickerScopeKey(undefined), 'ALL');
  assert.equal(pickerScopeKey('VOICE'), 'AUDIO');
  assert.equal(pickerScopeKey('AUDIO'), 'AUDIO');
  assert.equal(pickerScopeKey('TEXT'), 'TEXT_IMAGE');
  assert.equal(pickerScopeKey('image'), 'TEXT_IMAGE');
  assert.equal(pickerScopeKey('VIDEO'), 'VIDEO');
});

test('PICKER_SELECT is the exact column set the public payload always had', () => {
  assert.deepEqual(Object.keys(PICKER_SELECT).sort(), [
    'contextLength', 'description', 'displayName', 'icon', 'id', 'isActive', 'name', 'provider', 'type',
  ]);
});

// ── snapshot primitive ─────────────────────────────────────────────────────

test('snapshot: hit within TTL, reload after expiry, per-scope isolation', async () => {
  const c = clock();
  const snap = new AiModelCatalogSnapshot({ now: c.now, ttlMs: 10_000, env: {} });
  let loads = 0;
  const loader = (scope) => async () => { loads += 1; return [{ name: `${scope}-${loads}` }]; };

  const a1 = await snap.get('VIDEO', loader('VIDEO'));
  const a2 = await snap.get('VIDEO', loader('VIDEO'));
  assert.equal(loads, 1, 'second read inside the TTL is a hit');
  assert.equal(a1, a2, 'hits return the same rows reference');

  await snap.get('MUSIC', loader('MUSIC'));
  assert.equal(loads, 2, 'a different scope loads on its own');

  c.advance(10_001);
  const a3 = await snap.get('VIDEO', loader('VIDEO'));
  assert.equal(loads, 3, 'expired entry reloads');
  assert.notEqual(a3, a1);
  const stats = snap.snapshotStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 3);
  assert.equal(stats.scopes.VIDEO.rows, 1);
});

test('snapshot: concurrent readers of one scope share a single load', async () => {
  const snap = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [{ name: 'shared' }];
  };
  const [x, y, z] = await Promise.all([snap.get('VIDEO', loader), snap.get('VIDEO', loader), snap.get('VIDEO', loader)]);
  assert.equal(loads, 1);
  assert.equal(x, y);
  assert.equal(y, z);
  assert.equal(snap.snapshotStats().coalesced, 2);
});

test('snapshot: failures are never memoised and propagate to every waiter', async () => {
  const snap = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  let attempts = 0;
  const loader = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (attempts === 1) throw new Error('transient');
    return [{ name: 'ok' }];
  };
  const results = await Promise.allSettled([snap.get('ALL', loader), snap.get('ALL', loader)]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(attempts, 1, 'the two concurrent callers shared the failing load');
  const rows = await snap.get('ALL', loader);
  assert.equal(rows[0].name, 'ok');
  assert.equal(attempts, 2);
  assert.equal(snap.snapshotStats().errors, 1);
});

test('snapshot: invalidate drops entries and a load that started before the write is not stored', async () => {
  const snap = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let loads = 0;
  const slowLoader = async () => { loads += 1; await gate; return [{ name: 'pre-write' }]; };
  const pending = snap.get('VIDEO', slowLoader);
  // Admin writes while the read is in flight.
  snap.invalidate();
  release();
  const rows = await pending;
  assert.equal(rows[0].name, 'pre-write', 'the in-flight caller still gets its rows');
  assert.equal(snap.snapshotStats().scopes.VIDEO, undefined, 'stale rows must not repopulate the snapshot');
  await snap.get('VIDEO', async () => { loads += 1; return [{ name: 'post-write' }]; });
  assert.equal(loads, 2, 'the next reader loads fresh rows');
  assert.equal(snap.snapshotStats().scopes.VIDEO.rows, 1);
});

test('snapshot: single-scope invalidate leaves the other scopes intact', async () => {
  const snap = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  await snap.get('VIDEO', async () => [{ name: 'v' }]);
  await snap.get('MUSIC', async () => [{ name: 'm' }]);
  assert.equal(snap.invalidate('VIDEO'), 1);
  const stats = snap.snapshotStats();
  assert.equal(stats.scopes.VIDEO, undefined);
  assert.equal(stats.scopes.MUSIC.rows, 1);
});

test('snapshot: kill switch bypasses storage but still serves rows', async () => {
  const snap = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: { SIRAGPT_AI_MODEL_CATALOG_CACHE_DISABLED: '1' } });
  let loads = 0;
  const loader = async () => { loads += 1; return [{ name: 'x' }]; };
  await snap.get('VIDEO', loader);
  await snap.get('VIDEO', loader);
  assert.equal(loads, 2);
  assert.equal(snap.snapshotStats().disabled, true);
  assert.deepEqual(snap.snapshotStats().scopes, {});
});

test('resolveTtlMs / isSnapshotDisabled read and clamp the env', () => {
  assert.equal(resolveTtlMs({}), DEFAULT_TTL_MS);
  assert.equal(resolveTtlMs({ SIRAGPT_AI_MODEL_CATALOG_TTL_MS: 'nope' }), DEFAULT_TTL_MS);
  assert.equal(resolveTtlMs({ SIRAGPT_AI_MODEL_CATALOG_TTL_MS: '5' }), 1_000, 'floor at 1 s');
  assert.equal(resolveTtlMs({ SIRAGPT_AI_MODEL_CATALOG_TTL_MS: '999999999' }), 60 * 60_000, 'ceiling at 1 h');
  assert.equal(resolveTtlMs({}, 2_500), 2_500, 'explicit override wins');
  assert.equal(isSnapshotDisabled({}), false);
  assert.equal(isSnapshotDisabled({ SIRAGPT_AI_MODEL_CATALOG_CACHE_DISABLED: 'true' }), true);
  assert.equal(isSnapshotDisabled({ SIRAGPT_AI_MODEL_CATALOG_CACHE_DISABLED: '0' }), false);
});

// ── loadPickerRows ─────────────────────────────────────────────────────────

test('loadPickerRows issues the historical findMany and serves clones from the snapshot', async () => {
  const prisma = fakePrisma({ VIDEO: [{ id: '1', name: 'fal-ai/veo3.1', type: 'VIDEO', isActive: true }] });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });

  const first = await loadPickerRows({ prisma, type: 'VIDEO', snapshot });
  const second = await loadPickerRows({ prisma, type: 'video', snapshot });
  assert.equal(prisma.calls.length, 1, 'same scope → one DB read');
  assert.deepEqual(prisma.calls[0], {
    where: { isActive: true, type: 'VIDEO' },
    select: { ...PICKER_SELECT },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(first, second);
  assert.notEqual(first[0], second[0], 'callers get their own copies');
  first[0].name = 'mutated-by-a-request';
  const third = await loadPickerRows({ prisma, type: 'VIDEO', snapshot });
  assert.equal(third[0].name, 'fal-ai/veo3.1', 'per-request curation never leaks into the snapshot');
});

test('loadPickerRows: VOICE and AUDIO, TEXT and IMAGE share one read each', async () => {
  const prisma = fakePrisma({ AUDIO: [{ id: 'a', name: 'tts' }], TEXT_IMAGE: [{ id: 't', name: 'txt' }] });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  await loadPickerRows({ prisma, type: 'VOICE', snapshot });
  await loadPickerRows({ prisma, type: 'AUDIO', snapshot });
  await loadPickerRows({ prisma, type: 'TEXT', snapshot });
  await loadPickerRows({ prisma, type: 'IMAGE', snapshot });
  assert.equal(prisma.calls.length, 2);
});

test('loadPickerRows: bypass forces a DB read without touching the snapshot', async () => {
  const prisma = fakePrisma({ VIDEO: [{ id: '1', name: 'v' }] });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  await loadPickerRows({ prisma, type: 'VIDEO', snapshot });
  await loadPickerRows({ prisma, type: 'VIDEO', snapshot, bypass: true });
  assert.equal(prisma.calls.length, 2);
  assert.equal(snapshot.snapshotStats().scopes.VIDEO.rows, 1);
});

test('loadPickerRows rejects a client without aiModel.findMany', async () => {
  await assert.rejects(() => loadPickerRows({ prisma: {}, type: 'VIDEO' }), TypeError);
});

// ── invalidation helper ────────────────────────────────────────────────────

test('invalidateAiModelCatalog clears the snapshot AND the ai-models response-cache namespace', async () => {
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  await snapshot.get('VIDEO', async () => [{ name: 'v' }]);
  globalLRU.set('ai-models::anon::GET::/api/ai/models?type=VIDEO', { status: 200, body: '{}', expiresAt: Date.now() + 60_000, storedAt: Date.now() });
  globalLRU.set('other-ns::anon::GET::/api/other', { status: 200, body: '{}', expiresAt: Date.now() + 60_000, storedAt: Date.now() });

  const result = invalidateAiModelCatalog({ snapshot, reason: 'test' });
  assert.equal(result.removedRows, 1);
  assert.equal(result.removedResponses, 1);
  assert.equal(result.reason, 'test');
  assert.deepEqual(snapshot.snapshotStats().scopes, {});
  assert.equal(globalLRU.get('ai-models::anon::GET::/api/ai/models?type=VIDEO'), null);
  assert.ok(globalLRU.get('other-ns::anon::GET::/api/other'), 'other namespaces are untouched');
  globalLRU.delete('other-ns::anon::GET::/api/other');
});

// ── boot warm-up ───────────────────────────────────────────────────────────

test('warmAiModelCatalog ensures the static catalog once and primes every picker scope', async () => {
  const prisma = fakePrisma({ TEXT_IMAGE: [{ name: 't' }], VIDEO: [{ name: 'v' }], AUDIO: [{ name: 'a' }], MUSIC: [{ name: 'm' }] });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  const ensureCalls = [];
  const modelSyncService = {
    async ensureStaticCatalogModelsCached(options) {
      ensureCalls.push(options);
      return { skipped: false, created: 0, updated: 0 };
    },
  };
  const logs = [];
  const logger = { info: (obj, msg) => logs.push(['info', msg, obj]), warn: (obj, msg) => logs.push(['warn', msg, obj]) };

  const summary = await warmAiModelCatalog({ prisma, modelSyncService, snapshot, logger });
  assert.deepEqual(ensureCalls, [{ types: ['IMAGE', 'VIDEO', 'AUDIO', 'MUSIC'] }]);
  assert.deepEqual(summary.primed.sort(), ['AUDIO', 'MUSIC', 'TEXT_IMAGE', 'VIDEO']);
  assert.deepEqual(summary.errors, []);
  assert.equal(prisma.calls.length, 4);
  assert.equal(logs[0][1], 'ai_model_catalog_warmup_complete');
  // The picker's first read after boot is now a hit.
  await loadPickerRows({ prisma, type: 'VIDEO', snapshot });
  assert.equal(prisma.calls.length, 4);
});

test('warmAiModelCatalog invalidates the snapshot when the static sync changed rows', async () => {
  const prisma = fakePrisma({ VIDEO: [{ name: 'v' }] });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  await snapshot.get('VIDEO', async () => [{ name: 'stale' }]);
  const modelSyncService = { async ensureStaticCatalogModelsCached() { return { created: 2, updated: 0 }; } };
  await warmAiModelCatalog({ prisma, modelSyncService, snapshot, logger: { info() {}, warn() {} }, types: ['VIDEO'] });
  const rows = await loadPickerRows({ prisma, type: 'VIDEO', snapshot });
  assert.equal(rows[0].name, 'v', 'stale pre-sync rows were dropped before priming');
});

test('warmAiModelCatalog is best-effort: a failing DB or sync never throws', async () => {
  const prisma = fakePrisma({}, { failTimes: 99 });
  const snapshot = new AiModelCatalogSnapshot({ ttlMs: 10_000, env: {} });
  const modelSyncService = { async ensureStaticCatalogModelsCached() { throw new Error('fal.ai unreachable'); } };
  const logs = [];
  const logger = { info: (obj, msg) => logs.push(msg), warn: (obj, msg) => logs.push(msg) };
  const summary = await warmAiModelCatalog({ prisma, modelSyncService, snapshot, logger, types: ['VIDEO'] });
  assert.ok(summary.errors.some((e) => e.startsWith('ensure:')));
  assert.ok(summary.errors.some((e) => e.startsWith('VIDEO:')));
  assert.deepEqual(summary.primed, []);
  assert.equal(logs[0], 'ai_model_catalog_warmup_partial');
});
