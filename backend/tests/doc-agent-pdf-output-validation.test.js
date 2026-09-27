'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runDocumentAgent } = require('../src/services/doc-agent');
const { collectValidOutputs } = require('../src/services/agent-runner');

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

async function runAgentOutputCheck(source, output, request) {
  const events = [];
  const outputs = await collectValidOutputs(
    { collectOutputs: async () => [{ name: 'editado.pdf', buffer: output }] },
    (event) => events.push(event),
    { files: [{ name: 'original.pdf', buffer: source }], instruction: request, isEdit: true },
  );
  return { output: outputs[0], events };
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

test('the general agent rejects a readable PDF that keeps the old quoted title', async () => {
  const source = await pdfWith('Proyecto revisado');
  const unchanged = Buffer.concat([source, Buffer.from('\n% harmless trailing comment\n')]);
  const { output, events } = await runAgentOutputCheck(source, unchanged, instruction);
  assert.equal(output.valid, false);
  assert.equal(output.validation?.passed, false);
  assert.ok(events.some((event) => event.type === 'output_invalid' && event.reason === 'pdf_edit_unverified'));
});

test('the general agent rejects an unreadable PDF before it can be marked valid', async () => {
  const source = await pdfWith('Proyecto revisado');
  const { output, events } = await runAgentOutputCheck(source, Buffer.from('definitely not a PDF'), instruction);
  assert.equal(output.valid, false);
  assert.equal(output.validation?.passed, false);
  assert.ok(events.some((event) => event.type === 'output_invalid' && event.reason === 'pdf_unreadable'));
});

test('an unquoted literal PDF replacement is checked before marking the artifact valid', async () => {
  const source = await pdfWith('Proyecto revisado');
  const unchanged = Buffer.concat([source, Buffer.from('\n% harmless trailing comment\n')]);
  const request = 'Cambia Proyecto revisado por Proyecto final. Conserva Aprobado y CONTROL_SIN_CAMBIOS.';
  const { output } = await runAgentOutputCheck(source, unchanged, request);
  assert.equal(output.valid, false);
  assert.equal(output.validation?.passed, false);
  const edited = await pdfWith('Proyecto final');
  const { output: accepted } = await runAgentOutputCheck(source, edited, request);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.validation?.passed, true);
});

test('the general agent accepts a verified PDF literal edit', async () => {
  const source = await pdfWith('Proyecto revisado');
  const edited = await pdfWith('Proyecto final');
  const { output } = await runAgentOutputCheck(source, edited, instruction);
  assert.equal(output.valid, true);
  assert.equal(output.validation?.passed, true);
});
