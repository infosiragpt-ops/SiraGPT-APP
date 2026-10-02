'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAgenticActionRequest,
  isArtifactDeliverableRequest,
} = require('../src/services/agents/agentic-trigger');

test('triggers on the five explicit create categories (documents/images/videos/charts/organigrams)', () => {
  const yes = [
    'Hazme un organigrama de mi empresa',
    'genera una imagen de un gato astronauta',
    'créame un video corto sobre el producto',
    'necesito una gráfica de ventas por trimestre',
    'redacta un documento en Word con el resumen',
  ];
  for (const m of yes) {
    assert.equal(isAgenticActionRequest(m), true, `should trigger: ${m}`);
  }
});

test('triggers on Spanish create / transform requests', () => {
  const yes = [
    'diseña una presentación en powerpoint',
    'exporta esto a Excel',
    'hazme un PDF con el informe',
    'dibuja un diagrama de flujo del proceso',
    'crea un dashboard de KPIs',
    'elabora una infografía de los resultados',
    'arma una línea de tiempo del proyecto',
    'genera un mapa mental sobre el tema',
    'construye una tabla comparativa en una hoja de cálculo',
    'traduce y resume este contrato en un documento Word',
  ];
  for (const m of yes) {
    assert.equal(isAgenticActionRequest(m), true, `should trigger: ${m}`);
  }
});

test('triggers on English create requests', () => {
  const yes = [
    'create a bar chart of revenue',
    'make a mind map about climate change',
    'generate a slide deck for the pitch',
    'build a dashboard with the metrics',
    'draw a flowchart of the signup flow',
    'write a report and export it to pdf',
    'design an infographic about the survey',
  ];
  for (const m of yes) {
    assert.equal(isAgenticActionRequest(m), true, `should trigger: ${m}`);
  }
});

test('does NOT trigger on plain conversational messages', () => {
  const no = [
    'hola',
    '¿cómo estás?',
    'gracias por tu ayuda',
    '¿qué hora es?',
    'cuéntame sobre la segunda guerra mundial',
    'me gusta el café por la mañana',
    '¿cuál es la capital de Francia?',
    'buenos días',
  ];
  for (const m of no) {
    assert.equal(isAgenticActionRequest(m), false, `should NOT trigger: ${m}`);
  }
});

test('does NOT trigger on pure text-composition (no artifact, no tool) — these go to fast plain chat', () => {
  // Regression: "redacta en 9 líneas" was wrongly routed into the agentic
  // loop, which intermittently returned an empty answer ("El asistente dejó
  // de responder"). Pure redact/resume/translate/compose tasks with no
  // deliverable noun must be handled by a normal chat completion.
  const no = [
    'redacta en 9 líneas este texto sobre construcción sostenible',
    'resume esto en un párrafo',
    'tradúceme esta frase al inglés',
    'escribe un correo de agradecimiento',
    'redacta un resumen breve de lo anterior',
    'translate this sentence to Spanish',
    'summarize the following text in three lines',
  ];
  for (const m of no) {
    assert.equal(isAgenticActionRequest(m), false, `should NOT trigger: ${m}`);
  }
});

test('handles empty / nullish input safely', () => {
  assert.equal(isAgenticActionRequest(''), false);
  assert.equal(isAgenticActionRequest('   '), false);
  assert.equal(isAgenticActionRequest(null), false);
  assert.equal(isAgenticActionRequest(undefined), false);
});

test('isArtifactDeliverableRequest gates attachment turns on verb + noun', () => {
  // BUILD-a-deliverable: creation verb applied to an artifact noun → true.
  const yes = [
    'genera una tabla en Excel con los datos de este archivo',
    'conviértelo a PDF',
    'créame un PowerPoint con el resumen',
    'haz un gráfico con estos números',
    'export this to a spreadsheet',
    'build a dashboard from the attached data',
  ];
  for (const m of yes) {
    assert.equal(isArtifactDeliverableRequest(m), true, `should be a deliverable: ${m}`);
  }

  // Ask-ABOUT the doc (no creation verb, or a bare reference noun) → false.
  // These must stay on the fast plain stream — the doc text is already injected.
  const no = [
    'dame un resumen en 200 palabras',
    'cuál es el título de la investigación?',
    'resume este archivo',
    'qué dice el documento sobre el presupuesto?',
    'analiza este documento',
    'de qué trata el pdf?',
    '',
    null,
    undefined,
  ];
  for (const m of no) {
    assert.equal(isArtifactDeliverableRequest(m), false, `should NOT be a deliverable: ${m}`);
  }
});

test('typo / caps / accent tolerant edit detection (Luis prod message + paraphrases)', () => {
  const { isDocumentEditRequest, isFuzzyDocumentEditRequest } = require('../src/services/agents/agentic-trigger');
  for (const prompt of [
    'EN EL MISMO WORD QIERO QUE AGREGES COMENTARIOS EN OBSERVACIONES PORFVAOR',
    'ponle comentarios en observaciones', 'mete observaciones a cada pregunta', 'escribe en la columna observaciones',
    'llena observaciones', 'comenta cada ítem', 'AGREGA OBSERVACIONES', 'quiero que agreges observaciones',
    'pon observaciones en cada fila', 'completa la columna de observaciones', 'rellena observaciones con comentarios positivos',
    'qiero que modifiqes el titulo del documento',
  ]) assert.equal(isDocumentEditRequest(prompt), true, prompt);
  for (const prompt of ['¿qué dice el documento?', 'explica el word adjunto', 'resume el archivo', 'hola como estas', 'cambia de tema']) {
    assert.equal(isFuzzyDocumentEditRequest(prompt), false, prompt);
  }
});

test('the SPEC eval prompts route as edits; bare highlight/paraphrase questions do not', () => {
  const { isDocumentEditRequest, isHighlightEditRequest } = require('../src/services/agents/agentic-trigger');
  for (const prompt of [
    'Sube a 15 los ensayos de compresión no confinada y resalta esa celda.',
    'Parafrasea el párrafo que cita a García (2020) sin tocar la cita.',
    'subraya el título', 'resáltalo en amarillo', 'resalta «baja capacidad portante»',
    'Cambia 2024 por 2025 en la portada.',
  ]) assert.equal(isDocumentEditRequest(prompt), true, prompt);
  assert.equal(isHighlightEditRequest('resalta los puntos clave del documento'), false);
  for (const prompt of [
    'resalta los puntos clave del documento', 'destaca las ideas principales del texto',
    'sube el archivo a drive', 'hazme una portada para mi libro',
  ]) assert.equal(isDocumentEditRequest(prompt), false, prompt);
});


test('descriptive colors are not fuzzy document edits, including prefaced visual requests', () => {
  const { isDocumentEditRequest, isFuzzyDocumentEditRequest } = require('../src/services/agents/agentic-trigger');
  const prompts = [
    'Prueba de reconocimiento visual: identifica el texto exacto de la imagen y describe las dos figuras, sus colores y su posición. Responde solo con lo que observas en el archivo adjunto.',
    'Por favor, dime los colores de las figuras en el archivo adjunto.',
    'Necesito identificar los colores y el texto del archivo.',
    'Me interesa saber qué colores hay en este documento.',
  ];
  for (const prompt of prompts) {
    assert.equal(isFuzzyDocumentEditRequest(prompt), false, prompt);
    assert.equal(isDocumentEditRequest(prompt), false, prompt);
  }
  for (const prompt of [
    'Colorea el título del documento de naranja.',
    'Coloca el título del archivo al inicio.',
    'Quiero que coloques el título en la primera página.',
    'QIERO QUE AGREGES COMENTARIOS EN OBSERVACIONES DEL DOCUMENTO',
    'Cambia los colores de la tabla del archivo.',
  ]) {
    assert.equal(isDocumentEditRequest(prompt), true, prompt);
  }
});
