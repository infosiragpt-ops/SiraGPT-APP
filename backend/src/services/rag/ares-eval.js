/**
 * ares-eval — ARES (Saad-Falcon et al., arXiv:2311.09476), cited in
 * Gao et al. §VII.D.
 *
 * ARES is an automated RAG evaluator whose value-add over RAGAS is
 * FEW-SHOT CALIBRATION: the judge sees a handful of labelled
 * examples (good / bad for each axis) before scoring the target,
 * which stabilises the scores across runs and reduces the per-judge
 * drift RAGAS sometimes shows.
 *
 * We implement the three core axes from the paper:
 *
 *   - context_relevance   — do the retrieved passages answer the question?
 *   - answer_faithfulness — is the answer supported by the passages?
 *   - answer_relevance    — does the answer actually address the question?
 *
 * For each axis we ship a small set of built-in calibration exemplars
 * (few-shot) that callers can override with their own labelled set.
 * The judge sees them verbatim before scoring.
 *
 * All three axes return binary-style scores in [0, 1] plus a written
 * rationale so callers can inspect why something was flagged.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

// ─── Calibration exemplars (small, curated) ──────────────────────────────

const DEFAULT_FEWSHOTS = {
  context_relevance: [
    {
      question: 'When was the Eiffel Tower completed?',
      passages: ['The Eiffel Tower was completed in 1889 for the Paris World\'s Fair.'],
      label: 1, reason: 'Passage directly states the completion year asked for.',
    },
    {
      question: 'Who is the current CEO of Apple?',
      passages: ['Apple was founded in 1976 by Steve Jobs, Steve Wozniak, and Ronald Wayne.'],
      label: 0, reason: 'Passage is about Apple but does not mention a CEO.',
    },
  ],
  answer_faithfulness: [
    {
      passages: ['Pure water boils at 100 degrees Celsius at sea level.'],
      answer: 'Water boils at 100°C at sea level.',
      label: 1, reason: 'The answer restates a fact present in the passage.',
    },
    {
      passages: ['Pure water boils at 100 degrees Celsius at sea level.'],
      answer: 'Water boils at exactly 98.7°C at sea level.',
      label: 0, reason: 'The answer contradicts the passage; 98.7 is not supported.',
    },
  ],
  answer_relevance: [
    {
      question: 'Who painted the Mona Lisa?',
      answer: 'Leonardo da Vinci painted the Mona Lisa.',
      label: 1, reason: 'Directly answers the question.',
    },
    {
      question: 'Who painted the Mona Lisa?',
      answer: 'The Mona Lisa hangs in the Louvre museum in Paris.',
      label: 0, reason: 'Related fact but does not answer WHO painted it.',
    },
  ],
};

// ─── JSON parsing helper ─────────────────────────────────────────────────

function parseJSON(text) {
  if (typeof text !== 'string') return {};
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

async function callJudge({ openai, model, system, user, temperature = 0 }) {
  const resp = await openai.chat.completions.create({
    model, temperature, max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return parseJSON(resp.choices?.[0]?.message?.content || '{}');
}

// ─── Per-axis judge systems ──────────────────────────────────────────────

const CONTEXT_RELEVANCE_SYSTEM = `You are a calibrated judge deciding whether a set of retrieved PASSAGES is relevant enough to answer a given QUESTION.

Output format — STRICT JSON: { "score": 0|1, "reason": "<one sentence>" }

Label 1 = at least one passage contains information that directly answers the question.
Label 0 = no passage contains such information (even if they discuss the topic).`;

const FAITHFULNESS_SYSTEM = `You are a calibrated judge deciding whether an ANSWER is faithful to the information in the PASSAGES.

Output format — STRICT JSON: { "score": 0|1, "reason": "<one sentence>" }

Label 1 = every factual claim in the answer is supported by (or derivable from) the passages.
Label 0 = the answer contains at least one claim that is not supported or contradicts the passages.`;

const ANSWER_RELEVANCE_SYSTEM = `You are a calibrated judge deciding whether an ANSWER actually addresses the user's QUESTION.

Output format — STRICT JSON: { "score": 0|1, "reason": "<one sentence>" }

Label 1 = the answer directly addresses what was asked.
Label 0 = the answer is off-topic, partial to the point of uselessness, or answers a different question.`;

// ─── Exemplar formatter ──────────────────────────────────────────────────

function formatFewShots(axis, shots) {
  return shots.map((s, i) => {
    const passages = Array.isArray(s.passages) ? s.passages : (s.passages ? [s.passages] : []);
    const lines = [`EXAMPLE ${i + 1}:`];
    if (s.question) lines.push(`QUESTION: ${s.question}`);
    if (passages.length) lines.push(`PASSAGES:\n${passages.map((p, j) => `  [${j + 1}] ${p}`).join('\n')}`);
    if (s.answer) lines.push(`ANSWER: ${s.answer}`);
    lines.push(`LABEL: ${s.label}  (${s.reason})`);
    return lines.join('\n');
  }).join('\n\n');
}

// ─── Per-axis scorers ────────────────────────────────────────────────────

async function scoreContextRelevance({ openai, question, passages, fewShots, model }) {
  if (!openai) return { score: 0, reason: 'no LLM client' };
  const shots = fewShots || DEFAULT_FEWSHOTS.context_relevance;
  const ctx = passages.map((p, i) => `[${i + 1}] ${String(p.text || p).slice(0, 800)}`).join('\n');
  const user = `${formatFewShots('context_relevance', shots)}\n\nEVALUATE:\nQUESTION: ${question}\nPASSAGES:\n${ctx}`;
  const out = await callJudge({ openai, model, system: CONTEXT_RELEVANCE_SYSTEM, user });
  return {
    score: out.score === 1 || out.score === '1' ? 1 : 0,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
  };
}

async function scoreFaithfulness({ openai, answer, passages, fewShots, model }) {
  if (!openai) return { score: 0, reason: 'no LLM client' };
  const shots = fewShots || DEFAULT_FEWSHOTS.answer_faithfulness;
  const ctx = passages.map((p, i) => `[${i + 1}] ${String(p.text || p).slice(0, 800)}`).join('\n');
  const user = `${formatFewShots('answer_faithfulness', shots)}\n\nEVALUATE:\nPASSAGES:\n${ctx}\nANSWER: ${answer}`;
  const out = await callJudge({ openai, model, system: FAITHFULNESS_SYSTEM, user });
  return {
    score: out.score === 1 || out.score === '1' ? 1 : 0,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
  };
}

async function scoreAnswerRelevance({ openai, question, answer, fewShots, model }) {
  if (!openai) return { score: 0, reason: 'no LLM client' };
  const shots = fewShots || DEFAULT_FEWSHOTS.answer_relevance;
  const user = `${formatFewShots('answer_relevance', shots)}\n\nEVALUATE:\nQUESTION: ${question}\nANSWER: ${answer}`;
  const out = await callJudge({ openai, model, system: ANSWER_RELEVANCE_SYSTEM, user });
  return {
    score: out.score === 1 || out.score === '1' ? 1 : 0,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
  };
}

// ─── Per-item aggregate + dataset aggregate ──────────────────────────────

/**
 * Evaluate a single (question, passages, answer) triple across the
 * three ARES axes.
 */
async function evaluateItem({
  openai, model = DEFAULT_MODEL,
  question, passages, answer, fewShots,
}) {
  const [ctx, faith, relev] = await Promise.all([
    scoreContextRelevance({ openai, question, passages, fewShots: fewShots?.context_relevance, model }),
    scoreFaithfulness({ openai, answer, passages, fewShots: fewShots?.answer_faithfulness, model }),
    scoreAnswerRelevance({ openai, question, answer, fewShots: fewShots?.answer_relevance, model }),
  ]);
  return {
    context_relevance: ctx,
    answer_faithfulness: faith,
    answer_relevance: relev,
    overall: (ctx.score + faith.score + relev.score) / 3,
  };
}

/**
 * Evaluate a dataset. Each item: { question, passages, answer }.
 *
 * @returns {Promise<{
 *   total: number,
 *   axes: { context_relevance:number, answer_faithfulness:number, answer_relevance:number },
 *   overall: number,
 *   items: Array,
 * }>}
 */
async function evaluateDataset({ openai, items, fewShots, model = DEFAULT_MODEL }) {
  if (!openai) throw new Error('ares-eval: openai client required');
  if (!Array.isArray(items) || items.length === 0) {
    return { total: 0, axes: { context_relevance: 0, answer_faithfulness: 0, answer_relevance: 0 }, overall: 0, items: [] };
  }
  const results = [];
  for (const it of items) {
    const r = await evaluateItem({
      openai, model,
      question: it.question,
      passages: Array.isArray(it.passages) ? it.passages : [],
      answer: it.answer || '',
      fewShots,
    });
    results.push({ question: it.question, ...r });
  }
  const avg = (pick) => results.reduce((s, r) => s + pick(r), 0) / results.length;
  return {
    total: results.length,
    axes: {
      context_relevance: avg(r => r.context_relevance.score),
      answer_faithfulness: avg(r => r.answer_faithfulness.score),
      answer_relevance: avg(r => r.answer_relevance.score),
    },
    overall: avg(r => r.overall),
    items: results,
  };
}

module.exports = {
  evaluateItem,
  evaluateDataset,
  scoreContextRelevance,
  scoreFaithfulness,
  scoreAnswerRelevance,
  formatFewShots,
  CONTEXT_RELEVANCE_SYSTEM,
  FAITHFULNESS_SYSTEM,
  ANSWER_RELEVANCE_SYSTEM,
  DEFAULT_FEWSHOTS,
};
