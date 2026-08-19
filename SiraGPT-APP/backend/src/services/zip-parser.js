'use strict';

/**
 * ZIP Archive Parser — extracts and enumerates text from .zip archives.
 *
 * Recursively unpacks ZIP archives, extracting readable text from:
 *   - .txt, .md, .csv, .tsv, .json, .xml, .html, .htm
 *   - .js, .ts, .py, .java, .c, .cpp, .h, .rb, .go, .rs, .php
 *   - .css, .scss, .less
 *   - .yml, .yaml, .toml, .ini, .cfg, .conf
 *   - .log, .sql, .sh, .bat, .ps1
 *
 * Non-text files (images, binaries, office docs) are listed in the
 * file inventory but their content is not extracted.
 *
 * Depth limit: 3 levels (a zip inside a zip inside a zip = ok)
 * Max total text: 2MB extracted
 * Max files listed: 500
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_EXTRACTED_CHARS = Number.parseInt(process.env.ZIP_MAX_EXTRACTED_CHARS || String(2 * 1024 * 1024), 10);
const MAX_LISTED_FILES = Number.parseInt(process.env.ZIP_MAX_LISTED_FILES || '500', 10);
const MAX_DEPTH = 3;

// ── Malformed-archive guards ─────────────────────────────────────
// Total uncompressed payload allowed on disk (zip-bomb absolute cap).
const MAX_TOTAL_UNCOMPRESSED_BYTES = parsePositiveInt(
  process.env.ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES, 512 * 1024 * 1024);
// Reject suspiciously high compression ratios once the payload is big
// enough for the ratio to matter (classic 42.zip-style bombs are >1000x;
// legitimate source archives rarely exceed ~20x).
const MAX_COMPRESSION_RATIO = parsePositiveInt(
  process.env.ZIP_MAX_COMPRESSION_RATIO, 200);
const RATIO_CHECK_MIN_BYTES = 10 * 1024 * 1024;
// An archive with this many traversal-style names is hostile by design.
const MAX_UNSAFE_ENTRIES = 200;

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'xhtml',
  'js', 'jsx', 'ts', 'tsx', 'py', 'pyx', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
  'rb', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala', 'clj', 'cljs', 'r', 'jl',
  'css', 'scss', 'sass', 'less', 'styl', 'pcss',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'log', 'sql', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1',
  'gitignore', 'dockerignore', 'editorconfig', 'npmrc',
  'vue', 'svelte', 'astro', 'ejs', 'pug', 'hbs', 'njk', 'liquid',
  'graphql', 'gql', 'prisma', 'proto',
]);

/**
 * Run the system `unzip` binary, resolving on tolerated exit codes.
 * Info-ZIP semantics: 0 = ok, 1 = warnings but processing completed
 * (e.g. sanitized "../" entries, empty zipfile), 11 = no files matched
 * (everything excluded). Anything else rejects with the exit code attached.
 */
function execUnzip(args, { timeout = 60000, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('unzip', args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: stdout || '' });
      if (err.code === 'ENOENT') {
        const missing = new Error("system 'unzip' utility is not available");
        missing.unzipMissing = true;
        return reject(missing);
      }
      const code = typeof err.code === 'number' ? err.code : -1;
      if (okCodes.includes(code)) return resolve({ code, stdout: stdout || '' });
      const failed = new Error(err.killed ? 'unzip timed out' : `unzip exited with code ${code}`);
      failed.exitCode = code;
      return reject(failed);
    });
  });
}

/**
 * Pre-flight: read the archive's entry table (name + uncompressed size)
 * WITHOUT extracting anything, via `unzip -l`. Throws a clean structured
 * error when the archive is corrupted/truncated — instead of the old
 * behaviour of failing mid-extraction with a misleading message.
 */
async function listZipEntries(filePath) {
  let res;
  try {
    // Exit 1 tolerated: empty-but-valid zipfiles list with a warning.
    res = await execUnzip(['-l', filePath], { timeout: 30000, okCodes: [0, 1] });
  } catch (err) {
    if (err.unzipMissing) throw err;
    throw new Error('invalid or corrupted ZIP archive (could not read entry listing)');
  }
  const entries = [];
  for (const line of res.stdout.split('\n')) {
    // "      12  06-09-2026 23:16   path/to/name.txt"
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue; // header / separators / totals line never match
    entries.push({ size: Number.parseInt(m[1], 10) || 0, name: m[4] });
  }
  return entries;
}

/**
 * True when an archived entry name could escape the extraction sandbox:
 * absolute paths, drive-letter paths, ".." traversal segments, NUL bytes.
 */
function isUnsafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (name.includes('\0')) return true;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((seg) => seg === '..');
}

/** Escape Info-ZIP wildcard characters so `-x` excludes a literal name. */
function escapeUnzipPattern(name) {
  return name.replace(/[\\[\]*?]/g, (ch) => '\\' + ch);
}

/**
 * Parse a ZIP archive and extract all readable text.
 * Uses the system `unzip` command for reliability.
 */
async function parseZip(filePath) {
  const extractDir = path.join(os.tmpdir(), `siragpt-zip-${crypto.randomUUID()}`);

  try {
    // ── Pre-flight: inspect the entry table before touching the disk ──
    const archiveStat = await fs.promises.stat(filePath).catch(() => null);
    const listedEntries = await listZipEntries(filePath);
    const unsafeEntries = listedEntries.filter((e) => isUnsafeEntryName(e.name));
    const totalUncompressed = listedEntries.reduce((sum, e) => sum + e.size, 0);

    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `archive rejected: declared uncompressed size ${totalUncompressed} bytes exceeds the ` +
        `${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte limit (possible zip bomb)`);
    }
    if (archiveStat && archiveStat.size > 0 &&
        totalUncompressed > RATIO_CHECK_MIN_BYTES &&
        totalUncompressed / archiveStat.size > MAX_COMPRESSION_RATIO) {
      throw new Error(
        `archive rejected: compression ratio ${Math.round(totalUncompressed / archiveStat.size)}x ` +
        `exceeds the ${MAX_COMPRESSION_RATIO}x limit (possible zip bomb)`);
    }
    if (unsafeEntries.length > MAX_UNSAFE_ENTRIES) {
      throw new Error(
        `archive rejected: ${unsafeEntries.length} entries use unsafe paths (path traversal attempt)`);
    }

    await fs.promises.mkdir(extractDir, { recursive: true });

    // Extract the ZIP, excluding entries whose names could escape extractDir.
    // (Info-ZIP already sanitizes them, but the exclusion makes the guarantee
    // hold on any unzip variant — and keeps hostile content out of the output.)
    const extractArgs = ['-o', '-q', filePath, '-d', extractDir];
    if (unsafeEntries.length > 0) {
      extractArgs.push('-x', ...unsafeEntries.map((e) => escapeUnzipPattern(e.name)));
    }

    const warnings = [];
    try {
      await execUnzip(extractArgs, { timeout: 60000, okCodes: [0, 1, 11] });
    } catch (err) {
      if (err.unzipMissing) throw err;
      // Corrupted/truncated mid-archive: salvage whatever was extracted
      // instead of discarding it; only fail when nothing usable came out.
      const salvaged = await fs.promises.readdir(extractDir)
        .then((names) => names.length > 0)
        .catch(() => false);
      if (!salvaged) {
        throw new Error(`invalid or corrupted ZIP archive (${err.message})`);
      }
      warnings.push('Warning: archive is damaged — content below is a partial extraction.');
    }

    // Walk extracted files
    const inventory = [];
    const textParts = [];
    // Running extracted-char count, shared by reference across the
    // recursive walkDirectory calls (mirrors how inventory/textParts are
    // threaded). Must live in an object — a bare `let` is not visible to
    // the top-level walkDirectory function and previously threw
    // ReferenceError, aborting all text extraction.
    const counter = { totalChars: 0 };

    await walkDirectory(extractDir, extractDir, inventory, textParts, { depth: 0, counter });

    // Build output
    const fileCount = inventory.length;
    const textFileCount = inventory.filter(f => f.extractable).length;
    const binaryCount = fileCount - textFileCount;

    const safetyNotes = [];
    if (unsafeEntries.length > 0) {
      safetyNotes.push(
        `Skipped ${unsafeEntries.length} entr${unsafeEntries.length === 1 ? 'y' : 'ies'} with unsafe path(s) (path traversal guard):`,
        ...unsafeEntries.slice(0, 10).map((e) => `  - ${e.name}`));
      if (unsafeEntries.length > 10) {
        safetyNotes.push(`  ... and ${unsafeEntries.length - 10} more`);
      }
    }
    safetyNotes.push(...warnings);

    const header = [
      `ZIP Archive — ${fileCount} file(s) extracted` +
      (textFileCount > 0 ? ` (${textFileCount} text, ${binaryCount} binary)` : ''),
      ...safetyNotes,
      `Directory tree:`,
      ...buildTree(inventory, extractDir),
      binaryCount > 0 ? `\nBinary/non-text files (${binaryCount}):` : '',
      ...inventory.filter(f => !f.extractable)
        .slice(0, 30)
        .map(f => `  - ${f.relativePath}`),
      binaryCount > 30 ? `  ... and ${binaryCount - 30} more binary files` : '',
      textParts.length > 0 ? '\n--- Extracted Text ---' : '',
    ].filter(Boolean).join('\n');

    return header + '\n' + textParts.join('\n\n');
  } catch (err) {
    // Only blame a missing `unzip` binary when that is actually the cause —
    // corrupted archives and bomb rejections get their own clear message.
    const hint = err && err.unzipMissing ? " Ensure 'unzip' is installed on the system." : '';
    throw new Error(`ZIP parsing failed: ${err.message}.${hint}`);
  } finally {
    // Cleanup
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function walkDirectory(baseDir, currentDir, inventory, textParts, opts = {}) {
  const counter = opts.counter || { totalChars: 0 };
  let entries;
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  const resolvedBase = path.resolve(baseDir);

  for (const entry of entries) {
    if (entry.name.startsWith('__MACOSX')) continue;
    if (entry.name.startsWith('.')) continue;
    // Never follow symlinks — a link pointing outside the extraction
    // sandbox must not let the walker read arbitrary host files.
    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(currentDir, entry.name);
    // Containment guard: only ever touch paths inside the extraction dir.
    const resolvedFull = path.resolve(fullPath);
    if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + path.sep)) continue;
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (opts.depth >= MAX_DEPTH) {
        inventory.push({ relativePath: relativePath + '/', type: 'directory', extractable: false });
        continue;
      }
      await walkDirectory(baseDir, fullPath, inventory, textParts, { depth: opts.depth + 1, counter });
      continue;
    }

    if (entry.isFile()) {
      let fileSize = 0;
      try {
        const stat = await fs.promises.stat(fullPath);
        fileSize = stat.size;
      } catch {}

      if (inventory.length >= MAX_LISTED_FILES) continue;

      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext);

      inventory.push({
        relativePath,
        type: 'file',
        extractable: isText,
        size: fileSize,
      });

      if (isText && counter.totalChars < MAX_EXTRACTED_CHARS) {
        try {
          // Skip files larger than 500KB to avoid memory issues
          if (fileSize > 500 * 1024) {
            textParts.push(`[${relativePath} — file too large for inline extraction (${(fileSize / 1024).toFixed(0)}KB)]`);
            continue;
          }

          const content = await fs.promises.readFile(fullPath, 'utf8');
          const remainingSpace = MAX_EXTRACTED_CHARS - counter.totalChars;
          const snippet = content.length > remainingSpace
            ? content.slice(0, remainingSpace) + `\n[... truncated at ${MAX_EXTRACTED_CHARS} chars total]`
            : content;

          if (snippet.trim().length > 0) {
            textParts.push(`\n=== ${relativePath} ===\n${snippet}`);
            counter.totalChars += Math.min(content.length, remainingSpace);
          }
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }
}

function buildTree(inventory, baseDir) {
  const tree = {};
  for (const item of inventory) {
    const parts = item.relativePath.split('/');
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node[part]) node[part] = { __isLeaf: false, __children: {} };
      if (i === parts.length - 1) {
        node[part].__isLeaf = true;
        node[part].__extractable = item.extractable;
      }
      node = node[part].__children;
    }
  }

  const lines = [];
  renderTreeNode(tree, '', lines);
  return lines;
}

function renderTreeNode(node, prefix, lines) {
  const entries = Object.keys(node).filter(k => !k.startsWith('__')).sort();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    const leafNode = node[key];
    const extIcon = leafNode.__isLeaf
      ? (leafNode.__extractable ? ' [text]' : ' [bin]')
      : '/';
    lines.push(`${prefix}${connector}${key}${extIcon}`);
    if (!leafNode.__isLeaf) {
      renderTreeNode(leafNode.__children, prefix + childPrefix, lines);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────

module.exports = { parseZip };