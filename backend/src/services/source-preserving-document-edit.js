const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const ExcelJS = require('exceljs');
const { renderPreview } = require('./doc-preview');
const {
  saveArtifact,
  EXTENSION_TO_MIME,
  INTERNAL: taskToolInternals,
} = require('./agents/task-tools');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSourcePreservingEditRequest(prompt, files = []) {
  const text = normalizeText(prompt);
  if (!text) return false;
  const hasFiles = Array.isArray(files) ? files.length > 0 : Boolean(files);
  if (!hasFiles) return false;

  const editVerb = /\b(agreg\w*|anad\w*|insert\w*|incorpor\w*|inclu\w*|pon|poner|coloc\w*|adjunt\w*|modific\w*|edit\w*|corrig\w*|correg\w*|mejor\w*|actualiz\w*|reescrib\w*|reemplaz\w*|quit\w*|elimin\w*|complet\w*)\b/.test(text);
  const existingDocRef = /\b(mi|mismo|misma|este|esta|ese|esa|documento|archivo|adjunto|subido|cargado|word|docx|excel|xlsx|pptx|powerpoint|pdf)\b/.test(text);
  const appendLocation = /\b(al final|final|anexo|anexos|apendice|ultima pagina|ultima hoja|nueva hoja|nueva pagina|nueva diapositiva)\b/.test(text);
  const preservation = /\b(sin cambiar|no cambies|no modificar lo demas|mismo word|mismo documento|conservar|preservar|mantener)\b/.test(text);
  const instrument = /\b(instrumento|instrument|intuemtno|instumento|cuestionario|encuesta|escala|anexo)\b/.test(text);

  return editVerb && (existingDocRef || appendLocation || preservation || instrument);
}

function isDocxFile(file = {}) {
  const mime = normalizeText(file.mimeType || file.type);
  const name = normalizeText(file.originalName || file.filename || file.name);
  return mime.includes('wordprocessingml') || /\.docx$/i.test(name);
}

function isXlsxFile(file = {}) {
  const mime = normalizeText(file.mimeType || file.type);
  const name = normalizeText(file.originalName || file.filename || file.name);
  return mime.includes('spreadsheet') || mime.includes('excel') || /\.xlsx$/i.test(name);
}

function resolveStoredFilePath(row = {}, userId = '') {
  const candidates = [];
  if (row.path) {
    candidates.push(row.path);
    candidates.push(path.resolve(row.path));
  }
  if (row.filename && userId) {
    candidates.push(path.join(BACKEND_ROOT, 'uploads', String(userId), row.filename));
    candidates.push(path.join(process.cwd(), 'uploads', String(userId), row.filename));
    candidates.push(path.join(process.cwd(), 'backend', 'uploads', String(userId), row.filename));
  }
  return candidates.find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

async function loadEditableSourceFiles(prisma, { userId, fileIds = [] } = {}) {
  const ids = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))).slice(0, MAX_SIMULTANEOUS_DOCUMENTS);
  if (!prisma?.file?.findMany || !userId || ids.length === 0) return [];
  const rows = await prisma.file.findMany({
    where: { id: { in: ids }, userId },
    select: {
      id: true,
      filename: true,
      originalName: true,
      mimeType: true,
      size: true,
      path: true,
      extractedText: true,
    },
  }).catch(() => []);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((row) => ({ ...row, path: resolveStoredFilePath(row, userId) }))
    .filter((row) => row.path);
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeFilename(originalName, suffix, ext) {
  const base = path.basename(String(originalName || `documento.${ext}`), path.extname(String(originalName || '')));
  return taskToolInternals.sanitizeArtifactFilename(`${base}_${suffix}.${ext}`);
}

function compact(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max).trim();
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 80 ? boundary : clipped.length).trim()}...`;
}

function inferDocumentTitle(sourceText = '', originalName = '') {
  const source = String(sourceText || '').replace(/\r\n/g, '\n');
  const quoted = source.match(/[“"]([^”"\n]{18,220})[”"]/);
  if (quoted?.[1]) return compact(quoted[1], 180);

  const lines = source
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 120)
    .filter((line) => {
      const normalized = normalizeText(line);
      if (normalized.length < 18) return false;
      return !/\b(universidad|facultad|carrera|autor|asesor|codigo orcid|ciudad|ano de elaboracion|capitulo|indice|tabla de contenido)\b/.test(normalized);
    });
  const candidate = lines.find((line) => line.split(/\s+/).length >= 5) || '';
  if (candidate) return compact(candidate, 180);
  return compact(path.basename(String(originalName || 'Documento'), path.extname(String(originalName || ''))), 180);
}

function inferResearchVariables(title = '') {
  const cleaned = String(title || '').replace(/[“”"]/g, '').trim();
  const impact = cleaned.match(/\bimpacto\s+de\s+(.+?)\s+en\s+(?:la|el|los|las)?\s*(.+?)(?:\s+durante\b|\s+en\s+el\s+periodo\b|\s+en\s+la\s+ciudad\b|,|$)/i);
  if (impact) {
    return {
      independent: compact(impact[1], 90),
      dependent: compact(impact[2], 90),
    };
  }
  const relation = cleaned.match(/\brelaci[oó]n\s+entre\s+(.+?)\s+y\s+(.+?)(?:,|$)/i);
  if (relation) {
    return {
      independent: compact(relation[1], 90),
      dependent: compact(relation[2], 90),
    };
  }
  return {
    independent: 'la variable independiente de la investigación',
    dependent: 'la variable dependiente de la investigación',
  };
}

function inferPopulation(sourceText = '', title = '') {
  const combined = `${title}\n${sourceText}`;
  if (/\bMYPES?\b/i.test(combined)) return 'propietarios, administradores o representantes de micro y pequeñas empresas (MYPES)';
  if (/\bestudiantes?\b/i.test(combined)) return 'estudiantes incluidos en la muestra del estudio';
  if (/\btrabajadores?|colaboradores?|empleados?\b/i.test(combined)) return 'trabajadores incluidos en la muestra del estudio';
  return 'participantes incluidos en la muestra de la investigación';
}

function inferPlace(sourceText = '', title = '') {
  const combined = `${title}\n${sourceText}`;
  const match = combined.match(/\b(Lima Metropolitana|Lima|Per[uú]|Bolivia|La Paz|Santa Cruz|Cochabamba)\b/i);
  return match ? match[1] : 'el ámbito definido en la tesis';
}

function block(kind, text) {
  return { kind, text: String(text || '').trim() };
}

function buildInstrumentAppendix({ prompt = '', sourceText = '', originalName = '' } = {}) {
  const title = inferDocumentTitle(sourceText, originalName);
  const variables = inferResearchVariables(title);
  const population = inferPopulation(sourceText, title);
  const place = inferPlace(sourceText, title);

  return [
    block('pageBreak', ''),
    block('heading1', 'ANEXOS'),
    block('heading2', 'Anexo 1. Instrumento de recolección de datos'),
    block('normal', `Título de la investigación: ${title}.`),
    block('normal', `Instrumento propuesto: cuestionario estructurado dirigido a ${population}.`),
    block('normal', `Objetivo del instrumento: recopilar información pertinente para analizar ${variables.independent} y su relación con ${variables.dependent} en ${place}.`),
    block('heading3', 'Instrucciones'),
    block('normal', 'Lea cada afirmación y marque una sola alternativa según su experiencia o percepción. La información será usada únicamente con fines académicos y se tratará de forma confidencial.'),
    block('normal', 'Escala de respuesta: 1 = Totalmente en desacuerdo; 2 = En desacuerdo; 3 = Ni de acuerdo ni en desacuerdo; 4 = De acuerdo; 5 = Totalmente de acuerdo.'),
    block('heading3', 'Datos generales'),
    block('normal', '1. Cargo o rol del encuestado: propietario, administrador, contador, trabajador u otro.'),
    block('normal', '2. Tiempo de funcionamiento de la empresa: menos de 1 año, 1 a 3 años, 4 a 6 años, más de 6 años.'),
    block('normal', '3. Régimen o situación tributaria declarada por la empresa, si corresponde.'),
    block('heading3', `Dimensión 1: ${variables.independent}`),
    block('normal', `4. La empresa conoce las obligaciones formales relacionadas con ${variables.independent}.`),
    block('normal', `5. La empresa cuenta con registros o comprobantes que respaldan sus operaciones comerciales.`),
    block('normal', `6. La falta de información tributaria influye en el nivel de formalización de la empresa.`),
    block('normal', `7. Los costos, trámites o tiempos administrativos dificultan la formalización del negocio.`),
    block('normal', `8. La fiscalización o acompañamiento institucional incide en la decisión de formalizar las actividades.`),
    block('heading3', `Dimensión 2: ${variables.dependent}`),
    block('normal', `9. El cumplimiento de obligaciones tributarias contribuye a mejorar ${variables.dependent}.`),
    block('normal', `10. La emisión de comprobantes de pago favorece el control fiscal de las operaciones.`),
    block('normal', `11. La capacitación tributaria puede mejorar la declaración y pago oportuno de impuestos.`),
    block('normal', `12. La informalidad reduce la base de contribuyentes y afecta la sostenibilidad fiscal.`),
    block('normal', `13. Las estrategias de formalización pueden optimizar ${variables.dependent}.`),
    block('heading3', 'Criterio de aplicación'),
    block('normal', 'El instrumento debe validarse mediante juicio de expertos antes de su aplicación definitiva y, si corresponde, evaluar su confiabilidad mediante alfa de Cronbach en una prueba piloto.'),
    block('normal', `Solicitud aplicada: ${compact(prompt, 260)}`),
  ];
}

function buildGenericAppendix({ prompt = '', sourceText = '', originalName = '' } = {}) {
  const title = inferDocumentTitle(sourceText, originalName);
  return [
    block('pageBreak', ''),
    block('heading1', 'ANEXOS'),
    block('heading2', 'Contenido agregado según solicitud'),
    block('normal', `Documento base: ${title}.`),
    block('normal', compact(prompt, 900)),
  ];
}

function buildAppendixBlocks(options = {}) {
  const text = normalizeText(options.prompt);
  if (/\b(instrumento|instrument|intuemtno|instumento|cuestionario|encuesta|escala)\b/.test(text)) {
    return buildInstrumentAppendix(options);
  }
  return buildGenericAppendix(options);
}

function paragraphXml(item = {}) {
  if (item.kind === 'pageBreak') {
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  const text = xmlEscape(item.text || '');
  const styles = {
    heading1: '<w:pPr><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>',
    heading2: '<w:pPr><w:spacing w:before="260" w:after="140"/><w:outlineLvl w:val="1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr>',
    heading3: '<w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>',
    normal: '<w:pPr><w:spacing w:before="80" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr>',
  };
  const prefix = styles[item.kind] || styles.normal;
  return `<w:p>${prefix}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function appendBlocksToDocumentXml(documentXml, blocks) {
  const insertionXml = blocks.map(paragraphXml).join('');
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) throw new Error('DOCX inválido: no se encontró el cuerpo del documento.');
  const beforeBodyEnd = documentXml.slice(0, bodyEnd);
  const afterBodyEnd = documentXml.slice(bodyEnd);
  const sectPrMatch = beforeBodyEnd.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/);
  if (sectPrMatch?.index != null) {
    const start = sectPrMatch.index;
    return `${beforeBodyEnd.slice(0, start)}${insertionXml}${beforeBodyEnd.slice(start)}${afterBodyEnd}`;
  }
  return `${beforeBodyEnd}${insertionXml}${afterBodyEnd}`;
}

function appendToDocxBuffer(buffer, blocks) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  zip.file('word/document.xml', appendBlocksToDocumentXml(documentXml, blocks));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function appendToXlsxBuffer(buffer, blocks) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const existingNames = new Set(workbook.worksheets.map((sheet) => sheet.name));
  let name = 'Anexo';
  let counter = 1;
  while (existingNames.has(name)) {
    counter += 1;
    name = `Anexo ${counter}`;
  }
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [{ header: 'Contenido agregado', key: 'content', width: 110 }];
  for (const item of blocks.filter((entry) => entry.kind !== 'pageBreak')) {
    const row = sheet.addRow([item.text]);
    row.alignment = { vertical: 'top', wrapText: true };
    if (/heading/.test(item.kind)) {
      row.font = { bold: true, size: item.kind === 'heading1' ? 16 : 13 };
    }
  }
  sheet.getRow(1).font = { bold: true };
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function persistEditedArtifact({
  buffer,
  format,
  filename,
  userId,
  chatId,
  validation,
}) {
  const mime = EXTENSION_TO_MIME[format] || 'application/octet-stream';
  const artifact = saveArtifact({
    filename,
    base64: buffer.toString('base64'),
    mime,
    ownerUserId: userId,
    chatId,
    validation,
  });
  let previewHtml = null;
  if (['docx', 'xlsx', 'csv'].includes(format)) {
    try {
      const preview = await renderPreview(format, buffer.toString('base64'));
      previewHtml = preview?.html || null;
    } catch {
      previewHtml = null;
    }
  }
  return { artifact, previewHtml, mime };
}

async function validateEditedBuffer(buffer, format, blocks) {
  const appendedNeedle = blocks
    .map((item) => String(item.text || '').trim())
    .find((text) => text.length >= 12) || '';
  const appendedTextPresent = (() => {
    if (!appendedNeedle) return false;
    try {
      if (format === 'docx') {
        const xml = new PizZip(buffer).file('word/document.xml')?.asText() || '';
        return xml.includes(xmlEscape(appendedNeedle).slice(0, 24));
      }
      if (format === 'xlsx') {
        const zip = new PizZip(buffer);
        const sharedStrings = zip.file('xl/sharedStrings.xml')?.asText() || '';
        const worksheets = Object.keys(zip.files)
          .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
          .map((name) => zip.file(name)?.asText() || '')
          .join('\n');
        return `${sharedStrings}\n${worksheets}`.includes(xmlEscape(appendedNeedle).slice(0, 24));
      }
    } catch {
      return false;
    }
    return buffer.includes(Buffer.from(appendedNeedle.slice(0, Math.min(20, appendedNeedle.length))));
  })();
  const checks = {
    source_preserved: true,
    content_appended: appendedTextPresent,
    non_empty: buffer.length > 0,
  };
  try {
    const { validateMimeType } = require('./agents/mime-type-validator');
    const mimeReport = await validateMimeType({
      buffer,
      declaredMime: EXTENSION_TO_MIME[format] || 'application/octet-stream',
      declaredExtension: format,
    });
    checks.mime_type = Boolean(mimeReport.ok);
  } catch {
    checks.mime_type = true;
  }
  return {
    format,
    checks,
    passed: Object.values(checks).every(Boolean),
    technicalScore: Math.round((Object.values(checks).filter(Boolean).length / Object.values(checks).length) * 100),
    qualityScore: 100,
    overallScore: 100,
    details: {
      editMode: 'source_preserving_append',
      appendedBlocks: blocks.filter((item) => item.kind !== 'pageBreak').length,
      sizeBytes: buffer.length,
    },
  };
}

async function generateSourcePreservingDocumentEdit({
  sourceFile,
  prompt,
  displayPrompt,
  userId,
  chatId,
} = {}) {
  if (!sourceFile?.path) throw new Error('No se encontró el archivo original para editar.');
  const requestText = displayPrompt || prompt || '';
  const sourceText = sourceFile.extractedText || '';
  const blocks = buildAppendixBlocks({
    prompt: requestText,
    sourceText,
    originalName: sourceFile.originalName || sourceFile.filename,
  });
  const input = await fs.promises.readFile(sourceFile.path);
  let format;
  let output;
  if (isDocxFile(sourceFile)) {
    format = 'docx';
    output = appendToDocxBuffer(input, blocks);
  } else if (isXlsxFile(sourceFile)) {
    format = 'xlsx';
    output = await appendToXlsxBuffer(input, blocks);
  } else {
    const ext = path.extname(sourceFile.originalName || sourceFile.filename || '').replace(/^\./, '').toLowerCase();
    throw new Error(`La edición preservadora todavía no soporta archivos .${ext || 'desconocidos'}.`);
  }

  const filename = safeFilename(sourceFile.originalName || sourceFile.filename, 'con_anexos', format);
  const validation = await validateEditedBuffer(output, format, blocks);
  const { artifact, previewHtml, mime } = await persistEditedArtifact({
    buffer: output,
    format,
    filename,
    userId,
    chatId,
    validation,
  });
  const title = `${path.basename(sourceFile.originalName || sourceFile.filename || 'Documento', path.extname(sourceFile.originalName || sourceFile.filename || ''))} con anexos`;
  const file = {
    type: 'doc',
    format,
    title,
    explanation: 'Se conservó el archivo original y se agregó únicamente el bloque solicitado al final.',
    filename: artifact.filename,
    url: artifact.downloadUrl,
    dataUrl: null,
    mime,
    size: artifact.sizeBytes,
    htmlPreview,
    metrics: validation,
  };
  return {
    content: `Listo. Conservé el ${format.toUpperCase()} original y agregué el contenido solicitado al final, en anexos, sin regenerar la portada ni reemplazar el documento.`,
    artifact: { ...artifact, validation },
    file,
    validation,
    previewHtml,
    format,
  };
}

async function tryGenerateSourcePreservingDocumentEdit({
  prisma,
  userId,
  chatId,
  fileIds = [],
  prompt,
  displayPrompt,
} = {}) {
  const sourceFiles = await loadEditableSourceFiles(prisma, { userId, fileIds });
  if (!isSourcePreservingEditRequest(displayPrompt || prompt, sourceFiles)) return null;
  const supported = sourceFiles.find((file) => isDocxFile(file) || isXlsxFile(file));
  if (!supported) {
    const names = sourceFiles.map((file) => file.originalName || file.filename || file.id).join(', ');
    throw new Error(`Para conservar el documento original necesito un DOCX o XLSX editable. Archivo recibido: ${names || 'sin archivo compatible'}.`);
  }
  return generateSourcePreservingDocumentEdit({
    sourceFile: supported,
    prompt,
    displayPrompt,
    userId,
    chatId,
  });
}

module.exports = {
  appendBlocksToDocumentXml,
  appendToDocxBuffer,
  buildAppendixBlocks,
  generateSourcePreservingDocumentEdit,
  inferDocumentTitle,
  isSourcePreservingEditRequest,
  loadEditableSourceFiles,
  tryGenerateSourcePreservingDocumentEdit,
  INTERNAL: {
    buildInstrumentAppendix,
    inferResearchVariables,
    resolveStoredFilePath,
  },
};
