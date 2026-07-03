'use strict';

/**
 * DOCX professionalism contract — the deliverable must NOT contain internal
 * pipeline artifacts: no "Criterio/Validación/Estado" QA table, no synthetic
 * validation-marker images, no pipeline branding sentences, no APA-manual
 * citation stubs. Validation must still pass without that filler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const {
  buildPlan,
  validateDocument,
  INTERNAL,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

function docxText(buffer) {
  const zip = new PizZip(buffer);
  return zip.file('word/document.xml').asText().replace(/<[^>]+>/g, ' ');
}

function docxMediaEntries(buffer) {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files).filter((entry) => entry.startsWith('word/media/'));
}

test('plain business DOCX ships without internal QA table, marker image, branding or APA stub', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-professional-'));
  const plan = buildPlan({
    prompt: 'Genera un Word profesional sobre plan comercial trimestral con contexto, análisis y recomendaciones.',
    format: 'docx',
    template: 'business',
    complexity: 'standard',
  });

  const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
  const xml = docxText(artifact.buffer);

  // Internal QA artifacts must not leak into the deliverable.
  assert.doesNotMatch(xml, /Criterio\s+Validaci/i, 'no QA validation table');
  assert.doesNotMatch(xml, /Archivo DOCX inspeccionable/i, 'no QA table rows');
  assert.doesNotMatch(xml, /pipeline documental multiagente/i, 'no pipeline branding sentence');
  assert.doesNotMatch(xml, /Marca de validacion/i, 'no validation-mark caption');
  assert.doesNotMatch(
    xml,
    /American Psychological Association\. \(2020\)/,
    'no APA-manual citation stub',
  );

  // No synthetic marker image: a plain doc has no reference images, so
  // word/media must not carry the tiny validation PNG.
  assert.deepEqual(docxMediaEntries(artifact.buffer), [], 'no marker media entries');

  // The professional cleanup must not break validation.
  const expected = INTERNAL.expectedFor(plan.format, plan.template, plan.complexity, plan);
  assert.equal(expected.requiresImage, false, 'images only required when attachments carry them');
  assert.equal(expected.minTables, 0, 'tables are content-driven, not filler');
  const validation = validateDocument({ format: 'docx', buffer: artifact.buffer, expected });
  assert.equal(validation.passed, true, 'clean document still passes validation');
  assert.equal(validation.checks.table, true, 'minTables 0 is honoured (no || 1 fallback)');
  assert.equal(validation.checks.media, true);
});

test('academic DOCX renders real references only when reference material exists', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-refs-'));

  // Without attachments: no references section stub.
  const bare = buildPlan({
    prompt: 'Informe académico sobre metodología de investigación cuantitativa.',
    format: 'docx',
    template: 'academic',
    complexity: 'standard',
  });
  const bareArtifact = await INTERNAL.buildDocumentFile({ plan: bare, outputDir });
  assert.doesNotMatch(
    docxText(bareArtifact.buffer),
    /American Psychological Association\. \(2020\)/,
    'academic template must not pad with the APA manual stub',
  );

  // With real reference briefs: a Referencias section listing them.
  const withRefs = buildPlan({
    prompt: 'Informe académico sobre metodología de investigación cuantitativa.',
    format: 'docx',
    template: 'academic',
    complexity: 'standard',
    referenceFiles: [
      { name: 'estudio-base.pdf', mimeType: 'application/pdf', extractedText: 'Hallazgos del estudio base sobre metodología cuantitativa aplicada en campo con resultados replicables.' },
    ],
  });
  const refsArtifact = await INTERNAL.buildDocumentFile({ plan: withRefs, outputDir });
  const refsXml = docxText(refsArtifact.buffer);
  assert.match(refsXml, /estudio-base\.pdf/i, 'real reference listed');
});

test('blueprint documents keep their own real tables and still satisfy minTables 4', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-blueprint-'));
  const plan = buildPlan({
    prompt: 'Genera un Word profesional de alta complejidad sobre gestión de riesgos de IA: incluye metodología, matriz de riesgos, gobernanza y plan de implementación.',
    format: 'docx',
    template: 'business',
    complexity: 'high',
  });
  assert.equal(plan.qualityTargets.professionalBlueprint, 'ai-risk-professional-brief');

  const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
  const expected = INTERNAL.expectedFor(plan.format, plan.template, plan.complexity, plan);
  assert.ok(expected.minTables >= 4, 'blueprint keeps its table requirement');
  const validation = validateDocument({ format: 'docx', buffer: artifact.buffer, expected });
  assert.equal(validation.checks.table, true, 'blueprint tables are real content, not QA filler');
  assert.doesNotMatch(docxText(artifact.buffer), /Archivo DOCX inspeccionable/i);
});
