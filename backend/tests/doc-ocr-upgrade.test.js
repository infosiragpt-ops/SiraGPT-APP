/**
 * Tests for the document-analysis OCR upgrade:
 *   - mixed-pdf helpers (pure): low-text page detection + merge in page order
 *   - office-image-extractor: zip listing caps + OCR appendix (fake engine)
 *   - fileProcessor._withEmbeddedImageText: best-effort, never throws
 *
 * All offline — no network, no tesseract, no vision calls.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const PizZip = require('pizzip');

const mixedPdf = require('../src/services/document/mixed-pdf');
const officeImages = require('../src/services/office-image-extractor');
const fileProcessor = require('../src/services/fileProcessor');

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makePage(page, text) {
  return { page, text };
}

// ── mixed-pdf: findLowTextPages ─────────────────────────────────────────────

test('findLowTextPages flags empty and near-empty pages only', () => {
  const pages = [
    makePage(1, 'Página con un texto perfectamente normal y suficientemente largo.'),
    makePage(2, ''),
    makePage(3, '   \n  '),
    makePage(4, 'ok'), // below the 25-char default
    makePage(5, 'Otra página con texto real que supera el umbral mínimo.'),
  ];
  assert.deepEqual(mixedPdf.findLowTextPages(pages), [2, 3, 4]);
});

test('isMixedPdf: true only when SOME pages lack text (not all, not none)', () => {
  const textPage = makePage(1, 'Contenido normal de una página con su capa de texto completa.');
  const emptyPage = makePage(2, '');
  assert.equal(mixedPdf.isMixedPdf([textPage, emptyPage]), true);
  assert.equal(mixedPdf.isMixedPdf([textPage, { ...textPage, page: 2 }]), false);
  assert.equal(mixedPdf.isMixedPdf([emptyPage, { ...emptyPage, page: 3 }]), false);
  assert.equal(mixedPdf.isMixedPdf([]), false);
});

test('mixed-pdf env knobs: min chars, enable flag, page cap', async () => {
  await withEnv({
    SIRAGPT_PDF_PAGE_MIN_CHARS: '5',
    SIRAGPT_PDF_MIXED_OCR: '0',
    SIRAGPT_PDF_MIXED_OCR_MAX_PAGES: '7',
  }, () => {
    assert.equal(mixedPdf.minPageChars(), 5);
    assert.equal(mixedPdf.mixedOcrEnabled(), false);
    assert.equal(mixedPdf.mixedOcrMaxPages(), 7);
    // With minChars=5, 'ok' (2 chars) is low-text but 'hello!' is not.
    assert.deepEqual(mixedPdf.findLowTextPages([makePage(1, 'ok'), makePage(2, 'hello!')]), [1]);
  });
  assert.equal(mixedPdf.mixedOcrEnabled(), true); // default on
});

// ── mixed-pdf: mergeMixedPdfText ────────────────────────────────────────────

test('mergeMixedPdfText interleaves text-layer and OCR pages in page order', () => {
  const pages = [
    makePage(1, 'Texto de la primera página, extraído de la capa de texto.'),
    makePage(2, ''),
    makePage(3, 'Texto de la tercera página, también de la capa de texto.'),
    makePage(4, ''),
  ];
  const ocrPages = [
    { page: 2, text: 'TEXTO RECUPERADO POR OCR DE LA PÁGINA DOS' },
    { page: 4, text: 'TEXTO RECUPERADO POR OCR DE LA PÁGINA CUATRO' },
  ];
  const { text, ocrPagesUsed } = mixedPdf.mergeMixedPdfText(pages, ocrPages);
  assert.equal(ocrPagesUsed, 2);
  const idx1 = text.indexOf('[page 1]');
  const idx2 = text.indexOf('[page 2 — OCR]');
  const idx3 = text.indexOf('[page 3]');
  const idx4 = text.indexOf('[page 4 — OCR]');
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2 && idx4 > idx3, `orden incorrecto: ${[idx1, idx2, idx3, idx4]}`);
  assert.ok(text.includes('PÁGINA DOS'));
  assert.ok(text.includes('PÁGINA CUATRO'));
});

test('mergeMixedPdfText omits true blanks but keeps sub-threshold crumbs', () => {
  const pages = [
    makePage(1, 'Página normal con contenido suficiente para pasar el umbral.'),
    makePage(2, ''), // blank, no OCR result → omitted
    makePage(3, 'ok'), // crumbs, no OCR result → kept as-is
  ];
  const { text, ocrPagesUsed } = mixedPdf.mergeMixedPdfText(pages, []);
  assert.equal(ocrPagesUsed, 0);
  assert.ok(!text.includes('[page 2'));
  assert.ok(text.includes('[page 3]'));
  assert.ok(text.includes('ok'));
});

test('mergeMixedPdfText ignores OCR entries with empty text', () => {
  const pages = [makePage(1, 'Texto normal de página uno con longitud suficiente.'), makePage(2, '')];
  const { text, ocrPagesUsed } = mixedPdf.mergeMixedPdfText(pages, [{ page: 2, text: '   ' }]);
  assert.equal(ocrPagesUsed, 0);
  assert.ok(!text.includes('[page 2'));
});

// ── office-image-extractor ──────────────────────────────────────────────────

function fakePngBuffer(bytes) {
  const buf = Buffer.alloc(bytes, 0xab);
  // PNG magic so nothing downstream chokes on pure garbage.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

async function makeDocxLikeZip(entries) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document/>');
  for (const [name, buffer] of Object.entries(entries)) {
    zip.file(name, buffer);
  }
  const out = zip.generate({ type: 'nodebuffer' });
  const filePath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'ocr-test-')), 'doc.docx');
  await fsp.writeFile(filePath, out);
  return filePath;
}

test('listEmbeddedImages finds word/media images, skips tiny + non-media entries', async () => {
  const filePath = await makeDocxLikeZip({
    'word/media/image1.png': fakePngBuffer(10_000),
    'word/media/image2.jpg': fakePngBuffer(20_000),
    'word/media/icon.png': fakePngBuffer(500), // below minBytes → skipped
    'word/media/chart1.emf': fakePngBuffer(10_000), // unsupported ext → not listed
    'word/other/image9.png': fakePngBuffer(10_000), // outside media/ → not listed
  });
  const { images, total, skipped } = await officeImages.listEmbeddedImages(filePath);
  assert.equal(total, 3); // image1, image2, icon (media + supported ext)
  assert.equal(skipped, 1); // icon (too small)
  assert.deepEqual(images.map(i => i.name), ['image1.png', 'image2.jpg']);
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[1].mimeType, 'image/jpeg');
});

test('listEmbeddedImages respects maxImages cap with natural ordering', async () => {
  const entries = {};
  for (let i = 1; i <= 15; i++) entries[`ppt/media/image${i}.png`] = fakePngBuffer(8_000);
  const filePath = await makeDocxLikeZip(entries);
  await withEnv({ SIRAGPT_OFFICE_IMAGE_MAX: '3' }, async () => {
    const { images, skipped } = await officeImages.listEmbeddedImages(filePath);
    assert.equal(images.length, 3);
    // Natural sort: image1, image2, image3 (NOT image1, image10, image11)
    assert.deepEqual(images.map(i => i.name), ['image1.png', 'image2.png', 'image3.png']);
    assert.equal(skipped, 12);
  });
});

test('listEmbeddedImages returns empty listing for corrupt/non-zip files', async () => {
  const filePath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'ocr-test-')), 'broken.docx');
  await fsp.writeFile(filePath, Buffer.from('this is not a zip at all'));
  const out = await officeImages.listEmbeddedImages(filePath);
  assert.deepEqual(out, { images: [], total: 0, skipped: 0 });
});

test('extractImagesText runs the injected engine per image and captures failures', async () => {
  const filePath = await makeDocxLikeZip({
    'word/media/image1.png': fakePngBuffer(8_000),
    'word/media/image2.png': fakePngBuffer(8_000),
  });
  let calls = 0;
  const fakeEngine = {
    extractFromImage: async (buffer, opts) => {
      calls += 1;
      assert.ok(Buffer.isBuffer(buffer));
      assert.equal(opts.mimeType, 'image/png');
      if (calls === 2) throw new Error('boom');
      return { text: 'FACTURA Nº 001 — Total 1.234,56 €', ocr: { status: 'local_ok', confidence: 93 } };
    },
  };
  const { results } = await officeImages.extractImagesText(filePath, { ocrEngine: fakeEngine });
  assert.equal(results.length, 2);
  assert.equal(results[0].text.includes('FACTURA'), true);
  assert.equal(results[1].text, '');
  assert.equal(results[1].ocr.status, 'failed');
});

test('buildImageAppendix formats numbered blocks and is empty without text', () => {
  const appendix = officeImages.buildImageAppendix({
    results: [
      { name: 'image1.png', text: 'Texto de la primera imagen' },
      { name: 'image2.png', text: '' },
      { name: 'image3.png', text: 'Texto de la tercera' },
    ],
    total: 5,
  });
  assert.ok(appendix.includes('2 imagen(es)'));
  assert.ok(appendix.includes('(de 5 imágenes en el documento)'));
  assert.ok(appendix.includes('[Imagen 1 — image1.png]'));
  assert.ok(appendix.includes('[Imagen 2 — image3.png]'));
  assert.equal(officeImages.buildImageAppendix({ results: [{ name: 'a.png', text: ' ' }] }), '');
  assert.equal(officeImages.buildImageAppendix({}), '');
});

test('extractImageAppendix honours the SIRAGPT_OFFICE_IMAGE_OCR=0 kill switch', async () => {
  const filePath = await makeDocxLikeZip({ 'word/media/image1.png': fakePngBuffer(8_000) });
  await withEnv({ SIRAGPT_OFFICE_IMAGE_OCR: '0' }, async () => {
    const out = await officeImages.extractImageAppendix(filePath, {
      ocrEngine: { extractFromImage: async () => { throw new Error('should not be called'); } },
    });
    assert.equal(out, '');
  });
});

// ── fileProcessor._withEmbeddedImageText ────────────────────────────────────

test('_withEmbeddedImageText never throws and returns base text on failure', async () => {
  const out = await fileProcessor._withEmbeddedImageText('/nonexistent/path.docx', 'BASE TEXT', 'docx');
  assert.equal(out, 'BASE TEXT');
});

// ── vision fallback default flip ────────────────────────────────────────────

test('_shouldApplyVisionFallback is ON by default when a key exists (opt-out with 0)', async () => {
  const weak = { text: 'short', ocr: { confidence: 0.95 } };
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: undefined, OPENAI_API_KEY: 'sk-test' }, () => {
    assert.equal(fileProcessor._shouldApplyVisionFallback(weak, {}), true);
  });
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: '0', OPENAI_API_KEY: 'sk-test' }, () => {
    assert.equal(fileProcessor._shouldApplyVisionFallback(weak, {}), false);
  });
  await withEnv({ SIRAGPT_VISION_FALLBACK_ENABLED: undefined, OPENAI_API_KEY: undefined }, () => {
    assert.equal(fileProcessor._shouldApplyVisionFallback(weak, {}), false);
  });
});
