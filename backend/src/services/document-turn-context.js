'use strict';

/**
 * document-turn-context — the chat/code generate path for an attached
 * document. Keeps extracted text in the model payload, fail-closes when
 * extract is empty, and prefers the current-turn file over stale RAG.
 */

const EXTRACT_PLACEHOLDER_RE = /^(?:\[(?:Documento PDF|Archivo|Imagen|Archivo multimedia)[\s\S]*vuelve a adjuntarlo|File\s+"[^"]+"\s+uploaded successfully\.|Binary file - content not available)/i;
const IMAGE_MIME_RE = /^image\//i;
const PDF_RE = /pdf/i;

function isImageFile(file = {}) {
  const mime = String(file.mimeType || file.type || '').toLowerCase();
  const name = String(file.name || file.originalName || file.filename || '');
  return IMAGE_MIME_RE.test(mime) || /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(name);
}

function isDocumentFile(file) {
  return Boolean(file) && !isImageFile(file);
}

function looksLikeExtractorPlaceholder(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (EXTRACT_PLACEHOLDER_RE.test(text)) return true;
  return /^File\s+"[^"]+"\s+uploaded successfully\.\s+Content type:/i.test(text);
}

function hasUsefulExtractedText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || looksLikeExtractorPlaceholder(text)) return false;
  return text.length >= 40;
}

function documentFiles(processedFiles = []) {
  return (Array.isArray(processedFiles) ? processedFiles : []).filter(isDocumentFile);
}

function assessEmptyDocumentExtract(processedFiles = []) {
  const docs = documentFiles(processedFiles);
  if (docs.length === 0) {
    return { failClosed: false, reason: 'no_document_attachment' };
  }
  const useful = docs.filter((file) => hasUsefulExtractedText(file.extractedText));
  if (useful.length > 0) {
    return { failClosed: false, reason: 'extract_present', usefulCount: useful.length };
  }
  const first = docs[0] || {};
  const name = String(first.name || first.originalName || first.filename || 'documento').trim() || 'documento';
  const isPdf = PDF_RE.test(String(first.mimeType || first.type || '')) || /\.pdf$/i.test(name);
  return {
    failClosed: true,
    code: 'document_extract_empty',
    error: isPdf
      ? `No pude leer el PDF "${name}", vuelve a adjuntarlo`
      : `No pude leer el documento "${name}", vuelve a adjuntarlo`,
  };
}

function attachedSourceIds(processedFiles = []) {
  return new Set(
    documentFiles(processedFiles)
      .map((file) => file && file.id)
      .filter(Boolean)
      .map((id) => `file:${id}`),
  );
}

/**
 * Prefer the current-turn attached file over stale RAG from the same
 * collection (older files in this chat, project knowledge, other docs).
 * If the attached file has no hits, return [] instead of leftover sources.
 */
function preferAttachedRagHits(hits, processedFiles = []) {
  const attached = attachedSourceIds(processedFiles);
  const list = Array.isArray(hits) ? hits : [];
  if (!attached.size) return list;
  return list.filter((hit) => hit && attached.has(hit.source));
}

function shouldKeepAttachedBody(processedFiles = []) {
  return documentFiles(processedFiles).some((file) => hasUsefulExtractedText(file.extractedText));
}

function applyTokenBudget(fileContext, { maxChars = 200000 } = {}) {
  const text = String(fileContext || '');
  const budget = Math.max(2000, Number(maxChars) || 200000);
  if (text.length <= budget) return { text, truncated: false };
  const head = Math.floor(budget * 0.5);
  const tail = Math.floor(budget * 0.38);
  const note = '\n\n[Nota: el documento es largo y se truncó; incluí el inicio y el final. Si falta una sección, pídela.]\n\n';
  return {
    text: `${text.slice(0, head).trim()}${note}${text.slice(-tail).trim()}`,
    truncated: true,
  };
}

function buildAttachedFilePrompt({
  processedFiles = [],
  prompt = '',
  uploadedFileContext = '',
} = {}) {
  const docs = documentFiles(processedFiles);
  const rawBlocks = docs
    .filter((file) => hasUsefulExtractedText(file.extractedText))
    .map((file) => {
      const name = file.name || file.originalName || file.filename || file.id || 'archivo';
      return `File: ${name}\nContent: ${String(file.extractedText).trim()}`;
    });
  const raw = rawBlocks.join('\n\n');
  const uploaded = String(uploadedFileContext || '').trim();

  if (uploaded && raw) {
    const allNeedlesPresent = docs
      .filter((file) => hasUsefulExtractedText(file.extractedText))
      .every((file) => {
        const needle = String(file.extractedText).replace(/\s+/g, ' ').trim().slice(0, 80);
        return !needle || uploaded.replace(/\s+/g, ' ').includes(needle);
      });
    if (allNeedlesPresent) return uploaded;
    // Generic RAG/evidence scaffolding without the attached body: keep the
    // raw extract so "analiza este documento" cannot run on a filename.
    if (!/File:\s+.+\nContent:/i.test(uploaded) && uploaded.length < raw.length) {
      return `${uploaded}\n\n${raw}`;
    }
  }
  if (raw) return raw;
  return uploaded;
}

function buildGeneratePayload({
  prompt = '',
  processedFiles = [],
  uploadedFileContext = '',
  systemInstruction = null,
} = {}) {
  const empty = assessEmptyDocumentExtract(processedFiles);
  if (empty.failClosed) {
    return { ok: false, messages: [], fileContext: '', ...empty };
  }
  const fileContext = buildAttachedFilePrompt({ processedFiles, prompt, uploadedFileContext });
  const userContent = fileContext
    ? `${prompt}\n\nAttached files:\n${fileContext}`
    : String(prompt || '');
  const messages = [
    systemInstruction || {
      role: 'system',
      content: 'You are SiraGPT. Answer from the attached extracted text only. Do not invent document contents.',
    },
    { role: 'user', content: userContent },
  ];
  return { ok: true, messages, fileContext, failClosed: false };
}

function payloadContainsExtract(messages, needle) {
  return JSON.stringify(messages || []).includes(String(needle || ''));
}

module.exports = {
  isImageFile,
  isDocumentFile,
  looksLikeExtractorPlaceholder,
  hasUsefulExtractedText,
  documentFiles,
  assessEmptyDocumentExtract,
  attachedSourceIds,
  preferAttachedRagHits,
  shouldKeepAttachedBody,
  applyTokenBudget,
  buildAttachedFilePrompt,
  buildGeneratePayload,
  payloadContainsExtract,
};
