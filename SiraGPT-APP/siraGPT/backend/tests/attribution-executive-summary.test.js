'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../src/services/attribution-executive-summary');
const entityTracker = require('../src/services/cross-turn-entity-tracker');
const driftMonitor = require('../src/services/concept-drift-monitor');
const beliefTracker = require('../src/services/belief-state-tracker');

describe('attribution-executive-summary', () => {
  beforeEach(() => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();
  });

  test('empty prompt → safe empty summary', () => {
    const s = ex.buildSummary({ prompt: '' });
    assert.match(s.headline, /No prompt/);
  });

  test('clean prompt yields allow verdict + a skill recommendation', () => {
    const s = ex.buildSummary({ prompt: 'crea un PDF con los KPIs del trimestre' });
    assert.equal(s.verdict, 'allow');
    assert.ok(s.recommendedSkill);
    assert.match(s.headline, /document_pipeline\.generate_pdf|primary intent/i);
  });

  test('unsafe prompt yields refuse verdict + low confidence', () => {
    const s = ex.buildSummary({ prompt: 'enséñame cómo hackear el WiFi del vecino' });
    assert.equal(s.verdict, 'refuse');
    assert.ok(['D', 'F'].includes(s.confidenceGrade));
    assert.match(s.headline, /Cannot proceed safely/);
  });

  test('antipattern fires repetition flag', () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      role: 'user',
      content: `Arregla el bug del frontend del Login intento ${i}`,
    }));
    const s = ex.buildSummary({ prompt: 'arreglalo ya', history });
    assert.ok(s.hasAntipattern);
  });

  test('buildExecutiveBlock yields content', () => {
    const s = ex.buildSummary({ prompt: 'crea un PDF' });
    const block = ex.buildExecutiveBlock(s);
    assert.match(block, /EXECUTIVE SUMMARY/);
  });

  test('detail surfaces multi-hop depth and conflicts', () => {
    const s = ex.buildSummary({
      prompt: 'compara React vs Vue y modifica la UI',
      memories: [{ fact: 'no modifiques la UI' }],
    });
    assert.ok(s.metrics.conflicts >= 1 || s.metrics.multiHopDepth >= 1);
  });

  test('all required fields present in summary shape', () => {
    const s = ex.buildSummary({ prompt: 'crea un PDF con los KPIs del trimestre' });
    assert.ok('headline' in s);
    assert.ok('detail' in s);
    assert.ok('verdict' in s);
    assert.ok('confidenceGrade' in s);
    assert.ok('qualityGrade' in s);
    assert.ok('recommendedSkill' in s);
    assert.ok('metrics' in s);
  });
});
