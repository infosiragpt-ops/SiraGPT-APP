import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { sha256 } from '../src/modules/doc-sandbox/engine/artifacts';
import { hasCompleteValidation } from '../src/modules/doc-sandbox/types/contracts';
import { createTextFailureEvidenceFixture, runRealTextEvidenceValidation } from './helpers/doc-sandbox-failure-evidence';

// Real trusted Python + synthetic TXT/FS only. No provider/transport/validator
// mock, no Docker, and no claim about processor catch or private persistence.
test('real validator rejects 2028 for a 2026-to-2027 plan and emits the observed failed diff', () => {
  const fixture = createTextFailureEvidenceFixture();
  const before = JSON.stringify(fixture);
  const result = runRealTextEvidenceValidation(fixture, fixture.incorrectOutput);
  assert.equal(result.report.passed, false);
  assert.equal(hasCompleteValidation(result.report, 'txt'), false);
  assert.equal(result.report.originalSha256, sha256(Buffer.from('2026')));
  assert.equal(result.report.outputSha256, sha256(Buffer.from('2028')));
  assert.deepEqual(result.report.levels.map(level => [level.level, level.passed, level.applicable]),
    [[1, true, true], [2, false, false], [3, false, false], [4, false, true]]);
  assert.equal(result.report.levels[3]!.details.code, 'TEXT_DIFF_UNPLANNED');
  assert.deepEqual(result.report.changes, []);
  assert.deepEqual(result.textDiff, { schemaVersion: 1,
    observedChanges: [{ part: '$document', locator: 'text', before: '2026', after: '2028' }], validatedChanges: [] });
  const artifact = result.report.artifacts![0]!;
  assert.equal(artifact.kind, 'text_diff');
  assert.equal(artifact.sha256, sha256(artifact.data));
  assert.match(artifact.data.toString('utf8'), /2028/);
  assert.doesNotMatch(artifact.data.toString('utf8'), /2027/);
  assert.deepEqual(result.originalAfter, fixture.original.data);
  assert.deepEqual(result.candidateAfter, fixture.incorrectOutput);
  assert.equal(JSON.stringify(fixture), before);
  assert.throws(() => lstatSync(result.directory), { code: 'ENOENT' });
});

test('the same real validator accepts exactly 2027 and records its genuinely validated change', () => {
  const fixture = createTextFailureEvidenceFixture();
  const before = JSON.stringify(fixture);
  const result = runRealTextEvidenceValidation(fixture, fixture.requestedOutput);
  assert.equal(result.report.passed, true);
  assert.equal(hasCompleteValidation(result.report, 'txt'), true);
  assert.equal(result.report.originalSha256, sha256(Buffer.from('2026')));
  assert.equal(result.report.outputSha256, sha256(Buffer.from('2027')));
  assert.deepEqual(result.report.levels.map(level => [level.level, level.passed, level.applicable]),
    [[1, true, true], [2, false, false], [3, false, false], [4, true, true]]);
  assert.equal(result.report.levels[3]!.details.code, undefined);
  assert.deepEqual(result.report.changes, fixture.plan.edits);
  assert.deepEqual(result.textDiff, { schemaVersion: 1,
    observedChanges: [{ part: '$document', locator: 'text', before: '2026', after: '2027' }],
    validatedChanges: fixture.plan.edits });
  const artifact = result.report.artifacts![0]!;
  assert.equal(artifact.sha256, sha256(artifact.data));
  assert.doesNotMatch(artifact.data.toString('utf8'), /2028/);
  assert.deepEqual(result.originalAfter, fixture.original.data);
  assert.deepEqual(result.candidateAfter, fixture.requestedOutput);
  assert.equal(JSON.stringify(fixture), before);
  assert.throws(() => lstatSync(result.directory), { code: 'ENOENT' });
});
