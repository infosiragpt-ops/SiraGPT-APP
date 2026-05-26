'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../src/services/agents/intent-grounding-text');

// ─── detectHighCost ─────────────────────────────────────────────────

test('detect: presentation intent → high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'presentation_generation' },
  });
  assert.equal(d.isHighCost, true);
  assert.ok(d.reasons.some((r) => r.includes('presentation')));
});

test('detect: .pptx extension → high cost', () => {
  const d = G.detectHighCost({
    contract: { required_extension: '.pptx' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: SlidePipeline → high cost', () => {
  const d = G.detectHighCost({
    contract: { pipeline: 'SlidePipeline' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: ResearchGroundingPipeline → high cost', () => {
  const d = G.detectHighCost({
    contract: { pipeline: 'ResearchGroundingPipeline' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: scientific_research secondary → high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_secondary: ['scientific_research', 'doi_validation'] },
  });
  assert.equal(d.isHighCost, true);
  assert.ok(d.reasons.length >= 2);
});

test('detect: web_app_build → high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'web_app_build' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: video_generation → high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'video_generation' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: agent_long_running_task → high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'agent_long_running_task' },
  });
  assert.equal(d.isHighCost, true);
});

test('detect: required_tools includes generate_video → high cost', () => {
  const d = G.detectHighCost({
    requiredTools: ['generate_video', 'create_chart'],
  });
  assert.equal(d.isHighCost, true);
  assert.ok(d.reasons.some((r) => r.includes('tool:generate_video')));
});

test('detect: cost_class explícito → high cost', () => {
  const d = G.detectHighCost({
    contract: { cost_class: 'high' },
  });
  assert.equal(d.isHighCost, true);
  assert.ok(d.reasons.some((r) => r.includes('cost_class:high')));
});

test('detect: text_answer → NOT high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'text_answer' },
    contract: { required_extension: null, pipeline: 'DirectAnswerPipeline' },
  });
  assert.equal(d.isHighCost, false);
});

test('detect: simple chart viz → NOT high cost', () => {
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'viz_generation' },
    contract: { required_extension: '.svg' },
  });
  assert.equal(d.isHighCost, false);
});

test('detect: docx generation → NOT high cost (medium intent, not high-cost set)', () => {
  // .docx no está en HIGH_COST_EXTENSIONS; depende del intent
  const d = G.detectHighCost({
    structuredIntent: { intent_primary: 'spreadsheet_generation' },
    contract: { required_extension: '.xlsx' },
  });
  assert.equal(d.isHighCost, false);
});

test('detect: empty args → not high cost', () => {
  assert.equal(G.detectHighCost({}).isHighCost, false);
  assert.equal(G.detectHighCost().isHighCost, false);
});

// ─── buildGroundingPromptBlock ───────────────────────────────────────

test('build: returns null when not high cost', () => {
  assert.equal(G.buildGroundingPromptBlock({ isHighCost: false, reasons: [] }), null);
  assert.equal(G.buildGroundingPromptBlock(null), null);
});

test('build: returns block with reasons', () => {
  const block = G.buildGroundingPromptBlock({ isHighCost: true, reasons: ['intent:presentation_generation'] });
  assert.match(block, /GROUNDING_PREFACE/);
  assert.match(block, /presentation_generation/);
  assert.match(block, /Procedo/);
});

test('build: instructs LLM to start with "Entendí"', () => {
  const block = G.buildGroundingPromptBlock({ isHighCost: true, reasons: ['x'] });
  assert.match(block, /preámbulo/i);
  assert.match(block, /1-2 frases/);
});

test('build: caps reasons at 4', () => {
  const reasons = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const block = G.buildGroundingPromptBlock({ isHighCost: true, reasons });
  // No debe listar 7 razones
  assert.equal((block.match(/a, b, c, d/) || []).length, 1);
  assert.ok(!block.includes('e, f, g'));
});

test('build: instructs no blocking confirmation', () => {
  const block = G.buildGroundingPromptBlock({ isHighCost: true, reasons: ['x'] });
  assert.match(block, /NO pidas confirmación bloqueante/);
});

// ─── shouldInjectGrounding (integration) ─────────────────────────────

test('inject: high-cost case returns block', () => {
  const out = G.shouldInjectGrounding({
    structuredIntent: { intent_primary: 'presentation_generation' },
  });
  assert.ok(out && out.includes('GROUNDING_PREFACE'));
});

test('inject: low-cost case returns null', () => {
  const out = G.shouldInjectGrounding({
    structuredIntent: { intent_primary: 'text_answer' },
    contract: { pipeline: 'DirectAnswerPipeline' },
  });
  assert.equal(out, null);
});

test('inject: handles undefined args gracefully', () => {
  assert.equal(G.shouldInjectGrounding(), null);
  assert.equal(G.shouldInjectGrounding(null), null);
});
