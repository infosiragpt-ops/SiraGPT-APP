'use strict';

const DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS = 400;
const MAX_SAFE_SIMULTANEOUS_DOCUMENTS = 500;
const DEFAULT_MAX_DOCUMENTS_PER_FAMILY = 100;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampPositiveInt(value, fallback, max) {
  return Math.min(parsePositiveInt(value, fallback), max);
}

// Product contract: SiraGPT can upload/read up to 400 documents in one turn:
// 100 PDFs + 100 Word + 100 PowerPoint + 100 Excel. Keep a hard safety cap so
// one request cannot accidentally fan out thousands of files and overwhelm
// extraction, RAG indexing, or prompt planning.
const MAX_SIMULTANEOUS_DOCUMENTS = Math.min(
  MAX_SAFE_SIMULTANEOUS_DOCUMENTS,
  parsePositiveInt(process.env.SIRAGPT_MAX_SIMULTANEOUS_DOCUMENTS, DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS),
);

const DOCUMENT_FAMILY_LIMITS = Object.freeze({
  pdf: clampPositiveInt(process.env.SIRAGPT_MAX_PDF_DOCUMENTS, DEFAULT_MAX_DOCUMENTS_PER_FAMILY, MAX_SIMULTANEOUS_DOCUMENTS),
  word: clampPositiveInt(process.env.SIRAGPT_MAX_WORD_DOCUMENTS, DEFAULT_MAX_DOCUMENTS_PER_FAMILY, MAX_SIMULTANEOUS_DOCUMENTS),
  presentation: clampPositiveInt(process.env.SIRAGPT_MAX_PRESENTATION_DOCUMENTS, DEFAULT_MAX_DOCUMENTS_PER_FAMILY, MAX_SIMULTANEOUS_DOCUMENTS),
  spreadsheet: clampPositiveInt(process.env.SIRAGPT_MAX_SPREADSHEET_DOCUMENTS, DEFAULT_MAX_DOCUMENTS_PER_FAMILY, MAX_SIMULTANEOUS_DOCUMENTS),
});

const DOCUMENT_FAMILY_MIMES = Object.freeze({
  pdf: new Set(['application/pdf']),
  word: new Set([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
  ]),
  presentation: new Set([
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
  ]),
  spreadsheet: new Set([
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'text/csv',
    'text/tab-separated-values',
  ]),
});

const DOCUMENT_FAMILY_EXTENSIONS = Object.freeze({
  pdf: new Set(['pdf']),
  word: new Set(['doc', 'docx', 'odt']),
  presentation: new Set(['ppt', 'pptx', 'odp']),
  spreadsheet: new Set(['xls', 'xlsx', 'ods', 'csv', 'tsv']),
});

function extensionFromName(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(dot + 1).toLowerCase() : '';
}

function normalizeMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function classifyDocumentFamily(file = {}) {
  const mime = normalizeMime(file.mimetype || file.mimeType || file.type);
  const ext = extensionFromName(file.originalname || file.originalName || file.name || file.filename);
  for (const family of ['pdf', 'word', 'presentation', 'spreadsheet']) {
    if (DOCUMENT_FAMILY_MIMES[family].has(mime) || DOCUMENT_FAMILY_EXTENSIONS[family].has(ext)) {
      return family;
    }
  }
  return 'other';
}

function emptyFamilyCounts() {
  return {
    pdf: 0,
    word: 0,
    presentation: 0,
    spreadsheet: 0,
    other: 0,
  };
}

function validateDocumentBatch(files = [], opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const maxDocuments = opts.maxDocuments || MAX_SIMULTANEOUS_DOCUMENTS;
  const familyLimits = opts.familyLimits || DOCUMENT_FAMILY_LIMITS;
  const counts = emptyFamilyCounts();
  for (const file of list) {
    const family = classifyDocumentFamily(file);
    counts[family] = (counts[family] || 0) + 1;
  }

  if (list.length > maxDocuments) {
    return {
      ok: false,
      code: 'document_batch_too_large',
      message: `Puedes subir hasta ${maxDocuments} archivos por lote.`,
      total: list.length,
      maxDocuments,
      counts,
      familyLimits,
    };
  }

  for (const [family, limit] of Object.entries(familyLimits)) {
    if ((counts[family] || 0) > limit) {
      return {
        ok: false,
        code: `${family}_document_batch_too_large`,
        message: `Puedes subir hasta ${limit} archivos ${family} por lote.`,
        total: list.length,
        maxDocuments,
        counts,
        familyLimits,
      };
    }
  }

  return {
    ok: true,
    code: 'accepted',
    total: list.length,
    maxDocuments,
    counts,
    familyLimits,
  };
}

module.exports = {
  DEFAULT_MAX_DOCUMENTS_PER_FAMILY,
  DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS,
  DOCUMENT_FAMILY_LIMITS,
  MAX_SAFE_SIMULTANEOUS_DOCUMENTS,
  MAX_SIMULTANEOUS_DOCUMENTS,
  classifyDocumentFamily,
  validateDocumentBatch,
};
