'use strict';

/**
 * document-summarizer — produce a professional, structured analysis of
 * a document's text. Designed to sit ALONGSIDE the existing pipeline
 * (`document-intelligence.analyzeFile` for chunking + retrieval) and
 * give the chat layer a higher-quality "what is this document" view
 * than what term-matching alone can offer.
 *
 * What it returns (typed shape — see DocumentSummary below):
 *   - language          ISO-ish code inferred from the body
 *   - tldr              one-sentence executive summary, ≤ 220 chars
 *   - keyPoints[]       5–10 bullets capturing the substance
 *   - entities          people / organizations / places / dates / concepts
 *   - claims[]          assertive statements + a short verbatim evidence
 *                       quote pulled from the source text
 *   - structure         { type, sections[] } classification + section heads
 *   - complexity        low | medium | high (reading level + density)
 *   - estimatedReadTimeMin
 *
 * Why structured: a free-form paragraph is hard for the chat layer to
 * route on. With a typed shape we can render a "header card" for the
 * file, surface entities as filter chips, and compare claims across
 * documents in multi-doc threads — without re-prompting the LLM.
 *
 * The function is pure async — no DB writes, no globals. The caller
 * (route handler / pipeline step) owns persistence. Errors bubble up
 * with `code` set on the Error so the route can return a clean 502.
 */

const DEFAULT_MAX_INPUT_CHARS = 60_000;
const DEFAULT_MODEL = process.env.SIRAGPT_DOC_SUMMARIZER_MODEL || 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.SIRAGPT_DOC_SUMMARIZER_MAX_TOKENS, 10) || 1400;
const DEFAULT_LANGUAGE_HINT = ''; // empty = autodetect from text

const SYSTEM_PROMPT = `You are a professional document analyst. Given the text of a document or excerpt, produce a STRUCTURED analysis in JSON. Be objective, specific, and ground every claim in the supplied text — never your prior knowledge.

OUTPUT FORMAT (STRICT JSON; no prose, no code fences):
{
  "language": "es" | "en" | "fr" | "pt" | "de" | "other",
  "tldr": "<single sentence, max 220 chars, in the document's language>",
  "keyPoints": ["<bullet>", ...],
  "entities": {
    "people": ["..."],
    "organizations": ["..."],
    "places": ["..."],
    "dates": ["..."],
    "concepts": ["..."]
  },
  "claims": [
    {"claim": "<assertive statement>", "evidence": "<verbatim quote from source, max 200 chars>"}
  ],
  "structure": {
    "type": "article" | "report" | "email" | "spec" | "code" | "prose" | "academic" | "legal" | "financial" | "other",
    "sections": ["..."]
  },
  "complexity": "low" | "medium" | "high",
  "estimatedReadTimeMin": <integer >= 1>
}

RULES:
- tldr / keyPoints / claims must be in the document's own language.
- Each entity bucket: at most 12 distinct items, deduped, in source order.
- evidence must be a VERBATIM substring of the supplied text, truncated at 200 chars; never paraphrase.
- keyPoints: 5 to 10 bullets, each ≤ 200 chars, no trailing periods if it's a fragment.
- claims: 3 to 8 items. If the document is purely narrative / poetry / personal, return claims: [].
- complexity: low (everyday prose), medium (technical with definitions), high (specialised jargon, formulas, dense citations).
- estimatedReadTimeMin: assume 220 wpm for prose, 100 wpm for code or formulas.
- Return the JSON object DIRECTLY — no markdown, no commentary.`;

/**
 * @typedef {Object} EntityBuckets
 * @property {string[]} [people]
 * @property {string[]} [organizations]
 * @property {string[]} [places]
 * @property {string[]} [dates]
 * @property {string[]} [concepts]
 */

/**
 * @typedef {Object} StructuredClaim
 * @property {string} claim
 * @property {string} evidence
 */

/**
 * @typedef {Object} DocumentSummary
 * @property {string} language
 * @property {string} tldr
 * @property {string[]} keyPoints
 * @property {EntityBuckets} entities
 * @property {StructuredClaim[]} claims
 * @property {{type: string, sections: string[]}} structure
 * @property {'low'|'medium'|'high'} complexity
 * @property {number} estimatedReadTimeMin
 * @property {{model: string, inputChars: number, truncated: boolean}} meta
 */

/**
 * Truncate a string at the nearest sentence/paragraph boundary so the
 * LLM does not see a cut-mid-word artefact. Falls back to a hard slice
 * when no boundary is found inside the last 5 % of the window.
 */
function smartTruncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const window = text.slice(0, max);
  const tailStart = Math.floor(max * 0.95);
  const tail = window.slice(tailStart);
  // Prefer a paragraph break, then a sentence end, then a newline.
  const paragraphIdx = tail.lastIndexOf('\n\n');
  if (paragraphIdx >= 0) {
    return { text: window.slice(0, tailStart + paragraphIdx).trimEnd(), truncated: true };
  }
  const sentenceIdx = Math.max(tail.lastIndexOf('. '), tail.lastIndexOf('.\n'));
  if (sentenceIdx >= 0) {
    return { text: window.slice(0, tailStart + sentenceIdx + 1).trimEnd(), truncated: true };
  }
  const newlineIdx = tail.lastIndexOf('\n');
  if (newlineIdx >= 0) {
    return { text: window.slice(0, tailStart + newlineIdx).trimEnd(), truncated: true };
  }
  return { text: window, truncated: true };
}

/**
 * Coerce arbitrary LLM output into the strict DocumentSummary shape.
 * Defends against:
 *   - missing keys (fill with empty / 'other' / 'medium')
 *   - non-array entity buckets (replace with [])
 *   - keyPoints / claims overflow (truncate to spec)
 *   - claim items with non-string fields (drop the item)
 *   - complexity outside the enum (snap to 'medium')
 *   - estimatedReadTimeMin non-integer or zero (recompute from text)
 *
 * Always returns a fully-populated object — callers do not need to
 * branch on missing fields.
 */
function normalizeSummary(parsed, sourceText, modelUsed, truncated) {
  const safe = (v) => (typeof v === 'string' ? v : '');
  const safeArr = (v) => (Array.isArray(v) ? v : []);
  const cleanString = (s, maxLen) => safe(s).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  const dedupe = (arr) => Array.from(new Set(arr.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())));

  const language = ['es', 'en', 'fr', 'pt', 'de', 'other'].includes(parsed?.language)
    ? parsed.language
    : 'other';

  const tldr = cleanString(parsed?.tldr, 220);

  const keyPoints = dedupe(safeArr(parsed?.keyPoints))
    .map((p) => cleanString(p, 200))
    .filter(Boolean)
    .slice(0, 10);

  const entitiesRaw = parsed?.entities || {};
  const entities = {
    people: dedupe(safeArr(entitiesRaw.people)).slice(0, 12),
    organizations: dedupe(safeArr(entitiesRaw.organizations)).slice(0, 12),
    places: dedupe(safeArr(entitiesRaw.places)).slice(0, 12),
    dates: dedupe(safeArr(entitiesRaw.dates)).slice(0, 12),
    concepts: dedupe(safeArr(entitiesRaw.concepts)).slice(0, 12),
  };

  const claims = safeArr(parsed?.claims)
    .filter((c) => c && typeof c.claim === 'string' && typeof c.evidence === 'string')
    .map((c) => ({
      claim: cleanString(c.claim, 280),
      evidence: cleanString(c.evidence, 200),
    }))
    .filter((c) => c.claim.length > 0 && c.evidence.length > 0)
    .slice(0, 8);

  const structureRaw = parsed?.structure || {};
  const structure = {
    type: ['article', 'report', 'email', 'spec', 'code', 'prose', 'academic', 'legal', 'financial', 'other'].includes(structureRaw.type)
      ? structureRaw.type
      : 'other',
    sections: dedupe(safeArr(structureRaw.sections)).map((s) => cleanString(s, 140)).slice(0, 30),
  };

  const complexity = ['low', 'medium', 'high'].includes(parsed?.complexity)
    ? parsed.complexity
    : 'medium';

  let estimatedReadTimeMin = Number.parseInt(parsed?.estimatedReadTimeMin, 10);
  if (!Number.isFinite(estimatedReadTimeMin) || estimatedReadTimeMin <= 0) {
    // Fallback: 220 wpm; floor at 1.
    const words = (String(sourceText || '').match(/\S+/g) || []).length;
    estimatedReadTimeMin = Math.max(1, Math.round(words / 220));
  }

  return {
    language,
    tldr,
    keyPoints,
    entities,
    claims,
    structure,
    complexity,
    estimatedReadTimeMin,
    meta: {
      model: modelUsed,
      inputChars: String(sourceText || '').length,
      truncated,
    },
  };
}

/**
 * Run the structured analysis. Throws on bad input and on JSON parse
 * failure (with `code` set so the route layer can map to a 502).
 *
 * @param {object} args
 * @param {object} args.openai          OpenAI SDK client
 * @param {string} args.text            full document text
 * @param {string} [args.hint]          optional one-line hint about the doc
 *                                       (filename, MIME, source) — folded into
 *                                       the user prompt to bias structure.type
 * @param {object} [args.options]
 * @param {string} [args.options.model]
 * @param {number} [args.options.maxInputChars=60000]
 * @param {number} [args.options.maxTokens]
 * @param {string} [args.options.languageHint]
 * @returns {Promise<DocumentSummary>}
 */
async function summarizeDocumentStructured({ openai, text, hint = '', options = {} } = {}) {
  if (!openai || !openai.chat || !openai.chat.completions || typeof openai.chat.completions.create !== 'function') {
    const err = new Error('summarizeDocumentStructured: openai client is required');
    err.code = 'doc_summarizer_no_client';
    throw err;
  }
  const sourceText = String(text || '').trim();
  if (!sourceText) {
    const err = new Error('summarizeDocumentStructured: text is empty');
    err.code = 'doc_summarizer_empty_text';
    throw err;
  }

  const maxInputChars = Number.isFinite(options.maxInputChars) ? options.maxInputChars : DEFAULT_MAX_INPUT_CHARS;
  const model = options.model || DEFAULT_MODEL;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;
  const languageHint = String(options.languageHint || DEFAULT_LANGUAGE_HINT).trim();

  const { text: bounded, truncated } = smartTruncate(sourceText, maxInputChars);

  const userPrompt = [
    hint ? `Source hint: ${String(hint).slice(0, 200)}` : null,
    languageHint ? `Probable language: ${languageHint}` : null,
    truncated ? `(NOTE: input was truncated at ${maxInputChars} chars; analyse what is given.)` : null,
    '---',
    'TEXT:',
    bounded,
  ].filter(Boolean).join('\n');

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (err) {
    const wrapped = new Error(`document-summarizer LLM call failed: ${err && err.message}`);
    wrapped.code = 'doc_summarizer_llm_failed';
    wrapped.cause = err;
    throw wrapped;
  }

  const raw = resp?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`document-summarizer could not parse JSON: ${err && err.message}`);
    wrapped.code = 'doc_summarizer_invalid_json';
    wrapped.rawLength = raw.length;
    throw wrapped;
  }

  return normalizeSummary(parsed, bounded, model, truncated);
}

/**
 * Render a DocumentSummary as a compact markdown block suitable for
 * dropping into a chat message or system prompt. Pure — produces the
 * same string for the same input every time.
 */
function renderSummaryAsMarkdown(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const lines = [];
  if (summary.tldr) lines.push(`**TL;DR.** ${summary.tldr}`);
  lines.push('');
  if (summary.keyPoints?.length) {
    lines.push('**Puntos clave:**');
    for (const p of summary.keyPoints) lines.push(`- ${p}`);
    lines.push('');
  }
  const entityBlocks = [];
  const e = summary.entities || {};
  if (e.people?.length) entityBlocks.push(`Personas: ${e.people.join(', ')}`);
  if (e.organizations?.length) entityBlocks.push(`Organizaciones: ${e.organizations.join(', ')}`);
  if (e.places?.length) entityBlocks.push(`Lugares: ${e.places.join(', ')}`);
  if (e.dates?.length) entityBlocks.push(`Fechas: ${e.dates.join(', ')}`);
  if (e.concepts?.length) entityBlocks.push(`Conceptos: ${e.concepts.join(', ')}`);
  if (entityBlocks.length) {
    lines.push('**Entidades detectadas:**');
    for (const block of entityBlocks) lines.push(`- ${block}`);
    lines.push('');
  }
  if (summary.claims?.length) {
    lines.push('**Afirmaciones con evidencia:**');
    for (const c of summary.claims) lines.push(`- ${c.claim}\n  > ${c.evidence}`);
    lines.push('');
  }
  if (summary.structure?.sections?.length) {
    lines.push(`**Tipo:** ${summary.structure.type} · **Secciones detectadas:** ${summary.structure.sections.length}`);
  } else {
    lines.push(`**Tipo:** ${summary.structure?.type || 'other'}`);
  }
  lines.push(`**Complejidad:** ${summary.complexity} · **Tiempo de lectura estimado:** ~${summary.estimatedReadTimeMin} min`);
  return lines.join('\n').trim();
}

/**
 * Return the cached LLM summary for a user's file, computing + caching
 * it on demand. Designed to back an on-demand `/api/files/:id/summary`
 * route so the upload path stays cheap and we only pay for the LLM
 * pass when the user actually opens the file's analysis view.
 *
 * Caching: the summary lives inside `DocumentAnalysis.metadata.llmSummary`
 * (no schema migration needed). The cache key is implicit — one summary
 * per file, replaced on `refresh=true`. We also store
 * `llmSummary.cachedAt` so a future TTL-based invalidation hook is easy
 * to plug in.
 *
 * @param {object} args
 * @param {object} args.prisma         Prisma client
 * @param {object} args.openai         OpenAI SDK client
 * @param {string} args.userId
 * @param {string} args.fileId
 * @param {boolean} [args.refresh=false]
 * @param {object} [args.options]      forwarded to summarizeDocumentStructured
 * @returns {Promise<{ summary: DocumentSummary, fromCache: boolean }>}
 */
async function getOrComputeFileSummary({ prisma, openai, userId, fileId, refresh = false, options = {} } = {}) {
  if (!prisma) {
    const err = new Error('getOrComputeFileSummary: prisma is required');
    err.code = 'doc_summarizer_no_prisma';
    throw err;
  }
  if (!userId || !fileId) {
    const err = new Error('getOrComputeFileSummary: userId and fileId are required');
    err.code = 'doc_summarizer_bad_args';
    throw err;
  }

  // Verify ownership + load extracted text in one round-trip.
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId },
    select: { id: true, originalName: true, mimeType: true, extractedText: true },
  });
  if (!file) {
    const err = new Error('getOrComputeFileSummary: file not found or not owned by user');
    err.code = 'doc_summarizer_file_not_found';
    throw err;
  }

  // Look up the existing analysis row (if any) to read the cached summary.
  const analysis = await prisma.documentAnalysis.findUnique({
    where: { fileId },
    select: { id: true, metadata: true },
  });

  const cached = analysis?.metadata?.llmSummary;
  if (!refresh && cached && cached.tldr) {
    return { summary: cached, fromCache: true };
  }

  const text = String(file.extractedText || '').trim();
  if (!text) {
    const err = new Error('getOrComputeFileSummary: file has no extracted text');
    err.code = 'doc_summarizer_empty_text';
    throw err;
  }

  const hint = `${file.originalName || 'file'} (${file.mimeType || 'unknown'})`;
  const summary = await summarizeDocumentStructured({ openai, text, hint, options });

  // Persist into metadata.llmSummary if we have an analysis row to attach
  // it to. If not (first analysis hasn't run yet), still return the
  // computed summary — the next analyzeFile run will pick up the file
  // and an explicit `refresh=true` call after that will populate the
  // cache. Persisting without an analysis row would require an upsert,
  // which is out of scope for this read-mostly endpoint.
  if (analysis?.id) {
    const nextMetadata = { ...(analysis.metadata || {}), llmSummary: { ...summary, cachedAt: new Date().toISOString() } };
    await prisma.documentAnalysis.update({
      where: { id: analysis.id },
      data: { metadata: nextMetadata },
    }).catch(() => { /* best-effort cache write — non-fatal */ });
  }

  return { summary, fromCache: false };
}

module.exports = {
  summarizeDocumentStructured,
  renderSummaryAsMarkdown,
  normalizeSummary,
  smartTruncate,
  getOrComputeFileSummary,
  SYSTEM_PROMPT,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_MODEL,
};
