/**
 * ragas/context-recall — "does the retrieved context contain enough
 * information to reconstruct the ground-truth answer?"
 *
 * Es et al. 2024 (RAGAS §3.4): "Given ground truth answer a and
 * retrieved context c, we classify each statement in a as either
 * attributable or not attributable to c".
 *
 * Needs a ground truth. Breaks down the ground-truth answer into
 * atomic statements; for each, checks whether the retrieved context
 * entails it. Score = attributable / total.
 *
 * This is the "retrieval-side" counterpart to faithfulness:
 *   - faithfulness: is the ANSWER faithful to the RETRIEVAL?
 *   - context_recall: is the RETRIEVAL sufficient to produce the
 *     CORRECT ANSWER?
 *
 * Low recall + high faithfulness means retrieval missed info but the
 * generator didn't hallucinate — you just get partial answers.
 * High recall + low faithfulness means retrieval was fine but the
 * generator fabricated extras.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const GT_CLAIM_SYSTEM = `Break the GROUND_TRUTH_ANSWER into atomic statements — each self-contained, specific, checkable.

Reply with STRICT JSON: {"statements": ["<s1>", ...]}

Rules: at most 12 statements. Omit hedges and prose fluff — only factual content.`;

const ATTRIBUTE_SYSTEM = `For each STATEMENT (derived from a correct answer), decide whether it is attributable to the CONTEXT. A statement is attributable when the context explicitly states or clearly implies it.

Reply with STRICT JSON:
{"attributions": [{"idx": <1..N>, "attributable": true|false, "evidence": "<short>"}]}`;

async function extractGroundTruthClaims({ openai, groundTruth, model = DEFAULT_MODEL }) {
  if (!openai || !groundTruth) return [];
  const text = typeof groundTruth === 'string' ? groundTruth : JSON.stringify(groundTruth);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: GT_CLAIM_SYSTEM },
        { role: 'user', content: text.slice(0, 6000) },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    return Array.isArray(parsed?.statements)
      ? parsed.statements.map(s => String(s).slice(0, 300)).filter(Boolean).slice(0, 12)
      : [];
  } catch (err) {
    console.warn('[ragas/context-recall] gt extraction failed:', err.message);
    return [];
  }
}

async function attributeStatements({ openai, statements, retrievedContexts, model = DEFAULT_MODEL }) {
  if (!openai || statements.length === 0) return [];
  const context = Array.isArray(retrievedContexts)
    ? retrievedContexts.map((c, i) => `[${i + 1}${c.source ? ' ' + c.source : ''}] ${String(c.text || c || '').slice(0, 600)}`).join('\n\n')
    : String(retrievedContexts || '');
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ATTRIBUTE_SYSTEM },
        { role: 'user', content: `CONTEXT:\n${context.slice(0, 10000)}\n\nSTATEMENTS:\n${statements.map((s, i) => `${i + 1}. ${s}`).join('\n')}` },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
    const attributions = Array.isArray(parsed?.attributions) ? parsed.attributions : [];
    return statements.map((_, i) => {
      const a = attributions.find(x => x?.idx === i + 1) || attributions[i];
      return { attributable: !!a?.attributable, evidence: String(a?.evidence || '').slice(0, 200) };
    });
  } catch (err) {
    console.warn('[ragas/context-recall] attribution failed:', err.message);
    return statements.map(() => ({ attributable: false, evidence: '' }));
  }
}

/**
 * Compute context recall.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.groundTruth   — the correct answer
 * @param {Array}  args.retrievedContexts
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   score: number,            // ∈ [0, 1]
 *   n_statements: number,
 *   attributable_statements: number,
 *   statement_verdicts: [{ statement, attributable, evidence }],
 * }>}
 */
async function compute({ openai, groundTruth, retrievedContexts, model = DEFAULT_MODEL }) {
  const statements = await extractGroundTruthClaims({ openai, groundTruth, model });
  if (statements.length === 0) {
    return {
      score: 0,
      n_statements: 0,
      attributable_statements: 0,
      statement_verdicts: [],
      note: 'no ground-truth statements extracted',
    };
  }
  const attrs = await attributeStatements({ openai, statements, retrievedContexts, model });
  const attributable = attrs.filter(a => a.attributable).length;
  return {
    score: attributable / statements.length,
    n_statements: statements.length,
    attributable_statements: attributable,
    statement_verdicts: statements.map((s, i) => ({
      statement: s,
      attributable: attrs[i].attributable,
      evidence: attrs[i].evidence,
    })),
  };
}

module.exports = {
  compute,
  extractGroundTruthClaims,
  attributeStatements,
  GT_CLAIM_SYSTEM,
  ATTRIBUTE_SYSTEM,
};
