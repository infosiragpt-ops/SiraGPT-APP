'use strict';

// Request-intent "brain" — regression tests for topic-vs-conditions
// separation. Live failure: "crea una ppt de la gestión administrativa en 10
// Landin porfavor de forma muy profeiosnal" became the literal deck title and
// the thesis hallucinated "las diez sucursales de Landin".

const test = require('node:test');
const assert = require('node:assert');

process.env.SIRAGPT_PPTX_DECK_DESIGNER = '0';

const pipeline = require('../src/services/document-pipeline/advanced-document-pipeline');
const { normalizeIntent } = require('../src/services/document-pipeline/content/parse-document-request');

const { buildPlan } = pipeline;

test('deterministic: slide count + courtesy + quality phrases never reach the title', () => {
  const plan = buildPlan({ prompt: 'crea una ppt de la gestión administrativa en 10 láminas por favor de forma muy profesional', format: 'pptx', template: 'business', complexity: 'standard' });
  assert.equal(plan.title, 'Gestión administrativa');
  assert.equal(plan.slideTarget, 10);
});

test('deterministic: diapositivas/slides variants parse as slideTarget', () => {
  assert.equal(buildPlan({ prompt: 'presentación de ventas en 8 diapositivas', format: 'pptx', template: 'business', complexity: 'standard' }).slideTarget, 8);
  assert.equal(buildPlan({ prompt: 'deck about churn in 12 slides', format: 'pptx', template: 'business', complexity: 'standard' }).slideTarget, 12);
  assert.equal(buildPlan({ prompt: 'ppt sobre logística', format: 'pptx', template: 'business', complexity: 'standard' }).slideTarget, null);
});

test('deterministic: courtesy stripped even when constraint word is typo\'d', () => {
  const plan = buildPlan({ prompt: 'crea una ppt de la gestión administrativa en 10 Landin porfavor de forma muy profeiosnal', format: 'pptx', template: 'business', complexity: 'standard' });
  assert.ok(!/porfavor|profeiosnal|de forma/.test(plan.title), `courtesy/quality gone: ${plan.title}`);
});

test('deterministic: audience and visual style stay out of the deck title', () => {
  const plan = buildPlan({
    prompt: 'Créame una presentación ejecutiva y minimalista en 8 diapositivas sobre gestión de empresas para un directorio. Debe incluir estrategia, operaciones, personas, riesgos y próximos pasos. No inventes estadísticas.',
    format: 'pptx',
    template: 'business',
    complexity: 'standard',
  });
  assert.equal(plan.title, 'Gestión de empresas');
  assert.equal(plan.slideTarget, 8);
  assert.equal(plan.presentationBrief.audience, 'directorio');
  assert.equal(plan.presentationBrief.visualStyle, 'minimalista');
  assert.deepEqual(plan.presentationBrief.mustInclude, ['estrategia', 'operaciones', 'personas', 'riesgos', 'próximos pasos']);
  assert.deepEqual(plan.presentationBrief.mustAvoid, ['estadísticas']);
});

test('normalizeIntent clamps counts and preserves the presentation brief', () => {
  const good = normalizeIntent({
    topic: 'gestión administrativa',
    title: 'Gestión Administrativa',
    slideCount: 10,
    wordCount: null,
    pageCount: null,
    conditions: ['muy profesional'],
    audience: 'directorio',
    purpose: 'apoyar una decisión',
    tone: 'ejecutivo',
    visualStyle: 'minimalista',
    mustInclude: ['cronograma', 'riesgos'],
    mustAvoid: ['estadísticas sin fuente'],
  });
  assert.equal(good.slideCount, 10);
  assert.deepEqual(good.conditions, ['muy profesional']);
  assert.equal(good.audience, 'directorio');
  assert.deepEqual(good.mustInclude, ['cronograma', 'riesgos']);
  assert.deepEqual(good.mustAvoid, ['estadísticas sin fuente']);
  assert.equal(normalizeIntent({ topic: '', title: 'x', slideCount: 5 }), null);
  assert.equal(normalizeIntent({ topic: 't', title: 'Valid Title', slideCount: 999, wordCount: 5, pageCount: 0, conditions: [] }).slideCount, null, 'out-of-range slideCount clamped to null');
});

test('parseDocumentRequest fails open without provider keys', async (t) => {
  const saved = {};
  for (const key of ['CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) { saved[key] = process.env[key]; delete process.env[key]; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
  const { parseDocumentRequest } = require('../src/services/document-pipeline/content/parse-document-request');
  assert.equal(await parseDocumentRequest({ prompt: 'ppt de ventas en 10 láminas' }), null);
});

// ── Universal coverage: the interpretation rule must live in every brain ────

test('master-prompt carries the always-on interpretation rule (all chat paths)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/master-prompt'), 'utf8');
  assert.ok(src.includes('INTERPRET THE REQUEST BEFORE EXECUTING'), 'ABSOLUTE RULE present');
  assert.ok(src.includes('Landin'), 'typo-repair guidance present');
});

test('agent-core planner rules carry topic-vs-conditions interpretation', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/agents/agent-core'), 'utf8');
  assert.ok(src.includes('DELIVERY CONDITIONS'), 'agent loop rule present');
});

test('sandbox file tool instructs topic-only filenames', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/agents/task-tools'), 'utf8');
  assert.ok(src.includes('FILENAMES & TITLES: derive them from the CORE TOPIC only'));
});
