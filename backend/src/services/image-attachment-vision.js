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

// «transcribe esta foto», «qué dice», «pásalo a texto», «copia el texto»,
// «lee este documento», «extract the text»… (server port of
// lib/chat/ocr-preprocess.ts looksLikeTranscriptionRequest, extended).
// «qué dice» counts, «haz lo que dice» does not (that is an instruction to
// follow): «lo que dice» only with a reading verb in front of it.
const TRANSCRIPTION_REQUEST_RE = /(?:\btrans?cr[ií](?:b|p)\w*|\btrascr[ií](?:b|p)\w*|\bocr\b|(?<!\blo\s)qu[eé]\s+(?:dice|pone|est[aá]\s+escrito)|\b(?:dime|d[ií]game|lee|l[eé]eme|copia|c[oó]piame|escribe|escr[ií]beme)\s+lo\s+que\s+(?:dice|pone)|\bp[aá]s(?:a|alo|ala|ar|ame|amelo)(?:\s+(?:esto|eso|est[ae]\s+\S+|l[ao]s?\s+\S+|el\s+\S+))?\s+(?:a|en)\s+(?:texto|word|limpio)|\bcopi(?:a|ame|ar|alo)\s+(?:el|todo\s+el|los)\s+textos?|\bextra(?:e|er|eme)\s+(?:el|todo\s+el|los)\s+textos?|\b(?:lee|leer|leeme|léeme|lees)\s+(?:el|la|este|esta|lo\s+que)\s+(?:texto|imagen|foto|captura|documento|dice|escrito|letra)|\bwhat\s+does\s+(?:it|this|the\s+\w+)\s+say|\b(?:read|extract|copy)\s+(?:out\s+)?(?:all\s+)?(?:the\s+)?text)/iu;

// Another operation on the text (translate, summarise, solve, explain…)
// turns the request into a TASK: the copy-only protocol would refuse it.
// Verb forms only, so «transcribe la explicación de la pizarra» or «the
// answers» stay transcriptions.
const OTHER_OPERATION_RE = /(?:\btrad[uú]c(?:e|es|ir|irlo|irla|irlos|iendo|elo|ela|elos|elas|eme|emelo|[ií]melo)\b|\btraduzc\w*|\btranslat(?:e|es|ed|ing)\b|\bres[uú]m(?:e|es|a|as|ir|irlo|irla|iendo|elo|ela|eme|emelo)\b|\bsummari[sz](?:e|ing)\b|\bsum\s+(?:it\s+)?up\b|\bresu[eé]lv\w*|\bresolv(?:er|erlo|erla|iendo)\b|\bsolv(?:e|ing)\b|\bexpl[ií]c(?:a|as|ar|arlo|arla|ame|amelo|alo|ala|ando)\b|\bexpliqu\w*|\bexplain\w*|\banal[ií]z(?:a|as|ar|arlo|arla|alo|ala|ame|ando|e|es)\b|\banaly[sz](?:e|ing)\b|\bcorr[ií]g(?:e|es|elo|ela|eme)\b|\bcorreg(?:ir|irlo|irla|ido)\b|\bcorrij\w*|\bcorrect(?:\s+(?:it|this|the|my|any)\b|ing\b)|\bcalcul(?:a|as|ar|arlo|alo|ame|e|es|ate|ating)\b|\bderiv(?:a|ar|ala|alo|e)\b|\bdifferentiate\b|\binterpret(?:a|as|ar|arlo|alo|ame|e)?\b|\bsignific(?:a|an|ado)\b|\bwhat\s+does\s+(?:it|this|that)\s+mean\b|\bmeaning\b|\bcompar(?:a|as|ar|arlo|alo|e|es)\b|\bcompare\b|\bresp[oó]nd(?:e|es|er|elo|eme|a|as)\b|\bcontest(?:a|as|ar|alo|ame|e)\b|\banswer\s+(?:it|this|that|them|the\s+(?:question|exercise|problem)s?)\b|\bopin(?:a|as|ar|ame|e)\b|\beval[uú](?:a|as|ar|alo|e)\b|\bevaluate\b|\bde\s+qu[eé]\s+trata\b)/iu;

// «transcribe sin traducir», «no lo corrijas», «don't translate»: a negated
// operation is part of the copy contract, not another task.
const NEGATED_OPERATION_RE = /\b(?:sin|no|ni|nunca|without|don['’]?t|do\s+not|never)\s+(?:(?:lo|la|los|las|me|te|se|le|les|nada|el|la|the|it|any|anything)\s+){0,2}(?:trad[uú]c\w*|traduzc\w*|translat\w*|res[uú]m\w*|summari[sz]\w*|corr[ií]g\w*|correg\w*|corrij\w*|correct\w*|explic\w*|expliqu\w*|explain\w*|interpret\w*|resolv\w*|resu[eé]lv\w*|solv\w*|analiz\w*|analy[sz]\w*)/giu;

/**
 * The user asks ONLY to transcribe / read out the text of the image. A turn
 * that also asks for another operation («traduce lo que dice», «lee la
 * imagen y resuelve el ejercicio») is a task, not a transcription.
 */
function isTranscriptionRequest(text) {
  const source = String(text || '');
  if (!TRANSCRIPTION_REQUEST_RE.test(source)) return false;
  return !OTHER_OPERATION_RE.test(source.replace(NEGATED_OPERATION_RE, ' '));
}

// Header fileProcessor writes over OCR text, with the engines and the
// confidence of the read: «Imagen — fotografía (1200×1600 px) — 845
// caracteres extraídos · OCR: GLM-OCR (local) + Gemini · confianza media (72 %)».
const OCR_HEADER_RE = /^(Imagen — [^\n]*?|PDF OCR document — [^\n]*?)(?: · OCR: ([^\n·]+?) · confianza (alta|media|baja) \((\d{1,3}) %\))?\n---\n/u;

/**
 * Split stored OCR text into its provenance header and the body:
 * { header, body, engines, level, confidence, kind: 'image'|'pdf'|null }.
 * Text without a header comes back as the body with nulls.
 */
function parseOcrProvenance(text) {
  const source = String(text || '');
  const match = OCR_HEADER_RE.exec(source);
  if (!match) return { header: null, body: source, engines: null, level: null, confidence: null, kind: null };
  return {
    header: match[0].trim(),
    body: source.slice(match[0].length),
    engines: match[2] ? match[2].trim() : null,
    level: match[3] || null,
    confidence: match[4] ? Number(match[4]) : null,
    kind: match[1].startsWith('Imagen') ? 'image' : 'pdf',
  };
}

/**
 * Spanish label for OCR text injected into a prompt: engine(s) + confidence,
 * and how far the model may trust it. Unknown provenance is never presented
 * as exact.
 */
function describeOcrProvenance(provenance) {
  const prov = provenance || {};
  if (!prov.level) return 'texto leído por OCR, confianza desconocida; puede contener errores';
  const engines = prov.engines ? `motor: ${prov.engines}` : 'motor OCR';
  const base = `texto leído por OCR — ${engines}, confianza ${prov.level}${Number.isFinite(prov.confidence) ? ` (${prov.confidence} %)` : ''}`;
  if (prov.level === 'baja') return `${base}; puede tener errores: verifícalo contra la imagen y no lo des por exacto`;
  if (prov.level === 'media') return `${base}; puede tener errores puntuales`;
  return base;
}

/**
 * The single-attachment branch of the chat route injects the uploaded-file
 * context as built by message-attachments (it never goes through the
 * per-file describer): prefix it with the same OCR provenance label, so OCR
 * text on a text-only turn is never taken as exact. Returns the context
 * unchanged for non-OCR files.
 */
function labelUploadedOcrContext(context, file, { isImage = false, imageAttached = false } = {}) {
  const text = String(context || '');
  if (!text || !file) return text;
  const extracted = typeof file.extractedText === 'string' ? file.extractedText : '';
  if (!extracted.trim()) return text;
  const prov = parseOcrProvenance(extracted);
  if (!prov.header && !isImage) return text;
  const pixelsNote = isImage && imageAttached ? '; la imagen adjunta manda' : '';
  const name = String(file.name || file.originalName || 'archivo').replace(/[\r\n]+/g, ' ').slice(0, 200);
  return `[Contenido de «${name}»: ${describeOcrProvenance(prov)}${pixelsNote}]\n${text}`;
}

/**
 * Verbatim transcription contract (photo / scan / screenshot). Shared by the
 * chat stream (routes/ai.js) and the vision recovery path below.
 */
function buildImageTranscriptionProtocol() {
  return [
    'IMAGE TRANSCRIPTION PROTOCOL (the user asked to transcribe / read the image):',
    '- Copy the visible text VERBATIM, in reading order, keeping line breaks, headings, lists and tables (Markdown tables). Keep the original language, spelling and accents; do NOT translate, correct, summarize, reorder or complete anything.',
    '- Transcribe only what you can actually read in the pixels. A word or passage you cannot read → [ilegible]. A word you can partly read but are not sure of → [¿palabra?]. Never guess names, numbers, amounts, dates or codes: copy them character by character or mark them [ilegible].',
    '- An OCR reading may be attached below with its engine and confidence. Use it only as a cross-check: where it disagrees with the image, the image wins; where neither is legible, write [ilegible]. Its own [ilegible] / [¿…?] marks are honest gaps — keep them unless the image clearly shows the text.',
    '- Write math in LaTeX ($...$ inline, $$...$$ display).',
    '- After the transcription, add ONE short line only if parts were illegible (e.g. «Partes ilegibles: 2»). No other commentary, no summary.',
  ].join('\n');
}

/**
 * Task-first instruction: the user's text is the TASK, the image the content.
 * Mirrors the chat stream's IMAGE TASK PROTOCOL so "resolver" solves instead
 * of transcribing, and OCR text (when any) is offered only as a labelled hint
 * (engine + confidence). A transcription request gets the verbatim protocol
 * with the [ilegible] convention instead.
 */
function buildImageTaskText(prompt = '', { ocrHint = '', transcription } = {}) {
  const task = String(prompt || '').trim() || 'Analiza la imagen adjunta y responde.';
  const wantsTranscription = typeof transcription === 'boolean' ? transcription : isTranscriptionRequest(task);
  const prov = parseOcrProvenance(ocrHint);
  const hintBody = String(prov.body || '').trim();
  const hintLabel = describeOcrProvenance(prov);
  if (wantsTranscription) {
    return [
      task,
      '',
      buildImageTranscriptionProtocol(),
      hintBody ? `\nOCR adjunto (${hintLabel}; la imagen manda):\n${hintBody.slice(0, 6000)}` : '',
    ].filter(Boolean).join('\n').trim();
  }
  return [
    task,
    '',
    'IMAGE TASK PROTOCOL: the attached image(s) are vision inputs in this same message — inspect them directly.',
    '- The user\'s instruction is the TASK; the image is the CONTENT it applies to.',
    '- A brief instruction ("resolver", "resuelve", "calcula", "explica", "traduce", "qué dice") means: perform that operation completely on what the image shows (e.g. expand/solve the math step by step and give the final result).',
    '- Do not answer with only a transcription unless the user asks for one. Read the image yourself; if part of it is not legible, mark that part [ilegible] instead of guessing it.',
    '- Format math in LaTeX ($...$ inline, $$...$$ display). Answer in the user\'s language (Spanish by default).',
    hintBody ? `\nOCR preliminar (${hintLabel}; la imagen manda): ${hintBody.slice(0, 2000)}` : '',
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
 * `{ text, provider, model, attempts, request, pickedOnly, error }` — `text`
 * is '' when no runtime answered (callers then show
 * buildImageVisionUnavailableAnswer, or, for `pickedOnly`, the picked model's
 * exact failure from `error`).
 *
 * `pinned`: the user picked the model (owner policy: a picked model is never
 * switched). When it can see, it is the ONLY runtime tried; a text-only pick
 * still goes to the vision runtimes (it cannot read pixels at all).
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
  pinned = false,
} = {}) {
  const images = imageAttachments(imageFiles);
  const result = { text: '', provider: null, model: null, attempts: [], request: null, pickedOnly: false, error: null };
  if (images.length === 0 || typeof getClient !== 'function') return result;
  const content = await buildImageVisionContent({ prompt, imageFiles: images, prepareImage, ocrHint });
  if (!hasImagePart(content)) return result;
  const wantsTranscription = isTranscriptionRequest(prompt);
  let runtimes = visionRuntimesForTurn(provider, model, env);
  if (pinned && provider && model && modelSupportsVision(provider, model)) {
    runtimes = runtimes.slice(0, 1);
    result.pickedOnly = true;
  }
  for (const runtime of runtimes) {
    if (signal && signal.aborted) break;
    const runtimeModel = normalizeModel(runtime.provider, runtime.model) || runtime.model;
    const request = {
      model: runtimeModel,
      messages: [{ role: 'user', content }],
      stream: false,
      // A transcription is a copy, not a composition: temperature 0.
      temperature: wantsTranscription ? 0 : 0.2,
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
      result.error = err;
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
  TRANSCRIPTION_REQUEST_RE,
  isTranscriptionRequest,
  parseOcrProvenance,
  describeOcrProvenance,
  labelUploadedOcrContext,
  buildImageTranscriptionProtocol,
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
