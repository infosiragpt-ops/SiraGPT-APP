'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-questions');
const { extractQuestions, buildQuestionsForFiles, renderQuestionsBlock, _internal } = engine;
const { classifyQuestion } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractQuestions('').total, 0);
  assert.equal(extractQuestions(null).total, 0);
});

test('classifyQuestion: wh-en', () => {
  assert.equal(classifyQuestion('What is this?'), 'wh-en');
  assert.equal(classifyQuestion('How does it work?'), 'wh-en');
});

test('classifyQuestion: yes-no', () => {
  assert.equal(classifyQuestion('Does it scale?'), 'yes-no');
  assert.equal(classifyQuestion('Will it ship today?'), 'yes-no');
});

test('classifyQuestion: tag', () => {
  assert.equal(classifyQuestion('This works, right?'), 'tag');
});

test('detects WH question "What is X?"', () => {
  const r = extractQuestions('First sentence. What is the deployment plan?');
  assert.ok(r.questions.some((q) => q.kind === 'wh-en'));
});

test('detects yes-no question', () => {
  const r = extractQuestions('Some prose. Does the system scale?');
  assert.ok(r.questions.some((q) => q.kind === 'yes-no'));
});

test('detects Spanish ¿Qué es X?', () => {
  const r = extractQuestions('Una explicación. ¿Qué es el sistema?');
  assert.ok(r.questions.some((q) => q.kind === 'wh-es'));
});

test('detects ¿Cómo funciona?', () => {
  const r = extractQuestions('Texto. ¿Cómo funciona el algoritmo?');
  assert.ok(r.questions.some((q) => q.kind === 'wh-es'));
});

test('detects tag question "right?"', () => {
  const r = extractQuestions('We agreed, right?');
  assert.ok(r.questions.some((q) => q.kind === 'tag'));
});

test('dedupes identical questions', () => {
  const r = extractQuestions('What is X? What is X?');
  assert.equal(r.questions.length, 1);
});

test('caps questions per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `What about ${i}? `;
  const r = extractQuestions(text);
  assert.ok(r.questions.length <= 20);
});

test('counts byKind', () => {
  const r = extractQuestions('What is X? Does Y? ¿Cómo Z?');
  assert.ok(r.totals['wh-en'] >= 1);
  assert.ok(r.totals['yes-no'] >= 1);
  assert.ok(r.totals['wh-es'] >= 1);
});

test('buildQuestionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'What is X?' },
    { name: 'b.md', extractedText: 'Does Y work?' },
  ];
  const r = buildQuestionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderQuestionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'What is X?' }];
  const r = buildQuestionsForFiles(files);
  const md = renderQuestionsBlock(r);
  assert.match(md, /^## QUESTIONS/);
});

test('renderQuestionsBlock empty when nothing surfaces', () => {
  assert.equal(renderQuestionsBlock({ perFile: [] }), '');
  assert.equal(renderQuestionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildQuestionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'What is X?' },
  ]);
  assert.equal(r.perFile.length, 1);
});
