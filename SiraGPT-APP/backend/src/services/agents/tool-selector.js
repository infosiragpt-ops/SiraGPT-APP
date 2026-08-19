'use strict';

/**
 * tool-selector.js — per-turn tool selection ("tool RAG").
 * ───────────────────────────────────────────────────────────────────────────
 * The agentic loop dumps ~37 tools (up to ~73 on media turns) into EVERY
 * function-calling request. That floods the context, raises latency/cost, and
 * measurably degrades tool-choice accuracy — worst of all on the free
 * Llama-3.1-8B model. Frontier agents retrieve a small, relevant tool subset
 * per turn. This module does exactly that.
 *
 * Design contract (SAFE by construction):
 *   - Always keep a small CORE set (web_search, read_url, read_file,
 *     search_docs) + intent-conditioned cores → never strands the agent.
 *   - Score the rest by intent/signal category + query-token match + the
 *     skill→tool recommendation that already exists (skill-tool-adapter).
 *   - Cap at `maxTools`. When uncertain (broad/agentic intent, unknown intent,
 *     or the full set is already small) → return ALL tools (zero risk of
 *     excluding something needed).
 *
 * Pure, deterministic, no I/O. Dependency-injectable for tests.
 *
 * Public API:
 *   selectTools({ tools, userQuery, decision?, signals?, maxTools? }, deps?)
 *       → { tools, selectedNames, keptCount, droppedCount, reason, applied }
 *   scoreTool(tool, ctx)              → number
 *   CORE_TOOLS, CATEGORY_PATTERNS
 */

let defaultSkillAdapter = null;
try { defaultSkillAdapter = require('../skill-tool-adapter'); } catch (_) { defaultSkillAdapter = null; }

const DEFAULT_MAX_TOOLS = Number(process.env.SIRAGPT_TOOL_SELECTION_MAX) || 16;
const MIN_KEPT = Number(process.env.SIRAGPT_TOOL_SELECTION_MIN) || 8;

// General-purpose tools kept on (almost) every agentic turn. `run_skill` gives
// access to all policy-allowed specialized skills, so it stays available.
const CORE_TOOLS = Object.freeze(['web_search', 'read_url', 'read_file', 'search_docs', 'run_skill', 'run_skill_pipeline']);

// Tool-name → capability category (a tool can match several).
const CATEGORY_PATTERNS = Object.freeze({
  web: /^(web_search|read_url|web_extract|deep_search|browser_)/,
  research: /^(scientific_search|github_search|x_search|deep_search|sunat_)/,
  rag: /(rag_retrieve|search_docs|search_code|get_symbol|list_files|read_file|docintel|deep_analyze|compare_documents|auto_file|memory_recall)/,
  code: /(python_exec|host_bash|host_file|list_dir|glob_files|code_grep|clone_project|run_tests|propose_patch|static_check|check_ci|monitor_ci|search_code|get_symbol)/,
  generation: /(create_document|verify_artifact)/,
  media: /(image|video|audio|music|chart|diagram|svg|infograph|dashboard|organigram|mermaid|timeline|kanban|swot|eisenhower|raci|canvas|pyramid|porter|risk_matrix|funnel|radar|journey|okr|empathy|lean|scorecard|ansoff|bcg|moscow|decision_tree|concept_map|mindmap|swimlane|pestel|process_flow|comparison_table|gantt|gauge|waterfall|heatmap|treemap)/i,
  memory: /(memory_recall|session_|active_memory)/,
});

// intent → per-category weight.
const INTENT_CATEGORIES = Object.freeze({
  research_question: { research: 3, web: 3, rag: 1 },
  web_search: { web: 3, research: 2 },
  search_web: { web: 3, research: 2 },
  code_generation: { code: 3, generation: 1 },
  web_app_build: { code: 3, generation: 1 },
  data_analysis: { code: 2, rag: 2, media: 2 },
  math_solving: { code: 3 },
  complex_academic_document_generation: { rag: 2, generation: 2, research: 1, media: 1 },
  pdf_report_generation: { rag: 1, generation: 2, media: 1 },
  spreadsheet_generation: { generation: 2, code: 1 },
  summarization: { rag: 2 },
  translation: {},
  text_answer: {},
  small_talk: {},
  // agent_task is intentionally broad → triggers the widen path below.
});

const BROAD_INTENTS = new Set(['agent_task', 'agentic', 'agent_long_running_task', 'long_running_task']);

function toName(tool) {
  return tool && typeof tool === 'object' ? String(tool.name || '') : String(tool || '');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function categoriesFor(name) {
  const cats = [];
  for (const [cat, rx] of Object.entries(CATEGORY_PATTERNS)) {
    if (rx.test(name)) cats.push(cat);
  }
  return cats;
}

function buildCategoryWeights({ intent, signals }) {
  const weights = { web: 0, research: 0, rag: 0, code: 0, generation: 0, media: 0, memory: 0 };
  const it = String(intent || '').toLowerCase();
  const base = INTENT_CATEGORIES[it];
  if (base) for (const [c, w] of Object.entries(base)) weights[c] = (weights[c] || 0) + w;
  const s = signals || {};
  if (s.hasFiles) { weights.rag += 3; }
  if (s.hasCode) { weights.code += 2; }
  if (s.needsResearch) { weights.research += 2; weights.web += 2; }
  if (s.hasMedia) { weights.media += 3; }
  return weights;
}

function scoreTool(tool, ctx) {
  const name = toName(tool).toLowerCase();
  if (!name) return -1;
  const { categoryWeights, queryTokens, recommended } = ctx;
  let score = 0;
  for (const cat of categoriesFor(name)) score += categoryWeights[cat] || 0;
  // Query mentions the tool (or a token of its name).
  for (const tok of queryTokens) {
    if (tok.length >= 4 && name.includes(tok)) { score += 2; break; }
  }
  // Skill→tool recommendation from the existing adapter.
  if (recommended && recommended.has(name)) score += 2;
  return score;
}

function selectTools(rawInput, deps = {}) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const tools = Array.isArray(input.tools) ? input.tools.filter((t) => toName(t)) : [];
  const maxTools = Number(input.maxTools) || DEFAULT_MAX_TOOLS;
  const decision = input.decision || null;
  const intent = input.intent
    || (decision && decision.intent)
    || (decision && decision.routing && decision.routing.intent)
    || null;
  const signals = input.signals || {};

  const base = {
    tools,
    selectedNames: tools.map(toName),
    keptCount: tools.length,
    droppedCount: 0,
    reason: 'no_change',
    applied: false,
  };

  // Nothing to gain.
  if (tools.length <= maxTools) { base.reason = 'already_small'; return base; }

  // Uncertain → keep everything (zero risk).
  const it = String(intent || '').toLowerCase();
  if (!it || BROAD_INTENTS.has(it)) { base.reason = it ? 'broad_intent' : 'unknown_intent'; return base; }

  const adapter = 'skillAdapter' in deps ? deps.skillAdapter : defaultSkillAdapter;
  let recommended = null;
  try {
    if (adapter && typeof adapter.recommendToolsForIntent === 'function') {
      const rec = adapter.recommendToolsForIntent(intent, {
        hasDocuments: !!signals.hasFiles,
        hasCode: !!signals.hasCode,
        needsResearch: !!signals.needsResearch,
        needsAnalysis: !!signals.needsAnalysis,
      });
      recommended = new Set((rec && rec.concreteTools ? rec.concreteTools : []).map((n) => String(n).toLowerCase()));
    }
  } catch (_) { recommended = null; }

  const categoryWeights = buildCategoryWeights({ intent, signals });
  const queryTokens = tokenize(input.userQuery);
  const ctx = { categoryWeights, queryTokens, recommended };

  // Core set (present ones) — always kept.
  const coreSet = new Set();
  for (const t of tools) {
    const n = toName(t).toLowerCase();
    if (CORE_TOOLS.includes(n)) coreSet.add(toName(t));
    // When files are attached, never strand the document tools: document_edit
    // is the in-process "edit specific parts of my doc" path and has no
    // CATEGORY_PATTERNS entry (score 0), so without this it can be dropped on a
    // specific-intent turn even though the user attached a file to edit it.
    if (signals.hasFiles && /(rag_retrieve|docintel|deep_analyze|document_edit)/.test(n)) coreSet.add(toName(t));
    if ((signals.hasMedia || /media|image|chart/.test(it)) && /(create_document|generate_image|create_chart)/.test(n)) coreSet.add(toName(t));
  }

  // Score everything, then pick core + top-scored up to maxTools.
  const scored = tools.map((t) => ({ tool: t, name: toName(t), score: scoreTool(t, ctx) }));
  scored.sort((a, b) => b.score - a.score);

  const kept = new Map();
  for (const n of coreSet) kept.set(n, true);
  for (const s of scored) {
    if (kept.size >= maxTools) break;
    if (s.score <= 0 && kept.size >= MIN_KEPT) continue; // skip irrelevant once we have a floor
    kept.set(s.name, true);
  }
  // Guarantee a minimum even if scores were flat.
  if (kept.size < MIN_KEPT) {
    for (const s of scored) { if (kept.size >= MIN_KEPT) break; kept.set(s.name, true); }
  }

  const keptTools = tools.filter((t) => kept.has(toName(t)));
  // If we somehow didn't actually shrink, signal no change.
  if (keptTools.length >= tools.length) { base.reason = 'no_reduction'; return base; }

  return {
    tools: keptTools,
    selectedNames: keptTools.map(toName),
    keptCount: keptTools.length,
    droppedCount: tools.length - keptTools.length,
    reason: `selected:${it}`,
    applied: true,
  };
}

module.exports = {
  selectTools,
  scoreTool,
  categoriesFor,
  buildCategoryWeights,
  tokenize,
  CORE_TOOLS,
  CATEGORY_PATTERNS,
  INTENT_CATEGORIES,
  DEFAULT_MAX_TOOLS,
};
