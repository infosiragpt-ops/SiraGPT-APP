'use strict';

/**
 * deep-ask — multi-hop document Q&A orchestrator.
 *
 * Composes three existing helpers into one pipeline so the chat layer
 * gets a single call that:
 *
 *   1. Decomposes the user's question into atomic sub-queries via
 *      services/rag/query-decomposer.js (DecomposeRAG, +36.7% MRR@10
 *      on multi-hop benchmarks).
 *   2. Calls Anthropic's native Citations API with the full document
 *      and an ENRICHED prompt that lists each sub-query — the model
 *      then has explicit hooks to anchor each piece of evidence
 *      rather than collapsing the multi-hop into a single answer
 *      that loses citations to one of the hops.
 *   3. Optionally verifies every (block, citation) pair via the NLI
 *      faithfulness verifier (entailment / contradiction / neutral)
 *      and attaches the verdict in-place.
 *
 * Why a composer not an endpoint-only flag:
 *   The existing /:id/cite endpoint accepts a single question; adding
 *   `decompose: true` there would conflate "answer this question" with
 *   "decompose first and then answer". A dedicated helper + endpoint
 *   keeps the contract honest and testable, and lets the frontend
 *   render a "show me the sub-queries" affordance without inferring it
 *   from a flag.
 *
 * Public API:
 *   deepAskFile({ prisma, openai, anthropicCitations, userId, fileId, question, options })
 *     → {
 *         fileId, fileTitle,
 *         decomposition: { original, subqueries, rationale, combine, meta },
 *         answer, blocks, citations, usage,
 *         verification?: { applied, backend, perCitation: number }
 *       }
 *
 * Dependency injection:
 *   The caller provides `prisma` (DB), `openai` (for decomposer + NLI
 *   LLM-judge), and `anthropicCitations` (the module that calls
 *   Claude). Tests pass stubs for all three; production passes the
 *   shared clients.
 *
 * Failure modes (typed Error.code):
 *   deep_ask_bad_args              missing prisma / userId / fileId / question
 *   deep_ask_no_openai             missing openai client (decomposer needs it)
 *   deep_ask_no_anthropic_module   anthropicCitations missing
 *   …plus any code bubbled from decomposer / citations / NLI.
 */

const queryDecomposer = require('./query-decomposer');

/**
 * Build the enriched user prompt for the Anthropic Citations call.
 * Single-subquery case stays cheap (just the original question);
 * multi-subquery case lists them explicitly so the model can address
 * each hop and the citations can map back per hop.
 *
 * `combine` from the decomposer is folded into the framing so the
 * model knows whether to AND, INTERSECT, or chain the hops.
 */
function buildEnrichedQuestion(question, decomposition) {
  if (!decomposition || !Array.isArray(decomposition.subqueries) || decomposition.subqueries.length <= 1) {
    return question;
  }
  const framings = {
    concat: 'Address EACH of the following sub-questions in turn; produce a unified answer that covers ALL of them.',
    intersect: 'Find evidence that satisfies ALL of the following sub-questions at once; if no single passage covers them all, say so.',
    sequence: 'The sub-questions BUILD on each other; answer them in order and let later answers depend on earlier ones.',
  };
  const framing = framings[decomposition.combine] || framings.concat;
  const list = decomposition.subqueries.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `${question}\n\n---\n${framing}\nSub-questions:\n${list}`;
}

async function deepAskFile({
  prisma,
  openai,
  anthropicCitations,
  userId,
  fileId,
  question,
  options = {},
} = {}) {
  if (!prisma) {
    const err = new Error('deepAskFile: prisma is required');
    err.code = 'deep_ask_bad_args';
    throw err;
  }
  if (!openai) {
    const err = new Error('deepAskFile: openai client is required (for decomposer)');
    err.code = 'deep_ask_no_openai';
    throw err;
  }
  if (!anthropicCitations || typeof anthropicCitations.answerFileQuestionWithCitations !== 'function') {
    const err = new Error('deepAskFile: anthropicCitations module is required');
    err.code = 'deep_ask_no_anthropic_module';
    throw err;
  }
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion || !userId || !fileId) {
    const err = new Error('deepAskFile: question, userId, fileId are required');
    err.code = 'deep_ask_bad_args';
    throw err;
  }

  // ─── 1. Decompose ───────────────────────────────────────────────────────
  const decomposition = await queryDecomposer.decomposeQuery({
    openai,
    question: cleanQuestion,
    options: options.decomposer || {},
  });

  // ─── 2. Cite ────────────────────────────────────────────────────────────
  const enriched = buildEnrichedQuestion(cleanQuestion, decomposition);
  const citeOptions = {
    ...(options.cite || {}),
  };
  // Verification is requested at deep-ask level; forward to citations
  // helper which already knows how to attach per-citation verdicts.
  if (options.verify) {
    citeOptions.verify = true;
    citeOptions.nli = { openai, ...(options.nli || {}) };
  }

  const cite = await anthropicCitations.answerFileQuestionWithCitations({
    prisma,
    userId,
    fileId,
    question: enriched,
    options: citeOptions,
  });

  // ─── 3. Verification summary (count) ────────────────────────────────────
  // The per-citation verdicts already live on blocks/citations; this
  // top-level summary tells callers "is verification on, and over how
  // many citations did we run NLI". Keeps a CLI-friendly one-liner
  // available without iterating blocks.
  let verificationSummary = null;
  if (options.verify) {
    let perCitation = 0;
    let entailment = 0;
    let contradiction = 0;
    let neutral = 0;
    let errors = 0;
    for (const block of (cite.blocks || [])) {
      for (const c of (block.citations || [])) {
        if (!c.verification) continue;
        perCitation += 1;
        if (c.verification.label === 'entailment') entailment += 1;
        else if (c.verification.label === 'contradiction') contradiction += 1;
        else if (c.verification.label === 'neutral') neutral += 1;
        if (c.verification.backend === 'error') errors += 1;
      }
    }
    verificationSummary = {
      applied: true,
      perCitation,
      entailment,
      contradiction,
      neutral,
      errors,
    };
  }

  return {
    fileId: cite.fileId,
    fileTitle: cite.fileTitle,
    decomposition,
    answer: cite.text,
    blocks: cite.blocks,
    citations: cite.citations,
    usage: cite.usage,
    ...(verificationSummary ? { verification: verificationSummary } : {}),
  };
}

module.exports = {
  deepAskFile,
  buildEnrichedQuestion,
};
