/**
 * iterative-retgen — two iterative-retrieval orchestrators from
 * Gao et al. 2024 §VI.A-B:
 *
 *   - iterRetgen (Shao et al., arXiv:2305.15294, "Enhancing Retrieval-
 *     Augmented Large Language Models with Iterative Retrieval-
 *     Generation Synergy"):
 *     Each round, generate a draft answer using the passages so far,
 *     then use THAT draft (concatenated with the original query) as
 *     the next retrieval key. The draft exposes entities and phrasing
 *     the raw question lacks. Stop when the draft stabilises or a max
 *     iteration count is hit. Final generation uses the union of all
 *     retrieved passages.
 *
 *   - ircot (Trivedi et al., arXiv:2212.10509, "Interleaving Retrieval
 *     with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-
 *     Step Questions"):
 *     Each round emits ONE step of chain-of-thought. After each step,
 *     re-retrieve using the latest CoT step as the query and feed the
 *     new passages into the next step. Stops when the CoT step
 *     signals completion ("So the answer is …").
 *
 * Both are substrate-neutral: the retriever is a function
 * (query, k) → passages[], the generator is a function ({query,
 * passages, prior?}) → string. Tests stub both.
 */

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
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

function answerStabilised(prev, next, threshold = 0.85) {
  if (!prev || !next) return false;
  const a = String(prev).toLowerCase().replace(/\s+/g, ' ').trim();
  const b = String(next).toLowerCase().replace(/\s+/g, ' ').trim();
  if (a === b) return true;
  if (a.length < 30 || b.length < 30) return false;
  // Cheap shingle overlap rather than edit distance.
  const shingle = s => {
    const toks = s.split(' ');
    const out = new Set();
    for (let i = 0; i + 3 <= toks.length; i++) out.add(toks.slice(i, i + 3).join(' '));
    return out;
  };
  const A = shingle(a), B = shingle(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  const jac = inter / (A.size + B.size - inter);
  return jac >= threshold;
}

// ─── ITER-RETGEN ─────────────────────────────────────────────────────────

/**
 * ITER-RETGEN loop.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {Function} args.retrieve       — (query, k) => passages
 * @param {Function} args.generate       — ({query, passages}) => Promise<string>
 * @param {number} [args.iterations=3]
 * @param {number} [args.k=6]
 * @param {number} [args.stabilityThreshold=0.85] — stop early when drafts converge
 *
 * @returns {Promise<{
 *   answer: string,
 *   rounds: Array<{i, draft, retrieved, newPassages}>,
 *   passages: Array,
 *   stopped: 'max-iterations'|'stable',
 * }>}
 */
async function iterRetgen({
  query, retrieve, generate,
  iterations = 3, k = 6, stabilityThreshold = 0.85,
}) {
  if (typeof retrieve !== 'function') throw new Error('iter-retgen: retrieve(fn) required');
  if (typeof generate !== 'function') throw new Error('iter-retgen: generate(fn) required');

  let accumulated = [];
  let previousDraft = '';
  const rounds = [];
  let stopped = 'max-iterations';

  for (let i = 0; i < iterations; i++) {
    const retrievalQuery = previousDraft
      ? `${query}\n\n${previousDraft}`
      : query;
    const hits = await retrieve(retrievalQuery, k);
    const newPassages = dedupePassages(hits.filter(h => {
      return !accumulated.some(p =>
        (p.source || '') === (h.source || '') &&
        (p.text || '').slice(0, 80) === (h.text || '').slice(0, 80)
      );
    }));
    accumulated = dedupePassages([...accumulated, ...hits]);
    const draft = await generate({ query, passages: accumulated });
    rounds.push({
      i,
      draft: String(draft || '').slice(0, 2000),
      retrieved: hits.length,
      newPassages: newPassages.length,
    });
    if (answerStabilised(previousDraft, draft, stabilityThreshold)) {
      stopped = 'stable';
      previousDraft = draft;
      break;
    }
    previousDraft = draft;
  }
  return {
    answer: previousDraft,
    rounds,
    passages: accumulated,
    stopped,
  };
}

// ─── IRCoT ───────────────────────────────────────────────────────────────

const IRCOT_STEP_SYSTEM = `You are solving a multi-step question using Chain-of-Thought with retrieval at every step.

Given the QUESTION, a list of retrieved CONTEXT passages, and the CoT steps so far, produce the NEXT step of reasoning.

Output format — STRICT JSON:
{
  "step": "<the next CoT step; one sentence>",
  "retrieval_query": "<query for the next retrieval round; the next fact you need to check>",
  "final_answer": "<if this step concludes the reasoning, the final answer; else empty>"
}

Rules:
- "step" is a single reasoning sentence that adds ONE fact or deduction.
- "retrieval_query" should be SPECIFIC — a phrase the vector retriever can match.
- Set "final_answer" ONLY when you have enough evidence. Otherwise leave empty and keep reasoning.
- Do NOT invent facts; if a needed fact isn't in the context, say so in "step" and request it via retrieval_query.`;

/**
 * IRCoT loop — interleave Chain-of-Thought with retrieval.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {Function} args.retrieve       — (query, k) => passages
 * @param {number} [args.maxSteps=6]
 * @param {number} [args.k=4]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {Array} [args.seedPassages]    — optional initial context
 *
 * @returns {Promise<{
 *   answer: string,
 *   steps: Array<{i, step, retrieval_query, retrieved}>,
 *   passages: Array,
 *   stopped: 'final-answer'|'max-steps',
 * }>}
 */
async function ircot({
  openai, query, retrieve,
  maxSteps = 6, k = 4, model = 'gpt-4o-mini',
  seedPassages = [],
}) {
  if (!openai) throw new Error('ircot: openai client required');
  if (typeof retrieve !== 'function') throw new Error('ircot: retrieve(fn) required');

  let context = Array.isArray(seedPassages) ? [...seedPassages] : [];
  const stepsTrace = [];
  const cotSteps = [];
  let answer = '';
  let stopped = 'max-steps';

  for (let i = 0; i < maxSteps; i++) {
    const user = [
      `QUESTION:\n${query}`,
      `CONTEXT:\n${context.slice(0, 8).map((p, j) => `[${j + 1}] ${String(p.text || '').slice(0, 600)}`).join('\n') || '(none)'}`,
      `COT SO FAR:\n${cotSteps.map((s, j) => `${j + 1}. ${s}`).join('\n') || '(empty)'}`,
    ].join('\n\n');

    let parsed = {};
    try {
      const resp = await openai.chat.completions.create({
        model, temperature: 0, max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: IRCOT_STEP_SYSTEM },
          { role: 'user',   content: user },
        ],
      });
      parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    } catch (err) {
      stepsTrace.push({ i, step: `[LLM error: ${err.message}]`, retrieval_query: '', retrieved: 0 });
      break;
    }

    const step = typeof parsed.step === 'string' ? parsed.step.trim() : '';
    const rq = typeof parsed.retrieval_query === 'string' ? parsed.retrieval_query.trim() : '';
    const final = typeof parsed.final_answer === 'string' ? parsed.final_answer.trim() : '';

    let newRetrieved = 0;
    if (rq) {
      const hits = await retrieve(rq, k);
      const before = context.length;
      context = dedupePassages([...context, ...hits]);
      newRetrieved = context.length - before;
    }
    if (step) cotSteps.push(step);
    stepsTrace.push({ i, step, retrieval_query: rq, retrieved: newRetrieved });

    if (final) {
      answer = final;
      stopped = 'final-answer';
      break;
    }
  }

  return {
    answer,
    steps: stepsTrace,
    passages: context,
    stopped,
  };
}

module.exports = {
  iterRetgen,
  ircot,
  answerStabilised,
  dedupePassages,
  IRCOT_STEP_SYSTEM,
};
