'use strict';

/**
 * model-availability.js — Nivel 1: make intelligent routing SAFE to enable.
 * ───────────────────────────────────────────────────────────────────────────
 * The reasoning-orchestrator routes against ai-product-os/model-router's
 * CATALOG, which mixes real, reachable models (gpt-4o, gemini-2.5-*, …) with
 * aspirational placeholder IDs (gpt-5.5, claude-opus-4.7, gemini-3.5, …). In
 * `escalate`/`auto` mode that means the router could re-route a turn to a model
 * id that doesn't exist or whose provider isn't configured — a wasted round
 * trip (the ai-service fallback chain recovers, but at a latency cost).
 *
 * This module decides REACHABILITY deterministically from the environment:
 *   1. The model's provider must have an API key configured.
 *   2. The id must not be on the aspirational blocklist, and — if an explicit
 *      allowlist is set — must be on it.
 *
 * No network call (a future live-probe layer can extend this). Pure +
 * env-injectable so it's fully unit-tested. The orchestrator consumes the
 * resulting reachable-id set; when none is supplied it behaves exactly as
 * before (no filtering), so this is backward-compatible.
 *
 * Public API:
 *   providerKeyPresent(provider, env?)            → boolean
 *   isReachable(id, provider, { env? })           → boolean
 *   reachableModelIds(catalog, { env? })          → Set<string>
 *   resolveReachable(preferred, alts, lookup, opts?) → string | null
 *   PROVIDER_ENV_KEYS, DEFAULT_ASPIRATIONAL
 */

// Provider → the env var(s) that, when present, make that provider callable.
// Mirrors the providers SiraGPT actually wires (ai-service / createProviderClient).
const PROVIDER_ENV_KEYS = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
});

// Known not-yet-real placeholder ids in the catalog. Conservative default;
// override with SIRAGPT_AUTO_ROUTING_BLOCKLIST (comma-separated) per deployment
// as these graduate to real models.
const DEFAULT_ASPIRATIONAL = Object.freeze([
  'openai/gpt-5.5', 'gpt-5', 'gpt-5-mini',
  'anthropic/claude-opus-4.7',
  'google/gemini-3.5',
  'x-ai/grok-4.20',
  'z-ai/glm-5.1',
  'deepseek/deepseek-v4-pro',
  'moonshotai/kimi-k2.6',
]);

function getEnv(env) {
  return env && typeof env === 'object' ? env : process.env;
}

function csvSet(value) {
  if (!value || typeof value !== 'string') return null;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? new Set(items) : null;
}

function providerKeyPresent(provider, env) {
  const e = getEnv(env);
  const keys = PROVIDER_ENV_KEYS[String(provider || '').toLowerCase()];
  if (!keys) return false;
  return keys.some((k) => typeof e[k] === 'string' && e[k].trim().length > 0);
}

function aspirationalSet(env) {
  const e = getEnv(env);
  const override = csvSet(e.SIRAGPT_AUTO_ROUTING_BLOCKLIST);
  return override || new Set(DEFAULT_ASPIRATIONAL);
}

function allowlistSet(env) {
  return csvSet(getEnv(env).SIRAGPT_AUTO_ROUTING_ALLOWLIST);
}

/**
 * Is a specific model id reachable right now?
 *   - provider key must be present, AND
 *   - if an allowlist is configured → id must be on it,
 *   - else → id must not be on the aspirational blocklist.
 */
function isReachable(id, provider, { env } = {}) {
  if (!id) return false;
  if (!providerKeyPresent(provider, env)) return false;
  const allow = allowlistSet(env);
  if (allow) return allow.has(id);
  return !aspirationalSet(env).has(id);
}

/** Set of reachable model ids from a catalog ([{ id, provider }, …]). */
function reachableModelIds(catalog, { env } = {}) {
  const out = new Set();
  if (!Array.isArray(catalog)) return out;
  for (const m of catalog) {
    if (m && m.id && isReachable(m.id, m.provider, { env })) out.add(m.id);
  }
  return out;
}

/**
 * Pick the best reachable model: the preferred id if reachable, else the first
 * reachable alternative, else null. `lookup(id)` returns a catalog entry
 * ({ provider }) so we can check each candidate's provider.
 *
 * @param {string} preferred
 * @param {Array<{id:string}|string>} alternatives
 * @param {(id:string)=>({provider:string}|null)} lookup
 */
function resolveReachable(preferred, alternatives, lookup, { env } = {}) {
  const get = typeof lookup === 'function' ? lookup : () => null;
  const reach = (id) => {
    const m = get(id);
    return m ? isReachable(id, m.provider, { env }) : false;
  };
  if (preferred && reach(preferred)) return preferred;
  for (const a of Array.isArray(alternatives) ? alternatives : []) {
    const id = typeof a === 'string' ? a : (a && a.id);
    if (id && reach(id)) return id;
  }
  return null;
}

module.exports = {
  providerKeyPresent,
  isReachable,
  reachableModelIds,
  resolveReachable,
  aspirationalSet,
  allowlistSet,
  PROVIDER_ENV_KEYS,
  DEFAULT_ASPIRATIONAL,
};
