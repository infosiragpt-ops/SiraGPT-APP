/**
 * Chat attachment recovery — deterministic answers when the LLM runtime
 * fails or returns a weak "cannot read your file" reply. Reuses the same
 * bibliography / grounded fallbacks as agent-task-runner.
 */
const fs = require('fs');
const messageAttachments = require('./message-attachments');
const {
  resolveAttachmentFallbackMarkdown,
  parseSpreadsheetCitationRows,
} = require('./agents/agent-task-runner');
const { evaluateResponse } = require('./quality-guard');

const FILE_READ_FAILURE_RE = /\b(?:no\s+pude\s+leer\w*|no\s+puedo\s+leer\w*|recib[ií]\s+tu\s+archivo.{0,80}no\s+pude\s+leer|no\s+(?:pude|puedo)\s+(?:procesar|abrir|analizar|acceder\s+al\s+contenido\s+de(?:l)?|acceder\s+a|ver)\s+(?:tu\s+)?(?:archivo|adjunto|documento|file)|no\s+encontr[eé]\s+texto|binary file|content not available|file content could not be extracted|no\s+tengo\s+acceso\s+al\s+(?:archivo|adjunto|documento)|cannot\s+(?:read|access)\s+(?:the\s+)?(?:file|attachment)|unable\s+to\s+(?:read|access))\b/i;
const OPERATIONAL_DISCLOSURE_RE = /nota operativa|runtime principal|respuesta segura/i;
const GENERIC_STREAM_FAILURE_RE = /hubo un problema procesando tu solicitud|there was a problem processing your request/i;

function wantsBibliographyAnswer(request) {
  const value = String(request || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return /\b(bibliograf|referenc|citas?|apa|vancouver|harvard|chicago|mla|formato bibliograf)/.test(value);
}

function looksLikeUnsupportedExtractionPlaceholder(value) {
  const text = String(value || '').trim();
  return /^File\s+"[^"]+"\s+uploaded successfully\.\s+Content type:\s+application\/(?:octet-stream|zip|x-zip|x-zip-compressed)\.?$/i.test(text);
}

function shouldRecoverAttachmentResponse({ prompt, response, processedFiles = [] }) {
  if (!Array.isArray(processedFiles) || processedFiles.length === 0) return false;
  const trimmed = String(response || '').trim();
  if (!trimmed) return true;
  if (OPERATIONAL_DISCLOSURE_RE.test(trimmed)) return true;
  if (FILE_READ_FAILURE_RE.test(trimmed)) return true;
  if (GENERIC_STREAM_FAILURE_RE.test(trimmed)) return true;

  const verdict = evaluateResponse({ response: trimmed, userPrompt: prompt });
  if (!verdict.weak) return false;

  if (wantsBibliographyAnswer(prompt)) return true;

  const hasExtracted = processedFiles.some(
    (f) => typeof f.extractedText === 'string' && f.extractedText.trim().length > 40,
  );
  return hasExtracted;
}

function buildProcessedFilesContext(processedFiles = []) {
  if (!Array.isArray(processedFiles) || processedFiles.length === 0) return '';
  const blocks = processedFiles
    .map((file, index) => {
      const text = String(file?.extractedText || '').trim();
      if (!text || looksLikeUnsupportedExtractionPlaceholder(text)) return '';
      return [
        `### Archivo adjunto ${index + 1}: ${file.name || file.originalName || file.id || 'archivo'}`,
        file.id ? `id: ${file.id}` : null,
        `tipo: ${file.mimeType || file.type || 'desconocido'}`,
        '',
        text,
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);
  if (blocks.length === 0) return '';
  return [
    'Contexto inicial de archivos adjuntos ya extraido por siraGPT.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

async function refreshProcessedFileExtracts(prisma, processedFiles = []) {
  if (!Array.isArray(processedFiles) || processedFiles.length === 0) return processedFiles;
  const fileProcessor = require('./fileProcessor');
  return Promise.all(processedFiles.map(async (file) => {
    if (!file?.path || !fs.existsSync(file.path)) return file;
    if (
      messageAttachments.hasUsefulExtractedText(file.extractedText) &&
      !looksLikeUnsupportedExtractionPlaceholder(file.extractedText)
    ) {
      return file;
    }
    try {
      const result = await fileProcessor.processFile({
        path: file.path,
        mimetype: file.mimeType,
        originalname: file.originalName || file.name,
        size: Number(file.size) || 0,
      });
      const extractedText = String(result?.extractedText || '').trim();
      if (!messageAttachments.hasUsefulExtractedText(extractedText)) return file;
      if (file.id && prisma?.file?.update) {
        await prisma.file.update({
          where: { id: file.id },
          data: { extractedText },
        }).catch(() => {});
      }
      return { ...file, extractedText };
    } catch (err) {
      console.warn(`[chat-attachment-recovery] on-demand extract failed for ${file.id}:`, err.message);
      return file;
    }
  }));
}

async function buildChatUploadedFileContext(prisma, { userId, processedFiles, prompt }) {
  if (!userId || !processedFiles?.length) return '';
  const fileIds = processedFiles.map((f) => f.id).filter(Boolean);
  if (fileIds.length === 0) return buildProcessedFilesContext(processedFiles);
  const enrichedContext = await messageAttachments.buildUploadedFileContext(prisma, {
    userId,
    fileIds,
    query: prompt,
  });
  return enrichedContext || buildProcessedFilesContext(processedFiles);
}

async function recoverChatAttachmentResponse({
  prisma,
  userId,
  prompt,
  processedFiles,
  uploadedFileContext = '',
  reason = '',
}) {
  const context = uploadedFileContext
    || await buildChatUploadedFileContext(prisma, { userId, processedFiles, prompt })
    || buildProcessedFilesContext(processedFiles);
  let answer = resolveAttachmentFallbackMarkdown({
    goal: prompt,
    uploadedFileContext: context,
    reason,
  });

  if (wantsBibliographyAnswer(prompt) && parseSpreadsheetCitationRows(context).length === 0) {
    const rawExtract = (processedFiles || [])
      .map((file) => String(file?.extractedText || '').trim())
      .filter((text) => text.length > 40)
      .join('\n\n');
    if (rawExtract) {
      const fromRaw = resolveAttachmentFallbackMarkdown({
        goal: prompt,
        uploadedFileContext: rawExtract,
        reason,
      });
      if (fromRaw?.trim()) answer = fromRaw;
    }
  }

  return answer;
}

module.exports = {
  wantsBibliographyAnswer,
  shouldRecoverAttachmentResponse,
  buildProcessedFilesContext,
  refreshProcessedFileExtracts,
  buildChatUploadedFileContext,
  recoverChatAttachmentResponse,
};
