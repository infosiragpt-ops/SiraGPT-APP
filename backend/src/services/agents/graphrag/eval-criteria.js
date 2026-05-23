/**
 * graphrag/eval-criteria — the four sensemaking evaluation criteria
 * from Edge et al. 2024 (Microsoft GraphRAG), §2.4.
 *
 * Unlike RAGAS, which measures retrieval quality + generation
 * faithfulness, GraphRAG's criteria evaluate the QUALITY OF AN
 * ANSWER TO A SENSEMAKING QUESTION. Sensemaking queries ("what are
 * the main themes in this corpus?") don't have single correct answers
 * — you want answers that are:
 *
 *   1. COMPREHENSIVENESS — covers the breadth of the question.
 *      An answer that mentions 2 of 5 relevant themes scores low.
 *
 *   2. DIVERSITY — gives varied perspectives / angles / domains,
 *      not just many examples of the same idea.
 *
 *   3. EMPOWERMENT — helps the reader understand, assess, act.
 *      Claims are grounded, reasoning is visible, sources surfaced.
 *      An opaque "here are the facts" scores low.
 *
 *   4. DIRECTNESS — answers the question cleanly. Wandering prose
 *      and prefaces hurt; direct topic sentences help.
 *
 * Usage: A/B judging of two answers to the same sensemaking question.
 * The judge sees both answers anonymously and picks a winner PER
 * CRITERION. Useful for "did GraphRAG produce better sensemaking
 * answers than baseline RAG?" — exactly the comparison Edge et al.
 * publish in the paper.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const CRITERIA = ['comprehensiveness', 'diversity', 'empowerment', 'directness'];

const CRITERION_DESCRIPTIONS = {
  comprehensiveness: 'Does the answer cover the breadth the question invites? Missing important themes / angles lowers the score. Breadth without relevance does not help.',
  diversity:         'Does the answer surface varied perspectives or angles, rather than many examples of the same idea? Repetition with minor variation scores low.',
  empowerment:       'Does the answer help the reader understand, assess, and act on the topic? Grounded claims, visible reasoning, surfaced sources score high. Opaque assertions score low.',
  directness:        'Does the answer respond cleanly to the question, without unnecessary preamble, meta-commentary, or meandering?',
};

const AB_SYSTEM = `You compare two ANSWERS to the same sensemaking QUESTION across four criteria from Edge et al. 2024 (GraphRAG §2.4).

CRITERIA:
${CRITERIA.map(c => `  ${c}: ${CRITERION_DESCRIPTIONS[c]}`).join('\n')}

You will see ANSWER A and ANSWER B. For EACH criterion, pick which answer is better, or declare a tie.

Reply with STRICT JSON:
{
  "comprehensiveness": {"winner": "A"|"B"|"tie", "reasoning": "<one phrase>"},
  "diversity":         {"winner": "A"|"B"|"tie", "reasoning": "<one phrase>"},
  "empowerment":       {"winner": "A"|"B"|"tie", "reasoning": "<one phrase>"},
  "directness":        {"winner": "A"|"B"|"tie", "reasoning": "<one phrase>"},
  "overall":           {"winner": "A"|"B"|"tie", "reasoning": "<one sentence>"}
}

Be willing to call ties. Do not default to A or B when neither is clearly better.`;

const SINGLE_SYSTEM = `Rate a single ANSWER to a sensemaking QUESTION on the four criteria from Edge et al. 2024 (GraphRAG §2.4). Each 1-10.

CRITERIA:
${CRITERIA.map(c => `  ${c}: ${CRITERION_DESCRIPTIONS[c]}`).join('\n')}

Reply with STRICT JSON:
{"comprehensiveness": <1-10>, "diversity": <1-10>, "empowerment": <1-10>, "directness": <1-10>, "reasoning": "<one sentence>"}`;

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Score a single answer on each criterion (1-10).
 */
async function scoreSingle({ openai, question, answer, model = DEFAULT_MODEL }) {
  if (!openai) return neutralSingle('no LLM');
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SINGLE_SYSTEM },
        { role: 'user',   content: `QUESTION: ${String(question).slice(0, 2000)}\n\nANSWER:\n${text.slice(0, 8000)}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const out = { reasoning: String(parsed?.reasoning || '').slice(0, 300) };
    for (const c of CRITERIA) out[c] = clamp(parsed?.[c], 1, 10) ?? 5;
    out.overall = (out.comprehensiveness + out.diversity + out.empowerment + out.directness) / 4;
    return out;
  } catch (err) {
    console.warn('[graphrag/eval-criteria] single failed:', err.message);
    return neutralSingle(`error: ${err.message}`);
  }
}

function neutralSingle(reason) {
  const out = { reasoning: reason };
  for (const c of CRITERIA) out[c] = 5;
  out.overall = 5;
  return out;
}

/**
 * A/B compare two answers per criterion.
 *
 * @returns {Promise<{
 *   per_criterion: { comprehensiveness: 'A'|'B'|'tie', ... },
 *   overall: 'A'|'B'|'tie',
 *   reasoning_by_criterion: { ... },
 *   wins: { A: number, B: number, ties: number },
 * }>}
 */
async function compareAB({ openai, question, answerA, answerB, model = DEFAULT_MODEL }) {
  if (!openai) return neutralAB('no LLM');
  const a = typeof answerA === 'string' ? answerA : JSON.stringify(answerA);
  const b = typeof answerB === 'string' ? answerB : JSON.stringify(answerB);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AB_SYSTEM },
        { role: 'user',   content: `QUESTION: ${String(question).slice(0, 2000)}\n\nANSWER A:\n${a.slice(0, 6000)}\n\nANSWER B:\n${b.slice(0, 6000)}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const out = {
      per_criterion: {},
      reasoning_by_criterion: {},
    };
    let winsA = 0, winsB = 0, ties = 0;
    for (const c of CRITERIA) {
      const pick = parsed?.[c];
      const winner = ['A', 'B', 'tie'].includes(pick?.winner) ? pick.winner : 'tie';
      out.per_criterion[c] = winner;
      out.reasoning_by_criterion[c] = String(pick?.reasoning || '').slice(0, 200);
      if (winner === 'A') winsA++;
      else if (winner === 'B') winsB++;
      else ties++;
    }
    const overallPick = parsed?.overall;
    out.overall = ['A', 'B', 'tie'].includes(overallPick?.winner) ? overallPick.winner : winsA > winsB ? 'A' : winsB > winsA ? 'B' : 'tie';
    out.overall_reasoning = String(overallPick?.reasoning || '').slice(0, 300);
    out.wins = { A: winsA, B: winsB, ties };
    return out;
  } catch (err) {
    console.warn('[graphrag/eval-criteria] compareAB failed:', err.message);
    return neutralAB(`error: ${err.message}`);
  }
}

function neutralAB(reason) {
  const out = { per_criterion: {}, reasoning_by_criterion: {}, wins: { A: 0, B: 0, ties: 4 }, overall: 'tie', overall_reasoning: reason };
  for (const c of CRITERIA) { out.per_criterion[c] = 'tie'; out.reasoning_by_criterion[c] = reason; }
  return out;
}

/**
 * Run compareAB over a set of (question, answerA, answerB) triples,
 * aggregate wins per criterion.
 */
async function runABSet({ openai, examples, model = DEFAULT_MODEL }) {
  if (!Array.isArray(examples) || examples.length === 0) {
    return { n: 0, per_criterion_winrates: {}, verdicts: [] };
  }
  const verdicts = [];
  for (const ex of examples) {
    // eslint-disable-next-line no-await-in-loop
    const v = await compareAB({
      openai, question: ex.question, answerA: ex.answerA, answerB: ex.answerB, model,
    });
    verdicts.push({ id: ex.id || null, ...v });
  }

  const agg = {};
  for (const c of CRITERIA) {
    const winsA = verdicts.filter(v => v.per_criterion[c] === 'A').length;
    const winsB = verdicts.filter(v => v.per_criterion[c] === 'B').length;
    const ties = verdicts.filter(v => v.per_criterion[c] === 'tie').length;
    const n = verdicts.length;
    agg[c] = {
      A_wins: winsA, B_wins: winsB, ties,
      A_winrate: n === 0 ? 0 : (winsA + ties * 0.5) / n,
      B_winrate: n === 0 ? 0 : (winsB + ties * 0.5) / n,
    };
  }
  const overallA = verdicts.filter(v => v.overall === 'A').length;
  const overallB = verdicts.filter(v => v.overall === 'B').length;
  const overallTies = verdicts.filter(v => v.overall === 'tie').length;
  return {
    n: verdicts.length,
    per_criterion_winrates: agg,
    overall_winrates: {
      A_wins: overallA, B_wins: overallB, ties: overallTies,
      A_winrate: (overallA + overallTies * 0.5) / verdicts.length,
      B_winrate: (overallB + overallTies * 0.5) / verdicts.length,
    },
    verdicts,
  };
}

module.exports = {
  scoreSingle,
  compareAB,
  runABSet,
  CRITERIA,
  CRITERION_DESCRIPTIONS,
  AB_SYSTEM,
  SINGLE_SYSTEM,
};
