'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runUnderstandingEval,
  compareReports,
  readCorpus,
  _internal,
} = require('../src/services/agents/understanding-eval-harness');

function writeTempCorpus(rows) {
  const tmp = path.join(os.tmpdir(), `understanding-corpus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
  return tmp;
}

// ─── Internal helpers ────────────────────────────────────────────────

test('f1FromCounts: zero counts → zero f1', () => {
  const r = _internal.f1FromCounts(0, 0, 0);
  assert.equal(r.f1, 0);
  assert.equal(r.precision, 0);
  assert.equal(r.recall, 0);
});

test('f1FromCounts: perfect match', () => {
  const r = _internal.f1FromCounts(10, 0, 0);
  assert.equal(r.f1, 1);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});

test('f1FromCounts: precision/recall trade-off', () => {
  const r = _internal.f1FromCounts(5, 5, 5);
  assert.equal(r.precision, 0.5);
  assert.equal(r.recall, 0.5);
  assert.equal(r.f1, 0.5);
});

test('multiLabelMatch: exact set match', () => {
  const m = _internal.multiLabelMatch(['a', 'b'], ['a', 'b']);
  assert.equal(m.tp, 2);
  assert.equal(m.fp, 0);
  assert.equal(m.fn, 0);
});

test('multiLabelMatch: false positives and negatives', () => {
  const m = _internal.multiLabelMatch(['a', 'c'], ['a', 'b']);
  assert.equal(m.tp, 1);
  assert.equal(m.fp, 1); // c
  assert.equal(m.fn, 1); // b
});

test('multiLabelMatch: empty inputs', () => {
  const m = _internal.multiLabelMatch([], []);
  assert.equal(m.tp, 0);
  assert.equal(m.fp, 0);
  assert.equal(m.fn, 0);
});

test('normalizeIntent: known sinónimos colapsan', () => {
  assert.equal(_internal.normalizeIntent('small_talk'), 'text_answer');
  assert.equal(_internal.normalizeIntent('chitchat'), 'text_answer');
  assert.equal(_internal.normalizeIntent('database_query'), 'code_generation');
  assert.equal(_internal.normalizeIntent('pdf_report_generation'), 'complex_academic_document_generation');
  assert.equal(_internal.normalizeIntent('video_generation'), 'agent_long_running_task');
});

test('normalizeIntent: intent desconocido pasa intacto', () => {
  assert.equal(_internal.normalizeIntent('completely_new_intent'), 'completely_new_intent');
});

test('normalizeIntent: null/undefined passthrough', () => {
  assert.equal(_internal.normalizeIntent(null), null);
  assert.equal(_internal.normalizeIntent(undefined), undefined);
});

test('multiLabelMatch: sinónimo match cuenta como tp via equivalencia', () => {
  const m = _internal.multiLabelMatch(['small_talk'], ['text_answer']);
  assert.equal(m.tp, 1);
  assert.equal(m.fp, 0);
  assert.equal(m.fn, 0);
});

test('computeECE: empty input → 0', () => {
  assert.equal(_internal.computeECE([]), 0);
});

test('computeECE: perfect calibration', () => {
  // Buckets with avgConf == accuracy
  const pairs = [
    { score: 0.05, correct: false },
    { score: 0.05, correct: false },
    { score: 0.95, correct: true },
    { score: 0.95, correct: true },
  ];
  const ece = _internal.computeECE(pairs);
  assert.ok(ece < 0.1, `expected near-zero ECE, got ${ece}`);
});

test('computeECE: max miscalibration', () => {
  // All high-confidence but all wrong
  const pairs = [
    { score: 0.99, correct: false },
    { score: 0.99, correct: false },
    { score: 0.99, correct: false },
  ];
  const ece = _internal.computeECE(pairs);
  assert.ok(ece > 0.9, `expected high ECE, got ${ece}`);
});

test('optionsContainKeyword: case-insensitive matching', () => {
  assert.equal(_internal.optionsContainKeyword([{ label: 'Documento Word' }], ['word']), true);
  assert.equal(_internal.optionsContainKeyword([{ label: 'PDF' }], ['word']), false);
});

test('optionsContainKeyword: accepts string options', () => {
  assert.equal(_internal.optionsContainKeyword(['Documento', 'Visualización'], ['visual']), true);
});

test('optionsContainKeyword: no keywords → always true', () => {
  assert.equal(_internal.optionsContainKeyword([{ label: 'x' }], []), true);
});

test('optionsContainKeyword: empty options → false', () => {
  assert.equal(_internal.optionsContainKeyword([], ['x']), false);
});

// ─── Corpus parsing ──────────────────────────────────────────────────

test('readCorpus: parses valid JSONL', () => {
  const tmp = writeTempCorpus([
    { id: 'a', prompt: 'hola' },
    { id: 'b', prompt: 'adiós' },
  ]);
  const { rows, parseErrors } = readCorpus(tmp);
  assert.equal(rows.length, 2);
  assert.equal(parseErrors.length, 0);
  fs.unlinkSync(tmp);
});

test('readCorpus: reports parse errors per line', () => {
  const tmp = path.join(os.tmpdir(), `bad-corpus-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, `{"id":"ok","prompt":"x"}\n{broken json}\n{"id":"ok2","prompt":"y"}`);
  const { rows, parseErrors } = readCorpus(tmp);
  assert.equal(rows.length, 2);
  assert.equal(parseErrors.length, 1);
  assert.equal(parseErrors[0].line, 2);
  fs.unlinkSync(tmp);
});

test('readCorpus: throws when path does not exist', () => {
  assert.throws(() => readCorpus('/nonexistent/path/no.jsonl'), /not found/i);
});

// ─── Harness end-to-end with mocks ───────────────────────────────────

test('runUnderstandingEval: end-to-end with mocked router+triage', async () => {
  const tmp = writeTempCorpus([
    { id: 'r1', prompt: 'Genera un Word', expected_intent: { intent_primary: 'doc_gen' }, expected_action: 'execute' },
    { id: 'r2', prompt: 'hazme uno', expected_action: 'ask', expected_options: ['documento'] },
  ]);

  const runRouter = async (row) => ({
    intent_primary: row.id === 'r1' ? 'doc_gen' : 'text_answer',
    intent_secondary: [],
    required_extension: row.id === 'r1' ? '.docx' : null,
    ambiguity_score: row.id === 'r1' ? 0.1 : 0.9,
  });

  const runTriage = async (row) => ({
    action: row.id === 'r1' ? 'execute' : 'ask',
    options: row.id === 'r2' ? [{ label: 'Generar documento' }] : [],
  });

  const report = await runUnderstandingEval({ corpusPath: tmp, runRouter, runTriage });

  assert.equal(report.n_rows, 2);
  assert.equal(report.n_evaluated, 2);
  assert.equal(report.metrics.intent_accuracy.f1, 1);
  assert.equal(report.metrics.clarify.f1, 1);
  assert.equal(report.metrics.options_precision, 1);
  assert.ok(report.metrics.ambiguity_calibration_ece < 0.2);

  fs.unlinkSync(tmp);
});

test('runUnderstandingEval: handles router errors gracefully', async () => {
  const tmp = writeTempCorpus([
    { id: 'good', prompt: 'ok', expected_action: 'execute' },
    { id: 'bad', prompt: 'crash', expected_action: 'execute' },
  ]);

  const runRouter = async (row) => {
    if (row.id === 'bad') throw new Error('router boom');
    return { intent_primary: 'text_answer', ambiguity_score: 0.1 };
  };
  const runTriage = async () => ({ action: 'execute', options: [] });

  const report = await runUnderstandingEval({ corpusPath: tmp, runRouter, runTriage });
  assert.equal(report.n_evaluated, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].id, 'bad');
  assert.equal(report.errors[0].phase, 'router');

  fs.unlinkSync(tmp);
});

test('runUnderstandingEval: handles triage errors gracefully', async () => {
  const tmp = writeTempCorpus([{ id: 'x', prompt: 'p', expected_action: 'execute' }]);
  const runRouter = async () => ({ intent_primary: 'x', ambiguity_score: 0 });
  const runTriage = async () => { throw new Error('triage boom'); };
  const report = await runUnderstandingEval({ corpusPath: tmp, runRouter, runTriage });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].phase, 'triage');
  fs.unlinkSync(tmp);
});

test('runUnderstandingEval: requires runRouter and runTriage', async () => {
  await assert.rejects(() => runUnderstandingEval({ corpusPath: '/x' }), /runRouter required/);
});

test('runUnderstandingEval: coref_resolution_rate when resolver provided', async () => {
  const tmp = writeTempCorpus([
    { id: 'c1', prompt: 'eso', coref: { anaphor: 'eso', resolves_to: 'la fotosíntesis' } },
    { id: 'c2', prompt: 'lo', coref: { anaphor: 'lo', resolves_to: 'el documento' } },
  ]);
  const runRouter = async () => ({ intent_primary: 'x', ambiguity_score: 0 });
  const runTriage = async () => ({ action: 'execute', options: [] });
  const runCorefResolver = async (row) => {
    if (row.id === 'c1') return { resolvesTo: 'fotosíntesis convierte luz', confidence: 0.9 };
    if (row.id === 'c2') return { resolvesTo: 'imagen previa', confidence: 0.5 };
    return null;
  };
  const report = await runUnderstandingEval({ corpusPath: tmp, runRouter, runTriage, runCorefResolver });
  assert.equal(report.metrics.coref_resolution_rate, 0.5);
  fs.unlinkSync(tmp);
});

// ─── compareReports ──────────────────────────────────────────────────

test('compareReports: detects delta', () => {
  const prev = { n_evaluated: 10, metrics: { intent_accuracy: { f1: 0.6 }, clarify: { f1: 0.5 }, ambiguity_calibration_ece: 0.2, options_precision: 0.4, coref_resolution_rate: null } };
  const curr = { n_evaluated: 10, metrics: { intent_accuracy: { f1: 0.75 }, clarify: { f1: 0.7 }, ambiguity_calibration_ece: 0.12, options_precision: 0.65, coref_resolution_rate: null } };
  const cmp = compareReports(prev, curr);
  assert.equal(cmp.ok, true);
  assert.ok(Math.abs(cmp.delta['intent_accuracy.f1'].delta - 0.15) < 1e-9);
  assert.ok(cmp.delta['ambiguity_calibration_ece'].delta < 0); // mejora
  assert.equal(cmp.delta['coref_resolution_rate'].delta, null);
});

test('compareReports: missing report → ok:false', () => {
  assert.equal(compareReports(null, {}).ok, false);
  assert.equal(compareReports({}, null).ok, false);
});

// ─── Real corpus sanity check ────────────────────────────────────────

test('shipped corpus is parseable and has expected categories', () => {
  const corpus = path.resolve(__dirname, 'eval', 'understanding-corpus.jsonl');
  const { rows, parseErrors } = readCorpus(corpus);
  assert.equal(parseErrors.length, 0, `corpus has ${parseErrors.length} parse errors`);
  assert.ok(rows.length >= 50, `expected at least 50 examples, got ${rows.length}`);
  const tags = new Set();
  for (const r of rows) for (const t of (r.tags || [])) tags.add(t);
  assert.ok(tags.has('clear'));
  assert.ok(tags.has('ambig'));
  assert.ok(tags.has('coref'));
  assert.ok(tags.has('repair'));
  assert.ok(tags.has('high-cost'));
});
