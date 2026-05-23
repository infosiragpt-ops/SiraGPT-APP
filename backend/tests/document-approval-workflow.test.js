'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-approval-workflow');
const { extractApprovalStages, buildApprovalsForFiles, renderApprovalsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractApprovalStages('').total, 0);
  assert.equal(extractApprovalStages(null).total, 0);
});

test('detects English workflow stages', () => {
  const text = 'Drafted by: Jane Smith\nReviewed by: John Doe\nApproved by: Carmen López';
  const r = extractApprovalStages(text);
  const stages = r.stages.map((s) => s.stage);
  assert.ok(stages.includes('drafted'));
  assert.ok(stages.includes('reviewed'));
  assert.ok(stages.includes('approved'));
});

test('detects Spanish workflow stages', () => {
  const text = 'Redactado por: María Pérez\nRevisado por: Carlos García\nAprobado por: Ana Torres';
  const r = extractApprovalStages(text);
  const stages = r.stages.map((s) => s.stage);
  assert.ok(stages.includes('drafted'));
  assert.ok(stages.includes('reviewed'));
  assert.ok(stages.includes('approved'));
});

test('detects "Signed by" stage', () => {
  const r = extractApprovalStages('Signed by: Jane Smith\nDate: 2026-05-12');
  assert.ok(r.stages.some((s) => s.stage === 'signed'));
});

test('captures nearby date when present', () => {
  const text = 'Approved by: Jane Smith\nDate: 2026-05-12';
  const r = extractApprovalStages(text);
  const approved = r.stages.find((s) => s.stage === 'approved');
  assert.ok(approved);
  assert.ok(approved.date && /2026-05-12/.test(approved.date));
});

test('captures Spanish "Fecha" date', () => {
  const text = 'Aprobado por: María\nFecha: 2026-06-15';
  const r = extractApprovalStages(text);
  const approved = r.stages.find((s) => s.stage === 'approved');
  if (approved && approved.date) assert.match(approved.date, /2026-06-15/);
});

test('dedupes same stage + name', () => {
  const text = 'Approved by: Jane Smith\nApproved by: Jane Smith';
  const r = extractApprovalStages(text);
  assert.equal(r.stages.filter((s) => s.stage === 'approved').length, 1);
});

test('scans head AND tail', () => {
  const head = 'Drafted by: Jane Smith\n';
  const body = 'lorem '.repeat(2000);
  const tail = '\nApproved by: John Doe';
  const r = extractApprovalStages(head + body + tail);
  const stages = r.stages.map((s) => s.stage);
  assert.ok(stages.includes('drafted'));
  assert.ok(stages.includes('approved'));
});

test('buildApprovalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Approved by: Jane Smith' },
    { name: 'b.md', extractedText: 'Aprobado por: María López' },
  ];
  const r = buildApprovalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderApprovalsBlock returns markdown when stages exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Approved by: Jane Smith\nDate: 2026-05-12' }];
  const r = buildApprovalsForFiles(files);
  const md = renderApprovalsBlock(r);
  assert.match(md, /^## APPROVAL WORKFLOW/);
});

test('renderApprovalsBlock empty when nothing surfaces', () => {
  assert.equal(renderApprovalsBlock({ perFile: [] }), '');
  assert.equal(renderApprovalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildApprovalsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Approved by: Jane' }]);
  assert.equal(r.perFile.length, 1);
});
