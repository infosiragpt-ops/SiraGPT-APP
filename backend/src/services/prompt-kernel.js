'use strict';

/**
 * prompt-kernel.js — Phase 4 of the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * Need-based activation of the system-prompt blocks. Today routes/ai.js stacks
 * ~20 blocks on EVERY turn (master prompt, contracts, memory, evidence, plus a
 * large "attribution theater": attribution / circuit-attribution / saliency /
 * intent-attribution-graph, and heavy policy blocks: enterprise-execution /
 * openclaw-runtime / llm-understanding-packet). On a trivial "hola" these
 * compete with the persona for the model's attention, add latency, and dilute
 * the answer.
 *
 * This kernel decides — per turn, from the orchestrator's difficulty/risk + a
 * few signals — which OPTIONAL blocks actually earn their place. Load-bearing
 * blocks are NEVER dropped (master prompt, contract, conversation
 * understanding, evidence/RAG, memory, document enrichment, web search, the
 * grounding/cowork blocks). Only the heavy "thinking-about-thinking" and policy
 * blocks are conditionally dropped on easy, low-risk, non-agentic turns.
 *
 * Pure & deterministic. Returns an ADVISORY plan; the caller applies it
 * (gated by SIRAGPT_PROMPT_KERNEL) so behavior is reversible and measurable.
 *
 * Public API:
 *   planBlocks({ intent, difficulty, risk, signals, presentKinds })
 *       → { keep, drop, rationale, droppable }
 *   applyPlan(systemBlocks, plan)   → filtered systemBlocks (new array)
 *   summarizeForLog(plan)           → string
 *   ALWAYS_KEEP, CONDITIONALLY_DROP
 */

// Blocks that carry the answer's substance / grounding / persona — never dropped.
const ALWAYS_KEEP = new Set([
  'master-prompt',
  'universal-contract',
  'conversation-understanding',
  'evidence',
  'memory',
  'orchestration-memory',
  'cross-chat',
  'document-enrichment',
  'web-search',
  'cowork',
  'feedback',
  'pr5-grounding',
  // Phase 3 reasoning directive (if present) is load-bearing for hard turns.
  'reasoning-effort',
]);

// The "attribution theater" + heavy policy blocks: valuable on hard/ambiguous
// turns, pure dilution on trivial ones.
const CONDITIONALLY_DROP = new Set([
  'attribution',
  'circuit-attribution',
  'saliency-state',
  'intent-attribution-graph',
  'enterprise-execution',
  'openclaw-runtime',
  'llm-understanding-packet',
]);

// Intents that always justify the full heavy stack regardless of length.
const HEAVY_INTENTS = new Set([
  'agent_task', 'agentic', 'webdev', 'web_app_build', 'code_generation',
  'complex_academic_document_generation', 'research_question', 'data_analysis',
  'doc', 'math',
]);

function bucketRank(b) {
  return ({ trivial: 0, simple: 1, moderate: 2, complex: 3 })[b] ?? 1;
}

/**
 * Decide which optional blocks to keep this turn.
 * @returns {{ keep:string[], drop:string[], rationale:string, droppable:string[] }}
 */
function planBlocks({ intent = null, difficulty = null, risk = null, signals = {}, presentKinds = [] } = {}) {
  const present = Array.isArray(presentKinds) ? presentKinds : [];
  const bucket = (difficulty && difficulty.bucket) || 'simple';
  const riskLevel = (risk && risk.level) || 'low';
  const it = String(intent || '').toLowerCase();

  const droppable = present.filter((k) => CONDITIONALLY_DROP.has(k));

  // Keep the heavy stack when the turn is genuinely hard, risky, ambiguous, or
  // an agentic/deliverable intent. Only prune on easy + low-risk + light intent.
  const heavyJustified =
    bucketRank(bucket) >= 2 ||                    // moderate or complex
    riskLevel !== 'low' ||                        // any risk domain
    HEAVY_INTENTS.has(it) ||                      // deliverable / agentic
    signals.ambiguous === true ||                 // needs disambiguation
    signals.agentic === true;                     // tool-using turn

  let drop = [];
  if (!heavyJustified) {
    drop = droppable.slice();
  }
  const dropSet = new Set(drop);
  const keep = present.filter((k) => !dropSet.has(k));

  const rationale = heavyJustified
    ? `kept_full_stack (bucket=${bucket} risk=${riskLevel} intent=${it || 'none'})`
    : `pruned_${drop.length}_heavy_blocks (bucket=${bucket} risk=${riskLevel})`;

  return { keep, drop, rationale, droppable };
}

/**
 * Apply a plan to a systemBlocks array ([{ kind, text, cacheable }]). Returns a
 * new array with dropped kinds removed. Never drops a block not in the plan.
 */
function applyPlan(systemBlocks = [], plan = {}) {
  if (!Array.isArray(systemBlocks)) return systemBlocks;
  const dropSet = new Set(Array.isArray(plan.drop) ? plan.drop : []);
  if (dropSet.size === 0) return systemBlocks.slice();
  return systemBlocks.filter((b) => !(b && dropSet.has(b.kind)));
}

function summarizeForLog(plan) {
  if (!plan) return '[prompt-kernel] (no plan)';
  const dropped = (plan.drop || []).join(',') || '-';
  return `[prompt-kernel] ${plan.rationale} dropped=[${dropped}] kept=${(plan.keep || []).length}`;
}

module.exports = {
  planBlocks,
  applyPlan,
  summarizeForLog,
  ALWAYS_KEEP,
  CONDITIONALLY_DROP,
  HEAVY_INTENTS,
};
