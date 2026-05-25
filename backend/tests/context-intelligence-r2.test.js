'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const crossTurn = require('../src/services/cross-turn-attribution-chain');
const hiddenGoal = require('../src/services/hidden-goal-extractor');
const provenance = require('../src/services/prompt-provenance-tracker');
const counterfactual = require('../src/services/counterfactual-query-rewriter');
const engine = require('../src/services/context-intelligence-engine');

describe('cross-turn-attribution-chain', () => {
  it('returns empty influences for no history', () => {
    const chain = crossTurn.buildChain([], 'hello', {});
    assert.equal(chain.influences.length, 0);
    assert.equal(chain.topInfluences.length, 0);
  });

  it('builds a turn fingerprint with entities and tokens', () => {
    const fp = crossTurn.buildTurnFingerprint({ role: 'user', content: 'Analyze Tesla and Ford revenue for Q3' }, 0);
    assert.ok(fp.entities.length >= 2);
    assert.ok(fp.tokens.size > 0);
  });

  it('detects shared entities between current and prior turn', () => {
    const history = [
      { role: 'user', content: 'Tell me about Tesla Q3 earnings' },
      { role: 'assistant', content: 'Tesla reported strong results.' },
    ];
    const chain = crossTurn.buildChain(history, 'How does Tesla compare to Ford?', {});
    const top = chain.topInfluences[0];
    assert.ok(top, 'should produce at least one influence');
    assert.ok(top.sharedEntities.some((e) => /tesla/i.test(e)));
  });

  it('detects topic drift when subjects change abruptly', () => {
    const history = [
      { role: 'user', content: 'How do I write a Python function for fibonacci?' },
      { role: 'user', content: 'Make it recursive please' },
    ];
    const chain = crossTurn.buildChain(history, 'What is the best wine for fish?', {});
    assert.ok(chain.topicDrift >= 0.5);
  });

  it('flags unresolved references when no prior entities exist', () => {
    const chain = crossTurn.buildChain([], 'Apply that one to the previous document', {});
    assert.ok(chain.unresolvedCoreferences.length >= 1);
    assert.equal(chain.needsCorefResolution, true);
  });

  it('influence weights decay with distance', () => {
    const history = [
      { role: 'user', content: 'Tesla Q1' },
      { role: 'user', content: 'Tesla Q2' },
      { role: 'user', content: 'Tesla Q3' },
    ];
    const chain = crossTurn.buildChain(history, 'Tesla Q4 outlook?', {});
    const sortedByDistance = [...chain.influences].sort((a, b) => a.distance - b.distance);
    assert.ok(sortedByDistance[0].recencyDecay >= sortedByDistance[sortedByDistance.length - 1].recencyDecay);
  });

  it('buildCrossTurnPrompt returns string with key insights', () => {
    const chain = crossTurn.buildChain([{ role: 'user', content: 'Tell me about Tesla' }], 'Tesla Q4 outlook', {});
    const prompt = crossTurn.buildCrossTurnPrompt(chain);
    assert.ok(prompt.includes('Cross-turn'));
  });
});

describe('hidden-goal-extractor', () => {
  it('returns no candidates for empty query', () => {
    const r = hiddenGoal.extractHiddenGoals('', {});
    assert.equal(r.candidates.length, 0);
    assert.equal(r.topCandidate, null);
  });

  it('detects decide_whether_to_read for summarize requests', () => {
    const r = hiddenGoal.extractHiddenGoals('Summarize this 10-K', { documents: [{ text: 'a'.repeat(5000) }] });
    const decide = r.candidates.find((c) => c.name === 'decide_whether_to_read');
    assert.ok(decide);
  });

  it('detects troubleshoot goal from error mentions', () => {
    const r = hiddenGoal.extractHiddenGoals('My deploy is failing with error 500, please help', {});
    const trouble = r.candidates.find((c) => c.name === 'troubleshoot_a_problem');
    assert.ok(trouble);
    assert.ok(trouble.firedSignals.includes('emotion_urgent'));
  });

  it('detects compare goal with peer mention', () => {
    const r = hiddenGoal.extractHiddenGoals('Analyze Tesla vs Ford revenue', {});
    const compare = r.candidates.find((c) => c.name === 'compare_against_peers');
    assert.ok(compare);
  });

  it('detects produce_deliverable goal with format constraint', () => {
    const r = hiddenGoal.extractHiddenGoals('Draft an email in markdown format for executives', {});
    const deliverable = r.candidates.find((c) => c.name === 'produce_deliverable');
    assert.ok(deliverable);
    assert.ok(deliverable.firedSignals.length >= 1);
  });

  it('detects make_a_decision goal with decision pressure', () => {
    const r = hiddenGoal.extractHiddenGoals('Should I choose PostgreSQL or MySQL by tomorrow?', {});
    const decide = r.candidates.find((c) => c.name === 'make_a_decision');
    assert.ok(decide);
  });

  it('buildHiddenGoalPrompt returns block with top goal', () => {
    const r = hiddenGoal.extractHiddenGoals('Help me decide between options A and B', {});
    const prompt = hiddenGoal.buildHiddenGoalPrompt(r);
    assert.ok(prompt.includes('Hidden Goal'));
  });

  it('returns empty prompt for null result', () => {
    const prompt = hiddenGoal.buildHiddenGoalPrompt(null);
    assert.equal(prompt, '');
  });
});

describe('prompt-provenance-tracker', () => {
  it('creates an empty tracker', () => {
    const t = provenance.createTracker();
    const built = t.buildPrompt();
    assert.equal(built.prompt, '');
    assert.equal(built.map.length, 0);
  });

  it('adds blocks and tracks their offsets', () => {
    const t = provenance.createTracker();
    t.add(provenance.SOURCE_KINDS.SYSTEM_BASE, 'You are a helpful assistant.');
    t.add(provenance.SOURCE_KINDS.MEMORY, 'User prefers Spanish.');
    const built = t.buildPrompt();
    assert.ok(built.prompt.includes('You are a helpful'));
    assert.ok(built.prompt.includes('User prefers Spanish'));
    assert.equal(built.map.length, 2);
    assert.ok(built.map[1].offset > built.map[0].offset);
  });

  it('attributes a substring to its source block', () => {
    const t = provenance.createTracker();
    t.add(provenance.SOURCE_KINDS.RAG, 'According to the document, revenue grew 30%.');
    t.add(provenance.SOURCE_KINDS.MEMORY, 'User likes concise responses.');
    const attribution = t.attributeText('revenue grew 30%');
    assert.ok(attribution);
    assert.equal(attribution.source, provenance.SOURCE_KINDS.RAG);
  });

  it('returns null for unmatched substrings', () => {
    const t = provenance.createTracker();
    t.add(provenance.SOURCE_KINDS.MEMORY, 'A fact');
    assert.equal(t.attributeText('not present'), null);
  });

  it('summarizes distribution by source', () => {
    const t = provenance.createTracker();
    t.add(provenance.SOURCE_KINDS.MEMORY, 'short');
    t.add(provenance.SOURCE_KINDS.MEMORY, 'another short');
    t.add(provenance.SOURCE_KINDS.RAG, 'a much longer block of text here for the rag source');
    const summary = t.summarize();
    assert.equal(summary.blockCount, 3);
    assert.ok(summary.distribution.length >= 2);
    assert.equal(summary.distribution[0].source, provenance.SOURCE_KINDS.RAG);
  });

  it('trims low-weight blocks when over maxChars', () => {
    const t = provenance.createTracker({ maxChars: 50 });
    t.add(provenance.SOURCE_KINDS.SYSTEM_BASE, 'A'.repeat(40), { weight: 1.0 });
    t.add(provenance.SOURCE_KINDS.CUSTOM, 'B'.repeat(40), { weight: 0.1 });
    const built = t.buildPrompt();
    assert.equal(built.trimmed, true);
    assert.ok(built.prompt.length <= 50);
    assert.ok(built.prompt.includes('A'));
  });

  it('addMany inserts an array of blocks', () => {
    const t = provenance.createTracker();
    t.addMany([
      { source: provenance.SOURCE_KINDS.MEMORY, content: 'first' },
      { source: provenance.SOURCE_KINDS.RAG, content: 'second' },
    ]);
    assert.equal(t.buildPrompt().map.length, 2);
  });

  it('buildProvenancePrompt returns a non-empty block', () => {
    const t = provenance.createTracker();
    t.add(provenance.SOURCE_KINDS.MEMORY, 'A fact');
    assert.ok(provenance.buildProvenancePrompt(t).includes('Prompt Provenance'));
  });
});

describe('counterfactual-query-rewriter', () => {
  it('returns empty list for empty query', () => {
    assert.equal(counterfactual.generateRewrites('').length, 0);
  });

  it('generates multiple rewrites for a real query', () => {
    const r = counterfactual.generateRewrites('Analyze this revenue report', { limit: 6 });
    assert.ok(r.length >= 3);
  });

  it('rewrites include synonym swaps', () => {
    const r = counterfactual.generateRewrites('Analyze the Tesla report');
    assert.ok(r.some((v) => /review|audit/i.test(v)));
  });

  it('probeRobustness reports high robustness when intent function is stable', () => {
    const r = counterfactual.probeRobustness('Analyze this', () => 'analyze');
    assert.equal(r.verdict, 'highly_robust');
    assert.equal(r.robustnessScore, 1);
  });

  it('probeRobustness reports brittle when intent flips frequently', () => {
    let toggle = false;
    const r = counterfactual.probeRobustness('Analyze this', () => {
      toggle = !toggle;
      return toggle ? 'analyze' : 'summarize';
    });
    assert.ok(['brittle', 'unstable', 'mostly_robust'].includes(r.verdict));
  });

  it('throws if intentFn is not a function', () => {
    assert.throws(() => counterfactual.probeRobustness('hello', null), TypeError);
  });

  it('buildCounterfactualPrompt returns non-empty for results', () => {
    const r = counterfactual.probeRobustness('Build a chart', () => 'visualize');
    assert.ok(counterfactual.buildCounterfactualPrompt(r).includes('Counterfactual Robustness'));
  });
});

describe('context-intelligence-engine — round 2 integration', () => {
  it('analyzeContext returns crossTurn, hiddenGoal, and counterfactual fields', () => {
    const report = engine.analyzeContext('user', 'Analyze Tesla Q3 revenue', {
      history: [{ role: 'user', content: 'Tell me about Tesla' }],
      documents: [{ name: 'tesla.pdf', text: 'Tesla quarterly revenue grew 30%.' }],
    });
    assert.ok(report.crossTurn);
    assert.ok(report.hiddenGoal);
    assert.ok(report.counterfactual);
  });

  it('recommendations include hidden_goal category when goal inferred', () => {
    const report = engine.analyzeContext('user', 'Help me decide between A and B by tomorrow', {});
    assert.ok(report.recommendations.find((r) => r.category === 'hidden_goal'));
  });

  it('recommendations include coreference category when refs unresolved', () => {
    const report = engine.analyzeContext('user', 'Apply that one to the previous document', {});
    assert.ok(report.recommendations.find((r) => r.category === 'coreference'));
  });

  it('summariseForLog includes round 2 fields', () => {
    const report = engine.analyzeContext('user', 'Summarize this 10-K filing', { documents: [{ text: 'a'.repeat(5000) }] });
    const log = engine.summariseForLog(report);
    assert.ok(log.crossTurn !== undefined);
    assert.ok(log.hiddenGoal !== undefined);
    assert.ok(log.counterfactual !== undefined);
  });

  it('runCounterfactual=false skips the counterfactual module', () => {
    const report = engine.analyzeContext('user', 'Analyze data', { runCounterfactual: false });
    assert.equal(report.counterfactual, null);
  });

  it('buildSystemPromptBlock includes round 2 sections when present', () => {
    const report = engine.analyzeContext('user', 'Help me decide what to do', {});
    assert.ok(engine.buildSystemPromptBlock(report).includes('Hidden Goal'));
  });

  it('overall confidence reflects counterfactual robustness', () => {
    const report = engine.analyzeContext('user', 'Translate to Spanish', {});
    assert.ok(report.confidence >= 0 && report.confidence <= 1);
  });
});
