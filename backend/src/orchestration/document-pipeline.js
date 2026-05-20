'use strict';

const PARSERS = Object.freeze({
  pdf: ['marker', 'docling', 'unstructured', 'surya-ocr'],
  docx: ['markitdown', 'mammoth'],
  xlsx: ['markitdown', 'exceljs'],
  pptx: ['markitdown', 'officeparser'],
});

function parserPlanFor(file = {}) {
  const name = String(file.name || file.originalName || '').toLowerCase();
  const mime = String(file.mimeType || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return PARSERS.pdf;
  if (mime.includes('word') || name.endsWith('.docx')) return PARSERS.docx;
  if (mime.includes('spreadsheet') || name.endsWith('.xlsx')) return PARSERS.xlsx;
  if (mime.includes('presentation') || name.endsWith('.pptx')) return PARSERS.pptx;
  return ['internal-text-extractor'];
}

function semanticChunkingOptions(env = process.env) {
  return {
    chunkSize: Number.parseInt(env.SIRAGPT_SEMANTIC_CHUNK_SIZE || '1200', 10),
    overlap: Number.parseInt(env.SIRAGPT_SEMANTIC_CHUNK_OVERLAP || '200', 10),
    embeddingProvider: env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage',
    fallbackEmbeddingProvider: 'jina',
  };
}

module.exports = { PARSERS, parserPlanFor, semanticChunkingOptions };
