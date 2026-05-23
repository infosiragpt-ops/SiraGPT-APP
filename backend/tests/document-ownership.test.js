'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ownership');
const { extractOwnership, buildOwnershipForFiles, renderOwnershipBlock, _internal } = engine;
const { normaliseRole } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractOwnership('').total, 0);
  assert.equal(extractOwnership(null).total, 0);
});

test('normaliseRole: owner / DRI', () => {
  assert.equal(normaliseRole('Owner'), 'owner');
  assert.equal(normaliseRole('DRI'), 'owner');
  assert.equal(normaliseRole('Responsable'), 'owner');
});

test('normaliseRole: assignee / reporter / author / reviewer / approver', () => {
  assert.equal(normaliseRole('Assignee'), 'assignee');
  assert.equal(normaliseRole('Reporter'), 'reporter');
  assert.equal(normaliseRole('Author'), 'author');
  assert.equal(normaliseRole('Reviewer'), 'reviewer');
  assert.equal(normaliseRole('Approver'), 'approver');
});

test('normaliseRole: unknown returns null', () => {
  assert.equal(normaliseRole('Foo'), null);
});

test('extracts Owner line', () => {
  const r = extractOwnership('Owner: Alice Smith\nSummary: build the thing.');
  assert.ok(r.entries.some((e) => e.role === 'owner' && /Alice/.test(e.value)));
});

test('extracts DRI line', () => {
  const r = extractOwnership('DRI: Bob');
  assert.ok(r.entries.some((e) => e.role === 'owner' && /Bob/.test(e.value)));
});

test('extracts Reviewer line', () => {
  const r = extractOwnership('Reviewer: Charlie Diaz');
  assert.ok(r.entries.some((e) => e.role === 'reviewer'));
});

test('extracts Approved by line', () => {
  const r = extractOwnership('Approved by: Dana');
  assert.ok(r.entries.some((e) => e.role === 'approver'));
});

test('extracts Author / Authors line', () => {
  const r = extractOwnership('Authors: Alice, Bob, Charlie');
  assert.ok(r.entries.some((e) => e.role === 'author'));
});

test('extracts Spanish equivalents', () => {
  const r = extractOwnership('Responsable: Pedro\nAsignado a: Lucía\nAprobado por: Marta');
  const roles = r.entries.map((e) => e.role);
  assert.ok(roles.includes('owner'));
  assert.ok(roles.includes('assignee'));
  assert.ok(roles.includes('approver'));
});

test('byRole totals counted', () => {
  const r = extractOwnership('Owner: Alice\nReviewer: Bob\nReviewer: Charlie');
  assert.equal(r.byRole.owner, 1);
  assert.equal(r.byRole.reviewer, 2);
});

test('dedupes identical role+value pairs', () => {
  const r = extractOwnership('Owner: Alice\nOwner: Alice');
  assert.equal(r.entries.filter((e) => e.role === 'owner').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 35; i++) text += `Owner: Person${i}\n`;
  const r = extractOwnership(text);
  assert.ok(r.entries.length <= 20);
});

test('handles roles with hyphen (Assigned-to)', () => {
  const r = extractOwnership('Assigned-to: Alice');
  assert.ok(r.entries.some((e) => e.role === 'assignee'));
});

test('clips very long values', () => {
  const long = 'A'.repeat(300);
  const r = extractOwnership(`Owner: ${long}`);
  assert.ok(r.entries[0].value.length <= 160);
});

test('buildOwnershipForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Owner: Alice' },
    { name: 'b.md', extractedText: 'Reviewer: Bob' },
  ];
  const r = buildOwnershipForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.equal(r.byRole.owner, 1);
  assert.equal(r.byRole.reviewer, 1);
});

test('renderOwnershipBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Owner: Alice' }];
  const r = buildOwnershipForFiles(files);
  const md = renderOwnershipBlock(r);
  assert.match(md, /^## OWNERSHIP \/ DRI/);
});

test('renderOwnershipBlock includes by-role breakdown', () => {
  const files = [{ name: 'doc.md', extractedText: 'Owner: Alice\nReviewer: Bob' }];
  const r = buildOwnershipForFiles(files);
  const md = renderOwnershipBlock(r);
  assert.match(md, /By role/);
  assert.match(md, /owner=1/);
});

test('renderOwnershipBlock empty when nothing surfaces', () => {
  assert.equal(renderOwnershipBlock({ perFile: [] }), '');
  assert.equal(renderOwnershipBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOwnershipForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Owner: Alice' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('ignores arbitrary "Foo: bar" lines that are not ownership roles', () => {
  const r = extractOwnership('Description: a thing.\nNotes: another thing.');
  assert.equal(r.total, 0);
});
