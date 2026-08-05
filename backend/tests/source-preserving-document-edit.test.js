const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell } = require('docx');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

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

async function makePdfBuffer() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('SiraGPT banco real PDF', { x: 72, y: 720, size: 16, font, color: rgb(0, 0, 0) });
  page.drawText('Estado: BORRADOR', { x: 72, y: 690, size: 14, font, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save());
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

async function makeDocxWithAnnexTailBuffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Capítulo 1. Introducción original'),
        new Paragraph('REFERENCIAS'),
        new Paragraph('Referencia bibliográfica que debe conservarse.'),
        new Paragraph('ANEXO 01'),
        new Paragraph('Fotograma 1 y evidencia visual que debe eliminarse.'),
        new Paragraph('ANEXO 02'),
        new Paragraph('Contenido posterior del anexo dos que debe eliminarse.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function inflateDocxAboveSandboxLimit(buffer, extraBytes = 21 * 1024 * 1024) {
  const zip = new PizZip(buffer);
  zip.file('word/media/qa-large-unreferenced.bin', randomBytes(extraBytes), { binary: true });
  return zip.generate({ type: 'nodebuffer', compression: 'STORE' });
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

async function makeDocxWithOperationalMatrixBuffer() {
  const cell = (text = '') => new TableCell({ children: [new Paragraph(text)] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Matriz de categorización ACTUAL'),
        new Paragraph('Tabla 01. Matriz operacional'),
        new Table({
          rows: [
            new TableRow({
              children: [
                cell('Categoría'),
                cell('Subcategoría'),
                cell('Indicador'),
                cell('Técnica'),
                cell('Instrumento'),
              ],
            }),
            new TableRow({
              children: [
                cell('Informe pericial'),
                cell('Valoración económica'),
                cell('Criterios de cuantificación'),
                cell('Análisis documental'),
                cell('Guía de análisis documental'),
              ],
            }),
            new TableRow({
              children: [
                cell('Capacidad económica'),
                cell('Ingresos declarados'),
                cell('Nivel de ingresos'),
                cell('Revisión documental'),
                cell('Ficha de registro'),
              ],
            }),
            new TableRow({
              children: [
                cell('Capacidad económica'),
                cell('Patrimonio disponible'),
                cell('Bienes registrables'),
                cell('Revisión documental'),
                cell('Ficha de registro'),
              ],
            }),
          ],
        }),
        new Paragraph('Nota. Esta matriz operacional debe conservarse sin cambios.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeDocxWithOperationalMatrixAndProofreadBuffer() {
  const cell = (text = '') => new TableCell({ children: [new Paragraph(text)] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Resumen'),
        new Paragraph('Palabras claves: informe pericial; capacidad económica.'),
        new Paragraph('Matriz de categorización ACTUAL'),
        new Paragraph('Tabla 01. Matriz operacional'),
        new Table({
          rows: [
            new TableRow({
              children: [
                cell('Categoría'),
                cell('Subcategoría'),
                cell('Indicador'),
                cell('Técnica'),
                cell('Instrumento'),
              ],
            }),
            new TableRow({
              children: [
                cell('Informe pericial'),
                cell('Valoración económica'),
                cell('Criterios de cuantificación'),
                cell('Análisis documental'),
                cell('Guía de análisis documental'),
              ],
            }),
          ],
        }),
        new Paragraph('Contenido posterior que debe permanecer después del cronograma agregado.'),
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
    assert.equal(isSourcePreservingEditRequest('corrige la redacción', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('mejora el tono profesional', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('aplica correcciones minimas al documento porfavor', ['file-docx']), true);
    assert.equal(isSourcePreservingEditRequest('corrige la redacción', []), false);
    assert.equal(isSourcePreservingEditRequest('dame un resumen en un solo párrafo', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('calcula la diferencia usando los documentos adjuntos', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('compara el PDF y el DOCX adjuntos e indica la cifra final', ['file-docx']), false);
    assert.equal(isSourcePreservingEditRequest('Genera un Word profesional: incluye tabla Excel, índice y conclusiones.', []), false);
    assert.equal(isSourcePreservingEditRequest('Genera un Word profesional sobre el documento adjunto: incluye tabla Excel, índice y conclusiones.', ['file-docx']), false);
    // NEW PowerPoint from thesis PDF + images must NOT preserve the PDF as annexes.
    const thesisPptPrompt = 'realiza una ppt profesional en 30 ppts de forma profesional de la tesis 20 julio Tesis de maestria.pdf en base a las imagenes de forma profesional';
    assert.equal(isSourcePreservingEditRequest(thesisPptPrompt, ['file-pdf', 'img-1', 'img-2']), false);
    assert.equal(isSourcePreservingEditRequest('crea una presentacion de 15 diapositivas de este PDF', ['file-pdf']), false);
    assert.equal(isSourcePreservingEditRequest('genera un powerpoint de defensa de tesis con 20 slides', ['file-pdf']), false);
    // Surgical edit of an existing PPTX still preserves source.
    assert.equal(isSourcePreservingEditRequest('cambia el titulo de la diapositiva 3', ['file-pptx']), true);
    assert.equal(isSourcePreservingEditRequest('edita mi presentacion y corrige la ortografia', ['file-pptx']), true);
    assert.equal(isSourcePreservingEditRequest('reemplaza BORRADOR por APROBADO en los documentos adjuntos y devuelve un DOCX completo', ['file-docx', 'file-xlsx']), true);
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

  it('describes a 1000-agent virtual pool while bounding execution parallelism', () => {
    const plan = sourcePreservingInternals.buildDocumentOrchestrationPlan({
      requestText: 'corrige el documento y usa mil agentes en segundo plano',
      sourceFile: { originalName: 'tesis.docx' },
      operations: [{ kind: 'replace_text', needle: 'error', replacement: 'corrección' }],
      selectionReason: 'current_supported_file',
    });

    assert.equal(plan.mode, 'source_preserving_document_swarm');
    assert.equal(plan.virtualAgentPool, 1000);
    assert.equal(plan.requestedAgents, 1000);
    assert.equal(plan.executionMode, 'bounded_background_worker');
    assert.ok(plan.activeAgents >= 8);
    assert.ok(plan.activeAgents <= plan.parallelism);
  });

  it('returns the same DOCX with minimal corrections applied instead of a prose recommendation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-minimal-corrections-'));
    const originalPath = path.join(tmp, '910 250.docx');
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph('Resumen'),
          new Paragraph('Palabras claves: gestión empresarial; informe pericial.'),
          new Paragraph('Contenido original que debe seguir intacto.'),
        ],
      }],
    });
    fs.writeFileSync(originalPath, Buffer.from(await Packer.toBuffer(doc)));

    const prisma = {
      file: {
        async findMany() {
          return [{
            id: 'file-docx-minimal',
            userId: 'user-1',
            filename: '910 250.docx',
            originalName: '910 250.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: fs.statSync(originalPath).size,
            path: originalPath,
          }];
        },
      },
      generatedArtifact: { async findMany() { return []; } },
      message: { async findMany() { return []; } },
    };

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-docx-minimal'],
      prompt: 'aplica correcciones minimas al documento porfavor',
      displayPrompt: 'aplica correcciones minimas al documento porfavor',
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /910_250_correcciones_minimas_completado\.docx$/);
    assert.match(result.content, /Conservé el DOCX original/i);
    assert.doesNotMatch(result.content, /Estas son las correcciones/i);

    const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
    assert.match(xml, /Palabras clave:/);
    assert.doesNotMatch(xml, /Palabras claves:/);
    assert.match(xml, /Contenido original que debe seguir intacto/);
    const criteria = result.validation.details.operationCriteria.find((check) => check.id === 'minimal_proofread_applied');
    assert.equal(criteria?.passed, true);
    assert.equal(criteria.details.changedCount >= 1, true);
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

  it('uses the just-uploaded DOCX as the base for "mi word en anexos" instrument edits', () => {
    const selection = sourcePreservingInternals.selectSourcePreservingDocumentSet({
      requestText: 'en mi word en anexos agrega el intruemnto en blanco y negri de forma profesional porfavor',
      sourceFiles: [{
        id: 'file-current',
        filename: '775_785_final30-06-26.docx',
        originalName: '775 785 - final30-06-26.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'current_upload',
      }],
      priorArtifacts: [{
        id: 'artifact-integrated',
        filename: '775_785_final30-06-26_con_anexos_documentos_integrados.docx',
        originalName: '775_785_final30-06-26_con_anexos_documentos_integrados.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'generated_artifact',
      }],
    });

    assert.equal(selection.sourceFile.id, 'file-current');
    assert.equal(selection.selectionReason, 'current_upload_docx_edit');
    assert.deepEqual(selection.referenceFiles, []);
    assert.equal(selection.wantsReferenceIntegration, false);
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

  it('does not treat "imagen adjunta" as a source-preserving document edit', () => {
    assert.equal(
      isSourcePreservingEditRequest(
        'Crea esto en un Word editable. Reproduce la ficha visual de la imagen adjunta lo mejor posible.',
        [{ id: 'img-1', originalName: 'captura.png', mimeType: 'image/png' }],
      ),
      false,
    );
  });

  it('does not mistake an instrument request for external reference integration because it mentions Word final', () => {
    const prompt = 'agrega al final un instrumento profesional de recolección de datos para esta investigación y valida el Word final';
    const livePrompt = 'en mi word en anexos agrega el intruemnto en blanco y negri de forma profesional porfavor';

    assert.equal(sourcePreservingInternals.requestWantsReferenceIntegration(prompt), false);
    assert.equal(sourcePreservingInternals.requestWantsReferenceIntegration(livePrompt), false);
    assert.equal(sourcePreservingInternals.requestWantsReferenceIntegration('analiza este documento adjunto y agrégalo a mi documento general'), true);

    const ops = sourcePreservingInternals.planSourcePreservingOperations({
      requestText: livePrompt,
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

  it('treats "intruemnto en blanco y negri" as a real instrument appendix edit', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-instrument-typo-'));
      const originalPath = path.join(tmp, 'tesis.docx');
      fs.writeFileSync(originalPath, await makeDocxWithAnexo3CronogramaBuffer());

      const prompt = 'en mi word en anexos agrega el intruemnto en blanco y negri de forma profesional';
      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: '775_785_final30-06-26_con_anexos.docx',
          filename: '775_785_final30-06-26_con_anexos.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: [
            'Implementación de un sistema de ventilación inteligente para optimizar la seguridad y la eficiencia.',
            'Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis',
          ].join('\n'),
        },
        prompt,
        displayPrompt: prompt,
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.ok(result.validation.details.operationCriteria.some((check) => check.id === 'instrument_appended' && check.passed));

      const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /Anexo 4\. Instrumento de recolección de datos/);
      assert.match(xml, /Formato de presentación: versión en blanco y negro/);
      assert.match(xml, /Escala de respuesta/);
      assert.match(xml, /Datos generales/);
      assert.match(xml, /Portada original UPN/);
      assert.doesNotMatch(xml, /Contenido agregado según solicitud/);
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
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

  it('adds a real consistency matrix table derived from the DOCX operational matrix', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-consistency-matrix-'));
      const originalPath = path.join(tmp, 'Matriz de categorización ACTUAL.docx');
      fs.writeFileSync(originalPath, await makeDocxWithOperationalMatrixBuffer());

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: 'Matriz de categorización ACTUAL.docx',
          filename: 'Matriz de categorización ACTUAL.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Tabla 01. Matriz operacional con categorías, subcategorías e indicadores.',
        },
        prompt: 'agrega en el word matriz de cosistencia en base a la matriz operacional',
        displayPrompt: 'agrega en el word matriz de cosistencia en base a la matriz operacional',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.match(result.file.filename, /matriz_de_consistencia_completado\.docx$/);
      assert.match(result.content, /matriz de consistencia derivada de la matriz operacional/i);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.equal((xml.match(/<w:tbl\b/g) || []).length, 2);
      assert.ok(xml.indexOf('Matriz de consistencia') > xml.indexOf('Tabla 01'));
      assert.match(xml, /Tabla 01\. Matriz operacional/);
      assert.match(xml, /Matriz de consistencia basada en la matriz operacional/);
      assert.match(xml, /Problema/);
      assert.match(xml, /Objetivo/);
      assert.match(xml, /Supuesto\/Hipótesis/);
      assert.match(xml, /Informe pericial/);
      assert.match(xml, /Capacidad económica/);
      assert.match(xml, /Criterios de cuantificación/);
      assert.match(xml, /Bienes registrables/);
      assert.doesNotMatch(xml, /ANEXOS/);
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  it('returns the same DOCX with minimal proofreading and Anexo 3 cronograma inserted after the operational matrix', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-proofread-cronograma-'));
      const originalPath = path.join(tmp, '540_694_correccion_corregido.docx');
      fs.writeFileSync(originalPath, await makeDocxWithOperationalMatrixAndProofreadBuffer());

      const prompt = 'aplica correccioens minimas y agrega luego de la matrix operacional agrega Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis de forma profesional';
      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-docx',
          path: originalPath,
          originalName: '540_694_correccion_corregido.docx',
          filename: '540_694_correccion_corregido.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Tabla 01. Matriz operacional con categorías, subcategorías e indicadores. Palabras claves: informe pericial.',
        },
        prompt,
        displayPrompt: prompt,
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.match(result.file.filename, /\.docx$/);
      assert.ok(result.file.url);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.match(xml, /Palabras clave:/);
      assert.doesNotMatch(xml, /Palabras claves:/);
      assert.match(xml, /Anexo 3\. Cronograma del Desarrollo y Culminación de la Tesis/);
      assert.match(xml, /Planificaci[oó]n/);
      assert.match(xml, /Matriz de consistencia/);
      assert.match(xml, /Operacionalizaci[oó]n/);
      assert.match(xml, /Entrega/);

      const matrixIndex = xml.indexOf('Tabla 01. Matriz operacional');
      const anexoIndex = xml.indexOf('Anexo 3. Cronograma');
      const posteriorIndex = xml.indexOf('Contenido posterior que debe permanecer');
      assert.ok(matrixIndex >= 0, 'source operational matrix should remain');
      assert.ok(anexoIndex > matrixIndex, 'Anexo 3 should be inserted after the operational matrix');
      assert.ok(posteriorIndex > anexoIndex, 'existing later content should remain after the inserted Anexo 3');
      assert.doesNotMatch(result.content, /no pude|demasiado grande|opciones para/i);
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  it('edits an oversized DOCX by deleting from Anexo 01 to the end and returning a DOCX artifact', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-large-anexo-delete-'));
      const originalPath = path.join(tmp, '572_084_FINAL_gomez_mendizabal_tf_FORMATO-UPN.docx');
      const oversized = inflateDocxAboveSandboxLimit(await makeDocxWithAnnexTailBuffer());
      assert.ok(oversized.length > 20 * 1024 * 1024, 'fixture must exceed the sandbox document_edit byte cap');
      fs.writeFileSync(originalPath, oversized);

      const result = await generateSourcePreservingDocumentEdit({
        sourceFile: {
          id: 'file-large-docx',
          path: originalPath,
          originalName: '572_084_FINAL_gomez_mendizabal_tf_FORMATO-UPN.docx',
          filename: '572_084_FINAL_gomez_mendizabal_tf_FORMATO-UPN.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extractedText: 'Documento largo con referencias y anexos desde Anexo 01.',
        },
        prompt: 'borra desde el anexo 01 hacia abajo todo porfavor',
        displayPrompt: 'borra desde el anexo 01 hacia abajo todo porfavor',
        userId: 'user-1',
        chatId: 'chat-1',
      });

      assert.equal(result.format, 'docx');
      assert.equal(result.validation.passed, true);
      assert.equal(result.validation.checks.operation_criteria, true);
      assert.match(result.content, /eliminé Anexo 1 y todo el contenido posterior/i);
      assert.match(result.file.filename, /anexo_1_completado\.docx$/);

      const edited = fs.readFileSync(result.artifact.path);
      const xml = new PizZip(edited).file('word/document.xml').asText();
      assert.match(xml, /Portada original UPN/);
      assert.match(xml, /Capítulo 1\. Introducción original/);
      assert.match(xml, /REFERENCIAS/);
      assert.match(xml, /Referencia bibliográfica que debe conservarse/);
      assert.doesNotMatch(xml, /ANEXO 01/);
      assert.doesNotMatch(xml, /Fotograma 1/);
      assert.doesNotMatch(xml, /ANEXO 02/);
      assert.doesNotMatch(xml, /Contenido posterior del anexo dos/);
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
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

    const withAppendixTail = inferDocumentTitle(
      'Implementación de un sistema de ventilación inteligente para optimizar la seguridad. Anexo 3. Cronograma del Desarrollo y Culminación de la Tesis',
      'tesis.docx',
    );

    assert.equal(withAppendixTail, 'Implementación de un sistema de ventilación inteligente para optimizar la seguridad.');
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

describe('source-preserving DOCX title edits', () => {
  const {
    extractDocxTitleChange,
    extractNamedSectionAppend,
    planSourcePreservingOperations,
    setDocxDocumentTitleBuffer,
    validateDocxOperationCriteria,
    validateEditedBuffer,
  } = sourcePreservingInternals;

  it('extracts the new title without swallowing the next requested edit', () => {
    const parsed = extractDocxTitleChange(
      'Ahora cambia el título a Informe final Trabajo 2026 y agrega una sección Recomendaciones con dos puntos.',
    );
    assert.deepEqual(parsed, { newTitle: 'Informe final Trabajo 2026' });
    assert.deepEqual(
      extractNamedSectionAppend('Agrega una sección Recomendaciones con dos puntos.'),
      { sectionTitle: 'Recomendaciones' },
    );
  });

  it('understands the exact live phrasing and never degrades it to an appendix', () => {
    const prompt = 'quiero que en este mismo word Modelo Informe.docx el titulo le coloques 2027 solo modifica ello';
    assert.deepEqual(extractDocxTitleChange(prompt), { newTitle: '2027' });

    const operations = planSourcePreservingOperations({
      requestText: prompt,
      documentXml: '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Modelo Informe 2026</w:t></w:r></w:p></w:body></w:document>',
    });

    assert.deepEqual(operations.map((operation) => operation.kind), ['set_document_title']);
    assert.equal(operations[0].newTitle, '2027');
    assert.equal(operations.some((operation) => operation.kind === 'append_generic'), false);
  });

  it('changes “de 2026 al 2027” only in a complex multi-run cover title', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-title-de-al-'));
    const originalPath = path.join(tmp, 'TSP-profesional.docx');
    const original = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'PROPUESTA PROFESIONAL, LIMA, ', bold: true }),
            new TextRun({ text: '20', bold: true }),
            new TextRun({ text: '26', bold: true }),
          ],
        }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('2026')] }),
        new Paragraph('El cuerpo académico conserva la referencia 2026 sin cambios.'),
        new Paragraph('ANEXOS'),
        new Paragraph('Contenido preexistente que no debe validar una operación equivocada.'),
      ] }],
    })));
    fs.writeFileSync(originalPath, original);

    const prompt = 'cambia en el titulo de 2026 al 2027 en mi mismo word';
    const documentXml = new PizZip(original).file('word/document.xml').asText();
    const operations = planSourcePreservingOperations({ requestText: prompt, documentXml });
    assert.deepEqual(operations, [{
      kind: 'replace_text',
      needle: '2026',
      replacement: '2027',
      scope: 'title',
    }]);

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'professional-cover-de-al',
        path: originalPath,
        originalName: 'TSP-profesional.docx',
        filename: 'TSP-profesional.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'PROPUESTA PROFESIONAL, LIMA, 2026. Referencia 2026. ANEXOS.',
      },
      prompt,
      displayPrompt: prompt,
      userId: 'user-title-de-al',
      chatId: 'chat-title-de-al',
    });

    assert.equal(result.validation.passed, true, JSON.stringify(result.validation, null, 2));
    assert.equal(result.validation.checks.request_contract, true);
    assert.equal(result.validation.details.requestContract.type, 'replace_text');
    assert.equal(result.validation.details.requestContract.details.targetParagraphIndex, 0);
    assert.equal(result.orchestration.operations[0].changedCount, 1);
    assert.match(result.file.filename, /_editado\.docx$/);
    assert.doesNotMatch(result.file.filename, /con_anexos/);
    assert.match(result.content, /reemplacé el texto solicitado únicamente en el título/);
    assert.doesNotMatch(result.content, /agregué el contenido solicitado en anexos/);
    assert.equal(fs.readFileSync(originalPath).equals(original), true, 'the uploaded Word must remain immutable');

    const edited = fs.readFileSync(result.artifact.path);
    const beforeZip = new PizZip(original);
    const afterZip = new PizZip(edited);
    const editedXml = afterZip.file('word/document.xml').asText();
    const paragraphTexts = [...editedXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((paragraph) => (
      [...paragraph[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((textNode) => textNode[1])
        .join('')
    ));
    assert.equal(paragraphTexts[0], 'PROPUESTA PROFESIONAL, LIMA, 2027');
    assert.equal(paragraphTexts[1], '2026');
    assert.match(paragraphTexts[2], /referencia 2026/i);
    assert.equal(paragraphTexts.filter((text) => text === 'ANEXOS').length, 1);
    assert.equal((editedXml.match(/<w:p(?:\s|>)/g) || []).length, (documentXml.match(/<w:p(?:\s|>)/g) || []).length);
    assert.equal((editedXml.match(/<w:sectPr(?:\s|>)/g) || []).length, (documentXml.match(/<w:sectPr(?:\s|>)/g) || []).length);

    for (const name of Object.keys(beforeZip.files)) {
      if (name === 'word/document.xml' || beforeZip.files[name].dir) continue;
      assert.equal(
        beforeZip.file(name).asNodeBuffer().equals(afterZip.file(name).asNodeBuffer()),
        true,
        `${name} must remain byte-identical`,
      );
    }
  });

  it('fails closed instead of fabricating ANEXOS for an unresolved title mutation', () => {
    assert.throws(
      () => planSourcePreservingOperations({
        requestText: 'modifica el título, pero no indico cuál es el texto actual ni el nuevo',
        documentXml: '<w:document><w:body><w:p><w:r><w:t>Título actual</w:t></w:r></w:p></w:body></w:document>',
      }),
      (error) => error?.code === 'SOURCE_EDIT_INTENT_UNRESOLVED',
    );

    assert.throws(
      () => planSourcePreservingOperations({
        requestText: 'modifica el título del anexo 3 desde 2026 hasta 2027',
        documentXml: '<w:document><w:body><w:p><w:r><w:t>Anexo 3</w:t></w:r></w:p></w:body></w:document>',
      }),
      (error) => error?.code === 'SOURCE_EDIT_INTENT_UNRESOLVED',
      'an unresolved title edit must not escape through a section-fill operation',
    );

    assert.throws(
      () => planSourcePreservingOperations({
        requestText: 'cambia "Estado A" por "Estado B" y modifica el título del anexo 3 desde 2026 hasta 2027',
        documentXml: '<w:document><w:body><w:p><w:r><w:t>Estado A</w:t></w:r></w:p><w:p><w:r><w:t>Anexo 3, 2026</w:t></w:r></w:p></w:body></w:document>',
      }),
      (error) => error?.code === 'SOURCE_EDIT_INTENT_UNRESOLVED',
      'a valid sibling replacement must not hide an unresolved mutation clause',
    );
  });

  it('parses “del 2026 al 2027” without leaking the final letter of del', () => {
    const operations = planSourcePreservingOperations({
      requestText: 'cambia en el título del 2026 al 2027 en mi mismo Word',
      documentXml: '<w:document><w:body><w:p><w:r><w:t>LIMA, 2026</w:t></w:r></w:p></w:body></w:document>',
    });
    assert.deepEqual(operations, [{
      kind: 'replace_text',
      needle: '2026',
      replacement: '2027',
      scope: 'title',
    }]);
  });

  it('does not validate unrelated growth as a generic appendix', async () => {
    const before = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph('Informe original'),
        new Paragraph('ANEXOS'),
        new Paragraph('Contenido preexistente.'),
      ] }],
    })));
    const unrelatedGrowth = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph('Informe original'),
        new Paragraph('ANEXOS'),
        new Paragraph('Contenido preexistente.'),
        new Paragraph('Crecimiento ajeno a la operación solicitada.'),
      ] }],
    })));
    const validation = validateDocxOperationCriteria(
      unrelatedGrowth,
      [{ kind: 'append_generic', wantsInstrument: false }],
      { beforeBuffer: before },
    );
    assert.equal(validation.passed, false);
    assert.equal(validation.checks[0].details.beforeMarkerCount, 1);
    assert.equal(validation.checks[0].details.afterMarkerCount, 1);

    const misleadingGrowth = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph('Informe original'),
        new Paragraph('ANEXOS'),
        new Paragraph('Contenido preexistente.'),
        new Paragraph('ANEXOS'),
        new Paragraph('Texto distinto de los bloques que esta ejecución debía agregar.'),
      ] }],
    })));
    const fingerprintValidation = await validateEditedBuffer(
      misleadingGrowth,
      'docx',
      [
        { kind: 'pageBreak', text: '' },
        { kind: 'heading1', text: 'ANEXOS' },
        { kind: 'heading2', text: 'Contenido agregado según solicitud' },
      ],
      {
        beforeBuffer: before,
        operations: [{ kind: 'append_generic', wantsInstrument: false }],
        requestText: 'agrega el contenido solicitado como anexo',
      },
    );
    assert.equal(fingerprintValidation.checks.operation_criteria, true, 'the structural gate alone sees a new anchor');
    assert.equal(fingerprintValidation.checks.content_appended, false, 'the expected block fingerprint is absent');
    assert.equal(fingerprintValidation.passed, false);
  });

  it('plans a native title update instead of replacing the literal word título', async () => {
    const source = await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ style: 'Title', children: [new TextRun('Informe de prueba Trabajo 2026')] }),
        new Paragraph('Introducción que debe conservarse.'),
      ] }],
    }));
    const documentXml = new PizZip(Buffer.from(source)).file('word/document.xml').asText();
    const operations = planSourcePreservingOperations({
      requestText: 'Cambia el título a Informe final Trabajo 2026 y agrega una sección Recomendaciones con dos puntos.',
      documentXml,
    });

    assert.equal(operations.filter((op) => op.kind === 'set_document_title').length, 1);
    assert.equal(operations.some((op) => op.kind === 'replace_text' && op.needle === 'titulo'), false);
    assert.equal(operations.some((op) => op.kind === 'append_section' && op.sectionTitle === 'Recomendaciones'), true);
    assert.equal(operations.some((op) => op.kind === 'append_generic'), false);
  });

  it('adds a named section to the document body instead of creating ANEXOS', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-named-section-'));
    const originalPath = path.join(tmp, 'informe.docx');
    const source = await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ style: 'Title', children: [new TextRun('Informe de prueba Trabajo 2026')] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Introducción')] }),
        new Paragraph('Introducción que debe conservarse en el documento editado.'),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Conclusión')] }),
        new Paragraph('Conclusión que debe conservarse en el documento editado.'),
      ] }],
    }));
    fs.writeFileSync(originalPath, source);

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'named-section-docx',
        path: originalPath,
        originalName: 'informe.docx',
        filename: 'informe.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'Informe de prueba Trabajo 2026. Introducción. Conclusión.',
      },
      prompt: 'Agrega una sección Recomendaciones con dos puntos y devuelve el Word actualizado.',
      displayPrompt: 'Agrega una sección Recomendaciones con dos puntos y devuelve el Word actualizado.',
      userId: 'user-named-section',
      chatId: 'chat-named-section',
    });

    assert.equal(result.validation.passed, true);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'append_section'), true);
    assert.match(result.content, /sección «Recomendaciones»/);
    const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
    assert.match(xml, /Recomendaciones/);
    assert.match(xml, /Implementar las mejoras propuestas/);
    assert.match(xml, /Establecer indicadores de seguimiento/);
    assert.doesNotMatch(xml, />ANEXOS</);
    assert.match(xml, /Introducción que debe conservarse/);
    assert.match(xml, /Conclusión que debe conservarse/);
  });

  it('changes only the visible title and preserves its formatting and body', async () => {
    const source = await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({
          style: 'Title',
          children: [new TextRun({ text: 'Informe de prueba Trabajo 2026', bold: true, color: 'AA0000' })],
        }),
        new Paragraph('Introducción que debe conservarse.'),
        new Paragraph('Conclusión que debe conservarse.'),
      ] }],
    }));
    const edited = setDocxDocumentTitleBuffer(Buffer.from(source), 'Informe final Trabajo 2026');
    const xml = new PizZip(edited.buffer).file('word/document.xml').asText();

    assert.equal(edited.previousTitle, 'Informe de prueba Trabajo 2026');
    assert.match(xml, /Informe final Trabajo 2026/);
    assert.doesNotMatch(xml, /Informe de prueba Trabajo 2026/);
    assert.match(xml, /Introducción que debe conservarse/);
    assert.match(xml, /Conclusión que debe conservarse/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /w:color w:val="AA0000"/);
    const validation = validateDocxOperationCriteria(edited.buffer, [{
      kind: 'set_document_title',
      previousTitle: edited.previousTitle,
      newTitle: edited.newTitle,
    }]);
    assert.equal(validation.passed, true);
  });

  it('delivers a validated edited DOCX for a natural title replacement request', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-title-delivery-'));
    const originalPath = path.join(tmp, 'aspectos-administrativos.docx');
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({
          style: 'Title',
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Distrito Judicial de Ayacucho', bold: true })],
        }),
        new Paragraph('Antecedente institucional desarrollado en Ayacucho.'),
      ] }],
    })));
    fs.writeFileSync(originalPath, source);

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'title-delivery-docx',
        path: originalPath,
        originalName: 'aspectos-administrativos.docx',
        filename: 'aspectos-administrativos.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'Distrito Judicial de Ayacucho. Antecedente institucional desarrollado en Ayacucho.',
      },
      prompt: 'el titulo cambialo de ayacucho a cajamarca en mi mismo word',
      displayPrompt: 'el titulo cambialo de ayacucho a cajamarca en mi mismo word',
      userId: 'user-title-delivery',
      chatId: 'chat-title-delivery',
    });

    assert.equal(result.clarification, undefined);
    assert.equal(result.format, 'docx');
    assert.equal(result.validation.passed, true, JSON.stringify(result.validation, null, 2));
    assert.equal(result.validation.checks.operation_criteria, true);
    assert.equal(result.orchestration.operations[0].scope, 'title');
    assert.equal(result.orchestration.operations[0].changedCount, 1);
    const xml = new PizZip(fs.readFileSync(result.artifact.path)).file('word/document.xml').asText();
    assert.match(xml, /Distrito Judicial de Cajamarca/);
    assert.match(xml, /desarrollado en Ayacucho/);
  });

  it('edits the real DOCX in place, proves its structure, and leaves the uploaded bytes immutable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-live-title-'));
    const originalPath = path.join(tmp, 'Modelo Informe.docx');
    const cell = (text) => new TableCell({ children: [new Paragraph(text)] });
    const original = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({
          style: 'Title',
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Modelo Informe 2026', bold: true, color: '1F4E79' })],
        }),
        new Paragraph('CENTINELA-CUERPO-ORIGINAL-7429'),
        new Table({ rows: [new TableRow({ children: [cell('Dato fijo A'), cell('Dato fijo B')] })] }),
      ] }],
    })));
    fs.writeFileSync(originalPath, original);

    const prompt = 'quiero que en este mismo word Modelo Informe.docx el titulo le coloques 2027 solo modifica ello';
    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'modelo-informe-live',
        path: originalPath,
        originalName: 'Modelo Informe.docx',
        filename: 'Modelo Informe.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'Modelo Informe 2026. CENTINELA-CUERPO-ORIGINAL-7429.',
      },
      prompt,
      displayPrompt: prompt,
      userId: 'user-live-title',
      chatId: 'chat-live-title',
    });

    assert.equal(result.validation.passed, true, JSON.stringify(result.validation, null, 2));
    assert.equal(result.validation.checks.source_preserved, true);
    assert.equal(result.validation.details.sourcePreservation.strictTitleOnly, true);
    assert.deepEqual(result.validation.details.sourcePreservation.unexpectedlyChangedParts, []);
    assert.equal(fs.readFileSync(originalPath).equals(original), true, 'the uploaded file must never be mutated');

    const edited = fs.readFileSync(result.artifact.path);
    const xml = new PizZip(edited).file('word/document.xml').asText();
    assert.match(xml, /<w:t[^>]*>2027<\/w:t>/);
    assert.doesNotMatch(xml, /Modelo Informe 2026/);
    assert.match(xml, /CENTINELA-CUERPO-ORIGINAL-7429/);
    assert.match(xml, /Dato fijo A/);
    assert.match(xml, /Dato fijo B/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /w:color w:val="1F4E79"/);
    assert.doesNotMatch(xml, />ANEXOS</);
  });

  it('edits only the explicitly requested DOCX family when PDF files are also attached', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-live-title-batch-'));
    const makeSource = async (filename, title, sentinel) => {
      const sourcePath = path.join(tmp, filename);
      const buffer = Buffer.from(await Packer.toBuffer(new Document({
        sections: [{ children: [
          new Paragraph({ style: 'Title', children: [new TextRun({ text: title, bold: true })] }),
          new Paragraph(sentinel),
          new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph(`Tabla ${sentinel}`)] })] })] }),
        ] }],
      })));
      fs.writeFileSync(sourcePath, buffer);
      return { sourcePath, buffer };
    };
    const first = await makeSource('Informe Norte.docx', 'Informe Norte 2026', 'CENTINELA-NORTE-101');
    const second = await makeSource('Informe Sur.docx', 'Informe Sur 2026', 'CENTINELA-SUR-202');
    const referencePdfPath = path.join(tmp, 'Referencia.pdf');
    const referencePdf = await makePdfBuffer();
    fs.writeFileSync(referencePdfPath, referencePdf);
    const rows = [
      {
        id: 'batch-north', userId: 'user-batch', filename: 'Informe Norte.docx', originalName: 'Informe Norte.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: first.buffer.length,
        path: first.sourcePath, extractedText: 'Informe Norte 2026. CENTINELA-NORTE-101.',
      },
      {
        id: 'batch-south', userId: 'user-batch', filename: 'Informe Sur.docx', originalName: 'Informe Sur.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: second.buffer.length,
        path: second.sourcePath, extractedText: 'Informe Sur 2026. CENTINELA-SUR-202.',
      },
      {
        id: 'batch-reference-pdf', userId: 'user-batch', filename: 'Referencia.pdf', originalName: 'Referencia.pdf',
        mimeType: 'application/pdf', size: referencePdf.length,
        path: referencePdfPath, extractedText: 'SiraGPT banco real PDF. Estado: BORRADOR.',
      },
    ];
    const prisma = {
      file: { async findMany() { return [...rows].reverse(); } },
      generatedArtifact: { async findMany() { return []; } },
      message: { async findMany() { return []; } },
    };
    const prompt = 'quiero que en ambos Word el título le coloques 2027; solo modifica eso y devuélveme ambos archivos';

    assert.equal(sourcePreservingInternals.requestWantsBatchDocumentEdit(prompt, [
      { ...rows[0], source: 'current_upload' },
      { ...rows[2], source: 'current_upload' },
    ]), false, 'one matching Word plus another family must not activate batch mode');
    assert.deepEqual(
      sourcePreservingInternals.selectBatchDocumentSources(prompt, rows.map((row) => ({ ...row, source: 'current_upload' })))
        .map((file) => file.id),
      ['batch-north', 'batch-south'],
    );
    assert.deepEqual(
      sourcePreservingInternals.selectBatchDocumentSources(
        'reemplaza BORRADOR en todos los documentos y devuelve un DOCX completo',
        rows.map((row) => ({ ...row, source: 'current_upload' })),
      ).map((file) => file.id),
      ['batch-north', 'batch-south', 'batch-reference-pdf'],
      'an output-format mention must not narrow an otherwise generic batch',
    );

    const familyBatchCases = [
      ['en cada Word cambia el título', 'word', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['en cada PDF cambia el título', 'pdf', 'pdf', 'application/pdf'],
      ['en cada Excel cambia el título', 'excel', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['en ambos PowerPoint cambia el título', 'powerpoint', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ];
    for (const [familyPrompt, family, extension, mimeType] of familyBatchCases) {
      const familyRows = [1, 2].map((index) => ({
        id: `${family}-${index}`,
        originalName: `${family}-${index}.${extension}`,
        filename: `${family}-${index}.${extension}`,
        mimeType,
        source: 'current_upload',
      }));
      assert.equal(
        sourcePreservingInternals.requestWantsBatchDocumentEdit(familyPrompt, familyRows),
        true,
        `${familyPrompt} must activate one edited copy per matching upload`,
      );
    }

    for (const genericPrompt of [
      'edita los documentos adjuntos y cambia el título a 2027',
      'en los documentos adjuntos cambia el título a 2027',
      'edita mis archivos cargados y cambia el título a 2027',
      'en los archivos subidos cambia el título a 2027',
    ]) {
      assert.equal(
        sourcePreservingInternals.requestWantsBatchDocumentEdit(
          genericPrompt,
          rows.slice(0, 2).map((row) => ({ ...row, source: 'current_upload' })),
        ),
        true,
        `${genericPrompt} must edit every attached document independently`,
      );
    }
    const bareBatchPlan = sourcePreservingInternals.planSourcePreservingOperations({
      requestText: 'edita los documentos adjuntos y cambia el título a 2027; solo modifica eso y devuélveme ambos archivos',
      documentXml: new PizZip(first.buffer).file('word/document.xml').asText(),
    });
    assert.deepEqual(
      bareBatchPlan.map((operation) => operation.kind),
      ['set_document_title'],
      'attachment scope and delivery wording must not manufacture an ANEXOS operation',
    );
    const strictBatch = sourcePreservingInternals.buildBatchEditResult({
      attempts: [
        {
          ok: true,
          sourceFile: { id: 'invalid-truthy', originalName: 'truthy.docx' },
          result: {
            validation: { passed: 'true' },
            artifact: { id: 'truthy-artifact', filename: 'truthy.docx' },
            file: { filename: 'truthy.docx' },
          },
        },
        {
          ok: true,
          sourceFile: { id: 'valid-boolean', originalName: 'valid.docx' },
          result: {
            validation: { passed: true },
            artifact: { id: 'valid-artifact', filename: 'valid.docx' },
            file: { filename: 'valid.docx' },
          },
        },
      ],
    });
    assert.deepEqual(strictBatch.results.map((item) => item.artifact.id), ['valid-artifact']);
    assert.equal(strictBatch.failures[0].sourceFileId, 'invalid-truthy');
    assert.equal(
      sourcePreservingInternals.requestWantsBatchDocumentEdit(
        'fusiona los documentos adjuntos en un solo archivo',
        rows.slice(0, 2).map((row) => ({ ...row, source: 'current_upload' })),
      ),
      false,
      'a merge request must remain a single combined deliverable',
    );

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-batch',
      chatId: 'chat-batch',
      fileIds: ['batch-north', 'batch-south', 'batch-reference-pdf'],
      prompt,
      displayPrompt: prompt,
    });

    assert.equal(result.batch, true);
    assert.equal(result.partial, false);
    assert.equal(result.validation.passed, true, JSON.stringify(result.validation, null, 2));
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((item) => item.sourceFileId), ['batch-north', 'batch-south'],
      'batch source identity must survive even when file-version persistence is unavailable');
    assert.equal(new Set(result.artifacts.map((artifact) => artifact.id)).size, 2);
    assert.equal(fs.readFileSync(first.sourcePath).equals(first.buffer), true);
    assert.equal(fs.readFileSync(second.sourcePath).equals(second.buffer), true);
    assert.equal(fs.readFileSync(referencePdfPath).equals(referencePdf), true);
    assert.equal(result.orchestration.requestedDocuments, 2);
    assert.equal(result.orchestration.perDocument.some((document) => document.sourceFileId === 'batch-reference-pdf'), false);

    const proofs = [
      { result: result.results[0], own: 'CENTINELA-NORTE-101', other: 'CENTINELA-SUR-202' },
      { result: result.results[1], own: 'CENTINELA-SUR-202', other: 'CENTINELA-NORTE-101' },
    ];
    for (const proof of proofs) {
      assert.equal(proof.result.validation.passed, true);
      assert.equal(proof.result.validation.checks.source_preserved, true);
      const xml = new PizZip(fs.readFileSync(proof.result.artifact.path)).file('word/document.xml').asText();
      assert.match(xml, /<w:t[^>]*>2027<\/w:t>/);
      assert.match(xml, new RegExp(proof.own));
      assert.doesNotMatch(xml, new RegExp(proof.other));
      assert.doesNotMatch(xml, />ANEXOS</);
    }
  });
});

describe('source-preserving professional DOCX editing', () => {
  const {
    planSourcePreservingOperations,
    professionalEditDocxBuffer,
    selectSourcePreservingDocumentSet,
    validateProfessionalRevision,
  } = sourcePreservingInternals;

  it('plans an in-place professional edit instead of a generic appendix', async () => {
    const source = await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ style: 'Title', children: [new TextRun('Informe institucional')] }),
        new Paragraph('Este documento tiene una redacción simple que necesita mayor claridad y cohesión para su presentación final.'),
      ] }],
    }));
    const documentXml = new PizZip(Buffer.from(source)).file('word/document.xml').asText();
    const operations = planSourcePreservingOperations({
      requestText: 'Edita profesionalmente este documento, mejora el contenido y hazlo más interesante.',
      documentXml,
    });

    assert.equal(operations.length, 1);
    assert.equal(operations[0].kind, 'professional_edit');
    assert.equal(operations.some((op) => op.kind === 'append_generic'), false);

    const minimal = planSourcePreservingOperations({
      requestText: 'Aplica solo correcciones mínimas de ortografía, sin reescribir el contenido.',
      documentXml,
    });
    assert.deepEqual(minimal.map((op) => op.kind), ['proofread_minimal']);
  });

  it('prioritizes the document the user says they delivered over an older generated artifact', () => {
    const selection = selectSourcePreservingDocumentSet({
      requestText: 'Mejora profesionalmente el mismo documento que te entregué y devuélvemelo editado.',
      sourceFiles: [{
        id: 'uploaded-original',
        originalName: 'informe-del-usuario.docx',
        filename: 'informe-del-usuario.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        path: '/tmp/informe-del-usuario.docx',
        source: 'recent_attachment',
      }],
      priorArtifacts: [{
        id: 'artifact:older',
        originalName: 'otro-documento-editado.docx',
        filename: 'otro-documento-editado.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        path: '/tmp/otro-documento-editado.docx',
        source: 'generated_artifact',
      }],
    });

    assert.equal(selection.sourceFile.id, 'uploaded-original');
    assert.equal(selection.selectionReason, 'current_supported_file');
  });

  it('rewrites narrative paragraphs while preserving title, table, references, facts, and formatting', async () => {
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ style: 'Title', children: [new TextRun({ text: 'Informe SIRAGPT 2026', bold: true, color: 'AA0000' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Documento de trabajo - Comité de Dirección', bold: true })] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Introducción')] }),
        new Paragraph({
          children: [new TextRun({
            text: 'En 2026, SIRAGPT inició un proceso de mejora que permitió ordenar el trabajo y presentar resultados de manera más clara.',
            color: '223344',
          })],
        }),
        new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Dato fijo 99')] })] })] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Referencias bibliográficas')] }),
        new Paragraph('Castro, L. (2024). Documento de referencia. https://example.com/fuente'),
      ] }],
    })));

    const result = await professionalEditDocxBuffer(source, {
      requestText: 'Mejora profesionalmente este documento y hazlo interesante.',
      sourceText: 'Informe institucional de SIRAGPT correspondiente al año 2026.',
      rewriteBatch: async ({ batch }) => ({
        provider: 'test-editor',
        rejected: [],
        revisions: batch.map((item) => item.text.startsWith('Documento de trabajo')
          ? { id: item.id, text: 'Documento institucional modificado' }
          : {
            id: item.id,
            text: 'En 2026, SIRAGPT consolidó un proceso de mejora orientado a organizar el trabajo, fortalecer la coordinación y comunicar los resultados con mayor claridad y precisión.',
          }),
      }),
    });

    assert.equal(result.changedParagraphs, 1);
    assert.equal(result.reviewedParagraphs, 1);
    assert.deepEqual(result.providers, ['test-editor']);
    const xml = new PizZip(result.buffer).file('word/document.xml').asText();
    assert.match(xml, /Informe SIRAGPT 2026/);
    assert.match(xml, /Documento de trabajo - Comité de Dirección/);
    assert.doesNotMatch(xml, /Documento institucional modificado/);
    assert.match(xml, /consolidó un proceso de mejora/);
    assert.match(xml, /Dato fijo 99/);
    assert.match(xml, /Castro, L\. \(2024\)/);
    assert.match(xml, /w:color w:val="223344"/);
    assert.doesNotMatch(xml, />ANEXOS</);
  });

  it('returns a validated edited artifact based on the uploaded DOCX', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-professional-edit-'));
    const originalPath = path.join(tmp, 'informe-original.docx');
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{ children: [
        new Paragraph({ style: 'Title', children: [new TextRun('Informe operativo 2026')] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Situación actual')] }),
        new Paragraph('En 2026, el equipo registró 40 solicitudes y organizó la información para comunicar el avance del proyecto.'),
      ] }],
    })));
    fs.writeFileSync(originalPath, source);

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'uploaded-professional-docx',
        path: originalPath,
        originalName: 'informe-original.docx',
        filename: 'informe-original.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: 'Informe operativo 2026. En 2026, el equipo registró 40 solicitudes.',
      },
      prompt: 'Edita profesionalmente este documento, mejora su claridad y devuélveme el mismo Word.',
      displayPrompt: 'Edita profesionalmente este documento, mejora su claridad y devuélveme el mismo Word.',
      userId: 'user-professional-edit',
      chatId: 'chat-professional-edit',
      professionalRewriteBatch: async ({ batch }) => ({
        provider: 'test-editor',
        rejected: [],
        revisions: batch.map((item) => ({
          id: item.id,
          text: 'En 2026, el equipo gestionó 40 solicitudes y estructuró la información con criterios consistentes, lo que permitió comunicar el avance del proyecto con mayor claridad.',
        })),
      }),
    });

    assert.equal(result.format, 'docx');
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /informe-original_editado_profesionalmente\.docx$/);
    assert.match(result.content, /mejoré profesionalmente 1 párrafo/);
    assert.equal(result.orchestration.baseFile, 'informe-original.docx');
    assert.equal(result.orchestration.operations[0].kind, 'professional_edit');
    const edited = fs.readFileSync(result.artifact.path);
    const xml = new PizZip(edited).file('word/document.xml').asText();
    assert.match(xml, /Informe operativo 2026/);
    assert.match(xml, /gestionó 40 solicitudes/);
    assert.doesNotMatch(xml, />ANEXOS</);
  });

  it('rejects attractive rewrites that drop protected figures or acronyms', () => {
    const original = 'En 2026, SIRAGPT procesó 150 solicitudes y alcanzó un 95% de cumplimiento durante la evaluación.';
    assert.equal(validateProfessionalRevision(
      original,
      'Durante la evaluación, la plataforma procesó numerosas solicitudes y obtuvo un cumplimiento destacado.',
    ).ok, false);
    assert.equal(validateProfessionalRevision(
      original,
      'En 2026, SIRAGPT procesó 150 solicitudes y alcanzó un 95% de cumplimiento, resultado que evidencia una ejecución consistente durante la evaluación.',
    ).ok, true);

    const repetitive = validateProfessionalRevision(
      'El equipo utiliza una herramienta central para organizar la información y facilitar la toma de decisiones en las reuniones comerciales.',
      'El equipo utiliza la herramienta como una herramienta estratégica para organizar la información y facilitar decisiones en las reuniones comerciales.',
    );
    assert.equal(repetitive.ok, false);
    assert.equal(repetitive.reason, 'repeated_wording');
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

  it('plans EVERY quoted replace pair with the user original casing', () => {
    const {
      extractAllQuotedReplacementPairs,
      planSourcePreservingOperations,
    } = sourcePreservingInternals;
    const prompt = 'reemplaza "Introducción original" por "Introducción mejorada" y cambia "BORRADOR" por "APROBADO"';
    const pairs = extractAllQuotedReplacementPairs(prompt);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[1].needle, 'BORRADOR');
    assert.equal(pairs[1].replacement, 'APROBADO');

    const ops = planSourcePreservingOperations({ requestText: prompt, format: 'docx' });
    const replaces = ops.filter((op) => op.kind === 'replace_text');
    assert.equal(replaces.length, 2);
    assert.equal(replaces[1].replacement, 'APROBADO', 'must not collapse to lowercase via normalizeText');

    const generic = planGenericOfficeOperations({ requestText: prompt, format: 'docx' });
    assert.equal(generic.filter((op) => op.kind === 'replace_text')[1].replacement, 'APROBADO');
  });

  it('parses natural "cambia de X por Y" without gluing the Spanish "de" onto the needle', () => {
    const {
      extractReplacementPair,
      planSourcePreservingOperations,
      replaceTextInDocxBuffer,
    } = sourcePreservingInternals;
    // Live prod bug (2026-08-01): user said this exact phrasing and the planner
    // produced needle "de judicial de ayacucho", which never matched the Word.
    const livePrompt = 'En el titulo del word cambia de Judicial de Ayacucho por Judicial de de Cajamarca';
    const pair = extractReplacementPair(livePrompt);
    assert.ok(pair, 'pair extracted');
    assert.equal(pair.needle, 'Judicial de Ayacucho');
    assert.equal(pair.replacement, 'Judicial de Cajamarca', 'collapses typo "de de"');

    const ops = planSourcePreservingOperations({ requestText: livePrompt, format: 'docx' });
    const replaces = ops.filter((op) => op.kind === 'replace_text');
    assert.equal(replaces.length, 1);
    assert.equal(replaces[0].needle, 'Judicial de Ayacucho');
    assert.equal(replaces[0].replacement, 'Judicial de Cajamarca');
    assert.equal(replaces[0].scope, 'title');
    // Must NOT full-rewrite the title — this is a partial span replace.
    assert.equal(ops.some((op) => op.kind === 'set_document_title'), false);

    // End-to-end: the cleaned needle must hit a real title-like paragraph.
    const PizZip = require('pizzip');
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
    return (async () => {
      const source = Buffer.from(await Packer.toBuffer(new Document({
        sections: [{
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: 'Poder Judicial de Ayacucho — Aspectos administrativos', bold: true })],
            }),
            new Paragraph('Cuerpo del informe que no debe mutar.'),
          ],
        }],
      })));
      const edited = replaceTextInDocxBuffer(source, pair.needle, pair.replacement);
      assert.ok(edited.changedCount >= 1);
      const xml = new PizZip(edited.buffer).file('word/document.xml').asText();
      assert.match(xml, /Judicial de Cajamarca/);
      assert.doesNotMatch(xml, /Judicial de Ayacucho/);
      assert.match(xml, /Cuerpo del informe que no debe mutar/);
      assert.match(xml, /Poder /); // prefix of title preserved
    })();
  });

  it('returns the same DOCX with only the requested title span changed', async () => {
    const {
      extractReplacementPair,
      planSourcePreservingOperations,
      replaceTextInDocxBuffer,
      validateDocxOperationCriteria,
    } = sourcePreservingInternals;
    const prompt = 'el titulo cambialo de ayacucho a cajamarca en mi mismo word';
    assert.deepEqual(extractReplacementPair(prompt), {
      needle: 'ayacucho',
      replacement: 'cajamarca',
    });

    const operations = planSourcePreservingOperations({ requestText: prompt, format: 'docx' });
    const replaceOperation = operations.find((op) => op.kind === 'replace_text');
    assert.ok(replaceOperation);
    assert.deepEqual(replaceOperation, {
      kind: 'replace_text',
      needle: 'ayacucho',
      replacement: 'cajamarca',
      scope: 'title',
    });

    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph({
            style: 'Title',
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Distrito Judicial de ', bold: true, color: '1F2937' }),
              new TextRun({ text: 'Ayacucho', bold: true, color: '1F2937' }),
            ],
          }),
          new Paragraph('El expediente fue remitido desde Ayacucho y esta referencia debe conservarse.'),
        ],
      }],
    })));
    const edited = replaceTextInDocxBuffer(
      source,
      replaceOperation.needle,
      replaceOperation.replacement,
      { scope: replaceOperation.scope },
    );
    replaceOperation.changedCount = edited.changedCount;
    replaceOperation.remainingMatchCount = edited.remainingMatchCount;

    assert.equal(edited.changedCount, 1);
    assert.equal(edited.remainingMatchCount, 1, 'the unrelated body reference remains');
    const xml = new PizZip(edited.buffer).file('word/document.xml').asText();
    assert.match(xml, /Distrito Judicial de /);
    assert.match(xml, /Cajamarca/);
    assert.match(xml, /desde Ayacucho y esta referencia debe conservarse/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /w:color w:val="1F2937"/);
    assert.equal(validateDocxOperationCriteria(edited.buffer, operations).passed, true);
  });

  it('plans natural Excel cell changes as cell writes, not text replacements', () => {
    const ops = planGenericOfficeOperations({
      requestText: 'Edita este Excel: cambia la celda B2 a 999 y devuelveme el Excel completo.',
      format: 'xlsx',
    });

    assert.equal(ops[0].kind, 'set_cell');
    assert.equal(ops[0].address, 'B2');
    assert.equal(ops[0].value, '999');
    assert.equal(ops.some((op) => op.kind === 'replace_text' && /celda\s+b2/i.test(op.needle)), false);
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

  it('edits a requested XLSX cell from a natural-language instruction', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-xlsx-cell-'));
    const originalPath = path.join(tmp, 'matriz.xlsx');
    fs.writeFileSync(originalPath, await makeXlsxBuffer());

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: {
        id: 'file-xlsx-cell',
        path: originalPath,
        originalName: 'matriz.xlsx',
        filename: 'matriz.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extractedText: 'Estado Pendiente; Observación Revisar matriz.',
      },
      prompt: 'Edita este Excel: cambia la celda B2 a 999 y devuelveme el Excel completo.',
      displayPrompt: 'Edita este Excel: cambia la celda B2 a 999 y devuelveme el Excel completo.',
      userId: 'user-office',
      chatId: 'chat-office',
    });

    assert.equal(result.format, 'xlsx');
    assert.equal(result.validation.passed, true);
    assert.equal(result.orchestration.operations.some((op) => op.kind === 'set_cell' && op.address === 'B2'), true);

    const edited = fs.readFileSync(result.artifact.path);
    assert.equal(await readXlsxCell(edited, 'A2'), 'Pendiente');
    assert.equal(String(await readXlsxCell(edited, 'B2')), '999');
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

  it('surgical DOCX replace keeps mixed run formatting and paragraph properties', () => {
    const {
      mutateParagraphTextSurgical,
      findNeedleSpanInText,
      deleteTextFromDocxBuffer,
    } = sourcePreservingInternals;

    // Needle split across three runs (bold + normal + italic).
    const mixed = [
      '<w:p>',
      '<w:pPr><w:jc w:val="both"/></w:pPr>',
      '<w:r><w:rPr><w:b/></w:rPr><w:t>Intro</w:t></w:r>',
      '<w:r><w:t>ducción ori</w:t></w:r>',
      '<w:r><w:rPr><w:i/></w:rPr><w:t>ginal del capítulo</w:t></w:r>',
      '</w:p>',
    ].join('');
    const mutated = mutateParagraphTextSurgical(mixed, 'Introducción original', 'Introducción revisada');
    assert.ok(mutated && mutated.changed);
    assert.match(mutated.xml, /Introducción revisada/);
    assert.match(mutated.xml, /<w:jc w:val="both"\/>/);
    assert.match(mutated.xml, /<w:b\/>/);
    assert.match(mutated.xml, /del capítulo/);
    // First run keeps bold formatting; intermediate run is emptied, not rebuilt.
    assert.match(mutated.xml, /<w:rPr><w:b\/><\/w:rPr><w:t>Introducción revisada<\/w:t>/);

    // Partial delete must not wipe the rest of the paragraph.
    const partial = mutateParagraphTextSurgical(
      '<w:p><w:r><w:t>Alpha beta gamma delta</w:t></w:r></w:p>',
      'beta gamma',
      '',
    );
    assert.ok(partial);
    assert.match(partial.xml, /Alpha/);
    assert.match(partial.xml, /delta/);
    assert.doesNotMatch(partial.xml, /beta gamma/);

    // Accent-insensitive span maps back to the original characters.
    const span = findNeedleSpanInText('Evaluación final del proyecto', 'evaluacion final');
    assert.deepEqual(span, { start: 0, end: 'Evaluación final'.length });

    // Full-buffer path preserves heading style + mixed runs outside the needle.
    const documentXml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Portada UPN</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Texto </w:t></w:r><w:r><w:t>clave a corregir</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> y más</w:t></w:r></w:p>',
      '<w:sectPr/></w:body></w:document>',
    ].join('');
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', documentXml);
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    const sourceBuffer = zip.generate({ type: 'nodebuffer' });

    const replaced = replaceTextInDocxBuffer(sourceBuffer, 'clave a corregir', 'clave corregida');
    const replacedXml = new PizZip(replaced.buffer).file('word/document.xml').asText();
    assert.match(replacedXml, /clave corregida/);
    assert.match(replacedXml, /Portada UPN/);
    assert.match(replacedXml, /Heading1/);
    assert.match(replacedXml, /<w:b\/>/);
    assert.match(replacedXml, /<w:i\/>/);
    assert.match(replacedXml, / y más/);

    const deleted = deleteTextFromDocxBuffer(replaced.buffer, 'clave corregida');
    const deletedXml = new PizZip(deleted.buffer).file('word/document.xml').asText();
    assert.doesNotMatch(deletedXml, /clave corregida/);
    assert.match(deletedXml, /Texto /);
    assert.match(deletedXml, / y más/);
    assert.match(deletedXml, /Portada UPN/);
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

  it('fails closed for PDF text replacement or deletion instead of rebuilding and losing formatting', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-preserving-pdf-generic-'));
    const originalPath = path.join(tmp, 'estado.pdf');
    const original = await makePdfBuffer();
    fs.writeFileSync(originalPath, original);
    const sourceFile = {
      id: 'file-pdf',
      path: originalPath,
      originalName: 'estado.pdf',
      filename: 'estado.pdf',
      mimeType: 'application/pdf',
      extractedText: 'SiraGPT banco real PDF\nEstado: BORRADOR',
    };

    for (const prompt of [
      'reemplaza BORRADOR por APROBADO en este PDF y devuelve el PDF editado',
      'elimina BORRADOR de este PDF y devuelve el mismo PDF',
    ]) {
      await assert.rejects(
        () => generateSourcePreservingDocumentEdit({
          sourceFile,
          prompt,
          displayPrompt: prompt,
          userId: 'user-office',
          chatId: 'chat-office',
        }),
        (error) => {
          assert.equal(error.code, 'PDF_TEXT_EDIT_PRESERVATION_UNSUPPORTED');
          assert.equal(error.validationOnlyFailure, true);
          assert.match(error.message, /PDF/);
          assert.match(error.message, /DOCX\/Word/);
          assert.match(error.message, /diseño, imágenes y estructura/);
          return true;
        },
      );
    }

    assert.equal(fs.readFileSync(originalPath).equals(original), true, 'the uploaded PDF must remain byte-identical');
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
