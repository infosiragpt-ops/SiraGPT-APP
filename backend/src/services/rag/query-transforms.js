/**
 * query-transforms — three query-side techniques from Gao et al. 2024
 * §IV.C (Query Optimization) that shift the retrieval key AWAY from
 * the raw user query toward something the embedding model handles
 * better.
 *
 * Why these matter: an in-domain user query like "how do we throttle
 * write amplification" shares few tokens with retrieval-friendly
 * document text. The transformations below shift the query into a
 * space closer to the target documents, consistently improving
 * recall when the base RAG retrieval is reasonable but not great.
 *
 * Implemented:
 *
 *   - hyde (Gao et al., arXiv:2212.10496): Hypothetical Document
 *     Embeddings. Ask the LLM for a plausible ANSWER to the query as
 *     if it knew. Embed THAT. Answers share document-like vocabulary
 *     with the target corpus much better than questions do.
 *
 *   - step-back (Zheng et al., arXiv:2310.06117): first produce a
 *     more ABSTRACT form of the question, retrieve for the abstract
 *     form, then feed both sets of passages to generation. Pulls in
 *     conceptually-relevant context that the specific question misses.
 *
 *   - decompose (Khattab et al., "Demonstrate-Search-Predict"):
 *     break a complex multi-hop question into 2-4 atomic sub-questions.
 *     Each sub-question gets its own retrieval; results are unioned
 *     for the generation step. Useful when one query cannot cover all
 *     the facts needed to answer.
 *
 * None of these execute retrieval themselves — each returns a set of
 * queries the caller feeds to rag-service.retrieve() (or any other
 * retriever). That keeps the retriever swappable.
 */

const HYDE_SYSTEM = `You are an expert writer. Given a user question, produce a SHORT hypothetical answer passage as if you already knew the answer from a reference document. This is not a real answer — it's a retrieval key.

Output format — STRICT JSON:
{ "passage": "<150-300 word answer-shaped passage>" }

Rules:
- Write in the voice and vocabulary of a technical document (third person, declarative).
- Include concrete nouns, specific terms, and any units / numbers that would plausibly appear in a real document.
- Do NOT hedge. Do NOT say "I don't know". Do NOT add disclaimers.
- Do NOT answer in the first person. The passage must READ like a document, not a conversation.`;

const STEP_BACK_SYSTEM = `You are an expert at abstracting questions.

Given a specific user question, produce a MORE GENERAL ("step-back") version that captures the underlying concept. Example:
  specific:  "Which countries did Estrella Mountain Community College students come from in 2007?"
  step-back: "What is the student composition of Estrella Mountain Community College?"

Output format — STRICT JSON:
{ "stepBack": "<one general-form question>" }

Rules:
- The step-back question must be about the same entity/topic but less constrained.
- One sentence. No explanation.`;

const DECOMPOSE_SYSTEM = `You are an expert at decomposing complex questions into simpler retrieval-ready sub-questions.

Output format — STRICT JSON:
{ "subQuestions": ["<sub-question 1>", "<sub-question 2>", "..."] }

Rules:
- Each sub-question must be answerable INDEPENDENTLY of the others.
- Use specific nouns the user mentioned (don't pronoun-ify).
- Produce 2-4 sub-questions. If the question is already atomic, return a single-item array with a clean rephrase.
- Do NOT produce yes/no questions unless the original was yes/no.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callLLM({ openai, model = 'gpt-4o-mini', system, user, temperature = 0.2, maxTokens = 500 }) {
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

/**
 * HyDE — Hypothetical Document Embedding.
 *
 * @returns {Promise<{ queries: string[], trace: {strategy:'hyde', passage:string} }>}
 *   `queries` contains [original, hypothetical-passage] so the caller
 *   can retrieve with both (dual-embedding) or just with the passage.
 */
async function hyde({ openai, query, model, keepOriginal = true }) {
  if (!openai || !query) return { queries: [query].filter(Boolean), trace: { strategy: 'hyde', passage: '' } };
  const out = await callLLM({
    openai, model,
    system: HYDE_SYSTEM,
    user: `USER QUESTION:\n${String(query).slice(0, 2000)}`,
  });
  const passage = typeof out.passage === 'string' ? out.passage.trim() : '';
  const queries = [];
  if (keepOriginal) queries.push(query);
  if (passage) queries.push(passage);
  return { queries, trace: { strategy: 'hyde', passage } };
}

/**
 * Step-back — produce a more abstract version alongside the original.
 *
 * @returns {Promise<{ queries: string[], trace: {strategy:'step-back', stepBack:string} }>}
 */
async function stepBack({ openai, query, model, keepOriginal = true }) {
  if (!openai || !query) return { queries: [query].filter(Boolean), trace: { strategy: 'step-back', stepBack: '' } };
  const out = await callLLM({
    openai, model,
    system: STEP_BACK_SYSTEM,
    user: `QUESTION:\n${String(query).slice(0, 2000)}`,
    maxTokens: 200,
  });
  const abstract = typeof out.stepBack === 'string' ? out.stepBack.trim() : '';
  const queries = [];
  if (keepOriginal) queries.push(query);
  if (abstract && abstract !== query) queries.push(abstract);
  return { queries, trace: { strategy: 'step-back', stepBack: abstract } };
}

/**
 * Decompose — split into sub-questions.
 *
 * @returns {Promise<{ queries: string[], trace: {strategy:'decompose', subQuestions:string[]} }>}
 */
async function decompose({ openai, query, model, maxSubQuestions = 4 }) {
  if (!openai || !query) return { queries: [query].filter(Boolean), trace: { strategy: 'decompose', subQuestions: [] } };
  const out = await callLLM({
    openai, model,
    system: DECOMPOSE_SYSTEM,
    user: `QUESTION:\n${String(query).slice(0, 2000)}`,
  });
  const subs = Array.isArray(out.subQuestions)
    ? out.subQuestions.map(s => String(s).trim()).filter(Boolean).slice(0, maxSubQuestions)
    : [];
  // The original is ALSO a useful retrieval key — include it so we don't
  // lose whatever exact-phrase match it would have scored.
  const queries = [query, ...subs];
  // Dedupe case-insensitively preserving order.
  const seen = new Set();
  const unique = queries.filter(q => {
    const k = q.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { queries: unique, trace: { strategy: 'decompose', subQuestions: subs } };
}

const STRATEGIES = { hyde, 'step-back': stepBack, decompose };

/**
 * Dispatch to a named strategy.
 *
 * @param {object} args
 * @param {'hyde'|'step-back'|'decompose'} args.strategy
 * @returns {Promise<{queries:string[], trace:object}>}
 */
async function transform(args) {
  const s = args?.strategy;
  const fn = STRATEGIES[s];
  if (!fn) throw new Error(`query-transforms: unknown strategy "${s}"`);
  return await fn(args);
}

module.exports = {
  transform,
  hyde,
  stepBack,
  decompose,
  STRATEGIES: Object.keys(STRATEGIES),
  HYDE_SYSTEM,
  STEP_BACK_SYSTEM,
  DECOMPOSE_SYSTEM,
};
