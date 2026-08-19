'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-acceptance-criteria');
const { extractAcceptanceCriteria, buildAcceptanceCriteriaForFiles, renderAcceptanceCriteriaBlock, _internal } = engine;
const { normaliseKeyword } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractAcceptanceCriteria('').total, 0);
  assert.equal(extractAcceptanceCriteria(null).total, 0);
});

test('normaliseKeyword: Spanish → English equivalents', () => {
  assert.equal(normaliseKeyword('Given'), 'Given');
  assert.equal(normaliseKeyword('Dado'), 'Given');
  assert.equal(normaliseKeyword('Cuando'), 'When');
  assert.equal(normaliseKeyword('Entonces'), 'Then');
  assert.equal(normaliseKeyword('Y'), 'And');
  assert.equal(normaliseKeyword('Pero'), 'But');
});

test('extracts a single Gherkin scenario', () => {
  const text = `Scenario: User logs in successfully
Given the user is on the login page
When they submit valid credentials
Then they are redirected to the dashboard`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 1);
  assert.equal(r.scenarios[0].steps.length, 3);
  assert.equal(r.scenarios[0].steps[0].keyword, 'Given');
});

test('extracts Spanish Escenario / Dado / Cuando / Entonces', () => {
  const text = `Escenario: Usuario inicia sesión
Dado que el usuario está en la página de login
Cuando envía credenciales válidas
Entonces es redirigido al dashboard`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 1);
  assert.ok(r.scenarios[0].steps.some((s) => s.keyword === 'Given'));
  assert.ok(r.scenarios[0].steps.some((s) => s.keyword === 'When'));
  assert.ok(r.scenarios[0].steps.some((s) => s.keyword === 'Then'));
});

test('handles And / But continuations', () => {
  const text = `Scenario: Multi-step flow
Given a precondition
And another precondition
When an action happens
But something else also happens
Then the result occurs`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 1);
  assert.equal(r.scenarios[0].steps.length, 5);
});

test('extracts multiple scenarios in same file', () => {
  const text = `Scenario: Login success
Given user on login page
When valid credentials
Then redirect to home

Scenario: Login failure
Given user on login page
When invalid credentials
Then show error`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 2);
});

test('extracts AC bullets under Acceptance Criteria header', () => {
  const text = `## Acceptance Criteria
- User can sign in with email
- Password reset link works
- Session expires after 24 hours`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.acBullets.length, 3);
});

test('extracts numbered AC bullets', () => {
  const text = `Acceptance Criteria:
1. First criterion
2. Second criterion
3. Third criterion`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.acBullets.length, 3);
});

test('extracts Spanish "Criterios de Aceptación" bullets', () => {
  const text = `## Criterios de Aceptación
- Primer criterio
- Segundo criterio`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.acBullets.length, 2);
});

test('Scenario with no steps is dropped', () => {
  const text = 'Scenario: Empty scenario\n\nUnrelated paragraph.';
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 0);
});

test('caps steps per scenario', () => {
  let text = 'Scenario: Many steps\n';
  for (let i = 0; i < 25; i++) text += `Given step ${i}\n`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 1);
  assert.ok(r.scenarios[0].steps.length <= 16);
});

test('caps AC bullets per file', () => {
  let text = '## Acceptance Criteria\n';
  for (let i = 0; i < 30; i++) text += `- criterion ${i}\n`;
  const r = extractAcceptanceCriteria(text);
  assert.ok(r.acBullets.length <= 16);
});

test('totals reported correctly', () => {
  const text = `Scenario: Login
Given user is on page
When clicking login
Then dashboard appears

## Acceptance Criteria
- Email must be valid
- Password >= 8 chars`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.totals.scenarios, 1);
  assert.equal(r.totals.acBullets, 2);
});

test('handles Gherkin steps without explicit Scenario header', () => {
  const text = `Given the user exists
When they request data
Then return results`;
  const r = extractAcceptanceCriteria(text);
  assert.equal(r.scenarios.length, 1);
  assert.match(r.scenarios[0].title, /unnamed/);
});

test('clips long step text', () => {
  const long = 'A'.repeat(400);
  const r = extractAcceptanceCriteria(`Scenario: Big\nGiven ${long}\nWhen something\nThen result`);
  assert.ok(r.scenarios[0].steps[0].text.length <= 220);
});

test('buildAcceptanceCriteriaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Scenario: A\nGiven x\nWhen y\nThen z' },
    { name: 'b.md', extractedText: '## Acceptance Criteria\n- bullet 1' },
  ];
  const r = buildAcceptanceCriteriaForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.equal(r.totals.scenarios, 1);
  assert.equal(r.totals.acBullets, 1);
});

test('renderAcceptanceCriteriaBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Scenario: X\nGiven a\nWhen b\nThen c' }];
  const r = buildAcceptanceCriteriaForFiles(files);
  const md = renderAcceptanceCriteriaBlock(r);
  assert.match(md, /^## ACCEPTANCE CRITERIA/);
});

test('renderAcceptanceCriteriaBlock empty when nothing surfaces', () => {
  assert.equal(renderAcceptanceCriteriaBlock({ perFile: [] }), '');
  assert.equal(renderAcceptanceCriteriaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAcceptanceCriteriaForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Scenario: X\nGiven a\nWhen b\nThen c' },
  ]);
  assert.equal(r.perFile.length, 1);
});
