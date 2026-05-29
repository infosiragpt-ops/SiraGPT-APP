'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAgenticActionRequest } = require('../src/services/agents/agentic-trigger');

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
    'traduce y resume este contrato',
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

test('handles empty / nullish input safely', () => {
  assert.equal(isAgenticActionRequest(''), false);
  assert.equal(isAgenticActionRequest('   '), false);
  assert.equal(isAgenticActionRequest(null), false);
  assert.equal(isAgenticActionRequest(undefined), false);
});
