const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selfRepair,
  runStandardValidators,
  buildRepairInstruction,
  REPAIR_HINTS,
  DEFAULT_MAX_ATTEMPTS,
} = require('../src/services/agents/self-repair-engine');

test('DEFAULT_MAX_ATTEMPTS is 1 (single repair retry by default)', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 1);
});

test('selfRepair returns immediately when validate passes on first try', async () => {
  let regenerateCalls = 0;
  const validate = async () => ({ passed: true, failures: [] });
  const regenerate = async () => {
    regenerateCalls += 1;
    return { id: 'should-not-be-called' };
  };
  const result = await selfRepair({ artifact: { id: 'orig' }, validate, regenerate });
  assert.equal(regenerateCalls, 0, 'regenerate should not be called when initial validate passes');
  assert.equal(result.artifact.id, 'orig');
  assert.equal(result.repaired, false);
  assert.equal(result.attempts, 0);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].passed, true);
  assert.equal(result.finalReport.passed, true);
});

test('selfRepair regenerates once when first validation fails then passes', async () => {
  let validateCalls = 0;
  let regenerateCalls = 0;
  const validate = async () => {
    validateCalls += 1;
    if (validateCalls === 1) {
      return {
        passed: false,
        failures: [{ validator: 'math', reason: 'no_equations_rendered' }],
      };
    }
    return { passed: true, failures: [] };
  };
  const regenerate = async ({ repairInstruction, failures, attempt }) => {
    regenerateCalls += 1;
    assert.equal(attempt, 1, 'attempt counter starts at 1');
    assert.match(repairInstruction, /ecuaciones/, 'instruction should reference equations');
    assert.equal(failures[0].reason, 'no_equations_rendered');
    return { id: 'repaired' };
  };
  const result = await selfRepair({ artifact: { id: 'orig' }, validate, regenerate });
  assert.equal(regenerateCalls, 1);
  assert.equal(result.artifact.id, 'repaired');
  assert.equal(result.repaired, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].passed, false);
  assert.equal(result.history[1].passed, true);
});

test('selfRepair stops at maxAttempts when validation never passes', async () => {
  let regenerateCalls = 0;
  const validate = async () => ({
    passed: false,
    failures: [{ validator: 'pdf', reason: 'no_text_content' }],
  });
  const regenerate = async () => {
    regenerateCalls += 1;
    return { id: `regen-${regenerateCalls}` };
  };
  const result = await selfRepair({
    artifact: { id: 'orig' },
    validate,
    regenerate,
    maxAttempts: 2,
  });
  assert.equal(regenerateCalls, 2, 'should retry exactly maxAttempts times');
  assert.equal(result.repaired, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.history.length, 3); // initial + 2 retries
  assert.equal(result.history.at(-1).passed, false);
  assert.equal(result.finalReport.passed, false);
});

test('selfRepair handles regenerate throwing — breaks the loop and records the error', async () => {
  const validate = async () => ({
    passed: false,
    failures: [{ validator: 'mime', reason: 'mime_mismatch' }],
  });
  const regenerate = async () => {
    throw new Error('LLM is down');
  };
  const result = await selfRepair({ artifact: { id: 'orig' }, validate, regenerate });
  assert.equal(result.repaired, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.history.length, 2);
  assert.match(result.history[1].regenerateError, /LLM is down/);
  // Should not call validate a second time after a regenerate failure
});

test('selfRepair handles regenerate returning a falsy artifact', async () => {
  const validate = async () => ({
    passed: false,
    failures: [{ validator: 'mime', reason: 'mime_mismatch' }],
  });
  const regenerate = async () => null;
  const result = await selfRepair({ artifact: { id: 'orig' }, validate, regenerate });
  assert.equal(result.repaired, false);
  assert.equal(result.history.at(-1).regenerateError, 'regenerate returned no artifact');
});

test('selfRepair throws on missing required arguments', async () => {
  await assert.rejects(() => selfRepair({}), /artifact is required/);
  await assert.rejects(() => selfRepair({ artifact: {} }), /validate function is required/);
  await assert.rejects(
    () => selfRepair({ artifact: {}, validate: () => {} }),
    /regenerate function is required/,
  );
});

test('selfRepair calls logger with repair_attempt events', async () => {
  const events = [];
  const logger = (e) => events.push(e);
  let attempts = 0;
  const validate = async () => {
    attempts += 1;
    return attempts < 3
      ? { passed: false, failures: [{ validator: 'mime', reason: 'mime_mismatch' }] }
      : { passed: true, failures: [] };
  };
  const regenerate = async () => ({ id: 'next' });
  await selfRepair({
    artifact: { id: 'orig' },
    validate,
    regenerate,
    maxAttempts: 2,
    logger,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'repair_attempt');
  assert.equal(events[0].attempt, 1);
  assert.match(events[0].repairInstruction, /mime/);
});

test('buildRepairInstruction returns null on empty/null failures', () => {
  assert.equal(buildRepairInstruction([]), null);
  assert.equal(buildRepairInstruction(null), null);
  assert.equal(buildRepairInstruction(undefined), null);
});

test('buildRepairInstruction maps known reasons to Spanish hints', () => {
  const text = buildRepairInstruction([
    { validator: 'math', reason: 'no_equations_rendered' },
    { validator: 'pdf', reason: 'no_text_content' },
  ]);
  assert.match(text, /ecuaciones renderizadas/);
  assert.match(text, /texto extraíble/);
  assert.match(text, /\(math\)/);
  assert.match(text, /\(pdf\)/);
});

test('buildRepairInstruction falls back to generic copy when reason not in REPAIR_HINTS', () => {
  const text = buildRepairInstruction([
    { validator: 'custom', reason: 'made_up_reason' },
  ]);
  assert.match(text, /made_up_reason/);
  assert.match(text, /\(custom\)/);
  assert.match(text, /Falló la validación/);
});

test('REPAIR_HINTS covers every reason emitted by phases 2/4/5/6/7', () => {
  // Sanity: all the known reason codes should map to user-friendly copy.
  const required = [
    'no_equations_rendered',  // math-render-validator
    'no_text_content',        // pdf-render-validator
    'no_slides_rendered',     // pptx-package-validator
    'slide_manifest_mismatch',
    'no_sheets',              // xlsx-workbook-validator
    'no_cell_content',
    'sheet_manifest_mismatch',
    'mime_mismatch',          // mime-type-validator
    'blank_render',           // preview-screenshot-validator
  ];
  for (const r of required) {
    assert.ok(REPAIR_HINTS[r], `REPAIR_HINTS missing entry for "${r}"`);
    assert.equal(typeof REPAIR_HINTS[r], 'string');
    assert.ok(REPAIR_HINTS[r].length > 20, `hint for "${r}" should be a real sentence`);
  }
});

test('runStandardValidators returns a passed/failures shape with no inputs', async () => {
  const result = await runStandardValidators({});
  assert.equal(typeof result.passed, 'boolean');
  assert.equal(result.passed, true, 'no checks run → trivially passes');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checks, []);
});

test('runStandardValidators dispatches mime + format-specific checks', async () => {
  // Use a tiny zip header (PK\x03\x04 + zeros) — not a valid docx, but
  // enough to exercise both the mime-type validator and the math
  // validator code path. Both will record entries in `checks`.
  const buffer = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(64),
  ]);
  const result = await runStandardValidators({
    buffer,
    format: 'docx',
    declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredExtension: 'docx',
    prompt: 'genera un informe',
    sourceText: '',
  });
  assert.equal(typeof result.passed, 'boolean');
  // mime + math validators should both have produced a check entry.
  const validators = result.checks.map((c) => c.validator);
  assert.ok(validators.includes('mime'), `expected mime check, got ${validators}`);
  assert.ok(validators.includes('math'), `expected math check, got ${validators}`);
});
