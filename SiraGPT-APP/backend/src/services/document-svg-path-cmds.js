'use strict';

/**
 * document-svg-path-cmds.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SVG path d="..." command sequences:
 *
 *   - M / m: moveto
 *   - L / l: lineto
 *   - H / h: horizontal lineto
 *   - V / v: vertical lineto
 *   - C / c, S / s: cubic Bézier
 *   - Q / q, T / t: quadratic Bézier
 *   - A / a: elliptical arc
 *   - Z / z: closepath
 *
 * Public API:
 *   extractSvgPathCmds(text)             → { entries, totals, total }
 *   buildSvgPathCmdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderSvgPathCmdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const PATH_D_RE = /\bd\s*=\s*["']([MmLlHhVvCcSsQqTtAaZz][^"']{2,800})["']/g;
const CMD_RE = /([MmLlHhVvCcSsQqTtAaZz])/g;

const CMD_NAMES = {
  M: 'moveto', m: 'moveto-rel',
  L: 'lineto', l: 'lineto-rel',
  H: 'h-lineto', h: 'h-lineto-rel',
  V: 'v-lineto', v: 'v-lineto-rel',
  C: 'cubic-bezier', c: 'cubic-bezier-rel',
  S: 'cubic-smooth', s: 'cubic-smooth-rel',
  Q: 'quadratic', q: 'quadratic-rel',
  T: 'quadratic-smooth', t: 'quadratic-smooth-rel',
  A: 'arc', a: 'arc-rel',
  Z: 'closepath', z: 'closepath',
};

function summariseCommands(d) {
  const tallies = {};
  CMD_RE.lastIndex = 0;
  let m;
  while ((m = CMD_RE.exec(d))) {
    const c = m[1];
    tallies[c] = (tallies[c] || 0) + 1;
  }
  return tallies;
}

function extractSvgPathCmds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  PATH_D_RE.lastIndex = 0;
  let m;
  while ((m = PATH_D_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const d = m[1];
    const sig = d.slice(0, 60);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const tallies = summariseCommands(d);
    const commandTypes = Object.keys(tallies).length;
    entries.push({ snippet: sig, tallies, commandTypes, totalCommands: Object.values(tallies).reduce((a, b) => a + b, 0) });
    for (const [k, v] of Object.entries(tallies)) {
      const name = CMD_NAMES[k] || k;
      totals[name] = (totals[name] || 0) + v;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSvgPathCmdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSvgPathCmds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.snippet)) continue;
      aggSeen.add(e.snippet);
      aggregate.push(e);
      for (const [k, v] of Object.entries(e.tallies)) {
        const name = CMD_NAMES[k] || k;
        totals[name] = (totals[name] || 0) + v;
      }
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderSvgPathCmdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SVG PATH COMMANDS'];
  const t = report.totals || {};
  const top = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 10);
  if (top.length) lines.push(`- Top commands: ${top.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ${e.totalCommands} commands across ${e.commandTypes} types: \`${e.snippet.slice(0, 50)}…\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSvgPathCmds,
  buildSvgPathCmdsForFiles,
  renderSvgPathCmdsBlock,
  _internal: { summariseCommands, CMD_NAMES },
};
