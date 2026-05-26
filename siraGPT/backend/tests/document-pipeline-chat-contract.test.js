const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
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
