'use strict';

/**
 * summarizeForChat keeps markdown structure. Flattening whitespace turned a
 * deliverable's «## Datos del estudio» + table into one line rendered as a
 * giant heading (seen live 2026-09-18).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeForChat } = require('../src/services/agents/agent-task-runner');

const md = [
  '# Resumen y Análisis del Documento',
  '',
  '## 📄 Datos del estudio',
  '',
  'Título: *Factores asociados a la automedicación*.   ',
  '',
  '',
  '',
  '### Principales hallazgos',
  '',
  '| Indicador | Dato |',
  '|---|---|',
  '| Prevalencia | 68% |',
].join('\n');

test('headings, blank lines and table rows survive; runs of blank lines collapse to one', () => {
  const out = summarizeForChat(md, { format: 'docx' });
  assert.match(out, /^Preparé el entregable profesional en formato DOCX/);
  assert.match(out, /Resumen conversacional:\n\n# Resumen y Análisis del Documento\n\n## 📄 Datos del estudio\n\nTítulo:/);
  assert.match(out, /\n\| Indicador \| Dato \|\n\|---\|---\|\n\| Prevalencia \| 68% \|$/);
  assert.doesNotMatch(out, /\n{3,}/, 'no triple newlines');
  assert.doesNotMatch(out, /automedicación\*\. {2,}/, 'trailing spaces trimmed');
});

test('long text is clipped at a paragraph boundary, never mid-line, and marked with …', () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Párrafo ${i} ${'x'.repeat(150)}`);
  const out = summarizeForChat(paras.join('\n\n'), { format: 'pdf' });
  const body = out.split('Resumen conversacional:\n\n')[1];
  assert.ok(body.length <= 1400 + 4, `clipped: ${body.length}`);
  assert.match(body, /\n\n…$/);
  const kept = body.replace(/\n\n…$/, '');
  assert.ok(kept.endsWith('x'), 'cut lands at the end of a full paragraph');
  assert.doesNotMatch(kept, /Párrafo \d+ x{1,149}$/, 'no half paragraph');
});

test('empty text returns only the intro; CRLF is normalised', () => {
  assert.equal(summarizeForChat('   ', { format: 'xlsx' }), 'Preparé el entregable profesional en formato XLSX y lo validé antes de adjuntarlo.');
  assert.match(summarizeForChat('a\r\nb\r\n\r\nc', {}), /a\nb\n\nc$/);
});
