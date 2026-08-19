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
  if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return PARSERS.docx;
  if (mime.includes('spreadsheetml') || mime.includes('excel') || name.endsWith('.xlsx') || name.endsWith('.xls')) return PARSERS.xlsx;
  if (mime.includes('presentation') || mime.includes('powerpoint') || name.endsWith('.pptx')) return PARSERS.pptx;
  if (mime.includes('csv') || name.endsWith('.csv')) return PARSERS.csv;
  if (mime.includes('json') || name.endsWith('.json')) return PARSERS.json;
  if (mime.includes('markdown') || name.endsWith('.md')) return PARSERS.md;

  return ['internal-text-extractor'];
}

function semanticChunkingOptions(env = process.env) {
  return {
    chunkSize: Number.parseInt(env.SIRAGPT_SEMANTIC_CHUNK_SIZE || '1200', 10),
    overlap: Number.parseInt(env.SIRAGPT_SEMANTIC_CHUNK_OVERLAP || '200', 10),
    embeddingProvider: env.SIRAGPT_MEMORY_EMBED_PROVIDER || 'voyage',
    fallbackEmbeddingProvider: 'jina',
    embeddingModel: env.SIRAGPT_MEMORY_EMBED_MODEL || 'voyage-3-large',
    fallbackEmbeddingModel: 'jina-embeddings-v3',
  };
}

function chunkSemantically(text = '', opts = {}) {
  const { chunkSize = 1200, overlap = 200 } = opts;
  if (typeof text !== 'string' || !text.trim()) return [];
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current.length + para.length) > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n\n' + para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(c => c.length >= 50);
}

function qualityScoreForFile(file = {}) {
  let score = 0.5;
  const name = String(file.name || '').toLowerCase();
  const size = Number(file.size || 0);

  if (name.endsWith('.pdf')) score += 0.15;
  if (name.endsWith('.docx')) score += 0.10;
  if (name.endsWith('.pptx')) score += 0.05;
  if (name.endsWith('.xlsx')) score -= 0.05;
  if (name.endsWith('.txt') || name.endsWith('.csv')) score += 0.02;

  if (size > 1024 * 1024) score += 0.05;
  if (size < 1024) score -= 0.10;

  return Math.max(0, Math.min(1, score));
}

module.exports = { PARSERS, parserPlanFor, semanticChunkingOptions, chunkSemantically, qualityScoreForFile };
