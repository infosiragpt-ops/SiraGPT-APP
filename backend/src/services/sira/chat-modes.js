/**
 * chat-modes — mode-aware orchestration scaffolding.
 *
 * From the expanded vision: "Una versión todavía más premium sería que
 * tenga modos de trabajo, y que cada modo tenga sus propios prompts,
 * herramientas, permisos y flujo." This module formalizes that idea
 * as a typed contract every mode must satisfy.
 *
 * What a mode actually is
 * -----------------------
 * A mode is a *named bundle of policies* that scopes a chat turn. It
 * does not reimplement orchestration; it constrains the existing
 * orchestrator. The constraints are:
 *
 *   - `tool_whitelist`     — only these tools may run; everything
 *                            else is a `tool_policy_denied`.
 *   - `tool_blocklist`     — the inverse, applied before whitelist
 *                            so a generic tool can be banned within
 *                            a mode (e.g. no `web_search` while in
 *                            "code" mode unless explicit opt-in).
 *   - `system_prompt_addendum` — mode-specific guidance appended to
 *                            the master prompt. Short by design.
 *   - `validator_profile`  — name of the profile inside
 *                            `validator-engine` to apply (artifact +
 *                            source for "research", code + safety for
 *                            "code", etc.).
 *   - `intent_families`    — the intent-taxonomy families the mode
 *                            considers in-scope. Out-of-scope intents
 *                            either fall back to "chat" mode or
 *                            request clarification.
 *   - `default_response_format` — text | json | json_schema.
 *   - `requires_human_approval_for` — array of side-effect levels
 *                            ("publish", "send", "delete") this mode
 *                            forces through human-in-the-loop.
 *
 * Resolution order
 * ----------------
 *   1. caller-supplied `mode` (HTTP body or chat-controller arg).
 *   2. envelope.mode_hint (set by intent classifier when confidence
 *      is high).
 *   3. taxonomy family → mode mapping (heuristic fallback).
 *   4. "chat" (the safe default — no extra constraints).
 *
 * Wiring into chat-controller / runtime is intentionally a follow-up
 * commit: this one defines the contract + the resolver + the tool
 * policy override + tests, with the same pattern as task 7
 * (context-compactor) and task 9 (citation-frame): contract first,
 * integration second.
 */

// ── Mode catalog ───────────────────────────────────────────────────

const MODES = Object.freeze({
  chat: {
    label: "Chat",
    description: "Default conversational mode. No extra restrictions.",
    tool_whitelist: null,            // null = allow any registered tool
    tool_blocklist: [],
    system_prompt_addendum: "",
    validator_profile: "default",
    intent_families: [],             // empty = accept any family
    default_response_format: "text",
    requires_human_approval_for: ["publish", "send", "delete"],
  },
  research: {
    label: "Research",
    description: "Source-grounded answers. Citations required, fabrication blocked.",
    tool_whitelist: ["web_search", "web_extract", "read_url", "rag_retrieve", "openalex_search", "crossref_verify", "read_file", "session_search", "session_history"],
    tool_blocklist: ["execute_sandboxed_code", "publish_online", "send_message", "database_write"],
    system_prompt_addendum: [
      "You are in RESEARCH mode.",
      "Every factual claim must cite a source from the SOURCES block as [Source: N].",
      "If the available sources do not support a claim, say so explicitly instead of inventing.",
      "Prefer recent and authoritative sources. Note when a source is older than 3 years.",
    ].join(" "),
    validator_profile: "source_strict",  // artifact + source validators required
    intent_families: ["research", "education"],
    default_response_format: "text",
    requires_human_approval_for: ["publish", "send", "delete"],
  },
  document: {
    label: "Document",
    description: "Structured artifact generation: DOCX, PDF, reports.",
    tool_whitelist: ["docx_generation", "report_generation", "pdf_generation", "rag_retrieve", "read_file"],
    tool_blocklist: ["publish_online", "send_message", "execute_sandboxed_code"],
    system_prompt_addendum: [
      "You are in DOCUMENT mode.",
      "Produce a complete, well-structured document.",
      "Use sections (H1/H2), include a table of contents when length warrants it,",
      "and ensure references are present when sources were provided.",
    ].join(" "),
    validator_profile: "document_strict",  // document + artifact validators
    intent_families: ["document_artifacts"],
    default_response_format: "text",
    requires_human_approval_for: ["publish", "send", "delete"],
  },
  code: {
    label: "Code",
    description: "Software engineering tasks. Sandboxed execution + lint/test gates.",
    tool_whitelist: ["code_generation", "execute_sandboxed_code", "read_file", "rag_retrieve"],
    tool_blocklist: ["publish_online", "send_message", "database_write", "web_search", "web_extract", "read_url"],
    system_prompt_addendum: [
      "You are in CODE mode.",
      "All code must compile/parse cleanly.",
      "Never include secrets, credentials, or production endpoints.",
      "Prefer the smallest correct change; keep diffs reviewable.",
    ].join(" "),
    validator_profile: "code_strict",  // code + safety validators
    intent_families: ["coding"],
    default_response_format: "text",
    requires_human_approval_for: ["publish", "send", "delete", "deploy"],
  },
  presentation: {
    label: "Presentation",
    description: "Slide decks, charts, and executive-style visual artifacts.",
    tool_whitelist: ["pptx_generation", "svg_generation", "image_generation", "rag_retrieve", "read_file"],
    tool_blocklist: ["publish_online", "send_message", "execute_sandboxed_code"],
    system_prompt_addendum: [
      "You are in PRESENTATION mode.",
      "Optimize for clarity at a glance: short titles, one idea per slide,",
      "visuals that carry the argument. Avoid wall-of-text bullets.",
    ].join(" "),
    validator_profile: "artifact_strict",
    intent_families: ["presentation_artifacts", "design_visual"],
    default_response_format: "text",
    requires_human_approval_for: ["publish", "send", "delete"],
  },
});

const DEFAULT_MODE = "chat";

// Family → mode fallback. When neither caller nor envelope hint at a
// mode, we map the primary intent's family to the closest mode.
// Anything not in this table falls back to DEFAULT_MODE.
const FAMILY_TO_MODE = Object.freeze({
  research: "research",
  education: "research",       // study/learning gets the source-grounded surface
  document_artifacts: "document",
  coding: "code",
  presentation_artifacts: "presentation",
  design_visual: "presentation",
  // explicitly mapped to "chat":
  conversation: "chat",
});

// ── Public API ─────────────────────────────────────────────────────

function listModes() {
  return Object.keys(MODES);
}

function getModeConfig(mode) {
  if (typeof mode !== "string" || !MODES[mode]) return null;
  // Defensive copy: callers shouldn't be able to mutate the catalog.
  return JSON.parse(JSON.stringify(MODES[mode]));
}

/**
 * Resolve which mode applies to a given turn.
 *
 * @param {object} args
 * @param {string} [args.callerMode]   — explicit override from HTTP body / arg
 * @param {object} [args.envelope]     — the Sira Cognitive Task Envelope
 * @returns {{ mode: string, source: "caller"|"envelope_hint"|"family_fallback"|"default" }}
 */
function resolveMode({ callerMode = null, envelope = null } = {}) {
  if (typeof callerMode === "string" && MODES[callerMode]) {
    return { mode: callerMode, source: "caller" };
  }
  const hint = envelope && typeof envelope.mode_hint === "string" ? envelope.mode_hint : null;
  if (hint && MODES[hint]) {
    return { mode: hint, source: "envelope_hint" };
  }
  const family = envelope?.intent_analysis?.primary_intent?.task_family
    || envelope?.intent_analysis?.task_family
    || null;
  if (family && FAMILY_TO_MODE[family]) {
    return { mode: FAMILY_TO_MODE[family], source: "family_fallback" };
  }
  return { mode: DEFAULT_MODE, source: "default" };
}

/**
 * Returns true when `toolName` is allowed under `mode`. Runs the
 * blocklist first (a generic tool blocked in this mode wins), then
 * the whitelist if one is set.
 */
function isToolAllowedInMode(mode, toolName) {
  const cfg = MODES[mode];
  if (!cfg) return true;          // unknown mode: don't gate
  if (Array.isArray(cfg.tool_blocklist) && cfg.tool_blocklist.includes(toolName)) return false;
  if (Array.isArray(cfg.tool_whitelist) && cfg.tool_whitelist !== null) {
    return cfg.tool_whitelist.includes(toolName);
  }
  return true;
}

/**
 * Filter an envelope's tool plan through the mode constraints. Does
 * not mutate the input. Tools that were `required` and got dropped
 * are reported in `dropped_required` so the caller can decide whether
 * to fail closed (recommended for "code"/"research") or fall back
 * to a less-restricted mode.
 */
function applyModeToToolPlan(envelope, mode) {
  if (!envelope || !envelope.tool_plan) return { tool_plan: null, dropped_required: [] };
  const required = Array.isArray(envelope.tool_plan.required_tools) ? envelope.tool_plan.required_tools : [];
  const optional = Array.isArray(envelope.tool_plan.optional_tools) ? envelope.tool_plan.optional_tools : [];
  const dropped = [];
  const filteredRequired = required.filter((t) => {
    const ok = isToolAllowedInMode(mode, t.tool_name || t.name);
    if (!ok) dropped.push(t.tool_name || t.name);
    return ok;
  });
  const filteredOptional = optional.filter((t) => isToolAllowedInMode(mode, t.tool_name || t.name));
  return {
    tool_plan: {
      ...envelope.tool_plan,
      required_tools: filteredRequired,
      optional_tools: filteredOptional,
    },
    dropped_required: dropped,
  };
}

/**
 * Compose the mode's system prompt addendum onto a base system
 * prompt. Returns the original base when the mode has no addendum
 * so the call is safe to wire unconditionally.
 */
function applyModePrompt(basePrompt, mode) {
  const cfg = MODES[mode];
  if (!cfg || !cfg.system_prompt_addendum) return basePrompt || "";
  if (!basePrompt) return cfg.system_prompt_addendum;
  return `${basePrompt}\n\n${cfg.system_prompt_addendum}`;
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  FAMILY_TO_MODE,
  listModes,
  getModeConfig,
  resolveMode,
  isToolAllowedInMode,
  applyModeToToolPlan,
  applyModePrompt,
};
