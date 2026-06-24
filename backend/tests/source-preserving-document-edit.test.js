const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell } = require('docx');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
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
  tryGenerateSourcePreservingDocumentEdit,
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

async function makeDocxWithAnexo3CronogramaBuffer({
  heading = 'Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis',
} = {}) {
  const blankCells = (count) => Array.from({ length: count }, () => new TableCell({ children: [new Paragraph('')] }));
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Anexo 1. Matriz de Consistencia Interna'),
        new Paragraph('Contenido original del anexo uno.'),
        new Paragraph('Anexo 2. Matriz de Operacionalización de las Variables'),
        new Paragraph('Contenido original del anexo dos.'),
        new Paragraph(heading),
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

async function makeDocxWithAnexo3CronogramaStatusBuffer({ statusForRow = () => 'Completado', leakText = false } = {}) {
  const plan = sourcePreservingInternals.buildCronogramaAnexo3Plan();
  const blankCells = (count) => Array.from({ length: count }, () => new TableCell({ children: [new Paragraph('')] }));
  const doc = new Document({
    sections: [{
      children: [
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
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('')] }),
                new TableCell({ children: [new Paragraph('')] }),
                new TableCell({ children: [new Paragraph('')] }),
                ...plan.weekLabels.map((label) => new TableCell({ children: [new Paragraph(label)] })),
              ],
            }),
            ...plan.rows.map((row, index) => new TableRow({
              children: [
                new TableCell({ children: [new Paragraph(row.avance)] }),
                new TableCell({
                  children: [new Paragraph(leakText && index === 0
                    ? `${row.acciones} <w:tcPr><w:tcW w:type="dxa"/></w:tcPr>`
                    : row.acciones)],
                }),
                new TableCell({ children: [new Paragraph(statusForRow(row, index))] }),
                ...blankCells(plan.weekLabels.length),
              ],
            })),
          ],
        }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeDocxWithSingleHeaderCronogramaBuffer({
  heading = 'Anexo 03. Cronograma del Desarrollo y Culminación de la Tesis',
} = {}) {
  const plan = sourcePreservingInternals.buildCronogramaAnexo3Plan();
  const cell = (text = '') => new TableCell({ children: [new Paragraph(text)] });
  const header = ['AVANCE DE LA TESIS', 'ACCIONES', 'ESTADO', ...plan.weekLabels];
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph(heading),
        new Table({
          rows: [
            new TableRow({ children: header.map(cell) }),
            ...plan.rows.map((row) => new TableRow({
              children: [
                cell(row.avance),
                cell(row.acciones),
                cell('Pendiente'),
                ...plan.weekLabels.map(() => cell('')),
              ],
            })),
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
    assert.equal(isSourcePreservingEditRequest('modifica mi documento general con este nuevo contenido', []), true);
    assert.equal(isSourcePreservingEditRequest('analiza este documento adjunto y agrégalo a mi documento general', ['file-ref']), true);
    // Whole-document transforms over the uploaded file must preserve the source.
    assert.equal(isSourcePreservingEditRequest('traduce este documento al inglés', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('resume este documento', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('reescribe el documento adjunto en un tono más formal', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('reformula mi documento word', []), true);
    assert.equal(isSourcePreservingEditRequest('cambia el título de la portada del documento', ['file-docx']), true);
    // No document reference → still a normal chat answer, not a preserving edit.
    assert.equal(isSourcePreservingEditRequest('traduce esta frase al inglés', []), false);
    assert.equal(isSourcePreservingEditRequest('resume la reunión de ayer', []), false);
    assert.equal(isSourcePreservingEditRequest('cambia de tema', []), false);
    // Transform verb + attached file but only a pronoun reference (no document
    // noun) must NOT hijack the request into a source-preserving edit.
    assert.equal(isSourcePreservingEditRequest('traduce esta frase al inglés', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('cambia de tema', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('resume esta idea en una línea', ['file-docx']), false);
    // Noun forms (cambio / resumen / traducción) in read-only questions must NOT
    // be mistaken for transform verbs, even with a document attached.
    assert.equal(isSourcePreservingEditRequest('explica el cambio del documento', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('cuál es el resumen del documento', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('qué dice la traducción del documento', ['file-docx']), false);
    // reescribir parity with the frontend: whole-document transform, so it needs
    // an explicit document noun and must agree with shouldEditExistingDocument.
    assert.equal(isSourcePreservingEditRequest('reescribe esta frase', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('reescribe este documento en un tono formal', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('explica la reescritura del documento', ['file-docx']), false);
    assert.deepEqual(parseTargetSectionRequest('completa el anexo 3'), {
      kind: 'anexo',
      number: 3,
      numeric: '3',
      roman: 'III',
      label: 'Anexo 3',
    });
    assert.deepEqual(parseTargetSectionRequest('completa el anexo 03'), {
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

  it('uses the latest generated DOCX as the main document and current uploads as reference material', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-general-doc-'));
      const mainPath = path.join(tmp, 'documento-general.docx');
      const refPath = path.join(tmp, 'soporte.txt');
      fs.writeFileSync(mainPath, await makeDocxBuffer());
      fs.writeFileSync(refPath, 'Hallazgo externo de validación: el documento de soporte exige reforzar la matriz de riesgos y las recomendaciones.');

      const prisma = {
        file: {
          async findMany(query) {
            assert.deepEqual(query.where.id.in, ['file-ref']);
            return [{
              id: 'file-ref',
              filename: 'soporte.txt',
              originalName: 'soporte.txt',
              mimeType: 'text/plain',
              size: fs.statSync(refPath).size,
              path: refPath,
              extractedText: 'Hallazgo externo de validación: el documento de soporte exige reforzar la matriz de riesgos y las recomendaciones.',
            }];
          },
        },
        generatedArtifact: {
          async findMany() {
            return [{
              id: 'artifact-main',
              filename: 'documento-general.docx',
              mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              format: 'docx',
              path: mainPath,
              sizeBytes: fs.statSync(mainPath).size,
              createdAt: new Date('2026-06-05T12:00:00Z'),
              validation: { passed: true },
            }];
          },
        },
      };

      const result = await tryGenerateSourcePreservingDocumentEdit({
        prisma,
        userId: 'user-1',
        chatId: 'chat-1',
        fileIds: ['file-ref'],
        prompt: 'analiza este documento adjunto y agrégalo a mi documento general',
        displayPrompt: 'analiza este documento adjunto y agrégalo a mi documento general',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.details.orchestration.sourceSelection, 'latest_generated_docx_artifact');
      assert.deepEqual(result.validation.details.orchestration.referenceFiles, ['soporte.txt']);
      assert.match(result.file.filename, /documentos_integrados\.docx$/);

      const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /Portada original UPN/);
      assert.match(xml, /Contenido integrado de documentos de soporte/);
      assert.match(xml, /Hallazgo externo de validación/);
      assert.doesNotMatch(xml, /Solicitud del usuario:/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it('continues follow-up edits on the latest generated DOCX instead of the older uploaded attachment', () => {
    const selection = sourcePreservingInternals.selectSourcePreservingDocumentSet({
      requestText: 'agrega al final un instrumento profesional de recolección de datos',
      sourceFiles: [{
        id: 'file-original',
        filename: 'original.docx',
        originalName: 'original.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'recent_attachment',
      }],
      priorArtifacts: [{
        id: 'artifact-edited',
        filename: 'original_anexo_3_completado.docx',
        originalName: 'original_anexo_3_completado.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'generated_artifact',
      }],
    });

    assert.equal(selection.sourceFile.id, 'artifact-edited');
    assert.equal(selection.selectionReason, 'latest_generated_docx_artifact');

    const explicitSelection = sourcePreservingInternals.selectSourcePreservingDocumentSet({
      requestText: 'completa el anexo 3',
      sourceFiles: [{
        id: 'file-current',
        filename: 'nuevo.docx',
        originalName: 'nuevo.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'current_upload',
      }],
      priorArtifacts: [{
        id: 'artifact-old',
        filename: 'old.docx',
        originalName: 'old.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'generated_artifact',
      }],
    });

    assert.equal(explicitSelection.sourceFile.id, 'file-current');
    assert.equal(explicitSelection.selectionReason, 'current_docx_target_section');
  });

  it('does not crash selecting a source set when there is no editable file at all', () => {
    // Regresión: fileStableKey(null) lanzaba "Cannot read properties of null
    // (reading 'id')" cuando no había archivo base ni artefacto previo, lo que
    // bloqueaba la creación del documento ("coloca esta información en un word").
    let selection;
    assert.doesNotThrow(() => {
      selection = sourcePreservingInternals.selectSourcePreservingDocumentSet({
        requestText: 'coloca esta información en un word',
        sourceFiles: [],
        priorArtifacts: [],
      });
    });
    assert.equal(selection.sourceFile, null);
    assert.deepEqual(selection.sourceFiles, []);
    assert.deepEqual(selection.referenceFiles, []);
  });

  it('returns null (generate a fresh document) when "coloca esta información en un word" has no base file', async () => {
    // Regresión del flujo del usuario: sin archivo adjunto ni artefacto previo,
    // la petición debe tratarse como documento NUEVO (devuelve null para que el
    // caller lo genere) en vez de crashear o rechazar con "No generé un
    // documento nuevo para evitar entregarte contenido ajeno al archivo".
    const prisma = {
      file: { async findMany() { return []; } },
      generatedArtifact: { async findMany() { return []; } },
      message: { async findMany() { return []; } },
    };
    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: [],
      prompt: 'coloca esta información en un word',
      displayPrompt: 'coloca esta información en un word',
    });
    assert.equal(result, null);
  });

  it('asks for a compatible file (instead of crashing) when the only attachment is not editable', async () => {
    // Antes del fix, un adjunto no editable (p. ej. una imagen) también
    // disparaba fileStableKey(null) → "Cannot read properties of null". Ahora
    // pide un formato compatible con un mensaje útil.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-incompatible-'));
    const imgPath = path.join(tmp, 'foto.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const prisma = {
      file: {
        async findMany() {
          return [{
            id: 'file-img',
            filename: 'foto.png',
            originalName: 'foto.png',
            mimeType: 'image/png',
            size: 4,
            path: imgPath,
          }];
        },
      },
      generatedArtifact: { async findMany() { return []; } },
      message: { async findMany() { return []; } },
    };
    await assert.rejects(
      () => tryGenerateSourcePreservingDocumentEdit({
        prisma,
        userId: 'user-1',
        chatId: 'chat-1',
        fileIds: ['file-img'],
        prompt: 'edita este documento adjunto y agrégale una sección al final',
        displayPrompt: 'edita este documento adjunto y agrégale una sección al final',
      }),
      /archivo editable compatible|archivo DOCX/i,
    );
  });

  it('does not mistake an instrument request for external reference integration because it mentions Word final', () => {
    const prompt = 'agrega al final un instrumento profesional de recolección de datos para esta investigación y valida el Word final';

    assert.equal(sourcePreservingInternals.requestWantsReferenceIntegration(prompt), false);
    assert.equal(sourcePreservingInternals.requestWantsReferenceIntegration('analiza este documento adjunto y agrégalo a mi documento general'), true);

    const ops = sourcePreservingInternals.planSourcePreservingOperations({
      requestText: prompt,
      documentXml: '<w:document><w:body></w:body></w:document>',
      referenceFiles: [{ id: 'ref-original' }],
    });

    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'append_generic');
    assert.equal(ops[0].wantsInstrument, true);
  });

  it('recovers the previous DOCX from assistant message artifacts when generatedArtifact persistence is missing', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-message-artifact-'));
      const mainPath = path.join(tmp, 'documento-general.docx');
      const refPath = path.join(tmp, 'soporte.txt');
      fs.writeFileSync(mainPath, await makeDocxBuffer());
      fs.writeFileSync(refPath, 'Documento de soporte: incorporar controles de calidad documental y responsables de seguimiento.');

      const prisma = {
        file: {
          async findMany() {
            return [{
              id: 'file-ref',
              filename: 'soporte.txt',
              originalName: 'soporte.txt',
              mimeType: 'text/plain',
              size: fs.statSync(refPath).size,
              path: refPath,
              extractedText: 'Documento de soporte: incorporar controles de calidad documental y responsables de seguimiento.',
            }];
          },
        },
        generatedArtifact: {
          async findMany() {
            return [];
          },
        },
        message: {
          async findMany() {
            return [{
              timestamp: new Date('2026-06-05T12:00:00Z'),
              files: JSON.stringify([{
                type: 'doc',
                format: 'docx',
                filename: 'documento-general_anexo_3_completado.docx',
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                path: mainPath,
                url: '/api/agent/artifact/artifact-main?name=documento-general_anexo_3_completado.docx',
              }]),
            }];
          },
        },
      };

      const result = await tryGenerateSourcePreservingDocumentEdit({
        prisma,
        userId: 'user-1',
        chatId: 'chat-1',
        fileIds: ['file-ref'],
        prompt: 'analiza este documento adjunto y agrégalo a mi documento general',
        displayPrompt: 'analiza este documento adjunto y agrégalo a mi documento general',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.details.orchestration.sourceSelection, 'latest_generated_docx_artifact');
      assert.deepEqual(result.validation.details.orchestration.referenceFiles, ['soporte.txt']);

      const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /Portada original UPN/);
      assert.match(xml, /controles de calidad documental/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
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
      assert.doesNotMatch(xml, /En proceso/);
      assert.doesNotMatch(xml, /Pendiente/);
      assert.match(xml, /S1/);
      assert.match(xml, /S17/);
      assert.equal((xml.match(/<w:tbl\b/g) || []).length, 1);
    assert.equal((xml.match(/ANEXOS/g) || []).length, 0);
    assert.doesNotMatch(xml, /El Anexo 3 presenta un análisis detallado/i);
  });

  it('blocks Anexo 3 validation when statuses remain pending or OOXML leaks into visible text', async () => {
    const target = parseTargetSectionRequest('completa el anexo 3');
    const pending = await makeDocxWithAnexo3CronogramaStatusBuffer({
      statusForRow: (_, index) => (index % 2 === 0 ? 'En proceso' : 'Pendiente'),
    });
    const pendingReport = sourcePreservingInternals.validateDocxOperationCriteria(pending, [{ kind: 'fill_section', target }]);
    const pendingCheck = pendingReport.checks.find((check) => check.id === 'cronograma_anexo_3_completed');

    assert.equal(pendingReport.passed, false);
    assert.equal(pendingCheck.passed, false);
    assert.equal(pendingCheck.details.reason, 'incomplete_statuses_remaining');
    assert.ok(pendingCheck.details.incompleteStatuses >= 13);

    const leaked = await makeDocxWithAnexo3CronogramaStatusBuffer({ leakText: true });
    const leakReport = sourcePreservingInternals.validateDocxOperationCriteria(leaked, [{ kind: 'fill_section', target }]);
    const leakCheck = leakReport.checks.find((check) => check.id === 'cronograma_anexo_3_completed');

    assert.equal(leakReport.passed, false);
    assert.equal(leakCheck.passed, false);
    assert.equal(leakCheck.details.reason, 'visible_ooxml_text_in_table');
    assert.ok(leakCheck.details.xmlTextLeaks.length > 0);
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
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.ok(result.validation.details.agenticCycle);
      assert.equal(result.validation.details.agenticCycle.unresolvedChecks.length, 0);
      assert.match(result.file.filename, /anexo_3_completado\.docx$/);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.match(xml, /Anexo 3\. Cronograma del Desarrollo y Culminación de la Tesis/);
      assert.match(xml, /Lineamientos y cronograma de tesis/);
      assert.match(xml, /Informe final y sustentación/);
      assert.doesNotMatch(xml, /En proceso/);
      assert.doesNotMatch(xml, /Pendiente/);
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

  it('supports an autonomous multi-turn DOCX cycle: complete, add instrument, delete text and complete cover', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-autonomous-cycle-'));
      const originalPath = path.join(tmp, 'tesis-autonoma.docx');
      const seed = new Document({
        sections: [{
          children: [
            new Paragraph('Texto temporal para borrar'),
            new Paragraph('Portada original UPN'),
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
                ...Array.from({ length: 23 }, () => new TableRow({
                  children: Array.from({ length: 20 }, () => new TableCell({ children: [new Paragraph('')] })),
                })),
              ],
            }),
          ],
        }],
      });
      fs.writeFileSync(originalPath, Buffer.from(await Packer.toBuffer(seed)));

      const baseFile = {
        id: 'file-docx',
        path: originalPath,
        originalName: 'tesis-autonoma.docx',
        filename: 'tesis-autonoma.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: '“La inteligencia artificial y la experiencia del usuario en una empresa privada de tecnología en San Isidro, Lima 2025.”',
      };

      const completed = await generateSourcePreservingDocumentEdit({
        sourceFile: baseFile,
        prompt: 'completa el anexo 3',
        displayPrompt: 'completa el anexo 3',
        userId: 'user-1',
        chatId: 'chat-1',
      });
      assert.equal(completed.validation.passed, true);

      const instrumented = await generateSourcePreservingDocumentEdit({
        sourceFile: { ...baseFile, path: completed.artifact.path, originalName: completed.artifact.filename, filename: completed.artifact.filename },
        prompt: 'agrega al final un instrumento profesional',
        displayPrompt: 'agrega al final un instrumento profesional',
        userId: 'user-1',
        chatId: 'chat-1',
      });
      assert.equal(instrumented.validation.passed, true);

      const deleted = await generateSourcePreservingDocumentEdit({
        sourceFile: { ...baseFile, path: instrumented.artifact.path, originalName: instrumented.artifact.filename, filename: instrumented.artifact.filename },
        prompt: 'borra el texto temporal para borrar',
        displayPrompt: 'borra el texto temporal para borrar',
        userId: 'user-1',
        chatId: 'chat-1',
      });
      assert.equal(deleted.validation.passed, true);

      const covered = await generateSourcePreservingDocumentEdit({
        sourceFile: { ...baseFile, path: deleted.artifact.path, originalName: deleted.artifact.filename, filename: deleted.artifact.filename },
        prompt: 'completa la portada del word',
        displayPrompt: 'completa la portada del word',
        userId: 'user-1',
        chatId: 'chat-1',
      });
      assert.equal(covered.validation.passed, true);

      const xml = new PizZip(fs.readFileSync(covered.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /PORTADA COMPLETADA/);
      assert.match(xml, /Título de la investigación/);
      assert.match(xml, /Instrumento de recolección de datos/);
      assert.match(xml, /Escala de respuesta/);
      assert.match(xml, /Anexo 3\. Cronograma/);
      assert.match(xml, /Informe final y sustentación/);
      assert.doesNotMatch(xml, /Texto temporal para borrar/);
      assert.doesNotMatch(xml, /En proceso/);
      assert.doesNotMatch(xml, /Pendiente/);
      assert.equal(covered.validation.details.agenticCycle.unresolvedChecks.length, 0);
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
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

  it('extracts only the requested deletion target before validation instructions', () => {
    const ops = planSourcePreservingOperations({
      requestText: 'borra Aspectos Éticos del documento y valida el Word final',
      documentXml: DOC_WITH_ANEXO3,
    });

    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'delete_text');
    assert.equal(ops[0].needle, 'aspectos eticos');
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

  it('handles zero-padded appendix labels and completes Anexo 03 plus Anexo 04 in one validated DOCX', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-zero-padded-'));
      const originalPath = path.join(tmp, 'tesis.docx');
      fs.writeFileSync(originalPath, await makeDocxWithAnexo3CronogramaBuffer({
        heading: 'Anexo 03. Cronograma del Desarrollo y Culminación de la Tesis',
      }));

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: '609_120_Intro_y_matrices.docx',
          filename: '609_120_Intro_y_matrices.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Tesis con cronograma del desarrollo y matrices.',
        },
        prompt: 'completa el Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis y agrega el instrumento como anexo 04',
        displayPrompt: 'completa el Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis y agrega el instrumento como anexo 04',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.match(result.content, /2 pasos/);

      const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /Anexo 03\. Cronograma/);
      assert.match(xml, /Lineamientos y cronograma de tesis/);
      assert.match(xml, /Informe final y sustentación/);
      assert.match(xml, /Anexo 4\. Instrumentos de recolección de datos/);
      assert.match(xml, /Escala de respuesta/);
      assert.doesNotMatch(xml, /No pude editar/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it('completes single-header cronograma tables without skipping the final Entrega row', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-single-header-'));
      const originalPath = path.join(tmp, 'tesis.docx');
      fs.writeFileSync(originalPath, await makeDocxWithSingleHeaderCronogramaBuffer());

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: '609_120-_Intro_y_matrices.docx',
          filename: '609_120-_Intro_y_matrices.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Tesis con cronograma de desarrollo.',
        },
        prompt: 'completa el Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis y agrega el instrumento como anexo 04',
        displayPrompt: 'completa el Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis y agrega el instrumento como anexo 04',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);

      const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /Entrega/);
      assert.match(xml, /Informe final y sustentación/);
      assert.match(xml, /Anexo 4\. Instrumentos de recolección de datos/);
      assert.doesNotMatch(xml, /No pude editar/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
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

describe('source-preserving Office edit — generic XLSX/PPTX operations', () => {
  const {
    appendToPptxBuffer,
    extractTextFromPptxBuffer,
    planGenericOfficeOperations,
    replaceTextInDocxBuffer,
    replaceTextInPptxBuffer,
    replaceTextInXlsxBuffer,
    setXlsxCellBuffer,
  } = sourcePreservingInternals;

  async function makeXlsxBuffer() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Datos');
    sheet.addRow(['Estado', 'Observación']);
    sheet.addRow(['Pendiente', 'Revisar matriz']);
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async function readXlsxCell(buffer, address, sheetName = 'Datos') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook.getWorksheet(sheetName).getCell(address).value;
  }

  async function makePptxBuffer() {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const slide = pptx.addSlide();
    slide.addText('Título viejo', { x: 0.7, y: 0.6, w: 7, h: 0.6, fontSize: 26, bold: true });
    slide.addText('Contenido base', { x: 0.7, y: 1.5, w: 7, h: 1.2, fontSize: 18 });
    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    return Buffer.from(buffer);
  }

  it('plans replacement and Excel cell-write operations without section-specific prompts', () => {
    const replaceOps = planGenericOfficeOperations({
      requestText: 'reemplaza "Pendiente" por "Completado"',
      format: 'xlsx',
    });
    assert.deepEqual(replaceOps, [{ kind: 'replace_text', needle: 'Pendiente', replacement: 'Completado' }]);

    const cellOps = planGenericOfficeOperations({
      requestText: 'en la celda B2 escribe "Validado por comité"',
      format: 'xlsx',
    });
    assert.equal(cellOps[0].kind, 'set_cell');
    assert.equal(cellOps[0].address, 'B2');
    assert.equal(cellOps[0].value, 'Validado por comité');
  });

  it('replaces text and writes a specific cell in XLSX while preserving the workbook', async () => {
    const source = await makeXlsxBuffer();
    const replaced = await replaceTextInXlsxBuffer(source, 'Pendiente', 'Completado');
    assert.equal(await readXlsxCell(replaced.buffer, 'A2'), 'Completado');
    assert.equal(await readXlsxCell(replaced.buffer, 'B2'), 'Revisar matriz');

    const edited = await setXlsxCellBuffer(replaced.buffer, { address: 'B2', value: 'Validado por comité' });
    assert.equal(await readXlsxCell(edited.buffer, 'A2'), 'Completado');
    assert.equal(await readXlsxCell(edited.buffer, 'B2'), 'Validado por comité');
  });

  it('generates a validated XLSX artifact for a compound generic edit request', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-xlsx-generic-'));
    const originalPath = path.join(tmp, 'matriz.xlsx');
    fs.writeFileSync(originalPath, await makeXlsxBuffer());

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-xlsx',
        path: originalPath,
        originalName: 'matriz.xlsx',
        filename: 'matriz.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extractedText: 'Estado Pendiente; Observación Revisar matriz.',
      },
      prompt: 'reemplaza "Pendiente" por "Completado" y en la celda B2 escribe "Validado por comité"',
      displayPrompt: 'reemplaza "Pendiente" por "Completado" y en la celda B2 escribe "Validado por comité"',
      userId: 'user-office',
      chatId: 'chat-office',
    });

    assert.equal(result.format, 'xlsx');
    assert.equal(result.validation.passed, true);
    assert.equal(result.validation.checks.operation_criteria, true);
    assert.match(result.content, /reemplacé el texto específico/);
    assert.match(result.content, /actualicé la celda Datos!B2/);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'replace_text'), true);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'set_cell' && op.address === 'B2'), true);

    const edited = fs.readFileSync(result.artifact.path);
    assert.equal(await readXlsxCell(edited, 'A2'), 'Completado');
    assert.equal(await readXlsxCell(edited, 'B2'), 'Validado por comité');
  });

  it('replaces and deletes text in DOCX through the generic text operation', async () => {
    const source = await makeDocxBuffer();
    const replaced = replaceTextInDocxBuffer(source, 'Introducción original', 'Introducción mejorada');
    const text = sourcePreservingInternals
      .analyzeDocumentStructure(new PizZip(replaced.buffer).file('word/document.xml').asText());
    const xml = new PizZip(replaced.buffer).file('word/document.xml').asText();
    assert.match(xml, /Introducción mejorada/);
    assert.ok(text);
  });

  it('appends a real PPTX slide and preserves existing slides', async () => {
    const source = await makePptxBuffer();
    const edited = appendToPptxBuffer(source, [
      { kind: 'heading2', text: 'Nueva diapositiva de riesgos' },
      { kind: 'normal', text: 'Matriz de riesgos, controles y responsables.' },
    ]);
    const zip = new PizZip(edited);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slides.length, 2);
    const text = extractTextFromPptxBuffer(edited);
    assert.match(text, /Título viejo/);
    assert.match(text, /Nueva diapositiva de riesgos/);
    assert.match(text, /Matriz de riesgos/);
  });

  it('generates a validated PPTX artifact for replace plus new-slide requests', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-pptx-generic-'));
    const originalPath = path.join(tmp, 'riesgos.pptx');
    fs.writeFileSync(originalPath, await makePptxBuffer());

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-pptx',
        path: originalPath,
        originalName: 'riesgos.pptx',
        filename: 'riesgos.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extractedText: 'Título viejo. Contenido base.',
      },
      prompt: 'reemplaza "Título viejo" por "Título nuevo" y agrega una diapositiva sobre matriz de riesgos de IA',
      displayPrompt: 'reemplaza "Título viejo" por "Título nuevo" y agrega una diapositiva sobre matriz de riesgos de IA',
      userId: 'user-office',
      chatId: 'chat-office',
    });

    assert.equal(result.format, 'pptx');
    assert.equal(result.validation.passed, true);
    assert.equal(result.validation.checks.operation_criteria, true);
    assert.match(result.content, /reemplacé el texto específico/);
    assert.match(result.content, /agregué una diapositiva nueva/);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'replace_text'), true);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'append_generic'), true);

    const edited = fs.readFileSync(result.artifact.path);
    const text = extractTextFromPptxBuffer(edited);
    const slides = Object.keys(new PizZip(edited).files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slides.length, 2);
    assert.match(text, /Título nuevo/);
    assert.doesNotMatch(text, /Título viejo/);
    assert.match(text, /matriz de riesgos/i);
  });

  it('replaces and deletes PPTX slide text without rebuilding the deck', async () => {
    const source = await makePptxBuffer();
    const replaced = replaceTextInPptxBuffer(source, 'Título viejo', 'Título nuevo');
    assert.match(extractTextFromPptxBuffer(replaced.buffer), /Título nuevo/);
    assert.doesNotMatch(extractTextFromPptxBuffer(replaced.buffer), /Título viejo/);

    const deleted = replaceTextInPptxBuffer(replaced.buffer, 'Contenido base', '');
    assert.doesNotMatch(extractTextFromPptxBuffer(deleted.buffer), /Contenido base/);
    const slides = Object.keys(new PizZip(deleted.buffer).files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slides.length, 1);
  });
});

describe('append_references — referencias bibliográficas reales', () => {
  it('planea append_references con conteo para "agrega dos referencias en bibliografía al pie"', () => {
    const ops = sourcePreservingInternals.planSourcePreservingOperations({
      requestText: 'agrega dos referencias a este documento en bibliografia al pie',
      documentXml: '<w:document><w:body></w:body></w:document>',
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'append_references');
    assert.equal(ops[0].count, 2);
  });

  it('tolera el typo "bliografia" y números arábigos', () => {
    assert.equal(sourcePreservingInternals.clauseWantsBibliography('agrega 5 citas en la bliografia'), true);
    assert.equal(sourcePreservingInternals.extractReferenceCount('agrega 5 citas en la bliografia'), 5);
    assert.equal(sourcePreservingInternals.extractReferenceCount('agrega referencias'), 2);
  });

  it('formatea una referencia estilo APA con DOI', () => {
    const apa = sourcePreservingInternals.formatReferenceApa({
      title: 'Gestión administrativa moderna',
      authors: ['Pérez, J.', 'García, M.'],
      year: 2024,
      journal: 'Revista de Administración',
      doi: '10.1234/abc',
    });
    assert.match(apa, /Pérez, J.; García, M\./);
    assert.match(apa, /\(2024\)\./);
    assert.match(apa, /https:\/\/doi\.org\/10\.1234\/abc/);
  });

  it('sin red (NODE_ENV=test) degrada honestamente sin fabricar citas', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const input = await makeDocxBuffer();
      const result = await sourcePreservingInternals.runAppendReferencesOperation({
        buffer: input,
        op: { kind: 'append_references', count: 2 },
        sourceText: 'gestión administrativa en instituciones educativas',
        sourceFile: { originalName: 'matriz.docx' },
      });
      assert.equal(result.step.mode, 'unavailable');
      assert.equal(result.step.count, 0);
      assert.equal(result.buffer, input);
      assert.match(
        sourcePreservingInternals.describeStep(result.step),
        /no pude obtener referencias verificadas/,
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('describeStep reporta referencias verificadas agregadas', () => {
    assert.match(
      sourcePreservingInternals.describeStep({ kind: 'append_references', mode: 'scientific_search', count: 3 }),
      /agregué 3 referencia\(s\) bibliográfica\(s\) verificadas/,
    );
  });
});

describe('executeTextLikeOperations — in-place edits for plain-text files', () => {
  const { executeTextLikeOperations, countNeedleMatches } = sourcePreservingInternals;

  it('replaces text IN PLACE instead of only appending, preserving replacement casing (markdown)', () => {
    const input = Buffer.from('# Informe\n\nHola MUNDO, adios MUNDO.\n');
    const out = executeTextLikeOperations({ input, requestText: 'reemplaza MUNDO por TIERRA', format: 'md', blocks: [] });
    const text = out.buffer.toString('utf8');
    assert.match(text, /TIERRA/, 'replacement must keep the user-supplied casing (not lowercased)');
    assert.equal(/mundo/i.test(text), false, 'the original needle must be gone (replaced, not appended)');
    const replaceStep = out.steps.find((s) => s.kind === 'replace_text');
    assert.ok(replaceStep && replaceStep.changedCount === 2, 'reports both occurrences replaced');
    assert.equal(out.steps.some((s) => s.kind === 'append_generic'), false, 'a pure replace must NOT append an annex');
  });

  it('preserves accents/casing of an unquoted replacement', () => {
    const input = Buffer.from('Capítulo 1 — borrador');
    const out = executeTextLikeOperations({ input, requestText: 'reemplaza Capítulo 1 por Introducción', format: 'txt', blocks: [] });
    assert.match(out.buffer.toString('utf8'), /Introducción/, 'accents + casing must survive (not "introduccion")');
  });

  it('deletes specific text in place', () => {
    const input = Buffer.from('texto CONFIDENCIAL aqui');
    const out = executeTextLikeOperations({ input, requestText: 'borra CONFIDENCIAL', format: 'txt', blocks: [] });
    assert.equal(/confidencial/i.test(out.buffer.toString('utf8')), false);
    assert.ok(out.steps.some((s) => s.kind === 'delete_text' && s.removedCount === 1));
  });

  it('still APPENDS when the request asks to add content (back-compat)', () => {
    const input = Buffer.from('línea original\n');
    const blocks = [{ kind: 'normal', text: 'Contenido nuevo agregado' }];
    const out = executeTextLikeOperations({ input, requestText: 'agrega una sección de conclusiones', format: 'txt', blocks });
    const text = out.buffer.toString('utf8');
    assert.match(text, /línea original/, 'original content preserved');
    assert.match(text, /Contenido nuevo agregado/, 'new content appended');
    assert.ok(out.steps.some((s) => s.kind === 'append_generic'));
  });

  it('a replace whose needle is absent is a reported no-op (changedCount 0), buffer unchanged', () => {
    const input = Buffer.from('contenido sin coincidencias');
    const out = executeTextLikeOperations({ input, requestText: 'reemplaza FOO por BAR', format: 'txt', blocks: [] });
    assert.equal(out.buffer.toString('utf8'), 'contenido sin coincidencias');
    assert.ok(out.steps.some((s) => s.kind === 'replace_text' && s.changedCount === 0));
  });

  it('countNeedleMatches counts case-insensitively', () => {
    assert.equal(countNeedleMatches('aA aa Aa', 'aa'), 3);
    assert.equal(countNeedleMatches('nada', 'xyz'), 0);
  });
});
