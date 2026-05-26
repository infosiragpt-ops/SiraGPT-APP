#!/usr/bin/env node
/**
 * Generate TypeScript type declarations for the frontend from the backend's
 * Zod schemas.
 *
 * Why a hand-rolled converter?
 *   We considered `zod-to-ts`, but it isn't in our dep tree and pulling it
 *   in for a one-shot codegen step doesn't earn its weight. Our schemas are
 *   intentionally narrow (auth / chats / files / payments) and use a small
 *   subset of Zod, so a ~150-LOC walker is enough — and we already ship
 *   `zod-to-json-schema`, so we lean on that as the source of truth and
 *   then convert the JSON Schema → TS string.
 *
 * Usage:
 *   node backend/scripts/generate-api-types.js [--check]
 *
 * `--check` exits non-zero if the generated file would differ — useful in
 * CI to guard against schema drift.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { zodToJsonSchema } = require('zod-to-json-schema');

const OUT_PATH = path.join(__dirname, '..', '..', 'lib', 'api-types.ts');
const SCHEMA_INDEX = path.join(__dirname, '..', 'src', 'schemas', 'index.js');

function loadSchemas() {
  // eslint-disable-next-line global-require
  const mod = require(SCHEMA_INDEX);
  const out = {};
  for (const [name, value] of Object.entries(mod)) {
    if (value && typeof value === 'object' && typeof value.safeParse === 'function') {
      out[name] = value;
    }
  }
  return out;
}

// JSON Schema → TS string. Covers the constructs our schemas actually use.
function jsonSchemaToTs(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.anyOf) {
    return schema.anyOf.map((s) => jsonSchemaToTs(s, depth + 1)).join(' | ');
  }
  if (schema.oneOf) {
    return schema.oneOf.map((s) => jsonSchemaToTs(s, depth + 1)).join(' | ');
  }
  if (schema.allOf) {
    return schema.allOf.map((s) => jsonSchemaToTs(s, depth + 1)).join(' & ');
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return type.map((t) => jsonSchemaToTs({ ...schema, type: t }, depth + 1)).join(' | ');
  }
  switch (type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      const item = schema.items ? jsonSchemaToTs(schema.items, depth + 1) : 'unknown';
      return `Array<${item}>`;
    }
    case 'object': {
      const props = schema.properties || {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const lines = [];
      const pad = '  '.repeat(depth + 1);
      for (const [key, val] of Object.entries(props)) {
        const optional = required.has(key) ? '' : '?';
        const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
        lines.push(`${pad}${safeKey}${optional}: ${jsonSchemaToTs(val, depth + 1)};`);
      }
      // additionalProperties → index signature
      if (schema.additionalProperties && schema.additionalProperties !== false) {
        const extra = schema.additionalProperties === true
          ? 'unknown'
          : jsonSchemaToTs(schema.additionalProperties, depth + 1);
        lines.push(`${pad}[key: string]: ${extra};`);
      }
      if (lines.length === 0) return 'Record<string, unknown>';
      return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
    }
    default:
      return 'unknown';
  }
}

function buildOutput(schemas) {
  const banner = [
    '/* eslint-disable */',
    '// AUTO-GENERATED — DO NOT EDIT BY HAND.',
    '// Regenerate with: `node backend/scripts/generate-api-types.js`',
    '// Source schemas live in `backend/src/schemas/`.',
    '',
  ];
  const blocks = [];
  // Stable order for diff-friendliness.
  const names = Object.keys(schemas).sort();
  for (const name of names) {
    const schema = schemas[name];
    let json;
    try {
      json = zodToJsonSchema(schema, { name, $refStrategy: 'none' });
    } catch (err) {
      blocks.push(`// FAILED to convert ${name}: ${err.message}`);
      blocks.push(`export type ${typeNameFor(name)} = unknown;`);
      blocks.push('');
      continue;
    }
    const root = (json && json.definitions && json.definitions[name]) || json;
    const ts = jsonSchemaToTs(root, 0);
    blocks.push(`export type ${typeNameFor(name)} = ${ts};`);
    blocks.push('');
  }
  return banner.join('\n') + blocks.join('\n');
}

// `LoginRequestSchema` → `LoginRequest`; everything else unchanged.
function typeNameFor(name) {
  return name.endsWith('Schema') ? name.slice(0, -'Schema'.length) : name;
}

function main() {
  const check = process.argv.includes('--check');
  const schemas = loadSchemas();
  const out = buildOutput(schemas);

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('[generate-api-types] missing output file; run without --check');
      process.exit(1);
    }
    const existing = fs.readFileSync(OUT_PATH, 'utf8');
    if (existing !== out) {
      console.error('[generate-api-types] api-types.ts is out of date. Run: node backend/scripts/generate-api-types.js');
      process.exit(1);
    }
    console.log('[generate-api-types] up to date');
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out, 'utf8');
  console.log(`[generate-api-types] wrote ${OUT_PATH} (${Object.keys(schemas).length} schemas)`);
}

if (require.main === module) {
  main();
}

module.exports = { jsonSchemaToTs, buildOutput, typeNameFor };
