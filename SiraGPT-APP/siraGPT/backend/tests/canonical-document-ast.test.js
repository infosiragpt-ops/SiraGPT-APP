const test = require('node:test');
const assert = require('node:assert/strict');

const ast = require('../src/services/agents/canonical-document-ast');

test('SCHEMA_VERSION is the expected v1 string', () => {
  assert.equal(ast.SCHEMA_VERSION, 'sira.canonical_document.v1');
});

test('BLOCK_TYPES exposes exactly the 11 documented kinds', () => {
  assert.deepEqual([...ast.BLOCK_TYPES].sort(), [
    'artifact_metadata',
    'block_math',
    'chart',
    'citation',
    'code',
    'heading',
    'image',
    'inline_math',
    'page_break',
    'paragraph',
    'table',
  ]);
});

test('emptyAst produces a structurally valid document', () => {
  const doc = ast.emptyAst({ format: 'docx', title: 'Hola' });
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validateCanonicalAst rejects an empty / non-object ast', () => {
  assert.equal(ast.validateCanonicalAst(null).ok, false);
  assert.equal(ast.validateCanonicalAst('not an object').ok, false);
  assert.equal(ast.validateCanonicalAst([]).ok, false);
});

test('validateCanonicalAst rejects an unknown format', () => {
  const doc = { kind: ast.SCHEMA_VERSION, format: 'docxxxx', blocks: [] };
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.find((e) => e.path === '$.format'));
});

test('validateCanonicalAst rejects an unknown block type', () => {
  const doc = ast.emptyAst({ format: 'docx' });
  doc.blocks.push({ type: 'song' });
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.find((e) => /unknown block type/.test(e.reason)));
});

test('builders + walker accept a complete document with every block kind', () => {
  const doc = ast.emptyAst({ format: 'docx', title: 'Smoke', language: 'es' });
  doc.blocks.push(
    ast.heading(1, 'Capítulo 1'),
    ast.paragraph('La función es derivable.'),
    ast.inlineMath('x^2'),
    ast.blockMath('\\int_0^1 f(x)\\,dx'),
    ast.table({ headers: ['Autor', 'Año'], rows: [['García', '2020'], ['Smith', '2023']] }),
    ast.image({ src: '/uploads/img.png', alt: 'fig 1' }),
    ast.code('python', 'print(1)'),
    ast.citation({ label: 'García (2020)', source: 'Revista X', page: 12 }),
    ast.chart({ kind: 'bar', data: { labels: ['A', 'B'], values: [1, 2] } }),
    ast.pageBreak(),
    ast.artifactMetadata({ title: 'Tesis', author: 'Luis' }),
  );
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('paragraph requires a non-empty text field', () => {
  const doc = ast.emptyAst({ format: 'docx' });
  doc.blocks.push({ type: 'paragraph' });   // missing text
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /paragraph\.text must be/);
});

test('heading rejects out-of-range levels', () => {
  const doc = ast.emptyAst({ format: 'docx' });
  doc.blocks.push({ type: 'heading', level: 7, text: 'too big' });
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /heading\.level must be an integer 1\.\.6/);
});

test('table rejects rows whose length disagrees with the header count', () => {
  const doc = ast.emptyAst({ format: 'docx' });
  doc.blocks.push({
    type: 'table',
    headers: ['A', 'B', 'C'],
    rows: [['1', '2'], ['1', '2', '3']], // first row has 2 cells, header has 3
  });
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /rows\[0\] length 2 ≠ headers length 3/);
});

test('block_math + inline_math require a non-empty latex field', () => {
  const docA = ast.emptyAst({ format: 'docx' });
  docA.blocks.push({ type: 'block_math', latex: '' });
  const ra = ast.validateCanonicalAst(docA);
  assert.equal(ra.ok, false);

  const docB = ast.emptyAst({ format: 'docx' });
  docB.blocks.push({ type: 'inline_math' });
  const rb = ast.validateCanonicalAst(docB);
  assert.equal(rb.ok, false);
});

test('errors carry path strings that point at the offending block', () => {
  const doc = ast.emptyAst({ format: 'docx' });
  doc.blocks.push(ast.heading(1, 'ok'));
  doc.blocks.push({ type: 'paragraph' });   // failure at index 1
  doc.blocks.push(ast.paragraph('ok'));
  const result = ast.validateCanonicalAst(doc);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '$.blocks[1]');
});
