'use strict';

/**
 * Focused unit test for two-fa-sms.verifyChallenge's brute-force counter.
 *
 * The counter used to be read→+1→absolute-write, so concurrent wrong-code
 * submissions all read the same `attempts` and each wrote the same +1 — a
 * lost-update that let a parallel-guess burst slip past MAX_VERIFY_ATTEMPTS.
 * It now uses an atomic `{ increment: 1 }`. This test drives the service
 * directly (no router/DB/env) with a fake prisma whose findUnique returns a
 * snapshot (as a real DB row read would) and whose update honours increment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const twoFASms = require('../src/services/two-fa-sms');

function makeFakeChallengeDb(challenge) {
  return {
    twoFAChallenge: {
      // Return a snapshot copy — a real findUnique hands back the row as read,
      // not a live reference, which is exactly what makes the lost-update real.
      findUnique: async ({ where }) =>
        (where.challengeId === challenge.challengeId ? { ...challenge } : null),
      update: async ({ data }) => {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && typeof v.increment === 'number') {
            challenge[k] = (challenge[k] || 0) + v.increment;
          } else {
            challenge[k] = v;
          }
        }
        return { ...challenge };
      },
    },
  };
}

test('verifyChallenge: a single wrong code increments attempts by exactly 1', async () => {
  const challengeId = twoFASms.mintChallengeId();
  const challenge = {
    id: 'c1', challengeId, attempts: 0, consumedAt: null,
    expiresAt: new Date(Date.now() + 600000),
    codeHash: await twoFASms.hashCode('999999'),
  };
  const prisma = makeFakeChallengeDb(challenge);

  const res = await twoFASms.verifyChallenge(prisma, challengeId, '000000');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invalid_code');
  assert.equal(res.attempts, 1);
  assert.equal(challenge.attempts, 1);
});

test('verifyChallenge: concurrent wrong codes increment atomically and trip the cap', async () => {
  const challengeId = twoFASms.mintChallengeId();
  const challenge = {
    id: 'c1', challengeId, attempts: 0, consumedAt: null,
    expiresAt: new Date(Date.now() + 600000),
    codeHash: await twoFASms.hashCode('999999'),
  };
  const prisma = makeFakeChallengeDb(challenge);
  const MAX = twoFASms.MAX_VERIFY_ATTEMPTS;

  // All MAX requests read attempts=0 (snapshot) then each increments. With the
  // old absolute write they'd all land on 1, leaving the cap un-tripped; the
  // atomic increment must reach MAX and consume the challenge.
  const results = await Promise.all(
    Array.from({ length: MAX }, () => twoFASms.verifyChallenge(prisma, challengeId, '000000')),
  );

  assert.equal(challenge.attempts, MAX, 'counter reached the cap (atomic, not stuck at 1)');
  assert.ok(challenge.consumedAt instanceof Date, 'challenge consumed once the cap was hit');
  assert.ok(results.every((r) => r.ok === false), 'every wrong-code attempt rejected');
  // A subsequent attempt is now locked out.
  const after = await twoFASms.verifyChallenge(prisma, challengeId, '000000');
  assert.equal(after.code, 'not_found'); // consumedAt set → treated as not-found
});
