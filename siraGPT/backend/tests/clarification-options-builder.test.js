'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClarificationOptions,
  MAX_OPTIONS,
  MIN_OPTIONS,
  _internal,
} = require('../src/services/agents/clarification-options-builder');

function makeAnalysis({
  formats = [],
  signals = {},
  secondary = [],
  pipeline = null,
  primary = null,
  envelopeQuestions = [],
} = {}) {
  return {
    routing: {
      domain_signals: signals,
      pipeline,
    },
    request_intelligence: {
      requested_formats: formats.map((f) => ({ extension: f.startsWith('.') ? f : `.${f}` })),
    },
    structured_intent: {
      intent_primary: primary,
      intent_secondary: secondary,
    },
    contract: { pipeline },
    cira_task_envelope: {
      clarification_policy: { questions: envelopeQuestions },
    },
  };
}

// ─── Format conflict ─────────────────────────────────────────────────

test('format conflict: docx + xlsx → 2 format options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ formats: ['.docx', '.xlsx'] }),
    prompt: 'prepara el informe',
  });
  assert.equal(r.source, 'format_conflict');
  assert.equal(r.options.length, 2);
  assert.match(r.options[0].label, /Word|Excel/i);
  assert.equal(r.options[0].contractPatch.required_extension, '.docx');
});

test('format conflict: docx + pptx + pdf → 3 options capped', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ formats: ['.docx', '.pptx', '.pdf', '.xlsx'] }),
    prompt: 'envíame el material',
  });
  assert.equal(r.source, 'format_conflict');
  assert.equal(r.options.length, MAX_OPTIONS);
});

test('format conflict: each option has intentHint mapped to correct chat intent', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ formats: ['.docx', '.pptx'] }),
    prompt: 'el material',
  });
  const docx = r.options.find((o) => o.contractPatch.required_extension === '.docx');
  const pptx = r.options.find((o) => o.contractPatch.required_extension === '.pptx');
  assert.equal(docx.intentHint, 'doc');
  assert.equal(pptx.intentHint, 'ppt');
});

// ─── Signal conflict ─────────────────────────────────────────────────

test('signal conflict: doc + viz → 2 options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { doc: true, viz: true } }),
    prompt: 'hazme algo con esos datos',
  });
  assert.equal(r.source, 'signal_conflict');
  assert.ok(r.options.length >= MIN_OPTIONS);
  const labels = r.options.map((o) => o.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes('documento')));
  assert.ok(labels.some((l) => l.includes('visualización') || l.includes('gráfico') || l.includes('diagrama')));
});

test('signal conflict: viz + codeWork → 2 options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { viz: true, codeWork: true } }),
    prompt: 'algo con esto',
  });
  assert.equal(r.source, 'signal_conflict');
  assert.ok(r.options.length >= MIN_OPTIONS);
});

test('signal conflict: dataWork + viz → 2 options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { dataWork: true, viz: true } }),
    prompt: 'hazme un análisis',
  });
  assert.equal(r.source, 'signal_conflict');
});

test('signal conflict: doc + ppt + viz → 3 options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { doc: true, ppt: true, viz: true } }),
    prompt: 'prepara el material',
  });
  assert.equal(r.source, 'signal_conflict');
  assert.ok(r.options.length >= MIN_OPTIONS);
});

test('signal conflict: only one signal active → no signal conflict, falls to canonical', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { doc: true } }),
    prompt: 'el material',
  });
  // Solo una señal no debería generar conflicto de señales; depende de pipeline
  assert.notEqual(r.source, 'signal_conflict');
});

test('signal conflict: webdev + doc → web vs document options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { webdev: true, doc: true } }),
    prompt: 'crea algo',
  });
  assert.equal(r.source, 'signal_conflict');
  const labels = r.options.map((o) => o.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes('web')));
  assert.ok(labels.some((l) => l.includes('documento')));
});

// ─── Secondary intents ───────────────────────────────────────────────

test('secondary intents: 3 candidates without primary → secondary_intents source', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({
      secondary: ['docx_export', 'spreadsheet_export', 'apa7_citation'],
      primary: 'text_answer',
    }),
    prompt: 'el material académico',
  });
  // Puede caer en secondary_intents si no hay format/signal conflict
  assert.ok(['secondary_intents', 'canonical_fallback'].includes(r.source));
  assert.ok(r.options.length >= MIN_OPTIONS);
});

// ─── Canonical fallback ──────────────────────────────────────────────

test('canonical fallback: vague short prompt with no signals → 3 canonical options', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ pipeline: 'DirectAnswerPipeline' }),
    prompt: 'hazme uno',
  });
  assert.equal(r.source, 'canonical_fallback');
  assert.equal(r.options.length, 3);
  const labels = r.options.map((o) => o.label.toLowerCase());
  assert.ok(labels.some((l) => l.includes('chat') || l.includes('texto')));
  assert.ok(labels.some((l) => l.includes('documento')));
  assert.ok(labels.some((l) => l.includes('visualización') || l.includes('gráfico')));
});

test('canonical fallback: empty analysis → safe fallback (no_analysis)', () => {
  const r = buildClarificationOptions({ analysis: null, prompt: 'algo' });
  assert.equal(r.source, 'no_analysis');
  assert.equal(r.options.length, 0);
});

test('canonical fallback: long specific prompt without conflicts → no_match', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ pipeline: 'CodePipeline' }),
    prompt: 'implementa una función en TypeScript que valide un email con regex y devuelva un objeto con éxito y razón',
  });
  // Sin format/signal conflict, prompt largo y pipeline definido → no canonical
  assert.equal(r.source, 'no_match');
  assert.equal(r.options.length, 0);
});

// ─── Question text ───────────────────────────────────────────────────

test('question: envelope question used when available', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({
      signals: { doc: true, viz: true },
      envelopeQuestions: ['¿Qué tema cubre el informe?'],
    }),
    prompt: 'algo',
  });
  assert.equal(r.question, '¿Qué tema cubre el informe?');
});

test('question: envelope sentinel (snake_case-only) ignored, uses default for source', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({
      signals: { doc: true, viz: true },
      envelopeQuestions: ['missing_critical_execution_detail'],
    }),
    prompt: 'algo',
  });
  assert.match(r.question, /¿Qué quieres|exactamente/i);
});

// ─── Robustness ──────────────────────────────────────────────────────

test('robustness: malformed analysis fields → safe fallback', () => {
  const r = buildClarificationOptions({
    analysis: { routing: 'not-an-object', request_intelligence: 42 },
    prompt: 'algo',
  });
  assert.ok(['no_match', 'canonical_fallback', 'no_analysis', 'error'].some((s) => r.source.startsWith(s)) || r.source === 'no_match');
  assert.ok(Array.isArray(r.options));
});

test('robustness: long label gets clamped', () => {
  const longLabel = 'a'.repeat(200);
  const clamped = _internal.clampLabel(longLabel);
  assert.ok(clamped.length <= 80);
  assert.ok(clamped.endsWith('…'));
});

test('robustness: uniqueByLabel dedupes case-insensitively', () => {
  const opts = [
    { label: 'Generar documento' },
    { label: 'GENERAR DOCUMENTO' },
    { label: 'Otra' },
  ];
  const u = _internal.uniqueByLabel(opts);
  assert.equal(u.length, 2);
});

test('robustness: intent helper maps known intents to chat intents', () => {
  assert.equal(_internal.intentToChatIntent('complex_academic_document_generation'), 'doc');
  assert.equal(_internal.intentToChatIntent('presentation_generation'), 'ppt');
  assert.equal(_internal.intentToChatIntent('viz_generation'), 'viz');
  assert.equal(_internal.intentToChatIntent('web_app_build'), 'webdev');
  assert.equal(_internal.intentToChatIntent('research_question'), 'web_search');
  assert.equal(_internal.intentToChatIntent('unknown_xyz'), 'text');
});

test('robustness: humanizeIntentName converts snake_case', () => {
  assert.equal(_internal.humanizeIntentName('text_answer'), 'Respuesta en chat');
  assert.equal(_internal.humanizeIntentName('unknown_random_intent'), 'Unknown Random Intent');
  assert.equal(_internal.humanizeIntentName(null), null);
});

test('robustness: readRequestedFormats accepts string or object form', () => {
  const a1 = { request_intelligence: { requested_formats: ['docx', 'pdf'] } };
  const a2 = { request_intelligence: { requested_formats: [{ extension: '.xlsx' }] } };
  assert.deepEqual(_internal.readRequestedFormats(a1), ['.docx', '.pdf']);
  assert.deepEqual(_internal.readRequestedFormats(a2), ['.xlsx']);
});

test('robustness: all options have required shape', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({ signals: { doc: true, viz: true } }),
    prompt: 'algo',
  });
  for (const opt of r.options) {
    assert.ok(typeof opt.label === 'string' && opt.label.length > 0);
    assert.ok(typeof opt.intentHint === 'string');
    assert.ok(opt.contractPatch && typeof opt.contractPatch === 'object');
  }
});

test('robustness: never returns more than MAX_OPTIONS', () => {
  const r = buildClarificationOptions({
    analysis: makeAnalysis({
      signals: { doc: true, viz: true, ppt: true, webdev: true, codeWork: true, dataWork: true },
    }),
    prompt: 'algo',
  });
  assert.ok(r.options.length <= MAX_OPTIONS);
});

test('robustness: builder swallows exceptions and returns safe fallback', () => {
  // Pasar un objeto que rompa los reads internos
  const evil = new Proxy({}, {
    get(_t, key) {
      if (key === 'routing') throw new Error('boom');
      return undefined;
    },
  });
  const r = buildClarificationOptions({ analysis: evil, prompt: 'algo' });
  assert.ok(r);
  assert.ok(Array.isArray(r.options));
  assert.ok(r.source.startsWith('error:') || r.source === 'no_match' || r.source === 'canonical_fallback');
});
