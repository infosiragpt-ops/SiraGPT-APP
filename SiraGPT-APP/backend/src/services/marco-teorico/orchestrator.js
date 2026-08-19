/**
 * orchestrator — runs the 4-phase Marco Teórico pipeline and emits
 * structured progress events a route handler can forward as SSE.
 *
 * Phases:
 *   1. search    — OpenAlex query for candidate sources.
 *   2. validate  — parallel CrossRef DOI verification + enrichment.
 *   3. synthesize— streaming LLM writes APA-cited markdown.
 *   4. format    — apa7.referenceList appends the deterministic
 *                  bibliography; we emit the final payload.
 *
 * Event shape (caller fans out to SSE frames):
 *   { type: 'phase',         phase, status, extra? }  // 'running' | 'done' | 'error'
 *   { type: 'source',        source }                  // individual OpenAlex hit
 *   { type: 'validation',    index, ok, doi, meta? }   // each CrossRef result
 *   { type: 'synthesis_chunk', delta, full }           // streamed markdown
 *   { type: 'final',         markdown, sources }       // full document
 *   { type: 'error',         message, phase? }
 *
 * Everything is cancellable via AbortSignal. On abort, the generator
 * returns after emitting a final 'error' event with phase: 'aborted'.
 */

const openalex = require('./openalex');
const crossref = require('./crossref');
const apa7 = require('./apa7');
const synthesizer = require('./synthesizer');

const DEFAULT_LIMIT = 30;

/**
 * Run the full pipeline as an async generator. The caller is
 * expected to iterate and serialise events to SSE (or websocket,
 * or plain JSON-lines log).
 *
 * @param {object} openai — OpenAI client (passed through from route)
 * @param {object} args
 * @param {string} args.topic
 * @param {string} [args.description]
 * @param {number} [args.limit=30] — max sources to retrieve
 * @param {[number,number]} [args.yearRange]
 * @param {string} [args.lang='es']
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.model='gpt-4o']
 */
async function* run(openai, args) {
  const {
    topic, description = null, limit = DEFAULT_LIMIT,
    yearRange = null, lang = 'es', signal, model,
  } = args || {};

  if (!topic) { yield { type: 'error', message: 'topic required' }; return; }

  // ─── Phase 1: search ────────────────────────────────────────────────────
  yield { type: 'phase', phase: 'search', status: 'running' };
  let candidates = [];
  try {
    candidates = await openalex.search({ query: topic, limit, yearRange, lang, signal });
  } catch (err) {
    if (err.name === 'AbortError') { yield { type: 'error', message: 'aborted', phase: 'search' }; return; }
    yield { type: 'error', message: `search failed: ${err.message}`, phase: 'search' };
    return;
  }
  // Emit each hit individually so the UI can render cards as they
  // stream in — helps the perceived latency of a 30-source search.
  for (const src of candidates) yield { type: 'source', source: src };
  yield { type: 'phase', phase: 'search', status: 'done', count: candidates.length };

  if (candidates.length === 0) {
    yield { type: 'error', message: 'No sources found for this topic. Try widening the year range or rephrasing.', phase: 'search' };
    return;
  }

  // ─── Phase 2: validate ──────────────────────────────────────────────────
  yield { type: 'phase', phase: 'validate', status: 'running', total: candidates.length };
  const dois = candidates.map(s => s.doi);
  const hasDoiIdx = dois.map((d, i) => d ? i : -1).filter(i => i >= 0);
  // Only validate sources that have DOIs — sources without a DOI
  // still count (some older Latin American journals aren't indexed
  // on CrossRef) but skip the network hop.
  const dedupedDois = [...new Set(hasDoiIdx.map(i => dois[i]))];
  const cached = new Map();
  let validated = 0;

  if (dedupedDois.length > 0) {
    await crossref.verifyBatch(dedupedDois, {
      signal,
      onResult: (idx, r) => {
        const doi = dedupedDois[idx];
        cached.set(doi, r);
        validated++;
        // We don't emit validation events for the deduped lookup —
        // we emit once per candidate below so indices match the
        // source list the UI is rendering.
      },
    });
  }

  // Now map each candidate to its validation result.
  const validationResults = candidates.map((s, i) => {
    const r = s.doi ? cached.get(s.doi) : null;
    const ok = !s.doi ? 'nodoi' : (r?.valid ? true : false);
    return { index: i, doi: s.doi, ok, meta: r?.valid ? r : null };
  });
  for (const v of validationResults) {
    yield { type: 'validation', ...v };
  }
  const okCount = validationResults.filter(v => v.ok === true).length;
  const noDoiCount = validationResults.filter(v => v.ok === 'nodoi').length;
  yield { type: 'phase', phase: 'validate', status: 'done', valid: okCount, noDoi: noDoiCount, invalid: candidates.length - okCount - noDoiCount };

  // Merge OpenAlex + CrossRef into the canonical shape for
  // synthesis + reference formatting. Sources without a DOI keep
  // their OpenAlex metadata intact.
  const merged = candidates.map((oa, i) => apa7.pickSource(oa, cached.get(oa.doi)));

  if (signal?.aborted) { yield { type: 'error', message: 'aborted', phase: 'validate' }; return; }

  // ─── Phase 3: synthesize ────────────────────────────────────────────────
  yield { type: 'phase', phase: 'synthesize', status: 'running' };
  let body = '';
  try {
    for await (const chunk of synthesizer.streamMarkdown(openai, {
      topic, description, sources: merged, lang, signal, model,
    })) {
      body = chunk.full;
      yield { type: 'synthesis_chunk', delta: chunk.delta, full: chunk.full };
    }
  } catch (err) {
    if (err.name === 'AbortError') { yield { type: 'error', message: 'aborted', phase: 'synthesize' }; return; }
    yield { type: 'error', message: `synthesis failed: ${err.message}`, phase: 'synthesize' };
    return;
  }
  yield { type: 'phase', phase: 'synthesize', status: 'done' };

  // ─── Phase 4: format ────────────────────────────────────────────────────
  yield { type: 'phase', phase: 'format', status: 'running' };
  const refs = apa7.referenceList(merged);
  const fullMarkdown = `${body}\n\n## Referencias\n\n${refs}`;
  yield { type: 'phase', phase: 'format', status: 'done' };

  yield {
    type: 'final',
    markdown: fullMarkdown,
    sources: merged.map(s => ({
      doi: s.doi,
      title: s.title,
      authors: s.authors?.map(a => a.display) || [],
      year: s.year,
      venue: s.container,
      url: s.url,
      openAccessUrl: s.openAccessUrl,
    })),
    stats: {
      total: candidates.length,
      validated: okCount,
      noDoi: noDoiCount,
      invalid: candidates.length - okCount - noDoiCount,
    },
  };
}

module.exports = { run };
