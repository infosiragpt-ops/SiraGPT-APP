'use strict';

/**
 * vision-doc-parser — structured layout extraction from a document
 * page image using GPT-4o vision (or any OpenAI vision model).
 *
 * Why this and not Granite-Docling / dots.ocr?
 *   The "real" SOTA path for document parsing is a dedicated layout
 *   model (Granite-Docling-258M, dots.ocr) that emits structured
 *   DocTags with layout, tables, equations, captions, reading order
 *   in a single forward pass. Those models need GPU inference (or a
 *   hosted endpoint we don't have). This module is the LITE
 *   alternative: it reuses the OpenAI client we already pay for and
 *   asks GPT-4o vision to emit the same kind of structure via
 *   Structured Outputs strict mode. Lower fidelity than a dedicated
 *   model but zero new infrastructure, and meaningfully better than
 *   Tesseract for tables, equations, and multi-column reading order.
 *
 * What it produces (DocumentLayout):
 *   {
 *     language,
 *     elements: [
 *       { type, readingOrder, text, level?, rows? }
 *     ],
 *     hasTables, hasFigures, hasMath,
 *     meta: { model, inputBytes, truncated? }
 *   }
 *
 *   Element types:
 *     - heading      ({level: 1..6})
 *     - paragraph
 *     - list         (text contains the bullets joined by \n)
 *     - table        (text is markdown table; rows = number of rows)
 *     - figure       (text describes the figure)
 *     - caption      (caption text — usually follows a figure)
 *     - code         (code block; text preserves indentation)
 *     - equation     (LaTeX in text; $$…$$ or $…$)
 *     - footnote
 *     - other
 *
 * Public API:
 *   parseDocumentPage({ openai, image, options })
 *     → DocumentLayout
 *
 *   parseDocumentPagesBatch({ openai, images, options })
 *     → Array<{ ...DocumentLayout, pageIndex }>
 *
 *   buildImageInput(image) → SDK content shape
 *     pure helper that handles both base64 strings and URLs
 *
 *   STRICT_SCHEMA — exported so callers can introspect the contract
 *
 * Failure modes (Error.code):
 *   vision_doc_no_client       missing openai client
 *   vision_doc_bad_args        no image / bad image shape
 *   vision_doc_llm_failed      SDK threw
 *   vision_doc_invalid_json    model returned non-JSON
 */

const { asyncPool } = require('../../utils/async-pool');

const DEFAULT_MODEL = process.env.SIRAGPT_VISION_DOC_MODEL || 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.SIRAGPT_VISION_DOC_MAX_TOKENS, 10) || 3000;
const DEFAULT_DETAIL = process.env.SIRAGPT_VISION_DOC_DETAIL || 'auto'; // 'auto' | 'low' | 'high'
const DEFAULT_BATCH_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SIRAGPT_VISION_DOC_CONCURRENCY, 10) || 3);

const ELEMENT_TYPES = Object.freeze([
  'heading', 'paragraph', 'list', 'table', 'figure',
  'caption', 'code', 'equation', 'footnote', 'other',
]);

const SYSTEM_PROMPT = `You are a document layout parser. You are given an image of a single page from a document. Emit the page contents as a STRUCTURED list of elements in READING ORDER.

OUTPUT (STRICT JSON):
{
  "language": "es" | "en" | "fr" | "pt" | "de" | "other",
  "elements": [
    {
      "type": "heading" | "paragraph" | "list" | "table" | "figure" | "caption" | "code" | "equation" | "footnote" | "other",
      "readingOrder": <integer 1-N, no gaps>,
      "text": "<the element's text content>",
      "level": <1-6, ONLY for type=heading; 0 otherwise>,
      "rows": <integer, ONLY for type=table; 0 otherwise>
    }
  ],
  "hasTables": <bool>,
  "hasFigures": <bool>,
  "hasMath": <bool>
}

RULES:
- ONE element per logical block. Do not split a paragraph into sentences.
- "list" — combine bullets into ONE element; preserve bullets in text via "\\n- " separators.
- "table" — emit a Markdown table as text; set rows to (header + body) line count.
- "figure" — describe what the figure or chart depicts in 1-2 sentences (text). Include axis labels / colours / trend if visible.
- "caption" — a caption that explains a nearby figure / table.
- "equation" — preserve LaTeX with $...$ for inline or $$...$$ for display.
- "code" — preserve indentation; keep the language hint in a fenced block if shown.
- readingOrder is a 1-based contiguous integer; do NOT skip numbers.
- For elements where level/rows do not apply, set them to 0 (NOT null) — strict schema requires them present.
- Skip headers, page numbers, and recurring marginalia unless they convey content.
- Use the source language for all text. Do NOT translate.`;

const STRICT_SCHEMA = Object.freeze({
  name: 'document_layout',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      language: { type: 'string', enum: ['es', 'en', 'fr', 'pt', 'de', 'other'] },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...ELEMENT_TYPES] },
            readingOrder: { type: 'integer' },
            text: { type: 'string' },
            level: { type: 'integer' },
            rows: { type: 'integer' },
          },
          required: ['type', 'readingOrder', 'text', 'level', 'rows'],
        },
      },
      hasTables: { type: 'boolean' },
      hasFigures: { type: 'boolean' },
      hasMath: { type: 'boolean' },
    },
    required: ['language', 'elements', 'hasTables', 'hasFigures', 'hasMath'],
  },
});

/**
 * Translate our `image` argument into the SDK's image_url content
 * shape. Accepts:
 *   - { url: 'https://…' }     remote URL (passed through)
 *   - { url: 'data:…' }        data URL (passed through)
 *   - { base64, mediaType }    base64 + media type (we wrap into data URL)
 *   - 'https://…' string       URL shorthand
 *
 * Returns a single content block. Tests can verify both branches by
 * inspecting the resulting `image_url.url`.
 */
function buildImageInput(image, opts = {}) {
  const detail = opts.detail || DEFAULT_DETAIL;
  if (typeof image === 'string') {
    return { type: 'image_url', image_url: { url: image, detail } };
  }
  if (!image || typeof image !== 'object') {
    const err = new Error('vision-doc-parser: image must be a string URL or object');
    err.code = 'vision_doc_bad_args';
    throw err;
  }
  if (typeof image.url === 'string' && image.url.length > 0) {
    return { type: 'image_url', image_url: { url: image.url, detail } };
  }
  if (typeof image.base64 === 'string' && image.base64.length > 0) {
    const mediaType = image.mediaType || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image.base64}`, detail } };
  }
  const err = new Error('vision-doc-parser: image needs either url or base64');
  err.code = 'vision_doc_bad_args';
  throw err;
}

/**
 * Approximate the image payload size in bytes for telemetry. URL
 * images contribute the URL length only; base64 contributes the
 * decoded byte count.
 */
function estimateImageBytes(image) {
  if (typeof image === 'string') return image.length;
  if (image && typeof image.base64 === 'string') return Math.floor(image.base64.length * 0.75);
  if (image && typeof image.url === 'string') return image.url.length;
  return 0;
}

/**
 * Coerce arbitrary LLM output into the strict DocumentLayout shape.
 * Strict schema mode already guarantees the basic structure; this
 * pass enforces the contracts schema CANNOT enforce:
 *   - readingOrder is a contiguous 1..N integer sequence
 *   - element type falls into the ELEMENT_TYPES allowlist
 *   - level / rows fall into reasonable bounds
 *   - hasTables / hasFigures / hasMath are recomputed from elements
 *     so they cannot lie about content the model emitted
 */
function normalizeLayout(parsed, modelUsed, inputBytes, truncated) {
  const language = ['es', 'en', 'fr', 'pt', 'de', 'other'].includes(parsed?.language)
    ? parsed.language
    : 'other';

  const rawElements = Array.isArray(parsed?.elements) ? parsed.elements : [];
  const elements = [];
  let nextOrder = 1;
  for (const raw of rawElements) {
    if (!raw || typeof raw !== 'object') continue;
    const type = ELEMENT_TYPES.includes(raw.type) ? raw.type : 'other';
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (text.trim().length === 0) continue;
    let level = Number.isInteger(raw.level) ? raw.level : 0;
    if (type === 'heading') level = Math.min(6, Math.max(1, level || 1));
    else level = 0;
    let rows = Number.isInteger(raw.rows) && raw.rows > 0 ? raw.rows : 0;
    if (type !== 'table') rows = 0;
    elements.push({ type, readingOrder: nextOrder, text, level, rows });
    nextOrder += 1;
  }

  const hasTables = elements.some((e) => e.type === 'table');
  const hasFigures = elements.some((e) => e.type === 'figure');
  // Math signal: dedicated equation element OR LaTeX delimiters in any text.
  const hasMath = elements.some((e) => e.type === 'equation' || /\$[^$]+\$|\$\$[\s\S]+?\$\$/.test(e.text));

  return {
    language,
    elements,
    hasTables,
    hasFigures,
    hasMath,
    meta: { model: modelUsed, inputBytes, truncated },
  };
}

/**
 * Parse one document page image into a structured layout.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string|{url?:string, base64?:string, mediaType?:string}} args.image
 * @param {object} [args.options]
 * @param {string} [args.options.model]
 * @param {number} [args.options.maxTokens]
 * @param {'auto'|'low'|'high'} [args.options.detail]
 * @param {boolean} [args.options.useStrictSchema=true]
 * @param {string} [args.options.languageHint]
 *
 * @returns {Promise<DocumentLayout>}
 */
async function parseDocumentPage({ openai, image, options = {} } = {}) {
  if (!openai || !openai.chat || !openai.chat.completions || typeof openai.chat.completions.create !== 'function') {
    const err = new Error('parseDocumentPage: openai client is required');
    err.code = 'vision_doc_no_client';
    throw err;
  }
  if (!image) {
    const err = new Error('parseDocumentPage: image is required');
    err.code = 'vision_doc_bad_args';
    throw err;
  }

  const imageContent = buildImageInput(image, options);
  const inputBytes = estimateImageBytes(image);

  const useStrictSchema = options.useStrictSchema !== false;
  const responseFormat = useStrictSchema
    ? { type: 'json_schema', json_schema: STRICT_SCHEMA }
    : { type: 'json_object' };

  const userParts = [];
  if (options.languageHint) userParts.push({ type: 'text', text: `Probable language: ${options.languageHint}` });
  userParts.push({ type: 'text', text: 'Parse the page below into the structured layout schema.' });
  userParts.push(imageContent);

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: options.model || DEFAULT_MODEL,
      temperature: 0.0,
      max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS,
      response_format: responseFormat,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userParts },
      ],
    });
  } catch (err) {
    const wrapped = new Error(`vision-doc-parser LLM call failed: ${err && err.message}`);
    wrapped.code = 'vision_doc_llm_failed';
    wrapped.cause = err;
    throw wrapped;
  }

  const raw = resp?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`vision-doc-parser could not parse JSON: ${err && err.message}`);
    wrapped.code = 'vision_doc_invalid_json';
    wrapped.cause = err;
    wrapped.rawLength = raw.length;
    throw wrapped;
  }

  return normalizeLayout(parsed, options.model || DEFAULT_MODEL, inputBytes, false);
}

/**
 * Bounded-concurrency batch parser. Each result carries the original
 * pageIndex so callers can reorder if they kicked off a non-sequential
 * batch. Failed pages produce a stub layout with `meta.error` set so
 * the caller can render partial results without branching on rejected
 * promises.
 */
async function parseDocumentPagesBatch({ openai, images, options = {} } = {}) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : DEFAULT_BATCH_CONCURRENCY;

  const results = await asyncPool({
    items: images,
    concurrency,
    signal: options.signal,
    mode: 'settle',
    worker: async (image, index) => {
      try {
        const layout = await parseDocumentPage({ openai, image, options });
        return { ...layout, pageIndex: index };
      } catch (err) {
        return {
          language: 'other',
          elements: [],
          hasTables: false,
          hasFigures: false,
          hasMath: false,
          meta: { model: options.model || DEFAULT_MODEL, inputBytes: estimateImageBytes(image), truncated: false, error: err && err.message },
          pageIndex: index,
        };
      }
    },
  });

  return results.map((r, i) => (
    r && r.status === 'fulfilled'
      ? r.value
      : {
        language: 'other',
        elements: [],
        hasTables: false,
        hasFigures: false,
        hasMath: false,
        meta: { model: options.model || DEFAULT_MODEL, inputBytes: 0, truncated: false, error: r?.reason?.message },
        pageIndex: i,
      }
  ));
}

module.exports = {
  parseDocumentPage,
  parseDocumentPagesBatch,
  buildImageInput,
  estimateImageBytes,
  normalizeLayout,
  ELEMENT_TYPES,
  SYSTEM_PROMPT,
  STRICT_SCHEMA,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
};
