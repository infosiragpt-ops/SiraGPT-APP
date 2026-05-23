#!/usr/bin/env node
/**
 * bundle-analyzer.js — print top-N largest JS chunks from a Next.js build.
 *
 * Reads `.next/build-manifest.json` (client chunks per page) and
 * `.next/server/pages-manifest.json` (server bundles per route), then walks
 * the on-disk `.next` tree to size each referenced JS file (raw + gzipped).
 * Prints a ranked report of the top 20 chunks by gzipped size so regressions
 * are obvious. Intended as a complement to scripts/bundle-size-check.js: the
 * latter gates totals against a budget, this one tells you *which* chunks
 * grew.
 *
 * Usage:
 *   node scripts/bundle-analyzer.js
 *   node scripts/bundle-analyzer.js --next .next --top 30 --json
 *   node scripts/bundle-analyzer.js --json > bundle-report.json
 *
 * Exit codes:
 *   0 — printed report
 *   2 — required manifest files not found (run `npm run build` first)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KB = 1024;
const DEFAULT_TOP = 20;

function parseArgs(argv) {
  const args = { nextDir: null, top: DEFAULT_TOP, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--next') args.nextDir = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]) || DEFAULT_TOP;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bundle-analyzer [--next DIR] [--top N] [--json]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function loadJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function gzipBytes(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

/**
 * Resolve a manifest-relative path to an absolute path inside `.next`.
 * The client `build-manifest.json` references files like `static/chunks/...`,
 * which live at `<nextDir>/static/chunks/...`. The server `pages-manifest.json`
 * references files like `pages/_app.js`, which live at
 * `<nextDir>/server/pages/_app.js`.
 */
function resolveClientChunk(nextDir, rel) {
  return path.join(nextDir, rel);
}
function resolveServerChunk(nextDir, rel) {
  return path.join(nextDir, 'server', rel);
}

function sizeOf(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return { bytes: buf.length, gzipBytes: gzipBytes(buf) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Collect a Map<absPath, { side, pages: Set<string>, bytes, gzipBytes }>
 * by walking both manifests. A single chunk can be referenced by many
 * pages; we de-dupe on disk path and track all referring pages.
 */
function collectChunks(nextDir, buildManifest, pagesManifest) {
  const chunks = new Map();

  function addRef(absPath, side, page) {
    if (!absPath.endsWith('.js')) return;
    let entry = chunks.get(absPath);
    if (!entry) {
      const size = sizeOf(absPath);
      if (!size) return;
      entry = {
        absPath,
        side,
        pages: new Set(),
        bytes: size.bytes,
        gzipBytes: size.gzipBytes,
      };
      chunks.set(absPath, entry);
    }
    entry.pages.add(page);
  }

  // Client side — build-manifest.json shape: { pages: { '/route': ['static/chunks/x.js', ...], ... }, ... }
  if (buildManifest && typeof buildManifest === 'object') {
    const pages = buildManifest.pages || {};
    for (const [page, list] of Object.entries(pages)) {
      if (!Array.isArray(list)) continue;
      for (const rel of list) {
        addRef(resolveClientChunk(nextDir, rel), 'client', page);
      }
    }
    // Shared chunks across all pages (rootMainFiles, polyfillFiles, etc.).
    for (const key of ['rootMainFiles', 'polyfillFiles', 'lowPriorityFiles', 'devFiles']) {
      const list = buildManifest[key];
      if (!Array.isArray(list)) continue;
      for (const rel of list) {
        addRef(resolveClientChunk(nextDir, rel), 'client', `__${key}__`);
      }
    }
  }

  // Server side — pages-manifest.json shape: { '/route': 'pages/route.js', ... }
  if (pagesManifest && typeof pagesManifest === 'object') {
    for (const [page, rel] of Object.entries(pagesManifest)) {
      if (typeof rel !== 'string') continue;
      addRef(resolveServerChunk(nextDir, rel), 'server', page);
    }
  }

  return chunks;
}

function rankTop(chunks, topN) {
  return [...chunks.values()]
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, topN);
}

function toKB(b) {
  return Math.round((b / KB) * 100) / 100;
}

function formatHuman(top, totals, opts) {
  const lines = [];
  lines.push('Bundle analyzer report');
  lines.push('======================');
  lines.push(`next dir: ${opts.nextDir}`);
  lines.push(`chunks:   ${totals.count} (client ${totals.client} / server ${totals.server})`);
  lines.push(`raw:      ${toKB(totals.bytes)} KB`);
  lines.push(`gzipped:  ${toKB(totals.gzipBytes)} KB`);
  lines.push('');
  lines.push(`Top ${top.length} chunks by gzipped size:`);
  lines.push(
    '  '
      + 'gzip(KB)'.padStart(10)
      + '  '
      + 'raw(KB)'.padStart(9)
      + '  side    pages  path',
  );
  for (const c of top) {
    const rel = path.relative(opts.nextDir, c.absPath).split(path.sep).join('/');
    lines.push(
      '  '
        + toKB(c.gzipBytes).toString().padStart(10)
        + '  '
        + toKB(c.bytes).toString().padStart(9)
        + '  '
        + c.side.padEnd(6)
        + '  '
        + String(c.pages.size).padStart(5)
        + '  '
        + rel,
    );
  }
  return lines.join('\n');
}

function analyze(opts) {
  const nextDir = path.resolve(opts.nextDir || path.join(process.cwd(), '.next'));
  const buildManifest = loadJsonIfExists(path.join(nextDir, 'build-manifest.json'));
  const pagesManifest = loadJsonIfExists(path.join(nextDir, 'server', 'pages-manifest.json'));

  if (!buildManifest && !pagesManifest) {
    return {
      ok: false,
      reason: `No build manifests under ${nextDir} — run \`npm run build\` first.`,
    };
  }

  const chunks = collectChunks(nextDir, buildManifest, pagesManifest);
  const top = rankTop(chunks, opts.top);

  let bytes = 0;
  let gz = 0;
  let client = 0;
  let server = 0;
  for (const c of chunks.values()) {
    bytes += c.bytes;
    gz += c.gzipBytes;
    if (c.side === 'client') client += 1;
    else server += 1;
  }

  return {
    ok: true,
    nextDir,
    totals: {
      count: chunks.size,
      client,
      server,
      bytes,
      gzipBytes: gz,
    },
    top: top.map((c) => ({
      path: path.relative(nextDir, c.absPath).split(path.sep).join('/'),
      absPath: c.absPath,
      side: c.side,
      bytes: c.bytes,
      gzipBytes: c.gzipBytes,
      bytesKB: toKB(c.bytes),
      gzipKB: toKB(c.gzipBytes),
      pages: [...c.pages].sort(),
    })),
  };
}

function run(argv = process.argv) {
  const args = parseArgs(argv);
  const result = analyze(args);
  if (!result.ok) {
    process.stderr.write(`bundle-analyzer: ${result.reason}\n`);
    return 2;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${formatHuman(result.top, result.totals, { nextDir: result.nextDir })}\n`,
    );
  }
  return 0;
}

module.exports = {
  parseArgs,
  collectChunks,
  rankTop,
  analyze,
  toKB,
  formatHuman,
  run,
};

if (require.main === module) {
  try {
    process.exit(run());
  } catch (err) {
    process.stderr.write(`bundle-analyzer: ${err.stack || err.message || err}\n`);
    process.exit(2);
  }
}
