'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPptxTheme, inferRequestedHex } = require('../src/services/document-pipeline/pptx-design-system');
const { designThemeForTask, isSlideBackgroundColorRequest, isDesignUpgradeRequest, shouldRunAgentRunner, isRunnerOnlyDocumentTurn } = require('../src/services/agent-runner');

test('series and chart element colors do not repaint the whole presentation', () => {
  for (const request of [
    'crea una ppt con barras azules y naranjas',
    'gráfica de líneas: Norte #1F4E78, Centro #ED7D31 y Sur #70AD47',
    'rediseña la presentación con la serie Ventas roja y Costes verde',
    'pon la leyenda en #111827 y los títulos azules',
    'usa una paleta azul y naranja en la presentación',
  ]) {
    assert.equal(inferRequestedHex(request), null, request);
    assert.ok(!pickPptxTheme({ prompt: request }).id.startsWith('user-color:'), request);
    assert.notEqual(designThemeForTask(request).colorLocked, true, request);
  }
});

test('an explicit background remains independent of series colors and their order', () => {
  for (const request of [
    'gráficas: Norte #1F4E78 y Centro #ED7D31; fondo #FFFFFF',
    'fondo blanco, barras azules y naranjas',
    'fondo de la presentación #FFFFFF; gráfica Norte #1F4E78',
    'usa #1F4E78 para la serie Norte y fondo general #FFFFFF',
  ]) {
    assert.equal(inferRequestedHex(request), 'FFFFFF', request);
    assert.equal(designThemeForTask(request).palette.bg, 'FFFFFF', request);
  }
});

test('a chart-local or negated background is not a global background', () => {
  for (const request of [
    'un gráfico con fondo #112233 y barras naranjas',
    'pon el fondo del gráfico blanco y su serie azul',
    'barras verdes sin fondo #FF0000',
  ]) {
    assert.equal(inferRequestedHex(request), null, request);
  }
});

test('combined background and chart requests must run the full agent instead of paint-only shortcut', () => {
  for (const request of [
    'fondo blanco y serie Norte azul',
    'ponlas todas blancas y cambia la gráfica a barras verdes',
    'uniformiza el fondo azul y agrega dos columnas de datos',
  ]) assert.equal(isSlideBackgroundColorRequest(request), false, request);
  assert.equal(isSlideBackgroundColorRequest('ponlas todas rosadas'), true);
  assert.equal(designThemeForTask('ponlas todas rosadas').palette.bg, 'FFC0CB');
  assert.equal(designThemeForTask('cambia el fondo a naranja').palette.bg, 'F97316');
});

test('precise chart follow-ups enter the file editor without restyling the whole file', () => {
  for (const request of [
    'rediseña solo la gráfica del Excel',
    'mejora el diseño de la gráfica del Excel',
    'cambia la paleta de la gráfica del Excel a azul y naranja',
    'mejora el gráfico 1 del Excel',
    'rediseña únicamente la gráfica de la diapositiva 2',
    'mejora las gráficas y conserva las otras hojas',
  ]) {
    for (const format of ['xlsx', 'pptx']) {
      assert.equal(isDesignUpgradeRequest(request, { officeTarget: format }), false, request);
      assert.equal(shouldRunAgentRunner({ text: request, hasPriorArtifacts: true, priorArtifactFormat: format }), true, request);
      assert.equal(isRunnerOnlyDocumentTurn(request, { priorArtifactFormat: format }), true, request);
    }
  }
  assert.equal(shouldRunAgentRunner({ text: 'mejora el gráfico 1' }), false);
  assert.equal(shouldRunAgentRunner({ text: '¿Cómo puedo mejorar el gráfico 1?', hasPriorArtifacts: true, priorArtifactFormat: 'xlsx' }), false);
  assert.equal(isDesignUpgradeRequest('rediseña todo el Excel', { officeTarget: 'xlsx' }), true);
});
