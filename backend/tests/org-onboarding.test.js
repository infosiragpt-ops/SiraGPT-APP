/**
 * org-onboarding — default checklist + progress probing (cycle 45).
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultSteps, computeProgress, STEPS } = require('../src/services/org-onboarding');

describe('defaultSteps', () => {
  test('emits one step per registered descriptor', () => {
    const steps = defaultSteps();
    assert.equal(steps.length, STEPS.length);
    for (const s of steps) {
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.label, 'string');
      assert.equal(s.completed, false);
    }
  });

  test('includes invite_team and configure_billing', () => {
    const ids = defaultSteps().map((s) => s.id);
    assert.ok(ids.includes('invite_team'));
    assert.ok(ids.includes('configure_billing'));
  });
});

describe('computeProgress', () => {
  function makePrisma({ memberCount = 1, plan = 'FREE', stripeCustomerId = null, chats = 0, integrations = 0, userName = '' } = {}) {
    return {
      orgMembership: { async count() { return memberCount; } },
      organization: { async findUnique() { return { billingPlan: plan, stripeCustomerId, ownerId: 'o1' }; } },
      orgChat: { async count() { return chats; } },
      orgIntegration: { async count() { return integrations; } },
      user: { async findUnique() { return { name: userName, email: 'x@y.z' }; } },
    };
  }

  test('returns empty default when orgId missing', async () => {
    const r = await computeProgress({ prisma: {}, orgId: null });
    assert.equal(r.steps.length, STEPS.length);
    assert.equal(r.completedCount, 0);
  });

  test('marks completed steps correctly on a fully-onboarded org', async () => {
    const prisma = makePrisma({
      memberCount: 4,
      plan: 'PRO',
      stripeCustomerId: 'cus_123',
      chats: 2,
      integrations: 1,
      userName: 'Jorge',
    });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s.completed]));
    assert.equal(byId.invite_team, true);
    assert.equal(byId.configure_billing, true);
    assert.equal(byId.share_first_chat, true);
    assert.equal(byId.connect_integration, true);
    assert.equal(byId.set_owner_profile, true);
    assert.equal(r.completedCount, STEPS.length);
  });

  test('keeps all incomplete on a fresh org', async () => {
    const prisma = makePrisma();
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    assert.equal(r.completedCount, 0);
  });

  test('isolates probe failures (one throwing step does not poison others)', async () => {
    const prisma = makePrisma({ memberCount: 5 });
    // Make orgChat.count throw.
    prisma.orgChat.count = async () => { throw new Error('chat table missing'); };
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const invite = r.steps.find((s) => s.id === 'invite_team');
    const chats = r.steps.find((s) => s.id === 'share_first_chat');
    assert.equal(invite.completed, true);
    assert.equal(chats.completed, false);
    assert.ok(chats._probeError);
  });
});
