const test = require('node:test');
const assert = require('node:assert/strict');

const {
  wantsBibliographyAnswer,
  shouldRecoverAttachmentResponse,
  buildProcessedFilesContext,
} = require('../src/services/chat-attachment-recovery');
const { buildBibliographyFallbackAnswer } = require('../src/services/agents/agent-task-runner');

test('wantsBibliographyAnswer detects APA bibliography requests', () => {
  assert.equal(wantsBibliographyAnswer('dame la bibliografia en apa 7ma edición porfavor'), true);
  assert.equal(wantsBibliographyAnswer('resume el documento'), false);
});

test('shouldRecoverAttachmentResponse flags operational disclosure and file-read failures', () => {
  const files = [{ id: 'f1', extractedText: 'some text' }];
  assert.equal(
    shouldRecoverAttachmentResponse({
      prompt: 'analiza el pdf',
      response: 'Nota operativa: activé una respuesta segura porque el runtime principal no estuvo disponible.',
      processedFiles: files,
    }),
    true,
  );
  assert.equal(
    shouldRecoverAttachmentResponse({
      prompt: 'dame la bibliografia apa',
      response: 'Recibí tu archivo, pero no pude leerlo con claridad en este intento.',
      processedFiles: files,
    }),
    true,
  );
  assert.equal(
    shouldRecoverAttachmentResponse({
      prompt: 'hola',
      response: 'Hola, ¿en qué puedo ayudarte hoy?',
      processedFiles: [],
    }),
    false,
  );
});

test('bibliography recovery path produces APA references from spreadsheet context', () => {
  const ctx = [
    '### Archivo adjunto 1: base_sucesion.xlsx',
    '| Título del articulo | Autores | Año de publicacion |',
    '| Sucesión intestada y herederos | García López, M. | 2021 |',
  ].join('\n');
  const answer = buildBibliographyFallbackAnswer({
    goal: 'dame la bibliografia en apa 7ma edición',
    uploadedFileContext: ctx,
  });
  assert.match(answer, /Referencias \(APA 7\)/);
  assert.match(answer, /Sucesión intestada/);
  assert.doesNotMatch(answer, /Nota operativa|runtime principal|respuesta segura/i);
});

test('buildProcessedFilesContext preserves raw Excel extraction as recovery input', () => {
  const context = buildProcessedFilesContext([
    {
      id: 'file-xlsx',
      name: 'base_sucesion_intestada_seleccionados.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extractedText: [
        'Excel workbook — 1 sheet(s): Referencias',
        'Sheet: Referencias',
        'Columns (3): Título del articulo | Autores | Año de publicacion',
        'Total data rows: 1',
        '---',
        'Sucesión intestada y herederos\tGarcía López, M.\t2021',
      ].join('\n'),
    },
  ]);

  const answer = buildBibliographyFallbackAnswer({
    goal: 'cita la bibliografia en apa 7ma edicion',
    uploadedFileContext: context,
  });

  assert.match(answer, /García López, M\./);
  assert.match(answer, /Sucesión intestada y herederos/);
});
