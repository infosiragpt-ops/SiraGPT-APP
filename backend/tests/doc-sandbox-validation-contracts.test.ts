import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createValidatorStagingDirectory, freezePlan, validatorContainerArguments, type DocumentInventory } from '../src/modules/doc-sandbox/validation/index';
import { classifyAgentResult, editPlanSchema, hasCompleteValidation, type AgentResult, type DocumentFormat, type EditPlan, type InputFile, type ValidationReport } from '../src/modules/doc-sandbox/types/contracts';

const data = Buffer.from('before');
const sha256 = createHash('sha256').update(data).digest('hex');
const input: InputFile = { id: 'one', name: 'a.txt', format: 'txt', mime: 'text/plain', data, sha256 };
const inventory: DocumentInventory = { id: 'one', name: 'a.txt', format: 'txt', mime: 'text/plain', size: data.length,
  sha256, parts: {}, warnings: [], units: [{ part: '$document', locator: 'text', text: 'before', kind: 'text' }] };
const plan: EditPlan = { schemaVersion: 1, mode: 'preserve', outputName: 'a.txt', inputHashes: { one: sha256 }, notPossible: [],
  edits: [{ id: 'e1', kind: 'text', inputId: 'one', part: '$document', locator: 'text', before: 'before', after: 'after' }] };
const image = `siragpt/doc-validation@sha256:${'a'.repeat(64)}`;

test('container contract requires immutable image, gVisor and read-only input only', () => {
  const args = validatorContainerArguments('unit-contract', '/tmp/test-input', '/tmp/not-mounted', { image });
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
  assert.deepEqual(args.slice(args.indexOf('--runtime'), args.indexOf('--runtime') + 2), ['--runtime', 'runsc']);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.some((arg) => arg.includes('dst=/inputs,readonly')));
  assert.equal(args.filter((arg) => arg.startsWith('type=bind')).length, 1);
  assert.ok(args.some((arg) => arg.startsWith('/artifacts:') && arg.includes('size=32m')));
  assert.ok(!args.join(' ').includes('docker.sock'));
});
test('mutable image is rejected', () => assert.throws(() => validatorContainerArguments('name', '/a', '/b', { image: 'siragpt/doc-validation:latest' }), /digest/));
test('full local image ID is immutable and accepted; short ID and malformed digest are rejected', () => {
  const localImage = `sha256:${'b'.repeat(64)}`;
  assert.equal(validatorContainerArguments('name', '/a', '/b', { image: localImage }).at(-1), localImage);
  for (const value of ['b'.repeat(12), `sha256:${'b'.repeat(63)}`, `sha256:${'B'.repeat(64)}`]) {
    assert.throws(() => validatorContainerArguments('name', '/a', '/b', { image: value }), /digest/);
  }
});
test('shared staging uses exact configured path and creates private per-run directory', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-staging-test-'));
  try {
    await chmod(root, 0o700);
    const staging = await createValidatorStagingDirectory(root);
    assert.equal(path.dirname(staging), root);
    assert.equal((await lstat(staging)).mode & 0o777, 0o700);
    await chmod(root, 0o755);
    await assert.rejects(createValidatorStagingDirectory(root), /sin enlaces/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('shared staging rejects relative, injection, traversal and symlink roots', async () => {
  for (const root of ['relative', '/', '/a/../b', '/a,readonly=false', '/a\nb', '/a\tb']) {
    await assert.rejects(createValidatorStagingDirectory(root), /ruta absoluta/);
  }
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-staging-link-test-'));
  try {
    const link = path.join(root, 'link');
    await symlink(root, link);
    await assert.rejects(createValidatorStagingDirectory(link), /sin enlaces/);
    await assert.rejects(createValidatorStagingDirectory(path.join(root, 'missing')), /No está disponible/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unsafe runtime is rejected without fallback', () => assert.throws(() => validatorContainerArguments('name', '/a', '/b', { image, runtime: 'runc' }), /runsc/));
test('mount option injection is rejected', () => assert.throws(() => validatorContainerArguments('name', '/a,readonly=false', '/b', { image }), /Ruta/));
test('freezes only exact inspected leaves and clones plan ownership', () => {
  const result = freezePlan([input], [inventory], plan);
  assert.deepEqual(result, plan);
  assert.notEqual(result, plan);
});
test('no-op plan is accepted but a fake changed-unit no-op is rejected', () => {
  assert.deepEqual(freezePlan([input], [inventory], { ...plan, edits: [] }).edits, []);
  assert.throws(() => freezePlan([input], [inventory], { ...plan, edits: [{ ...plan.edits[0], after: 'before' }] }));
});
test('mutated input bytes are rejected despite metadata hash', () => assert.throws(() => freezePlan([{ ...input, data: Buffer.from('other') }], [inventory], plan)));
test('forged inventory hash is rejected', () => assert.throws(() => freezePlan([input], [{ ...inventory, sha256: 'a'.repeat(64) }], plan)));
test('substring or XPath wildcard cannot authorize extra changes', () => {
  assert.throws(() => freezePlan([input], [inventory], { ...plan, edits: [{ ...plan.edits[0], before: 'bef' }] }));
  assert.throws(() => freezePlan([input], [inventory], { ...plan, edits: [{ ...plan.edits[0], locator: '//*' }] }));
});
test('two model edits cannot claim the same original leaf', () => assert.throws(() => freezePlan([input], [inventory], {
  ...plan, edits: [...plan.edits, { ...plan.edits[0], id: 'e2' }],
})));
test('PDF operations cannot target text data', () => assert.throws(() => freezePlan([input], [inventory], {
  ...plan, edits: [{ id: 'e2', kind: 'pdf_rotate', inputId: 'one', pages: [1], degrees: 90 }],
})));

// Schema/projection checks only: provider claims never certify document bytes.
test('a plan rejects duplicate edit IDs even for distinct leaves', () => {
  const candidate = { ...plan, edits: [...plan.edits, { ...plan.edits[0], locator: 'another-leaf' }] };
  const result = editPlanSchema.safeParse(candidate);
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues.map(issue => issue.message), ['Identificadores de edición duplicados']);
});

test('a plan cannot mix successful edits with an unfulfilled part of the same request', () => {
  const result = editPlanSchema.safeParse({ ...plan, notPossible: [{ request: 'Other requested edit', reason: 'Cannot preserve original' }] });
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues.map(issue => issue.message), ['No se permite entregar una petición parcialmente editada']);
});

test('text and PDF merge edits cannot reference files absent from the approved input map', () => {
  for (const edit of [
    { ...plan.edits[0], inputId: 'unknown' },
    { id: 'merge', kind: 'pdf_merge', inputIds: ['one', 'unknown'] },
  ]) {
    const result = editPlanSchema.safeParse({ ...plan, edits: [edit] });
    assert.equal(result.success, false);
    if (!result.success) assert.deepEqual(result.error.issues.map(issue => issue.message), ['La edición referencia un archivo desconocido']);
  }
  assert.equal(editPlanSchema.safeParse({ ...plan, inputHashes: { one: sha256, two: sha256 },
    edits: [{ id: 'merge', kind: 'pdf_merge', inputIds: ['one', 'two'] }] }).success, true);
});

test('a provider claim with another filename or repeated applied IDs is not accepted', () => {
  const result: AgentResult = { schemaVersion: 1, outputName: plan.outputName, outcome: 'edited', editsApplied: ['e1'],
    editsFailed: [], partsModified: ['$document'], pagesAffected: [], warnings: [],
    selfCheck: { openedOk: true, textDiffMatchesPlan: true } };
  assert.equal(classifyAgentResult(plan, result), 'edited', 'Classifies a claim only, not independent validation');
  assert.throws(() => classifyAgentResult(plan, { ...result, outputName: 'another.txt' }), /DOC_RESULT_PLAN_MISMATCH/);
  assert.throws(() => classifyAgentResult(plan, { ...result, editsApplied: ['e1', 'e1'] }), /DOC_RESULT_PLAN_MISMATCH/);
  assert.deepEqual(result.editsApplied, ['e1']);
  assert.deepEqual(plan.inputHashes, { one: sha256 });
});

// Pure acceptance-predicate tests. These records exercise the report contract;
// they are never substituted for the real validator or used to approve bytes.
function completeReport(): ValidationReport {
  return { passed: true, levels: ([1, 2, 3, 4] as const).map((level) => ({
    level, passed: true, applicable: true, details: {}, durationMs: 1,
  })) };
}

test('publication report requires all four distinct levels, independent of their order', () => {
  const report = completeReport();
  assert.equal(hasCompleteValidation(report, 'docx'), true);
  assert.equal(hasCompleteValidation({ ...report, levels: [...report.levels].reverse() }, 'docx'), true);
  for (const level of [1, 2, 3, 4]) {
    const missing = report.levels.filter((entry) => entry.level !== level);
    assert.equal(hasCompleteValidation({ ...report, levels: missing }, 'docx'), false);
    assert.equal(hasCompleteValidation({ ...report, levels: [...missing, missing[0]!] }, 'docx'), false);
  }
  assert.equal(hasCompleteValidation({ ...report, levels: [...report.levels, report.levels[0]!] }, 'docx'), false);
});

test('a summary success cannot conceal any failed level and a failure summary cannot be promoted', () => {
  const report = completeReport();
  assert.equal(hasCompleteValidation({ ...report, passed: false }, 'pdf'), false);
  for (const level of [1, 2, 3, 4]) {
    assert.equal(hasCompleteValidation({ ...report,
      levels: report.levels.map((entry) => entry.level === level ? { ...entry, passed: false } : entry),
    }, 'pdf'), false);
  }
});

test('Office and PDF reports cannot waive a validation level as not applicable', () => {
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf'] as DocumentFormat[]) {
    for (const level of [1, 2, 3, 4]) {
      const report = completeReport();
      report.levels = report.levels.map((entry) => entry.level === level
        ? { ...entry, applicable: false, details: { reason: 'not paginated' } } : entry);
      assert.equal(hasCompleteValidation(report, format), false, `${format}: cannot waive level ${level}`);
    }
  }
});

test('plain formats permit only documented pagination exceptions, never structural or recipe exceptions', () => {
  for (const format of ['txt', 'md', 'csv', 'json', 'html'] as DocumentFormat[]) {
    const report = completeReport();
    report.levels = report.levels.map((entry) => [2, 3].includes(entry.level)
      ? { ...entry, applicable: false, passed: false, details: { reason: 'plain text has no fixed pagination' } } : entry);
    assert.equal(hasCompleteValidation(report, format), true);
    for (const level of [1, 4]) {
      assert.equal(hasCompleteValidation({ ...report, levels: report.levels.map((entry) => entry.level === level
        ? { ...entry, applicable: false, details: { reason: 'plain text' } } : entry) }, format), false);
    }
    for (const details of [{}, { reason: '' }, { reason: 42 }]) {
      assert.equal(hasCompleteValidation({ ...report, levels: report.levels.map((entry) => entry.level === 2
        ? { ...entry, details } : entry) }, format), false);
    }
  }
});

test('plan authority binds the exact filename, complete input hash map and inventory count', () => {
  for (const [inputs, inventories, candidate] of [
    [[], [], { ...plan, edits: [] }],
    [[input], [inventory], { ...plan, outputName: 'another.txt' }],
    [[input], [inventory], { ...plan, inputHashes: { one: sha256, extra: sha256 } }],
    [[input], [], plan],
    [[input], [inventory, inventory], plan],
  ] as const) {
    assert.throws(() => freezePlan([...inputs], [...inventories], candidate), { code: 'PLAN_INPUT_MISMATCH' });
  }
});

test('inventory identity, filename and format cannot be substituted despite an identical content hash', () => {
  for (const changed of [{ id: 'another' }, { name: 'another.txt' }, { format: 'pdf' }]) {
    assert.throws(() => freezePlan([input], [{ ...inventory, ...changed }], plan), { code: 'PLAN_INPUT_MISMATCH' });
  }
  assert.throws(() => freezePlan([input], [inventory], { ...plan, inputHashes: { one: '0'.repeat(64) } }),
    { code: 'PLAN_INPUT_MISMATCH' });
  assert.deepEqual(input.data, data);
});

test('frozen plan ownership separates nested maps and edits from subsequent model mutations', () => {
  const candidate = structuredClone(plan);
  const result = freezePlan([input], [inventory], candidate);
  const expected = structuredClone(result);
  candidate.inputHashes.one = '0'.repeat(64);
  candidate.outputName = 'substituted.txt';
  const first = candidate.edits[0]!;
  if (first.kind !== 'text') assert.fail('fixture requires a text operation');
  first.after = 'unauthorized extra text';
  candidate.edits.length = 0;
  assert.deepEqual(result, expected);
  assert.notEqual(result.inputHashes, candidate.inputHashes);
  assert.notEqual(result.edits, candidate.edits);
});

test('exact leaf identity is scoped by input and part, not only a matching text string', () => {
  const second = { ...input, id: 'two', name: 'b.txt' };
  const secondInventory = { ...inventory, id: 'two', name: 'b.txt' };
  const candidate = { ...plan, inputHashes: { one: sha256, two: sha256 },
    edits: [...plan.edits, { ...plan.edits[0], id: 'e2', inputId: 'two', after: 'different result' }] };
  assert.equal(freezePlan([input, second], [inventory, secondInventory], candidate).edits.length, 2);
  assert.throws(() => freezePlan([input], [inventory], { ...plan,
    edits: [{ ...plan.edits[0], part: 'another-part' }] }), { code: 'PLAN_LOCATOR' });
});

test('shared-string edits remain explicitly unsupported even when their claimed leaf matches', () => {
  // Pure plan policy: these records are not returned by a mocked validator and
  // do not establish that any document bytes are a valid spreadsheet.
  const source = { ...input, name: 'a.xlsx', format: 'xlsx' as const };
  const inspected = { ...inventory, name: source.name, format: source.format,
    units: [{ part: 'xl/sharedStrings.xml', locator: 'si[1]', text: 'before', kind: 'cell' }] };
  const candidate = { ...plan, outputName: source.name, edits: [{ id: 'cell-1', kind: 'cell', inputId: 'one',
    part: 'xl/sharedStrings.xml', locator: 'si[1]', before: 'before', after: 'after' }] };
  assert.throws(() => freezePlan([source], [inspected], candidate), { code: 'SHARED_STRING_EDIT_UNSUPPORTED' });
  assert.equal(inspected.units[0]!.text, 'before');
});

test('PDF merge policy checks every referenced inventory and preserves the explicit source order', () => {
  // Predicate inputs only; PDF sniffing/openability are tested by the real engine suite.
  const first = { ...input, name: 'a.pdf', format: 'pdf' as const };
  const second = { ...input, id: 'two', name: 'b.pdf', format: 'pdf' as const };
  const inventories = [{ ...inventory, name: first.name, format: 'pdf' },
    { ...inventory, id: second.id, name: second.name, format: 'pdf' }];
  const candidate = { ...plan, outputName: first.name, inputHashes: { one: sha256, two: sha256 },
    edits: [{ id: 'merge', kind: 'pdf_merge', inputIds: ['two', 'one'] }] };
  const result = freezePlan([first, second], inventories, candidate);
  assert.deepEqual(result.edits, candidate.edits);
  const nonPdf = { ...second, format: 'txt' as const };
  assert.throws(() => freezePlan([first, nonPdf], [inventories[0]!, { ...inventories[1]!, format: 'txt' }], candidate),
    { code: 'PDF_PLAN' });
});

test('output names cannot authorize traversal or control characters and valid Unicode names remain intact', () => {
  for (const outputName of ['../a.txt', 'sub/a.txt', 'sub\\a.txt', '.', '..', ' a.txt', 'a.txt ', 'a\u0000.txt', 'a\n.txt']) {
    assert.equal(editPlanSchema.safeParse({ ...plan, outputName }).success, false);
  }
  const name = 'Tesis revisión — 2026.txt';
  const result = freezePlan([{ ...input, name }], [{ ...inventory, name }], { ...plan, outputName: name });
  assert.equal(result.outputName, name);
});

test('both container path arguments reject control characters and relative paths before launch', () => {
  for (const invalid of ['relative', '/tmp/a\u0000b', '/tmp/a\rb', '/tmp/a\x7f', '/tmp/a,readonly=false']) {
    assert.throws(() => validatorContainerArguments('name', invalid, '/tmp/artifacts', { image }), { code: 'VALIDATOR_PATH_INVALID' });
    assert.throws(() => validatorContainerArguments('name', '/tmp/inputs', invalid, { image }), { code: 'VALIDATOR_PATH_INVALID' });
  }
});
