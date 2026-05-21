const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDocumentDeliveryPolicy,
  detectFormat,
} = require('../src/services/agents/document-delivery-policy');

test('DocumentDeliveryPolicy requires XLSX for tabular KPI work', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Genera un Excel profesional con ventas, costos, margen, fórmulas y dashboard KPI.',
  });

  assert.equal(policy.mode, 'doc_required');
  assert.equal(policy.format, 'xlsx');
  assert.equal(policy.autoGenerate, true);
  assert.equal(policy.palette.id, 'business');
});

test('DocumentDeliveryPolicy requires PPTX for presentation work', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Crea una presentación pitch deck para inversionistas con 12 diapositivas.',
  });

  assert.equal(policy.mode, 'doc_required');
  assert.equal(policy.format, 'pptx');
  assert.equal(policy.template, 'pitch');
});

test('DocumentDeliveryPolicy suggests DOCX for long document analysis without forcing generation', () => {
  const finalText = Array.from({ length: 950 }, (_, idx) => `palabra${idx}`).join(' ');
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Analiza esta tesis de manera académica.',
    finalText,
  });

  assert.equal(policy.mode, 'doc_suggested');
  assert.equal(policy.format, 'docx');
  assert.equal(policy.template, 'academic');
  assert.equal(policy.autoGenerate, false);
});

test('DocumentDeliveryPolicy keeps short conversational turns in chat', () => {
  const policy = buildDocumentDeliveryPolicy({ goal: 'Hola, dame una idea corta.' });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
});

test('DocumentDeliveryPolicy keeps plain transcription requests in chat', () => {
  const transcript = Array.from({ length: 1200 }, (_, idx) => `linea${idx}`).join(' ');
  const policy = buildDocumentDeliveryPolicy({
    goal: 'transcribir este archivo',
    finalText: transcript,
    files: ['uploaded-file-id'],
  });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
  assert.equal(policy.thresholds.transcriptionOnly, true);
});

test('DocumentDeliveryPolicy still creates a file when transcription asks for Word', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'transcribir este archivo en Word profesional',
    files: ['uploaded-file-id'],
  });

  assert.equal(policy.mode, 'doc_required');
  assert.equal(policy.format, 'docx');
  assert.equal(policy.autoGenerate, true);
});

test('DocumentDeliveryPolicy answers attached-document conclusions in chat by default', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'dame 3 párrafos de conclusiones',
    files: ['uploaded-docx-id'],
  });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
  assert.equal(policy.thresholds.fileCount, 1);
});

test('DocumentDeliveryPolicy creates Word only when attached-document conclusions ask for Word', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'dame 3 párrafos de conclusiones en Word',
    files: ['uploaded-docx-id'],
  });

  assert.equal(policy.mode, 'doc_required');
  assert.equal(policy.format, 'docx');
  assert.equal(policy.autoGenerate, true);
});

test('detectFormat honors explicit requested format', () => {
  assert.equal(detectFormat('Haz un informe', 'pdf'), 'pdf');
});

test('DocumentDeliveryPolicy treats "cuál es el título del word?" as chat-only (read intent, not generate)', () => {
  // Regression: user uploads a DOCX in a prior turn, then asks
  // "cuál es el título del word?" on a later turn (no file re-attached).
  // The literal "word" used to match WORDISH_RE and promote the turn
  // to doc_required with autoGenerate=true, generating a brand-new
  // unrelated DOCX instead of answering the question about the
  // already-shared file.
  const policy = buildDocumentDeliveryPolicy({
    goal: 'cual es el titulo del word?',
    files: [],
  });
  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
});

test('DocumentDeliveryPolicy keeps other read-intent phrasings in chat_only', () => {
  for (const goal of [
    'de qué trata el documento?',
    'qué dice el pdf adjunto',
    'cómo se llama el archivo',
    'cuántas páginas tiene el word',
    'resume el word',
    'léeme el pdf',
    'muéstrame el documento',
    'explícame el excel',
  ]) {
    const policy = buildDocumentDeliveryPolicy({ goal, files: [] });
    assert.notEqual(policy.mode, 'doc_required', `"${goal}" must not auto-generate`);
    assert.equal(policy.autoGenerate, false, `"${goal}" must not auto-generate`);
  }
});

test('DocumentDeliveryPolicy still promotes explicit generate-in-word requests', () => {
  // Sanity: the inquiry guard must not weaken legitimate generation
  // requests. "Hazme un word sobre X" and "exporta esto a pdf" still
  // need to land in doc_required.
  for (const goal of [
    'hazme un word sobre la guerra fría',
    'genera un informe en word',
    'crea un documento word',
    'exporta esto a pdf',
    'dame un excel con las ventas',
  ]) {
    const policy = buildDocumentDeliveryPolicy({ goal, files: [] });
    assert.equal(policy.mode, 'doc_required', `"${goal}" must auto-generate`);
    assert.equal(policy.autoGenerate, true, `"${goal}" must auto-generate`);
  }
});

test('DocumentDeliveryPolicy ignores assistant wording when classifying user intent', () => {
  // Regression: a short user question whose assistant draft happens to
  // contain "documento" used to be promoted to doc_required because the
  // classifier was reading goal + finalText combined.
  const policy = buildDocumentDeliveryPolicy({
    goal: 'de que pais es este?',
    finalText: 'No se pudo determinar el país basado en la información disponible en el documento proporcionado.',
    files: ['uploaded-file-id'],
  });

  assert.notEqual(policy.mode, 'doc_required');
  assert.equal(policy.autoGenerate, false);
});
