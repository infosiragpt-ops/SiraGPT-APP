const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const PizZip = require('pizzip');

const {
  appendToDocxBuffer,
  buildAppendixBlocks,
  fillDocxSectionBuffer,
  generateSourcePreservingDocumentEdit,
  inferDocumentTitle,
  isSourcePreservingEditRequest,
  loadEditableSourceFiles,
  parseTargetSectionRequest,
  INTERNAL: sourcePreservingInternals,
} = require('../src/services/source-preserving-document-edit');
const {
  buildDocumentDeliveryPolicy,
} = require('../src/services/agents/document-delivery-policy');

async function makeDocxBuffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Capítulo 1. Introducción original'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeDocxWithAnexo3Buffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('ANEXO 1'),
        new Paragraph('Contenido original del anexo uno.'),
        new Paragraph('ANEXO 3'),
        new Paragraph('[Pendiente de completar]'),
        new Paragraph('ANEXO 4'),
        new Paragraph('Contenido original del anexo cuatro.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('source-preserving document edit', () => {
  it('detects requests to edit the uploaded document instead of creating a new file', () => {
    const prompt = 'quiero que agregues al final el intuemtno de tesis que vamos a aplicar en esta tesis';

    assert.equal(isSourcePreservingEditRequest(prompt, ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest(prompt, []), true);
    assert.equal(isSourcePreservingEditRequest('agrega una tabla de presupuesto', []), false);
    assert.equal(isSourcePreservingEditRequest('agrega al final una tabla de presupuesto', []), false);
    assert.equal(isSourcePreservingEditRequest('dame un resumen en un solo párrafo', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('calcula la diferencia usando los documentos adjuntos', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('compara el PDF y el DOCX adjuntos e indica la cifra final', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('Genera un Word profesional: incluye tabla Excel, índice y conclusiones.', []), false);
    assert.equal(isSourcePreservingEditRequest('Genera un Word profesional sobre el documento adjunto: incluye tabla Excel, índice y conclusiones.', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('completa el anexo 3', ['file-docx']), true);
    assert.deepEqual(parseTargetSectionRequest('completa el anexo 3'), {
      kind: 'anexo',
      number: 3,
      numeric: '3',
      roman: 'III',
      label: 'Anexo 3',
    });
  });

  it('falls back to the newest recent editable chat attachment when the follow-up omits file ids', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-doc-'));
    const original = await makeDocxBuffer();
    const oldPath = path.join(tmp, 'old.docx');
    const newPath = path.join(tmp, 'tesis.docx');
    fs.writeFileSync(oldPath, original);
    fs.writeFileSync(newPath, original);

    const prisma = {
      message: {
        async findMany() {
          return [
            {
              id: 'message-new',
              files: JSON.stringify([{ id: 'file-new', name: 'tesis.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]),
              timestamp: new Date('2026-05-02T10:00:00Z'),
            },
            {
              id: 'message-old',
              files: [{ id: 'file-old', name: 'old.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
              timestamp: new Date('2026-05-01T10:00:00Z'),
            },
          ];
        },
      },
      file: {
        async findMany(query) {
          assert.deepEqual(query.where.id.in, ['file-new', 'file-old']);
          return [{
            id: 'file-new',
            filename: 'tesis.docx',
            originalName: 'tesis.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: original.length,
            path: newPath,
            extractedText: '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana”',
          }];
        },
      },
    };

    const files = await loadEditableSourceFiles(prisma, {
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: [],
      prompt: 'agrega al final el instrumento de tesis en anexos',
    });

    assert.equal(files.length, 1);
    assert.equal(files[0].id, 'file-new');
    assert.equal(files[0].path, newPath);
  });

  it('promotes source-preserving edits to doc_required so an artifact is returned', () => {
    const policy = buildDocumentDeliveryPolicy({
      goal: 'agrega al final un anexo con el instrumento de tesis',
      files: ['file-docx'],
    });

    assert.equal(policy.mode, 'doc_required');
    assert.equal(policy.autoGenerate, true);
  });

  it('appends instrument content into word/document.xml without replacing original body text', async () => {
    const original = await makeDocxBuffer();
    const sourceText = [
      '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025”',
      'Capítulo 1. Introducción',
      'La informalidad de las MYPES afecta la recaudación fiscal.',
    ].join('\n');
    const blocks = buildAppendixBlocks({
      prompt: 'agrega al final el instrumento de tesis',
      sourceText,
      originalName: 'tesis.docx',
    });

    const edited = appendToDocxBuffer(original, blocks);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /Capítulo 1\. Introducción original/);
    assert.match(xml, /ANEXOS/);
    assert.match(xml, /Instrumento de recolección de datos/);
    assert.match(xml, /informalidad de las MYPES/i);
    assert.match(xml, /recaudación fiscal/i);
    assert.doesNotMatch(xml, /Solicitud del usuario:/);
    assert.doesNotMatch(xml, /siraGPT Document Pipeline/);
  });

  it('fills only the requested DOCX section instead of appending a new appendix', async () => {
    const original = await makeDocxWithAnexo3Buffer();
    const edited = fillDocxSectionBuffer(original, parseTargetSectionRequest('completa el anexo 3'), [
      { kind: 'normal', text: 'Contenido específico del anexo tres con información integrada.' },
    ]);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /ANEXO 1/);
    assert.match(xml, /Contenido original del anexo uno/);
    assert.match(xml, /ANEXO 3/);
    assert.match(xml, /Contenido específico del anexo tres/);
    assert.match(xml, /ANEXO 4/);
    assert.match(xml, /Contenido original del anexo cuatro/);
    assert.doesNotMatch(xml, /Pendiente de completar/);
    assert.equal((xml.match(/ANEXOS/g) || []).length, 0);
  });

  it('returns a downloadable edited DOCX artifact instead of failing after validation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-generate-'));
    const originalPath = path.join(tmp, 'tesis.docx');
    fs.writeFileSync(originalPath, await makeDocxBuffer());

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-docx',
        path: originalPath,
        originalName: 'tesis.docx',
        filename: 'tesis.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana”',
      },
      prompt: 'agrega al final el instrumento de tesis en anexos',
      displayPrompt: 'agrega al final el instrumento de tesis en anexos',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.file.format, 'docx');
    assert.match(result.file.filename, /con_anexos\.docx$/);
    assert.ok(result.file.url);
    assert.equal(Object.prototype.hasOwnProperty.call(result.file, 'htmlPreview'), true);

    const edited = fs.readFileSync(result.artifact.path);
    const xml = new PizZip(edited).file('word/document.xml').asText();
    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /ANEXOS/);
    assert.match(xml, /Instrumento de recolección de datos/);
  });

  it('completes a targeted DOCX appendix using the combined uploaded document context', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-anexo-'));
      const originalPath = path.join(tmp, 'matrices.docx');
      const referencePath = path.join(tmp, 'contexto.txt');
      fs.writeFileSync(originalPath, await makeDocxWithAnexo3Buffer());
      fs.writeFileSync(referencePath, 'La matriz de consistencia integra problema, objetivos, hipótesis, variables y metodología.');

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: 'matrices.docx',
          filename: 'matrices.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Título: Introducción de matrices. ANEXO 3 pendiente.',
        },
        sourceFiles: [
          {
            id: 'file-docx',
            path: originalPath,
            originalName: 'matrices.docx',
            filename: 'matrices.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            extractedText: 'Título: Introducción de matrices. ANEXO 3 pendiente.',
          },
          {
            id: 'file-ref',
            path: referencePath,
            originalName: 'contexto.txt',
            filename: 'contexto.txt',
            mimeType: 'text/plain',
            extractedText: 'La matriz de consistencia integra problema, objetivos, hipótesis, variables y metodología.',
          },
        ],
        prompt: 'completa el anexo 3',
        displayPrompt: 'completa el anexo 3',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.format, 'docx');
      assert.match(result.file.filename, /anexo_3_completado\.docx$/);
      assert.match(result.content, /Anexo 3/);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.match(xml, /ANEXO 1/);
      assert.match(xml, /ANEXO 3/);
      assert.match(xml, /ANEXO 4/);
      assert.match(xml, /contexto\.txt/);
      assert.match(xml, /matriz de consistencia integra problema/);
      assert.doesNotMatch(xml, /Pendiente de completar/);
      assert.doesNotMatch(xml, /ANEXOS/);
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  it('keeps structured text artifacts valid while appending content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-json-'));
    const originalPath = path.join(tmp, 'tesis.json');
    fs.writeFileSync(originalPath, JSON.stringify({ original: true, title: 'Tesis base' }, null, 2));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-json',
        path: originalPath,
        originalName: 'tesis.json',
        filename: 'tesis.json',
        mimeType: 'application/json',
        extractedText: '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana”',
      },
      prompt: 'agrega al final el instrumento de tesis en anexos',
      displayPrompt: 'agrega al final el instrumento de tesis en anexos',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.format, 'json');
    assert.equal(result.validation.passed, true);

    const parsed = JSON.parse(fs.readFileSync(result.artifact.path, 'utf8'));
    assert.equal(parsed.original, true);
    assert.match(parsed._siraGPT_appendix.content, /ANEXOS/);
    assert.match(parsed._siraGPT_appendix.content, /Instrumento de recolección de datos/);
  });

  it('keeps YAML artifacts valid and passing MIME validation while appending content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-yaml-'));
    const originalPath = path.join(tmp, 'tesis.yaml');
    fs.writeFileSync(originalPath, 'original: true\ntitle: Tesis base\n');

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-yaml',
        path: originalPath,
        originalName: 'tesis.yaml',
        filename: 'tesis.yaml',
        mimeType: 'application/yaml',
        extractedText: '“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana”',
      },
      prompt: 'agrega al final el instrumento de tesis en anexos',
      displayPrompt: 'agrega al final el instrumento de tesis en anexos',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.format, 'yaml');
    assert.equal(result.validation.passed, true);
    assert.equal(result.validation.checks.mime_type, true);

    const edited = fs.readFileSync(result.artifact.path, 'utf8');
    assert.match(edited, /original: true/);
    assert.match(edited, /# SiraGPT appendix/);
    assert.match(edited, /ANEXOS/);
  });

  it('infers the thesis title from quoted source text instead of using the prompt as title', () => {
    const title = inferDocumentTitle(
      'FACULTAD DE XXXXX\n“Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025”',
      'tesis.docx',
    );

    assert.equal(title, 'Impacto de la informalidad de las MYPES en la recaudación fiscal de Lima Metropolitana durante el periodo 2020-2025');
  });
});

async function makeStyledDocxWithAnexo3Buffer() {
  const styledBody = (text) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, font: 'Times New Roman', size: 28 })],
  });
  const doc = new Document({
    sections: [{
      children: [
        styledBody('Portada original redactada con fuente Times New Roman a tamaño catorce puntos.'),
        new Paragraph({ children: [new TextRun({ text: 'ANEXO 3', bold: true, font: 'Times New Roman', size: 28 })] }),
        new Paragraph('[Pendiente de completar]'),
        styledBody('Contenido original del anexo cuatro conservando el formato académico de la tesis.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function findParagraphContaining(xml, needle) {
  return (xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).find((paragraph) => paragraph.includes(needle));
}

describe('source-preserving document edit — format inheritance', () => {
  it('fills the section reusing the source document font, size and alignment instead of generic defaults', async () => {
    const original = await makeStyledDocxWithAnexo3Buffer();
    const edited = fillDocxSectionBuffer(original, parseTargetSectionRequest('completa el anexo 3'), [
      { kind: 'normal', text: 'Contenido específico del anexo tres generado para la tesis.' },
    ]);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    const insertedParagraph = findParagraphContaining(xml, 'Contenido específico del anexo tres');
    assert.ok(insertedParagraph, 'inserted paragraph should exist');
    // Inherits the document's run formatting (Times New Roman 14pt = 28 half-points)…
    assert.match(insertedParagraph, /Times New Roman/);
    assert.match(insertedParagraph, /w:sz w:val="28"/);
    // …and its paragraph alignment, without re-imposing the generic 12pt default.
    assert.match(insertedParagraph, /w:jc w:val="both"/);
    assert.doesNotMatch(insertedParagraph, /w:sz w:val="24"/);

    // Original content and structure stay untouched; the placeholder is replaced.
    assert.match(xml, /Portada original redactada/);
    assert.match(xml, /Contenido original del anexo cuatro/);
    assert.doesNotMatch(xml, /Pendiente de completar/);
  });

  it('appends an appendix whose body text inherits the source document font', async () => {
    const original = await makeStyledDocxWithAnexo3Buffer();
    const edited = appendToDocxBuffer(original, [
      { kind: 'heading1', text: 'ANEXOS' },
      { kind: 'normal', text: 'Texto del anexo agregado que debe respetar la tipografía base del documento.' },
    ]);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    const appendedBody = findParagraphContaining(xml, 'tipografía base del documento');
    assert.ok(appendedBody, 'appended body paragraph should exist');
    assert.match(appendedBody, /Times New Roman/);
    assert.match(appendedBody, /w:sz w:val="28"/);

    // The new appendix heading keeps its readable heading-size ladder default.
    const appendedHeading = findParagraphContaining(xml, 'ANEXOS');
    assert.ok(appendedHeading, 'appended heading should exist');
    assert.match(appendedHeading, /w:sz w:val="32"/);
  });

  it('falls back to generic styling when the source document declares no formatting', async () => {
    const plain = new Document({
      sections: [{
        children: [
          new Paragraph('ANEXO 3'),
          new Paragraph('[Pendiente de completar]'),
          new Paragraph('Contenido original del anexo cuatro sin formato explícito declarado.'),
        ],
      }],
    });
    const buffer = Buffer.from(await Packer.toBuffer(plain));
    const edited = fillDocxSectionBuffer(buffer, parseTargetSectionRequest('completa el anexo 3'), [
      { kind: 'normal', text: 'Contenido específico del anexo tres con estilo por defecto.' },
    ]);
    const xml = new PizZip(edited).file('word/document.xml').asText();
    const insertedParagraph = findParagraphContaining(xml, 'Contenido específico del anexo tres');
    assert.ok(insertedParagraph, 'inserted paragraph should exist');
    assert.match(insertedParagraph, /w:sz w:val="24"/);
    assert.match(insertedParagraph, /w:jc w:val="both"/);
  });

  it('captures paragraph/run properties and strips section breaks and list numbering', () => {
    const {
      extractParagraphProperties,
      extractRunProperties,
      sanitizeCapturedParagraphProperties,
    } = sourcePreservingInternals;

    const paragraph = '<w:p><w:pPr><w:jc w:val="both"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr>'
      + '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="28"/></w:rPr><w:t>texto</w:t></w:r></w:p>';

    const pPr = extractParagraphProperties(paragraph);
    assert.match(pPr, /w:jc w:val="both"/);
    const cleaned = sanitizeCapturedParagraphProperties(pPr);
    assert.match(cleaned, /w:jc w:val="both"/);
    assert.doesNotMatch(cleaned, /w:sectPr/);
    assert.doesNotMatch(cleaned, /w:numPr/);

    const rPr = extractRunProperties(paragraph);
    assert.match(rPr, /Times New Roman/);
    assert.match(rPr, /w:sz w:val="28"/);
  });
});
