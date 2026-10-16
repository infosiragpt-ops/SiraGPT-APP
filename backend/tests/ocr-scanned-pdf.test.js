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

test('short form PDFs: lines that differ only in their numbers are content, not stamps — the exact layer is kept', () => {
  const names = ['Ana', 'Luis', 'Rosa', 'Iván', 'Eva'];
  const forms = names.map((name, i) => ({
    page: i + 1,
    text: `Constancia de notas\nAlumno: ${name}\nNota final: ${10 + i}\nFecha: 0${i + 1}/10/2026`,
  }));
  const plan = mixedPdf.planTextLayerOcr(forms);
  assert.equal(plan.kind, 'text');
  assert.equal(plan.counts.stampOnly, 0);
  // Page numbers are still recognised whatever their digits.
  const numbered = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `Escaneado con CamScanner\nPágina ${i + 1} de 6` }));
  assert.equal(mixedPdf.planTextLayerOcr(numbered).kind, 'scanned');
  assert.equal(mixedPdf.isStampOnlyText(forms.map((p) => p.text).join('\n'), 5), false);
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
