'use strict';

/**
 * contextual-chunking — Anthropic Contextual Retrieval (Sept 2024).
 *
 * What it does:
 *   For each chunk of a document, ask a small Claude model to write a
 *   50–100 token context block explaining where the chunk sits within
 *   the overall document. The block is prepended to the chunk text
 *   BEFORE embedding / BM25 indexing. Anthropic's evaluation shows
 *   this reduces retrieval failure rate by ~35% standalone, ~49% when
 *   combined with BM25, and up to ~67% when combined with reranking
 *   (https://www.anthropic.com/news/contextual-retrieval).
 *
 * Why it works:
 *   Plain chunking strips the surrounding context — a paragraph that
 *   says "the rate fell to 3.2%" loses the fact that "the rate" refers
 *   to the unemployment rate of Q2 2025. The contextual prefix
 *   ("This excerpt discusses the unemployment rate trend in Q2 2025…")
 *   restores that context so embeddings + lexical retrieval match the
 *   user's natural query.
 *
 * Cost shape (with Anthropic prompt caching):
 *   - The full document body lives in the cached system prompt.
 *   - Each chunk request reuses the cache → ~10× cheaper than
 *     re-sending the document on every call.
 *   - Reported cost: ~$1.02 per 1M document tokens (Anthropic blog).
 *
 * Interface:
 *   contextualizeChunks({ document, chunks, anthropic, options })
 *     → { contextualizedChunks, contextualized, failures, usage }
 *
 *   formatChunkForRetrieval(c) → string
 *     pure helper: concatenates "context\n\noriginal" for index time.
 *
 * Tests inject a fake Anthropic client via the standard SDK shape
 * `client.messages.create({...})`. Production wiring should pass the
 * Anthropic SDK instance (the same one used by anthropic-citations).
 */

const { asyncPool } = require('../../utils/async-pool');

const DEFAULT_MODEL = process.env.SIRAGPT_CONTEXTUAL_MODEL || 'claude-haiku-4-5';
const DEFAULT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SIRAGPT_CONTEXTUAL_CONCURRENCY, 10) || 4);
const DEFAULT_MAX_TOKENS = 200;
const DEFAULT_MAX_DOC_CHARS = 200_000;
const DEFAULT_MAX_CONTEXT_CHARS = 600;

const SYSTEM_TEMPLATE_PREFIX = '<document>\n';
const SYSTEM_TEMPLATE_SUFFIX = '\n</document>';

const CHUNK_PROMPT = (chunkText) => (
  `<chunk>\n${chunkText}\n</chunk>\n\n` +
  'Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer ONLY with the succinct context (50–100 tokens) and nothing else — no preamble, no commentary.'
);

/**
 * Build the cached system block. Anthropic's prompt-caching contract
 * requires the cached portion to be a `text` block with
 * `cache_control: { type: 'ephemeral' }`. The system block stays
 * identical across every chunk request for the same document, so the
 * cache is hit on every chunk after the first.
 */
function buildSystemBlock(document, opts = {}) {
  const maxChars = Number.isFinite(opts.maxDocChars) ? opts.maxDocChars : DEFAULT_MAX_DOC_CHARS;
  const truncated = document.length > maxChars;
  const body = truncated ? `${document.slice(0, maxChars)}\n\n[…document truncated for context generation…]` : document;
  return [
    {
      type: 'text',
      text: `${SYSTEM_TEMPLATE_PREFIX}${body}${SYSTEM_TEMPLATE_SUFFIX}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Pull text out of an Anthropic response's content blocks. Identical
 * idea to anthropic-native's extractText, duplicated here to avoid a
 * cross-module require for one helper.
 */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

function clampContext(text, max = DEFAULT_MAX_CONTEXT_CHARS) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

/**
 * Contextualize an array of chunks.
 *
 * @param {object} args
 * @param {string} args.document         full document text
 * @param {Array<{id?:string, text:string}>|string[]} args.chunks
 *                                       chunks to contextualize; strings or
 *                                       `{ id, text }` objects
 * @param {object} args.anthropic        SDK client (with .messages.create)
 * @param {object} [args.options]
 * @param {string} [args.options.model]
 * @param {number} [args.options.concurrency]
 * @param {number} [args.options.maxTokens]
 * @param {number} [args.options.maxDocChars]
 * @param {number} [args.options.maxContextChars]
 * @param {AbortSignal} [args.options.signal]
 *
 * @returns {Promise<{
 *   contextualizedChunks: Array<{ id, original, context, contextualized }>,
 *   contextualized: string[],            // index-ready strings, in order
 *   failures: Array<{ index, reason }>,
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
 * }>}
 */
async function contextualizeChunks({ document, chunks, anthropic, options = {} } = {}) {
  if (!anthropic || !anthropic.messages || typeof anthropic.messages.create !== 'function') {
    const err = new Error('contextualizeChunks: anthropic client is required');
    err.code = 'contextual_no_client';
    throw err;
  }
  const docText = String(document || '').trim();
  if (!docText) {
    const err = new Error('contextualizeChunks: document is empty');
    err.code = 'contextual_empty_document';
    throw err;
  }
  const list = normalizeChunks(chunks);
  if (list.length === 0) {
    return { contextualizedChunks: [], contextualized: [], failures: [], usage: emptyUsage() };
  }

  const model = options.model || DEFAULT_MODEL;
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : DEFAULT_CONCURRENCY;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;
  const maxContextChars = Number.isFinite(options.maxContextChars) ? options.maxContextChars : DEFAULT_MAX_CONTEXT_CHARS;
  const system = buildSystemBlock(docText, options);

  const usage = emptyUsage();
  const failures = [];

  const results = await asyncPool({
    items: list,
    concurrency,
    signal: options.signal,
    mode: 'settle',
    worker: async (chunk, index) => {
      try {
        const resp = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          temperature: 0.0,
          system,
          messages: [{ role: 'user', content: CHUNK_PROMPT(chunk.text) }],
        });
        accumulateUsage(usage, resp?.usage);
        const context = clampContext(extractText(resp?.content), maxContextChars);
        return { context };
      } catch (err) {
        failures.push({ index, reason: err && err.message });
        return { context: '' };
      }
    },
  });

  const contextualizedChunks = results.map((r, i) => {
    // asyncPool 'settle' returns { status, value|reason } per item.
    const value = r && r.status === 'fulfilled' ? r.value : { context: '' };
    const original = list[i].text;
    const context = (value && value.context) || '';
    return {
      id: list[i].id ?? null,
      original,
      context,
      contextualized: context ? `${context}\n\n${original}` : original,
    };
  });

  // For unfulfilled items (asyncPool rejected paths) the worker has
  // already pushed to failures[]. Make sure index alignment matches.
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].status === 'rejected') {
      failures.push({ index: i, reason: results[i].reason && results[i].reason.message });
    }
  }

  return {
    contextualizedChunks,
    contextualized: contextualizedChunks.map((c) => c.contextualized),
    failures,
    usage,
  };
}

function normalizeChunks(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks
    .map((c, i) => {
      if (typeof c === 'string') return { id: String(i), text: c };
      if (c && typeof c.text === 'string') return { id: c.id != null ? String(c.id) : String(i), text: c.text };
      return null;
    })
    .filter(Boolean)
    .filter((c) => c.text.trim().length > 0);
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function accumulateUsage(target, partial) {
  if (!partial || typeof partial !== 'object') return;
  target.input_tokens += partial.input_tokens || 0;
  target.output_tokens += partial.output_tokens || 0;
  target.cache_read_input_tokens += partial.cache_read_input_tokens || 0;
  target.cache_creation_input_tokens += partial.cache_creation_input_tokens || 0;
}

/**
 * Convenience: turn a single contextualized-chunk record into the
 * string we want at index time. Pure — keep separate from
 * contextualizeChunks so callers can plug in their own concatenation
 * strategy (HTML, JSON envelope, etc.) without re-running the LLM.
 */
function formatChunkForRetrieval(c) {
  if (!c || typeof c !== 'object') return '';
  if (typeof c.contextualized === 'string' && c.contextualized.length > 0) return c.contextualized;
  if (c.context && c.original) return `${c.context}\n\n${c.original}`;
  return c.original || '';
}

module.exports = {
  contextualizeChunks,
  formatChunkForRetrieval,
  buildSystemBlock,
  normalizeChunks,
  clampContext,
  CHUNK_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_CONTEXT_CHARS,
};
