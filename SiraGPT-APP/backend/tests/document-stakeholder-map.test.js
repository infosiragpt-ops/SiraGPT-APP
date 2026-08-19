'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-stakeholder-map');
const { buildStakeholderMapForFile, buildStakeholderMapForFiles, renderStakeholderBlock, _internal } = engine;
const { ROLE_GROUPS, countAll } = _internal;

test('empty / non-string input returns empty map', () => {
  assert.equal(buildStakeholderMapForFile('').total, 0);
  assert.equal(buildStakeholderMapForFile(null).total, 0);
});

test('countAll: counts all matches with global flag', () => {
  const text = 'CEO and CFO and CTO met.';
  const count = countAll(text, /\b(CEO|CFO|CTO)\b/i);
  assert.equal(count, 3);
});

test('detects leadership roles', () => {
  const text = 'The CEO and the board met to discuss the CFO succession. The CTO and CIO joined.';
  const r = buildStakeholderMapForFile(text);
  assert.ok(r.roles.some((x) => x.group === 'leadership'));
});

test('detects customer + operations roles', () => {
  const text = 'The customer feedback was positive. Our vendor delivered. Suppliers and contractors signed.';
  const r = buildStakeholderMapForFile(text);
  const groups = r.roles.map((x) => x.group);
  assert.ok(groups.includes('customer'));
  assert.ok(groups.includes('operations'));
});

test('detects investor roles', () => {
  const text = 'The investors and shareholders approved. The VC fund returned. LPs and GPs aligned.';
  const r = buildStakeholderMapForFile(text);
  assert.ok(r.roles.some((x) => x.group === 'investor'));
});

test('detects regulator roles', () => {
  const text = 'The regulator approved the filing. Auditors signed off. The tax authority cleared.';
  const r = buildStakeholderMapForFile(text);
  assert.ok(r.roles.some((x) => x.group === 'regulator'));
});

test('detects Spanish leadership and workforce roles', () => {
  const text = 'El presidente y el director general aprobaron. El consejo directivo y el equipo de empleados también.';
  const r = buildStakeholderMapForFile(text);
  const groups = r.roles.map((x) => x.group);
  assert.ok(groups.includes('leadership'));
  assert.ok(groups.includes('workforce'));
});

test('sorts roles by mention count descending', () => {
  const text = 'The CEO and the CEO and the CEO met. The customer was happy.';
  const r = buildStakeholderMapForFile(text);
  for (let i = 1; i < r.roles.length; i++) {
    assert.ok(r.roles[i].mentions <= r.roles[i - 1].mentions);
  }
});

test('caps roles to safe maximum', () => {
  const text = ROLE_GROUPS.map((g) => g.group + ' CEO CFO customer vendor partner investor regulator employee counsel'.repeat(2)).join(' ');
  const r = buildStakeholderMapForFile(text);
  assert.ok(r.roles.length <= 12);
});

test('buildStakeholderMapForFiles aggregates across files', () => {
  const files = [
    { name: 'a.md', extractedText: 'The CEO and board met. Customers wrote in.' },
    { name: 'b.md', extractedText: 'The regulator approved. Auditors signed off.' },
  ];
  const r = buildStakeholderMapForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.length >= 2);
});

test('renderStakeholderBlock returns markdown when roles exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'CEO CEO customer customer vendor.' }];
  const r = buildStakeholderMapForFiles(files);
  const md = renderStakeholderBlock(r);
  assert.match(md, /^## STAKEHOLDER MAP/);
});

test('renderStakeholderBlock empty when no roles', () => {
  assert.equal(renderStakeholderBlock({ perFile: [] }), '');
  assert.equal(renderStakeholderBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStakeholderMapForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'CEO board customer.' }]);
  assert.equal(r.perFile.length, 1);
});

test('aggregate is sorted by mention count descending', () => {
  const files = [
    { name: 'a.md', extractedText: 'CEO CEO CEO CEO customer.' },
    { name: 'b.md', extractedText: 'CEO regulator regulator regulator.' },
  ];
  const r = buildStakeholderMapForFiles(files);
  for (let i = 1; i < r.aggregate.length; i++) {
    assert.ok(r.aggregate[i].mentions <= r.aggregate[i - 1].mentions);
  }
});
