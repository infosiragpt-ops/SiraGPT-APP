'use strict';

// Scanned and mixed PDFs (C8 · G6b): every weak page goes through the full
// OCR ladder (Tesseract with a page budget → vision ladder), the document
// has a wall-clock budget, weak or unreadable pages are marked instead of
// silently dropped, and text layers made of stamps / page numbers / broken
// glyphs still get OCR. All offline: pdf-to-img, Tesseract and the vision
// ladder are fakes; page images are tiny in-memory PNGs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const engine = require('../src/services/ocr-engine');
const realOcrInput = require('../src/services/ocr-input');
const mixedPdf = require('../src/services/document/mixed-pdf');
const extractFastpath = require('../src/services/document-extract-fastpath');
const { toPdfJsData } = require('../src/utils/pdf-js-input');

function override(t, target, props) {
  const saved = {};
  for (const [key, value] of Object.entries(props)) {
    saved[key] = Object.prototype.hasOwnProperty.call(target, key) ? { own: true, value: target[key] } : { own: false };
    target[key] = value;
  }
  t.after(() => {
    for (const [key, entry] of Object.entries(saved)) {
      if (entry.own) target[key] = entry.value;
      else delete target[key];
    }
  });
}

function quiet(t) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => { console.log = log; console.warn = warn; });
}

function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Page k is a white PNG whose aspect ratio encodes k (variants keep the
// ratio). It carries a block of «ink» unless it is a blank page (the back of
// a duplex scan), which the engine never sends to a vision rung.
async function pagePng(k, { blank = false } = {}) {
  const base = sharp({ create: { width: 100 + k * 40, height: 200, channels: 3, background: 'white' } });
  if (blank) return base.png().toBuffer();
  const ink = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'black' } }).png().toBuffer();
  return base.composite([{ input: ink, left: 20, top: 30 }]).png().toBuffer();
}

async function pageOf(img) {
  const meta = await sharp(img).metadata();
  return Math.round(((meta.width / meta.height) * 200 - 100) / 40);
}

function fakePdf(buffers) {
  return {
    length: buffers.length,
    async getPage(n) { return buffers[n - 1]; },
    async* [Symbol.asyncIterator]() { for (const b of buffers) yield b; },
  };
}

/** Fake Tesseract: reads[k] = { text, confidence } | 'hang'. */
function fakeWorkerFactory(reads) {
  const created = [];
  const create = async () => {
    const worker = {
      terminated: false,
      async setParameters() {},
      async recognize(img) {
        const k = await pageOf(img);
        const read = reads[k];
        if (read === 'hang') return new Promise(() => {});
        return { data: read || { text: '', confidence: 0 } };
      },
      async terminate() { worker.terminated = true; },
    };
    created.push(worker);
    return worker;
  };
  return { create, created };
}

const GLM_ON = { isEnabled: () => true, config: () => ({ model: 'glm-ocr' }), ensureAvailable: async () => ({ available: true }), recognize: async () => ({ ok: false, reason: 'not_used' }) };

const CLEAN = 'Contrato de arrendamiento celebrado entre las partes para el local comercial ubicado en Lima.';
const GARBAGE = 'xq zvrr ttk qq wpl zz xxr kkq vvb zqx prr wwk';

async function setupPdf(t, { pages = 4, reads, vision, env = {}, blankPages = [] } = {}) {
  quiet(t);
  // Small renders and one variant keep the fake pages fast; the page budget
  // is lowered only by the tests that make Tesseract hang.
  withEnv(t, { SIRAGPT_OCR_PDF_PAGE_BUDGET_MS: '8000', OCR_PDF_MAX_SIDE: '300', OCR_PDF_MAX_VARIANTS: '1', ...env });
  const buffers = [];
  for (let k = 1; k <= pages; k += 1) buffers.push(await pagePng(k, { blank: blankPages.includes(k) }));
  const workers = fakeWorkerFactory(reads);
  const visionCalls = [];
  override(t, engine, {
    _openPdf: async () => fakePdf(buffers),
    createOcrWorker: workers.create,
    ocrInput: { ...realOcrInput, detectOrientation: async () => ({ ok: false }) },
    // The local GLM rung is switched on (as in production); the ladder
    // itself is faked below.
    ollamaOcr: GLM_ON,
    runVisionFallback: async (args) => {
      const k = Number((/Página (\d+)/.exec(args.promptPrefix) || [])[1]);
      visionCalls.push({ page: k, args });
      const out = vision ? await vision(k, args) : null;
      if (out && out.text) {
        return { text: out.text, ocr: { status: 'vision_fallback', provider: out.provider || 'gemini:gemini-3.5-flash', engines: out.engines, confidence: out.confidence || 80, confidenceLevel: out.level || 'media' } };
      }
      return { text: '', ocr: { status: 'failed', reason: (out && out.reason) || 'vision_fallback_failed' } };
    },
  });
  return { buffers, workers, visionCalls };
}

// ── Streaming scanned PDF: full ladder per page ───────────────────────────

test('every weak scanned page goes through the vision ladder; weak and unreadable pages are marked, never dropped', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    reads: {
      1: { text: CLEAN, confidence: 93 },
      2: { text: GARBAGE, confidence: 45 },
      3: { text: 'Acta de la sesión ordinaria del concejo municipal número ocho', confidence: 52 },
      4: { text: '', confidence: 0 },
    },
    vision: (k) => (k === 2 ? { text: 'Página dos leída por visión con su contenido completo.', engines: ['gemini:gemini-3.5-flash', 'ollama:glm-ocr'] } : null),
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.deepEqual(visionCalls.map((c) => c.page), [2, 3, 4], 'the accepted page never reaches vision');
  assert.equal(visionCalls[0].args.promptPrefix, 'Página 2 de 4.');
  assert.ok(Number.isFinite(visionCalls[0].args.deadlineAt));
  assert.equal(res.ocr.status, 'vision_fallback');
  assert.match(res.text, /\[page 1\]\nContrato de arrendamiento/);
  assert.match(res.text, /\[page 2\]\nPágina dos leída por visión/);
  assert.doesNotMatch(res.text, /xq zvrr/, 'garbage rescued by vision is not stored');
  assert.match(res.text, /\[page 3\]\n\[página 3 — lectura poco fiable \(Tesseract \(local\), confianza 52 %\): verifícala con el original\]\nActa de la sesión/);
  assert.match(res.text, /\[page 4\]\n\[página 4 — no legible: sin texto legible\]/);
  assert.equal(res.ocr.pagesWithText, 3);
  assert.deepEqual(res.ocr.unreadPages, [4]);
  assert.equal(res.ocr.visionPages, 1);
  assert.match(res.ocr.provider, /tesseract/);
  assert.match(res.ocr.provider, /gemini/);
  assert.equal(res.ocr.pageQuality[1].provider, 'gemini:gemini-3.5-flash');
  assert.equal(res.ocr.pageQuality[2].lowConfidence, true);
});

test('a page that hangs Tesseract is cut at the page budget; the next page gets a fresh worker', async (t) => {
  const { workers, visionCalls } = await setupPdf(t, {
    pages: 2,
    env: { SIRAGPT_OCR_PDF_PAGE_BUDGET_MS: '1000' },
    reads: { 1: 'hang', 2: { text: CLEAN, confidence: 95 } },
    vision: (k) => (k === 1 ? { text: 'Primera página leída por visión tras el corte.' } : null),
  });
  const started = Date.now();
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.ok(Date.now() - started < 8000);
  assert.equal(workers.created.length, 2, 'a fresh worker after the terminated one');
  assert.equal(workers.created[0].terminated, true);
  assert.deepEqual(visionCalls.map((c) => c.page), [1]);
  assert.match(res.text, /\[page 1\]\nPrimera página leída por visión/);
  assert.match(res.text, /\[page 2\]\nContrato/);
});

test('the document budget stops the read and marks the pages left, keeping every page already read', async (t) => {
  await setupPdf(t, {
    pages: 3,
    env: { SIRAGPT_OCR_PDF_PAGE_BUDGET_MS: '5000' },
    reads: { 1: { text: CLEAN, confidence: 94 }, 2: 'hang', 3: { text: CLEAN, confidence: 94 } },
  });
  // Page 2 hangs until the document deadline: page 3 is never started.
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf', { budgetMs: 1200, allowVision: false });
  assert.equal(res.ocr.partial, true);
  assert.equal(res.ocr.partialReason, 'budget');
  assert.match(res.text, /\[page 1\]\nContrato/);
  assert.match(res.text, /\[página 2 — no legible: tiempo agotado\]/);
  assert.match(res.text, /\[página 3 sin OCR: tiempo agotado\]/);
});

test('Tesseract unavailable: the pages go to the vision ladder instead of failing the whole PDF', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 2,
    reads: {},
    vision: (k) => ({ text: `Texto de la página ${k} leído por el modelo de visión.` }),
  });
  override(t, engine, {
    createOcrWorker: async () => { const e = new Error('tesseract_unavailable'); e.code = 'tesseract_unavailable'; throw e; },
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.deepEqual(visionCalls.map((c) => c.page), [1, 2]);
  assert.equal(res.ocr.pagesWithText, 2);
  assert.equal(res.ocr.tesseract, 'tesseract_unavailable');
});

test('the vision page cap bounds paid calls; capped pages keep their marked local read', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 3,
    reads: { 1: { text: GARBAGE, confidence: 30 }, 2: { text: 'Informe técnico de la obra en ejecución del segundo piso', confidence: 50 }, 3: { text: '', confidence: 0 } },
    vision: () => ({ text: 'Leído por visión con contenido suficiente para la página.' }),
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf', { visionMaxPages: 1 });
  assert.deepEqual(visionCalls.map((c) => c.page), [1]);
  assert.equal(res.ocr.pageQuality[1].visionReason, 'vision_page_cap');
  assert.match(res.text, /\[página 2 — lectura poco fiable/);
  // No capable engine read page 3: the marker says so instead of «no legible».
  assert.match(res.text, /\[page 3\]\n\[página 3 — sin OCR completo: límite de páginas con visión\]/);
  assert.equal(res.ocr.pageQuality[2].reason, 'vision_page_cap');
});

test('nothing readable anywhere: a typed failure with per-page reasons (no fabricated text)', async (t) => {
  await setupPdf(t, { pages: 2, reads: {}, vision: () => null });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.equal(res.ocr.status, 'failed');
  assert.equal(res.ocr.reason, 'local_pdf_ocr_empty');
  assert.equal(res.text, '');
  assert.deepEqual(res.ocr.unreadPages, [1, 2]);
});

test('mixed-PDF subset: each page runs the ladder; pages past the budget come back as «budget»', async (t) => {
  await setupPdf(t, {
    pages: 3,
    env: { SIRAGPT_OCR_PDF_PAGE_BUDGET_MS: '6000' },
    reads: { 1: { text: GARBAGE, confidence: 40 }, 2: 'hang', 3: { text: CLEAN, confidence: 95 } },
    vision: (k) => (k === 1 ? { text: 'Anexo escaneado leído por el modelo de visión, completo.' } : null),
  });
  // 4.5 s: enough for page 1's vision call after reserving Tesseract time
  // (≥ 0.5 s per page) for the two pages still to come.
  const res = await engine.extractPdfPagesSubset('/fake.pdf', [1, 2, 3], { budgetMs: 4500 });
  const byPage = Object.fromEntries(res.pages.map((p) => [p.page, p]));
  assert.match(byPage[1].text, /Anexo escaneado/);
  assert.equal(byPage[3].reason, 'budget');
  assert.equal(res.ocr.budgetHit, true);
});

// ── Text-layer quality (mixed-pdf) ────────────────────────────────────────

test('stamp-only or page-number-only text layers are scanned documents', () => {
  const numbers = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: `Página ${i + 1} de 10` }));
  assert.equal(mixedPdf.planTextLayerOcr(numbers).kind, 'scanned');
  const stamps = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: 'Escaneado con CamScanner - 03/10/2026' }));
  const plan = mixedPdf.planTextLayerOcr(stamps);
  assert.equal(plan.kind, 'scanned');
  assert.equal(plan.counts.stampOnly, 10);
  // A real document with a repeated header is NOT stamp-only.
  const real = Array.from({ length: 4 }, (_, i) => ({ page: i + 1, text: `Universidad Privada del Norte\nPágina ${i + 1}\n${CLEAN} Sección ${i + 1} con su propio desarrollo y conclusiones.` }));
  assert.equal(mixedPdf.planTextLayerOcr(real).kind, 'text');
});

test('broken text layers are garbled: (cid:NN), U+FFFD, private-use glyphs, mojibake — numeric tables are not', () => {
  assert.ok(mixedPdf.scoreTextLayerPage('(cid:12)(cid:13)(cid:14)(cid:15) (cid:16)(cid:17)(cid:18) hola').reasons.includes('cid_glyphs'));
  assert.ok(mixedPdf.scoreTextLayerPage('Contr�to de arr�ndamiento �� entre p�rtes').reasons.includes('replacement_chars'));
  assert.ok(mixedPdf.scoreTextLayerPage('  texto').reasons.includes('private_use_glyphs'));
  assert.ok(mixedPdf.scoreTextLayerPage('ConstituciÃ³n polÃ­tica del PerÃº, artÃ­culo 2: toda persona').reasons.includes('mojibake'));
  const table = 'Balance 2025\n1.234,56  2.345,67  3.456,78\n4.567,89  5.678,90  6.789,01\n'.repeat(5);
  assert.equal(mixedPdf.scoreTextLayerPage(table).garbled, false);
  assert.equal(mixedPdf.scoreTextLayerPage(CLEAN).garbled, false);
  const mixed = mixedPdf.planTextLayerOcr([
    { page: 1, text: CLEAN },
    { page: 2, text: '(cid:12)(cid:13)(cid:14)(cid:15)(cid:16)(cid:17) (cid:18)(cid:19)(cid:20)' },
    { page: 3, text: '' },
  ]);
  assert.equal(mixed.kind, 'mixed');
  assert.deepEqual(mixed.ocrPages, [2, 3]);
  assert.deepEqual(mixed.reasons, { 2: 'garbled', 3: 'short' });
  assert.equal(mixedPdf.isStampOnlyText('Escaneado con CamScanner\n\nEscaneado con CamScanner\n\nEscaneado con CamScanner', 3), true);
  assert.equal(mixedPdf.isStampOnlyText(`${CLEAN}\n${CLEAN}`, 2), false);
});

test('merge: planned pages take their OCR; nothing unread disappears; the legacy merge is unchanged', () => {
  const pages = [
    { page: 1, text: CLEAN },
    { page: 2, text: '(cid:1)(cid:2)(cid:3)(cid:4)(cid:5)(cid:6)(cid:7)(cid:8)(cid:9)' },
    { page: 3, text: '' },
    { page: 4, text: '' },
  ];
  const ocrPages = [
    { page: 2, text: 'Texto real de la página dos', confidence: 55, lowConfidence: true },
    { page: 3, text: '', reason: 'too_little_text' },
  ];
  const merged = mixedPdf.mergeMixedPdfText(pages, ocrPages, 25, { ocrTargets: [2, 3, 4], reasons: { 2: 'garbled' }, markUnread: true });
  assert.match(merged.text, /\[page 2 — OCR\]\n\[página 2 — lectura poco fiable \(confianza 55 %\)/);
  assert.match(merged.text, /\[page 3\]\n\[página 3 — no legible: sin texto legible\]/);
  assert.match(merged.text, /\[page 4\]\n\[página 4 sin OCR: límite\]/);
  assert.deepEqual(merged.unreadPages, [3, 4]);
  const keptLayer = mixedPdf.mergeMixedPdfText(pages.slice(0, 2), [], 25, { ocrTargets: [2], reasons: { 2: 'garbled' }, markUnread: true });
  assert.match(keptLayer.text, /la capa de texto parece dañada/);
  const legacy = mixedPdf.mergeMixedPdfText([{ page: 1, text: CLEAN }, { page: 2, text: '' }], []);
  assert.ok(!legacy.text.includes('[page 2'));
});

test('pdftotext reports the text-layer plan', async (t) => {
  extractFastpath.__setExecFileForTests(async () => ({ stdout: ['Página 1 de 3', 'Página 2 de 3', 'Página 3 de 3'].join('\f') }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  const res = await extractFastpath.tryPdftotext('/fake.pdf');
  assert.equal(res.used, true);
  assert.equal(res.textLayer.kind, 'scanned');
});

// ── fileProcessor.processPDF ──────────────────────────────────────────────

function tmpPdf(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scan.pdf');
  fs.writeFileSync(file, '%PDF-1.4 fake');
  return file;
}

// A real PDF with one text item per entry (Helvetica, Latin-1; '' is an
// empty text item, which pdf.js turns into a blank line inside the page).
// `pad` lengthens the header comment. Without it the file is small, which
// is the case that needs toPdfJsData (see the Buffer-pool test below).
function textItemsPdf(pages, pad = 0) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const pageIds = [];
  for (const items of pages) {
    const content = items.map((it) => `BT /F1 10 Tf 50 ${it.y} Td (${esc(it.text)}) Tj ET`).join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    objects.push(null);
    pageIds.push(objects.length);
  }
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const treeId = objects.length;
  for (const id of pageIds) {
    objects[id - 1] = `<< /Type /Page /Parent ${treeId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 1 0 R >> >> /Contents ${id - 1} 0 R >>`;
  }
  objects.push(`<< /Type /Catalog /Pages ${treeId} 0 R >>`);
  let out = `%PDF-1.4\n%${'0'.repeat(pad)}\n`;
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('processPDF (pdf-parse fallback): a blank line inside a scan page is no page boundary; certificates keep their layer', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  const streamingPdf = require('../src/services/document/streaming-pdf');
  extractFastpath.__setExecFileForTests(async () => { const err = new Error('spawn pdftotext ENOENT'); err.code = 'ENOENT'; throw err; });
  t.after(() => extractFastpath.__setExecFileForTests(null));
  override(t, streamingPdf, { extractPdfStreaming: async () => { throw new Error('streaming unavailable'); } });
  let ocrCalls = 0;
  override(t, engine, {
    extractFromPdfImages: async () => {
      ocrCalls += 1;
      return { text: '[page 1]\nTexto leído por OCR', ocr: { status: 'local_ok', pages: 4, pagesWithText: 1, confidence: 90, provider: 'tesseract' } };
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pdf-parse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return file;
  };
  // A 4-page scan with a stamp at the top and the bottom of every page;
  // page 2 also carries a signature and a seal with an empty text item
  // between them.
  const scanPage = (split) => [
    { y: 800, text: 'Escaneado con CamScanner' },
    ...(split ? [{ y: 400, text: 'Firma Juan Pérez' }, { y: 380, text: '' }, { y: 360, text: 'Sello notarial' }] : []),
    { y: 30, text: 'www.camscanner.com' },
  ];
  const scan = textItemsPdf([1, 2, 3, 4].map((i) => scanPage(i === 2)));
  const parsed = await fileProcessor.parsePdfWithPages(scan);
  assert.equal(parsed.data.text, (await require('pdf-parse')(toPdfJsData(scan))).text, 'the joined text is pdf-parse\'s own');
  assert.deepEqual(parsed.pages, [
    'Escaneado con CamScanner\nwww.camscanner.com',
    'Escaneado con CamScanner\nFirma Juan Pérez\n\nSello notarial\nwww.camscanner.com',
    'Escaneado con CamScanner\nwww.camscanner.com',
    'Escaneado con CamScanner\nwww.camscanner.com',
  ]);
  const out = await fileProcessor.processPDF(write('scan.pdf', scan), { detailed: true });
  assert.equal(ocrCalls, 1);
  assert.match(out.extractedText, /Texto leído por OCR/);
  assert.notEqual(out.ocr.provider, 'pdf_text_layer');
  // Mail-merge certificates with an empty text item inside every page: the
  // per-page texts show one name per page, so the layer is kept.
  const names = ['María Pérez López', 'José Quispe Mamani', 'Ana Torres Ruiz', 'Luis Chávez Rojas', 'Rosa Huamán Díaz', 'Iván Salazar Peña'];
  const certs = textItemsPdf(names.map((name) => [
    { y: 700, text: 'CERTIFICADO DE PARTICIPACIÓN' },
    { y: 680, text: '' },
    { y: 660, text: 'Se otorga el presente certificado a' },
    { y: 640, text: name },
    { y: 620, text: 'por haber participado en el Taller de Redacción' },
    { y: 600, text: 'Lima, 15 de octubre de 2026' },
  ]));
  ocrCalls = 0;
  const kept = await fileProcessor.processPDF(write('certs.pdf', certs), { detailed: true });
  assert.equal(ocrCalls, 0);
  assert.equal(kept.ocr.provider, 'pdf_text_layer');
  assert.match(kept.extractedText, /José Quispe Mamani/);
  // A pdf-parse whose text does not add up to the captured pages (a stub,
  // another version) falls back to the joined text.
  const stub = async (_buffer, opts) => {
    assert.equal(typeof opts.pagerender, 'function');
    return { text: 'Escaneado con CamScanner', numpages: 2 };
  };
  assert.equal((await fileProcessor.parsePdfWithPages(Buffer.alloc(0), stub)).pages, null);
  // A page pdf-parse could not render («») leaves no hole.
  const holes = async (_buffer, opts) => {
    const text = await opts.pagerender({ pageIndex: 1, getTextContent: async () => ({ items: [{ str: 'Hoja', transform: [1, 0, 0, 1, 50, 700] }] }) });
    return { text: `\n\n\n\n${text}`, numpages: 2 };
  };
  assert.deepEqual((await fileProcessor.parsePdfWithPages(Buffer.alloc(0), holes)).pages, ['', 'Hoja']);
});

test('pdf-parse reads a small PDF wherever the Buffer pool is (toPdfJsData)', async () => {
  const fileProcessor = require('../src/services/fileProcessor');
  // pdf.js 1.10 copies a Buffer with `new Buffer(buf)`: under half of
  // Buffer.poolSize that copy comes from the shared pool at a non-zero
  // offset, which its sub-streams ignore («bad XRef entry»). Each round moves
  // the pool first; parsePdfWithPages must read every one.
  for (let i = 0; i < 24; i += 1) {
    Buffer.from('x'.repeat((i * 97) % 1500 + 1), 'latin1');
    const small = textItemsPdf([[{ y: 700, text: `Hoja ${i}` }], [{ y: 700, text: 'Fin' }]]);
    assert.ok(small.length < 4096, 'stays under the pooled size on every Node');
    const { data, pages } = await fileProcessor.parsePdfWithPages(small);
    assert.equal(data.numpages, 2);
    assert.deepEqual(pages, [`Hoja ${i}`, 'Fin']);
  }
  // An exact Buffer becomes a plain view (no copy); a pooled or sliced one a
  // fresh copy at offset 0; anything else passes through.
  const exact = Buffer.alloc(16, 7);
  const view = toPdfJsData(exact);
  assert.equal(Object.getPrototypeOf(view), Uint8Array.prototype);
  assert.equal(view.buffer, exact.buffer);
  const big = Buffer.alloc(64, 1);
  const slice = big.subarray(8, 40);
  const copy = toPdfJsData(slice);
  assert.equal(Object.getPrototypeOf(copy), Uint8Array.prototype);
  assert.equal(copy.byteOffset, 0);
  assert.equal(copy.buffer.byteLength, 32);
  assert.notEqual(copy.buffer, big.buffer);
  assert.deepEqual([...copy], [...slice]);
  const ab = new ArrayBuffer(4);
  assert.equal(toPdfJsData(ab), ab);
  assert.equal(toPdfJsData(null), null);
});

test('processPDF: a stamp-only text layer goes to full OCR (with provenance) instead of being returned as text', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  extractFastpath.__setExecFileForTests(async () => ({ stdout: Array(4).fill('Escaneado con CamScanner - 03/10/2026').join('\f') }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  let ocrCalls = 0;
  override(t, engine, {
    extractFromPdfImages: async (_file, opts) => {
      ocrCalls += 1;
      assert.equal(opts.streaming, true);
      return {
        text: '[page 1]\nTexto real escaneado de la primera página.',
        ocr: { status: 'vision_fallback', pages: 4, pagesWithText: 1, confidence: 81, confidenceLevel: 'media', provider: 'tesseract+gemini:gemini-3.5-flash' },
      };
    },
  });
  const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.equal(ocrCalls, 1);
  assert.match(out.extractedText, /^PDF OCR document — 4 page\(s\) processed, 1 page\(s\) with readable text, \d+ characters · OCR: Tesseract \(local\) \+ Gemini · confianza media \(81 %\)\n---\n/);
  assert.doesNotMatch(out.extractedText, /CamScanner/);
});

test('processPDF: when OCR reads nothing, the stamp-only text layer is kept instead of «No text detected»', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  extractFastpath.__setExecFileForTests(async () => ({ stdout: Array(3).fill('Escaneado con CamScanner - 03/10/2026').join('\f') }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  override(t, engine, { extractFromPdfImages: async () => ({ text: '', ocr: { status: 'failed', reason: 'local_pdf_ocr_empty', pages: 3 } }) });
  const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.match(out.extractedText, /OCR read no text, keeping the embedded text layer/);
  assert.match(out.extractedText, /CamScanner/);
  assert.equal(out.ocr.textLayerKept, true);
});

test('processPDF: a garbled page of a mixed PDF is OCR\'d within the mixed budget and merged in page order', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  extractFastpath.__setExecFileForTests(async () => ({
    stdout: [CLEAN, '(cid:12)(cid:13)(cid:14)(cid:15)(cid:16)(cid:17) (cid:18)(cid:19)(cid:20)', '', `${CLEAN} Cláusula final.`].join('\f'),
  }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  let subsetArgs = null;
  override(t, engine, {
    extractPdfPagesSubset: async (_file, pages, opts) => {
      subsetArgs = { pages, opts };
      return { pages: [{ page: 2, text: 'Página dos recuperada por OCR', confidence: 88 }, { page: 3, text: '', reason: 'too_little_text' }], ocr: { pagesProcessed: 2 } };
    },
  });
  const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.deepEqual(subsetArgs.pages, [2, 3]);
  assert.equal(subsetArgs.opts.budgetMs, mixedPdf.mixedOcrBudgetMs());
  assert.match(out.extractedText, /\[page 1\]\nContrato[\s\S]*\[page 2 — OCR\]\nPágina dos recuperada[\s\S]*\[página 3 — no legible: sin texto legible\][\s\S]*\[page 4\]\nContrato[^\n]*Cláusula final/);
  assert.equal(out.ocr.mixedOcr.ocrPagesWithText, 1);
  assert.deepEqual(out.ocr.mixedOcr.unreadPages, [3]);
  assert.equal(out.ocr.mixedOcr.garbledPages, 1);
});

test('processPDF: SIRAGPT_PDF_TEXT_LAYER_CHECK=0 restores the length-only behaviour', async (t) => {
  quiet(t);
  withEnv(t, { SIRAGPT_PDF_TEXT_LAYER_CHECK: '0' });
  const fileProcessor = require('../src/services/fileProcessor');
  extractFastpath.__setExecFileForTests(async () => ({ stdout: Array(3).fill('Escaneado con CamScanner - 03/10/2026').join('\f') }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  let ocrCalls = 0;
  override(t, engine, { extractFromPdfImages: async () => { ocrCalls += 1; return { text: '', ocr: {} }; } });
  const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.equal(ocrCalls, 0);
  assert.match(out.extractedText, /CamScanner/);
});

test('SIRAGPT_OCR_PDF_VISION=0 keeps scanned PDFs Tesseract-only (cloud cost kill switch)', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 2,
    env: { SIRAGPT_OCR_PDF_VISION: '0' },
    reads: { 1: { text: GARBAGE, confidence: 40 }, 2: { text: CLEAN, confidence: 95 } },
    vision: () => ({ text: 'no debería usarse' }),
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.equal(visionCalls.length, 0);
  assert.match(res.text, /\[page 2\]\nContrato/);
});

// ── budgets, blank pages, paid rungs, honest markers ──────────────────────

const WEAK = 'Informe de la comisión revisora sobre el presupuesto del año fiscal';

test('slow vision never starves Tesseract: a 20-page scan still gets local text on every page', async (t) => {
  quiet(t);
  withEnv(t, { SIRAGPT_OCR_PDF_PAGE_BUDGET_MS: '8000', OCR_PDF_MAX_SIDE: '300', OCR_PDF_MAX_VARIANTS: '1' });
  const buffers = [];
  for (let k = 1; k <= 20; k += 1) buffers.push(await pagePng(k));
  const visionCalls = [];
  override(t, engine, {
    _openPdf: async () => fakePdf(buffers),
    // Every page reads at 70 % (typical scan: weak, sent to vision), 100 ms each.
    createOcrWorker: async () => ({
      async setParameters() {},
      async recognize() { await new Promise((r) => setTimeout(r, 100)); return { data: { text: WEAK, confidence: 70 } }; },
      async terminate() {},
    }),
    ocrInput: { ...realOcrInput, detectOrientation: async () => ({ ok: false }) },
    ollamaOcr: GLM_ON,
    // A slow vision model (CPU GLM): it honours the deadline it is given.
    runVisionFallback: async (args) => {
      visionCalls.push(args);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(2000, args.deadlineAt - Date.now()))));
      return { text: '', ocr: { status: 'failed', reason: 'ollama_ocr_failed' } };
    },
  });
  const started = Date.now();
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf', { budgetMs: 15_000 });
  assert.ok(Date.now() - started < 15_000);
  assert.ok(visionCalls.length >= 1, 'vision still runs while the reserve allows it');
  assert.ok(visionCalls.length < 20, 'vision stops before it eats the Tesseract reserve');
  assert.equal(res.ocr.partial, false);
  assert.equal(res.ocr.pagesWithText, 20);
  for (let k = 1; k <= 20; k += 1) {
    assert.match(res.text, new RegExp(`\\[page ${k}\\]\\n\\[página ${k} — lectura poco fiable[^\\n]*\\]\\n${WEAK}`));
  }
  assert.ok(res.ocr.pageQuality.some((p) => p.visionReason === 'vision_no_time'));
});

test('blank pages (duplex backs) never reach the vision ladder and never use the vision page cap', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 5,
    blankPages: [1, 3],
    reads: {},
    vision: (k) => ({ text: `Página ${k} leída por el modelo de visión con su contenido.` }),
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf', { visionMaxPages: 2 });
  assert.deepEqual(visionCalls.map((c) => c.page), [2, 4]);
  assert.match(res.text, /\[page 1\]\n\[página 1 — en blanco\]/);
  assert.match(res.text, /\[page 3\]\n\[página 3 — en blanco\]/);
  assert.match(res.text, /\[page 5\]\n\[página 5 — sin OCR completo: límite de páginas con visión\]/);
  assert.equal(res.ocr.blankPages, 2);
  assert.deepEqual(res.ocr.unreadPages, [5]);
  assert.equal(res.ocr.visionPages, 2);
});

test('paid rung opt-in: full scanned PDFs get local GLM only unless SIRAGPT_OCR_PDF_VISION_CLOUD=1; mixed PDFs keep the cloud rung', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 1,
    reads: { 1: { text: GARBAGE, confidence: 40 } },
    vision: () => ({ text: 'Leído por visión.' }),
  });
  withEnv(t, { SIRAGPT_OCR_PDF_VISION_CLOUD: undefined });
  await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.equal(visionCalls[0].args.allowCloud, false);
  process.env.SIRAGPT_OCR_PDF_VISION_CLOUD = '1';
  await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.equal(visionCalls[1].args.allowCloud, true);
  delete process.env.SIRAGPT_OCR_PDF_VISION_CLOUD;
  await engine.extractPdfPagesSubset('/fake.pdf', [1]);
  assert.equal(visionCalls[2].args.allowCloud, true);
});

test('runVisionFallback({ allowCloud:false }) never calls a cloud runtime', async (t) => {
  quiet(t);
  let cloudCalls = 0;
  override(t, engine, {
    ollamaOcr: { isEnabled: () => true, config: () => ({ model: 'glm-ocr' }), ensureAvailable: async () => ({ available: false, reason: 'model_pulling' }), recognize: async () => ({ ok: false }) },
    createVisionRuntimeClient: () => ({ chat: { completions: { create: async () => { cloudCalls += 1; return { choices: [{ message: { content: 'x' } }] }; } } } }),
  });
  withEnv(t, { GEMINI_API_KEY: 'g' });
  const res = await engine.runVisionFallback({ buffer: Buffer.from('img'), allowCloud: false });
  assert.equal(cloudCalls, 0);
  assert.equal(res.ocr.status, 'failed');
  assert.equal(res.ocr.reason, 'vision_cloud_disabled');
  assert.equal(res.ocr.ollamaOcr, 'model_pulling');
});

test('a large rendered page reaches the vision models as a provider-safe copy; band reads keep the native render', async (t) => {
  quiet(t);
  withEnv(t, { OCR_PDF_MAX_SIDE: '300', OCR_PDF_MAX_VARIANTS: '1' });
  const ink = await sharp({ create: { width: 200, height: 60, channels: 3, background: 'black' } }).png().toBuffer();
  const page = await sharp({ create: { width: 4000, height: 900, channels: 3, background: 'white' } })
    .composite([{ input: ink, left: 100, top: 100 }]).png().toBuffer();
  let seen = null;
  override(t, engine, {
    ollamaOcr: GLM_ON,
    runVisionFallback: async (args) => { seen = args; return { text: 'Texto', ocr: { status: 'vision_fallback', provider: 'ollama:glm-ocr', confidence: 70, confidenceLevel: 'media' } }; },
  });
  const state = {
    worker: { async recognize() { return { data: { text: '', confidence: 0 } }; }, async terminate() {} },
    broken: false, language: 'spa', visionPages: 0, localMs: 0, localPages: 0,
  };
  const read = await engine._readPdfPage(page, {
    pageNumber: 1, totalPages: 1, state, pageDeadlineAt: Date.now() + 5000, docDeadlineAt: Date.now() + 60_000,
    maxVariants: 1, allowVision: true, visionMaxPages: 5, pagesLeft: 0,
  });
  assert.equal(read.text, 'Texto');
  const meta = await sharp(seen.buffer).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 3072, `vision copy ${meta.width}×${meta.height}`);
  assert.equal(seen.sourceBuffer, page);
});

test('Tesseract unavailable and no vision: the marker says the page was not read, not that it has no text', async (t) => {
  await setupPdf(t, { pages: 1, reads: {} });
  override(t, engine, {
    createOcrWorker: async () => { const e = new Error('tesseract_unavailable'); e.code = 'tesseract_unavailable'; throw e; },
  });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf', { allowVision: false });
  assert.equal(res.ocr.status, 'failed');
  assert.equal(res.ocr.pageQuality[0].reason, 'tesseract_unavailable');
  const subset = await engine.extractPdfPagesSubset('/fake.pdf', [1], { allowVision: false });
  assert.equal(subset.pages[0].marker, '[página 1 — sin OCR: OCR local no disponible]');
});

test('short form PDFs: per-page data on a shared template is content, not a stamp — the exact layer is kept', () => {
  // Only the student's name differs: the residual is under minChars on every
  // page, so the plan cannot rely on other varying lines to keep the layer.
  const names = ['Ana', 'Luis', 'Rosa', 'Iván', 'Eva'];
  const forms = names.map((name, i) => ({ page: i + 1, text: `Constancia de notas\nCurso: Matemática Básica\nAlumno: ${name}` }));
  const boilerplate = mixedPdf.boilerplateLines(forms);
  for (const p of forms) assert.ok(mixedPdf.residualChars(p.text, boilerplate) < mixedPdf.DEFAULT_MIN_PAGE_CHARS);
  const plan = mixedPdf.planTextLayerOcr(forms);
  assert.equal(plan.kind, 'text');
  assert.equal(plan.counts.stampOnly, 0);
  assert.equal(mixedPdf.isStampOnlyText(forms.map((p) => p.text).join('\n'), 5), false);
  // Lines that differ only in their numbers are not boilerplate: they are
  // residual content (grades, amounts, dates).
  const graded = names.map((name, i) => ({ page: i + 1, text: `Constancia de notas\nAlumno: ${name}\nNota final: ${10 + i}\nFecha: 0${i + 1}/10/2026` }));
  assert.equal(mixedPdf.boilerplateLines(graded).has('nota final: 10'), false);
  assert.equal(mixedPdf.planTextLayerOcr(graded).kind, 'text');
  // Page numbers are still recognised whatever their digits.
  const numbered = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `Escaneado con CamScanner\nPágina ${i + 1} de 6` }));
  assert.equal(mixedPdf.planTextLayerOcr(numbered).kind, 'scanned');
});

test('mail-merge certificates (only the name differs) keep their exact layer; scanner counters and stray lines are still stamps', () => {
  const names = ['María Pérez López', 'José Quispe Mamani', 'Ana Torres Ruiz', 'Luis Chávez Rojas', 'Rosa Huamán Díaz', 'Iván Salazar Peña', 'Eva Castro León', 'Jorge Ramos Vega'];
  // pdftotext -layout: centred lines, < 200 chars per page, every template
  // line on 100 % of the pages.
  const certificate = (name) => `        CERTIFICADO DE PARTICIPACIÓN\n   Se otorga el presente certificado a\n              ${name}\n por haber participado en el Taller de Redacción\n        Lima, 15 de octubre de 2026`;
  const certs = names.map((name, i) => ({ page: i + 1, text: certificate(name) }));
  assert.ok(certs.every((p) => p.text.trim().length < 200));
  const plan = mixedPdf.planTextLayerOcr(certs);
  assert.equal(plan.kind, 'text');
  assert.deepEqual(plan.ocrPages, []);
  assert.equal(mixedPdf.isStampOnlyText(certs.map((p) => p.text).join('\n\n'), certs.length), false);
  // Per-page scanner data that only differs in its digits is a stamp.
  const sheets = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, text: `Escaneado con CamScanner\nHoja ${i + 1}` }));
  assert.equal(mixedPdf.planTextLayerOcr(sheets).kind, 'scanned');
  assert.equal(mixedPdf.isStampOnlyText(sheets.map((p) => p.text).join('\n\n'), 8), true);
  const stamped = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, text: `Escaneado con CamScanner\nscan_000${i + 1}.jpg 10:2${i}` }));
  assert.equal(mixedPdf.planTextLayerOcr(stamped).kind, 'scanned');
  // A scan whose pages are mostly empty stays a scan when two of them carry
  // a different short line.
  const signed = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: `Escaneado con CamScanner\n${i === 2 ? 'Firma Juan Pérez' : i === 6 ? 'Firma Ana Ruiz' : ''}` }));
  assert.equal(mixedPdf.planTextLayerOcr(signed).kind, 'scanned');
});

test('pdf-parse fallback: a scan whose one page carries a signature and a seal is still stamp-only; mail-merge certificates keep their layer', () => {
  // pdf-parse writes «\n\n» before every page.
  const pdfParse = (pages) => `\n\n${pages.join('\n\n')}`;
  const scans = {
    'signature and seal on page 2 of 4': [
      'Escaneado con CamScanner\nPágina 1 de 4',
      'Escaneado con CamScanner\nFirma Juan Pérez\nSello notarial\nPágina 2 de 4',
      'Escaneado con CamScanner\nPágina 3 de 4',
      'Escaneado con CamScanner\nPágina 4 de 4',
    ],
    'signature and seal on page 1 of 2': ['Escaneado con CamScanner\nFirma Ana\nSello', 'Escaneado con CamScanner'],
    '«Recibí conforme / Ana / Lima» on page 2 of 6': [
      'Escaneado con CamScanner', 'Escaneado con CamScanner\nRecibí conforme\nAna\nLima', 'Escaneado con CamScanner',
      'Escaneado con CamScanner', 'Escaneado con CamScanner', 'Escaneado con CamScanner',
    ],
  };
  for (const [name, pages] of Object.entries(scans)) {
    assert.equal(mixedPdf.isStampOnlyText(pdfParse(pages), pages.length), true, name);
    assert.equal(mixedPdf.isStampOnlyText(pages.join('\n\n'), pages.length), true, name);
    // Without page boundaries, fewer worded lines than pages cannot be a
    // page of data each (two lines over two pages stay ambiguous).
    if (pages.length > 2) assert.equal(mixedPdf.isStampOnlyText(pages.join('\n'), pages.length), true, `${name} (no boundaries)`);
    // The per-page planner reads the stamp pages too.
    assert.notEqual(mixedPdf.planTextLayerOcr(pages.map((text, i) => ({ page: i + 1, text }))).kind, 'text', name);
  }
  const names = ['María Pérez López', 'José Quispe Mamani', 'Ana Torres Ruiz', 'Luis Chávez Rojas', 'Rosa Huamán Díaz', 'Iván Salazar Peña', 'Eva Castro León', 'Jorge Ramos Vega'];
  const certs = names.map((name) => `CERTIFICADO DE PARTICIPACIÓN\nSe otorga el presente certificado a\n${name}\npor haber participado en el Taller de Redacción\nLima, 15 de octubre de 2026`);
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(certs), certs.length), false);
  // A blank first page (an empty cover) keeps the page blocks aligned.
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(['', ...certs]), certs.length + 1), false);
  // pdf.js turns an empty text item into a blank line INSIDE a page, so the
  // text splits into more blocks than pages. Each block still lies within one
  // page: a signature block without the template is not merge data.
  const stamp = 'Escaneado con CamScanner - www.camscanner.com';
  assert.equal(mixedPdf.isStampOnlyText(`\n\n${stamp}\n\n\n${stamp}\n\nRecibí conforme\nAna\nLima\n\n${stamp}\n`, 3), true, 'empty item on page 2 of 3');
  assert.equal(mixedPdf.isStampOnlyText(`\n\n${stamp}\nFirma Ana\nSello\n\n${stamp}\n\nPágina 2 de 2`, 2), true, 'empty item on page 2 of 2');
  // Each block beyond one per page may be the other half of a page: a scan
  // whose signature page splits between two stamp lines (header and footer,
  // or the same stamp twice) is not two pages of merge data.
  const scanPage = (top, bottom, split) => [top, ...(split ? ['Firma Juan Pérez', '', 'Sello notarial'] : []), bottom].join('\n');
  const splitScans = {
    'header and footer, page 2 of 4 split': [1, 2, 3, 4].map((i) => scanPage('Escaneado con CamScanner', 'www.camscanner.com', i === 2)),
    'header and footer, page 2 of 3 split': [1, 2, 3].map((i) => scanPage('Escaneado con CamScanner', 'www.camscanner.com', i === 2)),
    'header and footer, pages 3 and 6 of 8 split': [1, 2, 3, 4, 5, 6, 7, 8].map((i) => scanPage('Escaneado con CamScanner', 'www.camscanner.com', i === 3 || i === 6)),
    'the same stamp twice, page 1 of 2 split': [1, 2].map((i) => scanPage(stamp, stamp, i === 1)),
    'the same stamp twice, page 2 of 4 split': [1, 2, 3, 4].map((i) => scanPage(stamp, stamp, i === 2)),
  };
  for (const [name, pages] of Object.entries(splitScans)) {
    assert.equal(mixedPdf.isStampOnlyText(pdfParse(pages), pages.length), true, name);
    assert.equal(mixedPdf.isStampOnlyText(pdfParse(pages), pages.length, { pages }), true, `${name} (pages)`);
  }
  // With the text of each page (processPDF captures it from pdf-parse),
  // certificates with a blank line inside every page keep their layer; from
  // the joined text alone they cannot be told from split scan pages and are
  // OCR'd (still read).
  const spaced = names.map((name) => `CERTIFICADO DE PARTICIPACIÓN\n\nSe otorga el presente certificado a\n${name}\npor haber participado en el Taller de Redacción\nLima, 15 de octubre de 2026`);
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(spaced), spaced.length, { pages: spaced }), false);
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(spaced), spaced.length), true);
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(certs), certs.length, { pages: certs }), false);
  // Pages that do not match the page count are ignored.
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(certs), certs.length, { pages: certs.slice(1) }), false);
  // The stamp verdict counts every occurrence: a stamp printed twice on a few
  // pages of a scan is still a template with the per-page text passed.
  const twice = `${stamp}\n${stamp}`;
  const fewPages = [twice, twice, '', '', ''];
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(fewPages), fewPages.length, { pages: fewPages }), true, 'stamp twice on 2 of 5 pages');
  const mixedStamps = ['Escaneado con CamScanner\nwww.camscanner.com', twice];
  assert.equal(mixedPdf.isStampOnlyText(pdfParse(mixedStamps), mixedStamps.length, { pages: mixedStamps }), true, 'short stamps and the long stamp twice');
});

test('mail-merge whose pages straddle 200 chars: the page just under it keeps its layer; a page with only the template is still read', () => {
  const names = ['María Pérez López', 'José Quispe Mamani', 'Ana Paz Ruiz', 'Luis Chávez Rojas', 'Rosa Huamán Díaz', 'Iván Salazar Peña', 'Eva Castro León', 'Jorge Ramos Vega'];
  // pdftotext -layout pads the centred lines: most certificates land just
  // over 200 characters, the one with the shortest name just under.
  const pad = ' '.repeat(20);
  const certificate = (name) => `        CERTIFICADO DE PARTICIPACIÓN\n   Se otorga el presente certificado a\n              ${name}\n${pad} por haber participado en el Taller de Redacción\n        Lima, 15 de octubre de 2026`;
  const certs = names.map((name, i) => ({ page: i + 1, text: certificate(name) }));
  const lengths = certs.map((p) => p.text.trim().length);
  assert.ok(lengths[2] < 200 && lengths.filter((n) => n >= 200).length === 7, lengths.join(','));
  const plan = mixedPdf.planTextLayerOcr(certs);
  assert.equal(plan.kind, 'text');
  assert.deepEqual(plan.ocrPages, []);
  // A scanned insert carrying only the template's footer is still OCR'd.
  const withInsert = mixedPdf.planTextLayerOcr([...certs, { page: 9, text: '        Lima, 15 de octubre de 2026' }]);
  assert.equal(withInsert.kind, 'mixed');
  assert.deepEqual(withInsert.ocrPages, [9]);
  assert.equal(withInsert.reasons[9], 'stamp_only');
  assert.deepEqual(withInsert.emptyLayerPages, [9]);
  // A text document with a running header is not a merge: its scanned pages
  // (the header alone, or the header and one signature line) are still read.
  const clause = 'Las partes acuerdan que el arrendatario pagará la renta mensual dentro de los cinco primeros días de cada mes, en la cuenta indicada por el arrendador.';
  const contract = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `CONTRATO DE ARRENDAMIENTO\nCláusula ${i + 1}. ${clause}` }));
  contract.push({ page: 7, text: 'CONTRATO DE ARRENDAMIENTO\nFirma Juan Pérez' }, { page: 8, text: 'CONTRATO DE ARRENDAMIENTO' });
  assert.deepEqual(mixedPdf.planTextLayerOcr(contract).ocrPages, [7, 8]);
  // Two signature pages with different names are still not a merge: the
  // share is taken over the whole document, not only its thin pages.
  contract.push({ page: 9, text: 'CONTRATO DE ARRENDAMIENTO\nFirma Ana Ruiz' });
  assert.deepEqual(mixedPdf.planTextLayerOcr(contract).ocrPages, [7, 8, 9]);
  // A long thesis whose scanned annexes carry the running header and a
  // typed caption («ANEXO A/B/C»): the annexes are read.
  const head = 'UNIVERSIDAD NACIONAL MAYOR DE SAN MARCOS';
  const foot = 'Tesis de Licenciatura en Educación — 2026';
  const body = 'La presente investigación analiza el impacto de las políticas públicas en la educación básica regular del Perú durante el periodo 2015-2025. ';
  const thesis = Array.from({ length: 50 }, (_, i) => ({ page: i + 1, text: `${head}\n${body.repeat(14)}\n${foot}\n${i + 1}` }));
  for (const [i, letter] of ['A', 'B', 'C'].entries()) thesis.push({ page: 51 + i, text: `${head}\n                    ANEXO ${letter}\n${foot}\n${51 + i}` });
  const annexes = mixedPdf.planTextLayerOcr(thesis);
  assert.equal(annexes.kind, 'mixed');
  assert.deepEqual(annexes.ocrPages, [51, 52, 53]);
  assert.equal(annexes.reasons[51], 'stamp_only');
});

test('processPDF: a full OCR stopped by its budget keeps the text layer of every page it did not read', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  // Receipts whose only per-page data is a number: planned as stamps → full
  // OCR (on purpose: digits alone look like a scanner's counter, see
  // looksLikeMergeData).
  const layer = [1, 2, 3, 4].map((i) => `CONSTANCIA DE PAGO\nRecibo N° 0001${i}`);
  extractFastpath.__setExecFileForTests(async () => ({ stdout: layer.join('\f') }));
  t.after(() => extractFastpath.__setExecFileForTests(null));
  override(t, engine, {
    extractFromPdfImages: async () => ({
      text: '[page 1]\nCONSTANCIA DE PAGO\nRecibo N° 00011\n\n[page 2]\n[página 2 — no legible: tiempo agotado]\n\n[páginas 3–4 sin OCR: tiempo agotado]',
      pages: [
        { page: 1, text: 'CONSTANCIA DE PAGO\nRecibo N° 00011', confidence: 90, accepted: true },
        { page: 2, text: '', reason: 'timeout', confidence: 0, accepted: false },
      ],
      ocr: { status: 'local_ok', pages: 2, totalPages: 4, pagesWithText: 1, unreadPages: [2], partial: true, partialReason: 'budget', confidence: 90, provider: 'tesseract' },
    }),
  });
  const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.match(out.extractedText, /^PDF OCR document — 2 page\(s\) processed, 1 page\(s\) with readable text, \d+ characters \(partial — budget\) \(\+3 page\(s\) from the embedded text layer where OCR did not read\)\n---\n/);
  assert.match(out.extractedText, /\[page 1\]\nCONSTANCIA DE PAGO\nRecibo N° 00011\n\n\[page 2\]\n\[página 2 — el OCR no pudo leerla \(tiempo agotado\): se conserva el texto incrustado del PDF\]\nCONSTANCIA DE PAGO\nRecibo N° 00012/);
  assert.match(out.extractedText, /\[page 3\]\n\[página 3 sin OCR: tiempo agotado — se conserva el texto incrustado del PDF\]\nCONSTANCIA DE PAGO\nRecibo N° 00013/);
  assert.match(out.extractedText, /\[page 4\]\n\[página 4 sin OCR: tiempo agotado — se conserva el texto incrustado del PDF\]\nCONSTANCIA DE PAGO\nRecibo N° 00014$/);
  assert.doesNotMatch(out.extractedText, /páginas 3–4 sin OCR/);
  assert.equal(out.ocr.textLayerPages, 3);
  assert.deepEqual(out.ocr.textLayerPageList, [2, 3, 4]);
  // A complete OCR is returned as the engine wrote it.
  override(t, engine, {
    extractFromPdfImages: async () => ({
      text: '[page 1]\nRecibo leído',
      pages: [{ page: 1, text: 'Recibo leído', confidence: 90, accepted: true }],
      ocr: { status: 'local_ok', pages: 4, totalPages: 4, pagesWithText: 4, unreadPages: [], partial: false },
    }),
  });
  const full = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.match(full.extractedText, /\n---\n\[page 1\]\nRecibo leído$/);
  assert.equal(full.ocr.textLayerPages, undefined);
});

test('processPDF: a scan whose layer is only stamps, page numbers and scanner metadata keeps one marker for the pages OCR never reached', async (t) => {
  quiet(t);
  const fileProcessor = require('../src/services/fileProcessor');
  const N = 300;
  const READ = 50;
  const layers = {
    camscanner: Array.from({ length: N }, (_, i) => `Escaneado con CamScanner\nPágina ${i + 1} de ${N}`),
    metadata: Array.from({ length: N }, (_, i) => `Escaneado con CamScanner\nHoja ${i + 1}\nscan_${String(i + 1).padStart(4, '0')}.jpg 10:${String(i % 60).padStart(2, '0')}`),
  };
  t.after(() => extractFastpath.__setExecFileForTests(null));
  override(t, engine, {
    extractFromPdfImages: async () => ({
      text: `${Array.from({ length: READ }, (_, i) => `[page ${i + 1}]\nContenido real de la página ${i + 1}`).join('\n\n')}\n\n[páginas ${READ + 1}–${N} sin OCR: tiempo agotado]`,
      pages: Array.from({ length: READ }, (_, i) => ({ page: i + 1, text: `Contenido real de la página ${i + 1}`, confidence: 90, accepted: true })),
      ocr: { status: 'local_ok', pages: READ, totalPages: N, pagesWithText: READ, unreadPages: [], partial: true, partialReason: 'budget', confidence: 90, provider: 'tesseract' },
    }),
  });
  for (const [name, layer] of Object.entries(layers)) {
    extractFastpath.__setExecFileForTests(async () => ({ stdout: layer.join('\f') }));
    const out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
    assert.match(out.extractedText, /^PDF OCR document — 50 page\(s\) processed/, name);
    assert.doesNotMatch(out.extractedText.split('\n')[0], /embedded text layer/, name);
    assert.equal(out.extractedText.split(`[páginas ${READ + 1}–${N} sin OCR: tiempo agotado]`).length, 2, name);
    assert.doesNotMatch(out.extractedText, /\[page 51\]|se conserva el texto incrustado|CamScanner|scan_0051/, name);
    assert.equal(out.ocr.textLayerPages, undefined, name);
    const plan = mixedPdf.planTextLayerOcr(layer.map((text, i) => ({ page: i + 1, text })));
    assert.equal(plan.kind, 'scanned', name);
    assert.equal(plan.emptyLayerPages.length, N, name);
  }
  // A broken-font scan (every glyph a (cid:NN) code, readable page numbers):
  // its layer carries no text either, so the same single marker stays.
  const cid = Array.from({ length: N }, (_, i) => `${'(cid:3)(cid:17)(cid:22)(cid:9) (cid:44)(cid:12)(cid:5)\n'.repeat(30)}Página ${i + 1} de ${N}`);
  extractFastpath.__setExecFileForTests(async () => ({ stdout: cid.join('\f') }));
  const broken = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
  assert.doesNotMatch(broken.extractedText.split('\n')[0], /embedded text layer/);
  assert.equal(broken.extractedText.split(`[páginas ${READ + 1}–${N} sin OCR: tiempo agotado]`).length, 2);
  assert.doesNotMatch(broken.extractedText, /\(cid:|se conserva el texto incrustado/);
  assert.equal(broken.ocr.textLayerPages, undefined);
  assert.equal(mixedPdf.planTextLayerOcr(cid.map((text, i) => ({ page: i + 1, text }))).counts.garbled, N);
});

test('splice without a plan: stamp-only layers count as none, a layer with content is kept', () => {
  const layer = Array.from({ length: 5 }, (_, i) => ({
    page: i + 1,
    text: `Escaneado con CamScanner\n${i === 3 ? 'Nota manuscrita: entregar el lunes\n' : ''}Página ${i + 1} de 5`,
  }));
  const out = mixedPdf.spliceTextLayerIntoOcr(layer, [{ page: 1, text: 'Primera página leída' }], { totalPages: 5, stopReason: 'budget' });
  assert.equal(out.text, [
    '[page 1]\nPrimera página leída',
    '[páginas 2–3 sin OCR: tiempo agotado]',
    '[page 4]\n[página 4 sin OCR: tiempo agotado — se conserva el texto incrustado del PDF]\nEscaneado con CamScanner\nNota manuscrita: entregar el lunes\nPágina 4 de 5',
    '[página 5 sin OCR: tiempo agotado]',
  ].join('\n\n'));
  assert.deepEqual(out.splicedPages, [4]);
});

test('processPDF (streaming path): a 2000-page layer is planned without blocking the event loop', async (t) => {
  quiet(t);
  withEnv(t, { SIRAGPT_PDF_TEXT_LAYER_SCORE_MAX_CHARS: '100000' });
  const fileProcessor = require('../src/services/fileProcessor');
  const streamingPdf = require('../src/services/document/streaming-pdf');
  extractFastpath.__setExecFileForTests(async () => { const err = new Error('spawn pdftotext ENOENT'); err.code = 'ENOENT'; throw err; });
  t.after(() => extractFastpath.__setExecFileForTests(null));
  const prose = 'El contrato de arrendamiento celebrado entre las partes establece las condiciones del local comercial ubicado en la ciudad de Lima, con una renta mensual pactada y una garantía equivalente. ';
  const pages = Array.from({ length: 2000 }, (_, i) => ({
    page: i + 1,
    text: i === 1989 ? '(cid:12)(cid:13)(cid:14)(cid:15)(cid:16)(cid:17) (cid:18)(cid:19)(cid:20)' : `Capítulo ${i + 1}\n${prose.repeat(8)}`,
  }));
  override(t, streamingPdf, {
    extractPdfStreaming: async () => ({ pageCount: 2000, totalPages: 2000, totalChars: 3_000_000, partial: false, pages }),
  });
  let subsetPages = null;
  override(t, engine, {
    extractPdfPagesSubset: async (_file, list) => {
      subsetPages = list;
      return { pages: [{ page: 1990, text: 'Página 1990 recuperada por OCR', confidence: 88 }], ocr: { pagesProcessed: 1 } };
    },
  });
  let maxGap = 0;
  let ticks = 0;
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  let out;
  try {
    out = await fileProcessor.processPDF(tmpPdf(t), { detailed: true });
    maxGap = Math.max(maxGap, performance.now() - last);
  } finally {
    running = false;
  }
  assert.deepEqual(subsetPages, [1990]);
  assert.match(out.extractedText, /\[page 1990 — OCR\]\nPágina 1990 recuperada por OCR/);
  assert.ok(maxGap < 250, `longest synchronous slice ${Math.round(maxGap)} ms`);
  assert.ok(ticks >= 10, `the planner yielded (${ticks} ticks)`);
});

test('one giant page (an 18 MB layer without form feeds) is planned in bounded slices; the chunked glyph census stays exact', async () => {
  const prose = 'El contrato de arrendamiento celebrado entre las partes establece las condiciones del local comercial ubicado en la ciudad de Lima, con una renta mensual pactada y una garantía equivalente. ';
  const count = Math.floor(18e6 / (prose.length + 1));
  const giant = { lines: (prose + '\n').repeat(count), 'one line': prose.repeat(count) };
  for (const [shape, text] of Object.entries(giant)) {
    let maxGap = 0;
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    let plan;
    try {
      plan = await mixedPdf.planTextLayerOcrAsync([{ page: 1, text }, { page: 2, text: 'Capítulo final del contrato, con texto suficiente.' }]);
      maxGap = Math.max(maxGap, performance.now() - last);
    } finally {
      running = false;
    }
    assert.equal(plan.kind, 'text', shape);
    assert.ok(maxGap < 250, `${shape}: longest synchronous slice ${Math.round(maxGap)} ms`);
  }
  // 360 KB of (cid:NN): several census chunks, not one token split between two.
  const cids = '(cid:12) '.repeat(40_000);
  const score = mixedPdf.scoreTextLayerPage(cids, { deep: false });
  assert.equal(score.chars, 8 * 40_000);
  assert.equal(score.cidRatio, 1);
  assert.deepEqual(score.reasons, ['cid_glyphs']);
});

test('past the scoring budget, a layer the word/symbol checks find garbled everywhere stays a scanned document', async () => {
  // Only the word (or symbol) check catches these pages; with a 100 000-char
  // budget for 60 pages of ~4 KB only every third page is deep-scored.
  const fixtures = {
    words: 'rnmw tHe Iil xqzpt aaaa vvbnkl zzrt pkkqw Ww mmnnb ',
    symbols: '~~|| \\\\ ^^ ¦¦ ¬¬ ¤¤ ~| |~ ¦ ~~ || ¤ ¬ ~ | ',
  };
  for (const [name, unit] of Object.entries(fixtures)) {
    const pages = Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: unit.repeat(80) }));
    const plan = await mixedPdf.planTextLayerOcrAsync(pages, { maxScoreChars: 100_000 });
    assert.equal(plan.kind, 'scanned', name);
    assert.equal(plan.counts.garbled, 60, name);
    assert.equal(mixedPdf.planTextLayerOcr(pages, { maxScoreChars: 100_000 }).kind, 'scanned', name);
  }
  // The sample is the pages the glyph checks passed: a book whose broken
  // pages are (cid:NN) keeps its clean unsampled pages as text.
  const prose = 'El contrato de arrendamiento celebrado entre las partes establece las condiciones del local comercial ubicado en la ciudad de Lima. ';
  const cid = '(cid:12)(cid:13)(cid:14) '.repeat(160);
  const book = Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: i % 6 === 5 ? prose.repeat(30) : cid }));
  const plan = mixedPdf.planTextLayerOcr(book, { maxScoreChars: 100_000 });
  assert.equal(plan.kind, 'mixed');
  assert.equal(plan.counts.garbled, 50);
  assert.ok(book.every((p) => (p.page % 6 === 0) === !plan.reasons[p.page]));
  // Below the 80 % share nothing is extrapolated.
  const half = Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: i % 2 ? fixtures.words.repeat(80) : prose.repeat(30) }));
  const halfPlan = mixedPdf.planTextLayerOcr(half, { maxScoreChars: 100_000 });
  assert.equal(halfPlan.kind, 'mixed');
  assert.ok(halfPlan.counts.garbled < 30, `${halfPlan.counts.garbled} garbled`);
});

test('splice: page order, engine markers for pages with no layer, one marker for the run never reached, damaged layers flagged', () => {
  const MOJIBAKE = 'ConstituciÃ³n polÃ­tica del PerÃº, artÃ­culo 2: toda persona tiene derecho a la vida.';
  const layer = [
    { page: 1, text: 'Uno' },
    { page: 2, text: '' },
    { page: 3, text: 'Escaneado con CamScanner' },
    { page: 4, text: '(cid:1)(cid:2)(cid:3)' },
    { page: 5, text: MOJIBAKE },
  ];
  const ocrPages = [
    { page: 1, text: 'Uno (OCR)' },
    { page: 2, text: '', reason: 'too_little_text' },
    { page: 3, text: '', blank: true, marker: '[página 3 — en blanco]' },
  ];
  assert.ok(mixedPdf.scoreTextLayerPage(MOJIBAKE).reasons.includes('mojibake'));
  const out = mixedPdf.spliceTextLayerIntoOcr(layer, ocrPages, { totalPages: 7, stopReason: 'char_cap', reasons: { 4: 'garbled', 5: 'garbled' } });
  assert.equal(out.text, [
    '[page 1]\nUno (OCR)',
    '[page 2]\n[página 2 — no legible: sin texto legible]',
    '[page 3]\n[página 3 — en blanco]',
    // Glyph codes are no text: the page is one more page OCR did not reach.
    '[página 4 sin OCR: límite de caracteres]',
    // A mojibake layer is still text, kept under the «dañado» note.
    `[page 5]\n[página 5 sin OCR: límite de caracteres — se conserva el texto incrustado del PDF, que parece dañado: puede contener errores]\n${MOJIBAKE}`,
    '[páginas 6–7 sin OCR: límite de caracteres]',
  ].join('\n\n'));
  assert.deepEqual(out.splicedPages, [5]);
});

test('splice: a layer made of glyph codes ((cid:NN), private-use glyphs, U+FFFD) counts as none; a layer with a few codes is still kept', () => {
  // A broken-font book: every page is codes plus a readable page number.
  const N = 30;
  const READ = 20;
  const cidPage = (i) => `${'(cid:3)(cid:17)(cid:22)(cid:9) (cid:44)(cid:12)(cid:5) (cid:18)(cid:30)(cid:7)(cid:2)\n'.repeat(40)}Página ${i + 1} de ${N}`;
  const book = Array.from({ length: N }, (_, i) => ({ page: i + 1, text: cidPage(i) }));
  const plan = mixedPdf.planTextLayerOcr(book);
  assert.equal(plan.kind, 'scanned');
  assert.equal(plan.counts.garbled, N);
  const read = Array.from({ length: READ }, (_, i) => ({ page: i + 1, text: `Texto leído por OCR de la página ${i + 1}.` }));
  const out = mixedPdf.spliceTextLayerIntoOcr(book, read, { totalPages: N, stopReason: 'budget', reasons: plan.reasons, emptyLayerPages: plan.emptyLayerPages });
  assert.deepEqual(out.splicedPages, []);
  assert.equal(out.text, [
    ...read.map((p) => `[page ${p.page}]\n${p.text}`),
    `[páginas ${READ + 1}–${N} sin OCR: tiempo agotado]`,
  ].join('\n\n'));
  // Private-use glyphs and U+FFFD, without a plan; a page the engine tried
  // keeps the engine's marker.
  const PUA = `${'\uE001\uE002\uE003 \uE004\uE005 '.repeat(30)}Página 2`;
  const FFFD = '\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD '.repeat(20);
  const FEW_CODES = `${CLEAN} ${CLEAN} Cláusula (cid:7)(cid:8)(cid:9) del anexo ${CLEAN}`;
  assert.ok(mixedPdf.scoreTextLayerPage(FEW_CODES).reasons.includes('cid_glyphs'));
  const glyphs = mixedPdf.spliceTextLayerIntoOcr(
    [{ page: 1, text: 'Uno' }, { page: 2, text: PUA }, { page: 3, text: FFFD }, { page: 4, text: FEW_CODES }],
    [{ page: 1, text: 'Uno (OCR)' }, { page: 2, text: '', reason: 'timeout' }],
    { totalPages: 4, stopReason: 'budget', reasons: { 4: 'garbled' } },
  );
  assert.equal(glyphs.text, [
    '[page 1]\nUno (OCR)',
    '[page 2]\n[página 2 — no legible: tiempo agotado]',
    '[página 3 sin OCR: tiempo agotado]',
    `[page 4]\n[página 4 sin OCR: tiempo agotado — se conserva el texto incrustado del PDF, que parece dañado: puede contener errores]\n${FEW_CODES}`,
  ].join('\n\n'));
  assert.deepEqual(glyphs.splicedPages, [4]);
});

test('merge uses the engine\'s own page marker (blank, vision cap) and a blank page is not «unread»', () => {
  const pages = [{ page: 1, text: CLEAN }, { page: 2, text: '' }, { page: 3, text: '' }];
  const ocrPages = [
    { page: 2, text: '', reason: 'blank', marker: '[página 2 — en blanco]' },
    { page: 3, text: '', reason: 'vision_page_cap', marker: '[página 3 — sin OCR completo: límite de páginas con visión]' },
  ];
  const merged = mixedPdf.mergeMixedPdfText(pages, ocrPages, 25, { ocrTargets: [2, 3], markUnread: true });
  assert.match(merged.text, /\[page 2\]\n\[página 2 — en blanco\]/);
  assert.match(merged.text, /\[page 3\]\n\[página 3 — sin OCR completo: límite de páginas con visión\]/);
  assert.deepEqual(merged.unreadPages, [3]);
});

test('no vision rung can run (GLM-OCR off, cloud off): weak pages are not sent anywhere and do not use the cap', async (t) => {
  const { visionCalls } = await setupPdf(t, {
    pages: 2,
    reads: { 1: { text: GARBAGE, confidence: 40 }, 2: { text: '', confidence: 0 } },
    vision: () => ({ text: 'no debería usarse' }),
  });
  override(t, engine, { ollamaOcr: { isEnabled: () => false } });
  const res = await engine.extractFromPdfImagesStreaming('/fake.pdf');
  assert.equal(visionCalls.length, 0);
  assert.equal(res.ocr.visionPages, 0);
  assert.equal(res.ocr.pageQuality[0].visionReason, 'vision_unavailable');
  // Tesseract did read page 2 and found nothing: «no legible» is honest here.
  assert.match(res.text, /\[page 2\]\n\[página 2 — no legible: sin texto legible\]/);
});
