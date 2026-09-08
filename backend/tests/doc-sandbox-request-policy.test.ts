import assert from 'node:assert/strict';
import { test } from 'node:test';
import multer from 'multer';
import { z } from 'zod';
import { documentApiError, documentArtifactForDownload, documentDownloadHeaders, documentPayloadHash,
  documentRequestOwner, documentRequestPlan, parseDocumentAdmission, parseDocumentEventCursor,
  parseDocumentIdempotencyKey, prepareDocumentInputs } from '../src/modules/doc-sandbox/api/request-policy';
import { DocumentRepositoryError, type StoredArtifact } from '../src/modules/doc-sandbox/queue/repository';
import { DocSandboxError } from '../src/modules/doc-sandbox/types/errors';

// Real schemas, crypto and error classes; no HTTP/database/storage/validator substitute.
const code = (expected: string, status = 400) => (error: unknown): boolean =>
  error instanceof DocSandboxError && error.code === expected && error.status === status;
const pdf = (name: string, content = '%PDF-1.7\nfixture') => ({ originalname: name, buffer: Buffer.from(content) });

test('admission preserves selected model and applies defaults without allowing read-only edits', () => {
  assert.deepEqual(parseDocumentAdmission({ instructions: '  Corrige una fecha.\n' }), {
    instructions: 'Corrige una fecha.', mode: 'preserve', modelTier: 'mechanical', permission: 'default',
  });
  for (const permission of ['default', 'workspace', 'full']) {
    assert.deepEqual(parseDocumentAdmission({ instructions: 'Revisar', modelTier: 'academic', requestedModel: ' selected-model ', permission }), {
      instructions: 'Revisar', mode: 'preserve', modelTier: 'academic', requestedModel: 'selected-model', permission,
    });
  }
  for (const permission of ['read', 'protected']) assert.throws(() => parseDocumentAdmission({ instructions: 'Editar', permission }), code('E_PLAN_GATE', 403));
  for (const input of [null, {}, { instructions: ' ' }, { instructions: 'x'.repeat(50_001) }, { instructions: 'Editar', mode: 'rewrite' },
    { instructions: 'Editar', modelTier: 'cheap' }, { instructions: 'Editar', permission: 'admin' }, { instructions: 'Editar', requestedModel: '' },
    { instructions: 'Editar', requestedModel: 'x'.repeat(201) }, { instructions: 'Editar', disableValidation: true }]) assert.throws(() => parseDocumentAdmission(input), z.ZodError);
  assert.equal(parseDocumentAdmission({ instructions: 'x'.repeat(50_000), requestedModel: 'm'.repeat(200) }).instructions.length, 50_000);
});

test('multipart admission preserves bytes and Unicode names but generates independent input identities', () => {
  const bytes = Buffer.from('%PDF-1.7\nfixture'); const name = 'Información.pdf';
  const file = { originalname: Buffer.from(name).toString('latin1'), buffer: bytes };
  const first = prepareDocumentInputs([file])[0]!; const second = prepareDocumentInputs([file])[0]!;
  assert.equal(first.name, name); assert.equal(first.format, 'pdf'); assert.equal(first.mime, 'application/pdf'); assert.equal(first.data, bytes);
  assert.equal(first.sha256, 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224');
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id); assert.equal(first.sha256, second.sha256);
  assert.equal(file.buffer, bytes); assert.equal(file.originalname, Buffer.from(name).toString('latin1'));
});

test('multiple uploads require PDFs without weakening filename or signature admission', () => {
  assert.deepEqual(prepareDocumentInputs([pdf('a.pdf'), pdf('b.PDF')]).map((input) => input.name), ['a.pdf', 'b.PDF']);
  for (const files of [undefined, [], { 'files[]': [pdf('a.pdf')] }]) assert.throws(() => prepareDocumentInputs(files), code('E_PARAMS'));
  for (const files of [[pdf('a.txt'), pdf('b.txt')], [pdf('a.pdf'), pdf('b.txt')]]) assert.throws(() => prepareDocumentInputs(files), code('E_PARAMS'));
  assert.equal(prepareDocumentInputs([{ originalname: 'a.txt', buffer: Buffer.from('text') }])[0]!.format, 'txt');
  assert.throws(() => prepareDocumentInputs([pdf('a.pdf', 'not a PDF')]), code('E_PARAMS', 415));
  assert.throws(() => prepareDocumentInputs([pdf('../a.pdf')]), z.ZodError);
});

test('idempotency binds normalized instructions, selection, permission, document bytes, names and order, not random ids', () => {
  const params = parseDocumentAdmission({ instructions: ' Corrige. ' });
  const inputs = prepareDocumentInputs([pdf('a.pdf'), pdf('b.pdf', '%PDF-1.7\ndifferent')]); const hash = documentPayloadHash(params, inputs);
  assert.equal(documentPayloadHash(parseDocumentAdmission({ instructions: 'Corrige.', mode: 'preserve', modelTier: 'mechanical', permission: 'default' }), inputs), hash);
  assert.equal(documentPayloadHash(params, inputs.map((input) => ({ ...input, id: 'independent-attempt-id' }))), hash);
  const changes = [documentPayloadHash({ ...params, instructions: 'Otro cambio' }, inputs),
    documentPayloadHash({ ...params, requestedModel: 'explicit-model' }, inputs), documentPayloadHash({ ...params, permission: 'workspace' }, inputs),
    documentPayloadHash({ ...params, modelTier: 'academic' }, inputs), documentPayloadHash(params, [...inputs].reverse()),
    documentPayloadHash(params, prepareDocumentInputs([pdf('renamed.pdf'), pdf('b.pdf', '%PDF-1.7\ndifferent')])),
    documentPayloadHash(params, prepareDocumentInputs([pdf('a.pdf', '%PDF-1.7\nchanged'), pdf('b.pdf', '%PDF-1.7\ndifferent')]))];
  for (const changed of changes) assert.notEqual(changed, hash);
});

test('identity comes from authenticated user data, never body/route owner claims; malformed plans default to FREE', () => {
  assert.equal(documentRequestOwner({ user: { id: 'actual-user', plan: 'PRO' }, body: { userId: 'other' }, params: { userId: 'other' } }), 'actual-user');
  for (const request of [null, {}, { body: { userId: 'owner' } }, { user: null }, { user: { id: '' } }, { user: { id: 123 } }, { user: { id: '../other' } }]) {
    assert.throws(() => documentRequestOwner(request), code('E_FORBIDDEN', 401));
  }
  assert.equal(documentRequestPlan({ user: { plan: 'PRO' } }), 'PRO');
  for (const request of [undefined, {}, { user: { plan: 1 } }, { user: {} }, { user: { plan: '' } }]) assert.equal(documentRequestPlan(request), 'FREE');
});

test('idempotency keys retain caller identity while excluding path, controls and injection', () => {
  for (const key of ['key', 'v1:a-b_c.d', 'x'.repeat(200)]) assert.equal(parseDocumentIdempotencyKey(key), key);
  for (const key of [undefined, [], {}, '', 'x'.repeat(201), ' a', 'a ', 'a/b', 'a\nb', 'a?x=1']) assert.throws(() => parseDocumentIdempotencyKey(key), z.ZodError);
});

const artifact: StoredArtifact = { id: 'artifact-1', jobId: 'job-1', attempt: 1, published: true, purgedAt: null,
  kind: 'output', storageKey: 'private-storage-key', filename: 'résumé (v1)*.docx', mime: 'application/custom', size: 123, sha256: 'a'.repeat(64) };
test('download selection requires membership in the already-authorized result, never a storage key', () => {
  assert.equal(documentArtifactForDownload([artifact], artifact.id), artifact);
  for (const id of ['other', artifact.storageKey, ` ${artifact.id}`]) assert.throws(() => documentArtifactForDownload([artifact], id), code('E_NOT_FOUND', 404));
  assert.throws(() => documentArtifactForDownload([], artifact.id), code('E_NOT_FOUND', 404));
});

test('download headers force a sandboxed attachment with safe UTF-8 filename and observed byte length', () => {
  assert.deepEqual(documentDownloadHeaders("résumé (v1)*'!.docx", 321), {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename=\"document\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28v1%29%2A%27!.docx",
    'Content-Length': '321', 'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  assert.equal(documentDownloadHeaders('empty.txt', 0)['Content-Length'], '0');
  for (const name of ['a\r\nX-Injected: yes.docx', '../secret.txt', '/private.txt']) assert.throws(() => documentDownloadHeaders(name, 321), z.ZodError);
});

test('SSE cursor honors header precedence and excludes fractional, negative, nonfinite and unsafe sequences', () => {
  assert.equal(parseDocumentEventCursor(undefined, undefined), 0); assert.equal(parseDocumentEventCursor(undefined, '5'), 5);
  assert.equal(parseDocumentEventCursor('0', '8'), 0); assert.equal(parseDocumentEventCursor(String(Number.MAX_SAFE_INTEGER), null), Number.MAX_SAFE_INTEGER);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1), 'garbage']) assert.throws(() => parseDocumentEventCursor(value, '0'), code('E_PARAMS'));
  assert.throws(() => parseDocumentEventCursor(undefined, { after: '3' }), code('E_PARAMS'));
});

test('API errors map durable failures without publishing private details', () => {
  const expected: Array<[ConstructorParameters<typeof DocumentRepositoryError>[0], string, number]> = [
    ['DOC_BUDGET_EXCEEDED', 'E_QUOTA', 429], ['DOC_FORBIDDEN', 'E_FORBIDDEN', 403], ['DOC_NOT_FOUND', 'E_NOT_FOUND', 404],
    ['DOC_DELETED', 'E_NOT_FOUND', 404], ['DOC_EXPIRED', 'E_NOT_FOUND', 404], ['DOC_CONFLICT', 'E_CONFLICT', 409],
    ['DOC_STALE_LEASE', 'E_CONFLICT', 409], ['DOC_INVALID_TRANSITION', 'E_CONFLICT', 409], ['DOC_VALIDATION_GATE', 'E_CONFLICT', 409],
    ['DOC_INVALID_INPUT', 'E_CONFLICT', 409], ['DOC_CLEANUP_PENDING', 'E_CONFLICT', 409]];
  for (const [input, output, status] of expected) {
    const result = documentApiError(new DocumentRepositoryError(input)); assert.equal(result.code, output); assert.equal(result.status, status); assert.equal(result.message.includes('DOC_'), false);
  }
  const schemaError = z.string().safeParse({ private: 'document material' }); assert.equal(schemaError.success, false);
  if (!schemaError.success) assert.equal(documentApiError(schemaError.error).code, 'E_PARAMS');
  const multipartError = documentApiError(new multer.MulterError('LIMIT_FILE_SIZE', 'private-file-name'));
  assert.equal(multipartError.code, 'E_PARAMS'); assert.equal(multipartError.status, 400);
  const known = new DocSandboxError('E_CANCELLED', 499); assert.deepEqual(documentApiError(known), { code: known.code, status: known.status, message: known.message });
  const unknown = documentApiError(new Error('private database details')); assert.equal(unknown.status, 500); assert.equal(unknown.code, 'E_PROVIDER');
  assert.equal(JSON.stringify(unknown).includes('private'), false);
});
