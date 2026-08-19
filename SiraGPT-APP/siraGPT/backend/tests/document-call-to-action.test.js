'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-call-to-action');
const { extractCTAs, buildCTAsForFiles, renderCTAsBlock, _internal } = engine;
const { isCTA, hasUrgency } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCTAs('').total, 0);
  assert.equal(extractCTAs(null).total, 0);
});

test('isCTA: English imperatives', () => {
  assert.ok(isCTA('Sign up now for early access.'));
  assert.ok(isCTA('Click here to learn more.'));
  assert.ok(isCTA('Subscribe today.'));
  assert.ok(isCTA('Request a demo with our team.'));
});

test('isCTA: Spanish imperatives', () => {
  assert.ok(isCTA('Regístrate ahora para obtener acceso anticipado.'));
  assert.ok(isCTA('Suscríbete hoy.'));
  assert.ok(isCTA('Haz clic aquí para saber más.'));
});

test('isCTA: non-CTA rejected', () => {
  assert.ok(!isCTA('The platform was launched in 2026.'));
});

test('hasUrgency: detects now / today / limited time', () => {
  assert.ok(hasUrgency('Sign up now for the launch.'));
  assert.ok(hasUrgency('Limited time offer applies.'));
  assert.ok(hasUrgency('Regístrate ahora.'));
  assert.ok(!hasUrgency('Subscribe to the newsletter.'));
});

test('extracts urgent vs neutral CTAs', () => {
  const text = 'Sign up now. Subscribe to the newsletter. Limited time offer.';
  const r = extractCTAs(text);
  assert.ok(r.total >= 2);
  assert.ok(r.ctas.some((c) => c.urgent));
});

test('extracts Spanish CTAs', () => {
  const text = 'Regístrate ahora para no perderte la oferta. Suscríbete al boletín.';
  const r = extractCTAs(text);
  assert.ok(r.total >= 2);
});

test('dedupes identical CTAs', () => {
  const text = 'Sign up now. Sign up now. Sign up now.';
  const r = extractCTAs(text);
  assert.equal(r.total, 1);
});

test('buildCTAsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Sign up now for early access.' },
    { name: 'b.md', extractedText: 'Regístrate hoy para empezar.' },
  ];
  const r = buildCTAsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCTAsBlock returns markdown when CTAs exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'Sign up now for early access.' }];
  const r = buildCTAsForFiles(files);
  const md = renderCTAsBlock(r);
  assert.match(md, /^## CALLS TO ACTION/);
});

test('renderCTAsBlock empty when nothing surfaces', () => {
  assert.equal(renderCTAsBlock({ perFile: [] }), '');
  assert.equal(renderCTAsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCTAsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Subscribe now.' }]);
  assert.ok(Array.isArray(r.perFile));
});
