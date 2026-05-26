/**
 * repo-retriever — RepoCoder-style iterative retrieval
 * (Zhang et al., arXiv:2303.12570).
 *
 * The insight is that the user's natural-language query is a bad
 * retrieval key for code: "implement user authentication" doesn't
 * share tokens with `class AuthMiddleware { async verify(...) }`.
 * But if you generate a DRAFT of the code first — even a wrong one —
 * the draft's identifiers, imports, and structure make a much better
 * retrieval key for finding the relevant existing code in the repo.
 *
 * Pipeline:
 *
 *   1. Retrieve pass 1 — use the NL query to fetch initial context.
 *   2. Draft  — ask the LLM for a candidate implementation using that
 *               context. The draft is throwaway; its only job is to
 *               surface the right identifiers.
 *   3. Retrieve pass 2 — re-embed using the draft (or a signature-
 *               flavoured summary of it) and fetch context again. This
 *               pass tends to pull in shared utilities, base classes,
 *               and tests that the NL query alone would miss.
 *   4. Fuse  — RRF-merge pass 1 and pass 2 so high-quality matches from
 *               either side survive. Return the fused top-K as the
 *               retrieval context the downstream coder should use.
 *
 * This does NOT generate the final code — that's a separate step the
 * caller owns. The function returns the enriched context so the caller
 * can plug it into code-gen-agent, the chat system prompt, or a
 * direct LLM call.
 */

const rag = require('../rag-service');

const DRAFTER_SYSTEM = `You are an expert programmer. Given a natural-language requirement and a few snippets of existing code for context, produce a DRAFT implementation.

Output format — STRICT JSON:
{
  "code": "<draft source code>",
  "identifiers": ["<likely class/function/module names the final code will use>"]
}

The draft is a planning artefact — it does not have to run. Its purpose is to surface the identifiers and structure likely to appear in the real codebase. Be specific about module names, function names, and types that you expect to exist.`;

async function draftCandidate({ openai, query, seedContext, model = 'gpt-4o-mini' }) {
  if (!openai) return { code: '', identifiers: [] };
  const contextText = (seedContext || [])
    .slice(0, 5)
    .map((p, i) => `[${i + 1}] ${p.source || 'unknown'}\n${String(p.text || '').slice(0, 500)}`)
    .join('\n\n---\n\n');
  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: DRAFTER_SYSTEM },
      { role: 'user',   content: `REQUIREMENT:\n${query}\n\nSEED CONTEXT:\n${contextText}` },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { /* malformed draft */ }
  return {
    code: typeof parsed.code === 'string' ? parsed.code : '',
    identifiers: Array.isArray(parsed.identifiers)
      ? parsed.identifiers
          .filter(v => v !== null && v !== undefined && v !== '')
          .map(String)
          .filter(s => s && s !== 'null' && s !== 'undefined')
          .slice(0, 20)
      : [],
  };
}

function buildSecondPassQuery(originalQuery, draft) {
  const ids = (draft?.identifiers || []).slice(0, 12).join(' ');
  const draftTail = (draft?.code || '').slice(0, 1500);
  return [
    originalQuery,
    ids ? `identifiers: ${ids}` : '',
    draftTail ? `draft:\n${draftTail}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Iterative retrieve. Returns the fused top-K context plus the draft
 * used for the second pass (mostly for debugging / audit).
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.userId
 * @param {string} args.collection
 * @param {string} args.query
 * @param {number} [args.k=8]           — final top-K
 * @param {number} [args.kPerPass=8]
 * @param {number} [args.rrfK=60]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {boolean} [args.skipDraft=false] — allow callers to bypass when
 *                                           they already have a draft
 * @param {{code?:string, identifiers?:string[]}} [args.externalDraft]
 *
 * @returns {Promise<{
 *   passages: Array<{source:string, text:string, score:number}>,
 *   passA: Array, passB: Array,
 *   draft: {code:string, identifiers:string[]},
 *   stages: string[],
 * }>}
 */
async function retrieveIterative({
  openai,
  userId,
  collection,
  query,
  k = 8,
  kPerPass = 8,
  rrfK = 60,
  model = 'gpt-4o-mini',
  skipDraft = false,
  externalDraft,
}) {
  if (!query) return { passages: [], passA: [], passB: [], draft: { code: '', identifiers: [] }, stages: [] };
  const stages = [];

  // Pass 1 — retrieve by the NL query itself.
  const passA = await rag.retrieve(userId, collection, query, kPerPass);
  stages.push(`pass1: ${passA.length} hits`);

  // Draft the code we expect to write, seeded with pass-1 context.
  let draft = { code: '', identifiers: [] };
  if (!skipDraft) {
    if (externalDraft && (externalDraft.code || externalDraft.identifiers)) {
      draft = {
        code: String(externalDraft.code || ''),
        identifiers: Array.isArray(externalDraft.identifiers)
          ? externalDraft.identifiers.map(String)
          : [],
      };
      stages.push('draft: external');
    } else {
      draft = await draftCandidate({ openai, query, seedContext: passA, model });
      stages.push(`draft: ${draft.code ? draft.code.length : 0} chars, ${draft.identifiers.length} ids`);
    }
  }

  // Pass 2 — re-embed using the draft-enriched query.
  const q2 = buildSecondPassQuery(query, draft);
  const passB = draft.code || draft.identifiers.length
    ? await rag.retrieve(userId, collection, q2, kPerPass)
    : [];
  stages.push(`pass2: ${passB.length} hits`);

  // Fuse the two ranked pools with reciprocal-rank fusion.
  const fused = rag.fuseByRRF(passA, passB, { rrfK, k });
  stages.push(`fused: ${fused.length} hits`);

  return {
    passages: fused,
    passA,
    passB,
    draft,
    stages,
  };
}

module.exports = {
  retrieveIterative,
  draftCandidate,
  buildSecondPassQuery,
  DRAFTER_SYSTEM,
};
