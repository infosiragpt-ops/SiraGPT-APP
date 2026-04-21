/**
 * advanced-patterns — adaptive-retrieval frameworks from Gao et al.
 * 2024 §VI (Augmentation Process).
 *
 * Three patterns, all orchestrators over a swappable retriever +
 * generator. Each adds a control loop around the naive "retrieve-once,
 * generate-once" flow so the system can recover from bad retrievals
 * or decide not to retrieve at all.
 *
 *   - self-rag (Asai et al., arXiv:2310.11511): on each call the LLM
 *     decides whether to RETRIEVE. After retrieval it RATES each
 *     retrieved passage for relevance, grounding, and utility. Low
 *     ratings → drop the passage. Final answer is constrained to cite
 *     only passages above a grounding threshold.
 *
 *   - crag (Yan et al., arXiv:2401.15884): Corrective RAG. After
 *     initial retrieval, an LLM judge GRADES the retrieval ("correct",
 *     "ambiguous", "incorrect"). If ambiguous, re-retrieve with a
 *     decomposed query; if incorrect, fall back to a user-supplied
 *     external source (typically web search). If correct, proceed as
 *     usual but with a compressed version.
 *
 *   - flare (Jiang et al., arXiv:2305.06983): Forward-Looking Active
 *     REtrieval. Generate the answer SENTENCE BY SENTENCE. After each
 *     sentence, scan for low-confidence tokens (probability markers or
 *     "[retrieve-here]" flags the LLM emits). When confidence is low,
 *     interrupt generation, retrieve using the current sentence as
 *     query, then regenerate the sentence with the new context.
 *
 * The retriever is ANY function `async (query, k) => passages[]`. The
 * generator is ANY function `async (prompt) => string`. That keeps
 * the orchestration isolated from the stack — tests inject stubs, and
 * production wires them to rag-service.retrieve + openai.chat.
 */

// ─── helpers ─────────────────────────────────────────────────────────────

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callLLMJSON({ openai, model = 'gpt-4o-mini', system, user, temperature = 0, maxTokens = 400 }) {
  const resp = await openai.chat.completions.create({
    model, temperature, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return parseJSON(resp.choices?.[0]?.message?.content || '{}');
}

// ─── Self-RAG (Asai et al. 2023) ─────────────────────────────────────────

const SELF_RAG_RETRIEVE_GATE_SYSTEM = `You decide whether a user query requires retrieval from a knowledge base.

Output format — STRICT JSON:
{ "retrieve": <bool>, "reason": "<one sentence>" }

Output retrieve=true when: the question asks about specific facts, named entities, dates, quantities, or project-specific content that a general LLM would not reliably know.
Output retrieve=false when: the question is general reasoning, a math/logic puzzle, a language question, or conversational chat.`;

const SELF_RAG_RATER_SYSTEM = `You rate one retrieved passage on three axes, each 0..1.

Output format — STRICT JSON:
{
  "relevance": <0..1 — does the passage address the question>,
  "grounding": <0..1 — does the passage make verifiable factual claims on this topic>,
  "utility":   <0..1 — would a grounded answer actually cite this passage>,
  "reason":    "<one sentence>"
}`;

/**
 * Self-RAG orchestrator.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {(query:string, k:number) => Promise<Array<{source:string, text:string, score?:number}>>} args.retrieve
 * @param {(args:{query:string, passages:Array}) => Promise<string>} args.generate
 * @param {number} [args.k=6]
 * @param {number} [args.minGrounding=0.5]
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   answer: string,
 *   usedRetrieval: boolean,
 *   retrieved: Array,
 *   kept: Array<{source, text, relevance, grounding, utility}>,
 *   dropped: Array<{source, relevance, grounding, utility, reason}>,
 *   gate: { retrieve: boolean, reason: string },
 * }>}
 */
async function selfRag({
  openai, query, retrieve, generate,
  k = 6, minGrounding = 0.5, model,
}) {
  if (!openai) throw new Error('self-rag: openai client required');
  if (typeof retrieve !== 'function') throw new Error('self-rag: retrieve(fn) required');
  if (typeof generate !== 'function') throw new Error('self-rag: generate(fn) required');

  const gate = await callLLMJSON({
    openai, model,
    system: SELF_RAG_RETRIEVE_GATE_SYSTEM,
    user: `QUERY:\n${String(query).slice(0, 2000)}`,
  });
  const shouldRetrieve = gate?.retrieve === true;

  if (!shouldRetrieve) {
    const answer = await generate({ query, passages: [] });
    return {
      answer, usedRetrieval: false, retrieved: [], kept: [], dropped: [],
      gate: { retrieve: false, reason: String(gate?.reason || '') },
    };
  }

  const retrieved = await retrieve(query, k);
  const kept = [];
  const dropped = [];
  for (const p of retrieved) {
    try {
      const r = await callLLMJSON({
        openai, model,
        system: SELF_RAG_RATER_SYSTEM,
        user: `QUERY:\n${query}\n\nPASSAGE:\n${String(p.text || '').slice(0, 2000)}`,
      });
      const relevance = clamp01(r?.relevance);
      const grounding = clamp01(r?.grounding);
      const utility = clamp01(r?.utility);
      const reason = typeof r?.reason === 'string' ? r.reason.slice(0, 200) : '';
      if (grounding >= minGrounding && relevance > 0) {
        kept.push({ source: p.source, text: p.text, relevance, grounding, utility, reason });
      } else {
        dropped.push({ source: p.source, relevance, grounding, utility, reason });
      }
    } catch (err) {
      // If the rater errors, keep the passage — preserve recall over
      // precision on failure.
      kept.push({ source: p.source, text: p.text, relevance: 0.5, grounding: 0.5, utility: 0.5, reason: `[rater error: ${err.message}]` });
    }
  }
  const answer = await generate({ query, passages: kept });
  return {
    answer, usedRetrieval: true, retrieved, kept, dropped,
    gate: { retrieve: true, reason: String(gate?.reason || '') },
  };
}

// ─── CRAG (Yan et al. 2024) ──────────────────────────────────────────────

const CRAG_GRADER_SYSTEM = `You grade a set of retrieved passages for a user query.

Output format — STRICT JSON:
{
  "grade": "correct"|"ambiguous"|"incorrect",
  "confidence": <0..1>,
  "reason": "<one sentence>"
}

- correct:   at least one passage clearly answers the query.
- ambiguous: the passages are topically related but none clearly answers the query.
- incorrect: the passages are off-topic or contradictory.`;

/**
 * CRAG orchestrator.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Function} args.retrieve        — (query, k) => passages
 * @param {Function} args.generate        — ({query, passages}) => answer
 * @param {Function} [args.externalSearch] — optional (query) => passages; only called on grade=incorrect
 * @param {Function} [args.decompose]      — optional (query, openai) => subQueries; only called on grade=ambiguous
 * @param {number} [args.k=6]
 */
async function crag({
  openai, query, retrieve, generate, externalSearch, decompose,
  k = 6, model,
}) {
  if (!openai) throw new Error('crag: openai client required');
  const initial = await retrieve(query, k);
  const grade = await callLLMJSON({
    openai, model,
    system: CRAG_GRADER_SYSTEM,
    user: [
      `QUERY:\n${query}`,
      `PASSAGES:`,
      ...initial.slice(0, 6).map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 800)}`),
    ].join('\n'),
    maxTokens: 200,
  });
  const verdict = ['correct', 'ambiguous', 'incorrect'].includes(grade?.grade) ? grade.grade : 'ambiguous';

  if (verdict === 'correct') {
    const answer = await generate({ query, passages: initial });
    return { answer, grade: verdict, confidence: clamp01(grade?.confidence), path: 'trust-initial', passages: initial };
  }

  if (verdict === 'ambiguous' && typeof decompose === 'function') {
    const subQueries = await decompose(query, openai);
    const union = [];
    const seen = new Set();
    for (const sq of (Array.isArray(subQueries) ? subQueries : [])) {
      const more = await retrieve(sq, Math.max(2, Math.floor(k / 2)));
      for (const p of more) {
        const key = p.source + '|' + (p.text || '').slice(0, 60);
        if (!seen.has(key)) { seen.add(key); union.push(p); }
      }
    }
    const combined = [...initial, ...union];
    const answer = await generate({ query, passages: combined });
    return { answer, grade: verdict, confidence: clamp01(grade?.confidence), path: 'decomposed-retry', passages: combined };
  }

  if (verdict === 'incorrect' && typeof externalSearch === 'function') {
    const webPassages = await externalSearch(query);
    const answer = await generate({ query, passages: webPassages });
    return { answer, grade: verdict, confidence: clamp01(grade?.confidence), path: 'external-search', passages: webPassages };
  }

  // Fallback when the verdict is bad but no corrective tool is wired.
  const answer = await generate({ query, passages: initial });
  return { answer, grade: verdict, confidence: clamp01(grade?.confidence), path: 'degraded-fallback', passages: initial };
}

// ─── FLARE (Jiang et al. 2023) ───────────────────────────────────────────

const FLARE_STEP_SYSTEM = `You are writing an answer sentence-by-sentence. Produce the NEXT single sentence of the answer given the question, any prior answer so far, and any retrieved context.

Output format — STRICT JSON:
{
  "sentence": "<the next sentence to append to the answer>",
  "confidence": <0..1 — your confidence that this sentence is correct>,
  "needs_retrieval": <bool — is there a specific fact you wanted but did not see in context>,
  "retrieval_query": "<if needs_retrieval=true, the best search query to find the missing fact, else empty>",
  "done": <bool — is the answer now complete>
}

Rules:
- sentence must be a single sentence, never a fragment or list.
- If you are not confident (unfamiliar entity, specific number, recent event), set confidence low AND needs_retrieval=true with a precise retrieval_query.
- Do NOT hallucinate: prefer needs_retrieval=true over producing a confidently-wrong sentence.
- Set done=true ONLY when the question is fully answered.`;

/**
 * FLARE orchestrator.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Function} args.retrieve         — (query, k) => passages
 * @param {number} [args.maxSentences=6]
 * @param {number} [args.lowConfidence=0.6]
 * @param {number} [args.k=4]
 * @param {string} [args.model]
 * @param {Array} [args.seedPassages]     — optional initial context to start from
 */
async function flare({
  openai, query, retrieve,
  maxSentences = 6, lowConfidence = 0.6, k = 4, model,
  seedPassages = [],
}) {
  if (!openai) throw new Error('flare: openai client required');
  if (typeof retrieve !== 'function') throw new Error('flare: retrieve(fn) required');

  const sentences = [];
  const trace = [];
  let passages = Array.isArray(seedPassages) ? [...seedPassages] : [];

  for (let step = 0; step < maxSentences; step++) {
    const userMsg = [
      `QUESTION:\n${query}`,
      `ANSWER SO FAR:\n${sentences.join(' ') || '(empty)'}`,
      `CONTEXT:\n${passages.slice(0, 6).map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 600)}`).join('\n') || '(none)'}`,
    ].join('\n\n');
    const out = await callLLMJSON({
      openai, model,
      system: FLARE_STEP_SYSTEM,
      user: userMsg,
      temperature: 0.1,
      maxTokens: 300,
    });
    const sentence = typeof out?.sentence === 'string' ? out.sentence.trim() : '';
    const confidence = clamp01(out?.confidence);
    const needsRetrieval = out?.needs_retrieval === true;
    const retrievalQuery = typeof out?.retrieval_query === 'string' ? out.retrieval_query.trim() : '';
    const done = out?.done === true;

    // When confidence is low or the LLM asks for help, retrieve and retry.
    if ((needsRetrieval || confidence < lowConfidence) && retrievalQuery) {
      const more = await retrieve(retrievalQuery, k);
      passages = dedupePassages([...passages, ...more]);
      trace.push({ step, action: 'retrieve', retrievalQuery, added: more.length, confidence });
      const retry = await callLLMJSON({
        openai, model,
        system: FLARE_STEP_SYSTEM,
        user: [
          `QUESTION:\n${query}`,
          `ANSWER SO FAR:\n${sentences.join(' ') || '(empty)'}`,
          `CONTEXT:\n${passages.slice(0, 6).map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 600)}`).join('\n')}`,
        ].join('\n\n'),
        temperature: 0.1, maxTokens: 300,
      });
      const sentenceRetry = typeof retry?.sentence === 'string' ? retry.sentence.trim() : '';
      if (sentenceRetry) sentences.push(sentenceRetry);
      trace.push({ step, action: 'emit', sentence: sentenceRetry, confidence: clamp01(retry?.confidence) });
      if (retry?.done === true) break;
    } else {
      if (sentence) sentences.push(sentence);
      trace.push({ step, action: 'emit', sentence, confidence });
      if (done) break;
    }
  }

  return {
    answer: sentences.join(' ').trim(),
    sentences,
    passagesUsed: passages,
    trace,
  };
}

// ─── utilities ───────────────────────────────────────────────────────────

function clamp01(v) {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function dedupePassages(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = (p.source || '') + '|' + (p.text || '').slice(0, 80);
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

module.exports = {
  selfRag,
  crag,
  flare,
  SELF_RAG_RETRIEVE_GATE_SYSTEM,
  SELF_RAG_RATER_SYSTEM,
  CRAG_GRADER_SYSTEM,
  FLARE_STEP_SYSTEM,
  clamp01,
  dedupePassages,
};
