'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const fastpath = require('../src/services/document-extract-fastpath');
const fileProcessor = require('../src/services/fileProcessor');
const officeImages = require('../src/services/office-image-extractor');
const { createWorkbook, addRowsWorksheet, writeWorkbookBuffer, selectWorkbookWorksheets, DEFAULT_MAX_SHEETS } = require('../src/services/xlsx-safe-workbook');

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

function slideXml(texts) {
  const runs = texts.map((t) => `<a:t>${t}</a:t>`).join('');
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${runs}</p:spTree></p:cSld></p:sld>`;
}

async function writeMinimalPptx(filePath, slides) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  slides.forEach((texts, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(texts));
  });
  zip.file('ppt/notesSlides/notesSlide2.xml', slideXml(['Notes Placeholder', 'Remember the budget slide']));
  await fsp.writeFile(filePath, zip.generate({ type: 'nodebuffer' }));
}

test('default flags: skip RAG until send, skip external parsers, pdftotext on', async () => {
  await withEnv({
    SIRAGPT_RAG_SKIP_UNTIL_SEND: undefined,
    SIRAGPT_EXTERNAL_PARSER_FIRST: undefined,
    SIRAGPT_PDFTOTEXT: undefined,
    SIRAGPT_DEFER_OFFICE_IMAGE_OCR: undefined,
    SIRAGPT_UPLOAD_CONCURRENCY: undefined,
    SIRAGPT_ASYNC_FILE_PROCESSING_CONCURRENCY: undefined,
    SIRAGPT_OFFICE_VISION_MIN_TEXT: undefined,
    SIRAGPT_OFFICE_IMAGE_VISION: undefined,
  }, () => {
    assert.equal(fastpath.shouldSkipRagUntilSend(), true);
    assert.equal(fastpath.shouldRunExternalParsers(), false);
    assert.equal(fastpath.pdftotextEnabled(), true);
    assert.equal(fastpath.shouldDeferOfficeImageOcr(), true);
    assert.equal(fastpath.uploadConcurrency(), 4);
    assert.equal(fastpath.asyncFileProcessingConcurrency(), 8);
    assert.equal(fastpath.officeVisionMinText(), 800);
    assert.equal(fastpath.shouldAllowOfficeImageVision('short'), true);
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(800)), false);
  });
});

test('office vision stays on for short text and can be forced', async () => {
  await withEnv({ SIRAGPT_OFFICE_VISION_MIN_TEXT: undefined, SIRAGPT_OFFICE_IMAGE_VISION: undefined }, () => {
    assert.equal(fastpath.shouldAllowOfficeImageVision('logo-only deck'), true);
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(799)), true);
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(800)), false);
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(800), { allowVision: true }), true);
    assert.equal(fastpath.shouldAllowOfficeImageVision('short', { allowVision: false }), false);
  });
  await withEnv({ SIRAGPT_OFFICE_IMAGE_VISION: '0' }, () => {
    assert.equal(fastpath.shouldAllowOfficeImageVision('tiny'), false);
  });
  await withEnv({ SIRAGPT_OFFICE_IMAGE_VISION: '1' }, () => {
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(5000)), true);
  });
  await withEnv({ SIRAGPT_OFFICE_VISION_MIN_TEXT: '200' }, () => {
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(199)), true);
    assert.equal(fastpath.shouldAllowOfficeImageVision('x'.repeat(200)), false);
  });
});

test('env flags can restore legacy extract-then-index behaviour', async () => {
  await withEnv({
    SIRAGPT_RAG_SKIP_UNTIL_SEND: '0',
    SIRAGPT_EXTERNAL_PARSER_FIRST: '1',
    SIRAGPT_PDFTOTEXT: '0',
    SIRAGPT_DEFER_OFFICE_IMAGE_OCR: '0',
  }, () => {
    assert.equal(fastpath.shouldSkipRagUntilSend(), false);
    assert.equal(fastpath.shouldRunExternalParsers(), true);
    assert.equal(fastpath.pdftotextEnabled(), false);
    assert.equal(fastpath.shouldDeferOfficeImageOcr(), false);
  });
});

test('createStageTimer records per-stage and total ms', async () => {
  const timer = fastpath.createStageTimer('unit');
  await new Promise((r) => setTimeout(r, 8));
  timer.mark('pdftotext');
  await new Promise((r) => setTimeout(r, 8));
  timer.mark('ocr');
  const snap = timer.snapshot();
  assert.equal(snap.label, 'unit');
  assert.ok(snap.totalMs >= 14);
  assert.equal(snap.stages.length, 2);
  assert.equal(snap.stages[0].name, 'pdftotext');
  assert.ok(snap.stages[0].ms >= 6);
  assert.equal(snap.stages[1].name, 'ocr');
});

test('tryPdftotext uses injected exec and splits form-feed pages', async () => {
  const calls = [];
  const fakeExec = async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: 'Cover letter\nHello world\f\nPage two body\f\n' };
  };
  const out = await fastpath.tryPdftotext('/tmp/doc.pdf', { execFile: fakeExec });
  assert.equal(out.used, true);
  assert.equal(out.reason, 'pdftotext');
  assert.equal(out.pageCount, 2);
  assert.equal(out.pages[0].page, 1);
  assert.match(out.pages[0].text, /Hello world/);
  assert.match(out.pages[1].text, /Page two body/);
  assert.match(out.text, /\[page 1\]/);
  assert.match(out.text, /\[page 2\]/);
  assert.equal(calls[0].bin, 'pdftotext');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-layout', '-enc', 'UTF-8']);
});

test('tryPdftotext falls through when binary is missing or output is empty', async () => {
  const missing = await fastpath.tryPdftotext('/tmp/doc.pdf', {
    execFile: async () => {
      const err = new Error('spawn pdftotext ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(missing.used, false);
  assert.equal(missing.reason, 'unavailable');

  const empty = await fastpath.tryPdftotext('/tmp/scan.pdf', {
    execFile: async () => ({ stdout: '\f\n\f' }),
  });
  assert.equal(empty.used, false);
  assert.equal(empty.reason, 'empty');
});

test('extractPptxSlides keeps every slide plus notes in order', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-fast-'));
  const filePath = path.join(dir, 'deck.pptx');
  try {
    await writeMinimalPptx(filePath, [
      ['Agenda', 'Kickoff'],
      ['Budget', 'Q3 spend'],
      ['Risks', 'Vendor delay'],
    ]);
    const out = await fastpath.extractPptxSlides(filePath);
    assert.equal(out.ok, true);
    assert.equal(out.slideCount, 3);
    assert.equal(out.slidesWithText, 3);
    assert.match(out.text, /\[Slide 1 — Agenda\]/);
    assert.match(out.text, /\[Slide 2 — Budget\]/);
    assert.match(out.text, /\[Slide 3 — Risks\]/);
    assert.match(out.text, /Vendor delay/);
    assert.match(out.text, /Remember the budget slide/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('processPowerPoint uses per-slide extract and can defer image OCR', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-proc-'));
  const filePath = path.join(dir, 'deck.pptx');
  try {
    await writeMinimalPptx(filePath, [
      ['Slide A', 'alpha'],
      ['Slide B', 'bravo'],
    ]);
    const text = await fileProcessor.processPowerPoint(filePath, { deferOfficeImageOcr: true });
    assert.match(text, /PowerPoint presentation — 2 slide\(s\) extracted/);
    assert.match(text, /\[Slide 1 — Slide A\]/);
    assert.match(text, /\[Slide 2 — Slide B\]/);
    assert.doesNotMatch(text, /Texto extraído de/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('processExcel default sheet cap is 20 so typical workbooks are not truncated', () => {
  assert.equal(DEFAULT_MAX_SHEETS, 20);
  const workbook = createWorkbook();
  for (let i = 1; i <= 12; i += 1) {
    addRowsWorksheet(workbook, `S${i}`, [['H'], [`row-${i}`]]);
  }
  const selection = selectWorkbookWorksheets(workbook);
  assert.equal(selection.worksheets.length, 12);
  assert.equal(selection.skipped, 0);
});

test('processExcel extracts every selected sheet', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-fast-'));
  const filePath = path.join(dir, 'book.xlsx');
  try {
    const workbook = createWorkbook();
    for (let i = 1; i <= 6; i += 1) {
      addRowsWorksheet(workbook, `Sheet${i}`, [['Name'], [`value-${i}`]]);
    }
    await fsp.writeFile(filePath, await writeWorkbookBuffer(workbook));
    const extracted = await fileProcessor.processExcel(filePath, { deferOfficeImageOcr: true });
    assert.match(extracted, /Excel workbook — 6 sheet\(s\)/);
    for (let i = 1; i <= 6; i += 1) {
      assert.match(extracted, new RegExp(`Sheet: Sheet${i}`));
      assert.match(extracted, new RegExp(`value-${i}`));
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('office image OCR fans out with bounded concurrency', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-ocr-par-'));
  const filePath = path.join(dir, 'doc.docx');
  try {
    const zip = new PizZip();
    zip.file('word/media/image1.png', Buffer.alloc(5000, 1));
    zip.file('word/media/image2.png', Buffer.alloc(5000, 2));
    zip.file('word/media/image3.png', Buffer.alloc(5000, 3));
    await fsp.writeFile(filePath, zip.generate({ type: 'nodebuffer' }));

    let inFlight = 0;
    let maxInFlight = 0;
    const fakeEngine = {
      extractFromImage: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { text: 'ocr-line', ocr: { status: 'ok' } };
      },
    };

    const out = await officeImages.extractImagesText(filePath, {
      ocrEngine: fakeEngine,
      concurrency: 2,
    });
    assert.equal(out.results.length, 3);
    assert.equal(out.results.filter((r) => r.text === 'ocr-line').length, 3);
    assert.ok(maxInFlight <= 2, `expected concurrency ≤2, got ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `expected parallel work, maxInFlight=${maxInFlight}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('_withEmbeddedImageText skips OCR when deferred', async () => {
  const text = await fileProcessor._withEmbeddedImageText('/no/such/file.docx', 'BASE', 'docx', {
    deferOfficeImageOcr: true,
  });
  assert.equal(text, 'BASE');
});

test('_withEmbeddedImageText disables vision when office text is already long', async () => {
  const calls = [];
  const orig = officeImages.extractImageAppendix;
  officeImages.extractImageAppendix = async (_path, opts) => {
    calls.push(opts || {});
    return '';
  };
  try {
    await fileProcessor._withEmbeddedImageText('/tmp/doc.docx', 'x'.repeat(800), 'docx', {
      deferOfficeImageOcr: false,
    });
    await fileProcessor._withEmbeddedImageText('/tmp/scan.docx', 'foto', 'docx', {
      deferOfficeImageOcr: false,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].allowVision, false);
    assert.equal(calls[1].allowVision, true);
  } finally {
    officeImages.extractImageAppendix = orig;
  }
});

test('processFile returns stage timings for a text file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-txt-fast-'));
  const filePath = path.join(dir, 'note.txt');
  try {
    await fsp.writeFile(filePath, 'Documento de prueba con texto suficiente para extraer.');
    const result = await fileProcessor.processFile({
      path: filePath,
      originalname: 'note.txt',
      mimetype: 'text/plain',
      size: 60,
    });
    assert.equal(result.success, true);
    assert.match(result.extractedText, /Documento de prueba/);
    assert.ok(result.timings);
    assert.ok(Number.isFinite(result.timings.totalMs));
    assert.ok(Array.isArray(result.timings.stages));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('embed batch default is 128 and env-clamped', async () => {
  await withEnv({ SIRAGPT_EMBED_BATCH: undefined }, () => {
    assert.equal(fastpath.embedBatchSize(), 128);
  });
  await withEnv({ SIRAGPT_EMBED_BATCH: '256' }, () => {
    assert.equal(fastpath.embedBatchSize(), 256);
  });
  await withEnv({ SIRAGPT_EMBED_BATCH: '9999' }, () => {
    assert.equal(fastpath.embedBatchSize(), 512);
  });
});

test('PR 387 preview-gate labels stay unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../lib/document-preview-gate.ts'), 'utf8');
  assert.match(src, /export const CONVERSION_LOADING_LABEL = "Generando vista previa…"/);
  assert.match(src, /export const INDEXING_STATUS_LABEL = "Subido · preparando índice…"/);
  assert.match(src, /export const UPLOAD_STATUS_LABEL = "Subiendo…"/);
  assert.match(src, /RAG indexing does not block/);
});

test('PR 386 R2 stream contract remains in the upload static middleware', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/middleware/upload-static-access.js'), 'utf8');
  assert.match(src, /r2-stream/);
  assert.match(src, /pipeStreamToResponse|readStream/);
});

test('files route keeps skip-until-send RAG and applies the office-vision gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
  assert.match(src, /shouldSkipRagUntilSend/);
  assert.match(src, /shouldAllowOfficeImageVision/);
  assert.match(src, /uploadConcurrency/);
  assert.match(src, /asyncFileProcessingConcurrency/);
  assert.doesNotMatch(src, /SIRAGPT_UPLOAD_CONCURRENCY \|\| '5'/);
});
