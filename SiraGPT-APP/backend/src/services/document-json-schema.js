'use strict';

/**
 * document-json-schema.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects JSON Schema (draft 4 / 6 / 7 / 2019-09 / 2020-12) keyword references:
 *
 *   - $schema / $id / $ref / $defs / definitions
 *   - type: "string"/"number"/"object"/...
 *   - validation: required / minimum / maximum / minLength / maxLength /
 *                 pattern / enum / const / format
 *   - composition: oneOf / anyOf / allOf / not / if / then / else
 *   - structural:  properties / items / additionalProperties /
 *                  patternProperties / propertyNames
 *
 * Public API:
 *   extractJsonSchema(text)             → { entries, totals, total }
 *   buildJsonSchemaForFiles(files)      → { perFile, aggregate, totals }
 *   renderJsonSchemaBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const META_KEYS = ['$schema', '$id', '$ref', '$defs', '$comment', '$anchor', 'definitions', 'title'];
const TYPE_VALUES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const VALIDATION_KEYS = new Set([
  'required', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'multipleOf', 'pattern', 'enum', 'const',
  'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);
const COMPOSITION_KEYS = new Set(['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else']);
const STRUCTURAL_KEYS = new Set([
  'properties', 'items', 'prefixItems', 'additionalProperties',
  'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems',
  'contains', 'dependentRequired', 'dependentSchemas',
]);

const META_RE = /"(\$schema|\$id|\$ref|\$defs|\$comment|\$anchor|definitions|title)"\s*:\s*"?([^,"\n}]{1,200})/g;
const TYPE_RE = /"type"\s*:\s*"(string|number|integer|boolean|null|array|object)"/g;
const VALIDATION_RE = /"(required|minimum|maximum|exclusiveMinimum|exclusiveMaximum|minLength|maxLength|multipleOf|pattern|enum|const|format|minItems|maxItems|uniqueItems|minProperties|maxProperties)"\s*:\s*([^,\n}]{1,80})/g;
const COMPOSITION_RE = /"(oneOf|anyOf|allOf|not|if|then|else)"\s*:\s*(\[|\{)/g;
const STRUCTURAL_RE = /"(properties|items|prefixItems|additionalProperties|patternProperties|propertyNames|unevaluatedProperties|unevaluatedItems|contains|dependentRequired|dependentSchemas)"\s*:\s*(\{|\[|true|false)/g;

function classifyKey(key) {
  if (META_KEYS.includes(key)) return 'meta';
  if (TYPE_VALUES.has(key)) return 'type';
  if (VALIDATION_KEYS.has(key)) return 'validation';
  if (COMPOSITION_KEYS.has(key)) return 'composition';
  if (STRUCTURAL_KEYS.has(key)) return 'structural';
  return 'other';
}

function extractJsonSchema(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { meta: 0, type: 0, validation: 0, composition: 0, structural: 0 };

  function push(category, key, value) {
    const sig = `${category}:${key}:${value || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ category, key, value });
    if (totals[category] != null) totals[category] += 1;
  }

  META_RE.lastIndex = 0;
  let m;
  while ((m = META_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('meta', m[1], m[2].slice(0, 60));
  }

  if (entries.length < MAX_PER_FILE) {
    TYPE_RE.lastIndex = 0;
    while ((m = TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('type', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    VALIDATION_RE.lastIndex = 0;
    while ((m = VALIDATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('validation', m[1], m[2].trim().slice(0, 40));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COMPOSITION_RE.lastIndex = 0;
    while ((m = COMPOSITION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('composition', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STRUCTURAL_RE.lastIndex = 0;
    while ((m = STRUCTURAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('structural', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildJsonSchemaForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { meta: 0, type: 0, validation: 0, composition: 0, structural: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractJsonSchema(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.category}:${e.key}:${e.value || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderJsonSchemaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## JSON SCHEMA KEYWORDS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const val = e.value ? ` = \`${e.value}\`` : '';
      lines.push(`- [${e.category}] \`${e.key}\`${val}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractJsonSchema,
  buildJsonSchemaForFiles,
  renderJsonSchemaBlock,
  _internal: { classifyKey, META_KEYS, TYPE_VALUES, VALIDATION_KEYS, COMPOSITION_KEYS, STRUCTURAL_KEYS },
};
