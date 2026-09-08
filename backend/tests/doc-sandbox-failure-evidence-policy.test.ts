import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFailureEvidence, type FailureEvidenceMetadata, type FailureEvidenceMode } from '../src/modules/doc-sandbox/queue/failure-evidence';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Pure metadata contracts, not a validator oracle or a storage fixture. Synthetic
// digest/size declarations here do NOT prove image bytes, hashes, uploads or IO.
const digest = 'a'.repeat(64);
const mib = 1024 * 1024;
const single = { kind: 'single' } as const;
const preserved = (groups: number): FailureEvidenceMode => ({ kind: 'preservation', groups });
const metadata = (patch: Partial<FailureEvidenceMetadata> = {}): FailureEvidenceMetadata => ({
  kind: 'text_diff', filename: 'text-diff.json', mime: 'application/json', size: 1, sha256: digest, ...patch,
});
const thumbnail = (filename: string, size = 1): FailureEvidenceMetadata => metadata({ filename,
  kind: filename.replace(/^input-\d-/, '').startsWith('before-') ? 'thumbnail_before' : 'thumbnail_after',
  mime: 'image/png', size });
const rejected = (error: unknown): boolean => error instanceof DocSandboxError && error.code === 'E_VALIDATION' && error.status === 422;

test('single evidence accepts the validator diff and both thumbnail families without requiring missing evidence', () => {
  validateFailureEvidence([], single);
  validateFailureEvidence([metadata(), thumbnail('before-0.png'), thumbnail('after-2.png'),
    thumbnail('before-notes-3.png'), thumbnail('after-notes-4.png')], single);
  validateFailureEvidence([thumbnail('before-0001.png')], single); // Existing validator spelling is preserved.
});

test('preservation accepts only worker-prefixed groups and permits a real partial report set', () => {
  validateFailureEvidence([], preserved(10));
  validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' })], preserved(1));
  validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' }),
    metadata({ filename: 'input-9-text-diff.json' }), thumbnail('input-9-before-notes-1.png')], preserved(10));
  validateFailureEvidence([metadata({ filename: 'input-3-text-diff.json' })], preserved(4));
});

test('unknown modes and invalid preservation group counts reject even when evidence is empty', () => {
  for (const groups of [0, -1, 11, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateFailureEvidence([], preserved(groups)), rejected);
  }
  for (const mode of [null, undefined, {}, 'single', { kind: 'batch', groups: 1 },
    { kind: 'preservation' }, { kind: 'preservation', groups: '1' }]) {
    assert.throws(() => validateFailureEvidence([], mode as unknown as FailureEvidenceMode), rejected);
  }
});

test('unsafe filenames and artifacts outside the independent evidence allowlist reject', () => {
  for (const filename of ['', '../text-diff.json', '/text-diff.json', 'nested/text-diff.json',
    'text-diff.json\n', 'TEXT-DIFF.JSON', 'before--1.png', 'before-notes-.png',
    'before-1.jpg', 'before-1.png/extra', 'before-1%2F.png', 'result.json', 'recipe.zip']) {
    assert.throws(() => validateFailureEvidence([metadata({ filename })], single), rejected);
  }
});

test('raw and preservation names cannot mix and every prefixed index must belong to the chosen group count', () => {
  assert.throws(() => validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' })], single), rejected);
  assert.throws(() => validateFailureEvidence([metadata()], preserved(1)), rejected);
  assert.throws(() => validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' }), metadata()], preserved(2)), rejected);
  for (const filename of ['input-1-text-diff.json', 'input-9-text-diff.json', 'input-10-text-diff.json',
    'input-00-text-diff.json', 'input--1-text-diff.json', 'input-0-input-0-text-diff.json']) {
    assert.throws(() => validateFailureEvidence([metadata({ filename })], preserved(1)), rejected);
  }
});

test('kind and MIME must match the exact diff or before/after filename', () => {
  for (const kind of ['input', 'output', 'edit_plan', 'recipe', 'agent_result', 'validation_report',
    'transcript', 'thumbnail_before', 'thumbnail_after', 'unknown']) {
    assert.throws(() => validateFailureEvidence([metadata({ kind })], single), rejected);
  }
  for (const mime of ['text/plain', 'image/png', 'application/json; charset=utf-8', '']) {
    assert.throws(() => validateFailureEvidence([metadata({ mime })], single), rejected);
  }
  assert.throws(() => validateFailureEvidence([{ ...thumbnail('before-1.png'), kind: 'thumbnail_after' }], single), rejected);
  assert.throws(() => validateFailureEvidence([{ ...thumbnail('after-notes-1.png'), kind: 'thumbnail_before' }], single), rejected);
  assert.throws(() => validateFailureEvidence([{ ...thumbnail('before-1.png'), mime: 'application/json' }], single), rejected);
});

test('artifact sizes must be positive safe integers and may equal but never exceed ten MiB', () => {
  validateFailureEvidence([thumbnail('before-1.png', 10 * mib)], single);
  for (const size of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10 * mib + 1]) {
    assert.throws(() => validateFailureEvidence([metadata({ size })], single), rejected);
  }
  assert.throws(() => validateFailureEvidence([metadata({ size: '1' as unknown as number })], single), rejected);
});

test('metadata digests must have the exact lowercase SHA-256 shape without claiming their bytes match', () => {
  for (const sha256 of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${digest}\n`]) {
    assert.throws(() => validateFailureEvidence([metadata({ sha256 })], single), rejected);
  }
  assert.throws(() => validateFailureEvidence([metadata({ sha256: 1 as unknown as string })], single), rejected);
});

test('each validation admits exactly sixteen MiB in total and rejects one additional byte', () => {
  const artifacts = [thumbnail('before-1.png', 10 * mib), thumbnail('after-1.png', 6 * mib)];
  validateFailureEvidence(artifacts, single);
  assert.throws(() => validateFailureEvidence([...artifacts, metadata()], single), rejected);
});

test('preservation byte budgets are per completed group, not a pooled allowance transferable to one child', () => {
  const artifacts = Array.from({ length: 10 }, (_, index) => [
    thumbnail(`input-${index}-before-1.png`, 10 * mib), thumbnail(`input-${index}-after-1.png`, 6 * mib),
  ]).flat();
  // 160 MiB declared metadata only: no allocation, image decoding or PUT occurs.
  validateFailureEvidence(artifacts, preserved(10));
  assert.throws(() => validateFailureEvidence([...artifacts, metadata({ filename: 'input-9-text-diff.json' })], preserved(10)), rejected);
  assert.throws(() => validateFailureEvidence([thumbnail('input-0-before-1.png', 10 * mib),
    thumbnail('input-0-after-1.png', 6 * mib), metadata({ filename: 'input-0-text-diff.json' })], preserved(10)), rejected);
});

test('single validation count accepts 1001 unique entries and rejects entry 1002', () => {
  const artifacts = Array.from({ length: 1001 }, (_, index) => thumbnail(`before-${index}.png`));
  validateFailureEvidence(artifacts, single);
  assert.throws(() => validateFailureEvidence([...artifacts, metadata()], single), rejected);
});

test('ten preservation groups accept 10010 metadata entries without allowing a child to exceed 1001', () => {
  const artifacts = Array.from({ length: 10 }, (_, group) =>
    Array.from({ length: 1001 }, (_, index) => thumbnail(`input-${group}-before-${index}.png`))).flat();
  // This exercises cardinality only; it does not claim 10010 objects can be stored.
  validateFailureEvidence(artifacts, preserved(10));
  assert.throws(() => validateFailureEvidence([...artifacts, metadata({ filename: 'input-9-text-diff.json' })], preserved(10)), rejected);
  const overloadedChild = Array.from({ length: 1002 }, (_, index) => thumbnail(`input-0-before-${index}.png`));
  assert.throws(() => validateFailureEvidence(overloadedChild, preserved(10)), rejected);
});

test('duplicate filenames reject even with different digests while matching names in distinct groups remain separate', () => {
  assert.throws(() => validateFailureEvidence([metadata(), metadata({ sha256: 'b'.repeat(64) })], single), rejected);
  assert.throws(() => validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' }),
    metadata({ filename: 'input-0-text-diff.json' })], preserved(2)), rejected);
  validateFailureEvidence([metadata({ filename: 'input-0-text-diff.json' }),
    metadata({ filename: 'input-1-text-diff.json' })], preserved(2));
});

test('malformed collections and records fail with the same stable validation error', () => {
  for (const artifacts of [null, undefined, {}, 'evidence', [null], [undefined], [1], [{}], Array(1)]) {
    assert.throws(() => validateFailureEvidence(artifacts as unknown as readonly FailureEvidenceMetadata[], single), rejected);
  }
});

test('validation leaves frozen metadata, order and mode untouched on both acceptance and rejection', () => {
  const mode = Object.freeze({ kind: 'preservation' as const, groups: 2 });
  const artifacts = Object.freeze([Object.freeze(metadata({ filename: 'input-1-text-diff.json' })),
    Object.freeze(thumbnail('input-0-before-notes-1.png'))]);
  const before = structuredClone({ artifacts, mode });
  validateFailureEvidence(artifacts, mode);
  assert.deepEqual({ artifacts, mode }, before);
  const invalid = Object.freeze([...artifacts, artifacts[0]!]);
  const invalidBefore = structuredClone(invalid);
  assert.throws(() => validateFailureEvidence(invalid, mode), rejected);
  assert.deepEqual(invalid, invalidBefore);
});
