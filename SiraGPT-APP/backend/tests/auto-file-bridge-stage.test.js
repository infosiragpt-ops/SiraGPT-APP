'use strict';

// Regression — auto-file-bridge must not write an invalid processingStage.
//
// The file-processing state machine (file-processing-status.js) only knows the
// STAGES uploaded…validating…extracting…chunking…embedding…indexing…ready/failed
// and every transition is supposed to flow through setStage(). auto-file-bridge
// directly wrote `processingStage: 'analyzing'` — NOT a valid stage — bypassing
// setStage()'s validation and leaving a stage that isValidStage()/isTerminal()
// and the UI can't map. The fix drops the direct stage write (the row stays
// 'extracting' until scheduleAutoFileRagIndex + setStage('ready') advance it).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isValidStage, STAGES } = require('../src/services/file-processing-status');

test("'analyzing' is not a valid processing stage", () => {
  assert.equal(isValidStage('analyzing'), false);
});

test('auto-file-bridge never writes an invalid processingStage literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auto-file-bridge.js'), 'utf8');
  assert.ok(!/processingStage:\s*'analyzing'/.test(src), "must not write the invalid 'analyzing' stage");
  // Any directly-written processingStage string literal must be a real STAGE.
  const written = [...src.matchAll(/processingStage:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  for (const st of written) {
    assert.ok(STAGES.includes(st), `direct processingStage '${st}' must be a valid stage`);
  }
});
