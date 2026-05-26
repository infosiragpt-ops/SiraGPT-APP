'use strict';

/**
 * document-terraform-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Terraform / HCL references in IaC documents:
 *
 *   - resource:     resource "aws_instance" "web" {…}
 *   - data:         data "aws_ami" "ubuntu" {…}
 *   - module:       module "vpc" { source = … }
 *   - variable:     variable "region" {…}
 *   - output:       output "url" {…}
 *   - locals:       locals {…}
 *   - cross-refs:   aws_instance.web.id, module.vpc.id, var.region, data.X.Y
 *
 * Public API:
 *   extractTerraformRefs(text)            → { entries, totals, total }
 *   buildTerraformRefsForFiles(files)     → { perFile, aggregate, totals }
 *   renderTerraformRefsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

const RESOURCE_RE = /\b(resource|data)\s+"([a-z][a-z0-9_]{1,80})"\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const MODULE_RE = /\bmodule\s+"([a-zA-Z_][a-zA-Z0-9_-]{0,60})"\s*\{/g;
const VAR_OUTPUT_RE = /\b(variable|output)\s+"([a-zA-Z_][a-zA-Z0-9_]{0,60})"\s*\{/g;
const REF_RE = /\b(var|local|module|data|aws|gcp|azurerm|google|kubernetes|datadog)\.[a-zA-Z][a-zA-Z0-9_.\-]{1,100}/g;

const KIND_LABELS = {
  resource: 'resource',
  data: 'data',
  module: 'module',
  variable: 'variable',
  output: 'output',
};

function extractTerraformRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { resource: 0, data: 0, module: 0, variable: 0, output: 0, ref: 0 };

  function push(kind, name, fqn) {
    const key = `${kind}:${fqn}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, name, fqn });
    if (totals[kind] != null) totals[kind] += 1;
  }

  RESOURCE_RE.lastIndex = 0;
  let m;
  while ((m = RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const kind = m[1];
    const provider = m[2];
    const name = m[3];
    push(KIND_LABELS[kind], `${provider}.${name}`, `${provider}.${name}`);
  }

  if (entries.length < MAX_PER_FILE) {
    MODULE_RE.lastIndex = 0;
    while ((m = MODULE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('module', m[1], m[1]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    VAR_OUTPUT_RE.lastIndex = 0;
    while ((m = VAR_OUTPUT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const kind = KIND_LABELS[m[1]];
      push(kind, m[2], m[2]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const fqn = m[0];
      if (fqn.length > 120) continue;
      push('ref', fqn, fqn);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTerraformRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { resource: 0, data: 0, module: 0, variable: 0, output: 0, ref: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTerraformRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.fqn}`;
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

function renderTerraformRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TERRAFORM / HCL REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.kind}: \`${e.fqn}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTerraformRefs,
  buildTerraformRefsForFiles,
  renderTerraformRefsBlock,
};
