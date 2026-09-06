import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, originalFilename, publicEvent, jobSnapshot } from '../src/modules/doc-sandbox/api/router';
import type { DurableDocumentEvent, StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';
test('filenames preserve correct Unicode, accents, spaces and emoji without lossy conversion', () => {
  for (const name of ['tesis.docx', 'Mi tesis final.docx', 'Información.docx', 'Ārbol.docx', 'ĸ.docx', 'Documento 😀.docx', '文書.docx']) {
    assert.equal(originalFilename(name), name);
  }
});
test('latin1 multipart mojibake is repaired reversibly', () => {
  const expected = 'Información final.docx';
  const raw = Buffer.from(expected, 'utf8').toString('latin1');
  assert.equal(originalFilename(raw), expected);
});
test('filenames reject traversal, control characters and absolute/Windows paths', () => {
  for (const name of ['../secret.docx', '/tmp/a.docx', 'C:\\secret.docx', 'a\0.docx', 'a\n.docx', '.', '..', ' a.docx', 'a.docx ']) {
    assert.throws(() => originalFilename(name), name);
  }
});
test('cheap file admission accepts Office/PDF signatures but is not full validation', () => {
  const zipMagic = Buffer.from([80, 75, 3, 4]);
  for (const format of ['docx', 'xlsx', 'pptx']) assert.equal(classifyInput(`original.${format}`, zipMagic).format, format);
  assert.deepEqual(classifyInput('original.PDF', Buffer.from('%PDF-1.7')), { format: 'pdf', mime: 'application/pdf' });
});
test('cheap admission rejects falsified Office/PDF signatures and unenabled formats', () => {
  for (const name of ['fake.docx', 'fake.xlsx', 'fake.pptx', 'fake.pdf']) assert.throws(() => classifyInput(name, Buffer.from('not that format')));
  for (const suffix of ['xlsm', 'exe', 'zip', 'doc', 'ppt', 'odt']) assert.throws(() => classifyInput(`a.${suffix}`, Buffer.from('x')));
});
test('flat file MIME mapping is explicit and full parsing remains the independent worker gate', () => {
  for (const [format, mime] of [['txt', 'text/plain'], ['md', 'text/markdown'], ['json', 'application/json'], ['html', 'text/html'], ['csv', 'text/csv']]) {
    assert.deepEqual(classifyInput(`a.${format}`, Buffer.from('fixture')), { format, mime });
  }
});

const event: DurableDocumentEvent = { id: 'event-id', jobId: 'job-id', seq: 4, type: 'validation_level', createdAt: new Date(0), outbox: null,
  payload: { level: 3, passed: true, applicable: true, attempt: 1, providerRef: 'private-provider-reference',
    instructions: 'private-document-content', apiKey: 'synthetic-private-key', phase: 'validating' } };
test('public SSE projection excludes provider references, model/document text and secrets', () => {
  const output = publicEvent(event);
  assert.deepEqual(output, { seq: 4, type: 'validation_level', createdAt: event.createdAt,
    payload: { level: 3, passed: true, applicable: true, attempt: 1, phase: 'validating' } });
  const serialized = JSON.stringify(output);
  for (const forbidden of ['private-provider-reference', 'private-document-content', 'synthetic-private-key', 'job-id', 'outbox']) assert.equal(serialized.includes(forbidden), false);
});
test('malformed SSE names and multiline payload values cannot inject events', () => {
  const result = publicEvent({ ...event, type: 'phase\ndata: injected', payload: { phase: 'validating\ndata: injected', code: '<script>bad</script>', passed: false } });
  assert.equal(result.type, 'phase');
  assert.deepEqual(result.payload, { passed: false });
});

function job(): StoredDocumentJob {
  return { id: 'job-id', userId: 'user-id', status: 'validating', outcome: null, admissionReady: true, mode: 'preserve', engine: 'anthropic', modelTier: 'mechanical',
    requestedModel: 'fixture-mechanical', tokenBudget: 1000,
    instructionsKey: 'private-instructions-key', inputKeys: ['private-input-key'], outputKeys: ['private-output-key'], editPlanKey: 'private-plan-key',
    editPlanHash: 'private-plan-hash', validationReportKey: 'private-report-key', errorCode: null, usage: { inputTokens: 12, outputTokens: 4 }, costUsd: '0.001',
    maxCostUsd: '1', costReservations: [], purgedKeys: [], storageKeys: [], attempts: 1, fence: 4, leaseToken: 'private-lease-token', leaseExpiresAt: new Date(1000),
    eventSeq: 4, sessionRef: 'private-provider-session', providerFiles: [], providerContainers: [], cleanupPending: false, cleanupNotBefore: null, parentJobId: null,
    promptVersion: 'private-prompt-version', createdAt: new Date(0), startedAt: new Date(100), finishedAt: null, expiresAt: new Date(10000), deletedAt: null };
}
test('job snapshot never publishes storage keys, leases, owner or provider session', () => {
  const output = jobSnapshot(job(), false);
  assert.equal('usage' in output, false);
  assert.equal('costUsd' in output, false);
  assert.deepEqual(Object.keys(output).sort(), ['id', 'status', 'outcome', 'admissionReady', 'mode', 'modelTier', 'attempts', 'eventSeq', 'errorCode', 'cleanupPending', 'createdAt', 'startedAt', 'finishedAt', 'expiresAt'].sort());
  assert.equal(JSON.stringify(output).includes('private-'), false);
});
test('conservative completion is explicit, never presented as an edit or private provider explanation', () => {
  const original = job();
  original.status = 'done';
  original.outcome = 'not_possible';
  const snapshot = jobSnapshot(original, false);
  assert.equal(snapshot.outcome, 'not_possible');
  assert.equal(snapshot.warningCode, 'E_NOT_POSSIBLE');
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
  original.outcome = 'edited';
  assert.equal('warningCode' in jobSnapshot(original, false), false);
  original.outcome = 'unchanged';
  assert.equal(jobSnapshot(original, false).outcome, 'unchanged');
  assert.equal('warningCode' in jobSnapshot(original, false), false);
});
test('cost-visible job projection only publishes safe numeric usage metrics', () => {
  const original = job();
  original.usage = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2,
    providerRef: 'private-provider-reference', document: 'private-document-text', nested: { secret: 'private-nested-secret' } };
  const output = jobSnapshot(original, true);
  assert.equal(output.costUsd, '0.001');
  assert.deepEqual(output.usage, { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 });
  assert.equal(JSON.stringify(output).includes('private-'), false);
});
test('unknown or reserved cost is pending, never a zero-dollar confirmation', () => {
  const original = job();
  original.usage = { costUsd: null };
  assert.equal(jobSnapshot(original, true).costUsd, null);
  assert.equal(jobSnapshot(original, true).costStatus, 'pending');
  original.usage = { costExact: true };
  original.costReservations = [{ requestId: 'test-request', attempt: 1, reservedUsd: '0.5', actualUsd: null }];
  assert.equal(jobSnapshot(original, true).costUsd, null);
  assert.equal(jobSnapshot(original, true).costStatus, 'pending');
  original.costReservations = [];
  assert.equal(jobSnapshot(original, true).costStatus, 'exact');
});
