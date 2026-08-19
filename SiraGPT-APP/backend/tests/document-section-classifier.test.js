'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-section-classifier');
const {
  classifySections,
  buildSectionsForFiles,
  renderSectionsBlock,
  _internal,
} = engine;

test('classifySections: empty / non-string input returns empty', () => {
  const r = classifySections('');
  assert.equal(r.sectionCount, 0);
  assert.deepEqual(r.sections, []);
  assert.equal(classifySections(null).sectionCount, 0);
  assert.equal(classifySections(undefined).sectionCount, 0);
  assert.equal(classifySections(42).sectionCount, 0);
});

test('classifySections: classifies an academic paper structure', () => {
  const text = `# Abstract

This study examines…

# Introduction

Recent work has shown…

# Methods

We used a randomised design…

# Results

The effect size was significant…

# Discussion

These findings suggest…

# Conclusion

In sum, the data supports…

# References

Smith 2020`;
  const r = classifySections(text);
  assert.equal(r.schema, 'academic');
  const roles = r.sections.map((s) => s.role);
  assert.ok(roles.includes('abstract'));
  assert.ok(roles.includes('intro'));
  assert.ok(roles.includes('method'));
  assert.ok(roles.includes('results'));
  assert.ok(roles.includes('discussion'));
  assert.ok(roles.includes('conclusion'));
});

test('classifySections: classifies a legal contract structure', () => {
  const text = `# Preámbulo

Considerando que…

# Definiciones

"Contrato" significa…

# Partes

Las partes firmantes son…

# Obligaciones

Las partes se obligan a…

# Condiciones de pago

El pago se realizará…

# Terminación

El contrato puede terminarse…

# Ley aplicable

Este contrato se rige por…

# Anexos

Anexo A — …`;
  const r = classifySections(text);
  assert.equal(r.schema, 'legal');
  const roles = r.sections.map((s) => s.role);
  assert.ok(roles.includes('preamble'));
  assert.ok(roles.includes('definitions'));
  assert.ok(roles.includes('parties'));
  assert.ok(roles.includes('obligations'));
  assert.ok(roles.includes('payment'));
  assert.ok(roles.includes('termination'));
  assert.ok(roles.includes('law-and-jurisdiction'));
  assert.ok(roles.includes('annex'));
});

test('classifySections: handles numbered headings like "1. Introducción"', () => {
  const text = `1. Introducción
Este trabajo presenta…

2. Metodología
Se utilizó un enfoque cuantitativo…

3. Resultados
Los hallazgos muestran…`;
  const r = classifySections(text);
  const roles = r.sections.map((s) => s.role);
  assert.ok(roles.includes('intro'));
  assert.ok(roles.includes('method'));
  assert.ok(roles.includes('results'));
});

test('classifySections: preview captures the first non-empty line', () => {
  const text = `# Introduction

This work addresses the gap between A and B with novel technique X.`;
  const r = classifySections(text);
  const intro = r.sections.find((s) => s.role === 'intro');
  assert.ok(intro);
  assert.ok(intro.preview.includes('gap between A and B'));
});

test('classifySections: unrecognised headings are skipped', () => {
  const text = `# Acknowledgements

Thanks to everyone.

# Funding sources

NSF grant.

# Method

We used…`;
  const r = classifySections(text);
  // Only "Method" should classify.
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].role, 'method');
});

test('classifySections: dominant schema by majority', () => {
  const text = `# Introduction
…

# Method
…

# Annex
…`;
  const r = classifySections(text);
  // intro+method are academic, annex is legal → academic wins.
  assert.equal(r.schema, 'academic');
});

test('classifyHeading: handles Spanish/English variants', () => {
  assert.equal(_internal.classifyHeading('Resumen').role, 'abstract');
  assert.equal(_internal.classifyHeading('Resultados').role, 'results');
  assert.equal(_internal.classifyHeading('Conclusiones').role, 'conclusion');
  assert.equal(_internal.classifyHeading('Marco teórico').role, 'related-work');
  assert.equal(_internal.classifyHeading('Anexos').role, 'annex');
});

test('buildSectionsForFiles: aggregates across files', () => {
  const files = [
    {
      originalName: 'paper.txt',
      extractedText: `# Introduction\nThe paper…\n\n# Method\nWe used…\n\n# Results\nFound that…`,
    },
    {
      originalName: 'contract.txt',
      extractedText: `# Partes\nLas partes…\n\n# Obligaciones\nSe obligan a…\n\n# Terminación\nPuede terminar…`,
    },
  ];
  const { perFile, aggregate } = buildSectionsForFiles(files);
  assert.equal(perFile.length, 2);
  // Verify the per-file schemas were assigned correctly.
  assert.equal(perFile[0].report.schema, 'academic');
  assert.equal(perFile[1].report.schema, 'legal');
  assert.ok(aggregate.sectionCount >= 6);
});

test('buildSectionsForFiles: skips files without classifiable sections', () => {
  const { perFile } = buildSectionsForFiles([
    { originalName: 'empty.txt', extractedText: '' },
    { originalName: 'plain.txt', extractedText: 'just a plain paragraph without any headings.' },
    { originalName: 'ok.txt', extractedText: '# Results\nThe data shows…' },
  ]);
  assert.equal(perFile.length, 1);
  assert.equal(perFile[0].file, 'ok.txt');
});

test('renderSectionsBlock: empty → empty string', () => {
  assert.equal(renderSectionsBlock(null), '');
  assert.equal(renderSectionsBlock({ perFile: [], aggregate: {} }), '');
});

test('renderSectionsBlock: single-file rendering has schema label', () => {
  const r = buildSectionsForFiles([{
    originalName: 'paper.txt',
    extractedText: '# Introduction\nThis paper…\n\n# Method\nWe used…',
  }]);
  const md = renderSectionsBlock(r);
  assert.ok(md.includes('## DOCUMENT SECTION ROLES'));
  assert.ok(md.includes('### File: paper.txt'));
  assert.ok(md.includes('schema: Académico'));
});

test('renderSectionsBlock: multi-file has aggregate counts', () => {
  const r = buildSectionsForFiles([
    { originalName: 'a.txt', extractedText: '# Introduction\nx\n\n# Method\ny' },
    { originalName: 'b.txt', extractedText: '# Partes\nx\n\n# Obligaciones\ny' },
  ]);
  const md = renderSectionsBlock(r);
  assert.ok(md.includes('Aggregate across all files'));
  assert.ok(md.includes('### File: a.txt'));
  assert.ok(md.includes('### File: b.txt'));
});

test('renderSectionsBlock: respects MAX_BLOCK_CHARS budget', () => {
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    lines.push(`# Results\nLong paragraph ${i} describing the findings in great detail and exhaustive context. `.repeat(2));
  }
  const md = renderSectionsBlock(buildSectionsForFiles([
    { originalName: 'huge.txt', extractedText: lines.join('\n\n') },
  ]));
  assert.ok(md.length <= _internal.MAX_BLOCK_CHARS,
    `block exceeded budget: ${md.length} > ${_internal.MAX_BLOCK_CHARS}`);
});

test('integration: professional-analyzer exposes sectionRolesBlock', async () => {
  const pa = require('../src/services/document-professional-analyzer');
  const result = await pa.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 's1',
      originalName: 'paper.txt',
      extractedText: '# Introduction\nThis paper…\n\n# Method\nWe used a randomised design.\n\n# Results\nThe effect was large.',
    }],
  });
  assert.ok(typeof result.sectionRolesBlock === 'string');
  assert.ok(result.sectionRolesBlock.includes('DOCUMENT SECTION ROLES'));
});
