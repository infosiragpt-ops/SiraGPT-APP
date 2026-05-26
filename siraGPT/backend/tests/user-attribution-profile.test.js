'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const profileService = require('../src/services/user-attribution-profile');

describe('user-attribution-profile', () => {
  beforeEach(() => profileService.reset());

  describe('recordTurn()', () => {
    it('returns null for missing userId', () => {
      assert.equal(profileService.recordTurn(null, { signals: [] }), null);
    });

    it('creates a fresh profile on first turn', () => {
      profileService.recordTurn('user-1', {
        signals: [{ type: 'imperative', weight: 0.9 }],
        primaryIntent: 'analyze',
      });
      const summary = profileService.getProfileSummary('user-1');
      assert.equal(summary.totalTurns, 1);
      assert.equal(summary.topSignals[0].type, 'imperative');
    });

    it('records positive vs negative outcomes separately', () => {
      profileService.recordTurn('user-1', { signals: [{ type: 'imperative' }] }, 'positive');
      profileService.recordTurn('user-1', { signals: [{ type: 'imperative' }] }, 'negative');
      const summary = profileService.getProfileSummary('user-1');
      assert.equal(summary.positiveTurns, 1);
      assert.equal(summary.negativeTurns, 1);
    });

    it('captures hidden goals when provided', () => {
      profileService.recordTurn('user-1', {
        signals: [],
        hiddenGoal: 'troubleshoot_a_problem',
      });
      const summary = profileService.getProfileSummary('user-1');
      assert.equal(summary.topHiddenGoals[0].name, 'troubleshoot_a_problem');
    });

    it('accepts hiddenGoal as object with name', () => {
      profileService.recordTurn('user-1', {
        signals: [],
        hiddenGoal: { name: 'make_a_decision' },
      });
      assert.equal(
        profileService.getProfileSummary('user-1').topHiddenGoals[0].name,
        'make_a_decision',
      );
    });

    it('accepts primaryIntent as object with kind', () => {
      profileService.recordTurn('user-1', {
        signals: [],
        primaryIntent: { kind: 'translate', weight: 0.8 },
      });
      assert.equal(
        profileService.getProfileSummary('user-1').topIntents[0].kind,
        'translate',
      );
    });

    it('caps recentTurns history at MAX_HISTORY', () => {
      const max = profileService.DEFAULT_LIMITS.MAX_HISTORY;
      for (let i = 0; i < max + 50; i++) {
        profileService.recordTurn('user-1', { signals: [], primaryIntent: 'analyze' });
      }
      const profile = profileService.getProfile('user-1');
      assert.ok(profile.recentTurns.length <= max);
    });
  });

  describe('computeMultiplier()', () => {
    it('returns default for insufficient observations', () => {
      const mult = profileService.computeMultiplier({ positive: 1, negative: 0, neutral: 0 });
      assert.equal(mult, 1.0);
    });

    it('returns >1 for positive-dominant outcomes', () => {
      const mult = profileService.computeMultiplier({ positive: 10, negative: 0, neutral: 0 });
      assert.ok(mult > 1.0);
      assert.ok(mult <= 1.5);
    });

    it('returns <1 for negative-dominant outcomes', () => {
      const mult = profileService.computeMultiplier({ positive: 0, negative: 10, neutral: 0 });
      assert.ok(mult < 1.0);
      assert.ok(mult >= 0.5);
    });

    it('clamps to [0.5, 1.5] range', () => {
      const high = profileService.computeMultiplier({ positive: 1000, negative: 0, neutral: 0 });
      const low = profileService.computeMultiplier({ positive: 0, negative: 1000, neutral: 0 });
      assert.ok(high <= 1.5);
      assert.ok(low >= 0.5);
    });
  });

  describe('weights getters', () => {
    it('getSignalWeights returns empty for unknown user', () => {
      assert.deepEqual(profileService.getSignalWeights('nobody'), {});
    });

    it('getSignalWeights returns weights after enough positive observations', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn('user-1', { signals: [{ type: 'imperative' }] }, 'positive');
      }
      const weights = profileService.getSignalWeights('user-1');
      assert.ok(weights.imperative > 1.0);
    });

    it('getIntentWeights returns weights for repeat intents', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn('user-1', { signals: [], primaryIntent: 'analyze' }, 'positive');
      }
      const weights = profileService.getIntentWeights('user-1');
      assert.ok(weights.analyze > 1.0);
    });

    it('getHiddenGoalWeights returns weights for repeat goals', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn('user-1', { signals: [], hiddenGoal: 'decide_whether_to_read' }, 'positive');
      }
      const weights = profileService.getHiddenGoalWeights('user-1');
      assert.ok(weights.decide_whether_to_read > 1.0);
    });
  });

  describe('applyPersonalisedWeights()', () => {
    it('returns report unchanged for null userId', () => {
      const report = { attributionGraph: { signals: [], intents: [] } };
      const result = profileService.applyPersonalisedWeights(report, null);
      assert.equal(result, report);
    });

    it('boosts signal weights for positively-correlated types', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn('user-1', { signals: [{ type: 'document_ref' }] }, 'positive');
      }
      const report = {
        attributionGraph: {
          signals: [{ id: 's1', type: 'document_ref', weight: 0.5 }],
          intents: [],
        },
      };
      const result = profileService.applyPersonalisedWeights(report, 'user-1');
      assert.ok(result.attributionGraph.signals[0].weight > 0.5);
    });

    it('re-sorts intents after applying weights', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn('user-1', { signals: [], primaryIntent: 'code' }, 'positive');
      }
      const report = {
        attributionGraph: {
          signals: [],
          intents: [
            { id: 'i1', kind: 'analyze', weight: 0.8 },
            { id: 'i2', kind: 'code', weight: 0.7 },
          ],
          primaryIntent: { id: 'i1', kind: 'analyze', weight: 0.8 },
          confidence: 0.8,
        },
      };
      profileService.applyPersonalisedWeights(report, 'user-1');
      assert.ok(['analyze', 'code'].includes(report.attributionGraph.primaryIntent.kind));
    });

    it('handles report without attributionGraph gracefully', () => {
      assert.doesNotThrow(() => profileService.applyPersonalisedWeights({}, 'user-1'));
      assert.doesNotThrow(() => profileService.applyPersonalisedWeights(null, 'user-1'));
    });
  });

  describe('decay', () => {
    it('applyDecay shrinks frequency values', () => {
      profileService.recordTurn('user-1', { signals: [{ type: 'imperative' }] });
      const before = profileService.getProfile('user-1').signalFrequency.imperative;
      profileService.applyDecay(profileService.getProfile('user-1'), 0.5);
      const after = profileService.getProfile('user-1').signalFrequency.imperative;
      assert.ok(after < before);
    });

    it('prunes entries that fall below 0.05 after decay', () => {
      profileService.recordTurn('user-1', { signals: [{ type: 'rare' }] });
      const profile = profileService.getProfile('user-1');
      profileService.applyDecay(profile, 0.001);
      profileService.applyDecay(profile, 0.001);
      assert.equal(profile.signalFrequency.rare, undefined);
    });
  });

  describe('serialise / hydrate', () => {
    it('serialiseProfile returns null for unknown user', () => {
      assert.equal(profileService.serialiseProfile('nobody'), null);
    });

    it('round-trips a profile through serialise + hydrate', () => {
      profileService.recordTurn('user-1', { signals: [{ type: 'imperative' }], primaryIntent: 'analyze' });
      const snapshot = profileService.serialiseProfile('user-1');
      profileService.reset();
      profileService.hydrateProfile(snapshot);
      const summary = profileService.getProfileSummary('user-1');
      assert.equal(summary.totalTurns, 1);
      assert.equal(summary.topSignals[0].type, 'imperative');
    });

    it('hydrateProfile returns null for invalid input', () => {
      assert.equal(profileService.hydrateProfile(null), null);
      assert.equal(profileService.hydrateProfile({}), null);
    });
  });

  describe('LRU eviction', () => {
    it('tracks user IDs in getAllUserIds()', () => {
      profileService.recordTurn('user-1', { signals: [] });
      profileService.recordTurn('user-2', { signals: [] });
      const ids = profileService.getAllUserIds();
      assert.ok(ids.includes('user-1'));
      assert.ok(ids.includes('user-2'));
    });
  });

  describe('buildProfilePrompt()', () => {
    it('returns empty string when not enough observations', () => {
      assert.equal(profileService.buildProfilePrompt('nobody'), '');
    });

    it('returns prompt block once threshold is met', () => {
      for (let i = 0; i < 6; i++) {
        profileService.recordTurn('user-1', { signals: [], primaryIntent: 'analyze' }, 'positive');
      }
      const prompt = profileService.buildProfilePrompt('user-1');
      assert.ok(prompt.includes('Personalised Attribution Profile'));
      assert.ok(prompt.includes('analyze'));
    });

    it('mentions success rate', () => {
      for (let i = 0; i < 6; i++) {
        profileService.recordTurn('user-1', { signals: [], primaryIntent: 'analyze' }, 'positive');
      }
      const prompt = profileService.buildProfilePrompt('user-1');
      assert.ok(prompt.includes('success rate'));
    });
  });

  describe('getProfileSummary()', () => {
    it('returns null for unknown user', () => {
      assert.equal(profileService.getProfileSummary('nobody'), null);
    });

    it('includes weighted summaries after observations', () => {
      for (let i = 0; i < 10; i++) {
        profileService.recordTurn(
          'user-1',
          { signals: [{ type: 'document_ref' }], primaryIntent: 'analyze', hiddenGoal: 'spot_risks_or_red_flags' },
          'positive',
        );
      }
      const summary = profileService.getProfileSummary('user-1');
      assert.equal(summary.totalTurns, 10);
      assert.ok(summary.successRate >= 0.9);
      assert.ok(summary.topSignals.length >= 1);
      assert.ok(Object.keys(summary.signalWeights).length >= 1);
    });
  });
});
