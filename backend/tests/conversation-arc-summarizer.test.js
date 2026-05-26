'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const arc = require('../src/services/conversation-arc-summarizer');

function buildMockReport(opts = {}) {
  return {
    attributionGraph: {
      primaryIntent: opts.intent ? { kind: opts.intent, weight: opts.intentConfidence ?? 0.8 } : null,
      confidence: opts.intentConfidence ?? 0.8,
    },
    multiHop: { missingPrerequisites: opts.missing || [] },
    crossTurn: {
      currentFingerprint: { entities: opts.entities || [] },
      needsCorefResolution: Boolean(opts.unresolvedCoref),
    },
    hiddenGoal: opts.hiddenGoal
      ? { topCandidate: { name: opts.hiddenGoal, score: opts.hiddenGoalConfidence ?? 0.7 } }
      : null,
    entityGrounding: opts.entityGrounding || null,
    counterfactual: opts.brittle ? { verdict: 'brittle', robustnessScore: 0.4 } : null,
    confidence: opts.overallConfidence ?? 0.8,
  };
}

describe('conversation-arc-summarizer', () => {
  describe('summarize()', () => {
    it('returns empty result for empty input', () => {
      const result = arc.summarize([]);
      assert.equal(result.empty, true);
      assert.equal(result.sentence, '');
    });

    it('returns empty for non-array input', () => {
      assert.equal(arc.summarize(null).empty, true);
      assert.equal(arc.summarize(undefined).empty, true);
    });

    it('extracts top subjects from cross-turn entities', () => {
      const reports = [
        buildMockReport({ entities: ['Tesla', 'Ford'] }),
        buildMockReport({ entities: ['Tesla', 'GM'] }),
        buildMockReport({ entities: ['Tesla'] }),
      ];
      const result = arc.summarize(reports);
      assert.ok(result.subject.includes('Tesla'));
    });

    it('picks dominant intent (verb)', () => {
      const reports = [
        buildMockReport({ intent: 'analyze' }),
        buildMockReport({ intent: 'analyze' }),
        buildMockReport({ intent: 'summarize' }),
      ];
      const result = arc.summarize(reports);
      assert.equal(result.verb, 'analyze');
    });

    it('picks dominant hidden goal (motivation)', () => {
      const reports = [
        buildMockReport({ hiddenGoal: 'spot_risks_or_red_flags' }),
        buildMockReport({ hiddenGoal: 'spot_risks_or_red_flags' }),
        buildMockReport({ hiddenGoal: 'make_a_decision' }),
      ];
      const result = arc.summarize(reports);
      assert.equal(result.motivation, 'spot_risks_or_red_flags');
    });

    it('collects unique blockers', () => {
      const reports = [
        buildMockReport({ missing: ['document_missing'] }),
        buildMockReport({ missing: ['document_missing', 'data_missing'] }),
        buildMockReport({ unresolvedCoref: true }),
      ];
      const result = arc.summarize(reports);
      assert.ok(result.blockers.includes('document_missing'));
      assert.ok(result.blockers.includes('data_missing'));
      assert.ok(result.blockers.includes('unresolved_reference'));
    });

    it('adds brittle_intent blocker when counterfactual flags it', () => {
      const reports = [buildMockReport({ brittle: true, intent: 'analyze' })];
      const result = arc.summarize(reports);
      assert.ok(result.blockers.includes('brittle_intent'));
    });

    it('builds a sentence with subject, verb, motivation', () => {
      const reports = [
        buildMockReport({ entities: ['Tesla'], intent: 'analyze', hiddenGoal: 'spot_risks_or_red_flags' }),
        buildMockReport({ entities: ['Tesla'], intent: 'analyze', hiddenGoal: 'spot_risks_or_red_flags' }),
      ];
      const result = arc.summarize(reports);
      assert.ok(/User wants to/i.test(result.sentence));
      assert.ok(/Tesla/i.test(result.sentence));
      assert.ok(/risks/i.test(result.sentence));
    });

    it('sentence includes blockers list when present', () => {
      const reports = [
        buildMockReport({ entities: ['Tesla'], intent: 'analyze', missing: ['document_missing'] }),
      ];
      const result = arc.summarize(reports);
      assert.ok(/Open blockers/i.test(result.sentence));
    });

    it('averages overall confidence across reports', () => {
      const reports = [
        buildMockReport({ overallConfidence: 0.6, intent: 'analyze' }),
        buildMockReport({ overallConfidence: 0.9, intent: 'analyze' }),
      ];
      const result = arc.summarize(reports);
      assert.ok(result.confidence > 0.6 && result.confidence < 0.9);
    });

    it('honours subjectLimit option', () => {
      const reports = [
        buildMockReport({ entities: ['A', 'B', 'C', 'D'], intent: 'analyze' }),
      ];
      const result = arc.summarize(reports, { subjectLimit: 2 });
      assert.equal(result.subject.length, 2);
    });

    it('handles reports without optional fields gracefully', () => {
      const result = arc.summarize([{}]);
      assert.equal(result.empty, false);
      assert.ok(result.sentence);
    });
  });

  describe('buildArcPrompt()', () => {
    it('returns empty string for empty arc', () => {
      assert.equal(arc.buildArcPrompt({ empty: true }), '');
      assert.equal(arc.buildArcPrompt(null), '');
    });

    it('returns prompt block with sentence and details', () => {
      const result = arc.summarize([
        buildMockReport({ entities: ['Tesla'], intent: 'analyze', hiddenGoal: 'spot_risks_or_red_flags' }),
      ]);
      const prompt = arc.buildArcPrompt(result);
      assert.ok(prompt.includes('Conversation Arc'));
      assert.ok(prompt.includes('User wants to'));
    });

    it('omits detail lines when includeDetail=false', () => {
      const result = arc.summarize([buildMockReport({ entities: ['Tesla'], intent: 'analyze' })]);
      const prompt = arc.buildArcPrompt(result, { includeDetail: false });
      assert.ok(prompt.includes('Conversation Arc'));
      assert.ok(!prompt.includes('- Subjects:'));
    });
  });

  describe('detectArcShift()', () => {
    it('returns insufficient_data for empty inputs', () => {
      const r1 = arc.detectArcShift(null, null);
      assert.equal(r1.shifted, false);
      assert.equal(r1.reason, 'insufficient_data');
    });

    it('detects verb shift', () => {
      const prev = arc.summarize([buildMockReport({ intent: 'analyze', entities: ['Tesla'] })]);
      const curr = arc.summarize([buildMockReport({ intent: 'translate', entities: ['Tesla'] })]);
      const shift = arc.detectArcShift(prev, curr);
      assert.equal(shift.shifted, true);
      assert.equal(shift.verbShift, true);
    });

    it('detects motivation shift', () => {
      const prev = arc.summarize([buildMockReport({ intent: 'analyze', hiddenGoal: 'spot_risks_or_red_flags' })]);
      const curr = arc.summarize([buildMockReport({ intent: 'analyze', hiddenGoal: 'make_a_decision' })]);
      const shift = arc.detectArcShift(prev, curr);
      assert.equal(shift.motivationShift, true);
    });

    it('detects subject shift', () => {
      const prev = arc.summarize([buildMockReport({ intent: 'analyze', entities: ['Tesla'] })]);
      const curr = arc.summarize([buildMockReport({ intent: 'analyze', entities: ['Apple'] })]);
      const shift = arc.detectArcShift(prev, curr);
      assert.equal(shift.subjectShift, true);
    });

    it('reports no shift when arc is stable', () => {
      const prev = arc.summarize([buildMockReport({ intent: 'analyze', entities: ['Tesla'] })]);
      const curr = arc.summarize([buildMockReport({ intent: 'analyze', entities: ['Tesla'] })]);
      const shift = arc.detectArcShift(prev, curr);
      assert.equal(shift.shifted, false);
    });
  });
});
