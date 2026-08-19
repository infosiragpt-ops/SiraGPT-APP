'use strict';

/**
 * tool-args-validator — deterministic validator for a small JSON
 * Schema subset, sized to validate tool_call arguments after the
 * streaming assembler (#19) and JSON repair (#21) finish stitching
 * them. Pairs with the tool-authorization gate (#4): the gate decides
 * "may this tool run", this one decides "are the arguments shaped
 * the way the manifest declared".
 *
 * Why a custom subset and not ajv:
 *   - We only need: type, required, properties, items, enum, minimum,
 *     maximum, minLength, maxLength, minItems, maxItems, pattern.
 *   - Each manifest already lives in this repo; we trust it.
 *   - ajv adds 280k of dependencies for a problem we can solve in
 *     ~150 lines.
 *   - Pure JS, dependency-free, identical errors across processes.
 *
 * Public API:
 *   validate(schema, value)
 *     → { ok: true,  value }                         when valid
 *     → { ok: false, errors: [{ path, code, message, ... }] }
 *
 *   Path is a JSONPath-style string ('$', '$.foo', '$.items[2].x').
 *   Error codes: 'type', 'required', 'enum', 'min', 'max',
 *                'minLength', 'maxLength', 'minItems', 'maxItems',
 *                'pattern', 'unknownType'.
 */

const TYPE_CHECKS = {
  string:  (v) => typeof v === 'string',
  number:  (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object:  (v) => v != null && typeof v === 'object' && !Array.isArray(v),
  array:   Array.isArray,
  null:    (v) => v === null,
};

function err(path, code, message, extra) {
  return { path, code, message, ...(extra || {}) };
}

function checkType(schema, value, path, errors) {
  if (!schema.type) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) {
    const fn = TYPE_CHECKS[t];
    if (!fn) {
      errors.push(err(path, 'unknownType', `unknown type "${t}" in schema`, { schemaType: t }));
      return false;
    }
    if (fn(value)) return true;
  }
  errors.push(err(path, 'type', `expected ${types.join('|')} but got ${typeOf(value)}`, { expected: types, actual: typeOf(value) }));
  return false;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateNode(schema, value, path, errors) {
  if (schema == null) return;
  if (!checkType(schema, value, path, errors)) return;

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(err(path, 'enum', `value not in enum`, { allowed: schema.enum, actual: value }));
    }
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(err(path, 'minLength', `length ${value.length} < ${schema.minLength}`));
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(err(path, 'maxLength', `length ${value.length} > ${schema.maxLength}`));
    }
    if (schema.pattern) {
      const re = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(schema.pattern);
      if (!re.test(value)) errors.push(err(path, 'pattern', `value does not match pattern`, { pattern: re.source }));
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(err(path, 'min', `value ${value} < minimum ${schema.minimum}`));
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(err(path, 'max', `value ${value} > maximum ${schema.maximum}`));
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push(err(path, 'minItems', `length ${value.length} < minItems ${schema.minItems}`));
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(err(path, 'maxItems', `length ${value.length} > maxItems ${schema.maxItems}`));
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateNode(schema.items, value[i], `${path}[${i}]`, errors);
      }
    }
  }

  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(err(`${path}.${key}`, 'required', `missing required property "${key}"`));
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          validateNode(sub, value[k], `${path}.${k}`, errors);
        }
      }
    }
  }
}

function validate(schema, value) {
  const errors = [];
  validateNode(schema, value, '$', errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

module.exports = {
  validate,
  TYPE_CHECKS,
};
