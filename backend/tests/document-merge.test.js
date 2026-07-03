'use strict';

/**
 * document-merge — offline unit tests.
 *
 * Covers: bilingual merge-intent detection (positives/negatives, pronoun-only
 * forms on attachment turns), the real OOXML body merge (both documents' text
 * present in the output, verified with mammoth; formatting container intact),
 * the extracted-text fallback builder, and the document_edit deterministic
 * merge fast-path (artifact persisted + file_artifact emitted + doc-agent
 * never invoked). Also the shouldUseAgenticChat merge-routing gate.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the artifact store BEFORE task-tools is (transitively) required.
const ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-merge-artifacts-'));
process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;

const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const mammoth = require('mammoth');
const merge = require('../src/services/agents/document-merge');
const { buildDocumentEditTool } = require('../src/services/agent-harness/tools/document-edit-tool');

async function makeDocx(paragraphs, { heading } = {}) {
  const children = [];
  if (heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(heading)] }));
  for (const p of paragraphs) children.push(new Paragraph({ children: [new TextRun(p)] }));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

// ─── Intent detection ────────────────────────────────────────────────────────

test('merge intent: bilingual positives', () => {
  const positives = [
    ['combina estos 2 words en 1', 2],
    ['fusiona los dos documentos en un solo word', 2],
    ['une los archivos adjuntos en un único documento', 2],
    ['junta los 2 words y devuélveme 1 word', 2],
    ['únelos', 2],
    ['combínalos en uno solo', 2],
    ['merge these two docs into one', 2],
    ['combine both files as one document', 2],
    ['consolida los informes en un solo docx', 0], // noun present → no files needed
    ['quiero que fusiones los documentos', 2],
  ];
  for (const [text, fileCount] of positives) {
    assert.equal(merge.isDocumentMergeRequest(text, { fileCount }), true, `should match: ${text}`);
  }
});

test('merge intent: negatives', () => {
  const negatives = [
    ['resume el documento', 2],
    ['¿qué dice el archivo?', 2],
    ['combina bien los sabores de esta receta y explícame el resultado paso a paso por favor', 0],
    ['traduce el documento al inglés', 2],
    ['edita mi documento y corrige la ortografía', 2],
    ['', 2],
  ];
  for (const [text, fileCount] of negatives) {
    assert.equal(merge.isDocumentMergeRequest(text, { fileCount }), false, `should NOT match: ${text}`);
  }
});

// ─── OOXML merge ─────────────────────────────────────────────────────────────

test('mergeDocxBuffers: both documents present, page break between, valid docx', async () => {
  const a = await makeDocx(['Contenido del primer documento ALFA.'], { heading: 'Informe Alfa' });
  const b = await makeDocx(['Contenido del segundo documento BETA.'], { heading: 'Informe Beta' });

  const out = merge.mergeDocxBuffers([
    { name: 'alfa.docx', buffer: a },
    { name: 'beta.docx', buffer: b },
  ]);

  assert.ok(Buffer.isBuffer(out) && out.length > 0);
  const { value: text } = await mammoth.extractRawText({ buffer: out });
  assert.match(text, /primer documento ALFA/);
  assert.match(text, /segundo documento BETA/);
  assert.match(text, /Informe Alfa/);
  assert.match(text, /Informe Beta/);

  // Page break inserted between the two bodies.
  const PizZip = require('pizzip');
  const zip = new PizZip(out);
  const docXml = zip.file('word/document.xml').asText();
  assert.match(docXml, /<w:br w:type="page"\/>/);
  // Only ONE body-level sectPr survives (the base one).
  assert.ok(docXml.indexOf('<w:sectPr') === docXml.lastIndexOf('<w:sectPr'), 'second doc sectPr must be stripped');
});

test('mergeDocxBuffers: three documents, order preserved', async () => {
  const bufs = await Promise.all([
    makeDocx(['UNO primero']),
    makeDocx(['DOS segundo']),
    makeDocx(['TRES tercero']),
  ]);
  const out = merge.mergeDocxBuffers(bufs.map((buffer, i) => ({ name: `d${i}.docx`, buffer })));
  const { value: text } = await mammoth.extractRawText({ buffer: out });
  const iUno = text.indexOf('UNO primero');
  const iDos = text.indexOf('DOS segundo');
  const iTres = text.indexOf('TRES tercero');
  assert.ok(iUno !== -1 && iDos !== -1 && iTres !== -1);
  assert.ok(iUno < iDos && iDos < iTres, 'document order must be preserved');
});

test('mergeDocxBuffers: rejects non-zip sources', async () => {
  const a = await makeDocx(['ok']);
  assert.throws(() => merge.mergeDocxBuffers([
    { name: 'a.docx', buffer: a },
    { name: 'b.docx', buffer: Buffer.from('not a zip at all') },
  ]));
});

// ─── Extracted-text fallback ────────────────────────────────────────────────

test('mergeFromExtractedText: builds a readable merged docx', async () => {
  const out = await merge.mergeFromExtractedText([
    { name: 'notas.txt', text: 'Primera parte del contenido.\n\nSegundo párrafo.' },
    { name: 'anexo.docx', text: 'Contenido del anexo B.' },
  ]);
  const { value: text } = await mammoth.extractRawText({ buffer: out });
  assert.match(text, /Primera parte del contenido/);
  assert.match(text, /Contenido del anexo B/);
  assert.match(text, /notas\.txt/);
});

test('mergedFilename: derives from the first file, capped', () => {
  assert.equal(merge.mergedFilename([{ name: 'informe.docx' }, { name: 'anexo.docx' }]), 'informe (fusionado).docx');
  const long = merge.mergedFilename([{ name: `${'x'.repeat(60)}.docx` }]);
  assert.ok(long.length < 60);
});

// ─── document_edit fast-path ────────────────────────────────────────────────

function fakePrisma(rows) {
  return {
    file: {
      findMany: async (q) => rows.filter((r) => q.where.id.in.includes(r.id) && r.userId === q.where.userId),
    },
  };
}

test('document_edit merge fast-path: deterministic merge, artifact + event, doc-agent NOT called', async () => {
  const a = await makeDocx(['Documento primero MERGEA.']);
  const b = await makeDocx(['Documento segundo MERGEB.']);
  const pa = path.join(os.tmpdir(), `merge-a-${Date.now()}.docx`);
  const pb = path.join(os.tmpdir(), `merge-b-${Date.now()}.docx`);
  fs.writeFileSync(pa, a);
  fs.writeFileSync(pb, b);

  let docAgentCalled = false;
  let spCalled = false;
  const events = [];
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', path: pa, originalName: 'alfa.docx', filename: 'alfa.docx', mimeType: merge.DOCX_MIME },
      { id: 'f2', userId: 'u1', path: pb, originalName: 'beta.docx', filename: 'beta.docx', mimeType: merge.DOCX_MIME },
    ]),
    sourcePreservingEdit: { tryGenerateSourcePreservingDocumentEdit: async () => { spCalled = true; return null; } },
    runDocumentAgent: async () => { docAgentCalled = true; return { outputs: [] }; },
  });

  const out = await tool.execute(
    { instruction: 'fusiona los dos documentos adjuntos en un solo word' },
    { userId: 'u1', chatId: 'c1', fileIds: ['f1', 'f2'], signal: new AbortController().signal, onEvent: (e) => events.push(e) },
  );

  assert.equal(out.ok, true);
  assert.equal(out.engine, 'merge-deterministic');
  assert.equal(docAgentCalled, false, 'doc-agent must NOT run for a simple merge');
  assert.equal(spCalled, false, 'source-preserving editor must NOT run for a merge');
  assert.match(out.edited[0].filename, /fusionado.*\.docx$/i);
  assert.match(out.edited[0].downloadUrl, /^\/api\/agent\/artifact\//);

  const fa = events.find((e) => e.type === 'file_artifact');
  assert.ok(fa, 'file_artifact event emitted');
  assert.equal(fa.artifact.mime, merge.DOCX_MIME);

  // Artifact really merged: both texts inside.
  const onDisk = fs.readdirSync(ARTIFACT_DIR).find((n) => /fusionado/i.test(n));
  assert.ok(onDisk, 'merged artifact persisted');
  const { value: text } = await mammoth.extractRawText({ buffer: fs.readFileSync(path.join(ARTIFACT_DIR, onDisk)) });
  assert.match(text, /MERGEA/);
  assert.match(text, /MERGEB/);

  fs.rmSync(pa, { force: true });
  fs.rmSync(pb, { force: true });
});

test('document_edit merge fast-path: non-docx sources fall back to extracted text', async () => {
  const pa = path.join(os.tmpdir(), `merge-t1-${Date.now()}.txt`);
  const pb = path.join(os.tmpdir(), `merge-t2-${Date.now()}.txt`);
  fs.writeFileSync(pa, 'plain uno');
  fs.writeFileSync(pb, 'plain dos');
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', path: pa, originalName: 'uno.txt', filename: 'uno.txt', mimeType: 'text/plain', extractedText: 'TEXTO UNO extraído.' },
      { id: 'f2', userId: 'u1', path: pb, originalName: 'dos.txt', filename: 'dos.txt', mimeType: 'text/plain', extractedText: 'TEXTO DOS extraído.' },
    ]),
    sourcePreservingEdit: { tryGenerateSourcePreservingDocumentEdit: async () => null },
    runDocumentAgent: async () => ({ outputs: [] }),
  });
  const out = await tool.execute(
    { instruction: 'combínalos en un solo documento' },
    { userId: 'u1', chatId: 'c1', fileIds: ['f1', 'f2'], signal: new AbortController().signal, onEvent: () => {} },
  );
  assert.equal(out.ok, true);
  assert.equal(out.engine, 'merge-deterministic');
  const onDisk = fs.readdirSync(ARTIFACT_DIR).find((n) => /uno.*fusionado/i.test(n));
  assert.ok(onDisk, 'text-fallback artifact persisted');
  const { value: text } = await mammoth.extractRawText({ buffer: fs.readFileSync(path.join(ARTIFACT_DIR, onDisk)) });
  assert.match(text, /TEXTO UNO/);
  assert.match(text, /TEXTO DOS/);
  fs.rmSync(pa, { force: true });
  fs.rmSync(pb, { force: true });
});

test('document_edit NON-merge instruction still uses the normal editors', async () => {
  const pa = path.join(os.tmpdir(), `merge-n1-${Date.now()}.docx`);
  fs.writeFileSync(pa, await makeDocx(['hola']));
  const pb = path.join(os.tmpdir(), `merge-n2-${Date.now()}.docx`);
  fs.writeFileSync(pb, await makeDocx(['mundo']));
  let docAgentCalled = false;
  const tool = buildDocumentEditTool({
    prisma: fakePrisma([
      { id: 'f1', userId: 'u1', path: pa, originalName: 'a.docx', filename: 'a.docx' },
      { id: 'f2', userId: 'u1', path: pb, originalName: 'b.docx', filename: 'b.docx' },
    ]),
    sourcePreservingEdit: { tryGenerateSourcePreservingDocumentEdit: async () => null },
    runDocumentAgent: async () => { docAgentCalled = true; return { outputs: [{ name: 'ed.docx', buffer: Buffer.from('x'), valid: true }] }; },
  });
  const out = await tool.execute(
    { instruction: 'corrige la ortografía de ambos documentos' },
    { userId: 'u1', chatId: 'c1', fileIds: ['f1', 'f2'], signal: new AbortController().signal, onEvent: () => {} },
  );
  assert.equal(docAgentCalled, true, 'non-merge edits keep the doc-agent path');
  assert.equal(out.ok, true);
  fs.rmSync(pa, { force: true });
  fs.rmSync(pb, { force: true });
});

// ─── Routing gate ───────────────────────────────────────────────────────────

test('shouldUseAgenticChat routes merge requests with attachments into the loop', () => {
  const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
  assert.equal(
    shouldUseAgenticChat({ prompt: 'combina estos 2 words en 1', files: [{ id: 'f1' }, { id: 'f2' }] }),
    true,
  );
  assert.equal(
    shouldUseAgenticChat({ prompt: 'fusiona los documentos en un solo word', files: [{ id: 'f1' }, { id: 'f2' }] }),
    true,
  );
});
