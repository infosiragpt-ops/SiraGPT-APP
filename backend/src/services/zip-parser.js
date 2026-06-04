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
 * Parse a ZIP archive and extract all readable text.
 * Uses the system `unzip` command for reliability.
 */
async function parseZip(filePath) {
  const extractDir = path.join(os.tmpdir(), `siragpt-zip-${crypto.randomUUID()}`);

  try {
    await fs.promises.mkdir(extractDir, { recursive: true });

    // Extract the ZIP
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', filePath, '-d', extractDir],
        { timeout: 60000 },
        (err) => {
          if (err) reject(new Error(`ZIP extraction failed: ${err.message}`));
          else resolve();
        });
    });

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

    const header = [
      `ZIP Archive — ${fileCount} file(s) extracted` +
      (textFileCount > 0 ? ` (${textFileCount} text, ${binaryCount} binary)` : ''),
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
    throw new Error(`ZIP parsing failed: ${err.message}. Ensure 'unzip' is installed on the system.`);
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

  for (const entry of entries) {
    if (entry.name.startsWith('__MACOSX')) continue;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(currentDir, entry.name);
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