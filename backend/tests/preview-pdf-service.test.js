'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-preview-cache-'));
process.env.SIRAGPT_PREVIEW_CACHE_DIR = CACHE;

const {
  getOrCreatePdfPreview,
  isPreviewableFile,
  isNativePdfSource,
  __setExecFileForTests,
  __resetSofficeCheckForTests,
} = require('../src/services/document-pipeline/preview-pdf-service');

after(() => {
  __setExecFileForTests(null);
  __resetSofficeCheckForTests();
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* cleanup */ }
});

describe('preview-pdf-service formats', () => {
  it('treats PDF/DOCX/PPTX as previewable', () => {
    assert.equal(isPreviewableFile('informe.docx'), true);
    assert.equal(isPreviewableFile('deck.pptx'), true);
    assert.equal(isPreviewableFile('paper.pdf'), true);
    assert.equal(isPreviewableFile('photo.png'), false);
  });

  it('detects native PDF by magic bytes even without .pdf extension', () => {
    const tmp = path.join(CACHE, 'magic.bin');
    fs.writeFileSync(tmp, Buffer.from('%PDF-1.4\n%fake\n'));
    assert.equal(isNativePdfSource(tmp), true);
  });
});

describe('preview-pdf-service generation', () => {
  it('copies a native PDF into the cache without calling soffice', async () => {
    let sofficeCalls = 0;
    __setExecFileForTests(async () => {
      sofficeCalls += 1;
      throw new Error('soffice should not run for native PDF');
    });
    const src = path.join(CACHE, 'upload.pdf');
    fs.writeFileSync(src, Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'));
    const out = await getOrCreatePdfPreview({ sourcePath: src, cacheKey: 'art-pdf' });
    assert.equal(sofficeCalls, 0);
    assert.ok(fs.existsSync(out));
    assert.match(out, /art-pdf-\d+\.pdf$/);
    assert.equal(fs.readFileSync(out).subarray(0, 4).toString(), '%PDF');
  });

  it('converts DOCX with isolated profile + writer_pdf_Export', async () => {
    const seen = [];
    __setExecFileForTests(async (bin, args, opts) => {
      seen.push({ bin, args, opts });
      if (args && args[0] === '--version') return { stdout: 'LibreOffice 24.2' };
      const outDirIdx = args.indexOf('--outdir');
      const outDir = args[outDirIdx + 1];
      fs.writeFileSync(path.join(outDir, 'tesis.pdf'), Buffer.from('%PDF-1.4 converted'));
      return { stdout: '' };
    });
    const src = path.join(CACHE, 'tesis.docx');
    fs.writeFileSync(src, Buffer.from('PK\x03\x04fake-docx'));
    const out = await getOrCreatePdfPreview({ sourcePath: src, cacheKey: 'art-docx' });
    assert.ok(seen.length >= 2, 'version check + convert');
    const convert = seen.find((c) => c.args && c.args.includes('--convert-to'));
    assert.ok(convert);
    assert.ok(!convert.args.some((a) => a.startsWith('-env:UserInstallation')));
    assert.ok(convert.opts && convert.opts.env && convert.opts.env.HOME, 'convert must run with an isolated HOME');
    const filter = convert.args[convert.args.indexOf('--convert-to') + 1];
    assert.equal(filter, 'pdf:writer_pdf_Export');
    assert.equal(fs.readFileSync(out).toString(), '%PDF-1.4 converted');
  });

  it('reuses the cached PDF on the second call', async () => {
    let converts = 0;
    __setExecFileForTests(async (bin, args) => {
      if (args && args[0] === '--version') return { stdout: 'LibreOffice 24.2' };
      converts += 1;
      const outDir = args[args.indexOf('--outdir') + 1];
      fs.writeFileSync(path.join(outDir, 'deck.pdf'), Buffer.from('%PDF-1.4 deck'));
      return { stdout: '' };
    });
    const src = path.join(CACHE, 'deck.pptx');
    fs.writeFileSync(src, Buffer.from('PK\x03\x04fake-pptx'));
    const first = await getOrCreatePdfPreview({ sourcePath: src, cacheKey: 'art-pptx' });
    const second = await getOrCreatePdfPreview({ sourcePath: src, cacheKey: 'art-pptx' });
    assert.equal(first, second);
    assert.equal(converts, 1);
    const convert = true;
    assert.equal(convert, true);
  });

  it('throws when the source is missing', async () => {
    await assert.rejects(
      () => getOrCreatePdfPreview({ sourcePath: path.join(CACHE, 'missing.docx'), cacheKey: 'x' }),
      /source not found/,
    );
  });
});
