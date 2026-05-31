'use strict';

/**
 * tool-schema-sanitizer — normalize a JSON Schema (a tool's "parameters")
 * into a shape that every LLM tool-calling backend accepts.
 *
 * Why this exists:
 *   OpenAI silently accepts schema shapes that Anthropic, Gemini, and
 *   llama.cpp's GBNF grammar generator reject:
 *     - bare `{ type: 'object' }` with no `properties`
 *     - union `type` arrays like `["string", "null"]`
 *     - `anyOf` / `oneOf` null-unions (`[{...}, {type:'null'}]`)
 *     - (Gemini only) `additionalProperties`, `default`, `const`, `$schema`…
 *   siraGPT routes tool-calling across OpenAI-compatible providers (OpenAI,
 *   DeepSeek, xAI, OpenRouter, and the Cerebras/Llama free tier) plus
 *   Anthropic and Gemini. Weaker models choke on hostile shapes and either
 *   refuse to emit a tool call or emit malformed arguments. This pass
 *   produces a conservative lowest-common-denominator schema so a tool that
 *   works on GPT-4o also works on Llama-3.1-8B.
 *
 * Design reimplemented in JS from NousResearch/hermes-agent's
 * `tools/schema_sanitizer.py` and openclaw's tool-call hardening (both MIT).
 *
 * Contract:
 *   - Pure: never mutates its input (every node is rebuilt).
 *   - Idempotent: sanitize(sanitize(x)) deep-equals sanitize(x).
 *   - Total: any input (including null/garbage) yields a valid object schema.
 */

const SANITIZER_VERSION = '1.0.0';

// Keys Gemini's function-declaration schema subset does NOT accept. Stripped
// only for the 'gemini' profile; OpenAI/Anthropic tolerate them.
const GEMINI_DROP_KEYS = new Set([
  'additionalProperties', '$schema', '$id', '$ref', '$defs', 'definitions',
  'default', 'examples', 'patternProperties', 'propertyNames', 'title',
  'if', 'then', 'else', 'not', 'dependencies', 'dependentSchemas',
  'dependentRequired', 'unevaluatedProperties', 'unevaluatedItems',
]);

// Keys handled explicitly inside sanitizeNode (not copied verbatim).
const STRUCTURAL_KEYS = new Set([
  'type', 'properties', 'items', 'required', 'const',
  'anyOf', 'oneOf', 'allOf',
]);

const MAX_DEPTH = 64;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Map a provider id (or model name) to a sanitization profile.
 *   - 'gemini'    → strictest (strip unsupported keywords, collapse combiners)
 *   - 'anthropic' → collapse null-unions, guarantee object `properties`
 *   - 'default'   → OpenAI + every OpenAI-compatible backend
 */
function profileFor(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'google' || p.startsWith('gemini')) return 'gemini';
  if (p === 'anthropic' || p.startsWith('claude')) return 'anthropic';
  return 'default';
}

// Collapse a `type` array, lifting a `null` member into `nullable: true`.
function normalizeType(node, out) {
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t) => t !== 'null');
    if (node.type.includes('null')) out.nullable = true;
    if (nonNull.length === 0) out.type = 'string';
    else out.type = nonNull[0]; // multi-type unions are unsupported by most backends
  } else if (typeof node.type === 'string') {
    out.type = node.type;
  }
}

// Inspect a list of combiner branches for the `[schema, {type:'null'}]` pattern.
function inspectBranches(branches) {
  const nonNull = branches.filter((b) => !(isPlainObject(b) && b.type === 'null'));
  const hadNull = nonNull.length !== branches.length;
  return { nonNull, hadNull, collapsible: nonNull.length === 1 };
}

function sanitizeNode(node, profile, depth) {
  if (depth > MAX_DEPTH || !isPlainObject(node)) return {};

  let out = {};

  // 1) Copy non-structural keys verbatim (dropping Gemini-hostile ones).
  for (const [key, val] of Object.entries(node)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (profile === 'gemini' && GEMINI_DROP_KEYS.has(key)) continue;
    out[key] = val;
  }

  // 2) Normalize `type` (collapse unions, lift null → nullable).
  normalizeType(node, out);

  // 3) `const` → single-value `enum` for Gemini; preserved elsewhere.
  if ('const' in node) {
    if (profile === 'gemini') out.enum = [node.const];
    else out.const = node.const;
  }

  // 4) anyOf / oneOf: collapse null-unions everywhere; on Gemini, reduce any
  //    remaining combiner to its first branch (uneven combiner support).
  for (const combiner of ['anyOf', 'oneOf']) {
    if (!Array.isArray(node[combiner])) continue;
    const { nonNull, hadNull, collapsible } = inspectBranches(node[combiner]);
    if (collapsible) {
      const kept = sanitizeNode(nonNull[0], profile, depth + 1);
      out = { ...kept, ...out };
      if (hadNull) out.nullable = true;
    } else if (profile === 'gemini') {
      const first = sanitizeNode(nonNull[0] || {}, profile, depth + 1);
      out = { ...first, ...out };
      if (hadNull) out.nullable = true;
    } else {
      out[combiner] = node[combiner].map((b) => sanitizeNode(b, profile, depth + 1));
    }
  }

  // 5) allOf: shallow-merge on Gemini (no combiner support), else recurse.
  if (Array.isArray(node.allOf)) {
    if (profile === 'gemini') {
      let merged = {};
      for (const b of node.allOf) merged = { ...merged, ...sanitizeNode(b, profile, depth + 1) };
      out = { ...merged, ...out };
    } else {
      out.allOf = node.allOf.map((b) => sanitizeNode(b, profile, depth + 1));
    }
  }

  // 6) properties — recurse; guarantee an object schema always has one.
  const looksObject = out.type === 'object' || isPlainObject(node.properties);
  if (isPlainObject(node.properties)) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = sanitizeNode(v, profile, depth + 1);
    }
  }
  if (looksObject) {
    if (!isPlainObject(out.properties)) out.properties = {};
    if (out.type === undefined) out.type = 'object';
    // `required` must list only string keys that actually exist; a required
    // name with no matching property is a common strict-backend reject.
    if (Array.isArray(node.required)) {
      const present = node.required.filter(
        (r) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(out.properties, r),
      );
      if (present.length) out.required = present;
    }
  }

  // 7) items — recurse; collapse tuple typing; guarantee arrays have items.
  if (out.type === 'array' || node.items !== undefined) {
    if (isPlainObject(node.items)) {
      out.items = sanitizeNode(node.items, profile, depth + 1);
    } else if (Array.isArray(node.items)) {
      out.items = sanitizeNode(node.items[0] || {}, profile, depth + 1);
    }
    if (out.type === 'array' && !isPlainObject(out.items)) out.items = {};
  }

  return out;
}

/**
 * Sanitize any JSON Schema node. Returns a normalized deep copy.
 * @param {*} schema   the schema (object); anything else yields {}.
 * @param {{provider?: string}} [opts]
 */
function sanitizeJsonSchema(schema, opts = {}) {
  return sanitizeNode(schema, profileFor(opts.provider), 0);
}

/**
 * Sanitize a value destined for a function/tool `parameters` field. A
 * function's parameters MUST be an object schema, so a non-object result is
 * coerced to an empty object schema.
 */
function sanitizeToolParameters(schema, opts = {}) {
  const out = sanitizeJsonSchema(schema, opts);
  if (out.type !== 'object') {
    return { type: 'object', properties: isPlainObject(out.properties) ? out.properties : {} };
  }
  if (!isPlainObject(out.properties)) out.properties = {};
  return out;
}

/**
 * Sanitize a single tool descriptor, accepting either the OpenAI shape
 * (`{ type:'function', function:{ name, description, parameters } }`) or the
 * bare shape (`{ name, description, parameters }`). Returns a new object;
 * the input is never mutated.
 */
function sanitizeOpenAITool(tool, opts = {}) {
  if (!isPlainObject(tool)) return tool;
  if (isPlainObject(tool.function)) {
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeToolParameters(tool.function.parameters, opts),
      },
    };
  }
  if ('parameters' in tool) {
    return { ...tool, parameters: sanitizeToolParameters(tool.parameters, opts) };
  }
  return tool;
}

/** Sanitize an array of tool descriptors. */
function sanitizeTools(tools, opts = {}) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => sanitizeOpenAITool(t, opts));
}

module.exports = {
  SANITIZER_VERSION,
  profileFor,
  sanitizeJsonSchema,
  sanitizeToolParameters,
  sanitizeOpenAITool,
  sanitizeTools,
};
