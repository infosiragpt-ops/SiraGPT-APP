'use strict';

/**
 * End-to-end guard for the "texto seleccionable" quality bar: generate a
 * PDF through the same pdfkit path the artifact engine uses, with Spanish
 * accents, typographic punctuation, Greek letters and math symbols, then
 * re-parse it and assert every sentinel character survives the round trip.
 *
 * Before the Unicode font fix this test fails: Helvetica is WinAnsi-only
 * and mangles σ, ∑, “ ”, —, ≤ into garbage or drops them entirely.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

const { registerUnicodeFont } = require('../src/services/document/pdf-fonts');

// pdf-parse (pdf.js v1.10) leaks parser state across calls: the second
// extraction of a different buffer in the same process throws "bad XRef
// entry" even for structurally valid PDFs. Each extraction therefore runs
// in a clean child process.
async function extractPdfText(buffer) {
  const tmp = path.join(os.tmpdir(), `siragpt-pdf-unicode-${process.pid}-${Date.now()}.pdf`);
  await fsp.writeFile(tmp, buffer);
  try {
    const script = `
      const fs = require('fs');
      require('pdf-parse')(fs.readFileSync(process.argv[1])).then(r => {
        process.stdout.write(JSON.stringify({ ok: true, text: r.text }));
      }, err => {
        process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      });
    `;
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', script, tmp], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    if (!parsed.ok) throw new Error(`pdf-parse failed: ${parsed.error}`);
    return parsed.text;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function renderPdfToBuffer(lines) {
  const doc = new PDFDocument({ margin: 56, size: 'A4' });
  const fontResult = registerUnicodeFont(doc);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', resolve));

  for (const line of lines) {
    doc.fontSize(12).text(line);
    doc.moveDown();
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), embedded: fontResult.embedded };
}

test('generated PDF keeps accented Spanish text selectable', async () => {
  const { buffer } = await renderPdfToBuffer([
    'Informe de tesis: análisis ñandú, corazón y medición',
  ]);
  assert.ok(buffer.includes(Buffer.from('%PDF-')));
  const parsed = await extractPdfText(buffer);
  assert.match(parsed, /ñandú/);
  assert.match(parsed, /corazón/);
  assert.match(parsed, /análisis/);
});

test('generated PDF preserves typographic punctuation, Greek and math symbols', async () => {
  const sentinels = ['“citas”', '—guion largo—', 'sigma σ', 'suma ∑', 'menor o igual ≤'];
  const { buffer } = await renderPdfToBuffer(sentinels);
  const parsed = await extractPdfText(buffer);
  for (const s of sentinels) {
    assert.ok(parsed.includes(s), `missing sentinel in extracted text: ${s}`);
  }
});

test('artifact engine renders a PDF whose saved bytes keep unicode intact', async () => {
  // saveArtifact is destructured into artifact-engine at import time; to
  // observe the exact bytes it would persist we stub the task-tools module
  // BEFORE requiring the engine.
  let savedPayload = null;
  const savedPath = require.resolve('../src/services/agents/task-tools');
  require.cache[savedPath] = {
    id: savedPath,
    filename: savedPath,
    loaded: true,
    exports: {
      saveArtifact: (args) => {
        savedPayload = args;
        return {
          id: 'test-artifact',
          filename: args.filename,
          mime: args.mime,
          sizeBytes: Buffer.from(args.base64, 'base64').length,
          downloadUrl: '/test/out.pdf',
        };
      },
      EXTENSION_TO_MIME: {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        pdf: 'application/pdf',
        svg: 'image/svg+xml',
        csv: 'text/csv',
        md: 'text/markdown',
      },
      INTERNAL: { validateAgentArtifactBuffer: () => ({ passed: true, technicalScore: 100, qualityScore: 100 }) },
    },
  };
  const { executeArtifactTool } = require('../src/services/sira/artifact-engine');

  const result = await executeArtifactTool('create_academic_report', {
    title: 'Reporte Ñandú σ ∑',
    sections: [
      {
        heading: 'Resumen “ejecutivo” — con guion',
        body: 'El corazón del análisis σ: valores ≤ esperados y suma ∑ verificada.',
      },
    ],
    filename: 'reporte-unicode-test.pdf',
  }, {});

  assert.equal(result.status, 'success');
  assert.ok(savedPayload, 'saveArtifact was not called');
  assert.equal(savedPayload.mime, 'application/pdf');

  const buffer = Buffer.from(savedPayload.base64, 'base64');
  const parsed = await extractPdfText(buffer);
  for (const s of ['Ñandú', 'σ', '∑', '“ejecutivo”', '—', '≤', 'corazón', '∑ verificada']) {
    assert.ok(parsed.includes(s), `artifact PDF lost sentinel: ${s}`);
  }
});
