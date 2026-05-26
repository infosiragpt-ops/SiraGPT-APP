'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-mermaid');
const { extractMermaid, buildMermaidForFiles, renderMermaidBlock, _internal } = engine;
const { detectType } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractMermaid('').total, 0);
  assert.equal(extractMermaid(null).total, 0);
});

test('detectType: flowchart TD', () => {
  assert.equal(detectType('flowchart TD\nA --> B'), 'flowchart');
});

test('detectType: graph LR alias', () => {
  assert.equal(detectType('graph LR\nA --> B'), 'flowchart');
});

test('detectType: sequenceDiagram', () => {
  assert.equal(detectType('sequenceDiagram\nAlice->>Bob: hi'), 'sequence');
});

test('detectType: classDiagram', () => {
  assert.equal(detectType('classDiagram\nclass Foo'), 'class');
});

test('detectType: stateDiagram-v2', () => {
  assert.equal(detectType('stateDiagram-v2\n[*] --> Idle'), 'state');
});

test('detectType: erDiagram', () => {
  assert.equal(detectType('erDiagram\nCUSTOMER ||--o{ ORDER : places'), 'er');
});

test('detectType: gantt', () => {
  assert.equal(detectType('gantt\ntitle Project'), 'gantt');
});

test('detectType: pie', () => {
  assert.equal(detectType('pie\ntitle Distribution'), 'pie');
});

test('detectType: unknown body returns null', () => {
  assert.equal(detectType('just some random text'), null);
});

test('extracts a fenced mermaid block (flowchart)', () => {
  const text = '```mermaid\nflowchart TD\nA --> B\nB --> C\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
  assert.equal(r.diagrams[0].type, 'flowchart');
  assert.equal(r.diagrams[0].totalLines, 3);
});

test('extracts a sequenceDiagram block', () => {
  const text = '```mermaid\nsequenceDiagram\nAlice->>Bob: Hi\nBob-->>Alice: Hello\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
  assert.equal(r.diagrams[0].type, 'sequence');
});

test('extracts multiple diagrams in same file', () => {
  const text = '```mermaid\nflowchart TD\nA --> B\n```\n\nSome prose.\n\n```mermaid\nsequenceDiagram\nA->>B: ok\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 2);
  assert.equal(r.diagrams[0].type, 'flowchart');
  assert.equal(r.diagrams[1].type, 'sequence');
});

test('unknown diagram body returns type "unknown"', () => {
  const text = '```mermaid\ncompletely-made-up-syntax xyz\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
  assert.equal(r.diagrams[0].type, 'unknown');
});

test('truncates preview to MAX_PREVIEW_LINES', () => {
  const body = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const text = '```mermaid\nflowchart TD\n' + body + '\n```';
  const r = extractMermaid(text);
  assert.ok(r.diagrams[0].preview.length <= 8);
  assert.ok(r.diagrams[0].totalLines > 8);
});

test('dedupes identical diagrams', () => {
  const text = '```mermaid\nflowchart TD\nA --> B\n```\n\n```mermaid\nflowchart TD\nA --> B\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
});

test('caps diagrams per file', () => {
  let text = '';
  for (let i = 0; i < 15; i++) {
    text += `\`\`\`mermaid\nflowchart TD\nA${i} --> B${i}\n\`\`\`\n\n`;
  }
  const r = extractMermaid(text);
  assert.ok(r.diagrams.length <= 8);
});

test('buildMermaidForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '```mermaid\nflowchart TD\nA --> B\n```' },
    { name: 'b.md', extractedText: '```mermaid\nsequenceDiagram\nA->>B: hi\n```' },
  ];
  const r = buildMermaidForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.equal(r.aggregate.length, 2);
});

test('renderMermaidBlock returns markdown when diagrams exist', () => {
  const files = [{ name: 'doc.md', extractedText: '```mermaid\nflowchart TD\nA --> B\n```' }];
  const r = buildMermaidForFiles(files);
  const md = renderMermaidBlock(r);
  assert.match(md, /^## MERMAID DIAGRAMS/);
  assert.match(md, /flowchart/);
});

test('renderMermaidBlock empty when nothing surfaces', () => {
  assert.equal(renderMermaidBlock({ perFile: [] }), '');
  assert.equal(renderMermaidBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMermaidForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '```mermaid\nflowchart TD\nA --> B\n```' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('ignores fenced blocks that are not mermaid', () => {
  const text = '```js\nconst x = 1;\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 0);
});

test('extracts mindmap diagram', () => {
  const text = '```mermaid\nmindmap\n  root\n    child1\n    child2\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
  assert.equal(r.diagrams[0].type, 'mindmap');
});

test('extracts gitGraph diagram', () => {
  const text = '```mermaid\ngitGraph\n  commit\n  branch dev\n```';
  const r = extractMermaid(text);
  assert.equal(r.total, 1);
  assert.equal(r.diagrams[0].type, 'gitGraph');
});

test('clips very long preview lines', () => {
  const longLine = 'A'.repeat(200);
  const text = '```mermaid\nflowchart TD\n' + longLine + '\n```';
  const r = extractMermaid(text);
  assert.ok(r.diagrams[0].preview.some((l) => l.length <= 140));
});
