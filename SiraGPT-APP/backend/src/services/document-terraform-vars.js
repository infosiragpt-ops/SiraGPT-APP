'use strict';

/**
 * document-terraform-vars.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Terraform / OpenTofu HCL constructs:
 *
 *   - variable "name" {} blocks (with type / default / description)
 *   - output "name" {} blocks
 *   - locals {} blocks
 *   - resource "type" "name" {} blocks
 *   - data "type" "name" {} blocks
 *   - module "name" {} blocks
 *   - terraform {} / required_providers / backend "X" {}
 *   - var.X / local.X / data.X.Y / module.X.Y references
 *   - count / for_each / depends_on / provider / lifecycle meta-arguments
 *
 * Public API:
 *   extractTerraformVars(text)             → { entries, totals, total }
 *   buildTerraformVarsForFiles(files)      → { perFile, aggregate, totals }
 *   renderTerraformVarsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const VARIABLE_RE = /\bvariable\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const OUTPUT_RE = /\boutput\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const RESOURCE_RE = /\bresource\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const DATA_RE = /\bdata\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const MODULE_RE = /\bmodule\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const LOCALS_RE = /\blocals\s*\{/g;
const VAR_REF_RE = /\bvar\.([a-zA-Z_][a-zA-Z0-9_]{0,60})/g;
const LOCAL_REF_RE = /\blocal\.([a-zA-Z_][a-zA-Z0-9_]{0,60})/g;
const DATA_REF_RE = /\bdata\.([a-zA-Z_][a-zA-Z0-9_-]{0,60})\.([a-zA-Z_][a-zA-Z0-9_-]{0,60})/g;
const MODULE_REF_RE = /\bmodule\.([a-zA-Z_][a-zA-Z0-9_-]{0,60})/g;
const META_ARG_RE = /^\s+(count|for_each|depends_on|provider|lifecycle|providers)\s*[={]/gm;
const BACKEND_RE = /\bbackend\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const REQUIRED_PROVIDER_RE = /^\s+([a-zA-Z_][a-zA-Z0-9_-]{0,60})\s*=\s*\{[^}]{0,200}source\s*=\s*"([^"]{1,80})"/gm;

function isTerraformLike(body) {
  return /\b(?:variable|resource|data|module|output|locals|terraform)\s+["{]/.test(body)
    || /\b(?:var|local|data|module)\.[a-zA-Z_]/.test(body);
}

function extractTerraformVars(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isTerraformLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    variable: 0, output: 0, resource: 0, data: 0, module: 0, locals: 0,
    varRef: 0, localRef: 0, dataRef: 0, moduleRef: 0,
    metaArg: 0, backend: 0, requiredProvider: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  VARIABLE_RE.lastIndex = 0;
  let m;
  while ((m = VARIABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('variable', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    OUTPUT_RE.lastIndex = 0;
    while ((m = OUTPUT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('output', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESOURCE_RE.lastIndex = 0;
    while ((m = RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('resource', `${m[1]}.${m[2]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DATA_RE.lastIndex = 0;
    while ((m = DATA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('data', `${m[1]}.${m[2]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MODULE_RE.lastIndex = 0;
    while ((m = MODULE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('module', m[1], null);
    }
  }

  let localsCount = 0;
  LOCALS_RE.lastIndex = 0;
  while (LOCALS_RE.exec(body) && localsCount < 10) localsCount += 1;
  totals.locals = localsCount;

  if (entries.length < MAX_PER_FILE) {
    VAR_REF_RE.lastIndex = 0;
    while ((m = VAR_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('varRef', `var.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    LOCAL_REF_RE.lastIndex = 0;
    while ((m = LOCAL_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('localRef', `local.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DATA_REF_RE.lastIndex = 0;
    while ((m = DATA_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dataRef', `data.${m[1]}.${m[2]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MODULE_REF_RE.lastIndex = 0;
    while ((m = MODULE_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('moduleRef', `module.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    META_ARG_RE.lastIndex = 0;
    while ((m = META_ARG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('metaArg', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BACKEND_RE.lastIndex = 0;
    while ((m = BACKEND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('backend', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    REQUIRED_PROVIDER_RE.lastIndex = 0;
    while ((m = REQUIRED_PROVIDER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('requiredProvider', m[1], m[2].slice(0, 50));
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTerraformVarsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    variable: 0, output: 0, resource: 0, data: 0, module: 0, locals: 0,
    varRef: 0, localRef: 0, dataRef: 0, moduleRef: 0,
    metaArg: 0, backend: 0, requiredProvider: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTerraformVars(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTerraformVarsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TERRAFORM / HCL CONSTRUCTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTerraformVars,
  buildTerraformVarsForFiles,
  renderTerraformVarsBlock,
  _internal: { isTerraformLike },
};
