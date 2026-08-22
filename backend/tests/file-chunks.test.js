'use strict';

// Proof for the chunked ("paginated") large-document editor backend:
//   1. The server-side split module is byte-exact (join === original) and
//      respects target/max sizes, including giant paragraphs and \r\n input.
//   2. GET /api/files/:id/chunks serves pages of the ACTIVE version with
//      ownership checks, clamped params, and the documented response shape.
//   3. GET /api/files/:id/meta lets the client pick single-doc vs chunked
//      mode WITHOUT downloading the body.
// The route test mounts the REAL files router; only Prisma I/O and the auth
// session lookup are replaced with deterministic in-memory boundaries (same
// pattern as document-background-edit-http-integration.test.js).

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');
const prisma = require('../src/config/database');
const chunksService = require('../src/services/document-chunks');

const { chunkByParagraphs, joinChunks, shouldUseChunkedMode } = chunksService;

// ── Pure split module ────────────────────────────────────────────────────

describe('document-chunks service', () => {
  test('round-trips a paragraphed document EXACTLY', () => {
    const doc = 'Intro\n\nSegundo párrafo\n\n\n\nTercero con\nsaltos internos\n\nFinal';
    const chunks = chunkByParagraphs(doc, 32, 64);
    assert.equal(joinChunks(chunks), doc);
    assert.equal(chunks[0].index, 0);
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  });

  test('never exceeds max size, even on giant paragraphs', () => {
    const giant = 'X'.repeat(50_000);
    const doc = `small\n\ngap\n\n${giant}\n\ntail`;
    const chunks = chunkByParagraphs(doc, 1024, 4096);
    for (const chunk of chunks) {
      assert.ok(chunk.content.length <= 4096, `chunk too big: ${chunk.content.length}`);
    }
    assert.equal(joinChunks(chunks), doc);
  });

  test('hard-slices a single line bigger than max without losing chars', () => {
    const doc = 'A'.repeat(10_000);
    const chunks = chunkByParagraphs(doc, 1024, 2048);
    assert.ok(chunks.length >= 4);
    assert.equal(joinChunks(chunks), doc);
    for (const chunk of chunks) {
      if (chunk.index < chunks.length - 1) assert.equal(chunk.content.length, 2048);
    }
  });

  test('respects the target size when paragraphs are small', () => {
    const doc = Array.from({ length: 2000 }, (_, i) => `párrafo ${i} con contenido suficiente`).join('\n\n');
    const target = 8 * 1024;
    const chunks = chunkByParagraphs(doc, target, 12 * 1024);
    assert.equal(joinChunks(chunks), doc);
    // Every closed chunk (all but possibly the last) reaches ~target.
    for (const chunk of chunks.slice(0, -1)) {
      assert.ok(chunk.content.length >= target / 2, `undersized closed chunk: ${chunk.content.length}`);
    }
  });

  test('keeps CRLF sequences intact across the split', () => {
    const doc = 'uno\r\n\r\ndos\r\n\r\ntres';
    const chunks = chunkByParagraphs(doc, 5, 7);
    assert.equal(joinChunks(chunks), doc);
  });

  test('empty input yields zero chunks', () => {
    assert.deepEqual(chunkByParagraphs(''), []);
    assert.equal(joinChunks([]), '');
  });

  test('threshold: only >=8MB documents enter chunked mode', () => {
    assert.equal(shouldUseChunkedMode(0), false);
    assert.equal(shouldUseChunkedMode(8 * 1024 * 1024 - 1), false);
    assert.equal(shouldUseChunkedMode(8 * 1024 * 1024), true);
    assert.equal(shouldUseChunkedMode(NaN), false);
  });
});

// ── HTTP route proof (real router, mocked boundaries) ────────────────────

describe('GET /api/files/:id/chunks + /meta', () => {
  let auth;
  const files = new Map();
  const versions = [];
  let fileCounter = 0;
  let versionCounter = 0;
  const restores = [];

  const patch = (target, key, replacement) => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => { target[key] = original; });
  };

  const matches = (row, where = {}) => {
    if (where.id && typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.userId && String(row.userId) !== String(where.userId)) return false;
    if (where.fileId && String(row.fileId) !== String(where.fileId)) return false;
    if (where.validationPassed !== undefined && row.validationPassed !== where.validationPassed) return false;
    return true;
  };

  beforeEach(() => {
    auth = installAuthSessionMock();
    files.clear();
    versions.length = 0;

    patch(prisma.file, 'findFirst', async ({ where = {} } = {}) => {
      const row = Array.from(files.values()).find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    });
    patch(prisma.fileVersion, 'findFirst', async ({ where = {}, orderBy } = {}) => {
      let found = versions.filter((row) => matches(row, where));
      if (orderBy?.version === 'desc') found = found.sort((a, b) => b.version - a.version);
      return found[0] ? { ...found[0] } : null;
    });
  });

  afterEach(() => {
    while (restores.length) restores.pop()();
    auth.restore();
  });

  function seedFile({ extractedText, versionContent }) {
    fileCounter += 1;
    const row = {
      id: `file-${fileCounter}`,
      userId: auth.user.id,
      extractedText: extractedText ?? null,
    };
    files.set(row.id, row);
    if (versionContent) {
      versionCounter += 1;
      versions.push({
        id: `version-${versionCounter}`,
        fileId: row.id,
        userId: auth.user.id,
        version: versionCounter,
        validationPassed: true,
        content: versionContent,
      });
    }
    return row;
  }

  function buildApp() {
    return buildRouteTestApp('/api/files', reloadModule('../src/routes/files'));
  }

  async function fetchAllPages(app, fileId, { pageSize = 64 * 1024, headers } = {}) {
    const pages = [];
    let index = 0;
    for (;;) {
      const res = await request(app)
        .get(`/api/files/${fileId}/chunks`)
        .query({ index, size: pageSize })
        .set('Authorization', headers ?? auth.authHeader);
      assert.equal(res.status, 200);
      pages.push(res.body);
      if (res.body.nextIndex === null || res.body.nextIndex === undefined) break;
      index = res.body.nextIndex;
    }
    return pages;
  }

  test('serves an 8MB+ document page by page with exact reassembly', async () => {
    // Build a >8MB markdown document deterministically (~500+ pages).
    const paragraph = 'Párrafo de prueba con texto suficiente para llenar páginas. '.repeat(2);
    const parts = [];
    let total = 0;
    // Keep appending paragraphs until the JOINED document clears 8MB.
    // Track the real per-part length (paragraph + '#' + index) plus the
    // 2-char '\n\n' separator the final join adds between parts.
    while (total <= 8 * 1024 * 1024) {
      const part = `${paragraph}#${parts.length}`;
      parts.push(part);
      total += part.length + 2;
    }
    const doc = parts.join('\n\n');
    assert.ok(doc.length > 8 * 1024 * 1024, `doc too small: ${doc.length}`);

    const seeded = seedFile({ extractedText: doc });
    const app = buildApp();

    // Meta first — mode decision without the body.
    const metaRes = await request(app)
      .get(`/api/files/${seeded.id}/meta`)
      .set('Authorization', auth.authHeader);
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.body.chunkedMode, true);
    assert.equal(metaRes.body.contentChars, doc.length);
    assert.ok(metaRes.body.totalChunks === undefined); // meta carries estimates only

    const pages = await fetchAllPages(app, seeded.id, { pageSize: 64 * 1024 });
    assert.ok(pages.length > 100, `expected many pages, got ${pages.length}`);

    // Contract shape on every page.
    for (const [position, body] of pages.entries()) {
      assert.equal(body.index, position);
      assert.equal(typeof body.content, 'string');
      assert.ok(body.content.length <= 96 * 1024, 'page exceeds hard max');
      assert.equal(body.totalChunks, pages.length);
      assert.equal(body.nextIndex, position + 1 < pages.length ? position + 1 : null);
    }
    // Last page signals the end.
    assert.equal(pages[pages.length - 1].nextIndex, null);

    // EXACT reassembly.
    const rebuilt = pages.map((p) => p.content).join('');
    assert.equal(rebuilt, doc);

    // Out-of-range index → 416 with the total.
    const beyond = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: pages.length + 5 })
      .set('Authorization', auth.authHeader);
    assert.equal(beyond.status, 416);
    assert.equal(beyond.body.totalChunks, pages.length);
  });

  test('prefers the newest manual-edit version over the original text', async () => {
    const seeded = seedFile({
      extractedText: 'ORIGINAL\n\n'.repeat(2000),
      versionContent: 'EDITADO\n\n'.repeat(2000),
    });
    const app = buildApp();
    const res = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: 0 })
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'version');
    assert.ok(res.body.content.startsWith('EDITADO'));
    // Meta agrees on the active source.
    const metaRes = await request(app)
      .get(`/api/files/${seeded.id}/meta`)
      .set('Authorization', auth.authHeader);
    assert.equal(metaRes.body.source, 'version');
    assert.equal(metaRes.body.versionId, `version-1`);
  });

  test('falls back to original extracted text when no version exists', async () => {
    const seeded = seedFile({ extractedText: 'SOLO ORIGINAL' });
    const app = buildApp();
    const res = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: 0 })
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'original');
    assert.equal(res.body.versionId, null);
    assert.equal(res.body.totalChunks, 1);
  });

  test('small documents report chunkedMode=false in meta', async () => {
    const seeded = seedFile({ extractedText: 'documento pequeño' });
    const app = buildApp();
    const metaRes = await request(app)
      .get(`/api/files/${seeded.id}/meta`)
      .set('Authorization', auth.authHeader);
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.body.chunkedMode, false);
    assert.ok(metaRes.body.threshold >= 8 * 1024 * 1024);
  });

  test('enforces ownership and rejects unknown files', async () => {
    const seeded = seedFile({ extractedText: 'contenido privado' });
    const app = buildApp();

    const noAuth = await request(app).get(`/api/files/${seeded.id}/chunks`).query({ index: 0 });
    assert.equal(noAuth.status, 401);

    const foreign = await request(app)
      .get('/api/files/file-of-someone-else/chunks')
      .query({ index: 0 })
      .set('Authorization', auth.authHeader);
    assert.equal(foreign.status, 404);

    const foreignMeta = await request(app)
      .get('/api/files/file-of-someone-else/meta')
      .set('Authorization', auth.authHeader);
    assert.equal(foreignMeta.status, 404);
  });

  test('clamps absurd query params instead of crashing', async () => {
    const seeded = seedFile({ extractedText: 'texto' });
    const app = buildApp();
    const badSize = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: 0, size: 'not-a-number' })
      .set('Authorization', auth.authHeader);
    assert.equal(badSize.status, 200);
    assert.equal(badSize.body.size, 64 * 1024); // fallback default applied

    const hugeSize = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: 0, size: 99999999 })
      .set('Authorization', auth.authHeader);
    assert.equal(hugeSize.status, 200);
    assert.ok(hugeSize.body.size <= 262144);
  });

  test('404 when the owned file has no editable text at all', async () => {
    const seeded = seedFile({ extractedText: '' });
    const app = buildApp();
    const res = await request(app)
      .get(`/api/files/${seeded.id}/chunks`)
      .query({ index: 0 })
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 404);
  });
});
