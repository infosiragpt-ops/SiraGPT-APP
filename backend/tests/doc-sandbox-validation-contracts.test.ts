import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createValidatorStagingDirectory, freezePlan, validatorContainerArguments, type DocumentInventory } from '../src/modules/doc-sandbox/validation/index';
import { hasCompleteValidation, type DocumentFormat, type EditPlan, type InputFile, type ValidationReport } from '../src/modules/doc-sandbox/types/contracts';

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
