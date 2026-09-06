import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, jobSnapshot, originalFilename, publicEvent } from '../src/modules/doc-sandbox/api/router';
import { DocSandboxError, publicError, type DocErrorCode } from '../src/modules/doc-sandbox/types/errors';
import type { DurableDocumentEvent, StoredDocumentJob } from '../src/modules/doc-sandbox/queue/repository';

// These are pure projections and admission preconditions, not HTTP, storage,
// validator or provider fixtures. No document result is asserted validated.
function job(): StoredDocumentJob {
  return {
    id: 'release-job', userId: 'release-owner', status: 'queued', outcome: null, admissionReady: false,
    mode: 'preserve', engine: 'anthropic', modelTier: 'mechanical', requestedModel: 'synthetic-model', tokenBudget: 1000,
    instructionsKey: 'private-instructions', inputKeys: ['private-input'], outputKeys: [], editPlanKey: null, editPlanHash: null,
    validationReportKey: null, errorCode: null, usage: {}, costUsd: '0.125', maxCostUsd: '1', costReservations: [],
    purgedKeys: [], storageKeys: [], attempts: 0, fence: 0, leaseToken: null, leaseExpiresAt: null, eventSeq: 0,
    sessionRef: null, providerFiles: [], providerContainers: [], cleanupPending: false, cleanupNotBefore: null,
    parentJobId: null, promptVersion: 'synthetic-prompt', createdAt: new Date(0), startedAt: null,
    finishedAt: null, expiresAt: new Date(10_000), deletedAt: null,
  };
}

test('snapshot admits only finite nonnegative integer usage and boolean cost accuracy', () => {
  const source = job();
  source.usage = { inputTokens: NaN, outputTokens: Infinity, cacheReadTokens: -1,
    cacheWriteTokens: 1.5, costExact: 'true', internalPrompt: 'synthetic-private-content' };
  assert.deepEqual(jobSnapshot(source, true).usage, {});
  source.usage = { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: '20', cacheReadTokens: null,
    cacheWriteTokens: { number: 1 }, costExact: false };
  assert.deepEqual(jobSnapshot(source, true).usage, { costExact: false });
  source.usage = { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 2,
    cacheWriteTokens: 3, costExact: true };
  assert.deepEqual(jobSnapshot(source, true).usage, source.usage);
});

test('cost confidence is estimated unless exact and pending reservations always dominate', () => {
  const source = job();
  assert.equal(jobSnapshot(source, true).costStatus, 'estimated');
  source.usage = { costExact: true };
  assert.equal(jobSnapshot(source, true).costStatus, 'exact');
  source.costReservations = [{ requestId: 'synthetic-reservation', attempt: 1, reservedUsd: '0.5', actualUsd: null }];
  assert.equal(jobSnapshot(source, true).costStatus, 'pending');
  assert.equal(jobSnapshot(source, true).costUsd, null);
  assert.equal('costStatus' in jobSnapshot(source, false), false);
  assert.equal('usage' in jobSnapshot(source, false), false);
});

test('snapshot distinguishes unadmitted, failed and cancelled without fabricating edited output', () => {
  const source = job();
  for (const status of ['queued', 'failed', 'cancelled'] as const) {
    source.status = status;
    const projected = jobSnapshot(source, false);
    assert.equal(projected.status, status);
    assert.equal(projected.admissionReady, false);
    assert.equal(projected.outcome, null);
    assert.equal('warningCode' in projected, false);
    assert.equal('outputKeys' in projected, false);
  }
});

test('public event whitelist rejects nested values, nulls and overlong or empty strings', () => {
  const source: DurableDocumentEvent = { id: 'synthetic-event', jobId: 'release-job', seq: 7,
    type: 'status_changed', createdAt: new Date(0), outbox: null,
    payload: { status: 'done', outcome: 'not_possible', attempt: 2, phase: '', level: { value: 1 },
      passed: true, applicable: false, code: 'x'.repeat(81), retryable: null, cleanupPending: false,
      unexpected: true, filename: 'private-document-name' } };
  const result = publicEvent(source);
  assert.deepEqual(result.payload, { status: 'done', outcome: 'not_possible', attempt: 2,
    passed: true, applicable: false, cleanupPending: false });
  assert.equal(result.type, 'status_changed');
  assert.equal(result.seq, 7);
  assert.equal(result.createdAt, source.createdAt);
});

test('event names cannot introduce SSE delimiters or exceed the bounded public alphabet', () => {
  const source: DurableDocumentEvent = { id: 'synthetic-event', jobId: 'release-job', seq: 1,
    type: 'phase', createdAt: new Date(0), outbox: null, payload: {} };
  for (const type of ['', 'Phase', 'phase:token', 'phase\r\ndata: injected', 'a'.repeat(41)]) {
    assert.equal(publicEvent({ ...source, type }).type, 'phase');
  }
  assert.equal(publicEvent({ ...source, type: 'a'.repeat(40) }).type, 'a'.repeat(40));
});

test('short and misleading Office/PDF signatures are rejected before expensive processing', () => {
  for (const name of ['original.docx', 'original.xlsx', 'original.pptx', 'original.pdf']) {
    for (const bytes of [Buffer.alloc(0), Buffer.from([80, 75, 3]), Buffer.from('prefix %PDF-1.7')]) {
      assert.throws(() => classifyInput(name, bytes), error =>
        error instanceof DocSandboxError && error.code === 'E_PARAMS' && error.status === 415);
    }
  }
});

test('valid Latin-1 names are not damaged by lossy UTF-8 decoding', () => {
  for (const name of ['Año de edición.docx', 'Français.xlsx', 'Überblick.pptx', 'Información.pdf']) {
    assert.equal(originalFilename(name), name);
    assert.equal(originalFilename(Buffer.from(name, 'utf8').toString('latin1')), name);
  }
});

test('public errors never expose unknown thrown values or their provider/database causes', () => {
  for (const thrown of [new Error('synthetic-private-provider-body'), { token: 'synthetic-private-token' },
    'synthetic-private-string', null, undefined]) {
    const safe = publicError(thrown);
    assert.equal(safe.code, 'E_PROVIDER');
    assert.equal(safe.status, 500);
    assert.equal(JSON.stringify(safe).includes('synthetic-private'), false);
  }
});

test('typed public errors retain actionable codes and HTTP status without nested causes', () => {
  const codes: DocErrorCode[] = ['E_PARAMS', 'E_PROVIDER', 'E_QUOTA', 'E_TIMEOUT', 'E_CANCELLED', 'E_VALIDATION',
    'E_NOT_FOUND', 'E_FORBIDDEN', 'E_CONFLICT', 'E_NOT_READY', 'E_NOT_POSSIBLE', 'E_PLAN_GATE'];
  for (const code of codes) {
    const error = new DocSandboxError(code, 409, { cause: new Error('synthetic-private-cause') });
    const safe = publicError(error);
    assert.deepEqual(Object.keys(safe).sort(), ['code', 'message', 'status']);
    assert.equal(safe.code, code);
    assert.equal(safe.status, 409);
    assert.ok(safe.message.length > 0);
    assert.equal(JSON.stringify(safe).includes('synthetic-private'), false);
  }
});

test('snapshots expose an exact public projection and never return storage, model or lease identifiers', () => {
  const source = job();
  source.outputKeys = ['synthetic-private-output'];
  source.editPlanKey = 'synthetic-private-plan'; source.editPlanHash = 'synthetic-private-hash';
  source.validationReportKey = 'synthetic-private-report'; source.sessionRef = 'synthetic-private-session';
  source.leaseToken = 'synthetic-private-lease'; source.requestedModel = 'synthetic-private-model';
  const before = structuredClone(source);
  const projected = jobSnapshot(source, false);
  assert.deepEqual(Object.keys(projected).sort(), ['id', 'status', 'mode', 'modelTier', 'attempts',
    'admissionReady', 'outcome', 'eventSeq', 'errorCode', 'cleanupPending', 'createdAt', 'startedAt',
    'finishedAt', 'expiresAt'].sort());
  assert.equal(JSON.stringify(projected).includes('synthetic-private'), false);
  assert.deepEqual(source, before, 'public projection must not mutate authoritative state');
});

test('done outcomes remain distinct and preservation warnings never imply an edited document', () => {
  const source = job(); source.status = 'done'; source.admissionReady = true;
  for (const outcome of ['edited', 'unchanged', 'not_possible'] as const) {
    source.outcome = outcome;
    const result = jobSnapshot(source, true);
    assert.equal(result.outcome, outcome); assert.equal(result.status, 'done');
    assert.equal(result.warningCode, outcome === 'not_possible' ? 'E_NOT_POSSIBLE' : undefined);
    assert.equal('outputKeys' in result, false); assert.equal('validated' in result, false);
    assert.equal('validationReportKey' in result, false);
  }
});

test('unknown provider settlement keeps cost pending even when token usage claims exact', () => {
  const source = job(); source.usage = { costUsd: null, costExact: true, inputTokens: 0 };
  let projected = jobSnapshot(source, true);
  assert.equal(projected.costUsd, null); assert.equal(projected.costStatus, 'pending');
  assert.deepEqual(projected.usage, { costExact: true, inputTokens: 0 });
  source.usage = { costExact: true };
  source.costReservations = [
    { requestId: 'settled', attempt: 1, reservedUsd: '0.5', actualUsd: '0.1' },
    { requestId: 'unknown', attempt: 2, reservedUsd: '0.5', actualUsd: null },
  ];
  projected = jobSnapshot(source, true);
  assert.equal(projected.costUsd, null); assert.equal(projected.costStatus, 'pending');
  assert.equal('costReservations' in projected, false);
  const hidden = jobSnapshot(source, false);
  for (const field of ['costUsd', 'maxCostUsd', 'usage', 'costStatus', 'costReservations']) assert.equal(field in hidden, false);
});

test('event projection is non-mutating and strips every private payload kind including nested document text', () => {
  const source: DurableDocumentEvent = { id: 'private-event-id', jobId: 'private-job-id', seq: 0,
    type: 'warning', createdAt: new Date(0), outbox: null, payload: {
      code: 'E_NOT_POSSIBLE', phase: 'validating', level: 4, passed: false, applicable: true,
      instructions: 'private text', result: { document: 'private text' }, recipe: ['private code'],
      storageKey: 'private-key', filename: 'private-name', providerRef: 'private-ref', userId: 'private-user',
    } };
  const before = structuredClone(source);
  const result = publicEvent(source);
  assert.deepEqual(result, { seq: 0, type: 'warning', createdAt: new Date(0),
    payload: { code: 'E_NOT_POSSIBLE', phase: 'validating', level: 4, passed: false, applicable: true } });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(source, before);
});

test('filename normalization rejects path and header injection instead of silently making a different filename', () => {
  for (const name of ['', '.', '..', '../original.docx', 'directory/original.docx', 'directory\\original.docx',
    'original.docx\r\nX-Injected: true', 'original\0.docx']) assert.throws(() => originalFilename(name));
  for (const name of ['研究.docx', 'Informe 📄.pdf']) assert.equal(originalFilename(name), name);
});
