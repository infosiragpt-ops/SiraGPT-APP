'use strict';

/**
 * document-nuget-pkgs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects .NET NuGet package references in .csproj / .fsproj / packages.config:
 *
 *   - PackageReference Include="Name" Version="1.0"
 *   - <package id="Name" version="1.0" />
 *   - dotnet add package Name -v 1.0
 *   - paket: Name 1.0.0
 *
 * Public API:
 *   extractNugetPkgs(text)             → { entries, totals, total }
 *   buildNugetPkgsForFiles(files)      → { perFile, aggregate, totals }
 *   renderNugetPkgsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const PACKAGE_REF_RE = /<PackageReference\s+Include\s*=\s*"([A-Za-z][A-Za-z0-9._-]{0,80})"\s+Version\s*=\s*"([0-9*][0-9a-zA-Z._\-*+]{0,40})"/g;
const PACKAGES_CONFIG_RE = /<package\s+id\s*=\s*"([A-Za-z][A-Za-z0-9._-]{0,80})"\s+version\s*=\s*"([0-9*][0-9a-zA-Z._\-*+]{0,40})"/gi;
const DOTNET_CMD_RE = /\bdotnet\s+add\s+package\s+([A-Za-z][A-Za-z0-9._-]{0,80})(?:\s+(?:-v|--version)\s+([0-9*][0-9a-zA-Z._\-*+]{0,40}))?/g;
const PAKET_RE = /^\s*nuget\s+([A-Za-z][A-Za-z0-9._-]{0,80})(?:\s+([0-9*][0-9a-zA-Z._\-*+]{0,40}))?/gm;

function extractNugetPkgs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { packageRef: 0, packagesConfig: 0, command: 0, paket: 0 };

  PACKAGE_REF_RE.lastIndex = 0;
  let m;
  while ((m = PACKAGE_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `pkgRef:${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name: m[1], version: m[2], kind: 'packageRef' });
    totals.packageRef += 1;
  }
  if (entries.length < MAX_PER_FILE) {
    PACKAGES_CONFIG_RE.lastIndex = 0;
    while ((m = PACKAGES_CONFIG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `pkgsCfg:${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], version: m[2], kind: 'packagesConfig' });
      totals.packagesConfig += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DOTNET_CMD_RE.lastIndex = 0;
    while ((m = DOTNET_CMD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `cmd:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], version: m[2] || null, kind: 'command' });
      totals.command += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PAKET_RE.lastIndex = 0;
    while ((m = PAKET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `paket:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], version: m[2] || null, kind: 'paket' });
      totals.paket += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNugetPkgsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { packageRef: 0, packagesConfig: 0, command: 0, paket: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNugetPkgs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}:${e.version || ''}`;
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

function renderNugetPkgsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## .NET / NUGET PACKAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const v = e.version ? ` ${e.version}` : '';
      lines.push(`- \`${e.name}\`${v} (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNugetPkgs,
  buildNugetPkgsForFiles,
  renderNugetPkgsBlock,
};
