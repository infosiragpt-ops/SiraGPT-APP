'use strict';

/**
 * anthropic-citations — wrapper around Anthropic's Citations API for
 * grounded document Q&A.
 *
 * Why a dedicated module:
 *   The existing `citation-engine.js` does post-hoc string-matching to
 *   attach citation footnotes to a Claude response. That works but
 *   relies on the model echoing exact substrings, and the offsets are
 *   reconstructed by us — sometimes wrong on tables, lists, or
 *   reordered text.
 *
 *   Anthropic's Citations API returns citations as STRUCTURED metadata
 *   on each generated text block, with character (or page) offsets
 *   into the original document. The model never has to "re-quote";
 *   the SDK gives us the exact pointer + the verbatim cited_text. This
 *   removes a whole class of "citation says X but the doc says Y"
 *   bugs and is what Anthropic recommends today over prompt-based
 *   citation injection.
 *
 * Public API:
 *   callAnthropicWithCitations({ system, messages, documents, model, options })
 *     → { text, blocks, citations, usage, raw }
 *
 *   normalizeCitations(content) → { text, blocks, citations }
 *     (pure helper, useful in tests + non-SDK call paths)
 *
 *   buildDocumentBlocks(documents) → AnthropicContentBlock[]
 *     (turn our `{ type, title, data, mediaType? }[]` into the SDK shape)
 *
 * Compatibility:
 *   - text and PDF documents are supported. Citations + Structured
 *     Outputs cannot be combined in the same call (Anthropic limitation,
 *     verified May 2026); use this for citation-grounded answers and
 *     route structured-extraction calls through anthropic-native /
 *     openai instead.
 *   - The SDK is loaded lazily via dynamic import so requiring this
 *     module is cheap; tests inject a fake client via _setClientForTests.
 */

const native = require('./anthropic-native');

const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.ANTHROPIC_CITATIONS_MAX_TOKENS, 10) || 4096;
const DEFAULT_MODEL = process.env.ANTHROPIC_CITATIONS_DEFAULT_MODEL || 'claude-sonnet-4-6';

let _SdkClass = null;
let _client = null;

async function loadSdkClass() {
  if (_SdkClass) return _SdkClass;
  const mod = await import('@anthropic-ai/sdk');
  _SdkClass = mod.default || mod.Anthropic;
  if (typeof _SdkClass !== 'function') {
    throw new Error('@anthropic-ai/sdk did not export a constructor');
  }
  return _SdkClass;
}

async function getClient() {
  if (_client) return _client;
  if (!native.isEnabled()) return null;
  const Sdk = await loadSdkClass();
  _client = new Sdk({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * @typedef {Object} CitationDoc
 * @property {'text'|'pdf'|'custom_content'} type
 * @property {string} title
 * @property {string} data           text body OR base64 PDF OR newline-separated
 *                                   chunks for 'custom_content'
 * @property {string} [mediaType]    'text/plain' (default for 'text') or
 *                                   'application/pdf' (default for 'pdf')
 * @property {string} [context]      free-form metadata block sent alongside
 *                                   the document (e.g. provenance)
 */

/**
 * Translate our document shape into the SDK's content-block shape.
 * Each document becomes one `{ type: 'document', source, title, citations: { enabled: true }, ... }`
 * block. The SDK will then attach citations referencing each document
 * by its index in this array.
 */
function buildDocumentBlocks(documents) {
  if (!Array.isArray(documents)) return [];
  const out = [];
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;
    const type = String(doc.type || 'text').toLowerCase();
    const title = typeof doc.title === 'string' && doc.title.length > 0 ? doc.title : 'document';

    let source;
    if (type === 'text') {
      const data = String(doc.data || '');
      if (!data) continue;
      source = {
        type: 'text',
        media_type: doc.mediaType || 'text/plain',
        data,
      };
    } else if (type === 'pdf') {
      const data = String(doc.data || '');
      if (!data) continue;
      source = {
        type: 'base64',
        media_type: doc.mediaType || 'application/pdf',
        data,
      };
    } else if (type === 'custom_content') {
      // Custom-content lets the caller pass an array of pre-segmented
      // text chunks; citations come back referencing chunk index. The
      // shape is documented at platform.claude.com/docs/.../citations.
      const chunks = Array.isArray(doc.chunks) ? doc.chunks : null;
      if (!chunks || chunks.length === 0) continue;
      source = {
        type: 'content',
        content: chunks.map((c) => ({
          type: 'text',
          text: typeof c === 'string' ? c : String(c?.text || ''),
        })).filter((c) => c.text.length > 0),
      };
    } else {
      continue;
    }

    const block = {
      type: 'document',
      source,
      title,
      citations: { enabled: true },
    };
    if (typeof doc.context === 'string' && doc.context.length > 0) {
      block.context = doc.context;
    }
    out.push(block);
  }
  return out;
}

/**
 * Translate our message envelope into the SDK shape. The user prompt
 * is appended AFTER the document blocks in the same user message —
 * Anthropic recommends documents-then-question ordering so the model
 * has the source material in context before it reads the question.
 *
 * For multi-turn threads, we keep prior turns intact and only attach
 * the documents to the LAST user turn. This avoids re-uploading the
 * same document on every turn (and matches how chat UIs usually
 * surface a "documents in context" indicator on the active turn).
 */
function buildMessages(messages, documentBlocks) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant')) : [];

  // Fast path: caller passed no messages, just documents — synthesise
  // one user turn with the documents and a "summarise" hint.
  if (list.length === 0) {
    return [{
      role: 'user',
      content: [
        ...documentBlocks,
        { type: 'text', text: 'Resume y responde basándote únicamente en los documentos anteriores.' },
      ],
    }];
  }

  // Find the last user turn and prepend documents to its content.
  const lastUserIdx = (() => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user') return i;
    }
    return -1;
  })();

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (i !== lastUserIdx) {
      out.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    // Last user turn — attach documents.
    const userText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    out.push({
      role: 'user',
      content: [
        ...documentBlocks,
        { type: 'text', text: userText },
      ],
    });
  }
  return out;
}

/**
 * Walk the response content array, separating plain text from cited
 * spans. Returns:
 *   - text: concatenated text (for quick rendering / logging)
 *   - blocks: per-block view with `text` and `citations[]` so the UI
 *     can underline / footnote the cited spans
 *   - citations: a flat, deduped list keyed by document_index +
 *     start/end so the caller can render a "References" panel
 *
 * Citation entries are NORMALISED into a single shape regardless of
 * whether Anthropic returned a char_location, page_location, or
 * content_block_location.
 */
function normalizeCitations(content) {
  const safe = Array.isArray(content) ? content : [];
  const blocks = [];
  let textOut = '';

  const seen = new Map();
  const flat = [];

  for (const block of safe) {
    if (!block || block.type !== 'text') continue;
    const text = typeof block.text === 'string' ? block.text : '';
    const rawCitations = Array.isArray(block.citations) ? block.citations : [];

    const blockCitations = rawCitations
      .map((c) => normalizeOneCitation(c))
      .filter(Boolean);

    blocks.push({ text, citations: blockCitations });
    textOut += text;

    for (const c of blockCitations) {
      const key = `${c.documentIndex}:${c.kind}:${c.start ?? ''}:${c.end ?? ''}:${c.cited.slice(0, 64)}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      flat.push(c);
    }
  }

  return { text: textOut, blocks, citations: flat };
}

function normalizeOneCitation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cited = typeof raw.cited_text === 'string' ? raw.cited_text : '';
  const documentIndex = Number.isInteger(raw.document_index) ? raw.document_index : -1;
  const documentTitle = typeof raw.document_title === 'string' ? raw.document_title : null;

  switch (raw.type) {
    case 'char_location':
      return {
        kind: 'char',
        documentIndex,
        documentTitle,
        cited,
        start: Number.isInteger(raw.start_char_index) ? raw.start_char_index : null,
        end: Number.isInteger(raw.end_char_index) ? raw.end_char_index : null,
      };
    case 'page_location':
      return {
        kind: 'page',
        documentIndex,
        documentTitle,
        cited,
        start: Number.isInteger(raw.start_page_number) ? raw.start_page_number : null,
        end: Number.isInteger(raw.end_page_number) ? raw.end_page_number : null,
      };
    case 'content_block_location':
      return {
        kind: 'block',
        documentIndex,
        documentTitle,
        cited,
        start: Number.isInteger(raw.start_block_index) ? raw.start_block_index : null,
        end: Number.isInteger(raw.end_block_index) ? raw.end_block_index : null,
      };
    default:
      return null;
  }
}

/**
 * High-level entry point — invoke Anthropic with citations enabled.
 *
 * @param {object} args
 * @param {string|null} [args.system]   system prompt
 * @param {Array<{role:'user'|'assistant', content:string}>} [args.messages]
 * @param {CitationDoc[]} [args.documents]
 * @param {object} [args.options]
 * @param {string} [args.options.model]
 * @param {number} [args.options.maxTokens]
 * @param {number} [args.options.temperature]
 *
 * @returns {Promise<{
 *   text: string,
 *   blocks: Array<{text:string, citations:Array}>,
 *   citations: Array,
 *   usage: {input_tokens:number, output_tokens:number},
 *   raw: object|null,
 * }>}
 */
async function callAnthropicWithCitations({ system = null, messages = [], documents = [], options = {} } = {}) {
  const client = await getClient();
  if (!client) {
    const err = new Error('anthropic-citations disabled: set ANTHROPIC_API_KEY');
    err.code = 'anthropic_citations_disabled';
    throw err;
  }
  const docBlocks = buildDocumentBlocks(documents);
  if (docBlocks.length === 0) {
    const err = new Error('anthropic-citations: at least one document is required');
    err.code = 'anthropic_citations_no_documents';
    throw err;
  }

  const model = options.model || DEFAULT_MODEL;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;

  const sdkMessages = buildMessages(messages, docBlocks);

  let resp;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: typeof system === 'string' && system.length > 0 ? system : undefined,
      messages: sdkMessages,
    });
  } catch (err) {
    const wrapped = new Error(`anthropic-citations call failed: ${err && err.message}`);
    wrapped.code = 'anthropic_citations_llm_failed';
    wrapped.cause = err;
    throw wrapped;
  }

  const normalized = normalizeCitations(resp?.content);
  return {
    text: normalized.text,
    blocks: normalized.blocks,
    citations: normalized.citations,
    usage: {
      input_tokens: resp?.usage?.input_tokens ?? 0,
      output_tokens: resp?.usage?.output_tokens ?? 0,
    },
    raw: resp || null,
  };
}

// ── Test seams ────────────────────────────────────────────────────────────
function _setClientForTests(client) { _client = client; }
function _resetClientForTests() { _client = null; _SdkClass = null; }

module.exports = {
  callAnthropicWithCitations,
  normalizeCitations,
  normalizeOneCitation,
  buildDocumentBlocks,
  buildMessages,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  _setClientForTests,
  _resetClientForTests,
};
