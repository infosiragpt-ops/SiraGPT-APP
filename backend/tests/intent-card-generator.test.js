'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const card = require('../src/services/intent-card-generator');

function mockReport(opts = {}) {
  return {
    attributionGraph: {
      primaryIntent: opts.intent ? { kind: opts.intent, weight: opts.intentConfidence ?? 0.8 } : null,
      confidence: opts.intentConfidence ?? 0.8,
      intents: opts.intents || (opts.intent ? [{ kind: opts.intent, weight: opts.intentConfidence ?? 0.8 }] : []),
      signals: opts.signals || [],
    },
    multiHop: { missingPrerequisites: opts.missing || [], needsClarification: Boolean(opts.needsClarification) },
    crossTurn: {
      needsCorefResolution: Boolean(opts.unresolvedCoref),
      unresolvedCoreferences: opts.unresolvedCorefList || [],
    },
    hiddenGoal: opts.hiddenGoal
      ? {
          topCandidate: { name: opts.hiddenGoal, score: opts.hiddenGoalConfidence ?? 0.7 },
          needsClarification: Boolean(opts.hiddenGoalNeedsClarification),
          clarifyingQuestion: opts.clarifyingQuestion || null,
        }
      : null,
    knowledgeBoundary: opts.knowledgeBoundarySeverity ? { severity: opts.knowledgeBoundarySeverity, riskScore: 0.8 } : null,
    entityGrounding: opts.entityGroundingSeverity ? { severity: opts.entityGroundingSeverity, groundingRate: 0.3 } : null,
    reasoningFaithfulness: opts.faithfulnessSeverity ? { severity: opts.faithfulnessSeverity, faithfulness: 0.3 } : null,
    counterfactual: opts.brittle ? { verdict: 'brittle', robustnessScore: 0.4 } : null,
    lookahead: { nextSteps: opts.nextSteps || [] },
    confidence: opts.overallConfidence ?? 0.75,
    elapsedMs: 12,
  };
}

describe('intent-card-generator', () => {
  describe('generate()', () => {
    it('returns empty card for null report', () => {
      const c = card.generate(null);
      assert.equal(c.empty, true);
      assert.equal(c.headline, '');
    });

    it('builds headline from arc sentence when provided', () => {
      const arc = { empty: false, sentence: 'User wants to analyze Tesla revenue.' };
      const c = card.generate(mockReport({ intent: 'analyze' }), { arc });
      assert.ok(c.headline.includes('analyze Tesla'));
    });

    it('falls back to intent-based headline when no arc', () => {
      const c = card.generate(mockReport({ intent: 'analyze', intentConfidence: 0.85 }));
      assert.ok(/analyze/i.test(c.headline));
      assert.ok(/85%/.test(c.headline));
    });

    it('includes alternatives when multiple intents present', () => {
      const c = card.generate(mockReport({
        intent: 'analyze',
        intents: [
          { kind: 'analyze', weight: 0.8 },
          { kind: 'summarize', weight: 0.6 },
          { kind: 'compare', weight: 0.4 },
        ],
      }));
      assert.equal(c.alternatives.length, 2);
      assert.equal(c.alternatives[0].kind, 'summarize');
    });

    it('captures blockers from multiHop and crossTurn', () => {
      const c = card.generate(mockReport({
        missing: ['document_missing'],
        unresolvedCoref: true,
      }));
      assert.ok(c.blockers.includes('document_missing'));
      assert.ok(c.blockers.includes('unresolved_reference'));
    });

    it('adds risk flags when severity is high', () => {
      const c = card.generate(mockReport({
        knowledgeBoundarySeverity: 'high',
        entityGroundingSeverity: 'high',
      }));
      assert.ok(c.riskFlags.some((f) => f.kind === 'knowledge_boundary'));
      assert.ok(c.riskFlags.some((f) => f.kind === 'entity_grounding'));
    });

    it('captures clarifications when hidden-goal needs clarification', () => {
      const c = card.generate(mockReport({
        hiddenGoal: 'compare_against_peers',
        hiddenGoalNeedsClarification: true,
        clarifyingQuestion: '¿Comparar contra cuál competidor?',
      }));
      assert.ok(c.clarifications.find((cl) => cl.reason === 'hidden_goal_ambiguous'));
    });

    it('recommendedAction is ask_clarifying_question when clarifications exist', () => {
      const c = card.generate(mockReport({
        hiddenGoal: 'compare_against_peers',
        hiddenGoalNeedsClarification: true,
        clarifyingQuestion: 'q?',
      }));
      assert.equal(c.recommendedAction, 'ask_clarifying_question');
    });

    it('recommendedAction is gather_prerequisites_first when 2+ blockers', () => {
      const c = card.generate(mockReport({
        missing: ['document_missing', 'data_missing'],
      }));
      assert.equal(c.recommendedAction, 'gather_prerequisites_first');
    });

    it('recommendedAction is proceed_with_answer when high confidence and clean', () => {
      const c = card.generate(mockReport({
        intent: 'analyze',
        intentConfidence: 0.85,
        overallConfidence: 0.85,
      }));
      assert.equal(c.recommendedAction, 'proceed_with_answer');
    });

    it('suggestedActions captures lookahead next steps', () => {
      const c = card.generate(mockReport({
        nextSteps: [
          { label: 'Build a chart of findings', tool: 'create_chart', confidence: 0.7 },
        ],
      }));
      assert.equal(c.suggestedActions.length, 1);
      assert.equal(c.suggestedActions[0].tool, 'create_chart');
    });

    it('evidence captures top-weighted signals', () => {
      const c = card.generate(mockReport({
        signals: [
          { type: 'imperative', value: 'analyze', weight: 0.9 },
          { type: 'named_entity', value: 'Tesla', weight: 0.7 },
          { type: 'temporal_cue', value: 'q3', weight: 0.4 },
        ],
      }));
      assert.equal(c.evidence.length, 3);
      assert.equal(c.evidence[0].type, 'imperative');
    });

    it('confidence is clamped and rounded', () => {
      const c = card.generate(mockReport({ overallConfidence: 0.83456 }));
      assert.equal(c.confidence, 0.835);
    });

    it('captures motivation from hidden goal', () => {
      const c = card.generate(mockReport({
        hiddenGoal: 'spot_risks_or_red_flags',
        hiddenGoalConfidence: 0.85,
      }));
      assert.equal(c.motivation, 'spot_risks_or_red_flags');
      assert.equal(c.motivationConfidence, 0.85);
    });
  });

  describe('buildIntentCardPrompt()', () => {
    it('returns empty for empty card', () => {
      assert.equal(card.buildIntentCardPrompt({ empty: true }), '');
    });

    it('returns prompt block with headline', () => {
      const c = card.generate(mockReport({ intent: 'analyze' }));
      const prompt = card.buildIntentCardPrompt(c);
      assert.ok(prompt.includes('Intent Card'));
      assert.ok(prompt.includes('Recommended posture'));
    });

    it('omits clarifications when includeClarifications=false', () => {
      const c = card.generate(mockReport({
        hiddenGoal: 'compare_against_peers',
        hiddenGoalNeedsClarification: true,
        clarifyingQuestion: 'q?',
      }));
      const prompt = card.buildIntentCardPrompt(c, { includeClarifications: false });
      assert.ok(!prompt.includes('Clarifications you could ask'));
    });
  });

  describe('diff()', () => {
    it('returns no change for empty cards', () => {
      assert.equal(card.diff(null, null).changed, false);
    });

    it('detects intent change', () => {
      const c1 = card.generate(mockReport({ intent: 'analyze' }));
      const c2 = card.generate(mockReport({ intent: 'summarize' }));
      const d = card.diff(c1, c2);
      assert.equal(d.changed, true);
      assert.ok(d.fields.find((f) => f.field === 'primaryIntent'));
    });

    it('detects motivation change', () => {
      const c1 = card.generate(mockReport({ hiddenGoal: 'spot_risks_or_red_flags' }));
      const c2 = card.generate(mockReport({ hiddenGoal: 'make_a_decision' }));
      const d = card.diff(c1, c2);
      assert.ok(d.fields.find((f) => f.field === 'motivation'));
    });

    it('detects added/removed blockers', () => {
      const c1 = card.generate(mockReport({ missing: ['document_missing'] }));
      const c2 = card.generate(mockReport({ missing: ['document_missing', 'data_missing'] }));
      const d = card.diff(c1, c2);
      const blockerField = d.fields.find((f) => f.field === 'blockers');
      assert.ok(blockerField);
      assert.ok(blockerField.added.includes('data_missing'));
    });

    it('reports no change for identical cards', () => {
      const c1 = card.generate(mockReport({ intent: 'analyze' }));
      const c2 = card.generate(mockReport({ intent: 'analyze' }));
      assert.equal(card.diff(c1, c2).changed, false);
    });
  });
});
