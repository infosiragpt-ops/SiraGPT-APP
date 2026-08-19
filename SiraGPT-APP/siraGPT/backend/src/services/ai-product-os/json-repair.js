'use strict';

/**
 * json-repair — best-effort recovery for JSON-ish text emitted by
 * LLMs that promised structured output but missed by a hair: fenced
 * code blocks, trailing commentary, missing closing brace, trailing
 * commas, single-quoted strings. Pairs with the streaming-tool-call
 * assembler (#19): when arguments come back as a string but won't
 * parse, run them through `repairJson` before giving up.
 *
 * Strategy (cheap-first, never throws):
 *   1. Strip ```json … ``` (or any ``` fence) wrappers.
 *   2. Trim leading/trailing prose around the JSON span.
 *   3. Balance braces/brackets by counting unescaped openers/closers.
 *   4. Remove trailing commas before } or ].
 *   5. Replace single-quoted strings with double-quoted equivalents
 *      (only when the input has no double quotes — heuristic).
 *   6. JSON.parse the repaired text; on failure return the partial
 *      result alongside `ok:false` so callers can decide.
 *
 * Public API:
 *   repairJson(input) → { ok, value?, repaired, originalLength,
 *                          repairs: string[], error? }
 *   stripCodeFence(input) → string
 *   sliceJsonSpan(input)  → string
 *
 * Pure JS, dependency-free.
 */

function stripCodeFence(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  // ```json\n…\n``` or ```\n…\n```
  const m = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (m) return m[1].trim();
  return trimmed;
}

function sliceJsonSpan(input) {
  if (typeof input !== 'string') return '';
  const text = input.trim();
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    start = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
  }
  if (start === -1) return text;
  // Find the last matching close — naive walk balancing depth, ignoring
  // braces inside strings.
  let depth = 0;
  let inStr = false;
  let strQuote = '';
  let escape = false;
  let lastClose = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === strQuote) { inStr = false; }
      continue;
    }
    if (c === '"' || c === '\'') { inStr = true; strQuote = c; continue; }
    if (c === '{' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) { lastClose = i; break; }
    }
  }
  if (lastClose === -1) return text.slice(start);
  return text.slice(start, lastClose + 1);
}

function balanceBrackets(input) {
  // Count unescaped openers/closers ignoring strings.
  let openCurly = 0, closeCurly = 0;
  let openSquare = 0, closeSquare = 0;
  let inStr = false, q = '', esc = false;
  for (const c of input) {
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === '\'') { inStr = true; q = c; continue; }
    if (c === '{') openCurly += 1;
    else if (c === '}') closeCurly += 1;
    else if (c === '[') openSquare += 1;
    else if (c === ']') closeSquare += 1;
  }
  let out = input;
  if (openCurly > closeCurly) out = out + '}'.repeat(openCurly - closeCurly);
  if (openSquare > closeSquare) out = out + ']'.repeat(openSquare - closeSquare);
  return out;
}

function stripTrailingCommas(input) {
  return input.replace(/,(\s*[}\]])/g, '$1');
}

function singleToDoubleQuotes(input) {
  if (input.includes('"')) return input; // mixed → leave alone
  // Replace ' with " for keys/values; naive but safe when no " present.
  return input.replace(/'/g, '"');
}

function repairJson(input) {
  const original = typeof input === 'string' ? input : '';
  const repairs = [];
  if (!original) {
    return { ok: false, repaired: '', originalLength: 0, repairs, error: 'empty input' };
  }
  let working = original;

  const stripped = stripCodeFence(working);
  if (stripped !== working.trim()) repairs.push('strip_code_fence');
  working = stripped;

  const sliced = sliceJsonSpan(working);
  if (sliced !== working) repairs.push('slice_json_span');
  working = sliced;

  const noTrailing = stripTrailingCommas(working);
  if (noTrailing !== working) repairs.push('strip_trailing_commas');
  working = noTrailing;

  const quoted = singleToDoubleQuotes(working);
  if (quoted !== working) repairs.push('single_to_double_quotes');
  working = quoted;

  const balanced = balanceBrackets(working);
  if (balanced !== working) repairs.push('balance_brackets');
  working = balanced;

  // Try to parse — fall back through one more strip-trailing pass in
  // case the slice/balance step exposed new trailing commas.
  let value;
  try {
    value = JSON.parse(working);
    return { ok: true, value, repaired: working, originalLength: original.length, repairs };
  } catch (e1) {
    const second = stripTrailingCommas(working);
    if (second !== working) {
      try {
        value = JSON.parse(second);
        repairs.push('strip_trailing_commas_pass2');
        return { ok: true, value, repaired: second, originalLength: original.length, repairs };
      } catch (e2) {
        return { ok: false, repaired: second, originalLength: original.length, repairs, error: e2.message };
      }
    }
    return { ok: false, repaired: working, originalLength: original.length, repairs, error: e1.message };
  }
}

module.exports = {
  repairJson,
  stripCodeFence,
  sliceJsonSpan,
  balanceBrackets,
  stripTrailingCommas,
  singleToDoubleQuotes,
};
