'use strict';

/**
 * prompt-budget-allocator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Allocates a token budget across the structured `systemBlocks` that the
 * AI route builds for every chat turn. The chat now stacks 12+ named
 * blocks (master prompt, conversation-understanding, memory, cross-chat,
 * attribution, circuit-attribution, intent-attribution-graph, saliency,
 * feedback, evidence, document-enrichment, cowork, web-search …) and
 * naive concatenation can easily blow past 30 K tokens, eating into the
 * model's response budget. This module trims blocks to fit a token cap
 * while preserving high-importance tiers.
 *
 * Tier rules:
 *   • Tier 0 (master-prompt, conversation-understanding, contract,
 *     enterprise-execution, pr5-grounding) — never trimmed.
 *   • Tier 1 (attribution + circuit + intent-attribution-graph +
 *     saliency-state) — preferred; min 60 % preserved.
 *   • Tier 2 (memory, orchestration-memory, cross-chat, feedback) —
 *     min 40 % preserved.
 *   • Tier 3 (evidence, document-enrichment, cowork, web-search) —
 *     trimmed first; min 20 % preserved.
 *
 * Public API:
 *   estimateTokens(text)                  → number
 *   allocate(blocks, opts?)               → AllocationReport
 *   applyAllocation(blocks, allocation)   → trimmedBlocks
 *   buildBudgetSummaryLine(allocation)    → string
 *
 * Tunables (env):
 *   SIRAGPT_PROMPT_BUDGET_TOKENS         (default 12000)
 *   SIRAGPT_PROMPT_BUDGET_DISABLED       ("1" → no-op pass-through)
 */

const DEFAULT_BUDGET_TOKENS = Number(process.env.SIRAGPT_PROMPT_BUDGET_TOKENS) || 12_000;
const DISABLED = String(process.env.SIRAGPT_PROMPT_BUDGET_DISABLED || '').toLowerCase() === '1';

const TIER_BY_KIND = Object.freeze({
  'master-prompt': 0,
  'conversation-understanding': 0,
  'universal-contract': 0,

  // Demoted from tier-0 → tier-1 so the allocator actually has a lever when the
  // protected blocks alone blow the budget (was producing ~40k-token prompts
  // → ~74s turns). These tolerate 60% retention; the base identity stays tier-0.
  'enterprise-execution': 1,
  'pr5-grounding': 1,

  'attribution': 1,
  'circuit-attribution': 1,
  'intent-attribution-graph': 1,
  'saliency-state': 1,

  'memory': 2,
  'orchestration-memory': 2,
  'cross-chat': 2,
  'feedback': 2,

  'evidence': 3,
  'document-enrichment': 3,
  'cowork': 3,
  'web-search': 3,
});

const DEFAULT_TIER = 3;
const TIER_MIN_RATIO = Object.freeze({ 0: 1, 1: 0.6, 2: 0.4, 3: 0.2 });
const TIER_TRIM_ORDER = [3, 2, 1, 0];

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function classifyBlock(block, idx) {
  const kind = block?.kind || `block_${idx}`;
  const tier = TIER_BY_KIND[kind] ?? DEFAULT_TIER;
  return { kind, tier, text: String(block?.text || ''), originalIdx: idx };
}

function trimTextToTokens(text, targetTokens) {
  if (targetTokens <= 0) return '';
  const targetChars = Math.max(1, targetTokens * 4);
  const safe = String(text || '');
  if (safe.length <= targetChars) return safe;
  return `${safe.slice(0, targetChars - 1)}…`;
}

/**
 * Decide a per-block budget such that the totals fit under `budget`.
 * Tier-0 blocks are always preserved at full length; the others are
 * trimmed *low tier first* down to their per-tier minimum-ratio floor.
 */
function allocate(rawBlocks, opts = {}) {
  const budget = Math.max(512, Number(opts.budgetTokens) || DEFAULT_BUDGET_TOKENS);
  const blocks = (Array.isArray(rawBlocks) ? rawBlocks : []).map(classifyBlock);
  const baseline = blocks.reduce((acc, b) => acc + estimateTokens(b.text), 0);

  if (DISABLED || baseline <= budget) {
    return {
      budgetTokens: budget,
      baselineTokens: baseline,
      finalTokens: baseline,
      blocks: blocks.map((b) => ({
        kind: b.kind, tier: b.tier,
        originalTokens: estimateTokens(b.text),
        allocatedTokens: estimateTokens(b.text),
        ratio: 1,
      })),
      trimmedBlocks: [],
      overBudgetBefore: false,
      overBudgetAfter: false,
    };
  }

  const allocated = blocks.map((b) => ({
    ...b,
    originalTokens: estimateTokens(b.text),
    allocatedTokens: estimateTokens(b.text),
  }));
  const sumAlloc = () => allocated.reduce((acc, b) => acc + b.allocatedTokens, 0);

  // Walk the tiers from low → high, trimming each as much as it can give
  // back (down to its per-tier minimum ratio) before moving up.
  for (const tier of TIER_TRIM_ORDER) {
    if (sumAlloc() <= budget) break;
    if (tier === 0) continue;
    const tierMembers = allocated.filter((b) => b.tier === tier);
    if (tierMembers.length === 0) continue;
    const minRatio = TIER_MIN_RATIO[tier] ?? 0.2;
    const tierTokens = tierMembers.reduce((acc, b) => acc + b.allocatedTokens, 0);
    const tierMinTokens = tierMembers.reduce(
      (acc, b) => acc + Math.max(1, Math.floor(b.originalTokens * minRatio)),
      0,
    );
    const surplus = tierTokens - tierMinTokens;
    const deficit = sumAlloc() - budget;
    if (surplus <= 0 || deficit <= 0) continue;
    const cut = Math.min(surplus, deficit);
    const targetTierTokens = tierTokens - cut;
    const scale = Math.max(minRatio, targetTierTokens / Math.max(1, tierTokens));
    for (const m of tierMembers) {
      const tierFloor = Math.max(1, Math.floor(m.originalTokens * minRatio));
      m.allocatedTokens = Math.max(tierFloor, Math.floor(m.allocatedTokens * scale));
    }
  }

  // Last resort: still over budget. Scale all non-tier-0 uniformly.
  let total = sumAlloc();
  if (total > budget) {
    const protectedTokens = allocated.filter((b) => b.tier === 0).reduce((a, b) => a + b.allocatedTokens, 0);
    const remaining = Math.max(0, budget - protectedTokens);
    const nonProtected = allocated.filter((b) => b.tier !== 0);
    const nonProtectedTotal = nonProtected.reduce((a, b) => a + b.allocatedTokens, 0);
    if (nonProtectedTotal > 0) {
      const scale = Math.min(1, remaining / nonProtectedTotal);
      for (const m of nonProtected) m.allocatedTokens = Math.max(1, Math.floor(m.allocatedTokens * scale));
    }
    total = sumAlloc();
  }

  const trimmedBlocks = allocated.filter((b) => b.allocatedTokens < b.originalTokens).map((b) => b.kind);

  return {
    budgetTokens: budget,
    baselineTokens: baseline,
    finalTokens: total,
    blocks: allocated.map((b) => ({
      kind: b.kind,
      tier: b.tier,
      originalTokens: b.originalTokens,
      allocatedTokens: b.allocatedTokens,
      ratio: b.originalTokens === 0 ? 1 : Number((b.allocatedTokens / b.originalTokens).toFixed(3)),
    })),
    trimmedBlocks,
    overBudgetBefore: baseline > budget,
    overBudgetAfter: total > budget,
  };
}

function applyAllocation(rawBlocks, allocation) {
  if (!Array.isArray(rawBlocks)) return [];
  if (!allocation || !Array.isArray(allocation.blocks)) return rawBlocks;
  const byIdx = new Map(allocation.blocks.map((b, i) => [i, b]));
  return rawBlocks.map((block, i) => {
    const meta = byIdx.get(i);
    if (!meta || meta.allocatedTokens >= meta.originalTokens) return block;
    return {
      ...block,
      text: trimTextToTokens(block.text, meta.allocatedTokens),
      __trimmed: true,
      __originalTokens: meta.originalTokens,
      __allocatedTokens: meta.allocatedTokens,
    };
  });
}

function buildBudgetSummaryLine(allocation) {
  if (!allocation) return '';
  const trimmedCount = (allocation.trimmedBlocks || []).length;
  const trimmedList = trimmedCount > 0 ? ` trimmed=[${allocation.trimmedBlocks.slice(0, 6).join(',')}]` : '';
  return `[prompt-budget] baseline=${allocation.baselineTokens}t budget=${allocation.budgetTokens}t final=${allocation.finalTokens}t blocks=${allocation.blocks.length} ${trimmedCount > 0 ? 'TRIMMED' : 'ok'}${trimmedList}`;
}

module.exports = {
  estimateTokens,
  allocate,
  applyAllocation,
  buildBudgetSummaryLine,
  TIER_BY_KIND,
  TIER_MIN_RATIO,
  DEFAULT_BUDGET_TOKENS,
};
