/**
 * Tests for services/sira/session-actor-queue.js — per-key serialized
 * actor queue for chat-turn operations.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createSessionActorQueue,
  buildChatTurnActorKey,
  INTERNAL,
} = require('../src/services/sira/session-actor-queue');

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── INTERNAL helpers ──────────────────────────────────────────

describe('INTERNAL.normalizeActorKey', () => {
  it('trims whitespace', () => {
    assert.equal(INTERNAL.normalizeActorKey('  key  '), 'key');
  });

  it('falsy/empty input falls back to canonical anonymous key', () => {
    const fallback = 'sira-chat:anonymous:unknown-conversation';
    assert.equal(INTERNAL.normalizeActorKey(null), fallback);
    assert.equal(INTERNAL.normalizeActorKey(undefined), fallback);
    assert.equal(INTERNAL.normalizeActorKey(''), fallback);
    assert.equal(INTERNAL.normalizeActorKey('   '), fallback);
  });

  it('passes through valid keys', () => {
    assert.equal(INTERNAL.normalizeActorKey('user-1:conv-2'), 'user-1:conv-2');
  });
});

describe('INTERNAL.normalizeKeyPart', () => {
  it('lowercases input', () => {
    assert.equal(INTERNAL.normalizeKeyPart('UserABC'), 'userabc');
  });

  it('replaces non-allowed chars with "_"', () => {
    assert.equal(INTERNAL.normalizeKeyPart('user@!#$%'), 'user');
    assert.equal(INTERNAL.normalizeKeyPart('a/b\\c'), 'a_b_c');
  });

  it('keeps allowed chars (a-z, 0-9, _, ., :, -)', () => {
    assert.equal(INTERNAL.normalizeKeyPart('a.b:c-d_e'), 'a.b:c-d_e');
    assert.equal(INTERNAL.normalizeKeyPart('user_42'), 'user_42');
  });

  it('strips leading/trailing underscores', () => {
    assert.equal(INTERNAL.normalizeKeyPart('___user___'), 'user');
  });

  it('empty / falsy → "unknown"', () => {
    assert.equal(INTERNAL.normalizeKeyPart(null), 'unknown');
    assert.equal(INTERNAL.normalizeKeyPart(''), 'unknown');
    assert.equal(INTERNAL.normalizeKeyPart('   '), 'unknown');
  });

  it('coerces non-strings', () => {
    assert.equal(INTERNAL.normalizeKeyPart(42), '42');
  });

  it('all-special-chars input → "unknown" after strip', () => {
    assert.equal(INTERNAL.normalizeKeyPart('!!!'), 'unknown');
  });
});

// ── buildChatTurnActorKey ─────────────────────────────────────

describe('buildChatTurnActorKey', () => {
  it('joins prefix:userId:conversationId', () => {
    const out = buildChatTurnActorKey({ userId: 'u-1', conversationId: 'c-2' });
    assert.equal(out, 'sira-chat:u-1:c-2');
  });

  it('defaults to "anonymous" / "unknown-conversation" when missing', () => {
    const out = buildChatTurnActorKey({});
    assert.equal(out, 'sira-chat:anonymous:unknown-conversation');
  });

  it('normalises both parts (lowercase + special chars)', () => {
    const out = buildChatTurnActorKey({ userId: 'User@1!', conversationId: 'Conv$2' });
    assert.equal(out, 'sira-chat:user_1:conv_2');
  });

  it('handles missing args entirely', () => {
    assert.equal(buildChatTurnActorKey(), 'sira-chat:anonymous:unknown-conversation');
  });
});

// ── createSessionActorQueue · run ─────────────────────────────

describe('createSessionActorQueue · run', () => {
  it('throws when operation is not a function', () => {
    const q = createSessionActorQueue();
    assert.throws(() => q.run('actor-1', null), /operation function required/);
  });

  it('returns the operation result', async () => {
    const q = createSessionActorQueue();
    const out = await q.run('actor-1', async () => 'result');
    assert.equal(out, 'result');
  });

  it('passes { actorKey, jobId } to operation', async () => {
    const q = createSessionActorQueue();
    let captured;
    await q.run('actor-1', async (args) => { captured = args; });
    assert.equal(captured.actorKey, 'actor-1');
    assert.match(captured.jobId, /^actor-1#\d+$/);
  });

  it('serialises operations for the SAME actor', async () => {
    const q = createSessionActorQueue();
    const order = [];
    const gate1 = defer();
    const gate2 = defer();
    const p1 = q.run('actor', async () => {
      order.push('1-start');
      await gate1.promise;
      order.push('1-end');
    });
    const p2 = q.run('actor', async () => {
      order.push('2-start');
      await gate2.promise;
      order.push('2-end');
    });
    // Let microtasks run so #1 starts.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(order, ['1-start']);
    gate1.resolve();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(order, ['1-start', '1-end', '2-start']);
    gate2.resolve();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs operations from DIFFERENT actors concurrently', async () => {
    const q = createSessionActorQueue();
    const gate = defer();
    let started1 = false, started2 = false;
    const p1 = q.run('actor-1', async () => {
      started1 = true;
      await gate.promise;
    });
    const p2 = q.run('actor-2', async () => {
      started2 = true;
      await gate.promise;
    });
    await new Promise(r => setImmediate(r));
    assert.ok(started1 && started2, 'both actors should start concurrently');
    gate.resolve();
    await Promise.all([p1, p2]);
  });

  it('propagates operation rejection to caller', async () => {
    const q = createSessionActorQueue();
    await assert.rejects(
      () => q.run('actor', async () => { throw new Error('op fail'); }),
      /op fail/,
    );
  });

  it('rejected operation does NOT poison subsequent jobs for the actor', async () => {
    const q = createSessionActorQueue();
    const first = q.run('actor', async () => { throw new Error('bad'); });
    await assert.rejects(first);
    const second = await q.run('actor', async () => 'recovered');
    assert.equal(second, 'recovered');
  });

  it('normalises actor key on the way in', async () => {
    const q = createSessionActorQueue();
    const out = await q.run('  Some Key  ', async ({ actorKey }) => actorKey);
    // normalizeActorKey only trims whitespace; preserves case.
    assert.equal(out, 'Some Key');
  });

  it('falsy actor key collapses to anonymous fallback', async () => {
    const q = createSessionActorQueue();
    const out = await q.run('', async ({ actorKey }) => actorKey);
    assert.equal(out, 'sira-chat:anonymous:unknown-conversation');
  });
});

// ── pending / running counters ────────────────────────────────

describe('createSessionActorQueue · counters', () => {
  it('getPendingCountForActor + getTotalPendingCount track pending jobs', async () => {
    const q = createSessionActorQueue();
    const gate = defer();
    const p1 = q.run('actor', async () => { await gate.promise; });
    const p2 = q.run('actor', async () => { await gate.promise; });
    const p3 = q.run('other', async () => { await gate.promise; });
    assert.equal(q.getPendingCountForActor('actor'), 2);
    assert.equal(q.getPendingCountForActor('other'), 1);
    assert.equal(q.getTotalPendingCount(), 3);
    gate.resolve();
    await Promise.all([p1, p2, p3]);
    assert.equal(q.getTotalPendingCount(), 0);
  });

  it('getRunningCountForActor reflects in-flight count', async () => {
    const q = createSessionActorQueue();
    const gate = defer();
    let runningCount = 0;
    const p = q.run('actor', async () => {
      runningCount = q.getRunningCountForActor('actor');
      await gate.promise;
    });
    await new Promise(r => setImmediate(r));
    assert.equal(runningCount, 1);
    gate.resolve();
    await p;
    // After finish, count is back to 0.
    assert.equal(q.getRunningCountForActor('actor'), 0);
  });

  it('unknown actor → counts of 0', () => {
    const q = createSessionActorQueue();
    assert.equal(q.getPendingCountForActor('nobody'), 0);
    assert.equal(q.getRunningCountForActor('nobody'), 0);
  });
});

// ── snapshot ──────────────────────────────────────────────────

describe('createSessionActorQueue · snapshot', () => {
  it('returns active_actors + total_pending + per-actor maps', async () => {
    const q = createSessionActorQueue();
    const gate = defer();
    const p1 = q.run('a', async () => { await gate.promise; });
    const p2 = q.run('a', async () => { await gate.promise; });
    const p3 = q.run('b', async () => { await gate.promise; });
    const snap = q.snapshot();
    assert.equal(snap.active_actors, 2);
    assert.equal(snap.total_pending, 3);
    assert.equal(snap.pending_by_actor.a, 2);
    assert.equal(snap.pending_by_actor.b, 1);
    gate.resolve();
    await Promise.all([p1, p2, p3]);
  });

  it('empty queue → zero everything', () => {
    const q = createSessionActorQueue();
    const snap = q.snapshot();
    assert.equal(snap.active_actors, 0);
    assert.equal(snap.total_pending, 0);
    assert.deepEqual(snap.pending_by_actor, {});
    assert.deepEqual(snap.running_by_actor, {});
  });

  it('reflects running_by_actor when an op is mid-flight', async () => {
    const q = createSessionActorQueue();
    const gate = defer();
    const p = q.run('actor', async () => { await gate.promise; });
    await new Promise(r => setImmediate(r));
    const snap = q.snapshot();
    assert.equal(snap.running_by_actor.actor, 1);
    gate.resolve();
    await p;
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/sira/session-actor-queue');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['INTERNAL', 'buildChatTurnActorKey', 'createSessionActorQueue']);
  });
});
