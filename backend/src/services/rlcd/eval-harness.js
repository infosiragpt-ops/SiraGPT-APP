'use strict';

/**
 * Offline eval for document RLCD fixtures.
 *
 * Reads `backend/tests/fixtures/document-rlcd-eval.json` (or any
 * compatible array) and scores finalizeAnswer without network.
 * Fail-open per case. No GPU.
 *
 * The fixture lives under tests/ and is dockerignored from the production
 * image. NEVER require() it at module load — that crashed Lenovo boot of
 * a5c3b55f (#725). Load only inside runEval/loadFixtures, and skip if missing.
 */

const path = require('node:path');

const DEFAULT_FIXTURE_PATH = path.join(
  __dirname,
  '../../../tests/fixtures/document-rlcd-eval.json',
);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadDefaultFixtures() {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return asArray(require(DEFAULT_FIXTURE_PATH));
  } catch {
    return [];
  }
}

function loadFixtures(rows) {
  if (rows == null) return loadDefaultFixtures();
  if (typeof rows === 'string') {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return asArray(require(rows));
    } catch {
      return [];
    }
  }
  return asArray(rows);
}

function checkExpect(out, row) {
  const expect = (row && row.expect) || {};
  const failures = [];
  const score = out && out.score ? out.score : {};
  const ev = score.evidence || {};
  const text = String((out && out.text) || '');

  if (expect.unchanged === true) {
    const original = String(row.answer || '');
    if (text !== original && out.reason !== 'not_document' && out.reason !== 'disabled') {
      failures.push(`text changed on gated turn (${out.reason})`);
    }
    if (out && out.deferred === true) failures.push('deferred gated turn');
  }
  if (expect.maxConfidence != null && !(score.confidence <= expect.maxConfidence)) {
    failures.push(`confidence ${score.confidence} > ${expect.maxConfidence}`);
  }
  if (expect.minConfidence != null && !(score.confidence >= expect.minConfidence)) {
    failures.push(`confidence ${score.confidence} < ${expect.minConfidence}`);
  }
  if (expect.deferred != null && Boolean(out && out.deferred) !== Boolean(expect.deferred)) {
    failures.push(`deferred ${out && out.deferred} != ${expect.deferred}`);
  }
  if (expect.hasInferred && !(score.claims && score.claims.inferred >= 1)) {
    failures.push('missing inferred claims');
  }
  if (expect.minRetrievalScore != null) {
    const top = ev.retrievalScore;
    if (!(top != null && top >= expect.minRetrievalScore)) {
      failures.push(`retrievalScore ${top} < ${expect.minRetrievalScore}`);
    }
  }
  if (expect.weakRetrieval != null && Boolean(ev.weakRetrieval) !== Boolean(expect.weakRetrieval)) {
    failures.push(`weakRetrieval ${ev.weakRetrieval} != ${expect.weakRetrieval}`);
  }
  if (expect.pageCited != null && Boolean(ev.pageCited) !== Boolean(expect.pageCited)) {
    failures.push(`pageCited ${ev.pageCited} != ${expect.pageCited}`);
  }
  if (expect.hasPageHint && !/\bp[áa]gina\s+\d+/i.test(text) && !/\bpage\s+\d+/i.test(text)) {
    failures.push('missing page hint');
  }
  if (expect.matchText) {
    const re = expect.matchText instanceof RegExp
      ? expect.matchText
      : new RegExp(expect.matchText, 'i');
    if (!re.test(text)) failures.push(`text !~ ${re}`);
  }
  if (expect.notMatchText) {
    const re = expect.notMatchText instanceof RegExp
      ? expect.notMatchText
      : new RegExp(expect.notMatchText, 'i');
    if (re.test(text)) failures.push(`text ~ ${re}`);
  }
  if (expect.notScary && /afirmar\s+esto\s+con\s+seguridad|inventar|no\s+puedo\s+afirmar/i.test(text)) {
    failures.push('scary defer copy');
  }
  if (expect.reason && out && out.reason !== expect.reason) {
    failures.push(`reason ${out.reason} != ${expect.reason}`);
  }
  return failures;
}

function evaluateCase(row, { finalize } = {}) {
  const id = (row && row.id) || 'anonymous';
  try {
    const fn = typeof finalize === 'function' ? finalize : null;
    if (!fn) return { id, passed: false, failures: ['no_finalize'] };
    const out = fn({
      text: row.answer,
      prompt: row.prompt,
      files: row.files,
      hits: row.hits,
      agent: row.agent,
      language: row.language || 'es',
      threshold: row.expect && row.expect.threshold,
      maxRate: row.expect && row.expect.maxRate,
    });
    const failures = checkExpect(out, row);
    return {
      id,
      passed: failures.length === 0,
      failures,
      confidence: out && out.score ? out.score.confidence : null,
      deferred: Boolean(out && out.deferred),
      reason: out && out.reason,
    };
  } catch (err) {
    return { id, passed: false, failures: ['fail_open'], error: String(err && err.message || err) };
  }
}

function skippedReport(reason = 'fixture_missing') {
  return {
    n: 0,
    passed: 0,
    failed: 0,
    ok: false,
    skipped: true,
    reason,
    cases: [],
  };
}

function runEval(rows, opts = {}) {
  let fixtures;
  try {
    fixtures = loadFixtures(rows);
  } catch {
    return skippedReport('fixture_missing');
  }
  // Default path (no rows): fixture is optional. Production images omit tests/.
  if (rows == null && fixtures.length === 0) {
    return skippedReport('fixture_missing');
  }
  if (typeof rows === 'string' && fixtures.length === 0) {
    return skippedReport('fixture_missing');
  }
  const cases = fixtures.map((row) => evaluateCase(row, opts));
  const passed = cases.filter((c) => c.passed).length;
  return {
    n: cases.length,
    passed,
    failed: cases.length - passed,
    ok: cases.length > 0 && passed === cases.length,
    skipped: false,
    cases,
  };
}

module.exports = {
  loadFixtures,
  checkExpect,
  evaluateCase,
  runEval,
};
