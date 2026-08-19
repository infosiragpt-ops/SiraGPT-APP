'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-figure-refs');
const { extractFigureRefs, buildFigureRefsForFiles, renderFigureRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractFigureRefs('').total, 0);
  assert.equal(extractFigureRefs(null).total, 0);
});

test('detects Figure N reference', () => {
  const text = 'As shown in Figure 3, the trend is clear.';
  const r = extractFigureRefs(text);
  assert.ok(r.references.some((x) => x.kind === 'figure' && x.label === '3'));
});

test('detects Spanish Figura N', () => {
  const text = 'Véase la Figura 4 para el desglose.';
  const r = extractFigureRefs(text);
  assert.ok(r.references.some((x) => x.kind === 'figure' && x.label === '4'));
});

test('detects Table / Tabla / Cuadro', () => {
  const text = 'Refer to Table 1. La Tabla 2 muestra... El Cuadro 3 expone...';
  const r = extractFigureRefs(text);
  const tables = r.references.filter((x) => x.kind === 'table');
  assert.ok(tables.length >= 2);
});

test('detects Equation / Ecuación', () => {
  const text = 'See Equation 5. Ver Ecuación 6.';
  const r = extractFigureRefs(text);
  assert.ok(r.references.some((x) => x.kind === 'equation'));
});

test('detects Diagram / Chart / Appendix', () => {
  const text = 'See Chart 1, Diagram 2, Appendix A.';
  const r = extractFigureRefs(text);
  const kinds = new Set(r.references.map((x) => x.kind));
  assert.ok(kinds.has('chart'));
  assert.ok(kinds.has('diagram'));
  assert.ok(kinds.has('appendix'));
});

test('captures caption when "Figure 3: caption text" is present', () => {
  const text = `Some intro mentioning Figure 3.

Figure 3: Quarterly growth across regions.

End.`;
  const r = extractFigureRefs(text);
  const ref = r.references.find((x) => x.kind === 'figure' && x.label === '3');
  assert.ok(ref);
  assert.match(ref.caption, /Quarterly growth/);
});

test('dedupes same kind+label across references', () => {
  const text = 'Figure 3 here. Figure 3 again. Figure 3 once more.';
  const r = extractFigureRefs(text);
  assert.equal(r.references.filter((x) => x.kind === 'figure').length, 1);
});

test('caps references per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `See Figure ${i}. `;
  const r = extractFigureRefs(text);
  assert.ok(r.references.length <= 14);
});

test('buildFigureRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'See Figure 1 and Table 2.' },
    { name: 'b.md', extractedText: 'Ver Figura 3 y Tabla 4.' },
  ];
  const r = buildFigureRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFigureRefsBlock returns markdown when references exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'See Figure 1 for details.' }];
  const r = buildFigureRefsForFiles(files);
  const md = renderFigureRefsBlock(r);
  assert.match(md, /^## FIGURE \/ TABLE REFERENCES/);
});

test('renderFigureRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderFigureRefsBlock({ perFile: [] }), '');
  assert.equal(renderFigureRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFigureRefsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'See Table 1.' }]);
  assert.equal(r.perFile.length, 1);
});

test('does not extract from prose without figure keyword', () => {
  const r = extractFigureRefs('Just plain prose. 3 cats and 4 dogs.');
  assert.equal(r.references.length, 0);
});
