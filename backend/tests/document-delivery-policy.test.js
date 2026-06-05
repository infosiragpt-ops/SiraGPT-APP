const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDocumentDeliveryPolicy,
  normalizeDocumentPolicyCoherence,
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

test('DocumentDeliveryPolicy keeps cross-document analysis with PDF/DOCX references in chat', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Usando todos los documentos adjuntos, calcula el total real, explica la contradiccion entre PDF y DOCX e indica que cifra final debe usarse.',
    files: ['memo-txt', 'report-docx', 'metrics-xlsx', 'risk-pdf'],
  });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
  assert.equal(policy.thresholds.fileCount, 4);
  assert.equal(policy.thresholds.explicitOutput, false);
});

test('DocumentDeliveryPolicy honors explicit no-file directives even with create/matrix wording', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'A partir de los documentos adjuntos, crea una matriz breve de riesgos y decisiones. No crees archivos.',
    files: ['memo-txt', 'report-docx', 'metrics-xlsx', 'risk-pdf'],
  });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
  assert.equal(policy.thresholds.chatOnlyDirective, true);
});

test('DocumentDeliveryPolicy keeps executive recommendations in chat by default', () => {
  const policy = buildDocumentDeliveryPolicy({
    goal: 'Cruza la hoja de metricas con el informe ejecutivo y el memo. Dame 3 recomendaciones ejecutivas priorizadas.',
    files: ['memo-txt', 'report-docx', 'metrics-xlsx'],
  });

  assert.equal(policy.mode, 'chat_only');
  assert.equal(policy.autoGenerate, false);
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

test('DocumentDeliveryPolicy reason never contradicts autoGenerate for any built policy', () => {
  // Regression for the agent_task_queued log: mode:doc_required +
  // autoGenerate:true paired with reason "documento sugerido, no
  // automatico". A required deliverable must never carry a suggestion
  // reason, and a suggestion reason must never carry autoGenerate:true.
  const goals = [
    'Genera un informe profesional, extenso y detallado sobre el mercado peruano con análisis y conclusiones.',
    'Hazme un word completo sobre la guerra fría con metodología y referencias.',
    'Crea un excel corporativo con varias hojas, fórmulas y validaciones.',
    'Prepara una presentación pitch para inversionistas con 20 diapositivas.',
    'dame una idea corta',
    'analiza esta tesis académica de investigación',
  ];
  for (const goal of goals) {
    const longText = Array.from({ length: 1200 }, (_, idx) => `palabra${idx}`).join(' ');
    const policy = buildDocumentDeliveryPolicy({ goal, finalText: longText });
    const suggestsOptional = /no\s+autom[aá]tic|sugerid|opcional/i.test(policy.reason);
    if (policy.autoGenerate) {
      assert.equal(policy.mode, 'doc_required', `"${goal}" autoGenerate implies doc_required`);
      assert.equal(suggestsOptional, false, `"${goal}" forced doc must not have a suggestion reason: ${policy.reason}`);
    }
    if (suggestsOptional) {
      assert.equal(policy.autoGenerate, false, `"${goal}" suggestion reason must not force generation`);
      assert.notEqual(policy.mode, 'doc_required', `"${goal}" suggestion reason must not be doc_required`);
    }
  }
});

test('normalizeDocumentPolicyCoherence downgrades doc_required when reason says not automatic', () => {
  const contradictory = {
    mode: 'doc_required',
    format: 'docx',
    template: 'business',
    complexity: 'high',
    autoGenerate: true,
    reason: 'Respuesta prevista extensa; documento sugerido, no automatico.',
  };
  const fixed = normalizeDocumentPolicyCoherence(contradictory);
  assert.equal(fixed.mode, 'doc_suggested');
  assert.equal(fixed.autoGenerate, false);
});

test('normalizeDocumentPolicyCoherence derives autoGenerate strictly from mode', () => {
  assert.equal(
    normalizeDocumentPolicyCoherence({ mode: 'doc_required', reason: 'Word requerido.', autoGenerate: false }).autoGenerate,
    true,
  );
  assert.equal(
    normalizeDocumentPolicyCoherence({ mode: 'doc_suggested', reason: 'densidad suficiente', autoGenerate: true }).autoGenerate,
    false,
  );
  assert.equal(
    normalizeDocumentPolicyCoherence({ mode: 'chat_only', reason: 'corta', autoGenerate: true }).autoGenerate,
    false,
  );
});

test('normalizeDocumentPolicyCoherence leaves coherent required policies untouched', () => {
  const coherent = {
    mode: 'doc_required',
    format: 'docx',
    autoGenerate: true,
    reason: 'Entregable documental explícito; Word requerido.',
  };
  assert.equal(normalizeDocumentPolicyCoherence(coherent), coherent);
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

test('DocumentDeliveryPolicy treats source maps over attachments as chat-only unless a file format is requested', () => {
  const inlinePolicy = buildDocumentDeliveryPolicy({
    goal: 'Crea un mapa de fuentes: enumera cada archivo adjunto y que dato principal aporta. No inventes archivos.',
    files: ['file-txt-1', 'file-pdf-1'],
  });
  assert.equal(inlinePolicy.mode, 'chat_only');
  assert.equal(inlinePolicy.autoGenerate, false);

  const wordPolicy = buildDocumentDeliveryPolicy({
    goal: 'Crea un mapa de fuentes en Word con cada archivo adjunto.',
    files: ['file-txt-1', 'file-pdf-1'],
  });
  assert.equal(wordPolicy.mode, 'doc_required');
  assert.equal(wordPolicy.autoGenerate, true);
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
