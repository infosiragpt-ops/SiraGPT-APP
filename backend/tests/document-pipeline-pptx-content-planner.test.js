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
  buildPptxHtmlPreview,
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
    assert.match(text, /ciclo directivo reduce incertidumbre/i);
    assert.match(text, /Planificaci[oó]n/i);
    assert.match(text, /Finanzas/i);
    assert.match(text, /controles protegen velocidad y valor/i);
    assert.equal(hasGenericPlaceholderText(text), false);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('requested 8 slides produces exactly 8 in PPTX and HTML preview', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-exact-count-'));
  try {
    const plan = buildPlan({
      prompt: 'Créame una PPT en 8 diapositivas sobre gestión de empresas, sin inventar estadísticas.',
      format: 'pptx',
      template: 'business',
    });
    assert.equal(plan.slideTarget, 8);
    const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const zip = new PizZip(artifact.buffer);
    const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const chartFiles = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const validation = validateDocument({
      format: 'pptx',
      buffer: artifact.buffer,
      expected: { minSlides: 8, exactSlides: 8, requiresChart: false, requiresImage: false, requiresNotes: true },
    });
    const preview = buildPptxHtmlPreview(plan, artifact.filename, validation);

    assert.equal(slideFiles.length, 8);
    assert.equal(chartFiles.length, 0, 'no decorative chart without grounded data');
    assert.equal(validation.checks.exactSlideCount, true);
    assert.match(preview, /VISTA PREVIA · 8 LÁMINAS/);
    assert.equal((preview.match(/aspect-ratio:16\/9/g) || []).length, 8);
    assert.doesNotMatch(pptxSlideText(artifact.buffer), /68\s*%|Claridad\s+8\d|Impacto\s+7\d/i);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('PPTX prompt fidelity is a blocking validation and repair recomputes it', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-fidelity-block-'));
  try {
    const plan = buildPlan({
      prompt: 'Crea una PPT en 8 diapositivas sobre gestión de empresas. Debe incluir riesgos.',
      format: 'pptx',
      template: 'business',
    });
    const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
    const blocked = validateDocument({
      format: 'pptx',
      buffer: artifact.buffer,
      expected: {
        minSlides: 8,
        exactSlides: 8,
        requiresChart: false,
        requiresImage: false,
        requiresNotes: true,
        promptFidelity: false,
      },
    });
    assert.equal(blocked.checks.promptFidelity, false);
    assert.equal(blocked.passed, false);

    plan.promptFidelity = { passed: false };
    const repaired = INTERNAL.repairPlan(plan, blocked);
    assert.equal(repaired.promptFidelity.passed, true, JSON.stringify(repaired.promptFidelity));
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
