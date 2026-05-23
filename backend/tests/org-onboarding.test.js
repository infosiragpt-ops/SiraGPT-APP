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
  function makePrisma({
    memberCount = 1,
    plan = 'FREE',
    stripeCustomerId = null,
    chats = 0,
    integrations = 0,
    userName = '',
    acceptedLegal = false,
    twoFactorEnabled = false,
  } = {}) {
    return {
      orgMembership: { async count() { return memberCount; } },
      organization: { async findUnique() { return { billingPlan: plan, stripeCustomerId, ownerId: 'o1' }; } },
      orgChat: { async count() { return chats; } },
      orgIntegration: { async count() { return integrations; } },
      user: {
        async findUnique({ select } = {}) {
          if (select && select.settings) {
            return { settings: { twoFactorEnabled } };
          }
          return { name: userName, email: 'x@y.z', settings: { twoFactorEnabled } };
        },
      },
      policyAcceptance: {
        async findFirst() {
          return acceptedLegal ? { id: 'pa1', document: 'terms-of-service', version: 'latest' } : null;
        },
      },
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
      acceptedLegal: true,
      twoFactorEnabled: true,
    });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s.completed]));
    assert.equal(byId.invite_team, true);
    assert.equal(byId.configure_billing, true);
    assert.equal(byId.share_first_chat, true);
    assert.equal(byId.connect_integration, true);
    assert.equal(byId.set_owner_profile, true);
    assert.equal(byId.accept_legal, true);
    assert.equal(byId.enable_2fa, true);
    assert.equal(r.completedCount, STEPS.length);
  });

  test('accept_legal stays false when no PolicyAcceptance row exists', async () => {
    const prisma = makePrisma({ userName: 'Jorge', acceptedLegal: false });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const step = r.steps.find((s) => s.id === 'accept_legal');
    assert.equal(step.completed, false);
  });

  test('accept_legal flips true when PolicyAcceptance exists for terms-of-service@latest', async () => {
    const prisma = makePrisma({ userName: 'Jorge', acceptedLegal: true });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const step = r.steps.find((s) => s.id === 'accept_legal');
    assert.equal(step.completed, true);
  });

  test('enable_2fa stays false when owner has no settings.twoFactorEnabled', async () => {
    const prisma = makePrisma({ userName: 'Jorge', twoFactorEnabled: false });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const step = r.steps.find((s) => s.id === 'enable_2fa');
    assert.equal(step.completed, false);
  });

  test('enable_2fa flips true when owner.settings.twoFactorEnabled === true', async () => {
    const prisma = makePrisma({ userName: 'Jorge', twoFactorEnabled: true });
    const r = await computeProgress({ prisma, orgId: 'org1', ownerId: 'u1' });
    const step = r.steps.find((s) => s.id === 'enable_2fa');
    assert.equal(step.completed, true);
  });

  test('STEPS includes the two new onboarding steps (accept_legal + enable_2fa)', () => {
    const ids = STEPS.map((s) => s.id);
    assert.ok(ids.includes('accept_legal'));
    assert.ok(ids.includes('enable_2fa'));
    assert.equal(STEPS.length, 7);
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
