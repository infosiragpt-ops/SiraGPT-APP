'use strict';

// Regression guard: the design layer (charts + native tables) must stay wired
// into the source-preserving editor through the insert_visual / insert_table
// operations. Runs deterministically (no model) via the inline parsers, so it
// protects the integration even when the editor is edited by other work.

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph } = require('docx');
const PizZip = require('pizzip');

const { generateSourcePreservingDocumentEdit } = require('../src/services/source-preserving-document-edit');
const { isVisualAvailable } = require('../src/services/document-visual-embed');

let savedKey;
before(() => { savedKey = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; });
after(() => { if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey; });

async function writeDocx(children) {
  const doc = new Document({ sections: [{ children: children.map((t) => new Paragraph(t)) }] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-integration-'));
  const file = path.join(tmp, 'doc.docx');
  fs.writeFileSync(file, Buffer.from(await Packer.toBuffer(doc)));
  return file;
}

function sourceFile(p) {
  return {
    id: 'f1', path: p, originalName: 'doc.docx', filename: 'doc.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extractedText: 'Documento de prueba.',
  };
}

async function run(prompt, filePath) {
  return generateSourcePreservingDocumentEdit({
    sourceFile: sourceFile(filePath), prompt, displayPrompt: prompt, userId: 'u', chatId: 'c',
  });
}

describe('design layer ↔ editor integration', () => {
  it('embeds a chart into the DOCX via insert_visual (request → drawing)', async (t) => {
    if (!isVisualAvailable()) { t.skip('sharp not available'); return; }
    const file = await writeDocx(['Capítulo IV. Resultados.']);
    const res = await run('agrega un gráfico de barras con Lima 48, Arequipa 22, Cusco 18', file);
    const zip = new PizZip(fs.readFileSync(res.artifact.path));
    assert.match(zip.file('word/document.xml').asText(), /<w:drawing>/);
    assert.ok(zip.file('word/media/image1.png'), 'chart image embedded');
    assert.match(zip.file('word/document.xml').asText(), /Capítulo IV/); // preserved
  });

  it('inserts a native table into the DOCX via insert_table (markdown → w:tbl)', async () => {
    const file = await writeDocx(['Capítulo III. Presupuesto.']);
    const prompt = 'agrega una tabla con | Concepto | Monto |\n| Materiales | 1200 |\n| Servicios | 800 |';
    const res = await run(prompt, file);
    const xml = new PizZip(fs.readFileSync(res.artifact.path)).file('word/document.xml').asText();
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /Materiales/);
    assert.match(xml, /Capítulo III/); // preserved
  });

  it('does not insert a visual/table for an unrelated edit request', async () => {
    const file = await writeDocx(['Texto original del documento.']);
    const res = await run('corrige la ortografía y mejora la redacción del documento', file);
    const xml = new PizZip(fs.readFileSync(res.artifact.path)).file('word/document.xml').asText();
    assert.doesNotMatch(xml, /<w:drawing>/);
    assert.match(xml, /Texto original/); // preserved
  });
});
