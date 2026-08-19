/**
 * ragas/answer-relevancy — does the answer actually address the question?
 *
 * Es et al. 2024 (RAGAS §3.1): "An answer is deemed relevant when it
 * directly and appropriately addresses the original question. ... We
 * generate n potential questions qi based on the answer ai, compute
 * the mean cosine similarity between the embedding of qi and the
 * original question q."
 *
 * Intuition: if the answer addresses the question, an LLM reading JUST
 * the answer should be able to reconstruct a question similar to the
 * original. If the answer wandered off-topic or hedged, the
 * reconstructed questions will be about something else.
 *
 * Algorithm:
 *   1. LLM reads the answer and generates N hypothetical questions
 *      (default N=3) that the answer would answer well.
 *   2. Embed all N reconstructed questions + the original question.
 *   3. Score = mean(cosine(q_orig, q_i)).
 *
 * Works without a ground-truth answer — only needs (question, answer)
 * and an embedding model.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_N = 3;

const RECONSTRUCT_SYSTEM = `Given an ANSWER, generate ${DEFAULT_N} distinct questions that this answer would address well. Each question should be self-contained.

Reply with STRICT JSON:
{"questions": ["<q1>", "<q2>", "<q3>"]}

Rules:
- Each question must stand alone (no pronouns referring to missing context).
- Questions should be DIFFERENT from each other — pick the different angles the answer covers.
- If the answer is vague or off-topic, generate questions that reflect that vagueness (e.g. "What is a topic related to X?").
- Max 120 chars per question.`;

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function reconstructQuestions({ openai, answer, n = DEFAULT_N, model = DEFAULT_MODEL }) {
  if (!openai || !answer) return [];
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.3, max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: RECONSTRUCT_SYSTEM.replace(`${DEFAULT_N}`, String(n)) },
        { role: 'user', content: text.slice(0, 6000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.questions)
      ? parsed.questions.map(q => String(q).slice(0, 200)).filter(Boolean).slice(0, n)
      : [];
  } catch (err) {
    console.warn('[ragas/answer-relevancy] reconstruct failed:', err.message);
    return [];
  }
}

/**
 * Compute answer relevancy.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.question       — original user question
 * @param {string|object} args.answer  — model's answer
 * @param {function} args.embedder     — async (texts[]) => Float32Array[]
 * @param {number} [args.n=3]
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   score: number,             // ∈ [-1, 1], typically [0, 1]
 *   reconstructed_questions: string[],
 *   per_question_similarity: number[],
 * }>}
 */
async function compute({ openai, question, answer, embedder, n = DEFAULT_N, model = DEFAULT_MODEL }) {
  if (typeof embedder !== 'function') {
    throw new Error('ragas/answer-relevancy: embedder function required');
  }
  const reconstructed = await reconstructQuestions({ openai, answer, n, model });
  if (reconstructed.length === 0) {
    return { score: 0, reconstructed_questions: [], per_question_similarity: [] };
  }
  let queryVec, reconVecs;
  try {
    const vectors = await embedder([question, ...reconstructed]);
    queryVec = vectors[0];
    reconVecs = vectors.slice(1);
  } catch (err) {
    console.warn('[ragas/answer-relevancy] embedding failed:', err.message);
    return { score: 0, reconstructed_questions: reconstructed, per_question_similarity: [] };
  }
  const sims = reconVecs.map(v => cosine(queryVec, v));
  const mean = sims.length === 0 ? 0 : sims.reduce((a, b) => a + b, 0) / sims.length;
  return {
    score: mean,
    reconstructed_questions: reconstructed,
    per_question_similarity: sims,
  };
}

module.exports = {
  compute,
  reconstructQuestions,
  cosine,
  RECONSTRUCT_SYSTEM,
  DEFAULT_N,
};
