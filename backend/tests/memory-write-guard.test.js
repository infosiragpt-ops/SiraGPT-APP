'use strict';

const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/services/agents/memory-write-guard');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const curated = require('../src/services/agents/hermes-curated-memory');
const activeMemory = require('../src/services/active-memory');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');

const USER_A = 'mem-guard-user-a';
const USER_B = 'mem-guard-user-b';
const T0 = Date.parse('2026-09-07T12:00:00.000Z');

function memoryTool() {
  return buildHermesTools().find((tool) => tool.name === 'memory');
}

beforeEach(() => {
  guard.resetMemoryWriteGuardForTests();
  curated.resetForTests();
  curated.clearUser(USER_A);
  curated.clearUser(USER_B);
  activeMemory.clearUserMemory(USER_A);
  activeMemory.clearUserMemory(USER_B);
});

describe('memory write guard — size and rate', () => {
  test('oversized fact fails closed with Spanish E_PARAMS', () => {
    const huge = 'x'.repeat(guard.FACT_MAX_CHARS + 1);
    const result = guard.checkMemoryWrite(USER_A, huge, { rateLimit: false });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PARAMS');
    assert.equal(result.status, 400);
    assert.match(result.error, /supera el l[ií]mite de 2000 caracteres/);
    assert.match(result.error, /Acórtalo o sustituye/);
    assert.equal(result.error.includes('sk-'), false);
  });

  test('write flood fails closed with Spanish E_QUOTA and retryAfterMs', () => {
    for (let i = 0; i < 2; i += 1) {
      const ok = guard.checkMemoryWrite(USER_A, `dato ${i}`, {
        now: T0 + i,
        maxWrites: 2,
        windowMs: 60_000,
      });
      assert.equal(ok.ok, true);
    }
    const denied = guard.checkMemoryWrite(USER_A, 'dato extra', {
      now: T0 + 10,
      maxWrites: 2,
      windowMs: 60_000,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'E_QUOTA');
    assert.equal(denied.status, 429);
    assert.ok(denied.retryAfterMs > 0);
    assert.match(denied.error, /demasiadas veces este minuto/);
    assert.match(denied.error, /Espera unos \d+ segundos/);
  });

  test('user A hitting the cap does not block user B', () => {
    for (let i = 0; i < 2; i += 1) {
      assert.equal(guard.checkMemoryWrite(USER_A, `a${i}`, { now: T0, maxWrites: 2 }).ok, true);
    }
    assert.equal(guard.checkMemoryWrite(USER_A, 'a-blocked', { now: T0, maxWrites: 2 }).ok, false);
    const other = guard.checkMemoryWrite(USER_B, 'b-ok', { now: T0, maxWrites: 2 });
    assert.equal(other.ok, true);
  });

  test('assertMemoryWrite throws MemoryWriteError', () => {
    assert.throws(
      () => guard.assertMemoryWrite(USER_A, 'x'.repeat(guard.FACT_MAX_CHARS + 8)),
      (err) => guard.isMemoryWriteError(err) && err.code === 'E_PARAMS',
    );
  });
});

describe('active-memory and Hermes remember — write gates', () => {
  test('createMemoryEntry rejects an oversized fact and stores nothing', () => {
    assert.throws(
      () => activeMemory.createMemoryEntry(USER_A, 'y'.repeat(guard.FACT_MAX_CHARS + 20)),
      (err) => guard.isMemoryWriteError(err) && err.code === 'E_PARAMS',
    );
    const leftover = activeMemory.recall(USER_A, null, { limit: 20, bump: false });
    assert.equal(Array.isArray(leftover) ? leftover.length : 0, 0);
  });

  test('remember rate-limits and surfaces Spanish E_QUOTA', () => {
    memoryBridge.remember(USER_A, 'Prefiere tablas', { now: T0, maxWrites: 1 });
    assert.throws(
      () => memoryBridge.remember(USER_A, 'Prefiere listas', { now: T0 + 5, maxWrites: 1 }),
      (err) => {
        assert.equal(guard.isMemoryWriteError(err), true);
        assert.equal(err.code, 'E_QUOTA');
        assert.match(err.message, /demasiadas veces este minuto/);
        return true;
      },
    );
  });

  test('memory tool remember returns ok:false without throwing', async () => {
    const tool = memoryTool();
    const first = await tool.execute({ action: 'remember', fact: 'z'.repeat(guard.FACT_MAX_CHARS + 3) }, { userId: USER_A });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'E_PARAMS');
    assert.match(first.error, /supera el l[ií]mite/);
    assert.equal(JSON.stringify(first).includes('sk-'), false);
  });
});

describe('curated MEMORY/USER — Spanish overflow and rate-limit', () => {
  test('store overflow returns E_PARAMS in Spanish', () => {
    const chunk = 'n'.repeat(800);
    assert.equal(curated.add(USER_A, { target: 'memory', content: `${chunk}-1` }).ok, true);
    assert.equal(curated.add(USER_A, { target: 'memory', content: `${chunk}-2` }).ok, true);
    const overflow = curated.add(USER_A, { target: 'memory', content: `${chunk}-3` });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.code, 'E_PARAMS');
    assert.match(overflow.error, /La memoria est[aá] en \d+\/\d+ caracteres/);
    assert.match(overflow.error, /Sustituye o elimina/);
  });

  test('curated add rate-limit is per user', () => {
    const a1 = curated.add(USER_A, { target: 'user', content: 'Habla en español.', now: T0, maxWrites: 1 });
    assert.equal(a1.ok, true);
    const a2 = curated.add(USER_A, { target: 'user', content: 'Usa markdown.', now: T0 + 1, maxWrites: 1 });
    assert.equal(a2.ok, false);
    assert.equal(a2.code, 'E_QUOTA');
    assert.match(a2.error, /demasiadas veces este minuto/);

    const b1 = curated.add(USER_B, { target: 'user', content: 'Habla en español.', now: T0, maxWrites: 1 });
    assert.equal(b1.ok, true);
    const foreign = curated.read(USER_B, { target: 'user' });
    assert.ok(foreign.entries.includes('Habla en español.'));
    const own = curated.read(USER_A, { target: 'user' });
    assert.equal(own.entries.includes('Usa markdown.'), false);
  });
});
