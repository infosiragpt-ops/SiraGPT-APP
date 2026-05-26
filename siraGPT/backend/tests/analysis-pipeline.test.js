'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runAnalysisPipeline,
  runMultiDocumentAnalysis,
  buildAnalysisSystemPrompt,
  STAGES,
  STAGE_LABELS,
} = require('../src/services/analysis-pipeline');

test('exports the documented surface', () => {
  assert.equal(typeof runAnalysisPipeline, 'function');
  assert.equal(typeof runMultiDocumentAnalysis, 'function');
  assert.equal(typeof buildAnalysisSystemPrompt, 'function');
  assert.equal(typeof STAGES, 'object');
  assert.equal(typeof STAGE_LABELS, 'object');
});

test('STAGES + STAGE_LABELS cover the pipeline lifecycle', () => {
  for (const required of ['DETECTING_FORMAT', 'DETECTING_DOMAIN', 'EXTRACTING_ENTITIES', 'BUILDING_STRUCTURE', 'ASSESSING_RISKS', 'COMPUTING_QUALITY', 'BUILDING_DIMENSIONS', 'MAPPING_RISKS', 'COMPLETE']) {
    assert.ok(STAGES[required], `expected stage ${required}`);
    assert.ok(STAGE_LABELS[STAGES[required]], `expected label for ${required}`);
  }
});

test('runAnalysisPipeline returns ok:true with the documented top-level fields', () => {
  const text = '# Test Document\n\nThis is the body of a small document with the year 2026 and the value $1,250 USD mentioned.';
  const result = runAnalysisPipeline(text, { fileName: 'test.md', mimeType: 'text/markdown' });
  assert.equal(result.ok, true);
  for (const key of ['format', 'domain', 'entities', 'piiSummary', 'structure', 'risks', 'quality', 'dimensions', 'riskMapping', 'autoTags', 'stages', 'metadata']) {
    assert.ok(key in result, `expected field ${key} on the analysis result`);
  }
});

test('runAnalysisPipeline records a stage entry per major step', () => {
  const result = runAnalysisPipeline('Some text body here with content', {});
  assert.ok(Array.isArray(result.stages));
  // 8 stage transitions in the pipeline up through MAPPING_RISKS
  assert.ok(result.stages.length >= 7);
  const stageNames = result.stages.map((s) => s.stage);
  assert.ok(stageNames.includes(STAGES.DETECTING_FORMAT));
  assert.ok(stageNames.includes(STAGES.EXTRACTING_ENTITIES));
  assert.ok(stageNames.includes(STAGES.ASSESSING_RISKS));
});

test('runAnalysisPipeline metadata captures fileName, mimeType, pipelineVersion, elapsedMs', () => {
  const result = runAnalysisPipeline('content', { fileName: 'a.txt', mimeType: 'text/plain' });
  assert.equal(result.metadata.fileName, 'a.txt');
  assert.equal(result.metadata.mimeType, 'text/plain');
  assert.equal(typeof result.metadata.elapsedMs, 'number');
  assert.ok(result.metadata.elapsedMs >= 0);
  assert.match(result.metadata.pipelineVersion, /^\d+\.\d+\.\d+$/);
  assert.match(result.metadata.analyzedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('runAnalysisPipeline summarises piiSummary counters by sensitivity', () => {
  const result = runAnalysisPipeline('User contact: alice@example.com phone 555-123-4567 SSN 123-45-6789', {});
  const pii = result.piiSummary;
  assert.equal(typeof pii.total, 'number');
  assert.equal(typeof pii.critical, 'number');
  assert.equal(typeof pii.high, 'number');
  assert.equal(typeof pii.medium, 'number');
  assert.equal(typeof pii.low, 'number');
  // Sum of sensitivity bands equals total minus non-PII entities
  // (we don't pin exact values — different detectors evolve — but
  // the structure must hold).
});

test('runMultiDocumentAnalysis aggregates per-document analyses + a cross-report', () => {
  const docs = [
    { name: 'a.txt', text: 'first document content with year 2026', mimeType: 'text/plain' },
    { name: 'b.txt', text: 'second document content with year 2026', mimeType: 'text/plain' },
  ];
  const out = runMultiDocumentAnalysis(docs);
  assert.equal(out.ok, true);
  assert.equal(out.documentCount, 2);
  assert.equal(out.analyses.length, 2);
  assert.ok(out.crossAnalysis);
  assert.ok(typeof out.crossAnalysis.synthesis === 'object');
  assert.match(out.metadata.pipelineVersion, /^\d+\.\d+\.\d+$/);
});

test('runMultiDocumentAnalysis tolerates the .content / .extractedText / .text key aliases', () => {
  const docs = [
    { name: 'a', text: 'first body' },
    { name: 'b', extractedText: 'second body' },
    { name: 'c', content: 'third body' },
  ];
  const out = runMultiDocumentAnalysis(docs);
  assert.equal(out.documentCount, 3);
  assert.equal(out.analyses.length, 3);
  for (const a of out.analyses) {
    assert.equal(a.ok, true);
  }
});

test('buildAnalysisSystemPrompt returns "" when analysis is missing or not ok', () => {
  assert.equal(buildAnalysisSystemPrompt(null), '');
  assert.equal(buildAnalysisSystemPrompt({}), '');
  assert.equal(buildAnalysisSystemPrompt({ ok: false }), '');
});

test('buildAnalysisSystemPrompt emits the documented sections from a real analysis result', () => {
  const text = '# Title\n\nFinancial body with amount $5,000 USD and Q1 2026 milestone.';
  const analysis = runAnalysisPipeline(text);
  const prompt = buildAnalysisSystemPrompt(analysis);
  assert.match(prompt, /AN[ÁA]LISIS PROFESIONAL DEL DOCUMENTO/);
  assert.match(prompt, /\*\*Formato:\*\*/);
  assert.match(prompt, /\*\*Dominio:\*\*/);
  assert.match(prompt, /\*\*Calidad:\*\*/);
  assert.match(prompt, /\*\*Riesgo:\*\*/);
  assert.match(prompt, /\*\*PII:\*\*/);
  assert.match(prompt, /\*\*Estructura:\*\*/);
  assert.match(prompt, /Instrucciones para la Respuesta/);
});

test('buildAnalysisSystemPrompt caps dimensions list at 4 and risks at 5', () => {
  // Build a synthetic analysis with many dimensions + risks to assert the slice
  const analysis = {
    ok: true,
    format: 'markdown',
    domain: { primary: 'general', confidence: 0.6 },
    quality: { grade: 'B', overall: 75 },
    risks: {
      severity: 'medium',
      items: Array.from({ length: 20 }, (_, i) => ({ severity: 'medium', description: `risk ${i}`, recommendation: `mitigate ${i}` })),
    },
    piiSummary: { total: 0, critical: 0 },
    structure: { headingCount: 1, wordCount: 100 },
    autoTags: [],
    dimensions: Array.from({ length: 10 }, (_, i) => ({ label: `dim ${i}`, weight: 0.1, findings: [{}] })),
    riskMapping: { uncovered: [] },
  };
  const prompt = buildAnalysisSystemPrompt(analysis);
  // Dimensions cap: only 4 should appear
  assert.equal((prompt.match(/- \*\*dim \d+\*\*/g) || []).length, 4);
  // Risks cap: only 5 should appear
  assert.equal((prompt.match(/- \*\*\[MEDIUM\]\*\* risk \d+/g) || []).length, 5);
});
