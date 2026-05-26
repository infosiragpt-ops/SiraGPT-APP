/**
 * gear-agent — full multi-step GEAR orchestrator (Shen et al., ACL 2025,
 * "GEAR: Graph-enhanced Agent for Retrieval-augmented Generation", §5).
 *
 * Composes the single-step SyncGE pipeline already in rag-service with
 * the paper's agent loop:
 *
 *   G ← []                                       # gist memory
 *   q^(1) ← q                                    # input question
 *   for n in 1..maxIters:
 *     C_q^(n) ← retrieve(q^(n), useGraph=true, sessionId)   # §4 + §5.1
 *     (answerable, r^(n)) ← reason(G, q)                    # §5.2 Eq. 6
 *     if answerable: break
 *     q^(n+1) ← rewrite(G, q, r^(n))                        # §5.3 Eq. 7
 *   # After termination (§5.4 Eq. 8, 9):
 *   for each t in G:
 *     C_t ← passageLink(t, k)
 *   return RRF(C_q^(1), …, C_q^(n), C_t1, …, C_t|G|)
 *
 * This module owns only the orchestration — the atomic pieces live
 * elsewhere and are unit-tested independently:
 *   - retrieval:     rag-service.retrieve({ useGraph: true, sessionId })
 *   - proximal read: triple-extractor.extractProximalTriples() (inside rag)
 *   - gist memory:   gist-memory.js (accumulates triples across hops)
 *   - passage link:  rag-service.passageLink()
 *   - final RRF:     rag-service.fuseByRRF() over all per-hop pools
 *
 * Prompts (reasonTermination and rewriteQuery) are ported VERBATIM from
 * Appendix K.2 of the paper. The paper's format is simple text with
 * line-prefixed keys ("Answerable: Yes" / "Next Question: …"), so we
 * parse them with lightweight regexes and fall back to conservative
 * defaults when the LLM deviates (assume non-answerable, don't rewrite).
 */

const rag = require('./rag-service');
const gistMemory = require('./gist-memory');

// ─── Prompts (paper Appendix K.2) ───────────────────────────────────────────

const REASON_SYSTEM = `You are evaluating whether a set of known facts is sufficient to answer a question.`;

function buildReasonPrompt(query, triples) {
  const triplesText = (triples || [])
    .map(t => `("${t.subject}", "${t.predicate}", "${t.object}")`)
    .join(', ');
  return `# Task Description:
You are given an input question and a set of known facts:

Question: ${query}
Facts: ${triplesText || '(none)'}

Your reply must follow the required format:
1. If the provided facts contain the answer to the question, your should reply as follows:
Answerable: Yes
Answer: ...
2. If not, you should explain why and reply as follows:
Answerable: No
Why: ...

# Your reply:`;
}

const REWRITE_SYSTEM = `You rewrite a user question into the next sub-question needed to make progress, given what is already known.`;

function buildRewritePrompt(query, triples, reason) {
  const triplesText = (triples || [])
    .map(t => `("${t.subject}", "${t.predicate}", "${t.object}")`)
    .join(', ');
  return `# Task Description:
You will be presented with an input question and a set of known facts.
These facts might be insufficient for answering the question for some reason.
Your task is to analyze the question given the provided facts and determine what else information is needed for the next step.

# Example:
Question: What region of the state where Guy Shepherdson was born, contains SMA Negeri 68?
Facts: ("Guy Shepherdson", "born in", "Jakarta")
Reason: The provided facts only indicate that Guy Shepherdson was born in Jakarta, but they do not provide any information about the region of the state that contains SMA Negeri 68.
Next Question: What region of Jakarta contains SMA Negeri 68?

# Your Task:
Question: ${query}
Facts: ${triplesText || '(none)'}
Reason: ${reason || '(the facts are insufficient)'}
Next Question:`;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Parse the termination reply. The paper's format is:
 *   Answerable: Yes\nAnswer: …
 *   Answerable: No\nWhy: …
 * But LLMs drift. We accept case-insensitive matches and fall through
 * to "not answerable + empty reason" if neither keyword is found.
 */
function parseReasonReply(raw) {
  if (!raw || typeof raw !== 'string') return { answerable: false, answer: null, reason: '' };
  const yesMatch = raw.match(/Answerable\s*:\s*(Yes|No)/i);
  const answerMatch = raw.match(/Answer\s*:\s*([\s\S]*?)(?:\n\s*(?:Why|Answerable)\s*:|$)/i);
  const whyMatch = raw.match(/Why\s*:\s*([\s\S]*?)(?:\n\s*(?:Answer|Answerable)\s*:|$)/i);

  const answerable = !!yesMatch && /yes/i.test(yesMatch[1]);
  return {
    answerable,
    answer: answerable && answerMatch ? answerMatch[1].trim() : null,
    reason: !answerable && whyMatch ? whyMatch[1].trim() : '',
  };
}

/**
 * Parse the rewrite reply. The paper's prompt ends with "Next Question:"
 * so the model's next-question text is everything after that label. If
 * the prompt + response are stitched, we strip the prompt; if not, we
 * take the full response as the next question.
 *
 * Rejects obviously bogus rewrites (error messages, refusals, too-short
 * fragments) so the caller's agent loop doesn't go on to retrieve with
 * a junk query like "ERROR" or "I cannot help". An empty return triggers
 * the caller's fallback to the original question, which in turn trips
 * the loop-termination guard.
 */
const REWRITE_GARBAGE_PATTERNS = [
  /^(error|sorry|i (cannot|can't|am unable|don't)|unable to|apologize)/i,
  /\b(as an ai|language model|i'm sorry)/i,
];
const MIN_REWRITE_CHARS = 6;

function parseRewriteReply(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let candidate = '';
  const m = raw.match(/Next Question\s*:\s*([\s\S]+?)(?:\n\s*(?:#|$)|$)/i);
  if (m) {
    candidate = m[1].trim();
  } else {
    // No label — take the first non-empty line as the candidate.
    candidate = raw.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  }

  if (candidate.length < MIN_REWRITE_CHARS) return '';
  for (const pat of REWRITE_GARBAGE_PATTERNS) {
    if (pat.test(candidate)) return '';
  }
  return candidate;
}

// ─── LLM calls ──────────────────────────────────────────────────────────────

async function reasonTermination({ openai, query, triples, model = 'gpt-4o-mini' }) {
  if (!openai) return { answerable: false, answer: null, reason: 'no LLM client available' };
  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        { role: 'system', content: REASON_SYSTEM },
        { role: 'user', content: buildReasonPrompt(query, triples) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '';
    return parseReasonReply(raw);
  } catch (err) {
    console.warn('[gear-agent] reason() failed:', err.message);
    return { answerable: false, answer: null, reason: `reason() error: ${err.message}` };
  }
}

async function rewriteQuery({ openai, query, triples, reason, model = 'gpt-4o-mini' }) {
  if (!openai) return query;
  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: buildRewritePrompt(query, triples, reason) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '';
    const next = parseRewriteReply(raw);
    return next || query;
  } catch (err) {
    console.warn('[gear-agent] rewrite() failed:', err.message);
    return query;
  }
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

/**
 * Run the full GEAR agent loop for a query.
 *
 * @param {object} args
 * @param {string} args.userId, args.collection — retrieval namespace
 * @param {string} args.query — original question q
 * @param {object} args.openai — shared OpenAI client
 * @param {number} [args.k=10] — top-k for the final ranked passage list
 * @param {number} [args.maxIters=3] — hop budget (paper runs 2-3)
 * @param {string} [args.sessionId] — optional; if omitted we generate a
 *   one-shot id so gist memory is scoped to this call. Pass a stable
 *   sessionId across invocations to keep memory across turns.
 * @param {object} [args.retrieveOpts] — extra opts forwarded to
 *   rag.retrieve() (useHybrid, useMMR, rerank, etc.)
 * @param {string} [args.model='gpt-4o-mini'] — reasoning LLM
 *
 * @returns {Promise<{
 *   passages: Array,           // final ranked passage list (Eq. 9 RRF)
 *   answer: string|null,       // LLM's answer if answerable at some hop
 *   iterations: number,        // hops actually executed
 *   history: Array,            // per-hop { query, retrievedCount, reason }
 *   gist: Array                // final gist memory triples
 * }>}
 */
async function agentLoop({
  userId, collection, query, openai, k = 10, maxIters = 3,
  sessionId, retrieveOpts = {}, model = 'gpt-4o-mini',
}) {
  if (!query) throw new Error('agentLoop: query is required');

  const sid = sessionId || `gear-${userId || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owningSession = !sessionId; // we'll clear it at the end if we created it

  // Per-iteration retrieved pools — needed for the final Eq. 9 RRF.
  const perIterPools = [];
  const history = [];
  let currentQuery = query;
  let finalAnswer = null;
  let n = 0;

  try {
    for (n = 1; n <= maxIters; n++) {
      // §4 retrieval with graph expansion + gist memory injection.
      const hits = await rag.retrieve(userId, collection, currentQuery, k, {
        useGraph: true,
        graphOpenAI: openai,
        sessionId: sid,
        ...retrieveOpts,
      });
      perIterPools.push(hits);

      // §5.2 — is the gist enough to answer the ORIGINAL question?
      const currentGist = gistMemory.get(sid);
      const reasoning = await reasonTermination({
        openai, query, triples: currentGist, model,
      });

      history.push({
        iteration: n,
        query: currentQuery,
        retrievedCount: hits.length,
        gistSize: currentGist.length,
        answerable: reasoning.answerable,
        reason: reasoning.reason,
      });

      if (reasoning.answerable) {
        finalAnswer = reasoning.answer;
        break;
      }
      if (n === maxIters) break;

      // §5.3 — rewrite for next hop.
      currentQuery = await rewriteQuery({
        openai, query, triples: currentGist, reason: reasoning.reason, model,
      });
      // Guard against degenerate rewrites (same text — would waste a hop).
      if (currentQuery === query && n > 1) break;
    }

    // §5.4 Eq. 8 + 9 — link every gist triple to its best passages,
    // then fuse those lists with the per-iteration pools via RRF.
    const finalGist = gistMemory.get(sid);
    const tripleLinkedPools = await Promise.all(
      finalGist.map(t => rag.passageLink(userId, collection, t, { k: Math.min(5, k) }).catch(() => []))
    );
    const fused = rag.finalFuseGEAR({
      perIterPools,
      tripleLinkedPools: tripleLinkedPools.filter(p => p.length > 0),
      k,
    });

    return {
      passages: fused,
      answer: finalAnswer,
      iterations: n,
      history,
      gist: finalGist,
    };
  } finally {
    // Scope memory to the call when we created the session ourselves.
    // Caller-provided sessionIds are persisted for the next turn.
    if (owningSession) gistMemory.clear(sid);
  }
}

module.exports = {
  agentLoop,
  reasonTermination,
  rewriteQuery,
  // exported for tests
  buildReasonPrompt,
  buildRewritePrompt,
  parseReasonReply,
  parseRewriteReply,
};
