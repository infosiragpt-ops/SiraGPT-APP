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
 *   • Tier 0 (master-prompt, header/rules, custom-gpt,
 *     conversation-understanding, contract) — never trimmed.
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
  // The turn's request brief (what the user asked): never trimmed.
  'request-brief': 0,
  'header': 0,
  'rules': 0,
  'custom-gpt': 0,
  'conversation-understanding': 0,
  'universal-contract': 0,
  // Rolling context summary (conversation-compactor): dropping it forgets
  // the whole older half of the thread.
  'context-summary': 0,
  // Agent Skills the user activated for this turn: an explicit instruction,
  // already capped by chat-skills (16k chars), so it is never trimmed.
  'selected-skills': 0,
  // Explicit user/operator instructions and tiny turn facts. Before these
  // were listed they fell to DEFAULT_TIER (3) and were cut first — custom
  // instructions and the user's explicit constraints ended at ~2% on heavy
  // turns (measured with the real master prompt).
  'current-datetime': 0,
  'user-profile': 0,
  'constraints': 0,
  'response-posture': 0,
  'formatting-contract': 0,

  // Understanding, personalization and grounding: what makes the answer
  // about THIS user and THIS evidence. Tier 1 (60% floor).
  'project': 1,
  'inferred-profile': 1,
  'extra-block': 1,
  'active-memory': 1,
  'reasoning-effort': 1,
  'intent-context': 1,
  'intent-alignment': 1,
  'llm-understanding-packet': 1,
  'document-analysis-quality': 1,
  'feedback': 1,
  'evidence': 1,
  'web-search': 1,

  'pr5-grounding': 1,

  'attribution': 1,
  'circuit-attribution': 1,
  'intent-attribution-graph': 1,
  'saliency-state': 1,

  'memory': 2,
  'orchestration-memory': 2,
  'cross-chat': 2,

  // The agentic operating prompt is 100k+ chars: at tier 1 its 60% floor
  // alone exceeded the whole budget and forced the uniform last resort that
  // shrank everything else to a few percent. It is the first thing to cut.
  'enterprise-execution': 3,
  'document-enrichment': 3,
  'cowork': 3,
});

const DEFAULT_TIER = 3;
const TIER_MIN_RATIO = Object.freeze({ 0: 1, 1: 0.6, 2: 0.4, 3: 0.2 });
const TIER_TRIM_ORDER = [3, 2, 1, 0];
// Relative share of the fair-share level per tier in the last resort.
const TIER_FAIR_WEIGHT = Object.freeze({ 1: 1, 2: 0.7, 3: 0.4 });

/**
 * Weighted max-min fair allocation ("water filling"). Each item receives
 * min(size, level × weight); the level is the largest value whose total fits
 * `capacity`. Items smaller than their fair share keep their full size and
 * hand the rest to the larger ones. Returns integer tokens per item.
 */
function fairShare(items, capacity) {
  const out = new Array(items.length).fill(0);
  let cap = Math.max(0, Math.floor(capacity));
  const order = items
    .map((item, i) => ({ i, size: Math.max(0, item.size), weight: Math.max(0.01, item.weight || 1) }))
    .sort((a, b) => (a.size / a.weight) - (b.size / b.weight));
  let weightLeft = order.reduce((acc, it) => acc + it.weight, 0);
  for (const it of order) {
    const level = weightLeft > 0 ? cap / weightLeft : 0;
    const give = Math.max(0, Math.min(it.size, Math.floor(level * it.weight)));
    out[it.i] = give;
    cap -= give;
    weightLeft -= it.weight;
  }
  return out;
}

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

  // Last resort: the per-tier floors still don't fit (some block is huge).
  // Weighted max-min fair share from the ORIGINAL sizes ("water filling"):
  // every non-protected block keeps min(original, level × tierWeight), with
  // the level chosen so the total fits. Small blocks — custom instructions,
  // learned preferences, the turn's evidence — survive intact and the giant
  // ones absorb the cut. The old uniform scaling shrank every block by the
  // same factor, so one 100k-char block reduced all the others to ~2-6%.
  let total = sumAlloc();
  if (total > budget) {
    const protectedTokens = allocated.filter((b) => b.tier === 0).reduce((a, b) => a + b.allocatedTokens, 0);
    const remaining = Math.max(0, budget - protectedTokens);
    const nonProtected = allocated.filter((b) => b.tier !== 0);
    const shares = fairShare(
      nonProtected.map((b) => ({ size: b.originalTokens, weight: TIER_FAIR_WEIGHT[b.tier] ?? TIER_FAIR_WEIGHT[DEFAULT_TIER] })),
      remaining,
    );
    nonProtected.forEach((m, i) => { m.allocatedTokens = Math.max(1, shares[i]); });
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
  TIER_FAIR_WEIGHT,
  DEFAULT_BUDGET_TOKENS,
  fairShare,
};
