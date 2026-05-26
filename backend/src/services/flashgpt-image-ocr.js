const fs = require('fs');
const ocrEngine = require('./ocr-engine');
const messageAttachments = require('./message-attachments');

const DEFAULT_MAX_CHARS = 24000;
const MONEY_RE = /(?:S\/|US\$|\$|USD|EUR|Bs\.?|BOB|PEN)?\s*-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\b(?:S\/|US\$|\$|USD|EUR|Bs\.?|BOB|PEN)\s*-?\d+(?:[.,]\d{2})?/gi;
const PRIMARY_AMOUNT_LABEL_RE = /\b(disponible|saldo|balance|total|monto|importe|amount|available)\b/i;
const SECONDARY_AMOUNT_LABEL_RE = /\b(movimientos?|transfer|transf|pago|yape|retiro|deposito|dep[oó]sito|servicio|hoy|ayer)\b/i;

function isImageAttachment(file = {}) {
  const mime = String(file.mimeType || file.mimetype || file.type || '').toLowerCase();
  const name = String(file.originalName || file.name || file.filename || '').toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
}

function compactText(value, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80)).trim()}\n[OCR truncado por limite de contexto]`;
}

function ocrMetaLine(file, ocr = {}) {
  const parts = [
    `archivo=${file.name || file.originalName || file.filename || file.id || 'imagen'}`,
    `tipo=${file.mimeType || file.type || 'image'}`,
  ];
  if (ocr.provider) parts.push(`motor=${ocr.provider}`);
  if (ocr.status) parts.push(`estado=${ocr.status}`);
  if (Number.isFinite(Number(ocr.confidence))) parts.push(`confianza=${Math.round(Number(ocr.confidence))}%`);
  return parts.join('; ');
}

function normalizeOcrLines(text) {
  return String(text || '')
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractMoneyCandidates(text) {
  const lines = normalizeOcrLines(text);
  const candidates = [];

  lines.forEach((line, index) => {
    const matches = Array.from(line.matchAll(MONEY_RE));
    for (const match of matches) {
      let value = match[0].replace(/\s+/g, ' ').trim();
      const after = line.slice((match.index || 0) + match[0].length);
      const trailingCurrency = after.match(/^\s*(USD|EUR|BOB|PEN)\b/i);
      if (trailingCurrency && !new RegExp(`\\b${trailingCurrency[1]}\\b`, 'i').test(value)) {
        value = `${value} ${trailingCurrency[1].toUpperCase()}`;
      }
      if (!value) continue;
      const nearby = [
        lines[index - 2],
        lines[index - 1],
        line,
        lines[index + 1],
      ].filter(Boolean).join(' | ');
      const previous = [lines[index - 2], lines[index - 1]].filter(Boolean).join(' ');
      const hasPrimaryLabel = PRIMARY_AMOUNT_LABEL_RE.test(nearby);
      const hasSecondaryLabel = SECONDARY_AMOUNT_LABEL_RE.test(nearby);
      candidates.push({
        value,
        line,
        nearby,
        score: (hasPrimaryLabel ? 100 : 0)
          + (PRIMARY_AMOUNT_LABEL_RE.test(previous) ? 40 : 0)
          - (hasSecondaryLabel ? 20 : 0)
          + Math.min(15, value.length),
      });
    }
  });

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function buildVisualAnswerHints(text, userPrompt = '') {
  const prompt = String(userPrompt || '').toLowerCase();
  const asksAmount = /\b(cu[aá]l\s+es\s+el\s+monto|monto|saldo|disponible|total|cu[aá]nt[oa])\b/.test(prompt);
  const candidates = extractMoneyCandidates(text);
  if (candidates.length === 0) return '';

  const primary = candidates[0];
  const lines = [
    '### Lectura estructurada OCR',
    `Monto principal probable: ${primary.value}`,
    `Contexto del monto principal: ${primary.nearby}`,
  ];

  if (candidates.length > 1) {
    lines.push('Otros montos detectados:');
    for (const candidate of candidates.slice(1, 6)) {
      lines.push(`- ${candidate.value} (${candidate.nearby})`);
    }
  }

  if (asksAmount) {
    lines.push('Instruccion de respuesta: si el usuario pregunta por el monto/saldo/total de la imagen, responde primero con el monto principal probable y, si hay varios montos, aclara brevemente que tambien aparecen otros montos secundarios.');
  }

  return lines.join('\n');
}

async function extractLocalImageText(prisma, file, userId) {
  if (!file || !isImageAttachment(file)) return { file, text: '', ocr: null, skipped: true };

  if (messageAttachments.hasUsefulExtractedText(file.extractedText)) {
    return {
      file,
      text: String(file.extractedText || '').trim(),
      ocr: file.ocr || { status: 'existing_text', provider: 'stored_extract', confidence: null },
      skipped: false,
    };
  }

  const filePath = file.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      file,
      text: '',
      ocr: { status: 'failed', provider: 'tesseract', reason: 'image_file_not_found' },
      skipped: false,
    };
  }

  const result = await ocrEngine.extractFromImage(filePath, {
    mimeType: file.mimeType || file.type || 'image/png',
    mode: 'local',
    allowVision: false,
  });
  const text = String(result?.text || '').trim();
  const ocr = result?.ocr || { status: 'failed', provider: 'tesseract' };

  if (messageAttachments.hasUsefulExtractedText(text) && prisma?.file?.update && file.id) {
    await prisma.file.update({
      where: { id: file.id },
      data: { extractedText: text },
    }).catch(() => null);
  }

  return {
    file: messageAttachments.hasUsefulExtractedText(text) ? { ...file, extractedText: text, ocr } : file,
    text,
    ocr,
    skipped: false,
  };
}

async function buildFlashGptImageOcrContext(prisma, {
  userId,
  files = [],
  prompt = '',
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const imageFiles = (Array.isArray(files) ? files : []).filter(isImageAttachment);
  if (imageFiles.length === 0) {
    return { block: '', files, imageCount: 0, readableCount: 0, failedCount: 0 };
  }

  const perImageBudget = Math.max(1200, Math.floor(maxChars / Math.max(1, imageFiles.length)));
  const results = await Promise.all(imageFiles.map((file) => extractLocalImageText(prisma, file, userId)));
  const byId = new Map(results.map((result) => [result.file?.id || result.file?.name || result.file?.path, result.file]));
  const enrichedFiles = (Array.isArray(files) ? files : []).map((file) => {
    const key = file?.id || file?.name || file?.path;
    return byId.get(key) || file;
  });

  const readable = results.filter((result) => messageAttachments.hasUsefulExtractedText(result.text));
  const failed = results.filter((result) => !messageAttachments.hasUsefulExtractedText(result.text));

  if (readable.length === 0) {
    const failureLines = failed.map((result, index) => {
      const reason = result.ocr?.reason || result.ocr?.status || 'sin_texto_detectado';
      return `- Imagen ${index + 1}: ${ocrMetaLine(result.file, result.ocr)}; resultado=${reason}`;
    });
    return {
      block: [
        '## FLASHGPT OCR VISUAL BRIDGE',
        'FlashGPT es un modelo de texto. Se intento leer las imagenes adjuntas con OCR local gratuito, pero no se detecto texto confiable.',
        ...failureLines,
        'Instruccion: si el usuario pregunta por contenido visual no textual, explica con honestidad que FlashGPT solo puede usar texto OCR y pide una descripcion o un modelo con vision.',
      ].join('\n'),
      files: enrichedFiles,
      imageCount: imageFiles.length,
      readableCount: 0,
      failedCount: failed.length,
    };
  }

  const blocks = readable.map((result, index) => {
    const answerHints = buildVisualAnswerHints(result.text, prompt);
    return [
      `### Imagen OCR ${index + 1}`,
      ocrMetaLine(result.file, result.ocr),
      answerHints ? `\n${answerHints}` : '',
      '',
      compactText(result.text, perImageBudget),
    ].filter((part) => part !== '').join('\n');
  });

  return {
    block: [
      '## FLASHGPT OCR VISUAL BRIDGE',
      'FlashGPT no recibe pixeles directamente. Las imagenes adjuntas fueron convertidas a texto con OCR local gratuito antes de llamar al modelo.',
      'Instrucciones:',
      '- Usa este OCR como evidencia principal para responder sobre las imagenes.',
      '- Para preguntas como "cual es el monto", "saldo", "disponible" o "total", identifica el monto principal por etiquetas cercanas como Disponible/Saldo/Total y responde directo con ese valor.',
      '- Si el OCR es parcial, dilo con precision y no inventes detalles visuales no presentes en el texto.',
      '- Conserva formulas, numeros, nombres, tablas y saltos de linea utiles.',
      '',
      ...blocks,
    ].join('\n'),
    files: enrichedFiles,
    imageCount: imageFiles.length,
    readableCount: readable.length,
    failedCount: failed.length,
  };
}

module.exports = {
  buildFlashGptImageOcrContext,
  buildVisualAnswerHints,
  compactText,
  extractMoneyCandidates,
  extractLocalImageText,
  isImageAttachment,
};
