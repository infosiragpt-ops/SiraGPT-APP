'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-conditional-clauses');
const { extractConditionals, buildConditionalsForFiles, renderConditionalsBlock, _internal } = engine;
const { detectTrigger } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractConditionals('').total, 0);
  assert.equal(extractConditionals(null).total, 0);
});

test('detectTrigger: if-then', () => {
  assert.equal(detectTrigger('If the buyer defaults, then the seller may terminate.'), 'if-then');
  assert.equal(detectTrigger('Si el comprador incumple, entonces el vendedor puede terminar.'), 'if-then');
});

test('detectTrigger: unless', () => {
  assert.equal(detectTrigger('The contract will renew unless either party gives notice.'), 'unless');
  assert.equal(detectTrigger('El contrato se renueva a menos que una parte notifique.'), 'unless');
});

test('detectTrigger: provided that', () => {
  assert.equal(detectTrigger('Provided that the conditions are met, payment will be processed.'), 'provided');
  assert.equal(detectTrigger('Siempre que se cumplan las condiciones, se procesará el pago.'), 'provided');
});

test('detectTrigger: in the event of', () => {
  assert.equal(detectTrigger('In the event of a breach, damages will apply.'), 'event-of');
  assert.equal(detectTrigger('En caso de incumplimiento, se aplicarán daños.'), 'event-of');
});

test('detectTrigger: subject to', () => {
  assert.equal(detectTrigger('Payment is subject to approval by the board.'), 'subject-to');
  assert.equal(detectTrigger('El pago está sujeto a aprobación del consejo.'), 'subject-to');
});

test('detectTrigger: failing which / en su defecto', () => {
  assert.equal(detectTrigger('Notice must be given within 30 days, failing which the right expires.'), 'failing-which');
  assert.equal(detectTrigger('Debe notificarse en 30 días, en su defecto el derecho expira.'), 'failing-which');
});

test('detectTrigger: non-conditional returns null', () => {
  assert.equal(detectTrigger('The team had lunch on Tuesday.'), null);
});

test('extractConditionals returns labelled clauses', () => {
  const text = `If the buyer defaults, then the seller may terminate.
The contract renews unless either party gives notice.
In the event of a breach, damages will apply.`;
  const r = extractConditionals(text);
  assert.ok(r.total >= 3);
  const triggers = r.clauses.map((c) => c.trigger);
  assert.ok(triggers.includes('if-then'));
  assert.ok(triggers.includes('unless'));
  assert.ok(triggers.includes('event-of'));
});

test('dedupes identical sentences', () => {
  const text = 'If X then Y. If X then Y. If X then Y.';
  const r = extractConditionals(text);
  assert.equal(r.total, 1);
});

test('buildConditionalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'If buyer defaults, then seller terminates.' },
    { name: 'b.md', extractedText: 'Unless notice is given, the contract auto-renews.' },
  ];
  const r = buildConditionalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderConditionalsBlock returns markdown when clauses exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'If buyer defaults, then seller may terminate.' }];
  const r = buildConditionalsForFiles(files);
  const md = renderConditionalsBlock(r);
  assert.match(md, /^## CONDITIONAL CLAUSES/);
});

test('renderConditionalsBlock empty when nothing surfaces', () => {
  assert.equal(renderConditionalsBlock({ perFile: [] }), '');
  assert.equal(renderConditionalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildConditionalsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'If X then Y.' }]);
  assert.ok(Array.isArray(r.perFile));
});
