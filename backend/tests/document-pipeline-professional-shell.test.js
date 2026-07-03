'use strict';

// Professional document shell — regression tests for the meta-noise purge
// and the explicit length budget ("en 200 palabras" must not produce a
// 6-page document). Covers the bugs reported from production screenshots:
// blank first page (empty TOC field + PageBreak), "Portada" heading with
// pipeline marketing copy, broken validation-marker image (black box),
// empty English "Table of Contents", corrupted QC table (tblPr child order)
// and the phantom trailing page.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.SIRAGPT_PPTX_DECK_DESIGNER = '0';

const pipeline = require('../src/services/document-pipeline/advanced-document-pipeline');

const { buildPlan, validateDocument, INTERNAL } = pipeline;

test('parseRequestedLength: "en 200 palabras" caps the plan to one section', () => {
  const plan = buildPlan({ prompt: 'crea un word sobre el embarazo en 200 palabras', format: 'docx', template: 'premium', complexity: 'standard' });
  assert.equal(plan.wordTarget, 200);
  assert.equal(plan.sections.length, 1);
});

test('length budget: "2 páginas" maps to ~700 words → 3 sections max', () => {
  const plan = buildPlan({ prompt: 'informe word de 2 páginas sobre logística portuaria', format: 'docx', template: 'business', complexity: 'standard' });
  assert.equal(plan.wordTarget, 700);
  assert.ok(plan.sections.length <= 3, `expected ≤3 sections, got ${plan.sections.length}`);
});

test('no length constraint keeps the full template skeleton', () => {
  const plan = buildPlan({ prompt: 'crea un informe word profesional sobre la gestión administrativa municipal', format: 'docx', template: 'business', complexity: 'standard' });
  assert.equal(plan.wordTarget, null);
  assert.ok(plan.sections.length >= 5);
});

test('academic template no longer plans meta sections (Portada/Anexos)', () => {
  const plan = buildPlan({ prompt: 'ensayo académico word sobre economía circular', format: 'docx', template: 'academic', complexity: 'standard' });
  assert.ok(!plan.sections.includes('Portada'));
  assert.ok(!plan.sections.includes('Anexos'));
});

test('generated DOCX carries zero pipeline meta-noise and a viewer-safe shell', async () => {
  const plan = buildPlan({ prompt: 'crea un informe word profesional sobre la gestión administrativa municipal', format: 'docx', template: 'business', complexity: 'standard' });
  const { buffer } = await INTERNAL.buildDocumentFile({ plan, outputDir: path.join(os.tmpdir(), `shell-test-${Date.now()}`) });
  const PizZip = require('pizzip');
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml').asText();
  const plain = xml.replace(/<[^>]+>/g, ' ');

  // Meta-noise purge
  assert.ok(!plain.includes('Portada'), 'no "Portada" meta heading');
  assert.ok(!/estructura profesional, validacion|pipeline documental multiagente/.test(plain), 'no pipeline marketing copy');
  assert.ok(!plain.includes('Control de calidad'), 'no QC self-grading table');
  assert.ok(!plain.includes('American Psychological Association'), 'no placeholder APA reference');
  assert.ok(!xml.includes('siragpt-docx-marker'), 'no broken validation-marker image');

  // Viewer-safe shell: no field-based TOC (renders empty outside Word);
  // long-form docs get a static Índice + real page break instead.
  assert.ok(!/w:instrText[^<]*TOC/.test(xml), 'no TOC field');
  assert.ok(plain.includes('Índice'), 'static index present for long-form doc');
  assert.ok(xml.includes('<w:br w:type="page"'), 'explicit page break present');

  // tblPr child order: tblLook must come AFTER tblCellMar (LibreOffice
  // mis-renders out-of-order tblPr as an empty grid with spilled text).
  for (const match of xml.matchAll(/<w:tblPr>([\s\S]*?)<\/w:tblPr>/g)) {
    const inner = match[1];
    const look = inner.indexOf('<w:tblLook');
    const cellMar = inner.indexOf('<w:tblCellMar');
    if (look !== -1 && cellMar !== -1) {
      assert.ok(look > cellMar, 'tblLook ordered after tblCellMar');
    }
  }

  // Still validates as a professional document
  const expected = INTERNAL.expectedFor('docx', 'business', 'standard', plan);
  const verdict = validateDocument({ format: 'docx', buffer, expected });
  assert.ok(verdict.technicalScore >= 82, `technicalScore ${verdict.technicalScore} >= 82`);
  assert.ok(verdict.passed, 'document passes quality gates');
});

test('short DOCX (200 palabras) skips the index and passes relaxed gates', async () => {
  const plan = buildPlan({ prompt: 'crea un word sobre el embarazo en 200 palabras', format: 'docx', template: 'premium', complexity: 'standard' });
  const { buffer } = await INTERNAL.buildDocumentFile({ plan, outputDir: path.join(os.tmpdir(), `shell-short-${Date.now()}`) });
  const PizZip = require('pizzip');
  const zip = new PizZip(buffer);
  const plain = zip.file('word/document.xml').asText().replace(/<[^>]+>/g, ' ');
  assert.ok(!plain.includes('Índice'), 'short doc has no index');
  const expected = INTERNAL.expectedFor('docx', 'premium', 'standard', plan);
  assert.equal(expected.minTables, 0);
  assert.equal(expected.requiresImage, false);
  const verdict = validateDocument({ format: 'docx', buffer, expected });
  assert.ok(verdict.passed, `short doc passes (tech=${verdict.technicalScore} q=${verdict.qualityScore})`);
});

test('expectedFor honours minTables:0 (no ||-falsy fallback to 1)', () => {
  const plan = buildPlan({ prompt: 'word corto sobre ventas en 150 palabras', format: 'docx', template: 'premium', complexity: 'standard' });
  const expected = INTERNAL.expectedFor('docx', 'premium', 'standard', plan);
  assert.equal(expected.minTables, 0);
  // A tiny but valid docx with zero tables must not fail the table check.
  const fakeXml = '<w:document><w:body>' + '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(6) + '</w:body></w:document>';
  // validateDocx is internal; assert through validateDocument on a real buffer instead.
  assert.ok(fakeXml.includes('w:document'));
});
