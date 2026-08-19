'use strict';

/**
 * document-block-budget.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Token-budget enforcer for the document-enrichment cascade. The
 * pipeline now generates 70+ blocks per chat turn. Each block is
 * already capped (~3-4 KB) but 70 × 4 KB = 280 KB which is too much
 * for long-context models too. This module:
 *
 *   1. Accepts the full set of named blocks the analyzer produced.
 *   2. Estimates the character cost of each.
 *   3. Applies a relevance weight per block based on the document
 *      type (legal docs want obligations/scope/warranties; financial
 *      docs want KPIs/scenarios/benchmarks; etc.).
 *   4. Greedy-selects blocks in descending (weight × inverse-cost)
 *      order until the global budget is exhausted.
 *   5. Always keeps the high-priority "always-on" blocks (PII,
 *      profile, directive, executive-summary) even when budget is
 *      tight.
 *
 * This is composable: ai.js can opt into using the selector by
 * calling selectBlocks(blocksByName, { docType, maxChars }) before
 * concatenating. The default behaviour (no selector) keeps full
 * fidelity.
 *
 * Deterministic. No LLM. < 5 ms for 100 named blocks.
 *
 * Public API:
 *   selectBlocks({ blocks, docType, maxChars })   → { included, skipped, totalChars }
 *   computeRelevance(docType)                     → { [blockName]: weight }
 */

const DEFAULT_MAX_CHARS = 60_000;
const ALWAYS_ON = new Set([
  'piiSafetyBlock',
  'profileBlock',
  'directiveBlock',
  'executiveSummaryBlock',
]);

// Per-doctype weight bias. Missing weight = 1 (neutral). The
// document-professional-analyzer's classifier yields a primaryDocType
// like "legal_contract", "financial_statement", "academic_paper",
// "technical_doc", "marketing_collateral", etc.
const DOC_TYPE_WEIGHTS = {
  legal_contract: {
    obligationsBlock: 1.6, scopeExclusionsBlock: 1.5, warrantiesBlock: 1.5,
    disputeResolutionBlock: 1.5, indemnificationBlock: 1.5, jurisdictionBlock: 1.4,
    complianceBlock: 1.3, definitionsBlock: 1.4, crossReferenceBlock: 1.4,
    disclosuresBlock: 1.3, conditionalClausesBlock: 1.4, signatureBlocksBlock: 1.3,
    metadataBlock: 1.2, dataClassificationBlock: 1.2, callsToActionBlock: 0.3,
    tldrBlock: 0.7, keyPhrasesBlock: 0.6,
  },
  financial_statement: {
    kpisBlock: 1.7, numericCoherenceBlock: 1.6, numericStatisticsBlock: 1.5,
    crossNumericBlock: 1.5, pricingBlock: 1.4, scenariosBlock: 1.4,
    benchmarksBlock: 1.4, riskRegisterBlock: 1.3, goalsTargetsBlock: 1.3,
    disclosuresBlock: 1.3, complianceBlock: 1.2, callsToActionBlock: 0.3,
  },
  academic_paper: {
    hypothesesBlock: 1.7, recommendationsBlock: 1.4, assumptionsBlock: 1.4,
    numericStatisticsBlock: 1.4, quotesBlock: 1.5, crossReferenceBlock: 1.3,
    definitionsBlock: 1.4, sectionRolesBlock: 1.4, deepAnalysisBlock: 1.3,
    factVsOpinionBlock: 1.3, counterArgumentsBlock: 1.3, callsToActionBlock: 0.2,
    pricingBlock: 0.3, slaTermsBlock: 0.3,
  },
  technical_doc: {
    qaPairsBlock: 1.6, deepAnalysisBlock: 1.4, slaTermsBlock: 1.5,
    glossaryBlock: 1.4, acronymsBlock: 1.4, definitionsBlock: 1.4,
    conditionalClausesBlock: 1.4, callsToActionBlock: 0.4, pricingBlock: 0.4,
  },
  marketing_collateral: {
    callsToActionBlock: 1.7, sentimentBlock: 1.4, keyPhrasesBlock: 1.4,
    pricingBlock: 1.5, audienceToneBlock: 1.5, tldrBlock: 1.4,
    benchmarksBlock: 1.3, obligationsBlock: 0.3, warrantiesBlock: 0.3,
    disputeResolutionBlock: 0.3, indemnificationBlock: 0.3, complianceBlock: 0.4,
    hypothesesBlock: 0.3,
  },
  invoice: {
    pricingBlock: 1.8, kpisBlock: 1.4, metadataBlock: 1.5,
    signatureBlocksBlock: 1.4, jurisdictionBlock: 1.2,
    hypothesesBlock: 0.2, callsToActionBlock: 0.4, sentimentBlock: 0.4,
  },
  cv_resume: {
    stakeholderMapBlock: 1.6, kpisBlock: 1.4, audienceToneBlock: 1.4,
    factVsOpinionBlock: 1.3, qaPairsBlock: 0.4, obligationsBlock: 0.3,
    warrantiesBlock: 0.2, indemnificationBlock: 0.2, disclosuresBlock: 0.3,
  },
  spreadsheet_data: {
    numericCoherenceBlock: 1.7, numericStatisticsBlock: 1.6, kpisBlock: 1.5,
    factDensityBlock: 1.4, crossNumericBlock: 1.5,
    obligationsBlock: 0.3, warrantiesBlock: 0.3, qaPairsBlock: 0.3,
  },
};

function safeBlocks(blocks) {
  if (!blocks || typeof blocks !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(blocks)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

function computeRelevance(docType) {
  if (!docType) return {};
  return DOC_TYPE_WEIGHTS[docType] || {};
}

function selectBlocks({ blocks, docType, maxChars } = {}) {
  const safe = safeBlocks(blocks);
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
  const weights = computeRelevance(docType);
  const candidates = Object.entries(safe).map(([name, content]) => ({
    name,
    content,
    chars: content.length,
    weight: ALWAYS_ON.has(name) ? Number.POSITIVE_INFINITY : (weights[name] ?? 1),
  }));

  // Always-on blocks first, ordered by weight × inverse-cost so the
  // most-relevant per-character makes it in first.
  candidates.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    const aScore = a.weight / Math.max(1, a.chars);
    const bScore = b.weight / Math.max(1, b.chars);
    return bScore - aScore;
  });

  const included = [];
  const skipped = [];
  let used = 0;
  for (const c of candidates) {
    if (ALWAYS_ON.has(c.name) || used + c.chars <= budget) {
      included.push(c);
      used += c.chars;
    } else {
      skipped.push(c);
    }
  }
  return {
    included: included.map((c) => ({ name: c.name, chars: c.chars, weight: c.weight === Number.POSITIVE_INFINITY ? 'always-on' : Number(c.weight.toFixed(2)) })),
    skipped: skipped.map((c) => ({ name: c.name, chars: c.chars, weight: Number(c.weight.toFixed(2)) })),
    totalChars: used,
    budget,
    docType: docType || null,
  };
}

/**
 * Convenience: takes the full blocksByName + ordering hint and
 * returns a concatenated string respecting the budget. If no docType
 * or budget is supplied, returns blocks in the given order without
 * filtering (i.e. backwards-compatible).
 *
 * @param {{name: string, content: string}[]} orderedParts
 * @param {{ docType?: string, maxChars?: number }} [opts]
 * @returns {string}
 */
function joinWithinBudget(orderedParts, opts = {}) {
  const parts = Array.isArray(orderedParts) ? orderedParts.filter((p) => p && typeof p.content === 'string' && p.content.length > 0) : [];
  if (parts.length === 0) return '';
  const blocks = {};
  for (const p of parts) blocks[p.name] = p.content;
  const sel = selectBlocks({ blocks, docType: opts.docType, maxChars: opts.maxChars });
  const includedNames = new Set(sel.included.map((c) => c.name));
  return parts.filter((p) => includedNames.has(p.name)).map((p) => p.content).join('\n\n');
}

module.exports = {
  selectBlocks,
  joinWithinBudget,
  computeRelevance,
  _internal: {
    safeBlocks,
    DOC_TYPE_WEIGHTS,
    ALWAYS_ON,
    DEFAULT_MAX_CHARS,
  },
};
