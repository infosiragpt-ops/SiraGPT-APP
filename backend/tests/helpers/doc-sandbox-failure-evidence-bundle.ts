import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../src/modules/doc-sandbox/engine/artifacts';
import { editPlanSchema, hasCompleteValidation, type InputFile, type ValidationReport } from '../../src/modules/doc-sandbox/types/contracts';
import { createTextFailureEvidenceFixture, realTextEvidenceResponseSchema, runRealTextEvidenceValidation } from './doc-sandbox-failure-evidence';

// Test-only evidence transport. Loading this bundle is NOT a validator adapter.
// The operator records its hash after running the actual Python exporter and
// supplies that independently when replaying the exact bytes in PG/S3 tests.
const MAX_BUNDLE_BYTES = 64 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sources = {
  validator: path.resolve(__dirname, '../../src/modules/doc-sandbox/validation/validator.py'),
  helper: path.resolve(__dirname, 'doc-sandbox-failure-evidence.ts'),
  exporter: path.resolve(__dirname, 'doc-sandbox-failure-evidence-bundle.ts'),
};
const sourceSchema = z.object({ validator: hashSchema, helper: hashSchema, exporter: hashSchema }).strict();
const caseSchema = z.object({ candidateBase64: z.string().max(2048), candidateSha256: hashSchema,
  rawResponse: z.string().max(32 * 1024), rawResponseSha256: hashSchema,
  diffBase64: z.string().max(8192), diffSha256: hashSchema }).strict();
const bundleSchema = z.object({ schemaVersion: z.literal(1),
  generator: z.literal('doc-sandbox-real-python-evidence-v1'), generatedAt: z.string().datetime(),
  sourceHashes: sourceSchema,
  original: z.object({ id: z.literal('original-year'), name: z.literal('year.txt'), format: z.literal('txt'),
    mime: z.literal('text/plain'), dataBase64: z.string().max(2048), sha256: hashSchema }).strict(),
  plan: editPlanSchema,
  cases: z.object({ negative: caseSchema, positive: caseSchema }).strict(),
}).strict();
type EncodedCase = z.infer<typeof caseSchema>;

function sourceHashes(): z.infer<typeof sourceSchema> {
  return { validator: sha256(readFileSync(sources.validator)), helper: sha256(readFileSync(sources.helper)),
    exporter: sha256(readFileSync(sources.exporter)) };
}

function privateParent(filename: string): void {
  assert.ok(path.isAbsolute(filename) && path.normalize(filename) === filename && !/[\x00-\x1f\x7f]/.test(filename));
  const parent = path.dirname(filename);
  const stat = lstatSync(parent);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o700, 'evidence directory must be private');
  if (process.getuid) assert.equal(stat.uid, process.getuid());
  assert.equal(realpathSync(parent), parent, 'evidence parent must not traverse symlinks');
}

function decodeExact(value: string, maxBytes: number): Buffer {
  assert.ok(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  assert.ok(value.length <= Math.ceil(maxBytes / 3) * 4);
  const data = Buffer.from(value, 'base64');
  assert.ok(data.length <= maxBytes);
  assert.equal(data.toString('base64'), value);
  return data;
}

function verifyCase(encoded: EncodedCase, original: InputFile,
  plan: z.infer<typeof editPlanSchema>, expectedCandidate: Buffer, passed: boolean) {
  const candidate = decodeExact(encoded.candidateBase64, 1024);
  assert.deepEqual(candidate, expectedCandidate);
  assert.equal(sha256(candidate), encoded.candidateSha256);
  assert.equal(sha256(Buffer.from(encoded.rawResponse, 'utf8')), encoded.rawResponseSha256);
  const { report: rawReport } = realTextEvidenceResponseSchema.parse(JSON.parse(encoded.rawResponse) as unknown);
  const diff = decodeExact(encoded.diffBase64, 4096);
  assert.equal(sha256(diff), encoded.diffSha256);
  assert.deepEqual(rawReport.artifactFiles, ['text-diff.json']);
  assert.deepEqual(Object.keys(rawReport.artifactData), ['text-diff.json']);
  assert.equal(rawReport.artifactData['text-diff.json'], encoded.diffBase64);
  assert.equal(rawReport.passed, passed);
  assert.equal(rawReport.originalSha256, original.sha256);
  assert.equal(rawReport.outputSha256, encoded.candidateSha256);
  assert.deepEqual(rawReport.levels.map(level => [level.level, level.passed, level.applicable]),
    [[1, true, true], [2, false, false], [3, false, false], [4, passed, true]]);
  assert.equal(rawReport.levels[3]!.details.code, passed ? undefined : 'TEXT_DIFF_UNPLANNED');
  assert.deepEqual(rawReport.changes, passed ? plan.edits : []);
  const textDiff: unknown = JSON.parse(diff.toString('utf8'));
  assert.deepEqual(textDiff, { schemaVersion: 1,
    observedChanges: [{ part: '$document', locator: 'text', before: '2026', after: passed ? '2027' : '2028' }],
    validatedChanges: passed ? plan.edits : [] });
  // Projection only: every report field and diff byte comes from the exported
  // Python result, exactly as in the existing real-oracle helper.
  const report: ValidationReport = { passed: rawReport.passed, levels: rawReport.levels,
    originalSha256: rawReport.originalSha256, outputSha256: rawReport.outputSha256, changes: rawReport.changes,
    artifacts: [{ name: 'text-diff.json', kind: 'text_diff', data: diff, mime: 'application/json', sha256: encoded.diffSha256 }] };
  assert.equal(hasCompleteValidation(report, 'txt'), passed);
  return { candidate, report, rawReport, textDiff };
}

function verifyBundle(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_BUNDLE_BYTES);
  const encoded = bundleSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  assert.deepEqual(encoded.sourceHashes, sourceHashes(), 'bundle must match the actual validator/helper/exporter source bytes');
  const fixture = createTextFailureEvidenceFixture();
  const original: InputFile = { id: encoded.original.id, name: encoded.original.name, format: encoded.original.format,
    mime: encoded.original.mime, data: decodeExact(encoded.original.dataBase64, 1024), sha256: encoded.original.sha256 };
  assert.deepEqual(original, fixture.original);
  assert.equal(sha256(original.data), original.sha256);
  assert.deepEqual(encoded.plan, fixture.plan, 'transport must not widen or rewrite the frozen plan');
  return { original, plan: encoded.plan, sourceHashes: encoded.sourceHashes,
    negative: verifyCase(encoded.cases.negative, original, encoded.plan, fixture.incorrectOutput, false),
    positive: verifyCase(encoded.cases.positive, original, encoded.plan, fixture.requestedOutput, true) };
}

/** Runs two REAL Python validations before writing a new 0600 evidence file. */
export function exportRealFailureEvidenceBundle(filename: string) {
  privateParent(filename);
  const hashes = sourceHashes();
  const fixture = createTextFailureEvidenceFixture();
  function produce(candidate: Buffer): EncodedCase {
    const result = runRealTextEvidenceValidation(fixture, candidate);
    assert.deepEqual(result.originalAfter, fixture.original.data);
    assert.deepEqual(result.candidateAfter, candidate);
    assert.throws(() => lstatSync(result.directory), { code: 'ENOENT' });
    assert.ok(result.report.artifacts && result.report.artifacts.length === 1);
    const diff = result.report.artifacts[0]!;
    return { candidateBase64: candidate.toString('base64'), candidateSha256: sha256(candidate),
      rawResponse: result.rawResponse, rawResponseSha256: sha256(Buffer.from(result.rawResponse, 'utf8')),
      diffBase64: diff.data.toString('base64'), diffSha256: sha256(diff.data) };
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, generator: 'doc-sandbox-real-python-evidence-v1',
    generatedAt: new Date().toISOString(), sourceHashes: hashes,
    original: { id: fixture.original.id, name: fixture.original.name, format: fixture.original.format, mime: fixture.original.mime,
      dataBase64: fixture.original.data.toString('base64'), sha256: fixture.original.sha256 }, plan: fixture.plan,
    cases: { negative: produce(fixture.incorrectOutput), positive: produce(fixture.requestedOutput) } }), 'utf8');
  // Also detects source edits while either subprocess was running.
  verifyBundle(bytes);
  const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); }
  finally { closeSync(fd); }
  return { filename, sha256: sha256(bytes), bytes: bytes.length, sourceHashes: hashes,
    controls: { negative: 'TEXT_DIFF_UNPLANNED', positive: 'passed' } };
}

/** Must run before opening any PG/S3 fixture. No default or canned fallback. */
export function readVerifiedFailureEvidenceBundle(filename: string, expectedSha256: string) {
  try {
    hashSchema.parse(expectedSha256);
    privateParent(filename);
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_BUNDLE_BYTES);
      assert.equal(stat.mode & 0o077, 0);
      if (process.getuid) assert.equal(stat.uid, process.getuid());
      // Read at most the verified length plus one byte; a concurrent growth
      // must fail closed without allocating an arbitrarily enlarged file.
      const bounded = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bounded.length) {
        const count = readSync(fd, bounded, length, bounded.length - length, null);
        if (count === 0) break;
        length += count;
      }
      assert.equal(length, stat.size);
      bytes = bounded.subarray(0, length);
    } finally { closeSync(fd); }
    assert.equal(sha256(bytes), expectedSha256, 'operator-pinned bundle digest must match');
    return { ...verifyBundle(bytes), bundleSha256: expectedSha256 };
  } catch { throw new Error('DOC_TEST_FAILURE_EVIDENCE_INVALID'); }
}

if (require.main === module) {
  try {
    const [filename, extra] = process.argv.slice(2);
    assert.ok(filename); assert.equal(extra, undefined);
    process.stdout.write(`${exportRealFailureEvidenceBundle(filename).sha256}\n`);
  } catch {
    // Never print Python stderr, document data, paths supplied by malformed
    // bundles, or Zod diagnostic values through the export command.
    process.stderr.write('DOC_TEST_FAILURE_EVIDENCE_EXPORT_FAILED\n'); process.exitCode = 1;
  }
}
