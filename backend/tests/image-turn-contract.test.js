'use strict';

// Prod 2026-09-26 (Grok 4.7): a screenshot of "(a+b)² =" + «resolver este
// problema» ended in «Pensando…» with no answer. Root causes covered here:
//   1. the generate route re-extracted the just-uploaded image in parallel with
//      the upload pipeline (~77 s of OCR + vision-doc 429s) and blocked on it;
//   2. that prep counted against the 45 s first-byte budget, so the turn was
//      aborted before the model was called and ended silently;
//   3. the watchdog abort also stopped the SSE pings → the browser reconnected.

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const singleflight = require('../src/services/file-extraction-singleflight');
const recovery = require('../src/services/chat-attachment-recovery');
const turnOutcome = require('../src/services/turn-outcome');

const USEFUL_TEXT = 'Contenido extraído del documento con suficiente texto útil para responder preguntas sobre él. '.repeat(3);

function fakePrisma(rows) {
  return {
    file: {
      async findUnique({ where }) {
        const row = rows[where.id];
        return row ? { processingStage: row.processingStage, extractedText: row.extractedText } : null;
      },
      async update({ where, data }) {
        rows[where.id] = { ...(rows[where.id] || {}), ...data };
        return rows[where.id];
      },
    },
  };
}

function fakeProcessor() {
  const calls = [];
  return {
    calls,
    async processFile(file) {
      calls.push(file.path);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { extractedText: USEFUL_TEXT };
    },
  };
}

beforeEach(() => singleflight.__resetForTests());

describe('file-extraction-singleflight', () => {
  test('concurrent callers for the same file share ONE extraction', async () => {
    let runs = 0;
    const run = () => new Promise((resolve) => { runs++; setTimeout(() => resolve('texto'), 20); });
    const [a, b] = await Promise.all([
      singleflight.runExtractionOnce('file-1', run),
      singleflight.runExtractionOnce('file-1', run),
    ]);
    assert.equal(runs, 1);
    assert.equal(a, 'texto');
    assert.equal(b, 'texto');
    assert.equal(singleflight.inflightExtraction('file-1'), null, 'the entry clears once settled');
  });

  test('different files and id-less calls do not share', async () => {
    let runs = 0;
    const run = async () => { runs++; return runs; };
    await Promise.all([
      singleflight.runExtractionOnce('a', run),
      singleflight.runExtractionOnce('b', run),
      singleflight.runExtractionOnce(null, run),
    ]);
    assert.equal(runs, 3);
  });

  test('a failed extraction clears so a later attempt can run', async () => {
    await assert.rejects(singleflight.runExtractionOnce('x', async () => { throw new Error('boom'); }));
    assert.equal(await singleflight.runExtractionOnce('x', async () => 'ok'), 'ok');
  });
});

describe('refreshProcessedFileExtracts (turn path)', () => {
  test('images are never re-extracted on the turn path', async () => {
    const processor = fakeProcessor();
    const tmp = path.join(os.tmpdir(), `turn-img-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const files = [{ id: 'img-1', name: 'formula.png', mimeType: 'image/png', path: tmp, extractedText: '' }];
      const out = await recovery.refreshProcessedFileExtracts(fakePrisma({ 'img-1': { processingStage: 'extracting' } }), files, {
        fileProcessor: processor, waitMs: 2000,
      });
      assert.equal(processor.calls.length, 0, 'the pixels go to the model; no OCR on the turn path');
      assert.equal(out[0], files[0]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('a document still extracting in the upload pipeline is awaited, not re-extracted', async () => {
    const processor = fakeProcessor();
    const tmp = path.join(os.tmpdir(), `turn-doc-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, 'pdf');
    const rows = { 'doc-1': { processingStage: 'extracting', extractedText: null } };
    // The pipeline's own extraction is in flight and lands its text in the DB.
    const pipeline = singleflight.runExtractionOnce('doc-1', () => new Promise((resolve) => setTimeout(() => {
      rows['doc-1'] = { processingStage: 'ready', extractedText: USEFUL_TEXT };
      resolve({ extractedText: USEFUL_TEXT });
    }, 60)));
    try {
      const out = await recovery.refreshProcessedFileExtracts(fakePrisma(rows), [
        { id: 'doc-1', name: 'informe.pdf', mimeType: 'application/pdf', path: tmp, extractedText: '' },
      ], { fileProcessor: processor, waitMs: 5000 });
      await pipeline;
      assert.equal(processor.calls.length, 0, 'no second extraction of the same bytes');
      assert.equal(out[0].extractedText, USEFUL_TEXT);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('live progress: waiting for the pipeline is reported with the file name and the words it produced', async () => {
    const processor = fakeProcessor();
    const events = [];
    const tmp = path.join(os.tmpdir(), `turn-progress-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, 'pdf');
    const rows = { 'doc-9': { processingStage: 'extracting', extractedText: null } };
    const pipeline = singleflight.runExtractionOnce('doc-9', () => new Promise((resolve) => setTimeout(() => {
      rows['doc-9'] = { processingStage: 'ready', extractedText: USEFUL_TEXT };
      resolve({ extractedText: USEFUL_TEXT });
    }, 40)));
    try {
      const out = await recovery.refreshProcessedFileExtracts(fakePrisma(rows), [
        { id: 'doc-9', originalName: 'contrato.pdf', mimeType: 'application/pdf', path: tmp, extractedText: '' },
      ], { fileProcessor: processor, waitMs: 5000, onProgress: (ev) => { events.push(ev); throw new Error('sink'); } });
      await pipeline;
      assert.equal(out[0].extractedText, USEFUL_TEXT, 'a throwing sink changes nothing');
      assert.deepEqual(events.map((e) => e.type), ['extract_wait', 'extract_done']);
      assert.equal(events[0].file, 'contrato.pdf');
      assert.equal(events[1].words, USEFUL_TEXT.trim().split(/\s+/).length);
      assert.doesNotMatch(JSON.stringify(events), /Contenido extraído/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('the wait for the pipeline is bounded', async () => {
    const processor = fakeProcessor();
    const rows = { 'doc-2': { processingStage: 'extracting', extractedText: null } };
    const started = Date.now();
    const out = await recovery.refreshProcessedFileExtracts(fakePrisma(rows), [
      { id: 'doc-2', name: 'lento.pdf', mimeType: 'application/pdf', path: '/nonexistent/lento.pdf', extractedText: '' },
    ], { fileProcessor: processor, waitMs: 150, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    assert.ok(Date.now() - started < 2000, 'the turn never blocks past the budget');
    assert.equal(processor.calls.length, 0);
    assert.equal(out[0].extractedText, '');
  });

  test('a ready document without text is extracted once even by concurrent turns', async () => {
    const processor = fakeProcessor();
    const tmp = path.join(os.tmpdir(), `turn-ready-${Date.now()}.docx`);
    fs.writeFileSync(tmp, 'docx');
    const rows = { 'doc-3': { processingStage: 'ready', extractedText: null } };
    const file = { id: 'doc-3', name: 'viejo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', path: tmp, extractedText: '' };
    try {
      const [a, b] = await Promise.all([
        recovery.refreshProcessedFileExtracts(fakePrisma(rows), [file], { fileProcessor: processor }),
        recovery.refreshProcessedFileExtracts(fakePrisma(rows), [file], { fileProcessor: processor }),
      ]);
      assert.equal(processor.calls.length, 1);
      assert.equal(a[0].extractedText, USEFUL_TEXT.trim());
      assert.equal(b[0].extractedText, USEFUL_TEXT.trim());
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('turn-outcome contract', () => {
  test('a user Stop is not a failure', () => {
    assert.equal(turnOutcome.classifyEmptyTurn({ userCancelled: true, ttfbAborted: false }), null);
  });

  test('a lost image explains the empty turn first', () => {
    const out = turnOutcome.classifyEmptyTurn({ ttfbAborted: true, imageLoadFailures: 1 });
    assert.equal(out.category, 'adjunto_perdido');
    assert.match(out.message, /imagen adjunta/);
  });

  test('a system (first-byte) cancellation and an empty reply get honest Spanish messages', () => {
    const ttfb = turnOutcome.classifyEmptyTurn({ ttfbAborted: true });
    assert.equal(ttfb.category, 'cancelado_por_sistema');
    assert.match(ttfb.message, /no empezó a responder a tiempo/);
    const empty = turnOutcome.classifyEmptyTurn({});
    assert.equal(empty.category, 'sin_respuesta');
    assert.match(empty.message, /terminó sin dar una respuesta/);
  });

  test('logTurnOutcome writes one structured [turn-outcome] line', () => {
    const lines = [];
    turnOutcome.logTurnOutcome({ reason: 'sin_respuesta', chatId: 'c1', messageId: 's1', reqId: 'r1', model: 'grok-4.7' }, { warn: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[turn-outcome\] \{/);
    assert.deepEqual(JSON.parse(lines[0].slice('[turn-outcome] '.length)), {
      reason: 'sin_respuesta', chatId: 'c1', messageId: 's1', reqId: 'r1', model: 'grok-4.7',
    });
  });
});

describe('generate route wiring (source contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');

  test('the first-byte watchdog measures from after attachment prep', () => {
    assert.match(src, /let __ttfbClockStartedAt = __generateStartedAt;/);
    assert.match(src, /abortIfFirstByteOver45s\(\{\s*startedAt: __ttfbClockStartedAt,/);
    const reset = src.indexOf('__ttfbClockStartedAt = Date.now();');
    const attachmentsDone = src.indexOf("generateLog.info('documents.recovered_from_history'");
    assert.ok(reset > attachmentsDone && attachmentsDone > 0, 'the clock restarts after attachments are prepared');
  });

  test('SSE pings are not tied to the turn controller', () => {
    assert.match(src, /keepAlive = startGenerateSseHeartbeat\(res, \{ intervalMs: 5000, signal: __heartbeatStop\.signal \}\);/);
    assert.match(src, /res\.once\('close', \(\) => \{ try \{ __heartbeatStop\.abort\(\); \}/);
  });

  test('an empty turn writes an explicit message before persistence', () => {
    const guard = src.indexOf("require('../services/turn-outcome')");
    const tokens = src.indexOf('const tokens = fullResponseContent.length + prompt.length;');
    assert.ok(guard > 0 && guard < tokens, 'guard runs before the reply is persisted');
    assert.match(src, /userCancelled: Boolean\(signal && signal\.aborted && __ttfbAbortedAt == null\)/);
  });

  test('user-message attachments carry a storage-independent public url', () => {
    assert.match(src, /function uploadPublicUrl\(file\)/);
    assert.match(src, /return `\/uploads\/\$\{file\.userId\}\/\$\{file\.filename\}`;/);
  });
});

// Second pass (prod 2026-09-27, after #816): the turn still stalled ~47 s
// because messageAttachments.buildUploadedFileContext → ensureImageOcr ran
// tesseract + the OCR vision fallback (43 s, 0 chars) for an image the upload
// pipeline was still processing, and that prep overran the 45 s first-byte
// budget before the model was called.
describe('request paths never re-extract what the pipeline is processing', () => {
  const messageAttachments = require('../src/services/message-attachments');
  const ocrEngine = require('../src/services/ocr-engine');

  function prismaWithStage(stage, text = null) {
    return {
      file: {
        async findUnique() { return { processingStage: stage, extractedText: text }; },
        async update() { return {}; },
      },
    };
  }

  function stubOcr(t) {
    const calls = [];
    const original = ocrEngine.extractFromImage;
    ocrEngine.extractFromImage = async (p) => { calls.push(p); return { text: 'texto OCR', ocr: {} }; };
    t.after(() => { ocrEngine.extractFromImage = original; });
    return calls;
  }

  test('an image still extracting is not OCR-ed; with waitMs 0 the turn does not wait', async (t) => {
    const calls = stubOcr(t);
    const row = { id: 'img-9', mimeType: 'image/png', originalName: 'f.png', path: __filename, extractedText: null };
    const started = Date.now();
    const out = await messageAttachments.ensureImageOcr(prismaWithStage('extracting'), row, 'u1', { imageTextWaitMs: 0 });
    assert.equal(calls.length, 0);
    assert.equal(out, row);
    assert.ok(Date.now() - started < 1000);
  });

  test('a finished pipeline without useful text is not OCR-ed again', async (t) => {
    const calls = stubOcr(t);
    const row = { id: 'img-10', mimeType: 'image/png', originalName: 'f.png', path: __filename, extractedText: null };
    const out = await messageAttachments.ensureImageOcr(prismaWithStage('ready', ''), row, 'u1');
    assert.equal(calls.length, 0);
    assert.equal(out, row);
  });

  test('a legacy row (no pipeline stage) gets one bounded OCR pass', async (t) => {
    const calls = stubOcr(t);
    const row = { id: 'img-11', mimeType: 'image/png', originalName: 'f.png', path: __filename, extractedText: null };
    const out = await messageAttachments.ensureImageOcr(prismaWithStage(null), row, 'u1');
    assert.equal(calls.length, 1);
    assert.equal(out.extractedText, 'texto OCR');
  });

  test('the chat builds attachment context without waiting for image OCR', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/chat-attachment-recovery.js'), 'utf8');
    assert.match(src, /buildUploadedFileContext\(prisma, \{[\s\S]{0,260}imageTextWaitMs: 0,/);
  });

  test('document analysis does not reprocess a file the pipeline is extracting', async (t) => {
    const fileProcessor = require('../src/services/fileProcessor');
    const original = fileProcessor.processFile;
    let calls = 0;
    fileProcessor.processFile = async () => { calls++; return { extractedText: 'x' }; };
    t.after(() => { fileProcessor.processFile = original; });
    const documentIntelligence = require('../src/services/document-intelligence');
    const prisma = {
      file: {
        async findUnique() { return { processingStage: 'extracting', extractedText: null }; },
        async update() { return {}; },
      },
    };
    const file = { id: 'doc-9', userId: 'u1', originalName: 'a.pdf', filename: 'a.pdf', mimeType: 'application/pdf', path: __filename, size: 10, extractedText: null, createdAt: new Date() };
    await documentIntelligence.analyzeFile(prisma, { userId: 'u1', fileRecord: file, force: true });
    assert.equal(calls, 0, 'no second extraction while the pipeline works on it');
  });

  test('attachment prep has its own budget; 45 s applies to the model only', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
    assert.match(src, /let __ttfbLimitMs = \(\(\) => \{/);
    assert.match(src, /startedAt: __ttfbClockStartedAt,\s*limitMs: __ttfbLimitMs,/);
    assert.match(src, /__ttfbClockStartedAt = Date\.now\(\);\s*__ttfbLimitMs = undefined;/);
  });
});
