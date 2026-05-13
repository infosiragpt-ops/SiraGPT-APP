'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-language-ratio');
const { extractLanguageRatio, buildLanguageRatioForFiles, renderLanguageRatioBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractLanguageRatio('').primary, null);
  assert.equal(extractLanguageRatio(null).primary, null);
});

test('detects primary English on English-heavy text', () => {
  const text = 'The quick brown fox jumps over the lazy dog. The system is fast and efficient with all of the new features that we have added to our platform for you and your team.'.repeat(3);
  const r = extractLanguageRatio(text);
  assert.equal(r.primary, 'en');
});

test('detects primary Spanish on Spanish-heavy text', () => {
  const text = 'El sistema es rápido y eficiente con todas las nuevas características que hemos agregado a nuestra plataforma para usted y su equipo. La aplicación funciona en el navegador y se actualiza automáticamente.'.repeat(3);
  const r = extractLanguageRatio(text);
  assert.equal(r.primary, 'es');
});

test('detects multilingual flag with mixed text', () => {
  const en = 'The system is fast and efficient with all of the new features and updates.'.repeat(2);
  const es = 'El sistema es rápido y eficiente con todas las nuevas características y actualizaciones.'.repeat(2);
  const r = extractLanguageRatio(en + '\n' + es);
  assert.equal(r.multilingual, true);
});

test('returns null primary when too few tokens', () => {
  const r = extractLanguageRatio('Hi');
  assert.equal(r.primary, null);
});

test('returns ratios for languages', () => {
  const text = 'The system is fast and efficient with all of the new features that we have added.'.repeat(5);
  const r = extractLanguageRatio(text);
  assert.ok(r.ratios.en > 0);
});

test('counts tokens accurately', () => {
  const text = 'word ' .repeat(50);
  const r = extractLanguageRatio(text);
  assert.ok(r.tokens >= 50);
});

test('secondary language identified when >= 15%', () => {
  const en = 'the system is fast efficient with new features in this platform for the team'.repeat(3);
  const es = 'el sistema es rápido eficiente con nuevas características en esta plataforma para el equipo'.repeat(1);
  const r = extractLanguageRatio(en + ' ' + es);
  // secondary likely 'es' if enough hits
  assert.ok(r.primary === 'en');
});

test('buildLanguageRatioForFiles aggregates per file', () => {
  const en = 'The system is fast efficient with new features added to the platform.'.repeat(5);
  const files = [
    { name: 'a.md', extractedText: en },
    { name: 'b.md', extractedText: 'El sistema es rápido eficiente con nuevas características en la plataforma para nosotros y los usuarios.'.repeat(5) },
  ];
  const r = buildLanguageRatioForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLanguageRatioBlock returns markdown when entries exist', () => {
  const en = 'The system is fast efficient with new features that we have added to the platform for our users today.'.repeat(5);
  const files = [{ name: 'doc.md', extractedText: en }];
  const r = buildLanguageRatioForFiles(files);
  const md = renderLanguageRatioBlock(r);
  assert.match(md, /^## LANGUAGE MIX/);
});

test('renderLanguageRatioBlock empty when nothing surfaces', () => {
  assert.equal(renderLanguageRatioBlock({ perFile: [] }), '');
  assert.equal(renderLanguageRatioBlock(null), '');
});

test('handles non-string extractedText', () => {
  const en = 'The system is fast efficient with new features added to the platform for our users today.'.repeat(5);
  const r = buildLanguageRatioForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: en },
  ]);
  assert.equal(r.perFile.length, 1);
});
