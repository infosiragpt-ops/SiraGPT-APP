const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const PizZip = require('pizzip');

const { createDocument } = require('../src/services/document-service');

test('document-service creates a real PPTX with render-agent preview metadata', async () => {
  const userId = `test-pptx-${Date.now()}`;
  const filename = 'marketing_presentacion.pptx';
  const content = `
# Presentación PowerPoint sobre Marketing

## Diapositiva 1 - Portada
- Marketing estratégico para empresas digitales.
- Objetivo: comprender conceptos, métricas y acciones.
Nota del ponente: abrir con el valor del marketing como sistema.

## Diapositiva 2 - Agenda
- Concepto de marketing
- Segmentación
- Marketing digital
- Métricas

## Diapositiva 3 - Concepto central
- El marketing conecta necesidades del mercado con propuestas de valor.
- La estrategia debe partir de investigación y posicionamiento.

## Diapositiva 4 - Métricas
- CAC, LTV, ROAS y conversión deben gobernar la mejora continua.
- La medición evita decisiones basadas solo en intuición.
`;

  let created;
  try {
    created = await createDocument(userId, filename, content);
    const buffer = await fs.readFile(created.filePath);
    const zip = new PizZip(buffer);
    const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));

    assert.equal(created.format, 'pptx');
    assert.ok(created.slideCount >= 6, `expected at least 6 slides, got ${created.slideCount}`);
    assert.ok(created.htmlPreview.includes('siraGPT Rendering Agent'));
    assert.ok(created.htmlPreview.includes('Marketing'));
    assert.ok(zip.file('ppt/presentation.xml'), 'ppt/presentation.xml must exist');
    assert.ok(slideFiles.length >= 6, `expected OOXML slide files, got ${slideFiles.length}`);
    assert.ok(buffer.length > 10_000, `PPTX is suspiciously small: ${buffer.length} bytes`);
  } finally {
    const dir = path.join(__dirname, '../uploads/documents', userId);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
