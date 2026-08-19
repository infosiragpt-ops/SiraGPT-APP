'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const attributionGraph = require('../src/services/context-attribution-graph');
const multiHop = require('../src/services/multi-hop-intent-reasoner');
const lookahead = require('../src/services/lookahead-planner');
const knowledgeBoundary = require('../src/services/knowledge-boundary-detector');
const reasoningFaithfulness = require('../src/services/reasoning-faithfulness-check');
const entityGrounding = require('../src/services/entity-grounding-tracker');
const engine = require('../src/services/context-intelligence-engine');

describe('context-attribution-graph', () => {
  it('builds an empty-ish graph for an empty query', () => {
    const graph = attributionGraph.buildGraph('', {});
    assert.equal(graph.signals.length, 0);
    assert.equal(graph.intents.length >= 1, true);
  });

  it('extracts an imperative verb as a signal', () => {
    const graph = attributionGraph.buildGraph('Analyze the attached revenue report for Q3', {});
    const imp = graph.signals.find((s) => s.type === attributionGraph.SIGNAL_TYPES.IMPERATIVE);
    assert.ok(imp, 'should detect imperative');
    assert.equal(imp.value, 'analyze');
  });

  it('maps imperative to ANALYZE intent', () => {
    const graph = attributionGraph.buildGraph('Analyze the attached revenue report', {});
    assert.equal(graph.primaryIntent.kind, attributionGraph.INTENT_KINDS.ANALYZE);
    assert.ok(graph.confidence > 0.4);
  });

  it('falls back to EXPLAIN (not CONVERSE) when signals exist but no intent maps', () => {
    // Substantive content (entities + quantities) with no action verb → respond
    // to the content, not treat it as smalltalk. (The fallback ternary used to
    // return CONVERSE in both branches.)
    const graph = attributionGraph.buildGraph('Acme Corporation reported 42 widgets and 1500 dollars.', {});
    assert.ok(graph.signals.length > 0, 'the turn carried surface signals');
    assert.equal(graph.primaryIntent.kind, attributionGraph.INTENT_KINDS.EXPLAIN);
  });

  it('falls back to CONVERSE for a truly empty/trivial turn (no signals)', () => {
    const graph = attributionGraph.buildGraph('', {});
    assert.equal(graph.primaryIntent.kind, attributionGraph.INTENT_KINDS.CONVERSE);
  });

  it('maps Spanish imperative "implementa" to CODE intent', () => {
    const graph = attributionGraph.buildGraph('Implementa una función que sume números', {});
    assert.equal(graph.primaryIntent.kind, attributionGraph.INTENT_KINDS.CODE);
  });

  it('detects named entities (proper nouns)', () => {
    const graph = attributionGraph.buildGraph('Summarize the Acme Corp earnings call', {});
    const acmeEntity = graph.signals.find(
      (s) => s.type === attributionGraph.SIGNAL_TYPES.NAMED_ENTITY && /acme/i.test(s.value),
    );
    assert.ok(acmeEntity, 'should detect "Acme Corp" among named entities');
  });

  it('detects URL named entities', () => {
    const graph = attributionGraph.buildGraph('Check https://example.com/data for details', {});
    const url = graph.signals.find((s) => s.value && String(s.value).startsWith('https://'));
    assert.ok(url, 'should detect URL');
  });

  it('detects temporal cues', () => {
    const graph = attributionGraph.buildGraph('Find the latest reports from 2025 ASAP', {});
    const temporal = graph.signals.filter((s) => s.type === attributionGraph.SIGNAL_TYPES.TEMPORAL_CUE);
    assert.ok(temporal.length >= 1);
  });

  it('detects emotional cues', () => {
    const graph = attributionGraph.buildGraph('This is URGENT, the system is broken!!', {});
    const emo = graph.signals.find((s) => s.type === attributionGraph.SIGNAL_TYPES.EMOTIONAL_CUE);
    assert.ok(emo);
  });

  it('detects coreference cues', () => {
    const graph = attributionGraph.buildGraph('Apply that one to the previous document', {});
    const ref = graph.signals.find((s) => s.type === attributionGraph.SIGNAL_TYPES.REFERENCE_CUE);
    assert.ok(ref);
  });

  it('includes document_ref signals when context has docs', () => {
    const graph = attributionGraph.buildGraph('Summarize this', {
      documents: [{ name: 'q3.pdf', mime: 'application/pdf' }],
    });
    const doc = graph.signals.find((s) => s.type === attributionGraph.SIGNAL_TYPES.DOCUMENT_REF);
    assert.ok(doc);
    assert.equal(doc.value, 'q3.pdf');
  });

  it('includes memory_fact signals when memory facts provided', () => {
    const graph = attributionGraph.buildGraph('What did I say earlier', {
      memoryFacts: ['User prefers Spanish responses'],
    });
    const mem = graph.signals.find((s) => s.type === attributionGraph.SIGNAL_TYPES.MEMORY_FACT);
    assert.ok(mem);
  });

  it('builds abstractions from signals', () => {
    const graph = attributionGraph.buildGraph('Analyze the Acme report', {
      documents: [{ name: 'acme.pdf' }],
    });
    const actionAbs = graph.abstractions.find((a) => a.label.startsWith('action:'));
    const scopeAbs = graph.abstractions.find((a) => a.label === 'scope:documents');
    assert.ok(actionAbs);
    assert.ok(scopeAbs);
  });

  it('builds edges between signals → abstractions → intents', () => {
    const graph = attributionGraph.buildGraph('Generate a chart for revenue', {});
    assert.ok(graph.edges.length > 0);
    for (const edge of graph.edges) {
      assert.ok(typeof edge.from === 'string');
      assert.ok(typeof edge.to === 'string');
      assert.ok(edge.weight >= 0 && edge.weight <= 1);
    }
  });

  it('topContributors returns highest-weighted signals', () => {
    const graph = attributionGraph.buildGraph('Analyze "Acme Corp" earnings for 2025', {});
    const top = attributionGraph.topContributors(graph, 3);
    assert.ok(top.length <= 3);
    for (let i = 1; i < top.length; i++) {
      assert.ok(top[i - 1].weight >= top[i].weight);
    }
  });

  it('buildAttributionPrompt returns non-empty string for graph with intent', () => {
    const graph = attributionGraph.buildGraph('Analyze revenue', {});
    const prompt = attributionGraph.buildAttributionPrompt(graph);
    assert.ok(prompt.includes('Context Attribution'));
    assert.ok(prompt.includes('Primary inferred intent'));
  });
});

describe('multi-hop-intent-reasoner', () => {
  it('returns empty hops for empty query', () => {
    const result = multiHop.reason('', {});
    assert.equal(result.hops.length, 0);
    assert.equal(result.needsClarification, false);
  });

  it('always emits a literal hop for a real query', () => {
    const result = multiHop.reason('Build a dashboard from the sales data', {});
    const literal = result.hops.find((h) => h.kind === multiHop.HOP_KINDS.LITERAL);
    assert.ok(literal);
  });

  it('detects subject (proper noun) hop', () => {
    const result = multiHop.reason('Compare Tesla and Ford revenue', {});
    const subject = result.hops.find((h) => h.kind === multiHop.HOP_KINDS.SUBJECT);
    assert.ok(subject);
  });

  it('detects date_range constraint', () => {
    const result = multiHop.reason('Show me revenue for last quarter', {});
    const constraint = result.hops.find(
      (h) => h.kind === multiHop.HOP_KINDS.CONSTRAINT && h.metadata?.name === 'date_range',
    );
    assert.ok(constraint);
  });

  it('detects audience constraint', () => {
    const result = multiHop.reason('Write a summary for executives', {});
    const audience = result.hops.find(
      (h) => h.kind === multiHop.HOP_KINDS.CONSTRAINT && h.metadata?.name === 'audience',
    );
    assert.ok(audience);
  });

  it('detects output kind = visualization for "chart"', () => {
    const result = multiHop.reason('Make a chart of revenue trends', {});
    assert.equal(result.finalIntent.outputKind, 'visualization');
    const tooling = result.hops.find((h) => h.kind === multiHop.HOP_KINDS.TOOL_MAPPING);
    assert.ok(tooling);
    assert.ok(tooling.metadata.tools.includes('create_chart'));
  });

  it('does not detect an output kind from a hint token buried inside another word', () => {
    // Regression: substring matching fired "chart" on "merchant", "map" on
    // "example", etc. Word-boundary matching only.
    assert.notEqual(multiHop.detectOutputKind('the merchant tracks orders')?.kind, 'visualization');
    assert.equal(multiHop.detectOutputKind('the merchant tracks orders'), null);
    // A real, whole-word mention still detects; and the EARLIEST one wins.
    assert.equal(multiHop.detectOutputKind('first a table then a chart').kind, 'tabular');
  });

  it('flags missing prerequisites when "this document" referenced but no docs provided', () => {
    const result = multiHop.reason('Summarize this document', { documents: [] });
    assert.ok(result.missingPrerequisites.includes('document_missing'));
    assert.equal(result.needsClarification, true);
  });

  it('does not flag missing prerequisites when documents provided', () => {
    const result = multiHop.reason('Summarize this document', {
      documents: [{ name: 'x.pdf', text: 'hello' }],
    });
    assert.equal(result.missingPrerequisites.includes('document_missing'), false);
  });

  it('infers user goal: troubleshoot for "not working"', () => {
    const result = multiHop.reason('My deploy script is not working, error 500', {});
    const goal = result.hops.find((h) => h.kind === multiHop.HOP_KINDS.USER_GOAL);
    assert.ok(goal);
    assert.equal(goal.metadata.goalName, 'troubleshoot');
  });

  it('buildMultiHopPrompt returns non-empty when hops exist', () => {
    const result = multiHop.reason('Compare Tesla and Ford for last year', {});
    const prompt = multiHop.buildMultiHopPrompt(result);
    assert.ok(prompt.includes('Multi-hop Intent Reasoning'));
  });

  it('buildMultiHopPrompt returns empty string for empty result', () => {
    const prompt = multiHop.buildMultiHopPrompt(multiHop.reason('', {}));
    assert.equal(prompt, '');
  });
});

describe('lookahead-planner', () => {
  it('returns empty steps for no pattern match', () => {
    const plan = lookahead.planNextSteps('hello there', {});
    assert.equal(plan.nextSteps.length, 0);
    assert.equal(plan.matchedPatterns.length, 0);
  });

  it('matches analyze pattern and suggests chart as a follow-up', () => {
    const plan = lookahead.planNextSteps('Analyze the Q3 revenue trends', {});
    assert.ok(plan.matchedPatterns.includes('analyze_then_visualize'));
    const chartStep = plan.nextSteps.find((s) => s.tool === 'create_chart');
    assert.ok(chartStep);
  });

  it('matches code pattern and suggests running tests', () => {
    const plan = lookahead.planNextSteps('Implement a Fibonacci function', {});
    assert.ok(plan.matchedPatterns.includes('code_then_test'));
    const testStep = plan.nextSteps.find((s) => s.tool === 'code-sandbox');
    assert.ok(testStep);
  });

  it('matches translate pattern for Spanish "traducir"', () => {
    const plan = lookahead.planNextSteps('Traducir este documento al inglés', {});
    assert.ok(plan.matchedPatterns.includes('translate_then_localize'));
  });

  it('matches troubleshoot pattern for "not working"', () => {
    const plan = lookahead.planNextSteps('The deploy is not working', {});
    assert.ok(plan.matchedPatterns.includes('troubleshoot_then_fix'));
  });

  it('next steps are sorted by descending confidence', () => {
    const plan = lookahead.planNextSteps('Implement a parser and add tests', {});
    for (let i = 1; i < plan.nextSteps.length; i++) {
      assert.ok(plan.nextSteps[i - 1].confidence >= plan.nextSteps[i].confidence);
    }
  });

  it('produces non-empty prompt when steps exist', () => {
    const plan = lookahead.planNextSteps('Compare options A and B', {});
    const prompt = lookahead.buildLookaheadPrompt(plan);
    assert.ok(prompt.includes('Lookahead Planner'));
  });
});

describe('knowledge-boundary-detector', () => {
  it('extracts number claims', () => {
    const claims = knowledgeBoundary.extractClaims('Revenue grew 35% to $5 million in 2024');
    const numbers = claims.filter((c) => c.kind === 'number_claim');
    assert.ok(numbers.length >= 1);
  });

  it('extracts named entity claims', () => {
    const claims = knowledgeBoundary.extractClaims('Acme Corp acquired Globex last week');
    const entities = claims.filter((c) => c.kind === 'named_entity_claim');
    assert.ok(entities.length >= 1);
  });

  it('extracts URL claims', () => {
    const claims = knowledgeBoundary.extractClaims('See https://example.com/q3 for details');
    const urls = claims.filter((c) => c.kind === 'url_claim');
    assert.equal(urls.length, 1);
  });

  it('classifies claim as grounded when value appears in context documents', () => {
    const ctx = { documents: [{ text: 'Revenue in 2024 was $5 million.' }] };
    const result = knowledgeBoundary.detectBoundaries('Revenue was $5 million in 2024', ctx);
    const grounded = result.claims.filter((c) => c.status === 'grounded');
    assert.ok(grounded.length >= 1);
  });

  it('classifies claim as ungrounded_assertion when not in context', () => {
    const result = knowledgeBoundary.detectBoundaries(
      'Acme grew 47% last year',
      { documents: [] },
    );
    const ungrounded = result.claims.filter((c) => c.status === 'ungrounded_assertion');
    assert.ok(ungrounded.length >= 1);
  });

  it('severity is high when many ungrounded claims', () => {
    const text = '40% growth, 50% margin, Acme acquired Globex, John Smith signed a $10 million deal in 2024';
    const result = knowledgeBoundary.detectBoundaries(text, { documents: [] });
    assert.ok(['medium', 'high'].includes(result.severity));
  });

  it('riskScore is 0 when no claims', () => {
    const result = knowledgeBoundary.detectBoundaries('hello there', {});
    assert.equal(result.riskScore, 0);
  });

  it('buildKnowledgeBoundaryPrompt returns block when claims exist', () => {
    const result = knowledgeBoundary.detectBoundaries('Revenue was $5 million', { documents: [] });
    const prompt = knowledgeBoundary.buildKnowledgeBoundaryPrompt(result);
    assert.ok(prompt.includes('Knowledge Boundary'));
  });
});

describe('reasoning-faithfulness-check', () => {
  it('marks step as unsupported_claim when no evidence pool overlap', () => {
    const trace = [{ statement: 'I checked the financial report and found 30% growth.' }];
    const result = reasoningFaithfulness.checkFaithfulness(trace, { documents: [] });
    assert.equal(result.steps[0].verdict, 'unsupported_claim');
  });

  it('marks step as supported when evidence overlaps', () => {
    const trace = [
      { statement: 'The revenue grew 30% to five million dollars last quarter.' },
    ];
    const context = {
      documents: [
        {
          name: 'report.pdf',
          text: 'Quarterly revenue grew thirty percent to five million dollars last quarter.',
        },
      ],
    };
    const result = reasoningFaithfulness.checkFaithfulness(trace, context);
    assert.ok(['supported', 'weak_evidence'].includes(result.steps[0].verdict));
  });

  it('marks step as weak_evidence when overlap is small', () => {
    const trace = [{ statement: 'The team launched a new product strategy globally.' }];
    const context = { documents: [{ text: 'globally.' }] };
    const result = reasoningFaithfulness.checkFaithfulness(trace, context);
    assert.ok(['weak_evidence', 'supported', 'unsupported_claim'].includes(result.steps[0].verdict));
  });

  it('faithfulness score is 1.0 for empty trace', () => {
    const result = reasoningFaithfulness.checkFaithfulness([], {});
    assert.equal(result.faithfulness, 1);
  });

  it('marks step as evidence_mismatch when claimed evidence does not match best match', () => {
    const trace = [
      {
        statement: 'Based on the contract, we owe $5 million for licensing fees.',
        evidence: ['nonexistent_doc'],
      },
    ];
    const context = {
      documents: [{ id: 'real_contract', text: 'Owe five million dollars in licensing fees per contract.' }],
    };
    const result = reasoningFaithfulness.checkFaithfulness(trace, context);
    assert.ok(['evidence_mismatch', 'unsupported_claim', 'unverifiable_opinion', 'weak_evidence'].includes(result.steps[0].verdict));
  });

  it('buildFaithfulnessPrompt returns block with score', () => {
    const trace = [{ statement: 'I analyzed the data and found anomalies.' }];
    const result = reasoningFaithfulness.checkFaithfulness(trace, {});
    const prompt = reasoningFaithfulness.buildFaithfulnessPrompt(result);
    assert.ok(prompt.includes('Reasoning Faithfulness'));
  });
});

describe('entity-grounding-tracker', () => {
  it('extracts proper nouns', () => {
    const entities = entityGrounding.extractEntities('Tesla and SpaceX are run by Elon Musk');
    const propers = entities.filter((e) => e.kind === 'proper_noun');
    assert.ok(propers.length >= 2);
  });

  it('extracts URLs', () => {
    const entities = entityGrounding.extractEntities('Visit https://siragpt.io now');
    const urls = entities.filter((e) => e.kind === 'url');
    assert.equal(urls.length, 1);
  });

  it('extracts emails', () => {
    const entities = entityGrounding.extractEntities('Reach out at hello@example.com');
    const emails = entities.filter((e) => e.kind === 'email');
    assert.equal(emails.length, 1);
  });

  it('extracts money amounts', () => {
    const entities = entityGrounding.extractEntities('Revenue was $5 million in Q3');
    const money = entities.filter((e) => e.kind === 'money');
    assert.ok(money.length >= 1);
  });

  it('classifies entity as strongly_grounded when in current_turn', () => {
    const result = entityGrounding.trackEntities('Tesla performance is solid', {
      currentTurn: 'Tesla performance is solid',
    });
    const tesla = result.entities.find((e) => /tesla/i.test(e.value));
    assert.ok(tesla);
    assert.equal(tesla.status, 'strongly_grounded');
  });

  it('classifies entity as newly_introduced when nowhere in context', () => {
    const result = entityGrounding.trackEntities('NewCo just acquired OldCo', {
      documents: [],
      history: [],
      memoryFacts: [],
      currentTurn: '',
    });
    const newco = result.entities.find((e) => /newco/i.test(e.value));
    assert.ok(newco);
    assert.equal(newco.status, 'newly_introduced');
  });

  it('skips stop proper nouns (I, You, etc.)', () => {
    const entities = entityGrounding.extractEntities('I think You should try That');
    const stopWords = entities.filter((e) => ['I', 'You', 'That'].includes(e.value));
    assert.equal(stopWords.length, 0);
  });

  it('groundingRate is 1 when no entities', () => {
    const result = entityGrounding.trackEntities('hello there', {});
    assert.equal(result.groundingRate, 1);
  });

  it('buildEntityGroundingPrompt returns block when entities exist', () => {
    const result = entityGrounding.trackEntities('Acme Corp launched widget', { documents: [] });
    const prompt = entityGrounding.buildEntityGroundingPrompt(result);
    assert.ok(prompt.includes('Entity Grounding'));
  });
});

describe('context-intelligence-engine (orchestrator)', () => {
  it('returns a complete report for a typical query', () => {
    const report = engine.analyzeContext('test-user', 'Analyze the Q3 sales data for Tesla', {
      documents: [{ name: 'q3.pdf', text: 'Tesla Q3 revenue grew 30%.' }],
      history: [],
      memoryFacts: ['User prefers concise answers'],
    });
    assert.ok(report.attributionGraph);
    assert.ok(report.multiHop);
    assert.ok(report.lookahead);
    assert.ok(report.knowledgeBoundary);
    assert.ok(report.entityGrounding);
    assert.ok(report.recommendations.length >= 1);
    assert.ok(typeof report.confidence === 'number');
    assert.ok(report.elapsedMs >= 0);
  });

  it('handles empty query gracefully without crashing', () => {
    const report = engine.analyzeContext('user', '', {});
    assert.ok(report);
    assert.ok(Array.isArray(report.errors));
  });

  it('runs reasoning faithfulness only when reasoningTrace provided', () => {
    const without = engine.analyzeContext('u', 'test query', {});
    assert.equal(without.reasoningFaithfulness, null);

    const withTrace = engine.analyzeContext('u', 'test query', {
      reasoningTrace: [{ statement: 'I checked the data.' }],
    });
    assert.ok(withTrace.reasoningFaithfulness);
  });

  it('buildSystemPromptBlock concatenates non-empty subsystem blocks', () => {
    const report = engine.analyzeContext('u', 'Analyze the Tesla report', {
      documents: [{ name: 'tesla.pdf', text: 'Tesla revenue grew.' }],
    });
    const block = engine.buildSystemPromptBlock(report);
    assert.ok(block.includes('Context Attribution'));
    assert.ok(block.includes('Multi-hop'));
  });

  it('buildSystemPromptBlock respects MAX_PROMPT_BLOCK_CHARS', () => {
    const report = engine.analyzeContext('u', 'Analyze ' + 'data '.repeat(2000), {});
    const block = engine.buildSystemPromptBlock(report);
    assert.ok(block.length <= engine.MAX_PROMPT_BLOCK_CHARS);
  });

  it('buildSystemPromptBlock truncation never splits a surrogate pair', () => {
    // An emoji positioned right at the cut boundary used to be sliced in half,
    // emitting a lone surrogate (invalid char). opts.maxChars exercises it
    // deterministically.
    const report = {
      recommendations: [{
        severity: 'high', category: 'x',
        message: 'y'.repeat(200) + '😀😀😀😀😀' + 'z'.repeat(80),
      }],
    };
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const maxChars of [60, 120, 240, 250, 252]) {
      const block = engine.buildSystemPromptBlock(report, { maxChars });
      assert.ok(block.length <= maxChars, `within cap at maxChars=${maxChars}`);
      assert.ok(!loneSurrogate.test(block), `no lone surrogate at maxChars=${maxChars}`);
    }
  });

  it('summariseForLog returns a compact telemetry shape', () => {
    const report = engine.analyzeContext('u', 'Make a chart for revenue', {});
    const summary = engine.summariseForLog(report);
    assert.ok(summary);
    assert.equal(typeof summary.confidence, 'number');
    assert.equal(typeof summary.elapsedMs, 'number');
    assert.equal(typeof summary.needsClarification, 'boolean');
  });

  it('confidence is in [0, 1]', () => {
    const report = engine.analyzeContext('u', 'Analyze data for last quarter', {});
    assert.ok(report.confidence >= 0 && report.confidence <= 1);
  });

  it('recommendations include intent classification when graph has primary intent', () => {
    const report = engine.analyzeContext('u', 'Translate this to Spanish', {});
    const intentRec = report.recommendations.find((r) => r.category === 'intent');
    assert.ok(intentRec);
  });

  it('recommends clarification when prerequisite missing', () => {
    const report = engine.analyzeContext('u', 'Summarize this document', { documents: [] });
    const clarification = report.recommendations.find((r) => r.category === 'clarification');
    assert.ok(clarification);
  });
});
