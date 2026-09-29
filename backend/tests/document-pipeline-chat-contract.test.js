const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const PizZip = require('pizzip');
const {
  runAdvancedDocumentPipeline,
  streamAdvancedDocumentPipeline,
} = require('../src/services/document-pipeline/advanced-document-pipeline');
const { normalizeResearchArtifactInput } = require('../src/services/document-pipeline/research-artifact-input');

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

test('scientific DOCX preserves the approved outline and embeds an editable evidence table', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-doc-science-'));
  const input = normalizeResearchArtifactInput({
    outline: ['Pregunta clínica', 'Método', 'Hallazgos', 'Limitaciones', 'Conclusiones'],
    researchSources: [{
      title: 'Randomized telemedicine trial',
      abstract: 'Results showed improved follow-up.',
      year: 2025,
      doi: '10.1000/trial',
      studyType: 'rct',
      sampleSize: 420,
      keyFinding: 'Improved follow-up compared with usual care.',
    }],
  });
  const result = await runAdvancedDocumentPipeline({
    prompt: 'Crea un Word científico editable sobre telemedicina',
    format: 'docx',
    template: 'academic',
    outputDir,
    outline: input.outline,
    researchSources: input.sources,
    referenceFiles: input.referenceFiles,
  });

  assert.deepEqual(result.plan.sections, input.outline);
  const zip = new PizZip(result.buffer);
  const documentXml = zip.file('word/document.xml')?.asText() || '';
  assert.match(documentXml, /Matriz de evidencia cient[ií]fica/i);
  assert.match(documentXml, /Randomized telemedicine trial/);
  assert.match(documentXml, /10\.1000\/trial/);
  assert.match(documentXml, /w:tbl/);
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

  // Reopen the delivered bytes with the native workbook parser: an XML marker
  // alone does not prove a usable validation rule, range or error action.
  const readbackPath = path.join(outputDir, 'delivered-readback.xlsx');
  await fs.writeFile(readbackPath, result.buffer);
  const { stdout } = await promisify(execFile)(process.env.SANDBOX_PYTHON || 'python3', ['-c', `
import json, sys
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
book = load_workbook(sys.argv[1], data_only=False)
sheet = book.worksheets[0]
numeric = [get_column_letter(col) for col in range(1, sheet.max_column + 1)
           if any(isinstance(sheet.cell(row, col).value, (int, float)) and not isinstance(sheet.cell(row, col).value, bool)
                  for row in range(2, sheet.max_row + 1))]
rules = [{"range": str(rule.sqref), "type": rule.type, "formula": rule.formula1,
          "allowBlank": rule.allowBlank, "showError": rule.showErrorMessage,
          "errorStyle": rule.errorStyle, "error": rule.error}
         for rule in sheet.data_validations.dataValidation]
print(json.dumps({"numericColumns": numeric, "rules": rules}))
`, readbackPath], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const reopened = JSON.parse(stdout);
  assert.ok(reopened.numericColumns.length > 0);
  assert.deepEqual(reopened.rules.map((rule) => rule.range).sort(), reopened.numericColumns.map((col) => `${col}2:${col}1048576`).sort());
  for (const rule of reopened.rules) {
    const col = /^([A-Z]+)2:/.exec(rule.range)?.[1];
    assert.equal(rule.type, 'custom');
    assert.equal(rule.formula, `ISNUMBER(${col}2)`);
    assert.equal(rule.allowBlank, true);
    assert.equal(rule.showError, true);
    assert.equal(rule.errorStyle, 'stop');
    assert.match(rule.error, /número/);
  }
});
