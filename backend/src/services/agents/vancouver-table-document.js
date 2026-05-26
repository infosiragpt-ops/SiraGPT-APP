const {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require('docx');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { renderPreview } = require('../doc-preview');
const {
  EXTENSION_TO_MIME,
  INTERNAL: { validateAgentArtifactBuffer },
  saveArtifact,
} = require('./task-tools');
const persistence = require('./agent-task-persistence');

const VANCOUVER_HEADERS = [
  'TÍTULO DEL ARTÍCULO',
  'AUTORES',
  'AÑO DE PUBLICACIÓN',
  'DISEÑO DE INVESTIGACIÓN',
  'MUESTREO',
  'N',
  'PROCEDENCIA',
  'OCUPACIÓN',
  'INSTRUMENTO',
];

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanText(value, max = 360) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  if (!text) return 'No especificado en el documento';
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function decodeXml(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function isVancouverMatrixWordRequest(goal = '') {
  const text = normalize(goal);
  return (
    /\bvancouver\b/.test(text) &&
    /\b(word|docx|documento)\b/.test(text) &&
    /\b(tabla|matriz|titulo|autores|muestreo|instrumento|resultados)\b/.test(text)
  );
}

function sentencesFrom(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((line) => cleanText(line, 520))
    .filter((line) => line.length >= 12);
}

function firstSentenceMatching(text, patterns, max = 260) {
  const sentences = sentencesFrom(text);
  for (const sentence of sentences) {
    const normalized = normalize(sentence);
    if (patterns.some((pattern) => pattern.test(normalized))) return cleanText(sentence, max);
  }
  return 'No especificado en el documento';
}

function extractTitle(text, fallbackName) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => cleanText(line, 220))
    .filter((line) => line.length >= 18 && !/^(tabla|figura|resumen|abstract|introducci[oó]n)$/i.test(line));

  const titleLine = lines.find((line) => {
    const n = normalize(line);
    return /conocimiento|anticoncept|administraci|negocios|investigaci|estudio|efecto|relacion/.test(n);
  }) || lines[0];

  if (titleLine) return cleanText(titleLine, 220);
  return cleanText(String(fallbackName || '').replace(/\.[^.]+$/, ''), 220);
}

function extractAuthors(text) {
  const authorBlock = String(text || '').match(/(?:autor(?:es)?|presentado por|elaborado por)\s*[:\n]\s*([\s\S]{0,420})/i);
  if (authorBlock) {
    const candidates = authorBlock[1]
      .split(/\n|;|,/)
      .map((item) => cleanText(item, 120))
      .filter((item) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(item))
      .slice(0, 6);
    if (candidates.length) return candidates.join('; ');
  }

  const nameLines = String(text || '')
    .split(/\n+/)
    .map((line) => cleanText(line, 120))
    .filter((line) => {
      const n = normalize(line);
      return /^[a-záéíóúñ.\s-]{8,}$/i.test(line) &&
        /\s/.test(line) &&
        !/universidad|facultad|escuela|tesis|resumen|abstract|capitulo|tabla|figura/.test(n);
    })
    .slice(0, 4);
  return nameLines.length ? nameLines.join('; ') : 'No especificado en el documento';
}

function extractYear(text) {
  const matches = String(text || '').match(/\b(19[8-9]\d|20[0-3]\d)\b/g) || [];
  return matches.length ? matches[matches.length - 1] : 'No especificado';
}

function extractSampleSize(text) {
  const source = String(text || '');
  const direct = source.match(/\b(?:n|muestra|participantes|encuestados|estudiantes)\s*(?:=|:|de|fue de|estuvo conformada por)?\s*(\d{2,5})\b/i);
  if (direct) return direct[1];
  const nearby = source.match(/(?:muestra|participantes|poblaci[oó]n|encuestados)[\s\S]{0,180}?(\d{2,5})/i);
  return nearby ? nearby[1] : 'No especificado';
}

function sampleSizeFromText(text) {
  const source = String(text || '');
  const direct = source.match(/\b(?:n|muestra|participantes|encuestados|estudiantes)\s*(?:=|:|de|fue de|conformada por)?\s*(\d{2,5})\b/i);
  if (direct) return direct[1];
  const loose = source.match(/\b(\d{2,5})\s+(?:estudiantes|participantes|universitarias|universitarios|mujeres|usuarios|pacientes)\b/i);
  return loose ? loose[1] : 'No especificado';
}

function yearFromAuthorCell(text) {
  const match = String(text || '').match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  return match ? match[1] : 'No especificado';
}

function authorsFromAuthorCell(text) {
  return cleanText(String(text || '').replace(/\s*\((?:19[8-9]\d|20[0-3]\d)\)\s*/g, ''), 220);
}

function resolveUploadedFilePath(file) {
  const candidates = [
    file?.path,
    file?.storagePath,
    file?.url,
  ]
    .filter(Boolean)
    .map((candidate) => String(candidate).replace(/^file:\/\//, ''));

  for (const candidate of candidates) {
    const absoluteCandidates = path.isAbsolute(candidate)
      ? [candidate]
      : [
          path.resolve(process.cwd(), candidate),
          path.resolve(process.cwd(), 'backend', candidate),
        ];
    const found = absoluteCandidates.find((item) => fs.existsSync(item));
    if (found) return found;
  }
  return null;
}

function extractCellText(cellXml) {
  return decodeXml(
    Array.from(String(cellXml || '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
      .map((match) => match[1])
      .join('')
  ).replace(/\s+/g, ' ').trim();
}

async function extractDocxTables(file) {
  const filePath = resolveUploadedFilePath(file);
  if (!filePath || !/\.docx$/i.test(filePath)) return [];

  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) return [];

  return Array.from(documentXml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g))
    .map((tableMatch) => Array.from(tableMatch[0].matchAll(/<w:tr(?:\s|>)[\s\S]*?<\/w:tr>/g))
      .map((rowMatch) => Array.from(rowMatch[0].matchAll(/<w:tc(?:\s|>)[\s\S]*?<\/w:tc>/g))
        .map((cellMatch) => cleanText(extractCellText(cellMatch[0]), 900))))
    .filter((table) => table.length > 1 && table.some((row) => row.some(Boolean)));
}

function matrixTableScore(table) {
  const header = (table?.[0] || []).map(normalize).join(' ');
  let score = 0;
  if (/\bautor/.test(header)) score += 2;
  if (/\btitulo|\bestudio|\barticulo/.test(header)) score += 2;
  if (/\bmuestra|\bpoblacion|\bmuestreo/.test(header)) score += 2;
  if (/\benfoque|\btipo|\bdiseno|\bestudio/.test(header)) score += 1;
  if (/\bresultado|\bhallazgo/.test(header)) score += 1;
  if (/\bpais|\bprocedencia/.test(header)) score += 1;
  if (table.length >= 6) score += 2;
  return score;
}

function findHeaderIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function mapMatrixTableToRows(table) {
  const headerRow = table?.[0] || [];
  const normalizedHeaders = headerRow.map(normalize);
  const index = {
    authorYear: findHeaderIndex(normalizedHeaders, [/autor/, /autores/]),
    title: findHeaderIndex(normalizedHeaders, [/titulo/, /estudio/, /articulo/]),
    origin: findHeaderIndex(normalizedHeaders, [/pais/, /procedencia/, /origen/]),
    sample: findHeaderIndex(normalizedHeaders, [/muestra/, /poblacion/, /muestreo/, /participantes/]),
    design: findHeaderIndex(normalizedHeaders, [/enfoque/, /tipo de estudio/, /\btipo\b/, /diseno/]),
    results: findHeaderIndex(normalizedHeaders, [/resultado/, /hallazgo/, /conclusion/]),
    instrument: findHeaderIndex(normalizedHeaders, [/instrumento/, /escala/, /cuestionario/, /encuesta/]),
    occupation: findHeaderIndex(normalizedHeaders, [/ocupacion/, /poblacion/, /participantes/]),
  };

  return table
    .slice(1)
    .map((row) => {
      const authorYear = row[index.authorYear] || '';
      const sample = row[index.sample] || '';
      const results = row[index.results] || '';
      return {
        title: cleanText(row[index.title], 320),
        authors: authorsFromAuthorCell(authorYear),
        year: yearFromAuthorCell(authorYear),
        design: cleanText(row[index.design], 220),
        sampling: cleanText(sample, 220),
        sampleSize: sampleSizeFromText(sample),
        origin: cleanText(row[index.origin], 180),
        occupation: cleanText(
          row[index.occupation] || sample.replace(/\b\d{2,5}\b/g, '').trim(),
          180
        ),
        instrument: index.instrument >= 0
          ? cleanText(row[index.instrument], 220)
          : inferInstrumentFromText(results || row.join(' ')),
      };
    })
    .filter((row) => {
      const joined = normalize(Object.values(row).join(' '));
      return joined.length > 30 && !/^no especificado/.test(normalize(row.title));
    });
}

function inferInstrumentFromText(text) {
  const normalized = normalize(text);
  if (/cuestionario|encuesta|kap|escala|instrumento/.test(normalized)) {
    return firstSentenceMatching(text, [/cuestionario/, /encuesta/, /kap/, /escala/, /instrumento/], 220);
  }
  return 'No especificado en el documento';
}

async function extractRowsFromNativeTables(file) {
  const tables = await extractDocxTables(file);
  if (!tables.length) return [];

  const scored = tables
    .map((table) => ({ table, score: matrixTableScore(table) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 6) return [];
  return mapMatrixTableToRows(best.table);
}

function buildVancouverReference(row) {
  const authors = row.authors && !/^no especificado/i.test(row.authors) ? row.authors : 'Autor no especificado';
  const title = row.title && !/^no especificado/i.test(row.title) ? row.title : 'Titulo no especificado';
  const year = row.year && !/^no especificado/i.test(row.year) ? row.year : 's. f.';
  return `${authors}. ${title}. ${year}.`;
}

function extractRowFromDocument(file, fullText) {
  const text = String(fullText || '');
  return {
    title: extractTitle(text, file?.originalName || file?.filename),
    authors: extractAuthors(text),
    year: extractYear(text),
    design: firstSentenceMatching(text, [
      /diseno/,
      /tipo de investigacion/,
      /estudio/,
      /observacional/,
      /descriptivo/,
      /transversal/,
      /correlacional/,
      /cuantitativo/,
    ], 260),
    sampling: firstSentenceMatching(text, [
      /muestreo/,
      /muestra/,
      /probabilistico/,
      /no probabilistico/,
      /participantes/,
    ], 240),
    sampleSize: extractSampleSize(text),
    origin: firstSentenceMatching(text, [
      /procedencia/,
      /universidad/,
      /facultad/,
      /escuela/,
      /hospital/,
      /centro/,
      /peru/,
      /lima/,
    ], 240),
    occupation: firstSentenceMatching(text, [
      /ocupacion/,
      /estudiantes/,
      /profesionales/,
      /trabajadores/,
      /pacientes/,
      /usuarios/,
    ], 180),
    instrument: firstSentenceMatching(text, [
      /instrumento/,
      /cuestionario/,
      /encuesta/,
      /escala/,
      /ficha/,
      /validado/,
      /cronbach/,
    ], 260),
  };
}

async function extractRowsFromDocument(file, fullText) {
  const tableRows = await extractRowsFromNativeTables(file);
  if (tableRows.length) return tableRows;
  return [extractRowFromDocument(file, fullText)];
}

async function loadDocuments(prisma, userId, fileIds) {
  if (!prisma || !Array.isArray(fileIds) || fileIds.length === 0) return [];
  const files = await prisma.file.findMany({
    where: { id: { in: fileIds.map(String).filter(Boolean) }, userId: String(userId) },
    include: {
      documentAnalysis: {
        include: {
          chunks: { orderBy: { ordinal: 'asc' } },
          tables: { orderBy: { ordinal: 'asc' } },
        },
      },
    },
  });
  return files.map((file) => {
    const chunkText = (file.documentAnalysis?.chunks || [])
      .map((chunk) => chunk.text)
      .filter(Boolean)
      .join('\n\n');
    const tableText = (file.documentAnalysis?.tables || [])
      .map((table) => table.markdown)
      .filter(Boolean)
      .join('\n\n');
    return {
      file,
      text: [file.extractedText, chunkText, tableText].filter(Boolean).join('\n\n'),
    };
  });
}

function textParagraph(text, options = {}) {
  return new Paragraph({
    alignment: options.alignment || AlignmentType.LEFT,
    spacing: { after: options.after ?? 120, before: options.before ?? 0 },
    children: [
      new TextRun({
        text: cleanText(text, options.max || 900),
        bold: Boolean(options.bold),
        italics: Boolean(options.italics),
        size: options.size || 20,
        color: options.color || '111827',
      }),
    ],
  });
}

function cell(text, { header = false, width = 1200 } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: '17324D' } : undefined,
    margins: { top: 110, bottom: 110, left: 110, right: 110 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: '94A3B8' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: '94A3B8' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' },
    },
    children: [
      new Paragraph({
        alignment: header ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [
          new TextRun({
            text: cleanText(text, header ? 80 : 520),
            bold: header,
            color: header ? 'FFFFFF' : '111827',
            size: header ? 14 : 15,
          }),
        ],
      }),
    ],
  });
}

function buildTable(rows) {
  const widths = [2100, 1800, 900, 1800, 1800, 620, 1800, 1500, 1900];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: VANCOUVER_HEADERS.map((header, index) => cell(header, { header: true, width: widths[index] })),
      }),
      ...rows.map((row) => new TableRow({
        children: [
          row.title,
          row.authors,
          row.year,
          row.design,
          row.sampling,
          row.sampleSize,
          row.origin,
          row.occupation,
          row.instrument,
        ].map((value, index) => cell(value, { width: widths[index] })),
      })),
    ],
  });
}

function buildDocxBuffer(rows, goal) {
  const references = rows.map(buildVancouverReference);
  const children = [
    textParagraph('Matriz de resultados en estilo Vancouver', {
      alignment: AlignmentType.CENTER,
      bold: true,
      size: 28,
      after: 140,
    }),
    textParagraph('Estructura solicitada por el usuario: título del artículo, autores, año de publicación, diseño de investigación, muestreo, N, procedencia, ocupación e instrumento.', {
      alignment: AlignmentType.CENTER,
      size: 18,
      color: '475569',
      after: 220,
    }),
    buildTable(rows),
    textParagraph('Referencias en estilo Vancouver', { bold: true, size: 24, before: 260, after: 120 }),
    ...references.map((reference, index) => textParagraph(`${index + 1}. ${reference}`, { size: 19, after: 90 })),
    textParagraph(`Solicitud procesada: ${cleanText(goal, 500)}`, { italics: true, size: 16, color: '64748B', before: 180 }),
  ];

  const doc = new Document({
    creator: 'siraGPT',
    title: 'Matriz de resultados en estilo Vancouver',
    description: 'Documento DOCX generado por el runtime agentico de siraGPT.',
    sections: [{
      properties: {
        page: {
          size: { orientation: 'landscape' },
          margin: { top: 720, bottom: 720, left: 540, right: 540 },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

async function generateVancouverMatrixDocument({
  prisma,
  task,
  userId,
  fileIds,
  goal,
  emit,
} = {}) {
  emit?.({ type: 'checkpoint', label: 'Matriz Vancouver', status: 'running', payload: { format: 'docx' } });
  const docs = await loadDocuments(prisma, userId || task?.userId, fileIds);
  const rows = (await Promise.all(
    docs.map(({ file, text }) => extractRowsFromDocument(file, text))
  ))
    .flat()
    .filter(Boolean);

  if (rows.length === 0) {
    throw new Error('No hay contenido documental suficiente para construir la matriz Vancouver.');
  }

  const buffer = await buildDocxBuffer(rows, goal);
  const validation = validateAgentArtifactBuffer('docx', buffer);
  const filename = rows.length === 1
    ? `matriz_vancouver_${String(docs[0].file.originalName || 'documento').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 42)}.docx`
    : 'matriz_vancouver_documentos.docx';
  const artifact = saveArtifact({
    filename,
    base64: buffer.toString('base64'),
    mime: EXTENSION_TO_MIME.docx,
    ownerUserId: task?.userId || userId,
    chatId: task?.chatId,
    validation,
  });

  let previewHtml = null;
  try {
    const preview = await renderPreview('docx', buffer.toString('base64'));
    previewHtml = preview?.html || null;
  } catch (err) {
    emit?.({
      type: 'quality_gate',
      gate: 'preview',
      passed: false,
      summary: `Preview no disponible: ${err.message}`,
    });
  }

  emit?.({
    type: 'quality_gate',
    gate: 'artifact_validation',
    label: 'Validación DOCX',
    passed: Boolean(validation?.passed),
    score: validation?.overallScore ?? null,
    summary: validation?.passed
      ? 'Matriz Word verificada antes de entregar.'
      : 'Matriz Word generada con advertencias de validación.',
    payload: { format: 'docx', checks: validation?.checks || {}, rows: rows.length },
  });

  const eventArtifact = {
    id: artifact.id,
    filename: artifact.filename,
    format: artifact.format,
    mime: artifact.mime,
    sizeBytes: artifact.sizeBytes,
    downloadUrl: artifact.downloadUrl,
    previewHtml,
    validation,
  };
  emit?.({ type: 'file_artifact', artifact: eventArtifact });

  await persistence.persistGeneratedArtifact({
    artifact: { ...artifact, validation },
    task,
    previewHtml,
    validation,
  });

  return {
    artifact: eventArtifact,
    previewHtml,
    validation,
    finalMarkdown: [
      'Preparé el Word con la tabla solicitada en estructura Vancouver y lo validé antes de adjuntarlo.',
      '',
      `Filas creadas: ${rows.length}.`,
      `Columnas: ${VANCOUVER_HEADERS.join(', ')}.`,
    ].join('\n'),
    rows,
  };
}

module.exports = {
  VANCOUVER_HEADERS,
  generateVancouverMatrixDocument,
  isVancouverMatrixWordRequest,
  INTERNAL: {
    mapMatrixTableToRows,
    matrixTableScore,
  },
};
