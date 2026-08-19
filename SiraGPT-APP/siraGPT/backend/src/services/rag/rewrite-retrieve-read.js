/**
 * rewrite-retrieve-read — Ma et al. (arXiv:2305.14283), cited in
 * Gao et al. §III.C as one of the canonical Modular RAG patterns.
 *
 * Three explicit steps:
 *
 *   1. REWRITE  — an LLM rewrites the user's question into a form
 *                 better tuned for the retriever (concrete nouns,
 *                 keyword-friendly, self-contained if the original
 *                 was conversational).
 *   2. RETRIEVE — pass the rewritten question to any retriever.
 *   3. READ     — answer from the retrieved passages.
 *
 * The paper's contribution is a TRAINABLE rewriter (small model
 * fine-tuned with RL reward from the reader's correctness). We're in
 * a chat-app context — we can't fine-tune — so we ship a zero-shot
 * rewriter that approximates the same purpose via careful prompting.
 *
 * Useful when user queries are:
 *   - conversational ("could you... maybe... what was it about X?")
 *   - follow-ups that lost their subject ("when did it happen?")
 *   - stuffed with filler that drowns the retrieval signal
 *
 * This module does NOT run the retriever or the reader — it returns
 * the rewritten query and lets the caller plug in the rest.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const REWRITER_SYSTEM = `You rewrite a user's question into a retrieval-ready form.

Output format — STRICT JSON:
{
  "rewritten": "<the rewritten query, one sentence>",
  "reason": "<one sentence on what you changed>",
  "changed": <bool — true if the rewrite differs meaningfully from the original>
}

Rules:
- Keep the intent unchanged. Do NOT expand scope, do NOT narrow scope.
- Replace pronouns and deictics with the referents from the conversation history (if provided).
- Strip filler words ("maybe", "please", "could you") and conversational framing.
- Prefer specific, retrieval-friendly nouns over generic ones ("throughput limit" > "that thing").
- If the original query is already retrieval-ready, set changed=false and return the original.
- One sentence. No trailing questions to the user.`;

const READER_SYSTEM = `You answer a user's question using ONLY the provided passages.

Output format — STRICT JSON:
{
  "answer": "<direct answer to the question>",
  "cited": [<1-indexed passage numbers your answer used>]
}

Rules:
- If the passages do not contain the answer, say exactly "I don't know based on the provided context." and return cited=[].
- Keep the answer concise. No hedges like "based on the passages", no restatement of the question.
- cited is the minimal set of passages actually needed, not every one that mentions the topic.`;

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

/**
 * Step 1: rewrite.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {string} [args.history] — optional recent turns to resolve deictics
 * @returns {Promise<{ rewritten:string, changed:boolean, reason:string }>}
 */
async function rewrite({ openai, query, history, model = DEFAULT_MODEL }) {
  if (!openai) return { rewritten: query, changed: false, reason: 'no LLM client' };
  const user = history
    ? `CONVERSATION HISTORY:\n${String(history).slice(0, 2000)}\n\nCURRENT QUERY:\n${String(query).slice(0, 1000)}`
    : `QUERY:\n${String(query).slice(0, 1000)}`;
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REWRITER_SYSTEM },
        { role: 'user',   content: user },
      ],
    });
    const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    const rewritten = typeof parsed.rewritten === 'string' && parsed.rewritten.trim()
      ? parsed.rewritten.trim()
      : query;
    return {
      rewritten,
      changed: parsed.changed === true && rewritten !== query,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    };
  } catch (err) {
    // Rewriter failure is ALWAYS recoverable — we can use the original.
    return { rewritten: query, changed: false, reason: `rewriter error: ${err.message}` };
  }
}

/**
 * Step 3: read.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query            — original OR rewritten; the reader is robust to either
 * @param {Array<{source:string, text:string}>} args.passages
 */
async function read({ openai, query, passages, model = DEFAULT_MODEL }) {
  if (!openai) return { answer: '', cited: [], error: 'no LLM client' };
  if (!Array.isArray(passages) || passages.length === 0) {
    return { answer: "I don't know based on the provided context.", cited: [] };
  }
  const ctx = passages.map((p, i) =>
    `[${i + 1}] ${String(p.text || '').slice(0, 1500)}`
  ).join('\n\n');
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: READER_SYSTEM },
        { role: 'user',   content: `PASSAGES:\n${ctx}\n\nQUESTION:\n${String(query).slice(0, 1000)}` },
      ],
    });
    const parsed = parseJSON(resp.choices?.[0]?.message?.content || '{}');
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    const cited = Array.isArray(parsed.cited)
      ? parsed.cited.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= passages.length)
      : [];
    return { answer, cited };
  } catch (err) {
    return { answer: '', cited: [], error: `reader error: ${err.message}` };
  }
}

/**
 * Full pipeline: rewrite → retrieve → read. Caller supplies the
 * retriever; everything else is orchestrated here.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.query
 * @param {string} [args.history]
 * @param {Function} args.retrieve         — (query, k) => passages
 * @param {number} [args.k=6]
 * @param {string} [args.model]
 */
async function run({ openai, query, history, retrieve, k = 6, model }) {
  if (typeof retrieve !== 'function') throw new Error('rewrite-retrieve-read: retrieve(fn) required');
  const rew = await rewrite({ openai, query, history, model });
  const passages = await retrieve(rew.rewritten, k);
  const reader = await read({ openai, query: rew.rewritten, passages, model });
  return {
    original: query,
    rewritten: rew.rewritten,
    changed: rew.changed,
    rewriteReason: rew.reason,
    passages,
    answer: reader.answer,
    cited: reader.cited,
    citedSources: (reader.cited || []).map(i => passages[i - 1]?.source).filter(Boolean),
  };
}

module.exports = {
  rewrite,
  read,
  run,
  REWRITER_SYSTEM,
  READER_SYSTEM,
};
