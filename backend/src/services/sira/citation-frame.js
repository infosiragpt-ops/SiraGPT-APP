/**
 * citation-frame — first-class frame for source-grounded answers.
 * Closes the citations item from the expanded vision (task 9).
 *
 * Why a separate frame
 * --------------------
 * `services/citation-engine.js` already does the parsing (turning
 * `[Source: N]` markers into a structured citation array + annotated
 * text + footnotes). What was missing was the wrapping that makes
 * citations a first-class signal in the Sira pipeline, on the same
 * footing as `intent_frame`, `plan_frame`, `validation_frame`, etc.:
 *
 *   - typed `kind: "citation_frame"` discriminator the client renders.
 *   - language tag so the UI can pick the right strings.
 *   - per-citation `relevance_score` derived from the chunk score the
 *     reranker emitted.
 *   - per-citation `marker_count` so the UI can highlight a source
 *     that appears 5 times more visibly than one that appears once.
 *   - `coverage_ratio`: the share of source chunks that the model
 *     actually cited. Reading 12 sources and citing 1 is a useful
 *     signal that the answer may be under-grounded.
 *
 * The module owns *only* the wrapping and the new derived fields. The
 * regex parsing stays in `citation-engine.js` so all the existing
 * call sites that rely on `extractCitations`/`renderAnnotated`
 * keep working.
 */

const citationEngine = require("../citation-engine");

/**
 * Count `[N]` marker occurrences for each cited index in the
 * already-annotated text. Used for the per-citation `marker_count`
 * + the overall `coverage_ratio`.
 */
function countMarkerOccurrences(annotatedText, citationIndexes) {
  if (typeof annotatedText !== "string" || !annotatedText) return new Map();
  const counts = new Map();
  for (const i of citationIndexes) counts.set(i, 0);
  // `\[(\d+)\]` matches the post-collapse marker shape that
  // `extractCitations` produces.
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(annotatedText)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    if (counts.has(idx)) counts.set(idx, counts.get(idx) + 1);
  }
  return counts;
}

/**
 * Build a citation frame from a model response + the chunks the model
 * was given.
 *
 * @param {object} args
 * @param {string} args.response       — raw model output (with `[Source: N]` markers)
 * @param {Array}  args.chunks         — the numbered chunks (index 0 → marker [1])
 * @param {"en"|"es"} [args.language="en"]
 * @param {string} [args.requestId]    — propagated from the HTTP layer
 *
 * @returns {{
 *   kind: "citation_frame",
 *   schema_version: string,
 *   request_id: string|null,
 *   language: string,
 *   has_citations: boolean,
 *   annotated_text: string,
 *   footnotes: string,
 *   citations: Array<{
 *     index, source_id, title, snippet, relevance_score, marker_count
 *   }>,
 *   coverage: { sources_provided, sources_cited, coverage_ratio }
 * }}
 */
function buildCitationFrame({ response, chunks, language = "en", requestId = null } = {}) {
  const lang = language === "es" ? "es" : "en";
  const sourcesProvided = Array.isArray(chunks) ? chunks.length : 0;

  // Trivial fallback when nothing to cite. Stays consistent with the
  // contracts of the other frames (always returns the discriminator
  // and a `request_id` so observability infra has one shape).
  if (!response || sourcesProvided === 0) {
    return {
      kind: "citation_frame",
      schema_version: "sira.citation_frame.v1",
      request_id: requestId || null,
      language: lang,
      has_citations: false,
      annotated_text: typeof response === "string" ? response : "",
      footnotes: "",
      citations: [],
      coverage: { sources_provided: sourcesProvided, sources_cited: 0, coverage_ratio: 0 },
    };
  }

  const parsed = citationEngine.extractCitations(response, chunks);
  const citationIndexes = parsed.citations.map((c) => c.index);
  const occurrences = countMarkerOccurrences(parsed.annotatedText, citationIndexes);

  const citations = parsed.citations.map((c) => ({
    index: c.index,
    source_id: c.sourceId,
    title: c.title,
    snippet: c.snippet,
    relevance_score: c.relevanceScore,
    marker_count: occurrences.get(c.index) || 1,
  }));

  const sourcesCited = citations.length;
  const coverageRatio = sourcesProvided === 0 ? 0 : sourcesCited / sourcesProvided;

  return {
    kind: "citation_frame",
    schema_version: "sira.citation_frame.v1",
    request_id: requestId || null,
    language: lang,
    has_citations: parsed.hasCitations,
    annotated_text: parsed.annotatedText,
    footnotes: parsed.footnotes,
    citations,
    coverage: {
      sources_provided: sourcesProvided,
      sources_cited: sourcesCited,
      // Round to 4 decimals so dashboards don't drown in float noise.
      coverage_ratio: Math.round(coverageRatio * 10_000) / 10_000,
    },
  };
}

/**
 * Validate a citation_frame produced elsewhere (e.g. cached, persisted,
 * or built by a future LLM-side path). Returns `{ ok, errors[] }`.
 */
function validateCitationFrame(frame) {
  const errors = [];
  if (!frame || typeof frame !== "object") {
    return { ok: false, errors: ["frame must be an object"] };
  }
  if (frame.kind !== "citation_frame") errors.push(`kind must be "citation_frame", got ${frame.kind}`);
  if (frame.schema_version !== "sira.citation_frame.v1") errors.push("schema_version must be sira.citation_frame.v1");
  if (typeof frame.has_citations !== "boolean") errors.push("has_citations must be a boolean");
  if (!Array.isArray(frame.citations)) errors.push("citations must be an array");
  else {
    frame.citations.forEach((c, i) => {
      if (!c || typeof c !== "object") errors.push(`citation[${i}] must be an object`);
      else {
        if (!Number.isInteger(c.index) || c.index < 1) errors.push(`citation[${i}].index must be a positive integer`);
        if (typeof c.source_id !== "string" || !c.source_id) errors.push(`citation[${i}].source_id required`);
      }
    });
  }
  if (!frame.coverage || typeof frame.coverage !== "object") errors.push("coverage must be present");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  buildCitationFrame,
  validateCitationFrame,
  countMarkerOccurrences,
};
