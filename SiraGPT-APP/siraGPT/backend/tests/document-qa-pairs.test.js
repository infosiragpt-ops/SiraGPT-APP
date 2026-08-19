'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-qa-pairs');
const { extractQaPairs, buildQaForFiles, renderQaBlock, _internal } = engine;
const { looksLikeQuestion } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractQaPairs('').total, 0);
  assert.equal(extractQaPairs(null).total, 0);
});

test('looksLikeQuestion: ?-suffix and English wh-words', () => {
  assert.ok(looksLikeQuestion('How do I reset?'));
  assert.ok(looksLikeQuestion('What is the cost'));
  assert.ok(!looksLikeQuestion('This is a statement.'));
});

test('looksLikeQuestion: Spanish ¿ prefix and wh-words', () => {
  assert.ok(looksLikeQuestion('¿Cómo recupero la contraseña?'));
  assert.ok(looksLikeQuestion('Qué pasa si fallo'));
});

test('detects "Q: foo? A: bar." pattern', () => {
  const text = 'Q: How do I reset my password?\nA: Use the reset link in the login page.';
  const r = extractQaPairs(text);
  assert.equal(r.pairs.length, 1);
  assert.match(r.pairs[0].question, /reset my password/i);
});

test('detects "Question: foo? Answer: bar." pattern', () => {
  const text = 'Question: What is the SLA?\nAnswer: The SLA is 99.9% monthly uptime.';
  const r = extractQaPairs(text);
  assert.ok(r.pairs.some((p) => /SLA/i.test(p.question)));
});

test('detects Spanish "Pregunta / Respuesta" pattern', () => {
  const text = 'Pregunta: ¿Cómo recupero la contraseña?\nRespuesta: Sigue el enlace que aparece en el correo.';
  const r = extractQaPairs(text);
  assert.ok(r.pairs.some((p) => /contrase/i.test(p.question)));
});

test('detects numbered FAQ pattern', () => {
  const text = '1. How do I cancel my subscription?\nYou cancel by going to Settings > Billing.\n\n2. Where do I see invoices?\nIn the Billing tab.';
  const r = extractQaPairs(text);
  assert.ok(r.pairs.length >= 1);
});

test('detects markdown-style **Question?** pattern', () => {
  const text = '**How do I enable two-factor authentication?**\nGo to Settings > Security and toggle 2FA.';
  const r = extractQaPairs(text);
  assert.ok(r.pairs.some((p) => /two-factor/i.test(p.question)));
});

test('rejects statement-only "answers" without questions', () => {
  const text = 'Background: this section covers terminology.\nIntroduction: this product is built for X.';
  const r = extractQaPairs(text);
  assert.equal(r.pairs.length, 0);
});

test('dedupes identical questions across patterns', () => {
  const text = 'Q: How do I reset?\nA: Use the link.\nQuestion: How do I reset?\nAnswer: Use the link.';
  const r = extractQaPairs(text);
  // Either one or two pairs depending on dedup grain; assert non-duplicate behaviour
  const uniqueQ = new Set(r.pairs.map((p) => p.question.toLowerCase().slice(0, 30)));
  assert.equal(uniqueQ.size, r.pairs.length);
});

test('caps pairs per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) {
    text += `\n\nQ: How do I do thing ${i}?\nA: You do thing ${i} by following the steps in section ${i}.`;
  }
  const r = extractQaPairs(text);
  assert.ok(r.pairs.length <= 14);
});

test('buildQaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Q: How do I reset?\nA: Use the link.' },
    { name: 'b.md', extractedText: 'Pregunta: ¿Cómo cancelo?\nRespuesta: Ve a Configuración.' },
  ];
  const r = buildQaForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderQaBlock returns markdown when pairs exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'Q: How do I reset?\nA: Use the link.' }];
  const r = buildQaForFiles(files);
  const md = renderQaBlock(r);
  assert.match(md, /^## Q&A PAIRS/);
});

test('renderQaBlock empty when no pairs', () => {
  assert.equal(renderQaBlock({ perFile: [] }), '');
  assert.equal(renderQaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildQaForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Q: foo?\nA: bar.' }]);
  assert.ok(Array.isArray(r.perFile));
});
