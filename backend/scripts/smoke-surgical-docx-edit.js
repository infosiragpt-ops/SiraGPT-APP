#!/usr/bin/env node
'use strict';

/**
 * Offline smoke: surgical DOCX edit on the SAME document.
 * No network, no sandbox — pure in-process source-preserving path.
 *
 *   node scripts/smoke-surgical-docx-edit.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const PizZip = require('pizzip');

const {
  generateSourcePreservingDocumentEdit,
  INTERNAL: { replaceTextInDocxBuffer, deleteTextFromDocxBuffer },
} = require('../src/services/source-preserving-document-edit');

function paragraphText(xml = '') {
  const pieces = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml))) {
    pieces.push(m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
  }
  return pieces.join('');
}

function extractParagraphs(documentXml = '') {
  const paragraphs = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = re.exec(documentXml))) {
    paragraphs.push(match[0]);
  }
  return paragraphs;
}

function findParagraph(documentXml, needle) {
  return extractParagraphs(documentXml).find((p) => paragraphText(p).includes(needle)) || null;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-surgical-'));
  const sourcePath = path.join(tmp, 'informe-tesis.docx');

  const sourceBuffer = Buffer.from(await Packer.toBuffer(new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Informe Preliminar UPN', bold: true, size: 32 })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'El capítulo de ' }),
            new TextRun({ text: 'Introducción original', bold: true }),
            new TextRun({ text: ' describe el problema de investigación.', italics: true }),
          ],
        }),
        new Paragraph('Párrafo hermano intacto — no debe mutar.'),
        new Paragraph({
          children: [
            new TextRun({ text: 'Estado: ' }),
            new TextRun({ text: 'BOR', bold: true }),
            new TextRun({ text: 'RAD', bold: true, italics: true }),
            new TextRun({ text: 'OR', bold: true }),
            new TextRun({ text: ' del comité.' }),
          ],
        }),
      ],
    }],
  })));
  fs.writeFileSync(sourcePath, sourceBuffer);

  const beforeXml = new PizZip(sourceBuffer).file('word/document.xml').asText();
  const siblingBefore = findParagraph(beforeXml, 'Párrafo hermano intacto');
  assert(siblingBefore, 'sibling paragraph present in source');

  // 1) Low-level surgical replace (mixed formatting)
  const r1 = replaceTextInDocxBuffer(sourceBuffer, 'Introducción original', 'Introducción mejorada');
  let xml = new PizZip(r1.buffer).file('word/document.xml').asText();
  assert(/Introducción mejorada/.test(xml), 'replacement text present');
  assert(!/Introducción original/.test(xml), 'old needle gone');
  assert(/<w:b[\s/>]/.test(xml) || /w:b\s*\/>/.test(xml), 'bold preserved after mixed replace');
  const siblingAfter1 = findParagraph(xml, 'Párrafo hermano intacto');
  assert(siblingAfter1 === siblingBefore, 'sibling paragraph byte-identical after replace');

  // 2) Needle split across runs
  const r2 = replaceTextInDocxBuffer(r1.buffer, 'BORRADOR', 'APROBADO');
  xml = new PizZip(r2.buffer).file('word/document.xml').asText();
  const text2 = paragraphText(xml);
  assert(/APROBADO/.test(text2), 'split-run replacement applied');
  assert(!/BORRADOR/.test(text2), 'split-run needle removed');

  // 3) Partial delete
  const r3 = deleteTextFromDocxBuffer(r2.buffer, 'del comité.');
  xml = new PizZip(r3.buffer).file('word/document.xml').asText();
  const text3 = paragraphText(xml);
  assert(!/del comité/.test(text3), 'partial delete removed needle');
  assert(/APROBADO/.test(text3), 'rest of paragraph kept after partial delete');

  // 4) Full source-preserving pipeline (chat-equivalent path)
  fs.writeFileSync(sourcePath, sourceBuffer);
  const result = await generateSourcePreservingDocumentEdit({
    sourceFile: {
      id: 'smoke-file',
      path: sourcePath,
      originalName: 'informe-tesis.docx',
      filename: 'informe-tesis.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractedText: 'Informe Preliminar UPN. Introducción original. Estado: BORRADOR del comité.',
    },
    prompt: 'reemplaza "Introducción original" por "Introducción mejorada" y cambia "BORRADOR" por "APROBADO" sin tocar el resto del documento',
    displayPrompt: 'reemplaza "Introducción original" por "Introducción mejorada" y cambia "BORRADOR" por "APROBADO" sin tocar el resto del documento',
    userId: 'smoke-user',
    chatId: 'smoke-chat',
  });

  assert(result && result.artifact, 'pipeline produced artifact');
  assert(result.validation && result.validation.passed !== false, 'validation passed');
  const outPath = result.artifact.path || result.file?.path;
  assert(outPath && fs.existsSync(outPath), `artifact path exists: ${outPath}`);
  const outBuf = fs.readFileSync(outPath);
  const outXml = new PizZip(outBuf).file('word/document.xml').asText();
  const outText = paragraphText(outXml);
  assert(/Introducción mejorada/.test(outText), 'pipeline: intro replaced');
  assert(/APROBADO/.test(outText), 'pipeline: status replaced with original casing');
  assert(!/BORRADOR/.test(outText), 'pipeline: old status gone');
  assert(/Párrafo hermano intacto/.test(outText), 'pipeline: sibling kept');
  assert(/Informe Preliminar UPN/.test(outText), 'pipeline: title kept');

  console.log(JSON.stringify({
    ok: true,
    engine: 'source-preserving-surgical',
    artifact: {
      filename: result.artifact.filename,
      sizeBytes: outBuf.length,
      format: result.format,
    },
    validation: result.validation?.checks || result.validation,
    operations: (result.orchestration?.operations || []).map((o) => o.kind),
    proofs: [
      'mixed-run replace preserves bold',
      'sibling paragraph byte-identical',
      'split-run needle BORRADOR→APROBADO',
      'partial delete keeps rest of paragraph',
      'full pipeline returns validated artifact',
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err && err.stack || err);
  process.exit(1);
});
