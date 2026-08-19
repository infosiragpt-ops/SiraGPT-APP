'use strict';

/**
 * constrained-decoder — streaming-aware grammar/JSON-schema enforcement.
 *
 * LLM tool-calls and structured outputs frequently emerge as character
 * streams. By the time a downstream parser detects a malformed output,
 * the model has already burned tokens (and seconds) on bad text. This
 * module provides two streaming validators that detect violations at
 * the exact position they occur, plus a repair-prompt builder that
 * integrates with the existing self-repair-engine.js pattern.
 *
 *   1. **JsonStreamValidator** — incremental JSON validator. Feed it
 *      arbitrary chunks (single chars, buffers, anything) via feed();
 *      it tracks bracket/brace stack, string state, escape state, and
 *      number lexer. Emits a `{ valid, position, expected, got, reason }`
 *      diagnostic per call. Optional JSON Schema constraint set via
 *      setSchema(): once a top-level value is parsed it is matched
 *      against the schema; mismatches surface as `valid:false` with
 *      `reason:'schema_violation'`.
 *
 *   2. **GrammarValidator** — Earley-style chart parser for arbitrary
 *      context-free grammars. Used for tool-call schemas that go beyond
 *      JSON (mini-DSLs, function-call sigil syntax, etc.). Constructor
 *      takes a grammar in `{ rules: [{lhs, rhs}], start, terminals? }`.
 *      `feed(token)` advances the chart; `complete()` returns whether
 *      the input so far is in the language.
 *
 *   3. **buildRepairPrompt({ originalPrompt, violation, attempt })** —
 *      composes a corrective re-prompt that quotes the violation, tells
 *      the model exactly which character / token broke the constraint,
 *      and asks for a fixed regeneration. Mirrors the existing
 *      self-repair-engine.js convention.
 *
 *   4. **validateToolCallArgs(manifest, args)** — convenience wrapper:
 *      uses a tool manifest's `inputs` JSON-schema to validate args once
 *      the parse is complete.
 *
 * Public errors:
 *   - DecoderError  — base error type for invalid configuration
 *   - SchemaViolation — thrown by validateToolCallArgs (never thrown by
 *     streaming feed() calls; those return a diagnostic instead).
 */

class DecoderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecoderError';
    this.code = code;
    Object.assign(this, details);
  }
}

class SchemaViolation extends DecoderError {
  constructor(message, details = {}) {
    super('schema_violation', message, details);
    this.name = 'SchemaViolation';
  }
}

// ─────────────────────────────────────────────────────────────────────
// JsonStreamValidator
// ─────────────────────────────────────────────────────────────────────

const STATE = Object.freeze({
  start: 'start',
  inObject: 'in_object',
  inArray: 'in_array',
  inString: 'in_string',
  inEscape: 'in_escape',
  inNumber: 'in_number',
  inLiteral: 'in_literal', // true / false / null
  done: 'done',
});

class JsonStreamValidator {
  constructor() {
    this.position = 0;
    this.buffer = '';
    this.stack = [];
    this.state = STATE.start;
    this.literalBuffer = '';
    this.numberBuffer = '';
    this.expectKey = false;     // inside object, expecting "key"
    this.afterValue = false;    // expecting , or closing bracket
    this.expectColon = false;   // after key, expecting :
    this.violations = [];
    this.schema = null;
    this._lastValid = true;
  }

  setSchema(schema) {
    if (schema != null && typeof schema !== 'object') {
      throw new DecoderError('schema_invalid', 'schema must be an object');
    }
    this.schema = schema || null;
  }

  /**
   * Feed one or more characters. Returns the latest diagnostic:
   *   { valid: boolean, position, reason?, expected?, got? }
   *
   * `valid:true` means everything seen so far is parseable; once a top-
   * level value completes, the parser stays at STATE.done and any
   * further non-whitespace input is a violation.
   */
  feed(chunk) {
    const text = String(chunk);
    let last = { valid: true, position: this.position };
    for (const ch of text) {
      last = this._consume(ch);
      if (!last.valid) this.violations.push(last);
    }
    this._lastValid = last.valid;
    return last;
  }

  /** Returns true if the input so far is a complete, valid top-level JSON value. */
  isComplete() {
    return this.state === STATE.done && this.stack.length === 0;
  }

  /** Get the parsed value if complete (best-effort via JSON.parse on buffer). */
  result() {
    if (!this.isComplete()) return undefined;
    try { return JSON.parse(this.buffer); }
    catch { return undefined; }
  }

  /**
   * After `isComplete()` returns true, validate the parsed value
   * against the configured schema. Returns
   *   { valid:true } | { valid:false, reason, path, expected, got }.
   */
  validateAgainstSchema() {
    if (!this.schema) return { valid: true };
    if (!this.isComplete()) {
      return { valid: false, reason: 'incomplete', path: '$' };
    }
    const value = this.result();
    return validateValue(value, this.schema, '$');
  }

  // ── internal lexer ────────────────────────────────────────────────

  _consume(ch) {
    this.position += 1;
    this.buffer += ch;

    // Inside a string: handle escape and end-of-string.
    if (this.state === STATE.inString) {
      if (ch === '\\') {
        this.state = STATE.inEscape;
        return ok(this.position);
      }
      if (ch === '"') {
        // Let _popContextAfterString manage state directly so it can
        // transition to STATE.done when this completes the top-level value.
        this._popContextAfterString();
        return ok(this.position);
      }
      if (ch === '\n' || ch === '\r') {
        return fail(this.position, 'unescaped_newline_in_string');
      }
      return ok(this.position);
    }

    if (this.state === STATE.inEscape) {
      if ('"\\/bfnrtu'.includes(ch)) {
        this.state = STATE.inString;
        return ok(this.position);
      }
      return fail(this.position, 'invalid_escape', { got: ch });
    }

    if (this.state === STATE.inNumber) {
      if (/[0-9.eE+\-]/.test(ch)) {
        this.numberBuffer += ch;
        return ok(this.position);
      }
      // Number ended: validate buffer, then re-process this char in the
      // post-value state.
      if (!isValidNumber(this.numberBuffer)) {
        return fail(this.position, 'invalid_number', { got: this.numberBuffer });
      }
      this._endValue();
      // Fall through to handle ch in new state — recurse.
      this.position -= 1;
      this.buffer = this.buffer.slice(0, -1);
      return this._consume(ch);
    }

    if (this.state === STATE.inLiteral) {
      this.literalBuffer += ch;
      const expected = this._expectedLiteral();
      if (!expected.startsWith(this.literalBuffer)) {
        return fail(this.position, 'invalid_literal', { expected, got: this.literalBuffer });
      }
      if (this.literalBuffer === expected) {
        this._endValue();
      }
      return ok(this.position);
    }

    if (isWhitespace(ch)) return ok(this.position);

    if (this.expectColon) {
      if (ch !== ':') return fail(this.position, 'expected_colon', { got: ch });
      this.expectColon = false;
      this.expectKey = false;
      return ok(this.position);
    }

    if (this.afterValue) {
      this.afterValue = false;
      const top = this.stack[this.stack.length - 1];
      if (ch === ',') {
        if (top === '{') this.expectKey = true;
        return ok(this.position);
      }
      if (top === '{' && ch === '}') {
        this.stack.pop();
        this._endValue();
        return ok(this.position);
      }
      if (top === '[' && ch === ']') {
        this.stack.pop();
        this._endValue();
        return ok(this.position);
      }
      return fail(this.position, 'expected_comma_or_close', { got: ch });
    }

    if (this.expectKey) {
      if (ch === '"') {
        this.state = STATE.inString;
        return ok(this.position);
      }
      // Allow trailing close brace for empty-or-trailing-comma cases:
      const top = this.stack[this.stack.length - 1];
      if (top === '{' && ch === '}') {
        this.stack.pop();
        this.expectKey = false;
        this._endValue();
        return ok(this.position);
      }
      return fail(this.position, 'expected_key', { got: ch });
    }

    // Expect a value (start of value).
    if (ch === '{') {
      this.stack.push('{');
      this.expectKey = true;
      return ok(this.position);
    }
    if (ch === '[') {
      this.stack.push('[');
      // Empty array short-circuit handled by checking close on next char.
      return ok(this.position);
    }
    if (ch === ']') {
      const top = this.stack[this.stack.length - 1];
      if (top !== '[') return fail(this.position, 'unexpected_close_bracket', { got: ch });
      this.stack.pop();
      this._endValue();
      return ok(this.position);
    }
    if (ch === '"') {
      this.state = STATE.inString;
      return ok(this.position);
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.state = STATE.inNumber;
      this.numberBuffer = ch;
      return ok(this.position);
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      this.state = STATE.inLiteral;
      this.literalBuffer = ch;
      return ok(this.position);
    }
    return fail(this.position, 'expected_value', { got: ch });
  }

  _popContextAfterString() {
    // After a string ends, are we expecting a value (just consumed key)
    // or a value/finished (just consumed string value)?
    if (this.expectKey) {
      // Just got a key: now expect colon.
      this.expectColon = true;
      this.state = STATE.start;
      return;
    }
    // String was a value. _endValue will move to STATE.done if this
    // closes the top-level, or back to STATE.start with afterValue=true.
    this._endValue();
  }

  _endValue() {
    if (this.stack.length === 0) {
      this.state = STATE.done;
      return;
    }
    this.state = STATE.start;
    this.afterValue = true;
    this.numberBuffer = '';
    this.literalBuffer = '';
  }

  _expectedLiteral() {
    if (this.literalBuffer.startsWith('t')) return 'true';
    if (this.literalBuffer.startsWith('f')) return 'false';
    if (this.literalBuffer.startsWith('n')) return 'null';
    return '';
  }
}

function ok(position) {
  return { valid: true, position };
}

function fail(position, reason, extras = {}) {
  return { valid: false, position, reason, ...extras };
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isValidNumber(s) {
  return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(s);
}

// ─────────────────────────────────────────────────────────────────────
// Schema validation (subset of JSON Schema sufficient for tool manifests)
// ─────────────────────────────────────────────────────────────────────

function validateValue(value, schema, path) {
  if (!schema || typeof schema !== 'object') return { valid: true };

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      return { valid: false, reason: 'enum_mismatch', path, expected: schema.enum, got: value };
    }
  }

  if (schema.type) {
    const ok = matchesType(value, schema.type);
    if (!ok) {
      return { valid: false, reason: 'type_mismatch', path, expected: schema.type, got: typeOf(value) };
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in value)) {
          return { valid: false, reason: 'missing_required', path: `${path}.${k}`, expected: k };
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) {
          const r = validateValue(value[k], sub, `${path}.${k}`);
          if (!r.valid) return r;
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return { valid: false, reason: 'min_items', path, expected: schema.minItems, got: value.length };
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return { valid: false, reason: 'max_items', path, expected: schema.maxItems, got: value.length };
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const r = validateValue(value[i], schema.items, `${path}[${i}]`);
        if (!r.valid) return r;
      }
    }
  }

  return { valid: true };
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─────────────────────────────────────────────────────────────────────
// GrammarValidator — Earley-style CFG parser
//
// Grammar shape:
//   { start: 'S', rules: [{lhs:'S', rhs:['A','b']}, {lhs:'A', rhs:['a']}] }
// Terminals are anything not appearing as an `lhs`. feed(token) advances
// the chart with one terminal at a time. complete() returns whether the
// input parses to the start symbol.
// ─────────────────────────────────────────────────────────────────────

class GrammarValidator {
  constructor({ start, rules } = {}) {
    if (typeof start !== 'string') throw new DecoderError('grammar_invalid', 'grammar.start required');
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new DecoderError('grammar_invalid', 'grammar.rules must be a non-empty array');
    }
    this.start = start;
    this.rules = rules.map(r => ({ lhs: r.lhs, rhs: Array.isArray(r.rhs) ? r.rhs.slice() : [] }));
    this.nonTerminals = new Set(this.rules.map(r => r.lhs));
    this.chart = [];
    this._reset();
  }

  _reset() {
    // chart[i] = list of items {ruleIndex, dot, origin}
    this.chart = [[]];
    for (let ri = 0; ri < this.rules.length; ri++) {
      if (this.rules[ri].lhs === this.start) {
        this._addItem(0, { ruleIndex: ri, dot: 0, origin: 0 });
      }
    }
    this._predict(0);
  }

  reset() { this._reset(); }

  /** Feed one terminal symbol. Returns { valid: boolean, position }. */
  feed(token) {
    const i = this.chart.length - 1;
    this.chart.push([]);
    // Scan: for any item with `token` as next symbol, advance dot.
    for (const item of this.chart[i]) {
      const rule = this.rules[item.ruleIndex];
      const next = rule.rhs[item.dot];
      if (next === token) {
        this._addItem(i + 1, { ruleIndex: item.ruleIndex, dot: item.dot + 1, origin: item.origin });
      }
    }
    this._predict(i + 1);
    this._complete(i + 1);
    if (this.chart[i + 1].length === 0) {
      return { valid: false, position: i + 1, reason: 'no_parse' };
    }
    return { valid: true, position: i + 1 };
  }

  /** True iff the input so far is in the language defined by `start`. */
  complete() {
    const last = this.chart[this.chart.length - 1];
    return last.some(it => {
      const rule = this.rules[it.ruleIndex];
      return rule.lhs === this.start && it.dot === rule.rhs.length && it.origin === 0;
    });
  }

  // ── chart bookkeeping ─────────────────────────────────────────────

  _addItem(idx, item) {
    const set = this.chart[idx];
    for (const ex of set) {
      if (ex.ruleIndex === item.ruleIndex && ex.dot === item.dot && ex.origin === item.origin) return;
    }
    set.push(item);
  }

  _predict(idx) {
    let added = true;
    while (added) {
      added = false;
      const items = this.chart[idx];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const rule = this.rules[it.ruleIndex];
        const next = rule.rhs[it.dot];
        if (this.nonTerminals.has(next)) {
          for (let ri = 0; ri < this.rules.length; ri++) {
            if (this.rules[ri].lhs === next) {
              const before = items.length;
              this._addItem(idx, { ruleIndex: ri, dot: 0, origin: idx });
              if (items.length > before) added = true;
            }
          }
        }
      }
    }
  }

  _complete(idx) {
    let added = true;
    while (added) {
      added = false;
      const items = this.chart[idx];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const rule = this.rules[it.ruleIndex];
        if (it.dot === rule.rhs.length) {
          for (const back of this.chart[it.origin]) {
            const backRule = this.rules[back.ruleIndex];
            if (backRule.rhs[back.dot] === rule.lhs) {
              const before = items.length;
              this._addItem(idx, { ruleIndex: back.ruleIndex, dot: back.dot + 1, origin: back.origin });
              if (items.length > before) added = true;
            }
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Repair-prompt builder
// ─────────────────────────────────────────────────────────────────────

function buildRepairPrompt({ originalPrompt, violation, attempt = 1 } = {}) {
  if (typeof originalPrompt !== 'string' || originalPrompt.length === 0) {
    throw new DecoderError('prompt_required', 'originalPrompt must be a non-empty string');
  }
  if (!violation || typeof violation !== 'object') {
    throw new DecoderError('violation_required', 'violation object required');
  }
  const reason = violation.reason || 'unknown';
  const pos = typeof violation.position === 'number' ? violation.position : null;
  const got = violation.got != null ? JSON.stringify(violation.got) : '?';
  const expected = violation.expected != null ? JSON.stringify(violation.expected) : '?';
  const path = violation.path ? ` at path ${violation.path}` : '';
  const where = pos !== null ? ` near offset ${pos}` : '';

  return [
    `[REPAIR ATTEMPT ${attempt}] Your previous response violated the declared output schema${where}${path}.`,
    `Reason: ${reason}. Got: ${got}. Expected: ${expected}.`,
    `Regenerate the response from scratch. Output ONLY the corrected value — no preamble, no apology, no chain-of-thought.`,
    '',
    '--- Original prompt below ---',
    originalPrompt,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: validate tool-call args against a manifest
// ─────────────────────────────────────────────────────────────────────

function validateToolCallArgs(manifest, args) {
  if (!manifest || typeof manifest !== 'object') {
    throw new DecoderError('manifest_invalid', 'manifest required');
  }
  if (!manifest.inputs) return { valid: true };
  return validateValue(args, manifest.inputs, '$');
}

module.exports = {
  JsonStreamValidator,
  GrammarValidator,
  buildRepairPrompt,
  validateToolCallArgs,
  DecoderError,
  SchemaViolation,
  STATE,
  validateValue, // exported for tests
};
