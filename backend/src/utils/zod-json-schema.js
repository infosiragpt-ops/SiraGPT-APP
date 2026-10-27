'use strict';

/**
 * zod 4 → JSON Schema, in the shape zod-to-json-schema produced for this
 * backend under zod 3.
 *
 * zod-to-json-schema cannot read zod 4 schemas: it returns an empty schema
 * (every harness tool then fails to register). z.toJSONSchema reads them but
 * differs in details that reach models and clients — the tool parameters sent
 * to the LLM, the MCP/route contracts and the OpenAPI spec. This keeps those
 * documents as they were:
 *  - a key that accepts `undefined` (optional, default, any/unknown, catch) is
 *    not required: zod 3's rule;
 *  - strip and strict objects say `additionalProperties: false`, passthrough
 *    objects `true`;
 *  - no implicit safe-integer bounds on `.int()`, no `propertyNames` on string
 *    records, no library regex next to a string `format`, no `items: {}` on
 *    arrays of anything, no `additionalItems` on tuples, no `default` invented
 *    from `.catch()`;
 *  - discriminated unions are `anyOf` (several tool-calling APIs reject `oneOf`);
 *  - null is `{ type: 'null' }` and a date `{ type: 'string', format: 'date-time' }`.
 */

const { z } = require('zod');

const TARGETS = Object.freeze({ jsonSchema7: 'draft-7', openApi3: 'openapi-3.0' });

function acceptsUndefined(schema) {
  try {
    return Boolean(schema && typeof schema.safeParse === 'function' && schema.safeParse(undefined).success);
  } catch (_) {
    return false;
  }
}

function isEmptySchema(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** A `.regex()` written by us, as opposed to the regex behind a format such as email. */
function hasOwnRegex(def) {
  return Array.isArray(def.checks) && def.checks.some((check) => check && check._zod && check._zod.def && check._zod.def.format === 'regex');
}

function legacyShape(ctx) {
  const def = ctx.zodSchema && ctx.zodSchema._zod && ctx.zodSchema._zod.def;
  const node = ctx.jsonSchema;
  if (!def || !node || typeof node !== 'object') return;
  switch (def.type) {
    case 'object': {
      const shape = def.shape || {};
      if (Array.isArray(node.required)) {
        node.required = node.required.filter((key) => !acceptsUndefined(shape[key]));
        if (!node.required.length) delete node.required;
      }
      if (node.additionalProperties === undefined) node.additionalProperties = false;
      else if (isEmptySchema(node.additionalProperties)) node.additionalProperties = true;
      break;
    }
    case 'string':
      if (node.format && node.pattern && !hasOwnRegex(def)) delete node.pattern;
      // Several .regex() checks become allOf patterns; the type is already on
      // the string itself.
      if (Array.isArray(node.allOf)) {
        for (const part of node.allOf) {
          if (part && part.type === 'string' && typeof part.pattern === 'string' && Object.keys(part).length === 2) delete part.type;
        }
      }
      break;
    case 'number':
      if (node.type === 'integer') {
        if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
        if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
      }
      break;
    case 'record':
      if (node.propertyNames && node.propertyNames.type === 'string' && Object.keys(node.propertyNames).length === 1) {
        delete node.propertyNames;
      }
      break;
    case 'array':
      if (isEmptySchema(node.items)) delete node.items;
      break;
    case 'tuple':
      if (node.additionalItems === false) delete node.additionalItems;
      break;
    case 'null':
      // openapi-3.0 renders null as a nullable string enum; it was `type: null`.
      delete node.nullable;
      delete node.enum;
      node.type = 'null';
      break;
    case 'union':
      if (Array.isArray(node.oneOf)) {
        node.anyOf = node.oneOf;
        delete node.oneOf;
      }
      break;
    case 'catch':
      delete node.default;
      break;
    case 'date':
      node.type = 'string';
      node.format = 'date-time';
      break;
    default:
      break;
  }
}

/**
 * @param {import('zod').ZodType} schema
 * @param {{ target?: 'jsonSchema7'|'openApi3' }} [opts]
 * @returns {object} JSON Schema without `$schema`
 */
function zodToLegacyJsonSchema(schema, { target = 'jsonSchema7' } = {}) {
  if (!schema || !schema._zod) throw new TypeError('zodToLegacyJsonSchema: expected a zod 4 schema');
  const json = z.toJSONSchema(schema, {
    target: TARGETS[target] || TARGETS.jsonSchema7,
    io: 'input',
    unrepresentable: 'any',
    override: legacyShape,
  });
  if (json && typeof json === 'object') delete json.$schema;
  return json;
}

module.exports = { zodToLegacyJsonSchema };
