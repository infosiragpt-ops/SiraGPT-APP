import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { IndependentDocumentValidator, inspectRecipeArchive, validatorContainerArguments, createValidatorStagingDirectory } from '../src/modules/doc-sandbox/validation/index';
import { DocumentValidationError } from '../src/modules/doc-sandbox/validation/errors';
import type { EditPlan, InputFile } from '../src/modules/doc-sandbox/types/contracts';

const image = `sha256:${'a'.repeat(64)}`;
const dockerBinary = path.join(__dirname, 'fixtures/doc-sandbox-fake-docker.cjs');
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function privateRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-execute-test-'));
  await chmod(root, 0o700);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  return root;
}

function txt(text = 'El informe dice 2026.\n'): InputFile {
  const data = Buffer.from(text);
  return { id: 'input-1', name: 'informe.txt', format: 'txt', mime: 'text/plain', data, sha256: hash(data) };
}

function plan(input: InputFile): EditPlan {
  return {
    schemaVersion: 1, mode: 'preserve', outputName: input.name, inputHashes: { [input.id]: input.sha256 },
    edits: [], notPossible: [],
  };
}

test('fake isolated runner covers inspect, validate, recipe and preflight without Docker', async t => {
  const root = await privateRoot(t);
  const validator = new IndependentDocumentValidator({ image, runtime: 'runsc', stagingRoot: root, dockerBinary, timeoutMs: 5_000 });
  const input = txt();
  const inventories = await validator.inspect([input]);
  assert.equal(inventories[0]?.sha256, input.sha256);
  const report = await validator.validate([input], input.data, plan(input));
  assert.equal(report.passed, true);
  assert.equal(report.artifacts[0]?.name, 'text-diff.json');
  const recipe = Buffer.alloc(32, 0); recipe.writeUInt32LE(0x04034b50, 0);
  const inspected = await inspectRecipeArchive(recipe, { image, runtime: 'runsc', stagingRoot: root, dockerBinary, timeoutMs: 5_000 });
  assert.equal(inspected.scripts[0], '01_restore.py');
  await validator.preflight();
});

test('execute rejects duplicate ids, empty buffers and oversized output before launch', async t => {
  const root = await privateRoot(t);
  const validator = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => assert.fail('must not launch'),
  });
  const input = txt();
  await assert.rejects(validator.inspect([]), { code: 'INPUT_LIMIT' });
  await assert.rejects(validator.inspect([input, { ...input }]), { code: 'INPUT_LIMIT' });
  await assert.rejects(validator.inspect([{ ...input, data: Buffer.alloc(0), sha256: hash(Buffer.alloc(0)) }]), { code: 'INPUT_HASH_OR_SIZE' });
  await assert.rejects(validator.validate([input], Buffer.alloc(50 * 1024 * 1024 + 1), plan(input)), { code: 'OUTPUT_SIZE_LIMIT' });
});

test('injected runner covers artifact decode, limits and validator error replies', async t => {
  const root = await privateRoot(t);
  const input = txt();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const okDiff = Buffer.from('{"changed":false}').toString('base64');
  const cases: Array<[string, unknown]> = [
    ['ok-false', { ok: false, error: { code: 'PLAN_LOCATOR', message: 'bad' } }],
    ['too-many', { ok: true, report: {
      schemaVersion: 1, passed: true, originalSha256: input.sha256, outputSha256: input.sha256,
      levels: [1, 2, 3, 4].map(level => ({ level, passed: true, applicable: true, details: {}, durationMs: 1 })),
      artifactFiles: Array.from({ length: 1002 }, (_, i) => `before-${i}.png`), artifactData: {}, changes: [],
    } }],
    ['bad-name', { ok: true, report: {
      schemaVersion: 1, passed: true, originalSha256: input.sha256, outputSha256: input.sha256,
      levels: [1, 2, 3, 4].map(level => ({ level, passed: true, applicable: true, details: {}, durationMs: 1 })),
      artifactFiles: ['notes.txt'], artifactData: { 'notes.txt': okDiff }, changes: [],
    } }],
    ['missing-data', { ok: true, report: {
      schemaVersion: 1, passed: true, originalSha256: input.sha256, outputSha256: input.sha256,
      levels: [1, 2, 3, 4].map(level => ({ level, passed: true, applicable: true, details: {}, durationMs: 1 })),
      artifactFiles: ['text-diff.json'], artifactData: {}, changes: [],
    } }],
    ['bad-b64', { ok: true, report: {
      schemaVersion: 1, passed: true, originalSha256: input.sha256, outputSha256: input.sha256,
      levels: [1, 2, 3, 4].map(level => ({ level, passed: true, applicable: true, details: {}, durationMs: 1 })),
      artifactFiles: ['text-diff.json'], artifactData: { 'text-diff.json': 'abc' }, changes: [],
    } }],
  ];
  for (const [name, payload] of cases) {
    const validator = new IndependentDocumentValidator({
      image, runtime: 'runsc', stagingRoot: root, runContainer: async () => payload,
    });
    await assert.rejects(validator.validate([input], input.data, plan(input)), () => true, name);
  }
  const thumbs = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => ({
      ok: true,
      report: {
        schemaVersion: 1, passed: false, originalSha256: input.sha256, outputSha256: input.sha256,
        levels: [1, 2, 3, 4].map(level => ({ level, passed: true, applicable: true, details: {}, durationMs: 1 })),
        artifactFiles: ['before-1.png', 'after-notes-1.png', 'text-diff.json'],
        artifactData: {
          'before-1.png': png.toString('base64'),
          'after-notes-1.png': png.toString('base64'),
          'text-diff.json': okDiff,
        },
        changes: [],
      },
    }),
  });
  const report = await thumbs.validate([input], input.data, plan(input));
  assert.equal(report.artifacts.length, 3);
  assert.equal(report.artifacts[0]?.kind, 'thumbnail_before');
  assert.equal(report.artifacts[1]?.kind, 'thumbnail_after');
});

test('preflight fails when orphans remain or the probe hash does not match', async t => {
  const root = await privateRoot(t);
  const pending = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => assert.fail('preflight'),
  });
  pending.reconcileOrphans = async () => ({ examined: 1, purged: 0, pending: 1 });
  await assert.rejects(pending.preflight(), { code: 'VALIDATOR_CLEANUP_PENDING' });
  const mismatch = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => ({
      ok: true, preflight: {
        schemaVersion: 1, inputSha256: '0'.repeat(64),
        applications: { writer: 'b'.repeat(64), calc: 'c'.repeat(64), impress: 'd'.repeat(64) },
      },
    }),
  });
  await assert.rejects(mismatch.preflight(), { code: 'VALIDATOR_PREFLIGHT_FAILED' });
});

test('container argument helper and default staging directory stay pinned and private', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-args-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const inputs = path.join(root, 'inputs');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(inputs, { mode: 0o755 });
  await mkdir(artifacts, { mode: 0o755 });
  const args = validatorContainerArguments('siragpt-doc-validator-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', inputs, artifacts, { image, runtime: 'runsc' });
  assert.ok(args.includes('--pull'));
  assert.ok(args.includes('never'));
  assert.throws(() => validatorContainerArguments('n', inputs, artifacts, { image: 'latest', runtime: 'runsc' }), { code: 'VALIDATOR_IMAGE_UNPINNED' });
  assert.throws(() => validatorContainerArguments('n', inputs, artifacts, { image, runtime: 'runc' }), { code: 'VALIDATOR_RUNTIME_UNSAFE' });
  const staging = await createValidatorStagingDirectory();
  t.after(async () => { await rm(staging, { recursive: true, force: true }); });
  assert.ok(path.isAbsolute(staging));
});

test('inspect and validate reject a runner reply that omits the expected payload', async t => {
  const root = await privateRoot(t);
  const input = txt();
  const inventories = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => ({
      ok: true, recipe: { sha256: input.sha256, size: 1, expandedBytes: 0, scripts: ['01.py'], parts: {} },
    }),
  });
  await assert.rejects(inventories.inspect([input]), { code: 'VALIDATOR_INVALID_RESPONSE' });
  const report = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => ({
      ok: true, inventories: [{
        id: input.id, format: 'txt', sha256: input.sha256, size: input.data.length, name: input.name,
        mime: input.mime, parts: { $document: 'x' }, units: [], warnings: [],
      }],
    }),
  });
  await assert.rejects(report.validate([input], input.data, plan(input)), { code: 'VALIDATOR_INVALID_RESPONSE' });
  const recipe = new IndependentDocumentValidator({
    image, runtime: 'runsc', stagingRoot: root,
    runContainer: async () => ({
      ok: true, inventories: [{
        id: 'recipe', format: 'txt', sha256: input.sha256, size: input.data.length, name: 'recipe.zip',
        mime: 'application/zip', parts: {}, units: [], warnings: [],
      }],
    }),
  });
  await assert.rejects(recipe.inspectRecipeArchive(input.data), { code: 'VALIDATOR_INVALID_RESPONSE' });
  await assert.rejects(recipe.inspectRecipeArchive(Buffer.alloc(0)), { code: 'RECIPE_SIZE_LIMIT' });
});
