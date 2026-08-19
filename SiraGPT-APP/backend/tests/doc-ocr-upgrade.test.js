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

// ── image-analyzer: clasificación + teselas (OCR profesional) ───────────────

const imageAnalyzer = require('../src/services/image-analyzer');
const ocrEngine = require('../src/services/ocr-engine');

function fakeStats(over = {}) {
  return {
    width: 1920, height: 1080, megapixels: 2.07, aspect: 1920 / 1080,
    luminance: 230, saturationSpread: 5, entropy: 4,
    whiteBackground: true, darkBackground: false, grayscaleish: true,
    ...over,
  };
}

test('classifyImage: texto denso, escaneo, foto, recibo, captura', () => {
  // Muro de texto denso (como un dump de sistema renderizado)
  const dense = imageAnalyzer.classifyImage(fakeStats({ width: 6000, height: 4000, megapixels: 24 }), { usefulChars: 40_000 });
  assert.equal(dense.type, 'text_dense');
  // Documento escaneado normal
  const scan = imageAnalyzer.classifyImage(fakeStats({ megapixels: 8, width: 2480, height: 3508, aspect: 2480 / 3508 }), { usefulChars: 3000 });
  assert.equal(scan.type, 'document_scan');
  // Fotografía: colorida, alta entropía, sin texto
  const photo = imageAnalyzer.classifyImage(
    fakeStats({ whiteBackground: false, grayscaleish: false, saturationSpread: 60, entropy: 7.5, luminance: 120, aspect: 1.5 }),
    { usefulChars: 10 },
  );
  assert.equal(photo.type, 'photo');
  // Ticket: estrecho y alto, fondo blanco
  const receipt = imageAnalyzer.classifyImage(fakeStats({ width: 600, height: 2400, aspect: 0.25, megapixels: 1.44 }), { usefulChars: 400 });
  assert.equal(receipt.type, 'receipt');
  // Captura oscura 16:9 con texto
  const shot = imageAnalyzer.classifyImage(
    fakeStats({ whiteBackground: false, darkBackground: true, luminance: 40, megapixels: 2 }),
    { usefulChars: 500 },
  );
  assert.equal(shot.type, 'screenshot');
  // Sin stats → unknown sin crash
  assert.equal(imageAnalyzer.classifyImage(null, {}).type, 'unknown');
});

test('normalizeVisionType mapea respuestas libres del modelo', () => {
  assert.equal(imageAnalyzer.normalizeVisionType('Captura de pantalla'), 'screenshot');
  assert.equal(imageAnalyzer.normalizeVisionType('texto denso'), 'text_dense');
  assert.equal(imageAnalyzer.normalizeVisionType('documento escaneado'), 'document_scan');
  assert.equal(imageAnalyzer.normalizeVisionType('gráfico o diagrama'), 'chart_diagram');
  assert.equal(imageAnalyzer.normalizeVisionType('ticket o recibo'), 'receipt');
  assert.equal(imageAnalyzer.normalizeVisionType('otro'), null);
  assert.equal(imageAnalyzer.normalizeVisionType(''), null);
});

test('planTiles: cobertura completa, solape, respeta maxTiles', () => {
  const cfg = { ...imageAnalyzer.tilingConfig(), targetTile: 2200, maxTiles: 9, overlap: 0.06 };
  const tiles = imageAnalyzer.planTiles(6000, 4400, cfg);
  assert.ok(tiles.length >= 4 && tiles.length <= 9, `tiles=${tiles.length}`);
  // Cobertura: cada tesela dentro de límites y la última llega al borde
  for (const t of tiles) {
    assert.ok(t.left >= 0 && t.top >= 0);
    assert.ok(t.left + t.width <= 6000 && t.top + t.height <= 4400);
  }
  const maxRight = Math.max(...tiles.map(t => t.left + t.width));
  const maxBottom = Math.max(...tiles.map(t => t.top + t.height));
  assert.equal(maxRight, 6000);
  assert.equal(maxBottom, 4400);
  // Solape entre columnas consecutivas de la misma fila
  const row0 = tiles.filter(t => t.row === 0).sort((a, b) => a.col - b.col);
  if (row0.length > 1) assert.ok(row0[1].left < row0[0].left + row0[0].width, 'sin solape horizontal');
  // Imagen pequeña → 1 sola tesela
  assert.equal(imageAnalyzer.planTiles(800, 600, cfg).length, 1);
});

test('shouldTileOcr: solo imágenes grandes, débiles o muy densas', () => {
  const cfg = { ...imageAnalyzer.tilingConfig(), enabled: true, triggerSide: 3000, triggerChars: 1500 };
  const big = fakeStats({ width: 6000, height: 4000 });
  const small = fakeStats({ width: 1920, height: 1080 });
  const weak = { accepted: false, usefulChars: 50 };
  const strongSparse = { accepted: true, usefulChars: 200 };
  const strongDense = { accepted: true, usefulChars: 9000 };
  assert.equal(imageAnalyzer.shouldTileOcr(big, weak, cfg), true);
  assert.equal(imageAnalyzer.shouldTileOcr(big, strongDense, cfg), true);
  assert.equal(imageAnalyzer.shouldTileOcr(big, strongSparse, cfg), false);
  assert.equal(imageAnalyzer.shouldTileOcr(small, weak, cfg), false);
  assert.equal(imageAnalyzer.shouldTileOcr(null, weak, cfg), false);
  assert.equal(imageAnalyzer.shouldTileOcr(big, weak, { ...cfg, enabled: false }), false);
});

test('computeImageStats lee un PNG real generado con sharp', async () => {
  const sharpLib = require('sharp');
  const buf = await sharpLib({ create: { width: 400, height: 300, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
  const stats = await imageAnalyzer.computeImageStats(buf);
  assert.equal(stats.width, 400);
  assert.equal(stats.height, 300);
  assert.ok(stats.whiteBackground, `luminance=${stats.luminance}`);
  assert.ok(stats.grayscaleish);
  // Entrada corrupta → null, sin throw
  assert.equal(await imageAnalyzer.computeImageStats(Buffer.from('no soy imagen')), null);
});

test('_withImageMeta adjunta ocr.image y respeta el veredicto de visión', () => {
  const base = { text: 'hola', ocr: { status: 'local_ok', usefulChars: 40_000, lineCount: 100, confidence: 90 } };
  const out = ocrEngine._withImageMeta(base, fakeStats({ width: 6000, height: 4000, megapixels: 24 }), { tiled: 6 });
  assert.equal(out.ocr.image.type, 'text_dense');
  assert.equal(out.ocr.image.tiledOcr, 6);
  assert.equal(out.ocr.image.width, 6000);
  // visionType gana sobre la heurística
  const vis = { text: 'hola', ocr: { status: 'vision_fallback', usefulChars: 50, visionType: 'fotografía' } };
  const out2 = ocrEngine._withImageMeta(vis, fakeStats(), { tiled: 0 });
  assert.equal(out2.ocr.image.type, 'photo');
  assert.equal(out2.ocr.image.typeConfidence, 0.9);
  assert.equal(out2.ocr.image.tiledOcr, null);
  // Sin stats ni visionType → sin metadata, sin crash
  const out3 = ocrEngine._withImageMeta({ text: 'x', ocr: { status: 'local_ok' } }, null, {});
  assert.equal(out3.ocr.image, undefined);
});
