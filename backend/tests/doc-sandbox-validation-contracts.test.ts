import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createValidatorStagingDirectory, freezePlan, validatorContainerArguments, type DocumentInventory } from '../src/modules/doc-sandbox/validation/index';
import type { EditPlan, InputFile } from '../src/modules/doc-sandbox/types/contracts';

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
