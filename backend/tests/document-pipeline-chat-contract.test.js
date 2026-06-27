const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const {
  runAdvancedDocumentPipeline,
  streamAdvancedDocumentPipeline,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

test('document SSE output does not expose internal prompt contracts', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-'));
  const events = [];
  for await (const event of streamAdvancedDocumentPipeline({
    prompt: 'Creame en un word un chiste',
    format: 'docx',
    outputDir,
  })) {
    events.push(event);
  }

  const final = events.find((event) => event.type === 'final');
  assert.ok(final, 'expected final SSE event');
  const visible = JSON.stringify({
    content: final.content,
    title: final.file?.title,
    filename: final.file?.filename,
    explanation: final.file?.explanation,
  });
  assert.doesNotMatch(visible, /siraGPT professional execution contract/i);
  assert.doesNotMatch(visible, /Generate a polished downloadable file/i);
  assert.equal(final.file.format, 'docx');
  assert.equal(final.file.metrics.passed, true);
});

test('document pipeline incorporates authenticated reference-file metadata and scrubs telemetry excerpts', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-refs-'));
  const telemetryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-telemetry-'));
  const result = await runAdvancedDocumentPipeline({
    prompt: 'Crea un word con resumen del documento adjunto',
    format: 'docx',
    outputDir,
    telemetryDir,
    referenceFiles: [{
      id: 'file_1',
      originalName: 'tesis-rsn.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12345,
      extractedText: 'Este texto extraído del archivo debe poder usarse en el documento final, pero no quedar expuesto en telemetría sin control.',
    }],
  });

  assert.equal(result.validation.passed, true);
  assert.equal(result.plan.referenceFiles.length, 1);
  assert.equal(result.plan.referenceFiles[0].name, 'tesis-rsn.docx');
  assert.ok(result.plan.referenceBriefs[0].excerpt.includes('texto extraído'));

  const telemetry = JSON.parse(await fs.readFile(result.telemetryPath, 'utf8'));
  assert.equal(telemetry.plan.referenceFiles.length, 1);
  assert.equal(telemetry.plan.referenceFiles[0].extractedChars > 0, true);
  assert.equal(telemetry.plan.referenceBriefs, undefined);
});

test('document pipeline embeds uploaded image references into generated DOCX', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-image-'));
  const telemetryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-image-telemetry-'));
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-image-uploads-'));
  const userUploadDir = path.join(uploadRoot, 'user_1');
  await fs.mkdir(userUploadDir, { recursive: true });
  const imagePath = path.join(userUploadDir, 'captura.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );
  await fs.writeFile(imagePath, png);

  const previousUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadRoot;
  let result;
  try {
    result = await runAdvancedDocumentPipeline({
      prompt: 'Crea esto en un Word editable. Reproduce la ficha visual de la imagen adjunta lo mejor posible.',
      format: 'docx',
      outputDir,
      telemetryDir,
      referenceFiles: [{
        id: 'img_1',
        originalName: 'captura.png',
        filename: 'captura.png',
        mimeType: 'image/png',
        size: png.length,
        extractedText: '',
      }],
    });
  } finally {
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
  }

  assert.equal(result.validation.passed, true);
  assert.equal(result.plan.referenceFiles[0].isImage, true);
  assert.ok(result.plan.referenceBriefs[0].excerpt.includes('Imagen adjunta'));

  const zip = new PizZip(result.buffer);
  const mediaEntries = Object.keys(zip.files).filter((entry) => /^word\/media\//.test(entry));
  assert.ok(mediaEntries.length >= 1, 'expected at least one embedded media entry in the DOCX');

  const documentXml = zip.file('word/document.xml')?.asText() || '';
  assert.match(documentXml, /Im[aá]genes adjuntas de referencia|Material de referencia incorporado/i);

  const telemetry = JSON.parse(await fs.readFile(result.telemetryPath, 'utf8'));
  assert.equal(telemetry.plan.referenceFiles[0].localPath, undefined);
});

test('document pipeline generates a validated XLSX without missing runtime dependencies', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-xlsx-'));
  const telemetryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-chat-xlsx-telemetry-'));
  const result = await runAdvancedDocumentPipeline({
    prompt: 'Crea un Excel con ventas mensuales, costos, margen, validaciones y resumen ejecutivo.',
    format: 'xlsx',
    outputDir,
    telemetryDir,
  });

  assert.equal(result.validation.passed, true);
  assert.match(result.artifact.filename, /\.xlsx$/);
  assert.equal(result.artifact.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(result.buffer.length > 8_000, 'expected a non-empty workbook');

  const zip = new PizZip(result.buffer);
  const entries = Object.keys(zip.files);
  assert.ok(entries.includes('xl/workbook.xml'));
  assert.ok(entries.some((entry) => entry.startsWith('xl/charts/')), 'expected chart XML');

  const sheetXml = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .map((entry) => zip.file(entry)?.asText() || '')
    .join('\n');
  assert.match(sheetXml, /<f[ >]/, 'expected formulas');
  assert.match(sheetXml, /conditionalFormatting/, 'expected conditional formatting');
  assert.match(sheetXml, /dataValidation/, 'expected data validation');
  assert.match(sheetXml, /<pane\b/, 'expected frozen pane');
});
