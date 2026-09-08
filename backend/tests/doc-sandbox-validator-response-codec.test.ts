import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decodeValidatorResponse } from '../src/modules/doc-sandbox/validation/response-codec';
import { DocumentValidationError } from '../src/modules/doc-sandbox/validation/errors';

// Protocol parsing only: call the decoder with data, never substitute Docker,
// validator output or a document gate. Decoding does not attest document validity.
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown): boolean => error instanceof DocumentValidationError && error.code === expected;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6HAAAAABJRU5ErkJggg==', 'base64');
const diff = Buffer.from('{"changes":[]}', 'utf8');
const failedReport = (artifactFiles: string[], artifactData: Record<string, string>) => ({ ok: true, report: {
  schemaVersion: 1, passed: false, originalSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64),
  levels: [{ level: 1, passed: false, applicable: true, details: { reason: 'parser-test-only' }, durationMs: 0 }],
  artifactFiles, artifactData, changes: [],
} });
const one = (encoded: string) => failedReport(['text-diff.json'], { 'text-diff.json': encoded });
function paddedJson(size: number): Buffer {
  const bytes = Buffer.alloc(size, 0x20); bytes.write('{}'); return bytes;
}

test('report decoding preserves bytes, hashes, filename order and descriptor kinds without asserting validation success', () => {
  const names = ['after-2.png', 'before-notes-1.png', 'text-diff.json', 'before-1.png', 'after-notes-1.png'];
  const data = Object.fromEntries(names.map(name => [name, (name.endsWith('.png') ? png : diff).toString('base64')]));
  data['unused-private-value'] = Buffer.from('not requested').toString('base64');
  const input = failedReport(names, data); const original = structuredClone(input);
  const decoded = decodeValidatorResponse(input);
  assert.deepEqual(decoded.artifacts.map(({ name, kind, mime }) => ({ name, kind, mime })), [
    { name: 'after-2.png', kind: 'thumbnail_after', mime: 'image/png' },
    { name: 'before-notes-1.png', kind: 'thumbnail_before', mime: 'image/png' },
    { name: 'text-diff.json', kind: 'text_diff', mime: 'application/json' },
    { name: 'before-1.png', kind: 'thumbnail_before', mime: 'image/png' },
    { name: 'after-notes-1.png', kind: 'thumbnail_after', mime: 'image/png' },
  ]);
  for (const artifact of decoded.artifacts) {
    const bytes = artifact.name.endsWith('.png') ? png : diff;
    assert.deepEqual(artifact.data, bytes); assert.equal(artifact.sha256, hash(bytes));
  }
  assert.deepEqual(input, original);
  assert.equal('report' in decoded.response && decoded.response.report.passed, false);
  assert.equal('report' in decoded.response && decoded.response.report.levels[0]!.passed, false);
});

test('all unexpected artifact paths are rejected, not normalized into a different file', () => {
  for (const name of ['../before-1.png', '/before-1.png', 'folder/before-1.png', 'before-1.png\n',
    'before-x.png', 'before-1.PNG', 'before-1.svg', 'text-diff.json/child', 'report.json', 'after-notes-1.png?x']) {
    assert.throws(() => decodeValidatorResponse(failedReport([name], { [name]: png.toString('base64') })), code('ARTIFACT_PATH'));
  }
});

test('base64 must be present, bounded, canonical and strict rather than Node forgiving decoding', () => {
  assert.throws(() => decodeValidatorResponse(failedReport(['before-1.png'], {})), code('ARTIFACT_UNSAFE'));
  for (const encoded of ['', 'Zg', 'Zg=', 'Zg===', ' Zg==', 'Zg==\n', 'Zg-_', '=Zg=', 'Zh==', 'Zm9=']) {
    assert.throws(() => decodeValidatorResponse(one(encoded)), code('ARTIFACT_UNSAFE'));
  }
  const tooLong = paddedJson(18 * 1024 * 1024 + 3).toString('base64');
  assert.throws(() => decodeValidatorResponse(one(tooLong)), code('ARTIFACT_UNSAFE'));
});

test('per-artifact budget accepts exactly 10 MiB but excludes one extra decoded byte', () => {
  const limit = 10 * 1024 * 1024;
  const bytes = paddedJson(limit); const result = decodeValidatorResponse(one(bytes.toString('base64')));
  assert.deepEqual(result.artifacts[0]!.data, bytes); assert.equal(result.artifacts[0]!.sha256, hash(bytes));
  assert.throws(() => decodeValidatorResponse(one(paddedJson(limit + 1).toString('base64'))), code('ARTIFACT_LIMIT'));
});

test('aggregate budget is 16 MiB across artifacts, including repeated use of the same encoded payload', () => {
  const half = paddedJson(8 * 1024 * 1024).toString('base64');
  const names = ['before-1.png', 'after-1.png'];
  // Bytes test transport budgets only; these payloads are not asserted valid images.
  const exact = decodeValidatorResponse(failedReport(names, { 'before-1.png': half, 'after-1.png': half }));
  assert.equal(exact.artifacts.reduce((sum, artifact) => sum + artifact.data.length, 0), 16 * 1024 * 1024);
  assert.throws(() => decodeValidatorResponse(failedReport([...names, 'text-diff.json'], {
    'before-1.png': half, 'after-1.png': half, 'text-diff.json': Buffer.from('0').toString('base64'),
  })), code('ARTIFACT_LIMIT'));
});

test('artifact count accepts 1001 bounded entries and rejects 1002 before attempting payload decoding', () => {
  const names = Array.from({ length: 1001 }, (_, i) => `before-${i}.png`);
  const data = Object.fromEntries(names.map(name => [name, png.toString('base64')]));
  assert.equal(decodeValidatorResponse(failedReport(names, data)).artifacts.length, 1001);
  assert.throws(() => decodeValidatorResponse(failedReport([...names, 'after-0.png'], {})), code('ARTIFACT_LIMIT'));
  assert.deepEqual(decodeValidatorResponse(failedReport([], {})).artifacts, []);
});

test('protocol errors retain the validator code and message while malformed envelopes fail schema validation', () => {
  assert.throws(() => decodeValidatorResponse({ ok: false, error: { code: 'ZIP_BOMB', message: 'Presupuesto excedido' } }),
    (error: unknown) => error instanceof DocumentValidationError && error.code === 'ZIP_BOMB' && error.message === 'Presupuesto excedido');
  for (const input of [null, {}, { ok: false }, { ok: 'true', inventories: [] }, { ok: true, report: {} },
    { ok: false, error: { code: 42, message: 'bad' } }]) assert.throws(() => decodeValidatorResponse(input), z.ZodError);
});

test('inventory, recipe and preflight protocol variants decode without creating artifacts or conferring a validation result', () => {
  const digest = hash(diff);
  const inventory = { id: 'input-1', format: 'json', sha256: digest, size: diff.length, name: 'data.json', mime: 'application/json',
    parts: { content: digest }, units: [{ part: 'content', locator: '/changes', text: '[]', kind: 'value' }],
    warnings: [], partOrder: ['content'], pages: 1, encoding: 'utf-8' };
  const recipe = { sha256: digest, size: diff.length, expandedBytes: 0, scripts: ['edit.py'], parts: { 'edit.py': digest } };
  const preflight = { schemaVersion: 1, inputSha256: digest, applications: { writer: digest, calc: digest, impress: digest } };
  for (const input of [{ ok: true, inventories: [inventory] }, { ok: true, recipe }, { ok: true, preflight }]) {
    assert.deepEqual(decodeValidatorResponse(input), { response: input, artifacts: [] });
  }
  assert.throws(() => decodeValidatorResponse({ ok: true, inventories: [{ ...inventory, sha256: 'invalid' }] }), z.ZodError);
  assert.throws(() => decodeValidatorResponse({ ok: true, recipe: { ...recipe, scripts: [] } }), z.ZodError);
  assert.throws(() => decodeValidatorResponse({ ok: true, preflight: { ...preflight, bypass: true } }), z.ZodError);
  assert.throws(() => decodeValidatorResponse({ ok: true, preflight: { ...preflight, applications: { ...preflight.applications, extra: digest } } }), z.ZodError);
});

test('report schema refuses unsupported levels, negative timing and nonstring artifact bodies', () => {
  const source = failedReport([], {});
  for (const level of [{ ...source.report.levels[0], level: 5 }, { ...source.report.levels[0], durationMs: -1 }]) {
    assert.throws(() => decodeValidatorResponse({ ...source, report: { ...source.report, levels: [level] } }), z.ZodError);
  }
  assert.throws(() => decodeValidatorResponse({ ...source, report: { ...source.report, artifactData: { 'text-diff.json': null } } }), z.ZodError);
});
