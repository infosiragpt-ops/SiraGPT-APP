'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  measureAnswerStructure,
  checkFormatCompliance,
  buildFormatRepairPrompt,
  reflowIntoParagraphs,
} = require('../src/services/format-compliance');

const DRIFTED_FIVE_BLOCKS = [
  '## Resumen del trabajo de investigación',
  'El trabajo analiza la gestión hídrica en comunidades rurales de Ayacucho. Utiliza un diseño mixto con encuestas a 120 hogares.',
  '**Hallazgos principales:**',
  '- El 64% de los hogares no tiene acceso continuo al agua.\n- Las juntas vecinales carecen de capacitación técnica.',
  'Como conclusión, se recomienda fortalecer las juntas y crear un fondo de mantenimiento. ¿Quieres que profundice en algún punto?',
].join('\n\n');

test('«dame un resumen en 2 párrafos»: flags headings/bullets/wrong count and accepts exactly two prose paragraphs', () => {
  const drift = checkFormatCompliance(DRIFTED_FIVE_BLOCKS, 'dame un resumen en 2 párrafos');
  assert.equal(drift.applicable, true);
  assert.equal(drift.compliant, false);
  assert.equal(drift.wantedParagraphs, 2);
  assert.ok(drift.reasons.includes('headings-present'));
  assert.ok(drift.reasons.includes('bullets-present'));

  const good = 'El trabajo analiza la gestión hídrica en Ayacucho con un diseño mixto.\n\nConcluye que deben fortalecerse las juntas vecinales.';
  const ok = checkFormatCompliance(good, 'dame un resumen en dos párrafos');
  assert.equal(ok.compliant, true);
  assert.equal(measureAnswerStructure(good).paragraphs, 2);
});

test('single paragraph, word limit and list requests are checked; prompts without constraints are not applicable', () => {
  assert.equal(checkFormatCompliance('Uno.\n\nDos.', 'resúmelo en un solo párrafo').compliant, false);
  assert.equal(checkFormatCompliance('Todo en uno. Bien redactado.', 'resúmelo en un solo párrafo').compliant, true);

  const long = Array.from({ length: 160 }, (_, i) => `palabra${i}`).join(' ');
  const words = checkFormatCompliance(long, 'explícalo en máximo 100 palabras');
  assert.equal(words.compliant, false);
  assert.ok(words.reasons.some((r) => r.startsWith('words:')));

  assert.equal(checkFormatCompliance('Texto corrido sin viñetas.', 'dame una lista de los puntos clave').compliant, false);
  assert.equal(checkFormatCompliance('- Uno\n- Dos', 'dame una lista de los puntos clave').compliant, true);

  const none = checkFormatCompliance(DRIFTED_FIVE_BLOCKS, '¿de qué trata el documento?');
  assert.equal(none.applicable, false);
  assert.equal(checkFormatCompliance('hola', 'hola').applicable, false);
});

test('repair prompt is precise and the zero-model reflow yields exactly N paragraphs from the answer’s own sentences', () => {
  const check = checkFormatCompliance(DRIFTED_FIVE_BLOCKS, 'dame un resumen en 2 párrafos');
  const prompt = buildFormatRepairPrompt(check, 'es');
  assert.match(prompt, /exactamente 2 párrafos/);
  assert.match(prompt, /Sin título, sin encabezados, sin viñetas/);
  assert.match(prompt, /no inventes/);

  const reflowed = reflowIntoParagraphs(DRIFTED_FIVE_BLOCKS, 2);
  assert.equal(reflowed.split('\n\n').length, 2);
  assert.equal(checkFormatCompliance(reflowed, check.spec).compliant, true);
  assert.doesNotMatch(reflowed, /##|\*\*|^- /m);
  assert.match(reflowed, /64% de los hogares/);

  assert.equal(reflowIntoParagraphs('Una sola oración.', 3), '', 'never fabricates paragraphs');
});

test('ai-service wires the format check after the quality guard on the same model with the answer kept as context', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/ai-service.js'), 'utf8');
  assert.match(src, /require\('\.\/format-compliance'\)/);
  const block = src.slice(src.indexOf('Format obedience'), src.indexOf('return fullResponseContent;', src.indexOf('Format obedience')));
  assert.match(block, /if \(qualityGuard\)|checkFormatCompliance\(answerBody, userPrompt/);
  assert.match(block, /provider: currentProvider,\s*model: currentRuntimeModel/);
  assert.match(block, /\{ role: 'assistant', content: answerBody \}/);
  assert.match(block, /reflowIntoParagraphs/);
  assert.match(block, /replace: true, content: replacement/);
  assert.match(src, /messagesOverride = null/);
});
