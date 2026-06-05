const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell } = require('docx');
const PizZip = require('pizzip');

const {
  appendToDocxBuffer,
  buildAppendixBlocks,
  fillDocxCronogramaSectionBuffer,
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

async function makeDocxWithAnexo3CronogramaBuffer() {
  const blankCells = (count) => Array.from({ length: count }, () => new TableCell({ children: [new Paragraph('')] }));
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Anexo 1. Matriz de Consistencia Interna'),
        new Paragraph('Contenido original del anexo uno.'),
        new Paragraph('Anexo 2. Matriz de Operacionalización de las Variables'),
        new Paragraph('Contenido original del anexo dos.'),
        new Paragraph('Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis'),
        new Table({
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('AVANCE DE LA TESIS')] }),
                new TableCell({ children: [new Paragraph('ACCIONES')] }),
                new TableCell({ children: [new Paragraph('ESTADO')] }),
                new TableCell({ children: [new Paragraph('FECHAS')] }),
              ],
            }),
            ...Array.from({ length: 23 }, () => new TableRow({ children: blankCells(20) })),
          ],
        }),
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

  it('fills the existing Anexo 3 cronograma table without adding generic narrative paragraphs', async () => {
    const original = await makeDocxWithAnexo3CronogramaBuffer();
    const target = parseTargetSectionRequest('deseo que completes el anexo 3 en su mismo formato');
    const edited = fillDocxCronogramaSectionBuffer(original, target);
    const xml = new PizZip(edited).file('word/document.xml').asText();

    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /Anexo 1\. Matriz de Consistencia Interna/);
    assert.match(xml, /Anexo 2\. Matriz de Operacionalización de las Variables/);
    assert.match(xml, /Anexo 3\. Cronograma del Desarrollo y Culminación de la Tesis/);
    assert.match(xml, /AVANCE DE LA TESIS/);
    assert.match(xml, /Lineamientos y cronograma de tesis/);
    assert.match(xml, /Problema, objetivos, hipótesis y método/);
    assert.match(xml, /Informe final y sustentación/);
    assert.match(xml, /S1/);
    assert.match(xml, /S17/);
    assert.equal((xml.match(/<w:tbl\b/g) || []).length, 1);
    assert.equal((xml.match(/ANEXOS/g) || []).length, 0);
    assert.doesNotMatch(xml, /El Anexo 3 presenta un análisis detallado/i);
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

  it('generates the real cronograma artifact by editing the source DOCX table in place', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-cronograma-'));
      const originalPath = path.join(tmp, 'tesis-cronograma.docx');
      fs.writeFileSync(originalPath, await makeDocxWithAnexo3CronogramaBuffer());

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: 'tesis-cronograma.docx',
          filename: 'tesis-cronograma.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis.',
        },
        prompt: 'deseo que completes el anexo 3 en su mismo formato',
        displayPrompt: 'deseo que completes el anexo 3 en su mismo formato',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.passed, true);
      assert.match(result.file.filename, /anexo_3_completado\.docx$/);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.match(xml, /Anexo 3\. Cronograma del Desarrollo y Culminación de la Tesis/);
      assert.match(xml, /Lineamientos y cronograma de tesis/);
      assert.match(xml, /Informe final y sustentación/);
      assert.equal((xml.match(/<w:tbl\b/g) || []).length, 1);
      assert.doesNotMatch(xml, /El Anexo 3 presenta un análisis detallado/i);
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

describe('source-preserving document edit — agentic multi-step planning', () => {
  const { planSourcePreservingOperations, splitRequestClauses } = sourcePreservingInternals;
  const DOC_WITH_ANEXO3 = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis</w:t></w:r></w:p>'
    + '</w:body></w:document>';

  it('splits a compound request into one clause per action verb', () => {
    const clauses = splitRequestClauses('completa el anexo 3 en su mismo formato y agregar los instrumentos profesionales como un anexo 4');
    assert.equal(clauses.length, 2);
    assert.match(clauses[0], /anexo 3/);
    assert.match(clauses[1], /anexo 4/);
  });

  it('plans a fill for the existing section and a labeled append for the new instrument anexo', () => {
    const ops = planSourcePreservingOperations({
      requestText: 'completa el anexo 3 en su mismo formato y agregar los instrumentos profesionales como un anexo 4',
      documentXml: DOC_WITH_ANEXO3,
    });
    assert.equal(ops.length, 2);
    assert.equal(ops[0].kind, 'fill_section');
    assert.equal(ops[0].target.label, 'Anexo 3');
    assert.equal(ops[1].kind, 'append_labeled');
    assert.equal(ops[1].target.label, 'Anexo 4');
    assert.equal(ops[1].wantsInstrument, true);
  });

  it('keeps a single-intent request as one operation (backward compatible)', () => {
    assert.equal(splitRequestClauses('completa el anexo 3').length, 1);
    const ops = planSourcePreservingOperations({ requestText: 'completa el anexo 3', documentXml: DOC_WITH_ANEXO3 });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'fill_section');
  });

  it('falls back to a generic instrument appendix when no explicit section is named', () => {
    const ops = planSourcePreservingOperations({
      requestText: 'agrega al final el instrumento de tesis en anexos',
      documentXml: '<w:document><w:body></w:body></w:document>',
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'append_generic');
    assert.equal(ops[0].wantsInstrument, true);
  });

  it('executes both intentions: fills the Anexo 3 cronograma table AND appends a new Anexo 4 with the instrument', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-multi-'));
    const originalPath = path.join(tmp, 'tesis.docx');
    fs.writeFileSync(originalPath, await makeDocxWithAnexo3CronogramaBuffer());

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-docx',
        path: originalPath,
        originalName: 'tesis.docx',
        filename: 'tesis.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'Tesis con cronograma y matrices.',
      },
      prompt: 'deseo que completes el anexo 3 en su mismo formato y agregar los instrumentos profesionales como un anexo 4',
      displayPrompt: 'deseo que completes el anexo 3 en su mismo formato y agregar los instrumentos profesionales como un anexo 4',
      userId: 'user-1',
      chatId: 'chat-1',
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.validation.passed, true);
    assert.match(result.content, /2 pasos/);

    const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
    // Step 1: the cronograma table is filled in place.
    assert.match(xml, /AVANCE DE LA TESIS/);
    assert.match(xml, /Planificaci[oó]n/);
    // Step 2: a brand-new Anexo 4 with the professional instrument is appended.
    assert.match(xml, /Anexo 4\. Instrumentos de recolección de datos/);
    assert.match(xml, /Escala de respuesta/);
    // The originally requested Anexo 3 heading is preserved.
    assert.match(xml, /Anexo 3\. Cronograma/);
  });
});

async function makeDocxWithGenericTableBuffer({ heading = 'Anexo 5. Matriz de Operacionalización de Variables', headers = ['Variable', 'Dimensión', 'Indicador', 'Ítems'], dataRows = 6 } = {}) {
  const headerCell = (text) => new TableCell({ children: [new Paragraph(text)] });
  const blankCell = () => new TableCell({ children: [new Paragraph('')] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph(heading),
        new Table({
          rows: [
            new TableRow({ children: headers.map(headerCell) }),
            ...Array.from({ length: dataRows }, () => new TableRow({ children: headers.map(blankCell) })),
          ],
        }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('source-preserving document edit — generic table fill (any section)', () => {
  const {
    analyzeTableForFill,
    detectSectionTablePlan,
    fillGenericSectionTableBuffer,
    generateTableRowsContent,
  } = sourcePreservingInternals;

  it('identifies the content columns and empty data rows of an arbitrary table', async () => {
    const buffer = await makeDocxWithGenericTableBuffer();
    const tableXml = new PizZip(buffer).file('word/document.xml').asText().match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0];
    const analysis = analyzeTableForFill(tableXml);
    assert.deepEqual(analysis.labels, ['Variable', 'Dimensión', 'Indicador', 'Ítems']);
    assert.equal(analysis.contentColCount, 4);
    assert.equal(analysis.dataRows.length, 6);
  });

  it('stops the content columns at a wide grouping/date column (e.g. FECHAS)', async () => {
    const buffer = await makeDocxWithGenericTableBuffer({ headers: ['Actividad', 'Responsable', 'FECHAS'], dataRows: 3 });
    const tableXml = new PizZip(buffer).file('word/document.xml').asText().match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0];
    const analysis = analyzeTableForFill(tableXml);
    assert.deepEqual(analysis.labels, ['Actividad', 'Responsable']);
    assert.equal(analysis.contentColCount, 2);
  });

  it('detects a fillable table plan inside the requested section', async () => {
    const buffer = await makeDocxWithGenericTableBuffer();
    const plan = detectSectionTablePlan(buffer, parseTargetSectionRequest('completa el anexo 5'));
    assert.ok(plan);
    assert.deepEqual(plan.labels, ['Variable', 'Dimensión', 'Indicador', 'Ítems']);
    assert.equal(plan.dataRowCount, 6);
  });

  it('fills the content cells of an arbitrary table preserving its structure and the rest of the document', async () => {
    const buffer = await makeDocxWithGenericTableBuffer();
    const rows = [
      ['Gestión de inventarios', 'Control de stock', 'Rotación de inventario', '¿Con qué frecuencia se revisa el stock?'],
      ['Eficiencia operativa', 'Productividad', 'Pedidos atendidos', '¿Cuántos pedidos se atienden por día?'],
    ];
    const filled = fillGenericSectionTableBuffer(buffer, parseTargetSectionRequest('completa el anexo 5'), rows);
    const xml = new PizZip(filled).file('word/document.xml').asText();
    const cellCounts = (doc) => (doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0].match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [])
      .map((row) => (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).length).join(',');

    assert.match(xml, /Gestión de inventarios/);
    assert.match(xml, /Rotación de inventario/);
    assert.match(xml, /Pedidos atendidos/);
    // structure intact + rest of the document preserved
    assert.equal(cellCounts(xml), cellCounts(new PizZip(buffer).file('word/document.xml').asText()));
    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /Matriz de Operacionalización/);
  });

  it('degrades to no rows when the model is unavailable so the caller can fall back', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const rows = await generateTableRowsContent({
        labels: ['Variable', 'Indicador'],
        maxRows: 4,
        sectionLabel: 'Anexo 5',
        sourceText: 'contexto',
        prompt: 'completa el anexo 5',
      });
      assert.deepEqual(rows, []);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe('source-preserving document edit — document-understanding brain', () => {
  const {
    analyzeDocumentStructure,
    heuristicPlanIsConfident,
    planOperationsWithLLM,
    planSourcePreservingOperations,
    planSourcePreservingOperationsSmart,
    summarizeStructureForPrompt,
  } = sourcePreservingInternals;

  async function makeMixedThesisDocxXml() {
    const headerCell = (text) => new TableCell({ children: [new Paragraph(text)] });
    const blankCell = () => new TableCell({ children: [new Paragraph('')] });
    const emptyTable = (headers) => new Table({
      rows: [
        new TableRow({ children: headers.map(headerCell) }),
        ...Array.from({ length: 4 }, () => new TableRow({ children: headers.map(blankCell) })),
      ],
    });
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph('Anexo 1. Matriz de Consistencia'),
          new Paragraph('Contenido ya redactado del anexo uno con su análisis completo.'),
          new Paragraph('Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis'),
          emptyTable(['AVANCE DE LA TESIS', 'ACCIONES', 'ESTADO', 'FECHAS']),
          new Paragraph('Anexo 5. Matriz de Operacionalización de Variables'),
          emptyTable(['Variable', 'Dimensión', 'Indicador', 'Ítems']),
        ],
      }],
    });
    return new PizZip(Buffer.from(await Packer.toBuffer(doc))).file('word/document.xml').asText();
  }

  it('analyzes the document structure: which sections exist, hold a fillable table, or are empty', async () => {
    const documentXml = await makeMixedThesisDocxXml();
    const { sections } = analyzeDocumentStructure(documentXml);
    const byLabel = Object.fromEntries(sections.map((s) => [s.label, s]));
    assert.equal(byLabel['Anexo 1'].hasTable, false);
    assert.equal(byLabel['Anexo 1'].isEmpty, false);
    assert.equal(byLabel['Anexo 3'].hasTable, true);
    assert.equal(byLabel['Anexo 3'].emptyTableRows, 4);
    assert.deepEqual(byLabel['Anexo 5'].tableHeaders, ['Variable', 'Dimensión', 'Indicador', 'Ítems']);
    assert.match(summarizeStructureForPrompt({ sections }), /Anexo 3: tabla por completar/);
  });

  it('understands a bulk request and fills every empty-table section deterministically', async () => {
    const documentXml = await makeMixedThesisDocxXml();
    const ops = planSourcePreservingOperations({ requestText: 'rellena todas las tablas vacías de los anexos', documentXml });
    const filled = ops.filter((op) => op.kind === 'fill_section').map((op) => op.target.label).sort();
    assert.deepEqual(filled, ['Anexo 3', 'Anexo 5']);
  });

  it('routes clear requests to the heuristic and ambiguous ones to the LLM brain', async () => {
    const documentXml = await makeMixedThesisDocxXml();
    const confident = (req) => heuristicPlanIsConfident(planSourcePreservingOperations({ requestText: req, documentXml }), req);
    // Clear — handled deterministically, no model call.
    assert.equal(confident('completa el anexo 3'), true);
    assert.equal(confident('completa el anexo 3 y agregar los instrumentos como un anexo 4'), true);
    assert.equal(confident('agrega al final el instrumento de tesis en anexos'), true);
    // Ambiguous — a table cue with no matching fill / no covered section → escalate.
    assert.equal(confident('pon el cronograma y agrega el cuestionario de mi tesis'), false);
    assert.equal(confident('necesito que me ayudes con mi tesis'), false);
  });

  it('keeps the smart planner deterministic (heuristic) when the model is unavailable', async () => {
    const documentXml = await makeMixedThesisDocxXml();
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.equal(await planOperationsWithLLM({ requestText: 'pon el cronograma', documentXml }), null);
      const ops = await planSourcePreservingOperationsSmart({ requestText: 'completa el anexo 3', documentXml });
      assert.equal(ops.length, 1);
      assert.equal(ops[0].kind, 'fill_section');
      assert.equal(ops[0].target.label, 'Anexo 3');
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});
