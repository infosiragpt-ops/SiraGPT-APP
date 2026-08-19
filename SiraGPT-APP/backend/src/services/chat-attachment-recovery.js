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
const RAW_TOC_RESPONSE_RE = /\b(?:[ií]ndice\s+de\s+contenidos|tabla\s+de\s+contenido|table\s+of\s+contents|declaratoria\s+de\s+autenticidad|_Toc\d+)\b/i;
const RAW_MARKDOWN_LINK_RE = /\[[^\]\n]{2,160}\]\((?:#_?Toc|#[^)]+)\)/i;
const DIRECT_SHORT_ANSWER_RE = /\b(?:solo\s+(?:el\s+)?n[uú]mero|solo\s+una\s+palabra|una\s+sola\s+palabra|one\s+word|only\s+the\s+(?:number|word))\b/i;

function wantsBibliographyAnswer(request) {
  const value = String(request || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return /\b(bibliograf|referenc|citas?|apa|vancouver|harvard|chicago|mla|formato bibliograf)/.test(value);
}

function looksLikeUnsupportedExtractionPlaceholder(value) {
  const text = String(value || '').trim();
  return /^File\s+"[^"]+"\s+uploaded successfully\.\s+Content type:\s+application\/(?:octet-stream|zip|x-zip|x-zip-compressed)\.?$/i.test(text);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return '';
}

function comparableDirectValue(answer = '') {
  const text = String(answer || '').trim();
  const bold = text.match(/\*\*([^*]+)\*\*/);
  if (bold?.[1]) return bold[1].trim();
  const requested = text.match(/^El dato solicitado es\s+(.+?)\.?$/i);
  if (requested?.[1]) return requested[1].replace(/\*/g, '').trim();
  return text;
}

function splitSummarySentences(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function buildDirectExtractedSummaryAnswer(prompt = '', rawText = '') {
  const request = normalizeKey(prompt);
  if (!/\b(?:resumen|resume|sintesis|summary|de que trata|que dice)\b/.test(request)) return '';
  const sentences = splitSummarySentences(rawText)
    .filter((sentence) => sentence.length >= 24)
    .filter((sentence) => !/^[A-ZÁÉÍÓÚÑ0-9\s\-–—:]{8,}$/.test(sentence));
  if (!sentences.length) return '';
  const requestTerms = request
    .split(/\W+/)
    .filter((term) => term.length >= 5 && !['resumen', 'resume', 'documento', 'archivo', 'informe'].includes(term));
  const scored = sentences.map((sentence, index) => {
    const key = normalizeKey(sentence);
    let score = 0;
    for (const term of requestTerms) if (key.includes(term)) score += 2;
    if (/\d/.test(sentence)) score += 2;
    if (/\b(?:uptime|vulnerab|seguridad|recomendaci|credencial|cifrar|factor)\b/i.test(sentence)) score += 2;
    return { sentence, index, score };
  });
  const selectedIndexes = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);
  const selected = selectedIndexes.length ? selectedIndexes : scored.slice(0, 2);
  return selected.map((item) => item.sentence).join(' ').replace(/\s+/g, ' ').trim();
}

function buildDirectExtractedFieldAnswer(prompt = '', uploadedFileContext = '') {
  const request = normalizeKey(prompt);
  const context = String(uploadedFileContext || '');
  if (!request || !context.trim()) return '';

  let value = '';
  const asksInvoiceNumber = /\b(?:numero|nro|num|number)\s+(?:de\s+)?factura\b|\bfactura\s+(?:numero|nro|num|number)\b|\binvoice\s+number\b/.test(request);
  const asksInvoiceTotal = /\btotal\b.*\bfactura\b|\bfactura\b.*\btotal\b/.test(request);
  const asksInvoiceCurrency = /\b(?:moneda|currency|divisa)\b/.test(request) && (/\bfactura\b/.test(request) || /\btotal\b/.test(request));
  const asksMultipleInvoiceFields = !DIRECT_SHORT_ANSWER_RE.test(prompt) && asksInvoiceNumber && asksInvoiceTotal;
  if (asksMultipleInvoiceFields) return '';
  if (asksInvoiceCurrency) {
    value = pickMatch(context, [/\bTOTAL\s*[:\-]\s*[0-9][0-9.,]*\s*([A-Z]{2,4}|euros?)\b/i]);
    value = value.toUpperCase();
  } else if (asksInvoiceTotal) {
    value = pickMatch(context, [/\bTOTAL\s*[:\-]\s*([0-9][0-9.,]*)(?:\s*[A-Z]{2,4})?\b/i]);
  } else if (asksInvoiceNumber) {
    value = pickMatch(context, [
      /\bFACTURA\s*(?:N|N[°º.]?|NO\.?|NUM(?:ERO)?\.?|#)?\s*[:\-]?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i,
      /\b(?:n[uú]mero|numero|nro|no\.?|#)\s*(?:de\s+)?factura\s*[:\-]?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i,
    ]);
  } else if (/\bcliente\b/.test(request)) {
    value = pickMatch(context, [/\bCliente\s*[:\-]\s*([^\n\r]*?)(?=\s+(?:Fecha|Concepto|TOTAL|Factura)\s*[:\-]|\s*$)/i]);
  } else if (/\bfecha\b/.test(request)) {
    value = pickMatch(context, [/\bFecha\s*[:\-]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})\b/i]);
  } else if (/\bconcepto\b/.test(request)) {
    value = pickMatch(context, [/\bConcepto\s*[:\-]\s*([^\n\r]*?)(?=\s+(?:TOTAL|Cliente|Fecha|Factura)\s*[:\-]|\s*$)/i]);
  } else if (/\bmarcador\b/.test(request)) {
    value = pickMatch(context, [/\b(?:Marcador|Marker)\s*[:\t\-]\s*([A-Z0-9-]{4,})\b/i]);
  }

  if (!value) return '';
  value = value.replace(/[.。,:;]+$/g, '').trim();
  if (DIRECT_SHORT_ANSWER_RE.test(prompt)) return value;
  return `El dato solicitado es **${value}**.`;
}

function shouldUseDirectExtractedFieldAnswer({ prompt = '', response = '', directAnswer = '' } = {}) {
  const answer = String(directAnswer || '').trim();
  if (!answer) return false;
  const current = String(response || '').trim();
  if (!current) return true;
  const normalizedCurrent = normalizeKey(current).replace(/[.。,:;]+$/g, '');
  const normalizedAnswer = normalizeKey(comparableDirectValue(answer)).replace(/[.。,:;]+$/g, '');
  if (DIRECT_SHORT_ANSWER_RE.test(prompt)) {
    return normalizedCurrent !== normalizedAnswer;
  }
  return !normalizedCurrent.includes(normalizedAnswer);
}

function shouldRecoverAttachmentResponse({ prompt, response, processedFiles = [] }) {
  if (!Array.isArray(processedFiles) || processedFiles.length === 0) return false;
  const trimmed = String(response || '').trim();
  if (!trimmed) return true;
  if (OPERATIONAL_DISCLOSURE_RE.test(trimmed)) return true;
  if (FILE_READ_FAILURE_RE.test(trimmed)) return true;
  if (GENERIC_STREAM_FAILURE_RE.test(trimmed)) return true;
  if (
    messageAttachments.isProfessionalDocumentSynthesisRequest(prompt)
    && (RAW_TOC_RESPONSE_RE.test(trimmed.slice(0, 1200)) || RAW_MARKDOWN_LINK_RE.test(trimmed.slice(0, 1200)))
  ) {
    return true;
  }

  const verdict = evaluateResponse({ response: trimmed, userPrompt: prompt });
  if (!verdict.weak) return false;

  if (wantsBibliographyAnswer(prompt)) return true;

  const hasExtracted = processedFiles.some(
    (f) => typeof f.extractedText === 'string' && f.extractedText.trim().length > 40,
  );
  return hasExtracted;
}

function buildProcessedFilesContext(processedFiles = [], prompt = '') {
  if (!Array.isArray(processedFiles) || processedFiles.length === 0) return '';
  const synthesisRequest = messageAttachments.isProfessionalDocumentSynthesisRequest(prompt);
  const blocks = processedFiles
    .map((file, index) => {
      const rawText = String(file?.extractedText || '').trim();
      const text = synthesisRequest
        ? messageAttachments.prepareDocumentTextForProfessionalSynthesis(rawText)
        : rawText;
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
  if (fileIds.length === 0) return buildProcessedFilesContext(processedFiles, prompt);
  const enrichedContext = await messageAttachments.buildUploadedFileContext(prisma, {
    userId,
    fileIds,
    query: prompt,
  });
  return enrichedContext || buildProcessedFilesContext(processedFiles, prompt);
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
    || buildProcessedFilesContext(processedFiles, prompt);
  const directAnswer = buildDirectExtractedFieldAnswer(prompt, context);
  if (directAnswer) return directAnswer;
  let answer = resolveAttachmentFallbackMarkdown({
    goal: prompt,
    uploadedFileContext: context,
    reason,
  });

  const rawExtract = (processedFiles || [])
    .map((file) => String(file?.extractedText || '').trim())
    .filter((text) => text.length > 40)
    .join('\n\n');

  if (rawExtract && (!answer?.trim() || FILE_READ_FAILURE_RE.test(answer) || /no\s+encontr[eé]\s+texto\s+suficiente/i.test(answer))) {
    const fromRaw = resolveAttachmentFallbackMarkdown({
      goal: prompt,
      uploadedFileContext: rawExtract,
      reason,
    });
    if (fromRaw?.trim()) answer = fromRaw;
  }

  const directSummary = rawExtract ? buildDirectExtractedSummaryAnswer(prompt, rawExtract) : '';
  if (
    directSummary
    && (
      !answer?.trim()
      || FILE_READ_FAILURE_RE.test(answer)
      || /no\s+encontr[eé]\s+texto\s+suficiente/i.test(answer)
      || String(answer).trim().length < 140
    )
  ) {
    answer = directSummary;
  }

  if (wantsBibliographyAnswer(prompt) && parseSpreadsheetCitationRows(context).length === 0) {
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
  shouldUseDirectExtractedFieldAnswer,
  buildDirectExtractedFieldAnswer,
  buildProcessedFilesContext,
  refreshProcessedFileExtracts,
  buildChatUploadedFileContext,
  recoverChatAttachmentResponse,
  _internal: {
    buildDirectExtractedFieldAnswer,
    buildDirectExtractedSummaryAnswer,
    shouldUseDirectExtractedFieldAnswer,
    normalizeKey,
  },
};
