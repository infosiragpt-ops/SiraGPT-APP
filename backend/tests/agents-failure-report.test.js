/**
 * Tests for services/agents/failure-report.js — canonical
 * FailureReport schema + fromReviewer / fromSovereignty adapters.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createFailureReport,
  fromReviewer,
  fromSovereignty,
  STAGES,
  RELEASE_DECISIONS,
} = require('../src/services/agents/failure-report');

// ── STAGES / RELEASE_DECISIONS ────────────────────────────────────

describe('STAGES enum', () => {
  it('pins the 12 documented pipeline stages', () => {
    assert.deepEqual(STAGES, [
      'request_received',
      'contract_created',
      'contract_validated',
      'ambiguity_detected',
      'pipeline_selected',
      'tool_selected',
      'tool_executing',
      'artifact_generated',
      'format_validation',
      'semantic_validation',
      'release_review',
      'final_delivery',
    ]);
  });

  it('every stage is a snake_case string', () => {
    for (const s of STAGES) assert.match(s, /^[a-z][a-z0-9_]*$/);
  });

  it('no duplicates', () => {
    assert.equal(new Set(STAGES).size, STAGES.length);
  });
});

describe('RELEASE_DECISIONS enum', () => {
  it('pins the 4 documented decisions', () => {
    assert.deepEqual(RELEASE_DECISIONS, [
      'retry',
      'request_clarification',
      'abort',
      'accept_with_warning',
    ]);
  });

  it('no duplicates', () => {
    assert.equal(new Set(RELEASE_DECISIONS).size, RELEASE_DECISIONS.length);
  });
});

// ── createFailureReport · validation ──────────────────────────────

describe('createFailureReport · validation', () => {
  function valid(extra = {}) {
    return {
      failed_stage: 'format_validation',
      expected_output: 'a pdf',
      actual_output: 'a docx',
      root_cause: 'wrong format',
      repair_strategy: 'regenerate with format=pdf',
      ...extra,
    };
  }

  it('throws on unknown failed_stage', () => {
    assert.throws(
      () => createFailureReport(valid({ failed_stage: 'made_up' })),
      /unknown stage "made_up"/,
    );
  });

  it('throws on unknown release_decision', () => {
    assert.throws(
      () => createFailureReport(valid({ release_decision: 'made_up' })),
      /unknown release_decision "made_up"/,
    );
  });

  it('rejects every non-listed stage in STAGES', () => {
    assert.throws(() => createFailureReport(valid({ failed_stage: '' })));
    assert.throws(() => createFailureReport(valid({ failed_stage: null })));
  });
});

// ── createFailureReport · shape + defaults ────────────────────────

describe('createFailureReport · shape', () => {
  it('returns a record with version 1.0', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.equal(r.version, '1.0');
  });

  it('default retry_count = 0', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.equal(r.retry_count, 0);
  });

  it('default release_decision = retry', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.equal(r.release_decision, 'retry');
  });

  it('default tests_reexecuted = []', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.deepEqual(r.tests_reexecuted, []);
  });

  it('default meta = {}', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.deepEqual(r.meta, {});
  });

  it('createdAt is an ISO timestamp', () => {
    const r = createFailureReport({
      failed_stage: 'format_validation',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'w',
    });
    assert.ok(!isNaN(new Date(r.createdAt).getTime()));
  });
});

// ── createFailureReport · field caps ──────────────────────────────

describe('createFailureReport · field caps', () => {
  const base = {
    failed_stage: 'format_validation',
    expected_output: 'x',
    actual_output: 'y',
    root_cause: 'z',
    repair_strategy: 'w',
  };

  it('expected_output truncated to 1000 chars', () => {
    const r = createFailureReport({ ...base, expected_output: 'a'.repeat(2000) });
    assert.equal(r.expected_output.length, 1000);
  });

  it('actual_output string truncated to 1000 chars', () => {
    const r = createFailureReport({ ...base, actual_output: 'b'.repeat(2000) });
    assert.equal(r.actual_output.length, 1000);
  });

  it('actual_output object preserved as-is (no slice for non-string)', () => {
    const obj = { ext: 'docx', mime: 'application/msword' };
    const r = createFailureReport({ ...base, actual_output: obj });
    assert.deepEqual(r.actual_output, obj);
  });

  it('root_cause truncated to 400 chars', () => {
    const r = createFailureReport({ ...base, root_cause: 'c'.repeat(800) });
    assert.equal(r.root_cause.length, 400);
  });

  it('repair_strategy truncated to 400 chars', () => {
    const r = createFailureReport({ ...base, repair_strategy: 'd'.repeat(800) });
    assert.equal(r.repair_strategy.length, 400);
  });

  it('tests_reexecuted capped at 30', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `test-${i}`);
    const r = createFailureReport({ ...base, tests_reexecuted: ids });
    assert.equal(r.tests_reexecuted.length, 30);
    assert.deepEqual(r.tests_reexecuted, ids.slice(0, 30));
  });

  it('non-array tests_reexecuted coerces to []', () => {
    const r = createFailureReport({ ...base, tests_reexecuted: 'not-array' });
    assert.deepEqual(r.tests_reexecuted, []);
  });

  it('non-object meta coerces to {}', () => {
    const r = createFailureReport({ ...base, meta: 'not-object' });
    assert.deepEqual(r.meta, {});
  });

  it('coerces retry_count to number; non-numeric becomes 0', () => {
    const a = createFailureReport({ ...base, retry_count: '5' });
    assert.equal(a.retry_count, 5);
    const b = createFailureReport({ ...base, retry_count: 'NaN' });
    assert.equal(b.retry_count, 0);
  });
});

// ── fromReviewer ──────────────────────────────────────────────────

describe('fromReviewer', () => {
  it('builds a report from an ArtifactReviewer review', () => {
    const review = {
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      ext: 'docx',
      mimeSniffed: 'application/msword',
      failedTests: [
        { id: 'ext-match', detail: 'expected pdf, got docx' },
        { id: 'mime-match', detail: 'mime mismatch' },
      ],
    };
    const r = fromReviewer(review);
    assert.equal(r.failed_stage, 'format_validation');
    assert.match(r.expected_output, /required_extension/);
    assert.match(r.expected_output, /"pdf"/);
    assert.equal(r.actual_output.ext, 'docx');
    assert.equal(r.actual_output.mime, 'application/msword');
    assert.match(r.root_cause, /rejected 2 tests/);
    assert.match(r.repair_strategy, /ext-match: expected pdf/);
    assert.deepEqual(r.tests_reexecuted, ['ext-match', 'mime-match']);
    assert.equal(r.release_decision, 'retry');
  });

  it('singular "1 test" wording when exactly one failure', () => {
    const review = {
      contract: { required_extension: 'pdf', mime_type: 'application/pdf' },
      ext: 'docx',
      mimeSniffed: 'application/msword',
      failedTests: [{ id: 'x', detail: 'foo' }],
    };
    const r = fromReviewer(review);
    assert.match(r.root_cause, /rejected 1 test\b/);
    assert.equal(r.root_cause.includes('1 tests'), false);
  });

  it('handles missing contract gracefully', () => {
    const review = {
      ext: 'docx',
      mimeSniffed: 'application/msword',
      failedTests: [{ id: 'x', detail: 'foo' }],
    };
    const r = fromReviewer(review);
    assert.equal(r.expected_output, '(contract-defined)');
  });

  it('honours caller-supplied retry_count + meta', () => {
    const r = fromReviewer(
      { ext: 'docx', mimeSniffed: 'application/msword', failedTests: [] },
      { retry_count: 3, meta: { run: 'r1' } },
    );
    assert.equal(r.retry_count, 3);
    assert.deepEqual(r.meta, { run: 'r1' });
  });

  it('failedTests undefined → empty arrays + zero count', () => {
    const r = fromReviewer({ ext: 'pdf', mimeSniffed: 'application/pdf' });
    assert.deepEqual(r.tests_reexecuted, []);
    assert.match(r.root_cause, /rejected 0 tests/);
  });
});

// ── fromSovereignty ───────────────────────────────────────────────

describe('fromSovereignty', () => {
  it('builds a report from a hard-block sovereignty decision', () => {
    const sov = {
      expected: { extension: 'pdf', mime: 'application/pdf' },
      actual: { extension: 'docx', mime: 'application/msword' },
      violations: [
        { id: 'ext-mismatch', detail: 'wrong extension' },
        { id: 'mime-mismatch', detail: 'wrong mime' },
      ],
      policy: 'hard-block',
      repairHint: 'use create_document with format=pdf',
    };
    const r = fromSovereignty(sov);
    assert.equal(r.failed_stage, 'format_validation');
    assert.equal(r.expected_output, '.pdf + application/pdf');
    assert.equal(r.actual_output, '.docx + application/msword');
    assert.match(r.root_cause, /rejected 2 violations/);
    assert.match(r.repair_strategy, /ext-mismatch: wrong extension/);
    assert.match(r.repair_strategy, /use create_document with format=pdf/);
    assert.deepEqual(r.tests_reexecuted, ['ext-mismatch', 'mime-mismatch']);
    assert.equal(r.release_decision, 'retry');
  });

  it('soft-warn policy maps to release_decision=accept_with_warning', () => {
    const sov = {
      expected: { extension: 'pdf', mime: 'application/pdf' },
      actual: { extension: 'pdf', mime: 'application/pdf' },
      violations: [{ id: 'minor', detail: 'minor' }],
      policy: 'soft-warn',
    };
    const r = fromSovereignty(sov);
    assert.equal(r.release_decision, 'accept_with_warning');
  });

  it('singular "1 violation" wording', () => {
    const sov = {
      expected: { extension: 'pdf', mime: 'application/pdf' },
      actual: { extension: 'docx', mime: 'application/msword' },
      violations: [{ id: 'x', detail: 'foo' }],
      policy: 'hard-block',
    };
    const r = fromSovereignty(sov);
    assert.match(r.root_cause, /rejected 1 violation\b/);
    assert.equal(r.root_cause.includes('1 violations'), false);
  });

  it('handles missing violations array (defaults to [])', () => {
    const sov = {
      expected: { extension: 'pdf', mime: 'application/pdf' },
      actual: { extension: 'pdf', mime: 'application/pdf' },
      policy: 'hard-block',
    };
    const r = fromSovereignty(sov);
    assert.deepEqual(r.tests_reexecuted, []);
    assert.match(r.root_cause, /rejected 0 violations/);
  });

  it('extension-absent paths formatted as "(no file)" / "(none)"', () => {
    const sov = {
      expected: { mime: 'application/pdf' },
      actual: {},
      violations: [],
      policy: 'hard-block',
    };
    const r = fromSovereignty(sov);
    assert.match(r.expected_output, /\(no file\)/);
    assert.match(r.actual_output, /\(none\)/);
    assert.match(r.actual_output, /\(unknown\)/);
  });
});
