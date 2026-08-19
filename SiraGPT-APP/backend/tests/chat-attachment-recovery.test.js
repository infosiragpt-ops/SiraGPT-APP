const test = require('node:test');
const assert = require('node:assert/strict');

const {
  wantsBibliographyAnswer,
  shouldRecoverAttachmentResponse,
  buildProcessedFilesContext,
  recoverChatAttachmentResponse,
  _internal,
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
      prompt: 'resume el archivo adjunto',
      response: 'No puedo acceder al contenido del archivo adjunto desde aquí.',
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

test('direct OCR recovery extracts invoice number from image text', () => {
  const context = [
    '### Archivo adjunto 1: factura_4485.png',
    'FACTURA N 4485',
    'Cliente: ACME',
    'Fecha: 2025-03-15',
    'Concepto: Consultoria',
    'TOTAL: 1250 EUR',
  ].join('\n');

  const answer = _internal.buildDirectExtractedFieldAnswer(
    '¿Cuál es el número de factura de la imagen? Solo el número.',
    context,
  );

  assert.equal(answer, '4485');
});

test('direct OCR recovery extracts invoice total without confusing solo numero with invoice number', () => {
  const context = [
    '### Archivo adjunto 1: factura_4485.png',
    'Pregunta: ¿Cuál es el total de la factura? Solo el número.',
    'FACTURA N 4485',
    'Cliente: ACME',
    'TOTAL: 1250 EUR',
  ].join('\n');

  const answer = _internal.buildDirectExtractedFieldAnswer(
    '¿Cuál es el total de la factura? Solo el número.',
    context,
  );

  assert.equal(answer, '1250');
});

test('direct OCR recovery ignores prompt text when invoice number value is absent', () => {
  const context = 'Pregunta: ¿Cuál es el número de factura de la imagen? Solo el número.';
  const answer = _internal.buildDirectExtractedFieldAnswer(
    '¿Cuál es el número de factura de la imagen? Solo el número.',
    context,
  );

  assert.equal(answer, '');
});

test('direct OCR recovery replaces incorrect short invoice answers', () => {
  assert.equal(
    _internal.shouldUseDirectExtractedFieldAnswer({
      prompt: '¿Cuál es el total de la factura? Solo el número.',
      response: '4485',
      directAnswer: '1250',
    }),
    true,
  );
  assert.equal(
    _internal.shouldUseDirectExtractedFieldAnswer({
      prompt: '¿Cuál es el total de la factura? Solo el número.',
      response: '1250',
      directAnswer: '1250',
    }),
    false,
  );
});

test('direct OCR recovery extracts invoice currency as its own field', () => {
  const context = 'FACTURA N 4485 Cliente: ACME Fecha: 2025-03-15 Concepto: Consultoria TOTAL: 1250 EUR';
  const answer = _internal.buildDirectExtractedFieldAnswer(
    '¿En qué moneda está expresado el total de la factura?',
    context,
  );

  assert.match(answer, /EUR/);
  assert.doesNotMatch(answer, /1250/);
});

test('direct OCR recovery stops compact label values at the next label', () => {
  const context = 'FACTURA N 4485 Cliente: ACME Fecha: 2025-03-15 Concepto: Consultoria TOTAL: 1250 EUR';

  assert.match(
    _internal.buildDirectExtractedFieldAnswer('¿Quién es el cliente de la factura?', context),
    /\*\*ACME\*\*/,
  );
  assert.match(
    _internal.buildDirectExtractedFieldAnswer('¿Cuál es el concepto de la factura?', context),
    /\*\*Consultoria\*\*/,
  );
});

test('direct OCR recovery compares non-short answers by extracted value', () => {
  assert.equal(
    _internal.shouldUseDirectExtractedFieldAnswer({
      prompt: 'Del informe el coste de remediación y de la factura el total.',
      response: 'El coste es 12500 EUR y el total de la factura es 1250 EUR.',
      directAnswer: 'El dato solicitado es **1250**.',
    }),
    false,
  );
});

test('attachment recovery retries summaries with raw extracted text when compact context is insufficient', async () => {
  const answer = await recoverChatAttachmentResponse({
    prisma: null,
    userId: 'user-test',
    prompt: 'Resume el informe de seguridad en una sola frase.',
    processedFiles: [{
      name: 'informe_seguridad.pdf',
      mimeType: 'application/pdf',
      extractedText: [
        'INFORME DE SEGURIDAD - 2025',
        'Resumen ejecutivo: durante el periodo auditado el uptime registrado fue del 99.95%.',
        'Se detectaron 3 vulnerabilidades criticas y 8 de severidad media.',
        'Recomendaciones principales: rotar credenciales, activar doble factor y cifrar backups.',
      ].join('\n'),
    }],
    uploadedFileContext: 'Contexto adjunto insuficiente.',
    reason: 'test',
  });

  assert.match(answer, /99\.95|uptime/i);
  assert.match(answer, /vulnerabilidades|seguridad/i);
  assert.doesNotMatch(answer, /no encontr[eé] texto suficiente/i);
});
