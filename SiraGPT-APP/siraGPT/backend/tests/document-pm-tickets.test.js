'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pm-tickets');
const { extractPmTickets, buildPmTicketsForFiles, renderPmTicketsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPmTickets('').total, 0);
  assert.equal(extractPmTickets(null).total, 0);
});

test('detects Jira-style PROJ-123', () => {
  const r = extractPmTickets('Fixed in PROJ-1234');
  assert.ok(r.entries.some((e) => e.tool === 'jira' && e.ref === 'PROJ-1234'));
});

test('detects multiple short tickets', () => {
  const r = extractPmTickets('See SIRAGPT-42 and BLUE-100 for context');
  assert.ok(r.entries.filter((e) => e.tool === 'jira').length >= 2);
});

test('rejects HTTP method as ticket', () => {
  const r = extractPmTickets('GET-200 OK responses');
  assert.equal(r.entries.filter((e) => e.ref === 'GET-200').length, 0);
});

test('rejects RFC-2616 reference', () => {
  const r = extractPmTickets('per RFC-2616 spec');
  assert.equal(r.entries.filter((e) => e.ref === 'RFC-2616').length, 0);
});

test('detects Linear URL', () => {
  const r = extractPmTickets('https://linear.app/myteam/issue/ENG-1234');
  assert.ok(r.entries.some((e) => e.tool === 'linear'));
});

test('detects Asana URL', () => {
  const r = extractPmTickets('https://app.asana.com/0/1234567890123456/2345678901234567');
  assert.ok(r.entries.some((e) => e.tool === 'asana'));
});

test('detects Monday.com URL', () => {
  const r = extractPmTickets('https://myteam.monday.com/boards/1234567890/pulses/2345678901');
  assert.ok(r.entries.some((e) => e.tool === 'monday'));
});

test('detects Trello URL', () => {
  const r = extractPmTickets('https://trello.com/c/AbCdEfGh/my-card-name');
  assert.ok(r.entries.some((e) => e.tool === 'trello'));
});

test('detects ClickUp URL', () => {
  const r = extractPmTickets('https://app.clickup.com/t/abc123def');
  assert.ok(r.entries.some((e) => e.tool === 'clickup'));
});

test('detects Shortcut URL', () => {
  const r = extractPmTickets('https://app.shortcut.com/myorg/story/12345');
  assert.ok(r.entries.some((e) => e.tool === 'shortcut'));
});

test('dedupes identical refs', () => {
  const r = extractPmTickets('PROJ-100 here and PROJ-100 again');
  assert.equal(r.entries.filter((e) => e.ref === 'PROJ-100').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `PROJ-${100 + i} `;
  const r = extractPmTickets(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by tool', () => {
  const r = extractPmTickets(
    'PROJ-100 and https://linear.app/team/issue/ENG-1 and https://trello.com/c/AbCdEfGh/x'
  );
  assert.ok(r.totals.jira >= 1);
  assert.ok(r.totals.linear >= 1);
  assert.ok(r.totals.trello >= 1);
});

test('buildPmTicketsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'PROJ-100' },
    { name: 'b.md', extractedText: 'ENG-200' },
  ];
  const r = buildPmTicketsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPmTicketsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'changelog', extractedText: 'PROJ-100' }];
  const r = buildPmTicketsForFiles(files);
  const md = renderPmTicketsBlock(r);
  assert.match(md, /^## PM TICKET/);
});

test('renderPmTicketsBlock empty when nothing surfaces', () => {
  assert.equal(renderPmTicketsBlock({ perFile: [] }), '');
  assert.equal(renderPmTicketsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPmTicketsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'PROJ-100' },
  ]);
  assert.equal(r.perFile.length, 1);
});
