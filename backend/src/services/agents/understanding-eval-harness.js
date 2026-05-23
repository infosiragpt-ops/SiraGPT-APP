'use strict';

/**
 * understanding-eval-harness
 *
 * Mide objetivamente la calidad de comprensión del usuario contra un
 * golden set en JSONL. Sin esto, cualquier cambio en intent-router /
 * triage / clarification-options vuela a ciegas.
 *
 * Métricas reportadas:
 *   - intent_accuracy: F1 multi-label sobre intent_primary + intent_secondary
 *   - ambiguity_calibration_ece: Expected Calibration Error sobre el
 *     ambiguity_score (binning de 10 buckets)
 *   - clarify_precision / clarify_recall / clarify_f1: precisión y recall
 *     de la decisión action='ask' vs expected_action
 *   - coref_resolution_rate: en el sub-corpus con campo coref, porcentaje
 *     de coreferencias correctamente ancladas (requiere coref-resolver
 *     activado; si no está disponible, sub-métrica marcada como N/A)
 *   - options_precision: para casos con expected_options, porcentaje de
 *     opciones generadas que contienen al menos un keyword esperado
 *
 * Sin LLM por defecto: las métricas básicas no requieren judge. El
 * harness puede aceptar un judge opcional para scoring cualitativo.
 *
 * Reutiliza mean/stddev/twoProportionZ de eval-harness.js para
 * comparaciones inter-runs.
 */

const fs = require('fs');
const path = require('path');
const { mean, stddev } = require('./eval-harness');

const BUCKET_COUNT = 10;

function readCorpus(corpusPath) {
  const abs = path.isAbsolute(corpusPath) ? corpusPath : path.resolve(process.cwd(), corpusPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`understanding-eval-harness: corpus not found at ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  const parseErrors = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!obj || typeof obj !== 'object') throw new Error('non-object');
      rows.push(obj);
    } catch (err) {
      parseErrors.push({ line: i + 1, message: err.message || String(err) });
    }
  }
  return { rows, parseErrors };
}

function f1FromCounts(tp, fp, fn) {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function multiLabelMatch(predicted, expected) {
  const pSet = new Set(Array.isArray(predicted) ? predicted.map(String) : []);
  const eSet = new Set(Array.isArray(expected) ? expected.map(String) : []);
  let tp = 0; let fp = 0; let fn = 0;
  for (const e of eSet) {
    if (pSet.has(e)) tp++; else fn++;
  }
  for (const p of pSet) {
    if (!eSet.has(p)) fp++;
  }
  return { tp, fp, fn };
}

function computeECE(predictionPairs) {
  // predictionPairs: Array<{score: 0..1, correct: bool}>
  if (!Array.isArray(predictionPairs) || predictionPairs.length === 0) return 0;
  const buckets = Array.from({ length: BUCKET_COUNT }, () => ({ sum: 0, correct: 0, n: 0 }));
  for (const { score, correct } of predictionPairs) {
    const s = Math.max(0, Math.min(0.999999, Number(score) || 0));
    const idx = Math.min(BUCKET_COUNT - 1, Math.floor(s * BUCKET_COUNT));
    buckets[idx].sum += s;
    buckets[idx].correct += correct ? 1 : 0;
    buckets[idx].n += 1;
  }
  const total = predictionPairs.length;
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    const avgConf = b.sum / b.n;
    const accuracy = b.correct / b.n;
    ece += (b.n / total) * Math.abs(avgConf - accuracy);
  }
  return ece;
}

function optionsContainKeyword(options, keywords) {
  if (!Array.isArray(options) || options.length === 0) return false;
  if (!Array.isArray(keywords) || keywords.length === 0) return true;
  const lower = options
    .map((o) => (typeof o === 'string' ? o : (o?.label || '')).toLowerCase())
    .join(' | ');
  return keywords.some((kw) => lower.includes(String(kw).toLowerCase()));
}

function evaluateRow(row, results) {
  const r = {
    id: row.id,
    expected_action: row.expected_action || null,
    actual_action: results.triage?.action || null,
    intent_primary_expected: row.expected_intent?.intent_primary || null,
    intent_primary_actual: results.router?.intent_primary || null,
    extension_expected: row.expected_intent?.required_extension || null,
    extension_actual: results.router?.required_extension || null,
    ambiguity_score: typeof results.router?.ambiguity_score === 'number' ? results.router.ambiguity_score : null,
    options_actual: results.triage?.options || [],
    coref_expected: row.coref || null,
    coref_actual: results.coref || null,
  };
  return r;
}

/**
 * runUnderstandingEval
 *
 * @param {object} args
 * @param {string} args.corpusPath  — path to JSONL corpus
 * @param {Function} args.runRouter — async (row) => { intent_primary, required_extension, ambiguity_score, intent_secondary? }
 * @param {Function} args.runTriage — async (row, routerResult) => { action: 'execute'|'ask', options?: [...] }
 * @param {Function} [args.runCorefResolver] — async (row) => { resolvesTo, confidence } | null
 * @returns {Promise<Report>}
 */
async function runUnderstandingEval({ corpusPath, runRouter, runTriage, runCorefResolver = null } = {}) {
  if (typeof runRouter !== 'function') throw new Error('runUnderstandingEval: runRouter required');
  if (typeof runTriage !== 'function') throw new Error('runUnderstandingEval: runTriage required');

  const { rows, parseErrors } = readCorpus(corpusPath);

  const evaluations = [];
  const intentTpFpFn = { tp: 0, fp: 0, fn: 0 };
  const calibPairs = [];
  let clarifyTp = 0;
  let clarifyFp = 0;
  let clarifyFn = 0;
  let clarifyTn = 0;
  let optionsTotal = 0;
  let optionsHit = 0;
  let corefTotal = 0;
  let corefHit = 0;
  const errors = [];

  for (const row of rows) {
    let router;
    let triage;
    let coref = null;
    try {
      router = await runRouter(row);
    } catch (err) {
      errors.push({ id: row.id, phase: 'router', message: err.message || String(err) });
      continue;
    }
    try {
      triage = await runTriage(row, router);
    } catch (err) {
      errors.push({ id: row.id, phase: 'triage', message: err.message || String(err) });
      continue;
    }
    if (runCorefResolver && row.coref) {
      try {
        coref = await runCorefResolver(row);
      } catch (err) {
        errors.push({ id: row.id, phase: 'coref', message: err.message || String(err) });
      }
    }

    const evalRow = evaluateRow(row, { router, triage, coref });
    evaluations.push(evalRow);

    // intent_accuracy: F1 sobre primary + secondary
    const expectedIntents = [];
    if (row.expected_intent?.intent_primary) expectedIntents.push(row.expected_intent.intent_primary);
    if (Array.isArray(row.expected_intent?.intent_secondary)) {
      for (const s of row.expected_intent.intent_secondary) expectedIntents.push(s);
    }
    if (expectedIntents.length > 0) {
      const predicted = [];
      if (router.intent_primary) predicted.push(router.intent_primary);
      if (Array.isArray(router.intent_secondary)) {
        for (const s of router.intent_secondary) predicted.push(s);
      }
      const m = multiLabelMatch(predicted, expectedIntents);
      intentTpFpFn.tp += m.tp;
      intentTpFpFn.fp += m.fp;
      intentTpFpFn.fn += m.fn;
    }

    // clarify_precision/recall: ask vs expected
    if (row.expected_action) {
      const predAsk = triage.action === 'ask';
      const expAsk = row.expected_action === 'ask';
      if (predAsk && expAsk) clarifyTp++;
      else if (predAsk && !expAsk) clarifyFp++;
      else if (!predAsk && expAsk) clarifyFn++;
      else clarifyTn++;
    }

    // ambiguity_calibration_ece: ¿el ambiguity_score predice P(ask es la
    // acción correcta)? Por eso `correct` = (expected_action == 'ask').
    // Calibración perfecta: score=0.9 debería corresponder a ~90% de
    // expected_action='ask' en esa bucket.
    if (typeof router.ambiguity_score === 'number' && row.expected_action) {
      const expAsk = row.expected_action === 'ask';
      calibPairs.push({ score: router.ambiguity_score, correct: expAsk });
    }

    // options_precision: para casos con expected_options
    if (Array.isArray(row.expected_options) && row.expected_options.length > 0) {
      optionsTotal++;
      if (optionsContainKeyword(triage.options || [], row.expected_options)) optionsHit++;
    }

    // coref_resolution_rate
    if (row.coref && row.coref.resolves_to && coref && coref.resolvesTo) {
      corefTotal++;
      const expected = String(row.coref.resolves_to).toLowerCase();
      const actual = String(coref.resolvesTo).toLowerCase();
      // Match si actual contiene tokens significativos del expected o viceversa
      const expectedTokens = expected.split(/\W+/).filter((t) => t.length >= 4);
      const matched = expectedTokens.some((t) => actual.includes(t));
      if (matched) corefHit++;
    }
  }

  const intentF1 = f1FromCounts(intentTpFpFn.tp, intentTpFpFn.fp, intentTpFpFn.fn);
  const clarifyF1 = f1FromCounts(clarifyTp, clarifyFp, clarifyFn);
  const ece = computeECE(calibPairs);
  const optionsPrecision = optionsTotal === 0 ? null : optionsHit / optionsTotal;
  const corefResolutionRate = corefTotal === 0 ? null : corefHit / corefTotal;

  // Distribución de ambiguity scores
  const scores = calibPairs.map((p) => p.score);
  const scoreStats = {
    n: scores.length,
    mean: mean(scores),
    stddev: stddev(scores),
  };

  return {
    schema_version: '1.0.0',
    timestamp: new Date().toISOString(),
    corpus_path: corpusPath,
    n_rows: rows.length,
    n_evaluated: evaluations.length,
    parse_errors: parseErrors,
    errors,
    metrics: {
      intent_accuracy: intentF1,
      clarify: {
        ...clarifyF1,
        confusion: { tp: clarifyTp, fp: clarifyFp, fn: clarifyFn, tn: clarifyTn },
      },
      ambiguity_calibration_ece: ece,
      options_precision: optionsPrecision,
      coref_resolution_rate: corefResolutionRate,
      ambiguity_score_stats: scoreStats,
    },
    evaluations,
  };
}

/**
 * compareReports — útil para detectar regresiones inter-runs.
 */
function compareReports(prev, curr) {
  if (!prev || !curr) return { ok: false, reason: 'missing_report' };
  const fields = ['intent_accuracy.f1', 'clarify.f1', 'ambiguity_calibration_ece', 'options_precision', 'coref_resolution_rate'];
  const delta = {};
  for (const field of fields) {
    const [a, b] = field.split('.');
    const prevVal = b ? prev.metrics?.[a]?.[b] : prev.metrics?.[a];
    const currVal = b ? curr.metrics?.[a]?.[b] : curr.metrics?.[a];
    if (typeof prevVal !== 'number' || typeof currVal !== 'number') {
      delta[field] = { prev: prevVal, curr: currVal, delta: null };
    } else {
      delta[field] = { prev: prevVal, curr: currVal, delta: currVal - prevVal };
    }
  }
  return { ok: true, delta, n_prev: prev.n_evaluated, n_curr: curr.n_evaluated };
}

module.exports = {
  runUnderstandingEval,
  compareReports,
  readCorpus,
  // exposed for tests
  _internal: {
    f1FromCounts,
    multiLabelMatch,
    computeECE,
    optionsContainKeyword,
    BUCKET_COUNT,
  },
};
