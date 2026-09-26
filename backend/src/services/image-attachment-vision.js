'use strict';

/**
 * Image attachments always reach a vision model.
 *
 * Live incident 2026-09-25 (siragpt.com): a handwritten "(a+b)^2 =" photo +
 * "resolver" on Grok 4.6 came back as the document fallback «Recibí tu
 * archivo, pero no encontré texto suficiente…». The image had been treated
 * as a document: OCR produced ~3 useful characters and every recovery path
 * (chat stream recovery and the agent-task runner) fell through to
 * buildAttachmentUnavailableFallbackAnswer, a copy written for scanned PDFs.
 *
 * Contract enforced here:
 *   - An image is detected by MIME **or** extension (HEIC/octet-stream
 *     uploads included).
 *   - An image turn is answered by sending the pixels as an `image_url` part
 *     to a vision-capable model: the selected one when it can see, otherwise
 *     the configured vision runtimes (selectVisionRuntime order). OCR text may
 *     add context but is never the only input.
 *   - When no vision runtime answers, the user gets an image-specific notice —
 *     never the «no encontré texto suficiente» document copy.
 *
 * Pure module (no provider SDK / Prisma imports) so every rule is unit
 * testable with fake clients.
 */

const {
  modelSupportsVision,
  visionRuntimeCandidates,
} = require('./ai/vision-runtime');

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;
const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

function attachmentName(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return String(file.name || file.originalName || file.filename || file.path || '');
}

function attachmentMime(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.mimeType || file.mimetype || file.contentType || file.type || '').toLowerCase();
}

/** True for image attachments, by MIME or by file extension. SVG is excluded (not a raster vision input). */
function isImageAttachment(file) {
  if (!file) return false;
  const mime = attachmentMime(file);
  if (mime.startsWith('image/')) return mime !== 'image/svg+xml';
  if (typeof file === 'object' && file.type === 'image') return true;
  return IMAGE_EXT_RE.test(attachmentName(file));
}

/** MIME to use in the data URL: the stored one when it is image/*, else inferred from the extension. */
function imageMimeFor(file) {
  const mime = attachmentMime(file);
  if (mime.startsWith('image/')) return mime;
  const ext = (attachmentName(file).match(/\.([a-z0-9]+)$/i) || [])[1];
  return EXT_MIME[String(ext || '').toLowerCase()] || 'image/png';
}

function imageAttachments(files = []) {
  return (Array.isArray(files) ? files : []).filter(isImageAttachment);
}

/** Every attachment is an image (and there is at least one). */
function isImageOnlyAttachmentSet(files = []) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  return list.length > 0 && list.every(isImageAttachment);
}

/**
 * Task-first instruction: the user's text is the TASK, the image the content.
 * Mirrors the chat stream's IMAGE TASK PROTOCOL so "resolver" solves instead
 * of transcribing, and OCR text (when any) is offered only as a hint.
 */
function buildImageTaskText(prompt = '', { ocrHint = '' } = {}) {
  const task = String(prompt || '').trim() || 'Analiza la imagen adjunta y responde.';
  const hint = String(ocrHint || '').trim();
  return [
    task,
    '',
    'IMAGE TASK PROTOCOL: the attached image(s) are vision inputs in this same message — inspect them directly.',
    '- The user\'s instruction is the TASK; the image is the CONTENT it applies to.',
    '- A brief instruction ("resolver", "resuelve", "calcula", "explica", "traduce", "qué dice") means: perform that operation completely on what the image shows (e.g. expand/solve the math step by step and give the final result).',
    '- Do not answer with only a transcription unless the user asks for one. Never claim the image has no readable text: read it yourself.',
    '- Format math in LaTeX ($...$ inline, $$...$$ display). Answer in the user\'s language (Spanish by default).',
    hint ? `\nOCR preliminar (puede tener errores; la imagen manda): ${hint.slice(0, 2000)}` : '',
  ].filter((line) => line !== null).join('\n').trim();
}

/**
 * Build the user message content for a vision call: one text part plus one
 * `image_url` part per readable image. `prepareImage(path, mime)` returns an
 * `{ type: 'image_url', image_url: { url } }` part or null.
 */
async function buildImageVisionContent({ prompt = '', imageFiles = [], prepareImage, ocrHint = '' } = {}) {
  const content = [{ type: 'text', text: buildImageTaskText(prompt, { ocrHint }) }];
  if (typeof prepareImage !== 'function') return content;
  for (const file of imageFiles) {
    if (!file) continue;
    try {
      const part = await prepareImage(file.path, imageMimeFor(file));
      if (part && part.type === 'image_url' && part.image_url && part.image_url.url) content.push(part);
    } catch (_) { /* one unreadable image never drops the others */ }
  }
  return content;
}

function hasImagePart(content) {
  return Array.isArray(content) && content.some((part) => part && part.type === 'image_url');
}

/**
 * Ordered vision runtimes for an image turn: the selected model first when it
 * can see (the user's choice is respected), then every configured vision
 * runtime as a fallback. A text-only selection is never refused — it goes
 * straight to the vision runtimes. The default chat model policy is untouched:
 * this list is used only for turns that carry an image.
 */
function visionRuntimesForTurn(provider, model, env = process.env) {
  const out = [];
  const seen = new Set();
  const push = (p, m) => {
    if (!p || !m) return;
    const key = `${String(p).toLowerCase()}::${String(m).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider: p, model: m });
  };
  if (provider && model && modelSupportsVision(provider, model)) push(provider, model);
  for (const candidate of visionRuntimeCandidates(env)) push(candidate.provider, candidate.model);
  return out;
}

function completionText(completion) {
  const message = completion && completion.choices && completion.choices[0] && completion.choices[0].message;
  const content = message && message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('').trim();
  }
  return '';
}

/**
 * Answer an image turn with a vision model. Returns
 * `{ text, provider, model, attempts, request }` — `text` is '' when no
 * runtime answered (callers then show buildImageVisionUnavailableAnswer).
 */
async function answerImageTurnWithVision({
  prompt = '',
  imageFiles = [],
  provider = '',
  model = '',
  ocrHint = '',
  prepareImage,
  getClient,
  normalizeModel = (_p, m) => m,
  env = process.env,
  maxTokens = 4096,
  signal = null,
  logger = console,
} = {}) {
  const images = imageAttachments(imageFiles);
  const result = { text: '', provider: null, model: null, attempts: [], request: null };
  if (images.length === 0 || typeof getClient !== 'function') return result;
  const content = await buildImageVisionContent({ prompt, imageFiles: images, prepareImage, ocrHint });
  if (!hasImagePart(content)) return result;
  const runtimes = visionRuntimesForTurn(provider, model, env);
  for (const runtime of runtimes) {
    if (signal && signal.aborted) break;
    const runtimeModel = normalizeModel(runtime.provider, runtime.model) || runtime.model;
    const request = {
      model: runtimeModel,
      messages: [{ role: 'user', content }],
      stream: false,
      temperature: 0.2,
      max_tokens: maxTokens,
    };
    result.request = request;
    try {
      const client = getClient(runtime.provider);
      if (!client || !client.chat || !client.chat.completions) {
        result.attempts.push({ provider: runtime.provider, model: runtimeModel, ok: false, error: 'no_client' });
        continue;
      }
      const completion = await client.chat.completions.create(request, signal ? { signal } : undefined);
      const text = completionText(completion);
      result.attempts.push({ provider: runtime.provider, model: runtimeModel, ok: Boolean(text) });
      if (text) {
        result.text = text;
        result.provider = runtime.provider;
        result.model = runtimeModel;
        return result;
      }
    } catch (err) {
      result.attempts.push({ provider: runtime.provider, model: runtimeModel, ok: false, error: String((err && err.message) || err).slice(0, 200) });
      try { logger && logger.warn && logger.warn(`[image-vision] ${runtime.provider}:${runtimeModel} failed: ${(err && err.message) || err}`); } catch (_) { /* noop */ }
    }
  }
  return result;
}

/**
 * Honest notice when no vision runtime could read the image. Deliberately
 * different from the document copy: it never tells the user the picture had
 * "no text" nor asks for OCR — the problem is the vision service, not the file.
 */
function buildImageVisionUnavailableAnswer() {
  return [
    'Recibí tu imagen, pero el servicio de visión no respondió en este intento, así que no pude analizarla todavía.',
    '',
    '**Qué puedes hacer ahora:**',
    '- Envía el mismo mensaje otra vez en unos segundos: la imagen se volverá a enviar al modelo de visión.',
    '- Si lo prefieres, escribe aquí el contenido clave de la imagen y lo resuelvo de inmediato.',
  ].join('\n');
}

const NO_TEXT_FALLBACK_RE = /no\s+encontr[eé]\s+texto\s+suficiente/i;

function isNoTextFallback(text) {
  return NO_TEXT_FALLBACK_RE.test(String(text || ''));
}

module.exports = {
  IMAGE_EXT_RE,
  isImageAttachment,
  imageMimeFor,
  imageAttachments,
  isImageOnlyAttachmentSet,
  buildImageTaskText,
  buildImageVisionContent,
  hasImagePart,
  visionRuntimesForTurn,
  answerImageTurnWithVision,
  buildImageVisionUnavailableAnswer,
  isNoTextFallback,
  NO_TEXT_FALLBACK_RE,
};
