/**
 * rgb-benchmark — Chen et al. 2023 "Benchmarking Large Language
 * Models in Retrieval-Augmented Generation" (arXiv:2309.01431).
 *
 * RGB tests RAG systems on four robustness axes that RAGAS does NOT
 * cover (because RAGAS assumes a well-formed retrieval + generation):
 *
 *   1. noise        — golden passages are mixed with topically-adjacent
 *                     but irrelevant distractors. A robust system
 *                     should still produce the right answer.
 *   2. rejection    — NONE of the passages contain the answer. The
 *                     system should ABSTAIN ("I don't know") instead of
 *                     hallucinating.
 *   3. integration  — the answer requires combining facts from MULTIPLE
 *                     passages. A weak RAG will pick one and miss.
 *   4. counterfactual — a passage contains an INCORRECT claim about the
 *                     answer. Robust system: override the false passage
 *                     with its own prior or abstain; weak system: defer.
 *
 * Each item is a { question, answer, passages, correctPassageIds,
 * axis, distractors? } and we provide a scoring function for each axis.
 *
 * This module ships a small built-in sample set so the benchmark runs
 * offline. The real RGB dataset ships ~600 items per language on the
 * authors' GitHub; callers can provide a datasetPath (JSONL) to load
 * the full set.
 */

const BUILTIN_SAMPLE = [
  // Noise robustness — golden passage + distractors. The system should
  // extract the answer despite the distractors.
  {
    task_id: 'rgb-local/noise-1',
    axis: 'noise',
    question: 'When was the Eiffel Tower completed?',
    answer: '1889',
    passages: [
      { source: 'golden', text: 'The Eiffel Tower was completed in 1889 and inaugurated at the World\'s Fair.' },
      { source: 'distractor-1', text: 'The Statue of Liberty was completed in 1886.' },
      { source: 'distractor-2', text: 'The Louvre Pyramid was inaugurated in 1989.' },
    ],
  },
  {
    task_id: 'rgb-local/noise-2',
    axis: 'noise',
    question: 'What is the boiling point of water at sea level in Celsius?',
    answer: '100',
    passages: [
      { source: 'distractor-1', text: 'At 5000 m altitude water boils at about 84.5 degrees Celsius.' },
      { source: 'golden', text: 'At standard atmospheric pressure at sea level, pure water boils at 100 degrees Celsius.' },
      { source: 'distractor-2', text: 'Salt water boils at a slightly higher temperature due to boiling point elevation.' },
    ],
  },
  // Rejection — no passage contains the answer; the correct answer is
  // ABSTAIN / "I don't know".
  {
    task_id: 'rgb-local/rejection-1',
    axis: 'rejection',
    question: 'Who was the first human to land on Mars?',
    answer: 'ABSTAIN',
    passages: [
      { source: 'distractor-1', text: 'Neil Armstrong became the first person to walk on the Moon in 1969.' },
      { source: 'distractor-2', text: 'Several robotic missions including Curiosity and Perseverance are active on Mars.' },
    ],
  },
  // Integration — facts spread across two passages.
  {
    task_id: 'rgb-local/integration-1',
    axis: 'integration',
    question: 'In what year did the Beatles release their album that contained the song "Let It Be"?',
    answer: '1970',
    passages: [
      { source: 'p1', text: 'The Beatles released the album "Let It Be" in 1970.' },
      { source: 'p2', text: 'The title track "Let It Be" was written by Paul McCartney.' },
    ],
  },
  // Counterfactual — one passage contains wrong info; the other correct.
  {
    task_id: 'rgb-local/counterfactual-1',
    axis: 'counterfactual',
    question: 'What is the capital of Australia?',
    answer: 'Canberra',
    passages: [
      { source: 'false', text: 'The capital of Australia is Sydney, its largest city.' },
      { source: 'true', text: 'Although Sydney is larger, Canberra is the capital of Australia.' },
    ],
  },
];

const BUILTIN_ABSTAIN_PATTERNS = [
  /i don'?t know/i,
  /\babstain\b/i,
  /insufficient (information|context)/i,
  /not (enough|provided) (info|information|context)/i,
  /no (tengo|hay) (suficiente|información|info)/i,
  /no se puede responder/i,
  /cannot answer/i,
  /no answer available/i,
];

function looksLikeAbstention(answer) {
  if (typeof answer !== 'string' || answer.trim().length === 0) return true;
  return BUILTIN_ABSTAIN_PATTERNS.some(re => re.test(answer));
}

function normaliseAnswer(text) {
  return String(text || '').toLowerCase()
    .replace(/[\p{P}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAnswer(answer, referenceAnswer) {
  if (!answer || !referenceAnswer) return false;
  const a = normaliseAnswer(answer);
  const r = normaliseAnswer(referenceAnswer);
  if (r.length === 0) return false;
  return a.includes(r);
}

/**
 * Score a single RGB item against the system's answer on the
 * axis-appropriate rule.
 */
function scoreItem(item, systemAnswer) {
  const axis = item.axis;
  if (axis === 'rejection') {
    const abstained = looksLikeAbstention(systemAnswer);
    return {
      task_id: item.task_id, axis,
      correct: abstained,
      systemAnswer, referenceAnswer: 'ABSTAIN',
      detail: abstained ? 'abstained as expected' : 'answered instead of abstaining',
    };
  }
  const matched = containsAnswer(systemAnswer, item.answer);
  let detail = matched ? 'answer found in output' : 'reference answer missing from output';
  if (axis === 'counterfactual' && !matched && looksLikeAbstention(systemAnswer)) {
    // Counterfactual: abstaining is an ACCEPTABLE outcome when the
    // system detects contradiction. We mark it as partial credit (0.5).
    return {
      task_id: item.task_id, axis,
      correct: false, partial: 0.5,
      systemAnswer, referenceAnswer: item.answer,
      detail: 'abstained on counterfactual conflict (acceptable partial)',
    };
  }
  return {
    task_id: item.task_id, axis,
    correct: matched,
    systemAnswer, referenceAnswer: item.answer,
    detail,
  };
}

/**
 * Evaluate a RAG system (represented as an async answerer function)
 * across the full RGB axis set.
 *
 * @param {object} args
 * @param {(args:{question:string, passages:Array}) => Promise<string>} args.answer
 * @param {Array} [args.items]         — override the built-in set
 * @param {number} [args.limit]
 * @returns {Promise<{
 *   total: number,
 *   axes: Record<string, { total:number, correct:number, partial:number, score:number }>,
 *   overallScore: number,
 *   perItem: Array,
 * }>}
 */
async function evaluate({ answer, items, limit }) {
  if (typeof answer !== 'function') throw new Error('rgb-benchmark: answer(fn) required');
  const dataset = Array.isArray(items) ? items : BUILTIN_SAMPLE;
  const sliced = limit ? dataset.slice(0, limit) : dataset;

  const perItem = [];
  const byAxis = new Map();

  for (const item of sliced) {
    let output = '';
    try {
      output = await answer({ question: item.question, passages: item.passages });
    } catch (err) {
      output = `[system error: ${err.message}]`;
    }
    const scored = scoreItem(item, output);
    perItem.push(scored);
    if (!byAxis.has(item.axis)) byAxis.set(item.axis, { total: 0, correct: 0, partial: 0 });
    const a = byAxis.get(item.axis);
    a.total++;
    if (scored.correct) a.correct++;
    if (!scored.correct && typeof scored.partial === 'number') a.partial += scored.partial;
  }

  const axes = {};
  let overall = 0;
  let totalItems = 0;
  for (const [axis, bucket] of byAxis.entries()) {
    const score = bucket.total === 0 ? 0 : (bucket.correct + bucket.partial) / bucket.total;
    axes[axis] = { total: bucket.total, correct: bucket.correct, partial: bucket.partial, score };
    overall += (bucket.correct + bucket.partial);
    totalItems += bucket.total;
  }

  return {
    total: sliced.length,
    axes,
    overallScore: totalItems === 0 ? 0 : overall / totalItems,
    perItem,
  };
}

module.exports = {
  evaluate,
  scoreItem,
  looksLikeAbstention,
  containsAnswer,
  BUILTIN_SAMPLE,
  BUILTIN_ABSTAIN_PATTERNS,
};
