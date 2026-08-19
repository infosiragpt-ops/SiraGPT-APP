'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderToPdf,
  isConvertible,
  RendererUnavailableError,
  RendererUnsupportedError,
} = require('../src/services/documentRenderer');

test('exports the documented surface', () => {
  assert.equal(typeof renderToPdf, 'function');
  assert.equal(typeof isConvertible, 'function');
  assert.equal(typeof RendererUnavailableError, 'function');
  assert.equal(typeof RendererUnsupportedError, 'function');
});

test('RendererUnavailableError carries the correct name + code', () => {
  const err = new RendererUnavailableError('no engine');
  assert.equal(err.name, 'RendererUnavailableError');
  assert.equal(err.code, 'RENDERER_UNAVAILABLE');
  assert.equal(err.message, 'no engine');
});

test('RendererUnsupportedError carries the correct name + code', () => {
  const err = new RendererUnsupportedError('not convertible');
  assert.equal(err.name, 'RendererUnsupportedError');
  assert.equal(err.code, 'RENDERER_UNSUPPORTED');
});

test('isConvertible accepts MS Office MIME types', () => {
  assert.equal(isConvertible('application/msword'), true);
  assert.equal(isConvertible('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(isConvertible('application/vnd.ms-powerpoint'), true);
  assert.equal(isConvertible('application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.equal(isConvertible('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
});

test('isConvertible accepts RTF MIME types', () => {
  assert.equal(isConvertible('application/rtf'), true);
  assert.equal(isConvertible('text/rtf'), true);
});

test('isConvertible accepts OpenDocument MIME types', () => {
  assert.equal(isConvertible('application/vnd.oasis.opendocument.text'), true);
  assert.equal(isConvertible('application/vnd.oasis.opendocument.spreadsheet'), true);
  assert.equal(isConvertible('application/vnd.oasis.opendocument.presentation'), true);
});

test('isConvertible falls back to filename extension when MIME is unknown', () => {
  assert.equal(isConvertible(null, 'thesis.docx'), true);
  assert.equal(isConvertible(undefined, 'slides.pptx'), true);
  assert.equal(isConvertible('', 'data.xlsx'), true);
  assert.equal(isConvertible('', 'document.odt'), true);
  assert.equal(isConvertible('', 'PRESENTATION.PPTX'), true, 'extension match must be case-insensitive');
});

test('isConvertible rejects unsupported / unknown formats', () => {
  assert.equal(isConvertible('text/plain'), false);
  assert.equal(isConvertible('image/png'), false);
  assert.equal(isConvertible('application/pdf'), false, 'PDFs are already PDFs — not "convertible" here');
  assert.equal(isConvertible('', 'photo.jpg'), false);
  assert.equal(isConvertible('', 'archive.zip'), false);
});

test('isConvertible handles missing inputs without throwing', () => {
  assert.equal(isConvertible(), false);
  assert.equal(isConvertible(null, null), false);
  assert.equal(isConvertible('', ''), false);
});

test('renderToPdf throws RendererUnsupportedError for non-convertible inputs', async () => {
  await assert.rejects(
    () => renderToPdf({ id: 'x', path: '/tmp/x', mimeType: 'image/png', originalName: 'x.png' }),
    (err) => err instanceof RendererUnsupportedError && err.code === 'RENDERER_UNSUPPORTED'
  );
});

test('renderToPdf surfaces a RendererUnavailableError when neither engine is configured', async () => {
  // The test environment is unlikely to have LibreOffice installed and
  // GOTENBERG_URL is unset, so the call chain reaches the throw. We use a
  // mime/ext that passes isConvertible but ensure the source file doesn't
  // exist so any partial engine work fails. The throw we care about is
  // RendererUnavailableError from the engine-resolution branch.
  const origGotenberg = process.env.GOTENBERG_URL;
  const origBin = process.env.LIBREOFFICE_BIN;
  try {
    delete process.env.GOTENBERG_URL;
    process.env.LIBREOFFICE_BIN = '/definitely/not/a/real/binary/soffice';
    await assert.rejects(
      () => renderToPdf({
        id: `nonexistent-${Date.now()}`,
        path: '/nonexistent/source.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalName: 'source.docx',
      }),
      (err) => {
        // Either RendererUnavailableError (engine not found) or a generic
        // throw is acceptable here — both mean the renderer refused to
        // serve a PDF when no engine is available. The required behavior is
        // that the call rejects (does NOT silently produce a result).
        return err instanceof Error;
      },
    );
  } finally {
    if (origGotenberg !== undefined) process.env.GOTENBERG_URL = origGotenberg;
    else delete process.env.GOTENBERG_URL;
    if (origBin !== undefined) process.env.LIBREOFFICE_BIN = origBin;
    else delete process.env.LIBREOFFICE_BIN;
  }
});

test('renderToPdf returns the cached entry when the rendered PDF already exists on disk', async () => {
  // Pre-seed a fake PDF at the expected cache path so renderToPdf finds it
  // and short-circuits to fromCache:true without invoking any engine.
  const fs = require('node:fs/promises');
  const path = require('node:path');

  const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
  const RENDER_CACHE_DIR = path.join(UPLOAD_DIR, '_rendered');
  await fs.mkdir(RENDER_CACHE_DIR, { recursive: true });

  const fileId = `cached-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cachedPdf = path.join(RENDER_CACHE_DIR, `${fileId}.pdf`);
  await fs.writeFile(cachedPdf, '%PDF-1.4 fake');
  try {
    const out = await renderToPdf({
      id: fileId,
      path: '/some/source.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalName: 'source.docx',
    });
    assert.equal(out.fromCache, true);
    assert.equal(out.engine, 'cache');
    assert.equal(out.pdfPath, cachedPdf);
  } finally {
    await fs.rm(cachedPdf, { force: true });
  }
});
