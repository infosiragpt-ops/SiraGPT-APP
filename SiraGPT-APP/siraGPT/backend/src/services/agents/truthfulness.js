/**
 * truthfulness — hallucination detection for agent responses.
 *
 * InstructGPT's "honest" axis (Ouyang et al. 2022 §3.6) is defined
 * operationally as: does the model make up information that isn't
 * supported by the input? The paper measures it with:
 *   (1) closed-domain hallucination rate — did the model invent facts?
 *   (2) TruthfulQA — did it echo popular misconceptions?
 *
 * At inference time, for a RAG system, we have access to the retrieved
 * context. Every substantive claim in the response should be traceable
 * to one of the retrieved chunks. Claims without grounding are
 * hallucinations.
 *
 * Two-pass check:
 *   1. claim-extraction — LLM reads the response, pulls atomic factual
 *      statements (specifics: names, dates, numbers, URLs, code symbols,
 *      conditions). Opinions / hedged statements / generalities are
 *      not claims for this purpose.
 *   2. grounding-verification — for each claim, check if any retrieved
 *      chunk supports it. Fuzzy string match first (cheap), LLM
 *      verification for the ones that fuzzy-miss.
 *
 * Output shape:
 *   {
 *     claims: [{ text, grounded: bool, matchedSource: string|null,
 *                confidence: 0-1, matchType: 'fuzzy'|'llm'|'none' }],
 *     unfoundedCount: number,
 *     score: number,     // 1 - (unfounded / total) when there are claims
 *     summary: string,
 *   }
 *
 * Important: this is ADVISORY. The consumer decides whether to strip,
 * flag, or revise the response. Never block — a valid response with
 * one fuzzy-match miss shouldn't be thrown away.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

// ─── Pass 1: extract claims ───────────────────────────────────────────────

const CLAIM_EXTRACT_SYSTEM = `You extract atomic factual CLAIMS from a response.

A claim is a specific, checkable statement: a name, date, number, URL, code symbol (function/class name), version number, or a concrete condition. Opinions, hedged statements, and generalities are NOT claims.

Reply with STRICT JSON:
{"claims": ["<claim 1>", "<claim 2>", ...]}

Rules:
- Each claim must stand alone — "The function returns null on empty input" is a claim. "It's better" is not.
- Include at most 10 claims. Focus on the most checkable ones.
- If the response has no factual claims (pure opinion or meta-commentary), return {"claims": []}.`;

async function extractClaims({ openai, response, model = DEFAULT_MODEL }) {
  if (!openai || !response) return [];
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.0, max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLAIM_EXTRACT_SYSTEM },
        { role: 'user',   content: text.slice(0, 8000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.claims)
      ? parsed.claims.map(c => String(c).slice(0, 300)).filter(Boolean).slice(0, 10)
      : [];
  } catch (err) {
    console.warn('[truthfulness] claim extraction failed:', err.message);
    return [];
  }
}

// ─── Pass 2: ground each claim ────────────────────────────────────────────

/**
 * Cheap grounding: does a normalised substring of the claim appear in
 * any context chunk? Normalise by lowercasing and stripping punctuation
 * so "GPT-4o-mini" matches "gpt 4o mini".
 */
function fuzzyGround(claim, contextChunks) {
  const normalise = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const normClaim = normalise(claim);
  if (normClaim.length < 6) return null;

  // Split the claim into content words (>= 3 chars, not stopwords) and
  // require that ≥ 60% of them appear somewhere in the chunk. That's
  // lenient enough to catch paraphrases but strict enough to reject
  // "the earth is flat" when the context says "earth rotates".
  const STOP = new Set(['the','is','are','was','were','a','an','of','and','or','to','in','on','for','with','by','at','be','it','its']);
  const claimWords = normClaim.split(' ').filter(w => w.length >= 3 && !STOP.has(w));
  if (claimWords.length === 0) return null;

  for (const chunk of contextChunks) {
    const normChunk = normalise(chunk?.text || chunk || '');
    if (!normChunk) continue;
    const hits = claimWords.filter(w => normChunk.includes(w)).length;
    if (hits / claimWords.length >= 0.6) {
      return {
        matchedSource: chunk?.source || null,
        matchType: 'fuzzy',
        confidence: hits / claimWords.length,
      };
    }
  }
  return null;
}

const LLM_VERIFY_SYSTEM = `You verify whether a CLAIM is supported by a given CONTEXT.

Reply with STRICT JSON:
{"supported": <true|false>, "confidence": <0-1>, "evidence": "<quote from context or empty>"}

Rules:
- "supported" = true ONLY if the context directly states or clearly implies the claim.
- Paraphrase is fine; invention is not.
- If the context is silent or contradicts the claim, supported = false.
- Keep evidence under 200 chars.`;

async function llmVerify({ openai, claim, contextChunks, model = DEFAULT_MODEL }) {
  if (!openai) return { supported: false, confidence: 0, evidence: '' };
  const contextText = contextChunks
    .map((c, i) => `[${i + 1}${c?.source ? ' ' + c.source : ''}] ${String(c?.text || c || '').slice(0, 600)}`)
    .join('\n\n')
    .slice(0, 8000);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0.0, max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_VERIFY_SYSTEM },
        { role: 'user',   content: `CLAIM: ${claim}\n\nCONTEXT:\n${contextText}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return {
      supported: !!parsed?.supported,
      confidence: typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      evidence: String(parsed?.evidence || '').slice(0, 200),
    };
  } catch (err) {
    console.warn('[truthfulness] llm verify failed:', err.message);
    return { supported: false, confidence: 0, evidence: '' };
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run the full truthfulness pass over a response.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string|object} args.response
 * @param {Array<{text,source?}>} args.contextChunks — retrieved chunks
 *   the response should be grounded in. Can be empty (in which case
 *   we treat EVERY claim as unfounded — ground truth is what we have).
 * @param {string} [args.model='gpt-4o-mini']
 * @param {boolean} [args.llmFallback=true] — when true, fuzzy-miss
 *   claims go through a single LLM verification call. Set false to
 *   save tokens at the cost of more false "unfounded" flags.
 */
async function check({ openai, response, contextChunks = [], model = DEFAULT_MODEL, llmFallback = true }) {
  const claims = await extractClaims({ openai, response, model });
  if (claims.length === 0) {
    return {
      claims: [],
      unfoundedCount: 0,
      score: 1,
      summary: 'no checkable claims',
    };
  }

  const results = [];
  for (const c of claims) {
    let grounded = fuzzyGround(c, contextChunks);
    if (!grounded && llmFallback && contextChunks.length > 0) {
      const llm = await llmVerify({ openai, claim: c, contextChunks, model });
      if (llm.supported) {
        grounded = { matchedSource: null, matchType: 'llm', confidence: llm.confidence, evidence: llm.evidence };
      }
    }
    results.push({
      text: c,
      grounded: !!grounded,
      matchedSource: grounded?.matchedSource ?? null,
      confidence: grounded?.confidence ?? 0,
      matchType: grounded?.matchType ?? 'none',
      evidence: grounded?.evidence ?? '',
    });
  }

  const unfounded = results.filter(r => !r.grounded).length;
  const score = claims.length === 0 ? 1 : 1 - (unfounded / claims.length);

  return {
    claims: results,
    unfoundedCount: unfounded,
    score,
    summary: unfounded === 0
      ? `all ${claims.length} claims grounded`
      : `${unfounded} of ${claims.length} claims unfounded`,
  };
}

module.exports = {
  check,
  extractClaims,
  fuzzyGround,
  llmVerify,
  CLAIM_EXTRACT_SYSTEM,
  LLM_VERIFY_SYSTEM,
};
