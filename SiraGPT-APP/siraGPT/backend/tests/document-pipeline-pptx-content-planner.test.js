const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const {
  buildPptxContentPlan,
  hasGenericPlaceholderText,
} = require('../src/services/document-pipeline/pptx-content-planner');
const {
  buildPlan,
  validateDocument,
  INTERNAL,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

function pptxSlideText(buffer) {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .map((name) => zip.file(name).asText())
    .join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('pptx content planner creates domain-specific slides for business administration', () => {
  const plan = buildPptxContentPlan({
    title: 'Administracion de empresas',
    prompt: 'crea una ppt de la administracion de empresas',
    template: 'business',
  });
  const text = JSON.stringify(plan);

  assert.equal(plan.source, 'domain:business-administration');
  assert.ok(plan.slides.length >= 8);
  assert.match(text, /planificaci[oó]n/i);
  assert.match(text, /organizaci[oó]n/i);
  assert.match(text, /direcci[oó]n/i);
  assert.match(text, /control/i);
  assert.match(text, /finanzas/i);
  assert.equal(hasGenericPlaceholderText(text), false);
});

test('advanced PPTX builder writes topic-aware text into the native file', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-content-'));
  try {
    const plan = buildPlan({
      prompt: 'crea una ppt de la administracion de empresas',
      format: 'pptx',
      template: 'business',
    });
    const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const validation = validateDocument({
      format: 'pptx',
      buffer: artifact.buffer,
      expected: { minSlides: 6, requiresChart: true, requiresImage: true, requiresNotes: true },
    });
    const text = pptxSlideText(artifact.buffer);

    assert.equal(plan.title, 'Administracion de empresas');
    assert.equal(validation.checks.contentSpecific, true);
    assert.match(text, /Funciones administrativas/i);
    assert.match(text, /Planificaci[oó]n/i);
    assert.match(text, /Finanzas/i);
    assert.match(text, /Riesgos de gesti[oó]n/i);
    assert.equal(hasGenericPlaceholderText(text), false);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
