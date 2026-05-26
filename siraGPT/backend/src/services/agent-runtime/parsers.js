"use strict";

class OutputParserError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OutputParserError";
    this.code = "output_parser_error";
    this.details = details;
  }
}

function parseJsonStrict(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") {
    throw new OutputParserError("Expected JSON object or JSON string", { actual_type: typeof value });
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new OutputParserError("Invalid JSON output", { message: err.message, preview: value.slice(0, 500) });
  }
}

function validateJsonSchema(value, schema = {}, path = "$") {
  const errors = [];
  validateNode(value, schema, path, errors);
  return Object.freeze({
    ok: errors.length === 0,
    errors,
    value,
  });
}

function parseWithSchema(value, schema) {
  const parsed = parseJsonStrict(value);
  const validation = validateJsonSchema(parsed, schema);
  if (!validation.ok) {
    throw new OutputParserError("Output does not match schema", { errors: validation.errors });
  }
  return parsed;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({ path, code: "type_mismatch", expected: schema.type, actual: Array.isArray(value) ? "array" : typeof value });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, code: "enum_mismatch", expected: schema.enum, actual: value });
  }
  if (schema.type === "object" && schema.required) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value || {}, key)) {
        errors.push({ path: `${path}.${key}`, code: "required", message: `Missing required field "${key}"` });
      }
    }
  }
  if (schema.type === "object" && schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], childSchema, `${path}.${key}`, errors);
      }
    }
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
  }
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    if (item === "array") return Array.isArray(value);
    if (item === "null") return value === null;
    if (item === "integer") return Number.isInteger(value);
    if (item === "number") return typeof value === "number" && Number.isFinite(value);
    if (item === "object") return value && typeof value === "object" && !Array.isArray(value);
    return typeof value === item;
  });
}

module.exports = {
  OutputParserError,
  parseJsonStrict,
  parseWithSchema,
  validateJsonSchema,
};
