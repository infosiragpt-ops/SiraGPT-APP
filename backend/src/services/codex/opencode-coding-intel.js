'use strict';

/**
 * codex/opencode-coding-intel — shared native CommonJS coding intelligence
 * adapted from anomalyco/opencode (MIT License, commit
 * 4cf9db957485dd51a5b195fb6e2c1e03d8da1107).
 *
 * Adapted contracts (zero Effect-TS, zero Bun runtime, zero external deps):
 *   - packages/util/src/bom.ts               → UTF-8 BOM split/join
 *   - packages/core/src/tool/plugin/edit.ts  → typographic normalization,
 *     LCS region-aware LF/CRLF preservation, edit missHint (already-applied
 *     detection + whitespace-normalized line voting)
 *   - packages/core/src/tool/plugin/read.ts  → canonical look-alike filename
 *     normalization, 4-tier Levenshtein fuzzy path suggestions, nearest
 *     existing ancestor diagnosis
 *   - packages/core/src/instruction-discovery.ts → hierarchical AGENTS.md /
 *     CLAUDE.md discovery with preferAgents precedence and session dedupe
 *
 * All user-facing diagnostics are in Spanish and vendor-free.
 */

const path = require('node:path');

const UTF8_BOM = '\uFEFF';
const CRLF = '\r\n';
const MAX_LCS_CELLS = 250_000;
const DEFAULT_HINT_LINES = 12;
const DEFAULT_HINT_LINE_LENGTH = 200;
const INSTRUCTION_FILENAMES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

// ── UTF-8 BOM helpers (packages/util/src/bom.ts) ────────────────────────────

function splitBom(text) {
  const raw = String(text ?? '');
  if (raw.startsWith(UTF8_BOM)) {
    return { text: raw.slice(1), bom: true };
  }
  return { text: raw, bom: false };
}

function joinBom(text, bom) {
  const raw = String(text ?? '');
  if (!bom) return raw;
  return raw.startsWith(UTF8_BOM) ? raw : `${UTF8_BOM}${raw}`;
}

// ── Typographic normalization (edit.ts & patch.ts) ──────────────────────────
// Strictly 1-to-1 character replacements so character offsets remain identical.

function normalizeForMatch(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

// ── Line-ending preservation (edit.ts: alignLines + withRegionEndings) ──────

function detectDominantEnding(text, fallback = '\n') {
  const s = String(text ?? '');
  const crlfCount = s.split(CRLF).length - 1;
  const lfCount = s.split('\n').length - 1 - crlfCount;
  if (crlfCount === lfCount) return fallback;
  return crlfCount > lfCount ? CRLF : '\n';
}

/**
 * Number of sorted positions strictly before `offset` (binary search).
 */
function countBefore(positions, offset) {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (positions[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * For each line of `after`, return the index of the `before` line it preserves
 * (longest common subsequence) or, between preserved anchors, the line it
 * replaces; undefined for newly inserted lines with no counterpart.
 */
function alignLines(before, after) {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0) return new Array(m).fill(undefined);

  // Guard against quadratic allocation on huge whole-file replacements.
  if (n * m > MAX_LCS_CELLS) {
    const fallback = new Array(m);
    for (let j = 0; j < m; j += 1) fallback[j] = j < n ? j : undefined;
    return fallback;
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const result = new Array(m);
  let gapBefore = [];
  let gapAfter = [];
  const flush = () => {
    for (let k = 0; k < gapAfter.length; k += 1) {
      result[gapAfter[k]] = gapBefore[k];
    }
    gapBefore = [];
    gapAfter = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      flush();
      result[j] = i;
      i += 1;
      j += 1;
      continue;
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      gapBefore.push(i);
      i += 1;
    } else {
      gapAfter.push(j);
      j += 1;
    }
  }
  while (i < n) {
    gapBefore.push(i);
    i += 1;
  }
  while (j < m) {
    gapAfter.push(j);
    j += 1;
  }
  flush();
  return result;
}

/**
 * Joins `replacement` (LF-normalized) using line endings preserved from
 * `region`. Unchanged context lines keep their original LF/CRLF byte ending;
 * in-place edits inherit the ending of the line they replace; added lines use
 * `fallback`.
 */
function withRegionEndings(region, replacement, fallback = '\n') {
  const rawRegion = String(region ?? '');
  const lfReplacement = String(replacement ?? '').replaceAll(CRLF, '\n');
  const before = rawRegion.split(/\r?\n/);
  const endings = [];
  const rx = /\r?\n/g;
  let match;
  while ((match = rx.exec(rawRegion)) !== null) endings.push(match[0]);
  const after = lfReplacement.split('\n');
  const key = (line) => normalizeForMatch(line.trimEnd());
  const sourceMap = alignLines(before.map(key), after.map(key));
  const out = [];
  for (let idx = 0; idx < after.length; idx += 1) {
    if (idx === after.length - 1) {
      out.push(after[idx]);
    } else {
      const mapped = sourceMap[idx];
      const ending = mapped !== undefined && endings[mapped] !== undefined ? endings[mapped] : fallback;
      out.push(after[idx] + ending);
    }
  }
  return out.join('');
}

// ── Actionable edit missHint (edit.ts: missHint) ────────────────────────────

/**
 * Produces a concise Spanish diagnostic hint when an edit/hunk fails to match:
 *   1. Detects when `newString` (>=20 trimmed chars) is already present.
 *   2. Votes across whitespace-normalized alphanumeric lines to locate the
 *      closest region in the file (requires >=50% line agreement) and prints
 *      the numbered slice so the model can self-correct without re-reading.
 */
function buildEditMissHint(source, oldString, newString = '', opts = {}) {
  const maxLines = Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0
    ? Math.floor(Number(opts.maxLines))
    : DEFAULT_HINT_LINES;
  const maxLineLength = Number.isFinite(Number(opts.maxLineLength)) && Number(opts.maxLineLength) > 0
    ? Math.floor(Number(opts.maxLineLength))
    : DEFAULT_HINT_LINE_LENGTH;

  const view = String(source ?? '').replaceAll(CRLF, '\n');
  const replacement = String(newString ?? '').replaceAll(CRLF, '\n');

  if (replacement.trim().length >= 20 && normalizeForMatch(view).includes(normalizeForMatch(replacement))) {
    return 'El texto nuevo ya existe en el archivo; es posible que esta edición ya se haya aplicado.';
  }

  const key = (line) => normalizeForMatch(line).replace(/\s+/g, ' ').trim();
  const distinct = (line) => /[\p{L}\p{N}]/u.test(line);
  const lines = view.split('\n');
  const search = String(oldString ?? '').replaceAll(CRLF, '\n').split('\n');

  const positions = new Map();
  for (let idx = 0; idx < lines.length; idx += 1) {
    const value = key(lines[idx]);
    if (!distinct(value)) continue;
    const found = positions.get(value);
    if (found) found.push(idx);
    else positions.set(value, [idx]);
  }

  const votes = new Map();
  let wanted = 0;
  for (let offset = 0; offset < search.length; offset += 1) {
    const value = key(search[offset]);
    if (!distinct(value)) continue;
    wanted += 1;
    const hits = positions.get(value);
    if (!hits) continue;
    for (let h = 0; h < hits.length; h += 1) {
      const startCandidate = hits[h] - offset;
      votes.set(startCandidate, (votes.get(startCandidate) || 0) + 1);
    }
  }

  let bestStart = 0;
  let bestCount = 0;
  for (const [candidate, count] of votes.entries()) {
    if (count > bestCount) {
      bestStart = candidate;
      bestCount = count;
    }
  }

  if (bestCount === 0 || bestCount * 2 < wanted) return null;

  const matched = [];
  for (let offset = 0; offset < search.length; offset += 1) {
    const value = key(search[offset]);
    const idx = bestStart + offset;
    if (value !== '' && idx >= 0 && idx < lines.length && key(lines[idx]) === value) {
      matched.push(idx);
    }
  }
  if (!matched.length) return null;

  const from = matched[0];
  const to = Math.min(matched[matched.length - 1] + 1, from + maxLines);
  const snippet = lines.slice(from, to).map((line, index) => {
    const body = line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line;
    return `${from + index + 1}: ${body}`;
  });
  return ['Líneas más cercanas en el archivo:', ...snippet].join('\n');
}

// ── Fuzzy path suggestions & look-alike recovery (read.ts) ──────────────────

function canonicalFileName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'");
}

function fileStem(name) {
  const s = String(name ?? '');
  const ext = path.posix.extname(s);
  return s.slice(0, s.length - ext.length) || s;
}

function editDistance(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= right.length; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[right.length];
}

/**
 * Ranks sibling entries against a missing filename:
 *   1. Exact case-insensitive match
 *   2. Same stem with a different extension (e.g., App.js → App.tsx)
 *   3. Substring containment (min stem length >= 3)
 *   4. Bounded Levenshtein typo in the stem (0/1/2 by length)
 */
function suggestSimilarNames(names, requested, limit = 3) {
  const list = Array.isArray(names) ? names : [];
  const req = String(requested ?? '');
  if (!req) return [];
  const name = req.toLowerCase();
  const wanted = fileStem(name);
  const typos = wanted.length < 3 ? 0 : wanted.length < 5 ? 1 : 2;
  const reqCanonical = canonicalFileName(name);

  const tierOf = (candidate) => {
    if (candidate === name) return 1;
    if (canonicalFileName(candidate) === reqCanonical) return 1;
    const found = fileStem(candidate);
    if (found === wanted) return 2;
    if (
      Math.min(found.length, wanted.length) >= 3
      && (candidate.includes(name) || name.includes(candidate) || found.includes(wanted) || wanted.includes(found))
    ) {
      return 3;
    }
    if (typos > 0 && Math.abs(found.length - wanted.length) <= typos && editDistance(found, wanted) <= typos) {
      return 4;
    }
    return undefined;
  };

  const ranked = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry || entry === req) continue;
    const lower = entry.toLowerCase();
    const rank = tierOf(lower);
    if (rank === undefined) continue;
    ranked.push({ entry, rank, distance: editDistance(lower, name) });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.entry.localeCompare(b.entry));
  return ranked.slice(0, Math.max(1, limit)).map((item) => item.entry);
}

function normalizeRelPosix(relPath) {
  return String(relPath ?? '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * Given a missing relative path and a flat list of existing workspace relative
 * file paths, identifies either:
 *   - similar siblings in the same directory, OR
 *   - the first missing folder, its nearest existing ancestor, and similar
 *     folder names inside that ancestor.
 */
function diagnoseMissingPath(requestedRelPath, knownRelPaths, { limit = 3 } = {}) {
  const req = normalizeRelPosix(requestedRelPath);
  if (!req || !Array.isArray(knownRelPaths) || knownRelPaths.length === 0) {
    return { missingFolder: null, nearestFolder: null, suggestions: [] };
  }

  // Build directory → child entry names map from flat workspace file list.
  const dirChildren = new Map();
  const addChild = (dir, childName) => {
    let set = dirChildren.get(dir);
    if (!set) {
      set = new Set();
      dirChildren.set(dir, set);
    }
    set.add(childName);
  };
  dirChildren.set('', new Set());

  for (const raw of knownRelPaths) {
    const clean = normalizeRelPosix(raw);
    if (!clean) continue;
    const parts = clean.split('/').filter(Boolean);
    let prefix = '';
    for (let i = 0; i < parts.length; i += 1) {
      addChild(prefix, parts[i]);
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (i < parts.length - 1 && !dirChildren.has(prefix)) {
        dirChildren.set(prefix, new Set());
      }
    }
  }

  const reqDir = path.posix.dirname(req);
  const folder = reqDir === '.' ? '' : reqDir;
  const base = path.posix.basename(req);

  if (dirChildren.has(folder)) {
    const siblings = [...dirChildren.get(folder)];
    const similar = suggestSimilarNames(siblings, base, limit);
    const suggestions = similar.map((entry) => (folder ? `${folder}/${entry}` : entry));
    return { missingFolder: null, nearestFolder: folder || '.', suggestions };
  }

  // Walk upward to find the first missing folder and its nearest existing parent.
  let child = folder;
  let parent = path.posix.dirname(child);
  if (parent === '.') parent = '';
  while (child) {
    if (dirChildren.has(parent)) {
      const entries = [...dirChildren.get(parent)];
      const similar = suggestSimilarNames(entries, path.posix.basename(child), limit);
      const suggestions = similar.map((entry) => (parent ? `${parent}/${entry}` : entry));
      return {
        missingFolder: child,
        nearestFolder: parent || '.',
        suggestions,
      };
    }
    if (!parent) break;
    child = parent;
    parent = path.posix.dirname(child);
    if (parent === '.') parent = '';
  }

  return { missingFolder: folder || null, nearestFolder: '.', suggestions: [] };
}

function formatMissingPathHint({ missingFolder = null, nearestFolder = null, suggestions = [] } = {}) {
  const parts = [];
  if (missingFolder) {
    const near = nearestFolder || '.';
    parts.push(`La carpeta ${missingFolder} no existe. La carpeta existente más cercana es ${near}.`);
  }
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    parts.push(`¿Quisiste decir alguno de estos?\n${suggestions.slice(0, 3).join('\n')}`);
  }
  return parts.join('\n\n');
}

// ── Hierarchical scoped instruction discovery (instruction-discovery.ts) ────

/**
 * Drops each CLAUDE.md whose directory also has an AGENTS.md among `found`.
 */
function preferAgents(found) {
  const list = Array.isArray(found) ? found : [];
  const normalized = list.map(normalizeRelPosix);
  const set = new Set(normalized);
  return list.filter((_, idx) => {
    const rel = normalized[idx];
    if (path.posix.basename(rel) !== 'CLAUDE.md') return true;
    const dir = path.posix.dirname(rel);
    const sibling = dir === '.' ? 'AGENTS.md' : `${dir}/AGENTS.md`;
    return !set.has(sibling);
  });
}

/**
 * Returns relative ancestor directories from a target file walking upward
 * toward the workspace root (nearest-first). Excludes root by default because
 * root instructions are loaded once at session start.
 */
function ancestorsToRoot(targetRelPath, { includeRoot = false, isDirectory = false } = {}) {
  const clean = normalizeRelPosix(targetRelPath);
  if (!clean || clean === '.' || clean.startsWith('/') || clean.split('/').includes('..')) {
    return includeRoot ? [''] : [];
  }
  const start = isDirectory ? clean : path.posix.dirname(clean);
  const dirs = [];
  let cursor = start === '.' ? '' : start;
  while (cursor) {
    dirs.push(cursor);
    const next = path.posix.dirname(cursor);
    cursor = next === '.' || next === cursor ? '' : next;
  }
  if (includeRoot) dirs.push('');
  return dirs;
}

/**
 * Discovers scoped AGENTS.md (falling back to CLAUDE.md per directory) along
 * the ancestor chain of a read file, deduplicated against `seenSet`.
 * Never throws: read errors or missing files are silently skipped.
 */
async function discoverScopedInstructions({
  targetRelPath,
  readFile,
  seenSet = null,
  includeRoot = false,
  isDirectory = false,
  maxPerFile = 3_500,
  maxTotal = 6_000,
} = {}) {
  if (typeof readFile !== 'function') return [];
  const normalizedTarget = normalizeRelPosix(targetRelPath);
  if (!normalizedTarget || normalizedTarget.startsWith('/') || normalizedTarget.split('/').includes('..')) {
    return [];
  }

  const dirs = ancestorsToRoot(normalizedTarget, { includeRoot, isDirectory });
  if (!dirs.length) return [];

  const found = [];
  let totalChars = 0;

  for (const dir of dirs) {
    if (totalChars >= maxTotal) break;
    // preferAgents: check AGENTS.md first; only probe CLAUDE.md if absent.
    for (const filename of INSTRUCTION_FILENAMES) {
      const candidate = dir ? `${dir}/${filename}` : filename;
      if (candidate === normalizedTarget) {
        if (filename === 'AGENTS.md') break;
        continue;
      }
      if (seenSet && seenSet.has(candidate)) {
        if (filename === 'AGENTS.md') break;
        continue;
      }
      let content = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await readFile(candidate);
        if (typeof raw === 'string') content = raw;
        else if (raw && typeof raw.content === 'string') content = raw.content;
      } catch {
        content = null;
      }
      if (content == null) continue;
      const trimmed = content.trim();
      if (seenSet) seenSet.add(candidate);
      if (trimmed) {
        const remaining = Math.max(0, maxTotal - totalChars);
        const cap = Math.min(maxPerFile, remaining);
        if (cap > 0) {
          const clipped = trimmed.length > cap ? `${trimmed.slice(0, cap)}\n…[instrucciones recortadas]` : trimmed;
          found.push({ path: candidate, content: clipped });
          totalChars += clipped.length;
        }
      }
      // Once AGENTS.md exists in this directory, skip CLAUDE.md (preferAgents).
      if (filename === 'AGENTS.md') break;
    }
  }

  return found;
}

function formatScopedInstructionsBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map((entry) => `[INSTRUCCIONES DE SUBCARPETA: ${entry.path}]\n${entry.content}`)
    .join('\n\n');
}

module.exports = {
  UTF8_BOM,
  INSTRUCTION_FILENAMES,
  splitBom,
  joinBom,
  normalizeForMatch,
  detectDominantEnding,
  countBefore,
  alignLines,
  withRegionEndings,
  buildEditMissHint,
  canonicalFileName,
  fileStem,
  editDistance,
  suggestSimilarNames,
  diagnoseMissingPath,
  formatMissingPathHint,
  preferAgents,
  ancestorsToRoot,
  discoverScopedInstructions,
  formatScopedInstructionsBlock,
};
