const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const {
  runAdvancedDocumentPipeline,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

test('docx pipeline preserves formula-heavy requests in generated Word files', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-formulas-'));
  try {
    const result = await runAdvancedDocumentPipeline({
      prompt: 'Crear un Word academico con calculo de muestra para una poblacion de 119 padres de familia, incluir formulas LaTeX y tabla de parametros.',
      format: 'docx',
      template: 'academic',
      complexity: 'high',
      outputDir,
      maxRepairAttempts: 1,
    });

    assert.equal(result.validation.passed, true);
    assert.equal(result.validation.checks.formulaContent, true);
    assert.equal(result.validation.checks.headerFooter, true);
    assert.equal(result.validation.checks.media, true);

    const zip = new PizZip(result.buffer);
    const documentXml = zip.file('word/document.xml').asText();
    assert.match(documentXml, /Calculo de muestra|<m:oMath|n\s*=/i);
    assert.match(documentXml, /119/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
