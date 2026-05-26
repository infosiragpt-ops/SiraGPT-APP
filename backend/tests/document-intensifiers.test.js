'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-intensifiers');
const { extractIntensifiers, buildIntensifiersForFiles, renderIntensifiersBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractIntensifiers('').total, 0);
  assert.equal(extractIntensifiers(null).total, 0);
});

test('detects "very"', () => {
  const r = extractIntensifiers('This is very important.');
  assert.ok(r.entries.some((e) => e.word === 'very'));
});

test('detects "extremely"', () => {
  const r = extractIntensifiers('Extremely fast performance.');
  assert.ok(r.entries.some((e) => e.word === 'extremely'));
});

test('detects "absolutely"', () => {
  const r = extractIntensifiers('Absolutely critical to ship today.');
  assert.ok(r.entries.some((e) => e.word === 'absolutely'));
});

test('detects Spanish "muy"', () => {
  const r = extractIntensifiers('Es muy importante.');
  assert.ok(r.entries.some((e) => e.word === 'muy'));
});

test('detects Spanish "extremadamente"', () => {
  const r = extractIntensifiers('Extremadamente rápido.');
  assert.ok(r.entries.some((e) => e.word === 'extremadamente'));
});

test('detects "increíblemente"', () => {
  const r = extractIntensifiers('Es increíblemente eficiente.');
  assert.ok(r.entries.some((e) => /incre[íi]blemente/.test(e.word)));
});

test('reports density per 1k words', () => {
  const text = 'very '.repeat(10) + 'word '.repeat(100);
  const r = extractIntensifiers(text);
  assert.ok(r.density > 0);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Very item ${i} word${i}. `;
  const r = extractIntensifiers(text);
  assert.ok(r.entries.length <= 24);
});

test('buildIntensifiersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Very important.' },
    { name: 'b.md', extractedText: 'Extremely fast.' },
  ];
  const r = buildIntensifiersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIntensifiersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Very fast.' }];
  const r = buildIntensifiersForFiles(files);
  const md = renderIntensifiersBlock(r);
  assert.match(md, /^## INTENSIFIERS/);
});

test('renderIntensifiersBlock empty when nothing surfaces', () => {
  assert.equal(renderIntensifiersBlock({ perFile: [] }), '');
  assert.equal(renderIntensifiersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIntensifiersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Very fast.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
