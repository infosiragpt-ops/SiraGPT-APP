'use strict';

/**
 * prompt-cache-stability — deterministic prompt/serialization helpers so
 * provider prompt caching keeps hitting across turns.
 *
 * Long agent conversations break provider-side prompt caches when "the same"
 * system block or tool result serializes differently between turns (CRLF vs
 * LF, trailing whitespace, Map-insertion ordering, circular refs stringified
 * differently). These helpers normalize those inputs once so byte-identical
 * prompts stay byte-identical.
 *
 * Adapted from OpenClaw v2026.6.11 (MIT — Copyright (c) 2026 OpenClaw
 * Foundation): `src/agents/prompt-cache-stability.ts` and
 * `src/agents/stable-stringify.ts`, rewritten for the SiraGPT backend
 * (CommonJS, no external deps). Upstream reference mirrored under
 * `src/upstream/openclaw/`.
 *
 * Pure, deterministic, no I/O.
 */

/** Normalize structured prompt text before hashing or cache-key comparison. */
function normalizeStructuredPromptSection(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Normalize, de-dupe and sort capability/tool ids for stable prompt payloads. */
function normalizePromptCapabilityIds(capabilities) {
  const seen = new Set();
  const normalized = [];
  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    const value = normalizeStructuredPromptSection(capability).toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.sort((a, b) => a.localeCompare(b));
}

/**
 * Deterministically stringify unknown values for cache keys and diagnostics.
 * Handles: key ordering, Errors, Uint8Array, BigInt, non-finite numbers and
 * circular references — all the shapes tool results actually carry.
 */
function stableStringify(value) {
  return stringifyStableValue(value, new WeakSet());
}

function stringifyStableValue(value, stack) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  }
  if (stack.has(value)) return JSON.stringify('[Circular]');
  stack.add(value);
  try {
    return stringifyObjectValue(value, stack);
  } finally {
    stack.delete(value);
  }
}

function stringifyObjectValue(value, stack) {
  if (value instanceof Error) {
    return stringifyStableValue(
      { name: value.name, message: value.message, stack: value.stack },
      stack,
    );
  }
  if (value instanceof Uint8Array) {
    return stringifyStableValue(
      { type: 'Uint8Array', data: Buffer.from(value).toString('base64') },
      stack,
    );
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => stringifyStableValue(entry, stack));
    return `[${entries.join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const v = value[key];
    if (typeof v === 'function' || v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stringifyStableValue(v, stack)}`);
  }
  return `{${parts.join(',')}}`;
}

module.exports = {
  normalizeStructuredPromptSection,
  normalizePromptCapabilityIds,
  stableStringify,
};