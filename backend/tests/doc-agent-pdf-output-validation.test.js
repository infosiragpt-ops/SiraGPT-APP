'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runDocumentAgent } = require('../src/services/doc-agent');

const instruction = 'En el PDF cambia solamente «Proyecto revisado» por «Proyecto final». Conserva «Aprobado» y CONTROL_SIN_CAMBIOS.';

async function pdfWith(title, { control = true } = {}) {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 50, y: 710, size: 12, font });
  page.drawText('Aprobado', { x: 50, y: 680, size: 12, font });
  if (control) page.drawText('CONTROL_SIN_CAMBIOS', { x: 50, y: 650, size: 12, font });
  return Buffer.from(await document.save());
}

function clientThatWrites(bytes) {
  const encoded = bytes.toString('base64');
  let calls = 0;
  return { chat: { completions: { async create() {
    calls += 1;
    return { choices: [{ message: calls === 1 ? {
      content: null,
      tool_calls: [{ id: 'write-pdf', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: `printf '%s' '${encoded}' | base64 -d > /workspace/outputs/editado.pdf` }),
      } }],
    } : { content: 'Terminé la edición.', tool_calls: [] } }] };
  } } } };
}

async function runWith(source, output) {
  const events = [];
  const result = await runDocumentAgent({
    files: [{ name: 'original.pdf', buffer: source }],
    instruction, model: 'test-selected-model', client: clientThatWrites(output),
    route: 'sandbox', driver: 'local', maxAttempts: 1,
    onEvent: (event) => events.push({ type: event.type, reason: event.reason }),
  });
  return { result, events };
}

test('an unreadable PDF is rejected before the document editor can publish it', async () => {
  const source = await pdfWith('Proyecto revisado');
  const { result, events } = await runWith(source, Buffer.from('definitely not a PDF'));
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].valid, false);
  assert.ok(events.some((event) => event.type === 'output_invalid' && event.reason === 'pdf_unreadable'));
});

test('a byte-different PDF without the requested text change is rejected', async () => {
  const source = await pdfWith('Proyecto revisado');
  const unchanged = Buffer.concat([source, Buffer.from('\n% harmless trailing comment\n')]);
  const { result, events } = await runWith(source, unchanged);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].valid, false);
  assert.ok(events.some((event) => event.type === 'output_invalid' && event.reason === 'pdf_edit_unverified'));
});

test('a reopened PDF passes when only the requested text changes at the same position', async () => {
  const source = await pdfWith('Proyecto revisado');
  const edited = await pdfWith('Proyecto final');
  const { result } = await runWith(source, edited);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].valid, true);
  assert.equal(result.stoppedReason, 'final');
});

test('a PDF that drops an unrelated control is rejected despite containing the new title', async () => {
  const source = await pdfWith('Proyecto revisado');
  const edited = await pdfWith('Proyecto final', { control: false });
  const { result, events } = await runWith(source, edited);
  assert.equal(result.outputs[0].valid, false);
  assert.ok(events.some((event) => event.type === 'output_invalid' && event.reason === 'pdf_edit_unverified'));
});
