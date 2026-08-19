'use strict';

/**
 * document-build-tools.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects build / bundler tool references and configurations:
 *
 *   - webpack:    webpack.config.js, webpack.config.{js,ts}, webpack CLI
 *   - vite:       vite.config.{js,ts}, npm run dev (vite)
 *   - rollup:     rollup.config.{js,ts}
 *   - esbuild:    esbuild.config, esbuild CLI
 *   - parcel:     .parcelrc, parcel build
 *   - turbopack:  next.config (turbopack flag)
 *   - swc:        .swcrc / swc CLI
 *   - babel:      babel.config / .babelrc
 *
 * Public API:
 *   extractBuildTools(text)             → { entries, totals, total }
 *   buildBuildToolsForFiles(files)      → { perFile, aggregate, totals }
 *   renderBuildToolsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const TOOLS = [
  { name: 'webpack', re: /\b(webpack(?:\.config)?(?:\.[a-z]{1,4})?|webpack\s+(?:--config|--mode))/g, category: 'bundler' },
  { name: 'vite', re: /\b(vite(?:\.config)?(?:\.[a-z]{1,4})?|vite\s+(?:build|dev))/g, category: 'bundler' },
  { name: 'rollup', re: /\b(rollup(?:\.config)?(?:\.[a-z]{1,4})?|rollup\s+(?:--config|-c))/g, category: 'bundler' },
  { name: 'esbuild', re: /\besbuild(?:\.config)?(?:\.[a-z]{1,4})?\b/g, category: 'bundler' },
  { name: 'parcel', re: /\b(\.parcelrc|parcel\s+(?:build|serve))/g, category: 'bundler' },
  { name: 'turbopack', re: /\bturbopack\b/g, category: 'bundler' },
  { name: 'swc', re: /(\.swcrc|@swc\/core|\bswc\s+(?:compile|--config))/g, category: 'transpiler' },
  { name: 'babel', re: /\b(babel\.config(?:\.[a-z]{1,4})?|\.babelrc(?:\.[a-z]+)?|@babel\/)/g, category: 'transpiler' },
  { name: 'tsc', re: /\btsc(?:\s+(?:--noEmit|--watch|--build|-p))?\b/g, category: 'transpiler' },
  { name: 'tsup', re: /\btsup(?:\.config)?(?:\.[a-z]{1,4})?\b/g, category: 'bundler' },
  { name: 'unbuild', re: /\bunbuild(?:\.config)?(?:\.[a-z]{1,4})?\b/g, category: 'bundler' },
  { name: 'gulp', re: /\bgulpfile(?:\.[a-z]{1,4})?\b/g, category: 'task-runner' },
  { name: 'grunt', re: /\bGruntfile(?:\.[a-z]{1,4})?\b/g, category: 'task-runner' },
  { name: 'make', re: /\b(?:Makefile|GNUmakefile)\b/g, category: 'task-runner' },
];

function extractBuildTools(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  for (const { name, re, category } of TOOLS) {
    if (entries.length >= MAX_PER_FILE) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const raw = m[1] || m[0];
      const key = `${name}:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, category, raw: raw.slice(0, 60) });
      totals[name] = (totals[name] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildBuildToolsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBuildTools(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}:${e.raw}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.name] = (totals[e.name] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderBuildToolsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BUILD / BUNDLER TOOLS'];
  const t = report.totals || {};
  const top = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 10);
  if (top.length) lines.push(`- Top: ${top.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.name} (${e.category}): \`${e.raw}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractBuildTools,
  buildBuildToolsForFiles,
  renderBuildToolsBlock,
};
