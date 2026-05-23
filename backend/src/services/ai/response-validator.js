'use strict';

/**
 * Runtime contract checks for LLM JSON responses.
 *
 * LLMs occasionally:
 *   - wrap JSON in ```json ... ``` fences
 *   - prepend explanatory prose ("Sure, here's the JSON: ...")
 *   - drop a trailing comma or add a leading BOM
 *   - emit JSON5-style quoting (we DO NOT try to parse JSON5 here — instead
 *     we surface a structured error and let the caller retry)
 *
 * `validate(rawText, schema)` does best-effort extraction + Zod validation
 * and ALWAYS returns `{ ok, data?, error? }` — it never throws. The optional
 * `retryPrompt(originalPrompt, error)` helper builds a self-correction prompt
 * the caller can resend to the model.
 *
 * This module has zero external dependencies beyond zod (already in tree),
 * so it can be required from any code path (agents, document pipeline, etc.)
 * without spinning up SDKs.
 */

const { ZodError } = require('zod');

// Common fence patterns — covers ```json, ```JSON, ```typescript (rare but
// seen with tool-using models that fall back to TS interfaces), and bare ```.
const FENCE_RE = /```(?:json|JSON|javascript|js|ts|typescript)?\s*\n?([\s\S]*?)```/g;

/**
 * Pull the most plausible JSON document out of a raw LLM response.
 * Strategy:
 *   1. If the entire text already parses as JSON, return it.
 *   2. Try every fenced block; return the first that parses.
 *   3. Walk the string for the outermost balanced { } or [ ] span and try
 *      that as a last resort.
 *
 * Returns the raw string slice — caller still has to JSON.parse it. We
 * return the string so callers can include it in error messages.
 */
function extractJsonCandidate(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim().replace(/^﻿/, '');

  // Fast path — whole thing is JSON.
  if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // fall through
    }
  }

  // Fenced blocks.
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(trimmed)) !== null) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // try next fence
    }
  }

  // Balanced-brace walk — find the first { or [ then track depth.
  const startIdx = trimmed.search(/[\[{]/);
  if (startIdx >= 0) {
    const opener = trimmed[startIdx];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(startIdx, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // give up — caller surfaces the original parse error
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Validate `rawText` against `schema`. Never throws.
 *
 * Result shape:
 *   { ok: true, data }
 *   { ok: false, error: { kind, message, details? } }
 *
 * `error.kind` is one of:
 *   - "no_json"        — couldn't find any JSON in the response
 *   - "parse_error"    — JSON.parse failed
 *   - "schema_error"   — Zod rejected the structure (`details` = issues[])
 *   - "bad_schema"     — caller passed something that isn't a zod schema
 */
function validate(rawText, schema) {
  if (!schema || typeof schema.safeParse !== 'function') {
    return {
      ok: false,
      error: { kind: 'bad_schema', message: 'validate() requires a zod schema' },
    };
  }
  const candidate = extractJsonCandidate(rawText);
  if (candidate == null) {
    return {
      ok: false,
      error: {
        kind: 'no_json',
        message: 'No JSON object or array could be extracted from the response',
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'parse_error',
        message: err && err.message ? err.message : 'JSON.parse failed',
      },
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error instanceof ZodError ? result.error.issues : [];
    return {
      ok: false,
      error: {
        kind: 'schema_error',
        message: 'Response failed schema validation',
        details: issues.map((i) => ({
          path: Array.isArray(i.path) ? i.path.join('.') : '',
          code: i.code,
          message: i.message,
          expected: i.expected,
          received: i.received,
        })),
      },
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Build a follow-up prompt instructing the model to self-correct.
 * Tries to be specific — for schema_error it lists each failing path, for
 * parse_error it explains the JSON.parse complaint, etc. Keep the wording
 * imperative and short; models follow short directives better.
 */
function retryPrompt(originalPrompt, error) {
  const base = String(originalPrompt || '').trim();
  const lines = [];
  lines.push(base || 'Please provide the requested JSON response.');
  lines.push('');
  lines.push('Your previous response was rejected. Please respond again, this time:');
  lines.push('- Reply with ONLY a single JSON document (no prose, no markdown fences).');
  lines.push('- Ensure it parses with JSON.parse — no trailing commas, no comments.');

  if (error && error.kind === 'schema_error' && Array.isArray(error.details)) {
    lines.push('- Fix the following schema violations:');
    for (const d of error.details.slice(0, 10)) {
      const path = d.path || '(root)';
      const expected = d.expected != null ? ` expected ${JSON.stringify(d.expected)}` : '';
      const received = d.received != null ? ` got ${JSON.stringify(d.received)}` : '';
      lines.push(`  - ${path}: ${d.message}${expected}${received}`);
    }
  } else if (error && error.kind === 'parse_error') {
    lines.push(`- Previous error: ${error.message}`);
  } else if (error && error.kind === 'no_json') {
    lines.push('- The previous response did not contain any JSON. Reply with a single JSON document.');
  }
  return lines.join('\n');
}

module.exports = {
  validate,
  retryPrompt,
  extractJsonCandidate,
};
