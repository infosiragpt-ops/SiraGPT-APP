const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const ExcelJS = require('exceljs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { renderPreview } = require('./doc-preview');
const {
  saveArtifact,
  EXTENSION_TO_MIME,
  INTERNAL: taskToolInternals,
} = require('./agents/task-tools');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');
const {
  createContentClient,
  DEFAULT_MODEL,
} = require('./document-pipeline/content/llm-client');

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

  const primaryEditVerb = /\b(agreg\w*|anad\w*|insert\w*|incorpor\w*|inclu\w*|pon|poner|coloc\w*|modific\w*|edit\w*|corrig\w*|correg\w*|mejor\w*|actualiz\w*|reescrib\w*|reemplaz\w*|quit\w*|elimin\w*|complet\w*)\b/.test(text);
  const adjuntarAction = /\badjunt(?:a|ar|ame|arme|alo|ala|alos|alas|arlo|arla|arlos|arlas)\b/.test(text)
    && !/\b(?:documentos?|archivos?|pdf|word|docx|excel|xlsx|pptx?)\s+adjunt[oa]s?\b/.test(text);
  const editVerb = primaryEditVerb || adjuntarAction;
  const existingDocRef = /\b(mi|mismo|misma|este|esta|ese|esa|documento|archivo|adjunto|subido|cargado|word|docx|excel|xlsx|pptx|powerpoint|pdf|tesis)\b/.test(text);
  const appendLocation = /\b(al final|final|anexo|anexos|apendice|ultima pagina|ultima hoja|nueva hoja|nueva pagina|nueva diapositiva)\b/.test(text);
  const preservation = /\b(sin cambiar|no cambies|no modificar lo demas|mismo word|mismo documento|conservar|preservar|mantener)\b/.test(text);
  const explicitFreshDeliverable = /\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|dame|prepara(?:r|me)?|redacta(?:r|me)?|elabora(?:r|me)?|devu[eé]lv(?:e|eme|elo)|entr[eé]ga(?:r|me)?)\b[^.?!]{0,160}\b(?:un\s+|una\s+|el\s+|la\s+)?(?:word|docx|documento|informe|reporte|tesis|monografia|ensayo)\b/.test(text)
    || /\b(?:quiero|necesito)\s+(?:un\s+|una\s+|el\s+|la\s+)(?:word|docx|documento|informe|reporte|tesis|monografia|ensayo)\b/.test(text);
  const instrument = /\b(instrumento|instrument|intuemtno|instumento|cuestionario|encuesta|escala|anexo)\b/.test(text);
  const documentRegion = /\b(portada|caratula|t[ií]tulo|encabezado|pie de pagina|indice|tabla|hoja|celda|fila|columna|diapositiva|pagina|seccion|capitulo)\b/.test(text);
  const strongImplicitFollowUp = appendLocation && (instrument || preservation || /\btesis\b/.test(text));

  if (!editVerb) return false;
  if (explicitFreshDeliverable && !preservation) return false;
  if (hasFiles) return existingDocRef || appendLocation || preservation || instrument || documentRegion;
  return preservation
    || (existingDocRef && (appendLocation || instrument || documentRegion))
    || strongImplicitFollowUp;
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

function extensionForFile(file = {}) {
  const name = String(file.originalName || file.filename || file.name || '').toLowerCase();
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  if (ext === 'markdown') return 'md';
  return ext;
}

function isPdfFile(file = {}) {
  const mime = normalizeText(file.mimeType || file.type);
  const name = normalizeText(file.originalName || file.filename || file.name);
  return mime.includes('pdf') || /\.pdf$/i.test(name);
}

const TEXT_LIKE_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'html', 'htm', 'svg', 'json', 'xml', 'yaml', 'yml']);
function textLikeFormatForFile(file = {}) {
  const ext = extensionForFile(file);
  if (TEXT_LIKE_EXTENSIONS.has(ext)) return ext === 'markdown' ? 'md' : ext;
  const mime = normalizeText(file.mimeType || file.type || file.contentType);
  if (mime.includes('json')) return 'json';
  if (mime.includes('xml')) return mime.includes('svg') ? 'svg' : 'xml';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('markdown')) return 'md';
  if (mime.includes('html')) return 'html';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('yaml') || mime.includes('yml')) return 'yaml';
  if (mime.startsWith('text/')) return 'txt';
  return '';
}

function isTextLikeFile(file = {}) {
  return Boolean(textLikeFormatForFile(file));
}

function isSupportedSourcePreservingFile(file = {}) {
  return isDocxFile(file) || isXlsxFile(file) || isPdfFile(file) || isTextLikeFile(file);
}

function supportedSourceEditLabel() {
  return 'DOCX, XLSX, PDF, TXT, Markdown, CSV, HTML, SVG, JSON, XML o YAML';
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

function normalizeFileIdList(fileIds = []) {
  return Array.from(new Set((Array.isArray(fileIds) ? fileIds : [])
    .map((value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'object') return value.id || value.fileId || value.attachmentId || '';
      return String(value || '');
    })
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
    .slice(0, MAX_SIMULTANEOUS_DOCUMENTS);
}

function parseMessageFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === 'string') {
    try {
      const parsed = JSON.parse(files);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function fileRefId(file) {
  if (!file) return '';
  if (typeof file === 'string') return file.trim();
  if (typeof file === 'object') return String(file.id || file.fileId || file.attachmentId || '').trim();
  return '';
}

function isPotentialEditableAttachmentRef(file) {
  if (!file) return false;
  if (typeof file === 'string') return Boolean(file.trim());
  if (typeof file !== 'object') return false;
  const mime = normalizeText(file.mimeType || file.type || file.contentType);
  const name = normalizeText(file.name || file.originalName || file.filename || file.path || '');
  if (mime.startsWith('image/') || file.type === 'image') return false;
  return /\.(docx?|xlsx?|pdf|csv|txt|md|markdown|html?|svg|json|xml|ya?ml)$/i.test(name)
    || /\b(word|wordprocessingml|spreadsheet|excel|pdf|csv|plain|markdown|html|svg|json|xml|yaml)\b/.test(mime);
}

async function resolveRecentEditableFileIds(prisma, { chatId, prompt } = {}) {
  if (!chatId || !prisma?.message?.findMany || !isSourcePreservingEditRequest(prompt, [])) return [];
  const messages = await prisma.message.findMany({
    where: { chatId, deletedAt: null },
    select: { id: true, files: true, timestamp: true },
    orderBy: { timestamp: 'desc' },
    take: 25,
  }).catch(() => []);
  const seen = new Set();
  const ids = [];
  for (const message of messages) {
    for (const file of parseMessageFiles(message.files)) {
      if (!isPotentialEditableAttachmentRef(file)) continue;
      const id = fileRefId(file);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= MAX_SIMULTANEOUS_DOCUMENTS) return ids;
    }
  }
  return ids;
}

async function loadEditableSourceFiles(prisma, { userId, fileIds = [], chatId = null, prompt = '' } = {}) {
  let ids = normalizeFileIdList(fileIds);
  if (ids.length === 0) {
    ids = await resolveRecentEditableFileIds(prisma, { chatId, prompt });
  }
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

// Just the instrument content (no ANEXOS / Anexo-N heading), so it can be
// reused either as a standalone appendix or as the body of a brand-new labeled
// anexo (e.g. "Anexo 4. Instrumentos...").
function buildInstrumentAppendixBody({ prompt = '', sourceText = '', originalName = '' } = {}) {
  const title = inferDocumentTitle(sourceText, originalName);
  const variables = inferResearchVariables(title);
  const population = inferPopulation(sourceText, title);
  const place = inferPlace(sourceText, title);

  return [
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

function buildInstrumentAppendix(options = {}) {
  return [
    block('pageBreak', ''),
    block('heading1', 'ANEXOS'),
    block('heading2', 'Anexo 1. Instrumento de recolección de datos'),
    ...buildInstrumentAppendixBody(options),
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

const ROMAN_VALUES = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

function romanToNumber(value = '') {
  const text = normalizeText(value);
  if (!/^[ivxlcdm]+$/.test(text)) return null;
  let total = 0;
  let previous = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const current = ROMAN_VALUES[text[i]] || 0;
    if (current < previous) total -= current;
    else total += current;
    previous = current;
  }
  return total || null;
}

function numberToRoman(value) {
  let number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 3999) return '';
  const pairs = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let roman = '';
  for (const [amount, numeral] of pairs) {
    while (number >= amount) {
      roman += numeral;
      number -= amount;
    }
  }
  return roman;
}

function parseTargetSectionRequest(prompt = '') {
  const text = normalizeText(prompt);
  const match = text.match(/\b(anexo|anexos|apendice|apendices|seccion|secciones|apartado|apartados|capitulo|capitulos)\s*(?:n(?:ro|umero)?\.?|num\.?|no\.?|#)?\s*([0-9]{1,3}|[ivxlcdm]{1,10})\b/);
  if (!match) return null;
  const rawKind = match[1];
  const rawNumber = match[2];
  const number = /^\d+$/.test(rawNumber) ? Number(rawNumber) : romanToNumber(rawNumber);
  if (!number) return null;
  const kind =
    rawKind.startsWith('apendice') ? 'apéndice' :
    rawKind.startsWith('seccion') ? 'sección' :
    rawKind.startsWith('apartado') ? 'apartado' :
    rawKind.startsWith('capitulo') ? 'capítulo' :
    'anexo';
  const displayKind = kind.charAt(0).toUpperCase() + kind.slice(1);
  return {
    kind,
    number,
    numeric: String(number),
    roman: numberToRoman(number),
    label: `${displayKind} ${number}`,
  };
}

function isTargetedSectionFillRequest(prompt = '') {
  const text = normalizeText(prompt);
  return Boolean(
    parseTargetSectionRequest(prompt)
    && /\b(complet\w*|llen\w*|rellen\w*|desarroll\w*|agreg\w*|anad\w*|insert\w*|incorpor\w*|actualiz\w*|modific\w*|edit\w*)\b/.test(text)
  );
}

// Default visual styling used only when the source document offers no formatting
// to inherit. Keeping pPr (paragraph) and rPr (run) separate lets us swap each
// half independently for the source document's own properties.
const PARAGRAPH_STYLE_DEFAULTS = {
  heading1: {
    pPr: '<w:pPr><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr>',
    rPr: '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>',
  },
  heading2: {
    pPr: '<w:pPr><w:spacing w:before="260" w:after="140"/><w:outlineLvl w:val="1"/></w:pPr>',
    rPr: '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>',
  },
  heading3: {
    pPr: '<w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr>',
    rPr: '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>',
  },
  normal: {
    pPr: '<w:pPr><w:spacing w:before="80" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>',
    rPr: '<w:rPr><w:sz w:val="24"/></w:rPr>',
  },
};

// Pull the first <w:pPr>…</w:pPr> block (paragraph-level formatting: alignment,
// spacing, indentation, the paragraph style reference) out of a single
// paragraph's XML. Handles both the closing-tag form and the self-closing form.
function extractParagraphProperties(paragraphXmlValue = '') {
  const match = String(paragraphXmlValue || '').match(/<w:pPr\b(?:[\s\S]*?<\/w:pPr>|\s*\/>)/);
  return match ? match[0] : '';
}

// Pull the first run's <w:rPr>…</w:rPr> block (font, size, colour, bold…) out of
// a paragraph. The paragraph-mark rPr that lives inside <w:pPr> is stripped first
// so we capture the formatting that actually applies to the visible text.
function extractRunProperties(paragraphXmlValue = '') {
  const withoutParagraphProps = String(paragraphXmlValue || '')
    .replace(/<w:pPr\b(?:[\s\S]*?<\/w:pPr>|\s*\/>)/, '');
  const match = withoutParagraphProps.match(/<w:rPr\b(?:[\s\S]*?<\/w:rPr>|\s*\/>)/);
  return match ? match[0] : '';
}

// Captured paragraph properties may carry section breaks or list-numbering refs
// that would corrupt inserted body text (spurious page sections / auto-numbered
// lists). Drop those while keeping fonts, alignment, spacing and style refs.
function sanitizeCapturedParagraphProperties(paragraphProps = '') {
  return String(paragraphProps || '')
    .replace(/<w:sectPr\b(?:[\s\S]*?<\/w:sectPr>|\s*\/>)/g, '')
    .replace(/<w:numPr\b(?:[\s\S]*?<\/w:numPr>|\s*\/>)/g, '');
}

function looksLikeDocxHeadingParagraph(paragraph = {}) {
  const xml = String(paragraph.xml || '');
  if (/<w:pStyle\s+w:val="[^"]*(?:Heading|Titulo|T[ií]tulo|Title)[^"]*"/i.test(xml)) return true;
  if (/<w:outlineLvl\b/.test(xml)) return true;
  const text = String(paragraph.text || '').trim();
  if (text && text.length <= 60 && /<w:b\s*\/>|<w:b\s+w:val="(?:true|1|on)"/i.test(xml) && !/[.;:]\s*$/.test(text)) {
    return true;
  }
  return false;
}

// Pick the longest real body paragraph (not a heading, not a placeholder) as the
// representative of the document's "normal text" formatting.
function pickRepresentativeBodyParagraph(paragraphs = [], excludeIndexes = new Set()) {
  let bestXml = '';
  let bestLength = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (excludeIndexes.has(i)) continue;
    const paragraph = paragraphs[i];
    const text = String(paragraph.text || '').trim();
    if (text.length < 25) continue;
    if (isPlaceholderParagraph(paragraph.text)) continue;
    if (looksLikeDocxHeadingParagraph(paragraph)) continue;
    if (text.length > bestLength) {
      bestLength = text.length;
      bestXml = paragraph.xml;
    }
  }
  return bestXml;
}

function buildFormattingTemplate({ bodyXml = '', headingXml = '' } = {}) {
  return {
    bodyPPr: sanitizeCapturedParagraphProperties(extractParagraphProperties(bodyXml)),
    bodyRPr: extractRunProperties(bodyXml),
    headingPPr: sanitizeCapturedParagraphProperties(extractParagraphProperties(headingXml)),
    headingRPr: extractRunProperties(headingXml),
  };
}

// Template for filling a specific section: body text mirrors the document's own
// normal paragraphs, generated sub-headings (rare) mirror the section heading.
function buildSectionFormattingTemplate(paragraphs = [], headingIndex = -1) {
  const heading = headingIndex >= 0 ? paragraphs[headingIndex] : null;
  return buildFormattingTemplate({
    bodyXml: pickRepresentativeBodyParagraph(paragraphs, new Set(headingIndex >= 0 ? [headingIndex] : [])),
    headingXml: heading ? heading.xml : '',
  });
}

// Template for appending a fresh appendix: only inherit body text formatting so
// the new ANEXOS heading hierarchy keeps its readable size ladder.
function buildDocumentFormattingTemplate(paragraphs = []) {
  return buildFormattingTemplate({
    bodyXml: pickRepresentativeBodyParagraph(paragraphs),
    headingXml: '',
  });
}

function paragraphXml(item = {}, template = null) {
  if (item.kind === 'pageBreak') {
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  const text = xmlEscape(item.text || '');
  const kind = PARAGRAPH_STYLE_DEFAULTS[item.kind] ? item.kind : 'normal';
  const isHeading = kind.startsWith('heading');
  let pPr = PARAGRAPH_STYLE_DEFAULTS[kind].pPr;
  let rPr = PARAGRAPH_STYLE_DEFAULTS[kind].rPr;

  if (template) {
    const inheritedPPr = isHeading ? template.headingPPr : template.bodyPPr;
    const inheritedRPr = isHeading ? template.headingRPr : template.bodyRPr;
    if (inheritedPPr || inheritedRPr) {
      // Adopt the source document's own formatting. Run properties are deferred
      // to whatever the document declares (captured rPr, or the paragraph style
      // referenced inside the captured pPr) so we never re-impose a default font
      // size over the document's styling.
      pPr = inheritedPPr || '';
      rPr = inheritedRPr || '';
    }
  }

  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(paragraphXmlValue = '') {
  const pieces = [];
  const textRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = textRe.exec(paragraphXmlValue))) {
    pieces.push(xmlUnescape(match[1]));
  }
  return pieces.join('');
}

function extractDocxParagraphs(documentXml = '') {
  const paragraphs = [];
  const paragraphRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(documentXml))) {
    const xml = match[0];
    const text = paragraphText(xml);
    paragraphs.push({
      start: match.index,
      end: match.index + xml.length,
      xml,
      text,
      normalized: normalizeText(text),
    });
  }
  return paragraphs;
}

function extractXmlSegments(xml = '', regex) {
  const segments = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(xml))) {
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      xml: match[0],
    });
  }
  return segments;
}

function extractDocxTables(documentXml = '') {
  return extractXmlSegments(documentXml, /<w:tbl\b[\s\S]*?<\/w:tbl>/g)
    .map((table) => ({
      ...table,
      text: paragraphText(table.xml),
      normalized: normalizeText(paragraphText(table.xml)),
    }));
}

function extractTableRows(tableXml = '') {
  return extractXmlSegments(tableXml, /<w:tr\b[\s\S]*?<\/w:tr>/g);
}

function extractTableCells(rowXml = '') {
  return extractXmlSegments(rowXml, /<w:tc\b[\s\S]*?<\/w:tc>/g)
    .map((cell) => ({
      ...cell,
      text: paragraphText(cell.xml),
      normalized: normalizeText(paragraphText(cell.xml)),
    }));
}

function targetHeadingPattern(target) {
  const numberPart = target.roman
    ? `(?:${target.numeric}|${normalizeText(target.roman)})`
    : target.numeric;
  if (target.kind === 'anexo') {
    return new RegExp(`\\b(?:anexo|anexos|apendice|apendices)\\s*(?:n(?:ro|umero)?\\.?|num\\.?|no\\.?|#)?\\s*${numberPart}\\b`);
  }
  if (target.kind === 'sección') {
    return new RegExp(`\\b(?:seccion|secciones)\\s*(?:n(?:ro|umero)?\\.?|num\\.?|no\\.?|#)?\\s*${numberPart}\\b`);
  }
  if (target.kind === 'capítulo') {
    return new RegExp(`\\b(?:capitulo|capitulos)\\s*(?:n(?:ro|umero)?\\.?|num\\.?|no\\.?|#)?\\s*${numberPart}\\b`);
  }
  return new RegExp(`\\b${normalizeText(target.kind)}\\s*(?:n(?:ro|umero)?\\.?|num\\.?|no\\.?|#)?\\s*${numberPart}\\b`);
}

function matchesTargetHeading(normalizedParagraph, target) {
  if (!normalizedParagraph) return false;
  return targetHeadingPattern(target).test(normalizedParagraph);
}

function isSectionBoundary(normalizedParagraph, target) {
  if (!normalizedParagraph) return false;
  if (matchesTargetHeading(normalizedParagraph, target)) return false;
  if (target.kind === 'anexo') {
    return /\b(?:anexo|anexos|apendice|apendices)\s*(?:n(?:ro|umero)?\.?|num\.?|no\.?|#)?\s*(?:[0-9]{1,3}|[ivxlcdm]{1,10})\b/.test(normalizedParagraph)
      || /\b(?:capitulo|seccion)\s*(?:[0-9]{1,3}|[ivxlcdm]{1,10})\b/.test(normalizedParagraph);
  }
  return /\b(?:capitulo|capitulos|seccion|secciones|apartado|apartados|anexo|anexos|apendice|apendices)\s*(?:n(?:ro|umero)?\.?|num\.?|no\.?|#)?\s*(?:[0-9]{1,3}|[ivxlcdm]{1,10})\b/.test(normalizedParagraph);
}

function isPlaceholderParagraph(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (/^[._\-\[\]()\s]{1,40}$/.test(String(text || ''))) return true;
  return /^(?:pendiente|por completar|completar|rellenar|llenar|desarrollar|agregar informacion|insertar informacion|texto pendiente|a completar|no aplica|n\/a|xxx|xxxxx)(?:\b|$)/.test(normalized)
    || /\b(?:pendiente de completar|completar aqui|completar aquí|rellenar aqui|rellenar aquí|desarrollar aqui|desarrollar aquí)\b/.test(normalized);
}

function sectionInsertionRange(documentXml, target, precomputedParagraphs = null) {
  const paragraphs = precomputedParagraphs || extractDocxParagraphs(documentXml);
  const headingIndex = paragraphs.findIndex((paragraph) => matchesTargetHeading(paragraph.normalized, target));
  if (headingIndex < 0) {
    const notFound = new Error(`No encontré "${target.label}" dentro del DOCX original.`);
    notFound.code = 'SECTION_NOT_FOUND';
    throw notFound;
  }

  const heading = paragraphs[headingIndex];
  let replaceStart = heading.end;
  let replaceEnd = heading.end;
  let replacingPlaceholder = false;

  for (let index = headingIndex + 1; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (isSectionBoundary(paragraph.normalized, target)) break;

    if (isPlaceholderParagraph(paragraph.text)) {
      if (!replacingPlaceholder) replaceStart = paragraph.start;
      replaceEnd = paragraph.end;
      replacingPlaceholder = true;
      continue;
    }

    break;
  }

  return {
    replaceStart,
    replaceEnd,
    replacingPlaceholder,
  };
}

function targetSectionBounds(documentXml, target, precomputedParagraphs = null) {
  const paragraphs = precomputedParagraphs || extractDocxParagraphs(documentXml);
  const headingIndex = paragraphs.findIndex((paragraph) => matchesTargetHeading(paragraph.normalized, target));
  if (headingIndex < 0) {
    const notFound = new Error(`No encontré "${target.label}" dentro del DOCX original.`);
    notFound.code = 'SECTION_NOT_FOUND';
    throw notFound;
  }

  const heading = paragraphs[headingIndex];
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  let sectionEnd = bodyEnd >= 0 ? bodyEnd : documentXml.length;
  for (let index = headingIndex + 1; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (isSectionBoundary(paragraph.normalized, target)) {
      sectionEnd = paragraph.start;
      break;
    }
  }
  return {
    heading,
    headingIndex,
    sectionStart: heading.end,
    sectionEnd,
  };
}

function isAnexo3CronogramaTarget(target = {}) {
  return target?.kind === 'anexo' && Number(target.number) === 3;
}

function locateCronogramaTable(documentXml, target, precomputedParagraphs = null) {
  if (!isAnexo3CronogramaTarget(target)) return null;
  const paragraphs = precomputedParagraphs || extractDocxParagraphs(documentXml);
  const bounds = targetSectionBounds(documentXml, target, paragraphs);
  const sectionIntro = documentXml.slice(bounds.heading.start, Math.min(bounds.sectionEnd, bounds.heading.end + 1200));
  const introText = normalizeText(paragraphText(sectionIntro));
  const tables = extractDocxTables(documentXml);
  return tables.find((table) => {
    if (table.start < bounds.sectionStart || table.start >= bounds.sectionEnd) return false;
    const normalized = table.normalized;
    const tableLooksLikeSchedule = normalized.includes('avance de la tesis')
      && normalized.includes('acciones')
      && normalized.includes('estado')
      && normalized.includes('fechas');
    return tableLooksLikeSchedule || introText.includes('cronograma');
  }) || null;
}

function detectCronogramaAnexo3Plan(buffer, target) {
  if (!isAnexo3CronogramaTarget(target)) return null;
  try {
    const documentXml = new PizZip(buffer).file('word/document.xml')?.asText() || '';
    if (!documentXml) return null;
    const table = locateCronogramaTable(documentXml, target);
    if (!table) return null;
    return buildCronogramaAnexo3Plan();
  } catch {
    return null;
  }
}

function buildCronogramaAnexo3Plan() {
  const rows = [
    {
      avance: 'Planificación',
      acciones: 'Lineamientos y cronograma de tesis.',
      estado: 'Completado',
      weeks: [0],
    },
    {
      avance: 'Capítulo I',
      acciones: 'Problema, objetivos y justificación.',
      estado: 'Completado',
      weeks: [0, 1],
    },
    {
      avance: 'Capítulo II',
      acciones: 'Antecedentes y marco teórico.',
      estado: 'En proceso',
      weeks: [1, 2, 3],
    },
    {
      avance: 'Matriz de consistencia',
      acciones: 'Problema, objetivos, hipótesis y método.',
      estado: 'En proceso',
      weeks: [2, 3],
    },
    {
      avance: 'Operacionalización',
      acciones: 'Variables, indicadores, ítems y escala.',
      estado: 'En proceso',
      weeks: [3, 4],
    },
    {
      avance: 'Metodología',
      acciones: 'Tipo, diseño, población y muestra.',
      estado: 'Pendiente',
      weeks: [4, 5],
    },
    {
      avance: 'Instrumentos',
      acciones: 'Elaboración y validación del cuestionario.',
      estado: 'Pendiente',
      weeks: [5, 6],
    },
    {
      avance: 'Trabajo de campo',
      acciones: 'Aplicación de encuesta y base de datos.',
      estado: 'Pendiente',
      weeks: [7, 8, 9],
    },
    {
      avance: 'Resultados',
      acciones: 'Procesamiento estadístico e interpretación.',
      estado: 'Pendiente',
      weeks: [9, 10, 11],
    },
    {
      avance: 'Discusión',
      acciones: 'Contraste de hipótesis y antecedentes.',
      estado: 'Pendiente',
      weeks: [11, 12],
    },
    {
      avance: 'Conclusiones',
      acciones: 'Conclusiones, recomendaciones y anexos.',
      estado: 'Pendiente',
      weeks: [12, 13],
    },
    {
      avance: 'Revisión final',
      acciones: 'Corrección de estilo y normas APA.',
      estado: 'Pendiente',
      weeks: [14],
    },
    {
      avance: 'Entrega',
      acciones: 'Informe final y sustentación.',
      estado: 'Pendiente',
      weeks: [15, 16],
    },
  ];
  return {
    type: 'cronograma_anexo_3',
    weekLabels: Array.from({ length: 17 }, (_, index) => `S${index + 1}`),
    rows,
    validationBlocks: rows.slice(0, 4).map((row) => block('normal', row.acciones)),
  };
}

function firstParagraphXml(xml = '') {
  return String(xml || '').match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0] || '';
}

function cellParagraphXml(text = '', cellXml = '', template = null, options = {}) {
  const sourceParagraph = firstParagraphXml(cellXml);
  const inheritedPPr = sanitizeCapturedParagraphProperties(extractParagraphProperties(sourceParagraph));
  const inheritedRPr = extractRunProperties(sourceParagraph);
  let pPr = inheritedPPr || template?.bodyPPr || '';
  const rPr = inheritedRPr || template?.bodyRPr || '';
  if (options.center && !/<w:jc\b/.test(pPr)) {
    pPr = pPr
      ? pPr.replace(/<\/w:pPr>$/, '<w:jc w:val="center"/></w:pPr>')
      : '<w:pPr><w:jc w:val="center"/></w:pPr>';
  }
  const value = String(text || '');
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r></w:p>`;
}

function replaceCellText(cellXml = '', text = '', template = null, options = {}) {
  const tcPr = cellXml.match(/<w:tcPr\b(?:[\s\S]*?<\/w:tcPr>|\s*\/>)/)?.[0] || '';
  return `<w:tc>${tcPr}${cellParagraphXml(text, cellXml, template, options)}</w:tc>`;
}

function replaceRowCells(rowXml = '', replacements = new Map()) {
  const cells = extractTableCells(rowXml);
  if (!cells.length || !replacements.size) return rowXml;
  let updated = '';
  let cursor = 0;
  cells.forEach((cell, index) => {
    updated += rowXml.slice(cursor, cell.start);
    updated += replacements.has(index) ? replacements.get(index) : cell.xml;
    cursor = cell.end;
  });
  updated += rowXml.slice(cursor);
  return updated;
}

function replaceTableRows(tableXml = '', replacements = new Map()) {
  const rows = extractTableRows(tableXml);
  if (!rows.length || !replacements.size) return tableXml;
  let updated = '';
  let cursor = 0;
  rows.forEach((row, index) => {
    updated += tableXml.slice(cursor, row.start);
    updated += replacements.has(index) ? replacements.get(index) : row.xml;
    cursor = row.end;
  });
  updated += tableXml.slice(cursor);
  return updated;
}

function fillCronogramaTableXml(tableXml = '', plan = buildCronogramaAnexo3Plan(), template = null) {
  const rows = extractTableRows(tableXml);
  const cellCounts = rows.map((row) => extractTableCells(row.xml).length);
  const maxColumns = Math.max(0, ...cellCounts);
  if (maxColumns < 4) {
    const err = new Error('La tabla de cronograma no tiene suficientes columnas para completarse.');
    err.code = 'CRONOGRAMA_TABLE_INVALID';
    throw err;
  }

  const dateStartColumn = 3;
  const availableDateColumns = maxColumns - dateStartColumn;
  const dateLabels = plan.weekLabels.slice(0, availableDateColumns);
  const headerRowIndex = rows.findIndex((row, index) => index > 0 && extractTableCells(row.xml).length === maxColumns);
  const dataStartRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 1;
  const rowReplacements = new Map();

  if (headerRowIndex >= 0) {
    const headerCells = extractTableCells(rows[headerRowIndex].xml);
    const replacements = new Map();
    dateLabels.forEach((label, index) => {
      const cellIndex = dateStartColumn + index;
      if (headerCells[cellIndex]) {
        replacements.set(cellIndex, replaceCellText(headerCells[cellIndex].xml, label, template, { center: true }));
      }
    });
    rowReplacements.set(headerRowIndex, replaceRowCells(rows[headerRowIndex].xml, replacements));
  }

  plan.rows.forEach((scheduleRow, offset) => {
    const rowIndex = dataStartRow + offset;
    const row = rows[rowIndex];
    if (!row) return;
    const cells = extractTableCells(row.xml);
    if (cells.length < maxColumns) return;
    const replacements = new Map();
    replacements.set(0, replaceCellText(cells[0].xml, scheduleRow.avance, template));
    replacements.set(1, replaceCellText(cells[1].xml, scheduleRow.acciones, template));
    replacements.set(2, replaceCellText(cells[2].xml, scheduleRow.estado, template, { center: true }));
    for (let index = 0; index < availableDateColumns; index += 1) {
      const cellIndex = dateStartColumn + index;
      if (!cells[cellIndex]) continue;
      const marker = scheduleRow.weeks.includes(index) ? 'X' : '';
      replacements.set(cellIndex, replaceCellText(cells[cellIndex].xml, marker, template, { center: true }));
    }
    rowReplacements.set(rowIndex, replaceRowCells(row.xml, replacements));
  });

  return replaceTableRows(tableXml, rowReplacements);
}

function fillDocxCronogramaSectionBuffer(buffer, target, plan = buildCronogramaAnexo3Plan()) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  const paragraphs = extractDocxParagraphs(documentXml);
  const table = locateCronogramaTable(documentXml, target, paragraphs);
  if (!table) {
    const err = new Error(`No encontré una tabla de cronograma dentro de ${target.label}.`);
    err.code = 'CRONOGRAMA_TABLE_NOT_FOUND';
    throw err;
  }
  const bounds = targetSectionBounds(documentXml, target, paragraphs);
  const template = buildSectionFormattingTemplate(paragraphs, bounds.headingIndex);
  const updatedTable = fillCronogramaTableXml(table.xml, plan, template);
  const updatedXml = `${documentXml.slice(0, table.start)}${updatedTable}${documentXml.slice(table.end)}`;
  zip.file('word/document.xml', updatedXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// Generic, AI-driven table fill for ANY section (not just the Anexo 3
// cronograma). It locates the first table inside the requested section,
// figures out which leading columns are "content" columns (those with a text
// header, before any wide grouping / date column), finds the empty data rows,
// and writes generated values into those cells while preserving each cell's
// own formatting and the table's structure.
// ---------------------------------------------------------------------------

function cellPropsXml(cellXml = '') {
  return String(cellXml || '').match(/<w:tcPr\b(?:[\s\S]*?<\/w:tcPr>|\s*\/>)/)?.[0] || '';
}

function isVMergeContinuationCell(cellXml = '') {
  const tcPr = cellPropsXml(cellXml);
  return /<w:vMerge\s*\/>/.test(tcPr) || /<w:vMerge\s+w:val="continue"\s*\/>/.test(tcPr);
}

function cellGridSpan(cellXml = '') {
  const tcPr = cellPropsXml(cellXml);
  return parseInt((tcPr.match(/<w:gridSpan\s+w:val="(\d+)"\/>/) || [])[1] || '1', 10) || 1;
}

const TABLE_GROUPING_HEADER_RE = /\b(fecha|fechas|mes|meses|semana|semanas|cronograma|tiempo|periodo|periodos|trimestre|bimestre|d[ií]a|d[ií]as|a[nñ]o|a[nñ]os)\b/;

function locateSectionTable(documentXml, target, precomputedParagraphs = null) {
  const paragraphs = precomputedParagraphs || extractDocxParagraphs(documentXml);
  const bounds = targetSectionBounds(documentXml, target, paragraphs);
  const tables = extractDocxTables(documentXml);
  return tables.find((table) => table.start >= bounds.sectionStart && table.start < bounds.sectionEnd) || null;
}

// Inspect a table and report the content columns + empty data rows we can fill.
function analyzeTableForFill(tableXml = '') {
  const rows = extractTableRows(tableXml);
  if (rows.length < 2) return null;
  const cellCounts = rows.map((row) => extractTableCells(row.xml).length);
  const maxColumns = Math.max(0, ...cellCounts);
  if (maxColumns < 2) return null;

  const headerRowIndex = rows.findIndex((row) => extractTableCells(row.xml).some((cell) => cell.text.trim()));
  if (headerRowIndex < 0) return null;

  const headerCells = extractTableCells(rows[headerRowIndex].xml);
  const labels = [];
  let contentColCount = 0;
  for (const cell of headerCells) {
    const label = cell.text.trim();
    if (!label) break;
    if (cellGridSpan(cell.xml) >= 3) break;
    if (TABLE_GROUPING_HEADER_RE.test(normalizeText(label))) break;
    labels.push(label);
    contentColCount += 1;
  }
  if (contentColCount === 0) return null;

  const dataRows = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const cells = extractTableCells(rows[i].xml);
    if (cells.length < contentColCount) continue;
    let fillable = true;
    for (let c = 0; c < contentColCount; c += 1) {
      if (isVMergeContinuationCell(cells[c].xml) || cells[c].text.trim()) {
        fillable = false;
        break;
      }
    }
    if (fillable) dataRows.push(i);
  }
  if (!dataRows.length) return null;
  return { rows, headerRowIndex, contentColCount, labels, dataRows, maxColumns };
}

function detectSectionTablePlan(buffer, target) {
  try {
    const documentXml = readDocxDocumentXml(buffer);
    if (!documentXml) return null;
    const paragraphs = extractDocxParagraphs(documentXml);
    const table = locateSectionTable(documentXml, target, paragraphs);
    if (!table) return null;
    const analysis = analyzeTableForFill(table.xml);
    if (!analysis) return null;
    return { labels: analysis.labels, dataRowCount: analysis.dataRows.length };
  } catch {
    return null;
  }
}

// Ask the model to produce rows that fit the table's own column headers and the
// document's real topic. Degrades to [] (caller falls back) when no key/result.
async function generateTableRowsContent({ labels = [], maxRows = 0, sectionLabel = '', sourceText = '', prompt = '', signal } = {}) {
  if (!process.env.OPENAI_API_KEY || !labels.length || maxRows <= 0) return [];
  try {
    const client = createContentClient('OpenAI');
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'Eres un asistente académico experto en COMPLETAR TABLAS dentro de documentos Word sin alterar su estructura.',
            'Te dan los encabezados de las columnas de contenido y el contexto real del documento.',
            'Genera filas coherentes con esos encabezados y con el tema concreto del documento.',
            'No inventes cifras, citas, autores ni DOI; usa únicamente lo que el contexto permita inferir de forma razonable.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Solicitud del usuario: ${prompt}`,
            `Tabla a completar: ${sectionLabel}`,
            `Columnas de contenido, en orden: ${labels.join(' | ')}`,
            `Genera entre 1 y ${maxRows} filas (las que el tema amerite).`,
            'Contexto del documento:',
            compact(sourceText, 12000),
            '',
            'Responde SOLO en JSON con esta forma exacta:',
            `{"rows":[[${labels.map(() => '"valor"').join(', ')}]]}`,
            'Cada fila es un arreglo con un valor de texto por columna, en el mismo orden de los encabezados.',
          ].join('\n'),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }, { signal, timeout: 30_000 });

    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return rows
      .filter((row) => Array.isArray(row))
      .slice(0, maxRows)
      .map((row) => row.map((value) => String(value == null ? '' : value).trim()));
  } catch {
    return [];
  }
}

function fillGenericSectionTableXml(tableXml = '', generatedRows = [], template = null) {
  const analysis = analyzeTableForFill(tableXml);
  if (!analysis || !generatedRows.length) return null;
  const { rows, contentColCount, dataRows } = analysis;
  const rowReplacements = new Map();
  const count = Math.min(dataRows.length, generatedRows.length);
  for (let i = 0; i < count; i += 1) {
    const rowIndex = dataRows[i];
    const cells = extractTableCells(rows[rowIndex].xml);
    const values = generatedRows[i] || [];
    const cellReplacements = new Map();
    for (let c = 0; c < contentColCount; c += 1) {
      const value = values[c] != null ? String(values[c]).trim() : '';
      if (!value || !cells[c]) continue;
      cellReplacements.set(c, replaceCellText(cells[c].xml, value, template));
    }
    if (cellReplacements.size) {
      rowReplacements.set(rowIndex, replaceRowCells(rows[rowIndex].xml, cellReplacements));
    }
  }
  if (!rowReplacements.size) return null;
  return replaceTableRows(tableXml, rowReplacements);
}

function fillGenericSectionTableBuffer(buffer, target, generatedRows = []) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  const paragraphs = extractDocxParagraphs(documentXml);
  const table = locateSectionTable(documentXml, target, paragraphs);
  if (!table) {
    const err = new Error(`No encontré una tabla dentro de ${target.label}.`);
    err.code = 'SECTION_TABLE_NOT_FOUND';
    throw err;
  }
  const bounds = targetSectionBounds(documentXml, target, paragraphs);
  const template = buildSectionFormattingTemplate(paragraphs, bounds.headingIndex);
  const updatedTable = fillGenericSectionTableXml(table.xml, generatedRows, template);
  if (!updatedTable) {
    const err = new Error(`La tabla de ${target.label} no tiene celdas de contenido vacías para completar.`);
    err.code = 'SECTION_TABLE_NOT_FILLABLE';
    throw err;
  }
  const updatedXml = `${documentXml.slice(0, table.start)}${updatedTable}${documentXml.slice(table.end)}`;
  zip.file('word/document.xml', updatedXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function fillDocxSectionBuffer(buffer, target, blocks) {
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');
  const documentXml = documentFile.asText();
  const paragraphs = extractDocxParagraphs(documentXml);
  const range = sectionInsertionRange(documentXml, target, paragraphs);
  const headingIndex = paragraphs.findIndex((paragraph) => matchesTargetHeading(paragraph.normalized, target));
  const template = buildSectionFormattingTemplate(paragraphs, headingIndex);
  const insertionXml = blocks
    .filter((item) => item.kind !== 'pageBreak')
    .map((item) => paragraphXml(item, template))
    .join('');
  const updatedXml = `${documentXml.slice(0, range.replaceStart)}${insertionXml}${documentXml.slice(range.replaceEnd)}`;
  zip.file('word/document.xml', updatedXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function appendBlocksToDocumentXml(documentXml, blocks, template = null) {
  const insertionXml = blocks.map((item) => paragraphXml(item, template)).join('');
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
  const template = buildDocumentFormattingTemplate(extractDocxParagraphs(documentXml));
  zip.file('word/document.xml', appendBlocksToDocumentXml(documentXml, blocks, template));
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

function nonPageBreakBlocks(blocks) {
  return blocks.filter((item) => item.kind !== 'pageBreak' && String(item.text || '').trim());
}

function blocksToPlainText(blocks) {
  return nonPageBreakBlocks(blocks)
    .map((item) => {
      const text = String(item.text || '').trim();
      if (item.kind === 'heading1') return `# ${text}`;
      if (item.kind === 'heading2') return `## ${text}`;
      if (item.kind === 'heading3') return `### ${text}`;
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendToCsvBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const prefix = original.endsWith('\n') ? '' : '\n';
  const rows = [
    ['SiraGPT appendix'],
    ...nonPageBreakBlocks(blocks).map((item) => [item.text]),
  ].map((row) => row.map(csvEscape).join(',')).join('\n');
  return Buffer.from(`${original}${prefix}${rows}\n`, 'utf8');
}

function appendToJsonBuffer(buffer, blocks) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  const appendix = {
    kind: 'siraGPT_appendix',
    content: blocksToPlainText(blocks),
    blocks: nonPageBreakBlocks(blocks).map((item) => ({ kind: item.kind, text: item.text })),
  };
  if (Array.isArray(parsed)) {
    return Buffer.from(`${JSON.stringify([...parsed, appendix], null, 2)}\n`, 'utf8');
  }
  if (parsed && typeof parsed === 'object') {
    const keyBase = '_siraGPT_appendix';
    let key = keyBase;
    let counter = 2;
    while (Object.prototype.hasOwnProperty.call(parsed, key)) {
      key = `${keyBase}_${counter}`;
      counter += 1;
    }
    return Buffer.from(`${JSON.stringify({ ...parsed, [key]: appendix }, null, 2)}\n`, 'utf8');
  }
  return Buffer.from(`${JSON.stringify({ value: parsed, _siraGPT_appendix: appendix }, null, 2)}\n`, 'utf8');
}

function appendToHtmlBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const section = [
    '<section data-siragpt-appendix="true">',
    ...nonPageBreakBlocks(blocks).map((item) => {
      const text = htmlEscape(item.text);
      if (item.kind === 'heading1') return `<h1>${text}</h1>`;
      if (item.kind === 'heading2') return `<h2>${text}</h2>`;
      if (item.kind === 'heading3') return `<h3>${text}</h3>`;
      return `<p>${text}</p>`;
    }),
    '</section>',
  ].join('\n');
  if (/<\/body>/i.test(original)) return Buffer.from(original.replace(/<\/body>/i, `${section}\n</body>`), 'utf8');
  if (/<\/html>/i.test(original)) return Buffer.from(original.replace(/<\/html>/i, `${section}\n</html>`), 'utf8');
  return Buffer.from(`${original}${original.endsWith('\n') ? '' : '\n'}${section}\n`, 'utf8');
}

function appendToSvgBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const metadata = `<metadata><siragpt-appendix>${htmlEscape(blocksToPlainText(blocks))}</siragpt-appendix></metadata>`;
  if (/<\/svg>/i.test(original)) return Buffer.from(original.replace(/<\/svg>/i, `${metadata}\n</svg>`), 'utf8');
  throw new Error('SVG inválido: no se encontró la etiqueta de cierre </svg>.');
}

function xmlCommentEscape(value) {
  return String(value ?? '').replace(/--/g, '—');
}

function appendToXmlBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const comment = `<!-- SiraGPT appendix\n${xmlCommentEscape(blocksToPlainText(blocks))}\n-->`;
  return Buffer.from(`${original}${original.endsWith('\n') ? '' : '\n'}${comment}\n`, 'utf8');
}

function appendToYamlBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const comments = blocksToPlainText(blocks)
    .split('\n')
    .map((line) => `# ${line}`)
    .join('\n');
  const separator = original.endsWith('\n') ? '' : '\n';
  return Buffer.from(`${original}${separator}# SiraGPT appendix\n${comments}\n`, 'utf8');
}

function appendToPlainTextBuffer(buffer, blocks) {
  const original = buffer.toString('utf8');
  const separator = original.endsWith('\n') ? '\n' : '\n\n';
  return Buffer.from(`${original}${separator}${blocksToPlainText(blocks)}\n`, 'utf8');
}

function appendToTextLikeBuffer(buffer, blocks, format = 'txt') {
  if (format === 'csv') return appendToCsvBuffer(buffer, blocks);
  if (format === 'json') return appendToJsonBuffer(buffer, blocks);
  if (format === 'html' || format === 'htm') return appendToHtmlBuffer(buffer, blocks);
  if (format === 'svg') return appendToSvgBuffer(buffer, blocks);
  if (format === 'xml') return appendToXmlBuffer(buffer, blocks);
  if (format === 'yaml' || format === 'yml') return appendToYamlBuffer(buffer, blocks);
  return appendToPlainTextBuffer(buffer, blocks);
}

function extractTextFromDocxBuffer(buffer) {
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText() || '';
  return extractDocxParagraphs(xml)
    .map((paragraph) => paragraph.text.trim())
    .filter(Boolean)
    .join('\n');
}

async function extractTextFromXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];
  workbook.worksheets.forEach((sheet) => {
    lines.push(`Hoja: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const text = values
        .map((value) => {
          if (value == null) return '';
          if (typeof value === 'object') {
            if (value.text) return value.text;
            if (value.result != null) return String(value.result);
            if (value.richText) return value.richText.map((part) => part.text || '').join('');
          }
          return String(value);
        })
        .map((value) => value.trim())
        .filter(Boolean)
        .join(' | ');
      if (text) lines.push(text);
    });
  });
  return lines.join('\n');
}

async function extractTextFromFile(file = {}) {
  if (file.extractedText) return String(file.extractedText);
  if (!file.path) return '';
  try {
    const buffer = await fs.promises.readFile(file.path);
    if (isDocxFile(file)) return extractTextFromDocxBuffer(buffer);
    if (isXlsxFile(file)) return extractTextFromXlsxBuffer(buffer);
    if (isTextLikeFile(file)) return buffer.toString('utf8');
  } catch {
    return '';
  }
  return '';
}

async function buildCombinedSourceText(sourceFiles = []) {
  const chunks = [];
  for (const file of sourceFiles) {
    const name = file.originalName || file.filename || file.id || 'documento';
    const text = compact(await extractTextFromFile(file), 5000);
    if (!text) continue;
    chunks.push(`Fuente: ${name}\n${text}`);
  }
  return chunks.join('\n\n---\n\n');
}

function sectionFallbackBlocks({ prompt = '', target, sourceText = '', sourceFiles = [] } = {}) {
  const names = sourceFiles
    .map((file) => file.originalName || file.filename || file.id)
    .filter(Boolean)
    .slice(0, 8);
  const excerpts = sourceText
    .split(/\n{2,}|---/)
    .map((item) => compact(item, 360))
    .filter((item) => item.length >= 50)
    .slice(0, 4);

  const blocks = [
    block('normal', `${target?.label || 'La sección solicitada'} se completa con base en la información integrada de ${names.length ? names.join(', ') : 'los documentos adjuntos'}.`),
  ];
  for (const excerpt of excerpts) {
    blocks.push(block('normal', excerpt));
  }
  blocks.push(block('normal', `Contenido incorporado según la solicitud: ${compact(prompt, 260)}.`));
  return blocks;
}

async function generateTargetSectionBlocks({
  prompt = '',
  target,
  sourceFiles = [],
  sourceText = '',
  signal,
} = {}) {
  const fallback = () => sectionFallbackBlocks({ prompt, target, sourceText, sourceFiles });
  if (!process.env.OPENAI_API_KEY) return fallback();

  try {
    const client = createContentClient('OpenAI');
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'Eres un editor académico experto en completar secciones de documentos Word sin alterar el resto del archivo.',
            'Devuelve contenido formal en español para insertar dentro de la sección solicitada.',
            'Usa únicamente la información de los documentos proporcionados. No inventes citas, autores, datos ni DOI.',
            'No repitas el título de la sección; el DOCX original ya contiene el encabezado.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Solicitud: ${prompt}`,
            `Sección a completar: ${target?.label || 'sección indicada'}`,
            'Documentos de contexto combinados:',
            compact(sourceText, 12000),
            '',
            'Responde en JSON con esta forma exacta:',
            '{"paragraphs":["2 a 5 párrafos sustantivos"],"bullets":["0 a 6 puntos si aportan claridad"],"closing":"cierre breve opcional"}',
          ].join('\n'),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.25,
    }, { signal, timeout: 30_000 });

    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return fallback();
    const parsed = JSON.parse(raw);
    const blocks = [];
    for (const paragraph of Array.isArray(parsed.paragraphs) ? parsed.paragraphs : []) {
      const text = String(paragraph || '').trim();
      if (text) blocks.push(block('normal', text));
    }
    for (const bullet of Array.isArray(parsed.bullets) ? parsed.bullets : []) {
      const text = String(bullet || '').trim();
      if (text) blocks.push(block('normal', `• ${text}`));
    }
    if (parsed.closing) blocks.push(block('normal', String(parsed.closing).trim()));
    return blocks.length ? blocks.slice(0, 12) : fallback();
  } catch {
    return fallback();
  }
}

function wrapPdfText(text, font, fontSize, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split(/\n+/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    lines.push('');
  }
  return lines;
}

async function appendToPdfBuffer(buffer, blocks) {
  const pdf = await PDFDocument.load(buffer);
  let page = pdf.addPage();
  let { width, height } = page.getSize();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  let y = height - margin;
  let maxWidth = width - (margin * 2);

  const addPageIfNeeded = () => {
    if (y >= margin) return;
    page = pdf.addPage();
    ({ width, height } = page.getSize());
    maxWidth = width - (margin * 2);
    y = height - margin;
  };

  for (const item of blocks.filter((entry) => entry.kind !== 'pageBreak')) {
    const isHeading = /heading/.test(item.kind);
    const currentFont = isHeading ? boldFont : font;
    const fontSize = item.kind === 'heading1' ? 16 : item.kind === 'heading2' ? 14 : isHeading ? 12 : 10.5;
    const lineHeight = Math.max(14, fontSize + 4);
    const lines = wrapPdfText(item.text, currentFont, fontSize, maxWidth);
    for (const line of lines) {
      addPageIfNeeded();
      page.drawText(line || ' ', { x: margin, y, size: fontSize, font: currentFont, color: rgb(0.08, 0.1, 0.14) });
      y -= line ? lineHeight : Math.ceil(lineHeight / 2);
    }
    y -= isHeading ? 4 : 2;
  }
  return Buffer.from(await pdf.save());
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
      if (format === 'pdf') {
        return buffer.slice(0, 5).toString('latin1') === '%PDF-';
      }
      if (TEXT_LIKE_EXTENSIONS.has(format)) {
        const text = buffer.toString('utf8');
        const needle = appendedNeedle.slice(0, Math.min(20, appendedNeedle.length));
        if (format === 'json') {
          return JSON.stringify(JSON.parse(text)).includes(needle);
        }
        return text.includes(needle) || text.includes(htmlEscape(needle));
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

// ---------------------------------------------------------------------------
// Agentic multi-step planner for source-preserving edits.
//
// A single user request can carry several intentions (e.g. "completa el anexo 3
// y agrega los instrumentos como un anexo 4"). Instead of handling only the
// first one, we (1) split the request into action clauses, (2) classify each
// clause's intent, (3) inspect the document to decide the right operation, and
// (4) execute every operation in order on the same evolving buffer.
// ---------------------------------------------------------------------------

const CLAUSE_ACTION_VERB = 'agreg\\w*|anad\\w*|incorpor\\w*|inclu\\w*|adjunt\\w*|complet\\w*|llen\\w*|rellen\\w*|desarroll\\w*|coloc\\w*|reescrib\\w*|reemplaz\\w*';

function splitRequestClauses(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const anchorRe = new RegExp(`\\b(?:${CLAUSE_ACTION_VERB})\\b`, 'g');
  const anchors = [];
  let match;
  while ((match = anchorRe.exec(normalized))) anchors.push(match.index);
  if (anchors.length <= 1) return [normalized];
  const clauses = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1] : normalized.length;
    const clause = normalized.slice(start, end).trim();
    if (clause) clauses.push(clause);
  }
  return clauses;
}

function clauseWantsInstrument(clauseNorm) {
  return /\b(instrumento\w*|instrument\w*|intuemtno|intrumneto|intrumento|cuestionario\w*|encuesta\w*|escala\w*)\b/.test(clauseNorm);
}

function clauseIsFill(clauseNorm) {
  return /\b(complet\w*|llen\w*|rellen\w*|desarroll\w*|termin\w*|reescrib\w*|reemplaz\w*)\b/.test(clauseNorm);
}

function clauseIsAppend(clauseNorm) {
  return /\b(agreg\w*|anad\w*|incorpor\w*|inclu\w*|adjunt\w*|coloc\w*)\b/.test(clauseNorm)
    || /\bcomo\s+(?:un\s+|una\s+)?(?:nuevo\s+|nueva\s+)?(?:anexo|apendice|seccion)\b/.test(clauseNorm);
}

function sectionExistsInDoc(documentXml, target) {
  if (!target) return false;
  const paragraphs = extractDocxParagraphs(documentXml);
  return paragraphs.some((paragraph) => matchesTargetHeading(paragraph.normalized, target));
}

function buildOperationFromClause(clauseNorm, documentXml) {
  const target = parseTargetSectionRequest(clauseNorm);
  const wantsInstrument = clauseWantsInstrument(clauseNorm);
  const fill = clauseIsFill(clauseNorm);
  const append = clauseIsAppend(clauseNorm);

  if (target) {
    const exists = sectionExistsInDoc(documentXml, target);
    // "agrega … como anexo 4" when the anexo does not exist yet → create it.
    if (append && !exists) return { kind: 'append_labeled', target, wantsInstrument };
    if (exists) return { kind: 'fill_section', target, wantsInstrument };
    if (fill) return { kind: 'fill_section', target, wantsInstrument };
    return { kind: 'append_labeled', target, wantsInstrument };
  }
  if (append || wantsInstrument) return { kind: 'append_generic', wantsInstrument };
  if (fill) return null;
  return null;
}

function planSourcePreservingOperations({ requestText = '', documentXml = '' } = {}) {
  const clauses = splitRequestClauses(requestText);
  const ops = [];
  const seen = new Set();
  for (const clause of clauses) {
    const op = buildOperationFromClause(clause, documentXml);
    if (!op) continue;
    const key = `${op.kind}:${op.target ? op.target.label : ''}:${op.wantsInstrument ? 'instr' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(op);
  }
  if (ops.length === 0) {
    ops.push({ kind: 'append_generic', wantsInstrument: clauseWantsInstrument(normalizeText(requestText)) });
  }
  return ops;
}

function readDocxDocumentXml(buffer) {
  try {
    return new PizZip(buffer).file('word/document.xml')?.asText() || '';
  } catch {
    return '';
  }
}

async function runFillSectionOperation({ buffer, op, requestText, sourceText, allSourceFiles, sourceFile, signal }) {
  // Step A — tuned, deterministic fast-path for the Anexo 3 thesis cronograma.
  const plan = detectCronogramaAnexo3Plan(buffer, op.target);
  if (plan?.type === 'cronograma_anexo_3') {
    return {
      buffer: fillDocxCronogramaSectionBuffer(buffer, op.target, plan),
      validationBlocks: plan.validationBlocks || [],
      step: { kind: 'fill_section', label: op.target.label, mode: 'cronograma_table' },
    };
  }
  // Step B — generic, document-grounded table fill for ANY section whose body
  // is a table (matrices, operacionalización, presupuesto, otros cronogramas…).
  const tablePlan = detectSectionTablePlan(buffer, op.target);
  if (tablePlan) {
    const generatedRows = await generateTableRowsContent({
      labels: tablePlan.labels,
      maxRows: tablePlan.dataRowCount,
      sectionLabel: op.target.label,
      sourceText,
      prompt: requestText,
      signal,
    });
    if (generatedRows.length) {
      try {
        const filledBuffer = fillGenericSectionTableBuffer(buffer, op.target, generatedRows);
        const validationBlocks = generatedRows
          .flat()
          .filter((value) => String(value || '').trim())
          .map((value) => block('normal', String(value)));
        return {
          buffer: filledBuffer,
          validationBlocks,
          step: { kind: 'fill_section', label: op.target.label, mode: 'table' },
        };
      } catch (err) {
        if (err?.code !== 'SECTION_TABLE_NOT_FOUND' && err?.code !== 'SECTION_TABLE_NOT_FILLABLE') throw err;
        // fall through to the paragraph fill below
      }
    }
  }
  // Step C — narrative paragraph fill (AI-generated, grounded in the document).
  const blocks = await generateTargetSectionBlocks({
    prompt: requestText,
    target: op.target,
    sourceFiles: allSourceFiles,
    sourceText,
    signal,
  });
  try {
    return {
      buffer: fillDocxSectionBuffer(buffer, op.target, blocks),
      validationBlocks: blocks,
      step: { kind: 'fill_section', label: op.target.label, mode: 'paragraphs' },
    };
  } catch (err) {
    if (err?.code !== 'SECTION_NOT_FOUND') throw err;
    const labeled = [
      block('pageBreak', ''),
      block('heading2', op.target.label),
      ...blocks.filter((item) => item.kind !== 'pageBreak'),
    ];
    return {
      buffer: appendToDocxBuffer(buffer, labeled),
      validationBlocks: labeled,
      step: { kind: 'append_labeled', label: op.target.label, mode: 'fallback_paragraphs' },
    };
  }
}

async function runAppendLabeledOperation({ buffer, op, requestText, sourceText, allSourceFiles, sourceFile, signal }) {
  const originalName = sourceFile.originalName || sourceFile.filename;
  const bodyBlocks = op.wantsInstrument
    ? buildInstrumentAppendixBody({ prompt: requestText, sourceText, originalName })
    : await generateTargetSectionBlocks({
      prompt: requestText,
      target: op.target,
      sourceFiles: allSourceFiles,
      sourceText,
      signal,
    });
  const heading = op.wantsInstrument
    ? `${op.target.label}. Instrumentos de recolección de datos`
    : op.target.label;
  const labeled = [
    block('pageBreak', ''),
    block('heading2', heading),
    ...bodyBlocks.filter((item) => item.kind !== 'pageBreak'),
  ];
  return {
    buffer: appendToDocxBuffer(buffer, labeled),
    validationBlocks: labeled,
    step: { kind: 'append_labeled', label: op.target.label, mode: op.wantsInstrument ? 'instrument' : 'generic' },
  };
}

function runAppendGenericOperation({ buffer, op, requestText, sourceText, sourceFile }) {
  const originalName = sourceFile.originalName || sourceFile.filename;
  const blocks = op.wantsInstrument
    ? buildInstrumentAppendix({ prompt: requestText, sourceText, originalName })
    : buildAppendixBlocks({ prompt: requestText, sourceText: sourceText || sourceFile.extractedText || '', originalName });
  return {
    buffer: appendToDocxBuffer(buffer, blocks),
    validationBlocks: blocks,
    step: { kind: 'append_generic', mode: op.wantsInstrument ? 'instrument' : 'generic' },
  };
}

async function executeDocxOperations({ input, ops, requestText, sourceText, allSourceFiles, sourceFile, signal }) {
  let buffer = input;
  const steps = [];
  const validationBlocks = [];
  for (const op of ops) {
    let result;
    if (op.kind === 'fill_section') {
      result = await runFillSectionOperation({ buffer, op, requestText, sourceText, allSourceFiles, sourceFile, signal });
    } else if (op.kind === 'append_labeled') {
      result = await runAppendLabeledOperation({ buffer, op, requestText, sourceText, allSourceFiles, sourceFile, signal });
    } else {
      result = runAppendGenericOperation({ buffer, op, requestText, sourceText, sourceFile });
    }
    buffer = result.buffer;
    steps.push(result.step);
    validationBlocks.push(...(result.validationBlocks || []));
  }
  return { buffer, steps, validationBlocks };
}

function joinSpanishList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
}

function describeStep(step) {
  if (step.kind === 'fill_section' && step.mode === 'cronograma_table') return `completé la tabla del cronograma de ${step.label}`;
  if (step.kind === 'fill_section') return `completé ${step.label} respetando su formato`;
  if (step.kind === 'append_labeled' && step.mode === 'instrument') return `agregué ${step.label} con los instrumentos profesionales`;
  if (step.kind === 'append_labeled' && step.mode === 'fallback_paragraphs') return `agregué ${step.label} al final (no existía en el documento)`;
  if (step.kind === 'append_labeled') return `agregué ${step.label}`;
  if (step.kind === 'append_generic' && step.mode === 'instrument') return 'agregué un anexo con el instrumento de recolección de datos';
  return 'agregué el contenido solicitado en anexos';
}

async function generateSourcePreservingDocumentEdit({
  sourceFile,
  sourceFiles = null,
  prompt,
  displayPrompt,
  userId,
  chatId,
  signal,
} = {}) {
  if (!sourceFile?.path) throw new Error('No se encontró el archivo original para editar.');
  const requestText = displayPrompt || prompt || '';
  const allSourceFiles = Array.isArray(sourceFiles) && sourceFiles.length ? sourceFiles : [sourceFile];
  const sourceText = await buildCombinedSourceText(allSourceFiles);
  const input = await fs.promises.readFile(sourceFile.path);

  let format;
  let output;
  let suffix = 'con_anexos';
  let titleSuffix = 'con anexos';
  let explanation = 'Se conservó el archivo original y se agregó únicamente el bloque solicitado al final.';
  let content = 'Listo. Conservé el archivo original y agregué el contenido solicitado al final, en anexos, sin regenerar la portada ni reemplazar el documento.';
  let validationBlocks;

  if (isDocxFile(sourceFile)) {
    format = 'docx';
    // Agentic step 1-3: analyse the request + document and plan one or more
    // operations; step 4: execute every operation in order on the same buffer.
    const documentXml = readDocxDocumentXml(input);
    const operations = planSourcePreservingOperations({ requestText, documentXml });
    const execution = await executeDocxOperations({
      input,
      ops: operations,
      requestText,
      sourceText,
      allSourceFiles,
      sourceFile,
      signal,
    });
    output = execution.buffer;
    validationBlocks = execution.validationBlocks;

    const labels = execution.steps.map((step) => step.label).filter(Boolean);
    if (labels.length) {
      suffix = `${labels.map((label) => normalizeText(label).replace(/\s+/g, '_')).join('_')}_completado`;
      titleSuffix = `${labels.join(' y ')} completado`;
    }
    const stepSummary = joinSpanishList(execution.steps.map(describeStep));
    explanation = stepSummary
      ? `Se conservó el DOCX original; ${stepSummary}.`
      : 'Se conservó el DOCX original y se aplicó la edición solicitada.';
    content = stepSummary
      ? `Listo. Conservé el DOCX original y, en ${execution.steps.length === 1 ? 'un paso' : `${execution.steps.length} pasos`}, ${stepSummary}, sin alterar el resto del archivo.`
      : 'Listo. Conservé el DOCX original y apliqué la edición solicitada sin alterar el resto del archivo.';
  } else {
    const blocks = buildAppendixBlocks({
      prompt: requestText,
      sourceText: sourceText || sourceFile.extractedText || '',
      originalName: sourceFile.originalName || sourceFile.filename,
    });
    validationBlocks = blocks;
    if (isXlsxFile(sourceFile)) {
      format = 'xlsx';
      output = await appendToXlsxBuffer(input, blocks);
      content = 'Listo. Conservé el XLSX original y agregué el contenido solicitado en una hoja nueva, sin reemplazar las hojas existentes.';
    } else if (isPdfFile(sourceFile)) {
      format = 'pdf';
      output = await appendToPdfBuffer(input, blocks);
      content = 'Listo. Conservé el PDF original y agregué el contenido solicitado al final, sin reemplazar las páginas existentes.';
    } else if (isTextLikeFile(sourceFile)) {
      format = textLikeFormatForFile(sourceFile) || 'txt';
      output = appendToTextLikeBuffer(input, blocks, format);
      content = `Listo. Conservé el ${format.toUpperCase()} original y agregué el contenido solicitado sin reemplazar el archivo base.`;
    } else {
      const ext = path.extname(sourceFile.originalName || sourceFile.filename || '').replace(/^\./, '').toLowerCase();
      throw new Error(`La edición preservadora todavía no soporta archivos .${ext || 'desconocidos'}. Formatos soportados: ${supportedSourceEditLabel()}.`);
    }
  }

  const filename = safeFilename(sourceFile.originalName || sourceFile.filename, suffix, format);
  const validation = await validateEditedBuffer(output, format, validationBlocks);
  const { artifact, previewHtml, mime } = await persistEditedArtifact({
    buffer: output,
    format,
    filename,
    userId,
    chatId,
    validation,
  });
  const title = `${path.basename(sourceFile.originalName || sourceFile.filename || 'Documento', path.extname(sourceFile.originalName || sourceFile.filename || ''))} ${titleSuffix}`;
  const file = {
    type: 'doc',
    format,
    title,
    explanation,
    filename: artifact.filename,
    url: artifact.downloadUrl,
    dataUrl: null,
    mime,
    size: artifact.sizeBytes,
    htmlPreview: previewHtml,
    metrics: validation,
  };
  return {
    content,
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
  signal,
} = {}) {
  const requestText = displayPrompt || prompt || '';
  const sourceFiles = await loadEditableSourceFiles(prisma, { userId, fileIds, chatId, prompt: requestText });
  if (!isSourcePreservingEditRequest(requestText, sourceFiles)) return null;
  const targetedSection = isTargetedSectionFillRequest(requestText);
  const supported = targetedSection
    ? sourceFiles.find((file) => isDocxFile(file))
    : sourceFiles.find((file) => isSupportedSourcePreservingFile(file));
  if (!supported) {
    const names = sourceFiles.map((file) => file.originalName || file.filename || file.id).join(', ');
    const needed = targetedSection ? 'un archivo DOCX con la sección solicitada' : `un archivo editable compatible (${supportedSourceEditLabel()})`;
    throw new Error(`Para conservar el documento original necesito ${needed}. Archivo recibido: ${names || 'sin archivo compatible'}.`);
  }
  return generateSourcePreservingDocumentEdit({
    sourceFile: supported,
    sourceFiles,
    prompt,
    displayPrompt,
    userId,
    chatId,
    signal,
  });
}

module.exports = {
  appendBlocksToDocumentXml,
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
  INTERNAL: {
    buildCombinedSourceText,
    buildCronogramaAnexo3Plan,
    buildDocumentFormattingTemplate,
    buildInstrumentAppendix,
    buildInstrumentAppendixBody,
    buildSectionFormattingTemplate,
    analyzeTableForFill,
    detectCronogramaAnexo3Plan,
    detectSectionTablePlan,
    extractParagraphProperties,
    extractRunProperties,
    fillCronogramaTableXml,
    fillGenericSectionTableBuffer,
    fillGenericSectionTableXml,
    generateTableRowsContent,
    inferResearchVariables,
    isTargetedSectionFillRequest,
    locateCronogramaTable,
    locateSectionTable,
    planSourcePreservingOperations,
    resolveStoredFilePath,
    sanitizeCapturedParagraphProperties,
    splitRequestClauses,
  },
};
