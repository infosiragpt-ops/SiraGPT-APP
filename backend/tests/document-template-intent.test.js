'use strict';

// «Crea una ppt con este formato» + Plantilla.pptx is a TEMPLATE FILL: the
// attachment is the format of a new deliverable, never its content and never
// a surgical-edit target. Pins the detector that the runner, the request
// brief and the doc-agent all consume.

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectTemplateIntent, hasTemplateCue, describeTemplateIntent, formatForTemplate } = require('../src/services/document-template-intent');

test('«usando este formato» + a .pptx names the attachment as the template of a new deck', () => {
  const r = detectTemplateIntent({ prompt: 'crea una presentación de 8 láminas sobre marketing digital usando este formato', fileNames: ['Plantilla-UPN.pptx'] });
  assert.equal(r.isTemplateFill, true);
  assert.equal(r.templateFile, 'Plantilla-UPN.pptx');
  assert.equal(r.outputFormat, 'pptx');
  assert.deepEqual(r.contentFiles, []);
  assert.equal(r.reason, 'format_cue');
  assert.equal(describeTemplateIntent(r), 'siguiendo el formato de «Plantilla-UPN.pptx»');
});

test('a .potx is a template even without a cue; its output is a .pptx', () => {
  const r = detectTemplateIntent({ prompt: 'haz una ppt sobre la ley de protección de datos, 10 diapositivas', fileNames: ['formato-institucional.potx'] });
  assert.equal(r.isTemplateFill, true);
  assert.equal(r.templateFile, 'formato-institucional.potx');
  assert.equal(r.outputFormat, 'pptx');
  assert.equal(r.reason, 'template_extension');
  assert.equal(formatForTemplate('x.potx'), 'pptx');
  assert.equal(formatForTemplate('x.dotx'), 'docx');
  assert.equal(formatForTemplate('x.xltx'), 'xlsx');
});

test('content + template pair: «pasa mi informe al formato de la plantilla» picks the file named as the format', () => {
  const r = detectTemplateIntent({ prompt: 'pasa mi informe al formato de la plantilla', fileNames: ['informe.docx', 'plantilla-tesis.docx'] });
  assert.equal(r.isTemplateFill, true);
  assert.equal(r.templateFile, 'plantilla-tesis.docx');
  assert.deepEqual(r.contentFiles, ['informe.docx']);
  assert.equal(r.outputFormat, 'docx');
});

test('«con esta plantilla haz una ppt» and «como este» are cues; «usa esta plantilla para una ppt» needs no create verb', () => {
  assert.equal(detectTemplateIntent({ prompt: 'con esta plantilla haz una ppt sobre ventas', fileNames: ['base.pptx'] }).isTemplateFill, true);
  assert.equal(detectTemplateIntent({ prompt: 'haz una presentación como esta sobre nuestros resultados', fileNames: ['deck-ejemplo.pptx'] }).isTemplateFill, true);
  assert.equal(detectTemplateIntent({ prompt: 'usa esta plantilla para una ppt de 6 láminas sobre nuestros resultados Q3', fileNames: ['Plantilla.pptx'] }).isTemplateFill, true);
  assert.equal(hasTemplateCue('siguiendo el diseño adjunto'), true);
  assert.equal(hasTemplateCue('resume este documento'), false);
});

test('scoped edits of the attached deck are NOT template fills, even when they mention the format', () => {
  for (const prompt of [
    'cambia el título de la lámina 3 a "Resultados 2026" y nada más',
    'pon el fondo azul oscuro solo en la diapositiva 2',
    'agrega una lámina al final con el mismo diseño que la 4, titulada Conclusiones, con 3 viñetas',
    'corrige la redacción del párrafo 4 manteniendo el formato',
  ]) {
    const r = detectTemplateIntent({ prompt, fileNames: ['deck.pptx'] });
    assert.equal(r.isTemplateFill, false, prompt);
  }
});

test('an attached deck with no format wording is content, not a template; SiraGPT artifacts never qualify', () => {
  assert.equal(detectTemplateIntent({ prompt: 'resume esta presentación en 5 puntos', fileNames: ['deck.pptx'] }).isTemplateFill, false);
  assert.equal(detectTemplateIntent({ prompt: 'crea una ppt sobre el embarazo', fileNames: ['notas.docx'] }).isTemplateFill, false);
  const r = detectTemplateIntent({ prompt: 'crea una ppt con este formato', fileNames: ['propuesta.pptx'], priorArtifactNames: ['propuesta.pptx'] });
  assert.equal(r.isTemplateFill, false);
  assert.equal(detectTemplateIntent({ prompt: 'crea una ppt con este formato', fileNames: ['logo.png'] }).isTemplateFill, false);
});

test('never throws on odd input', () => {
  assert.doesNotThrow(() => detectTemplateIntent({}));
  assert.doesNotThrow(() => detectTemplateIntent({ prompt: null, fileNames: [null, {}, { name: 'x.potx' }] }));
  assert.equal(detectTemplateIntent({ prompt: 'ppt', fileNames: [{ originalName: 'f.potx' }] }).templateFile, 'f.potx');
});
