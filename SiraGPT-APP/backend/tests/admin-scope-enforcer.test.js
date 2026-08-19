'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  AdminScopeError,
  LEVEL_TIERS,
  CLEARANCE_TIERS,
  decide,
  enforce,
  issueConfirmationToken,
  verifyConfirmationToken,
  minClearanceFor,
  levelTier,
  principalClearanceTier,
} = require('../src/services/agents/admin-scope-enforcer');

const baseManifest = (overrides = {}) => ({
  name: 'tool.test',
  side_effect_level: 'none',
  ...overrides,
});

describe('LEVEL_TIERS / CLEARANCE_TIERS', () => {
  it('exports a frozen, complete level ladder', () => {
    assert.strictEqual(Object.isFrozen(LEVEL_TIERS), true);
    assert.strictEqual(LEVEL_TIERS.none, 0);
    assert.strictEqual(LEVEL_TIERS.destructive, 4);
  });

  it('exports a frozen, complete clearance ladder', () => {
    assert.strictEqual(Object.isFrozen(CLEARANCE_TIERS), true);
    assert.strictEqual(CLEARANCE_TIERS.guest, 0);
    assert.strictEqual(CLEARANCE_TIERS.superadmin, 5);
  });
});

describe('helpers', () => {
  it('minClearanceFor maps each level correctly', () => {
    assert.strictEqual(minClearanceFor('none'), CLEARANCE_TIERS.user);
    assert.strictEqual(minClearanceFor('remote-read'), CLEARANCE_TIERS.user);
    assert.strictEqual(minClearanceFor('local-fs'), CLEARANCE_TIERS.user);
    assert.strictEqual(minClearanceFor('remote-write'), CLEARANCE_TIERS.power);
    assert.strictEqual(minClearanceFor('destructive'), CLEARANCE_TIERS.admin);
  });

  it('minClearanceFor falls closed on unknown levels', () => {
    assert.strictEqual(minClearanceFor('unknown-level'), CLEARANCE_TIERS.admin);
  });

  it('levelTier handles missing/unknown values', () => {
    assert.strictEqual(levelTier(undefined), LEVEL_TIERS.none);
    assert.strictEqual(levelTier(null), LEVEL_TIERS.none);
    assert.strictEqual(levelTier('NoT-A-LeVeL'), LEVEL_TIERS.destructive);
  });

  it('principalClearanceTier defaults to guest', () => {
    assert.strictEqual(principalClearanceTier(null), CLEARANCE_TIERS.guest);
    assert.strictEqual(principalClearanceTier({}), CLEARANCE_TIERS.guest);
    assert.strictEqual(principalClearanceTier({ clearance: 'admin' }), CLEARANCE_TIERS.admin);
    assert.strictEqual(principalClearanceTier({ clearance: 'NOPE' }), CLEARANCE_TIERS.guest);
  });
});

describe('decide() — manifest validation', () => {
  it('throws when manifest is missing or malformed', () => {
    assert.throws(() => decide({}), AdminScopeError);
    assert.throws(() => decide({ manifest: {} }), AdminScopeError);
    assert.throws(() => decide({ manifest: { name: '' } }), AdminScopeError);
  });
});

describe('decide() — clearance tiers', () => {
  it('allows a user to run a none-level tool', () => {
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'none' }),
      principal: { clearance: 'user' },
    });
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.reasons.length, 0);
  });

  it('blocks a guest from running a remote-write tool', () => {
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'remote-write' }),
      principal: { clearance: 'guest' },
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'insufficient_clearance'));
  });

  it('blocks a user from running a destructive tool without admin', () => {
    const token = issueConfirmationToken({ toolName: 'tool.test' });
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'user' },
      confirmationToken: token,
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'insufficient_clearance'));
  });

  it('admin + valid token can run destructive', () => {
    const token = issueConfirmationToken({ toolName: 'tool.test' });
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'admin' },
      confirmationToken: token,
    });
    assert.strictEqual(r.allow, true, JSON.stringify(r.reasons));
  });
});

describe('decide() — scopes', () => {
  it('allows when manifest has no scopes', () => {
    const r = decide({
      manifest: baseManifest({}),
      principal: { clearance: 'user', scopes: [] },
    });
    assert.strictEqual(r.allow, true);
  });

  it('blocks when manifest scopes are not all granted', () => {
    const r = decide({
      manifest: baseManifest({ scopes: ['rag.read', 'files.write'] }),
      principal: { clearance: 'user', scopes: ['rag.read'] },
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'missing_scope'));
  });

  it('allows when all manifest scopes are granted', () => {
    const r = decide({
      manifest: baseManifest({ scopes: ['rag.read', 'files.write'] }),
      principal: { clearance: 'user', scopes: ['rag.read', 'files.write', 'extra.scope'] },
    });
    assert.strictEqual(r.allow, true);
  });
});

describe('decide() — data classes', () => {
  it('blocks when manifest data_classes are not in principal data_clearance', () => {
    const r = decide({
      manifest: baseManifest({ data_classes: ['pii'] }),
      principal: { clearance: 'user', data_clearance: ['public'] },
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'data_class_clearance'));
  });

  it('allows when data_classes match principal clearance', () => {
    const r = decide({
      manifest: baseManifest({ data_classes: ['pii', 'internal'] }),
      principal: { clearance: 'user', data_clearance: ['public', 'internal', 'pii'] },
    });
    assert.strictEqual(r.allow, true);
  });
});

describe('decide() — confirmation gating', () => {
  it('blocks destructive without a token', () => {
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'admin' },
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'confirmation_required'));
    assert.strictEqual(r.needsConfirmation, true);
  });

  it('blocks when requires_confirmation is true on a non-destructive tool', () => {
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'none', requires_confirmation: true }),
      principal: { clearance: 'user' },
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'confirmation_required'));
  });

  it('blocks an expired token', () => {
    const longAgo = Date.now() - 60_000;
    const token = issueConfirmationToken({ toolName: 'tool.test', ttlMs: 1, now: longAgo });
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'admin' },
      confirmationToken: token,
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'confirmation_invalid'));
  });

  it('blocks a token issued for a different tool', () => {
    const token = issueConfirmationToken({ toolName: 'other.tool' });
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'admin' },
      confirmationToken: token,
    });
    assert.strictEqual(r.allow, false);
    assert.ok(r.reasons.find(x => x.code === 'confirmation_invalid'));
  });

  it('blocks a tampered signature', () => {
    let token = issueConfirmationToken({ toolName: 'tool.test' });
    token = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    const r = decide({
      manifest: baseManifest({ side_effect_level: 'destructive' }),
      principal: { clearance: 'admin' },
      confirmationToken: token,
    });
    assert.strictEqual(r.allow, false);
  });
});

describe('verifyConfirmationToken — error reasons', () => {
  it('returns token_missing when input is empty', () => {
    assert.deepStrictEqual(verifyConfirmationToken({ token: '', toolName: 'x' }), {
      ok: false,
      reason: 'token_missing',
    });
  });

  it('returns token_malformed for inputs with too few segments', () => {
    assert.deepStrictEqual(verifyConfirmationToken({ token: 'a.b', toolName: 'x' }), {
      ok: false,
      reason: 'token_malformed',
    });
  });

  it('round-trips a valid token through verify', () => {
    const token = issueConfirmationToken({ toolName: 'tool.dotted.name' });
    const v = verifyConfirmationToken({ token, toolName: 'tool.dotted.name' });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(typeof v.exp, 'number');
  });
});

describe('enforce()', () => {
  it('returns the decision when allowed', () => {
    const d = enforce({
      manifest: baseManifest({ side_effect_level: 'remote-read' }),
      principal: { clearance: 'user' },
    });
    assert.strictEqual(d.allow, true);
  });

  it('throws AdminScopeError when denied', () => {
    assert.throws(
      () => enforce({
        manifest: baseManifest({ side_effect_level: 'destructive' }),
        principal: { clearance: 'user' },
      }),
      err => err instanceof AdminScopeError && err.code === 'insufficient_clearance',
    );
  });
});
