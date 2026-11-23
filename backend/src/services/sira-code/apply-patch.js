'use strict';

/**
 * Workspace patch language for SiraCode & Codex.
 *
 * Native CommonJS adaptation of OpenCode's apply_patch engine
 * (anomalyco/opencode, MIT, commit 4cf9db957485dd51a5b195fb6e2c1e03d8da1107,
 * packages/util/src/patch.ts + packages/core/src/tool/plugin/patch.ts):
 *   - Heredoc stripping (`cat <<'EOF' ... EOF`)
 *   - `*** Begin Patch` / `*** End Patch` envelopes (optional for compact calls)
 *   - `*** Add File:` / `*** Delete File:` / `*** Update File:` / `*** Move to:`
 *   - `@@ [changeContext]` contextual seeking + `*** End of File` anchoring
 *   - 4-tier fuzzy `seek` (exact → rstrip → trim → unicode-normalized) with
 *     strict ambiguity rejection when unanchored
 *   - UTF-8 BOM preservation, per-line CRLF/LF preservation, literal `$`,
 *     and actionable Spanish missHint diagnostics on hunk miss
 *
 * No Effect runtime, no external dependencies.
 */

const {
  splitBom,
  joinBom,
  normalizeForMatch,
  detectDominantEnding,
  withRegionEndings,
  buildEditMissHint,
} = require('../codex/opencode-coding-intel');
const { reindentReplacement } = require('../codex/edit-matching');

const CRLF = '\r\n';

function stripHeredoc(input) {
  const trimmed = String(input || '').trim();
  const m = trimmed.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/);
  return m ? m[3] : trimmed;
}

function toolError(code, message, operations = []) {
  const partial = operations.length > 0;
  return {
    ok: false,
    code,
    error: message,
    content: `ERROR: ${message}${partial ? `\nCambios ya aplicados:\n${operations.join('\n')}` : ''}`,
    operations: [...operations],
    partial,
  };
}

function parseChangeContext(atLine) {
  const trimmed = atLine.trimEnd();
  if (trimmed === '@@') return null;
  // Standard unified-diff numeric header: `@@ -1,3 +1,4 @@ optional context`
  const unified = trimmed.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s+(.*))?$/);
  if (unified) {
    const trailing = (unified[1] || '').trim();
    return trailing || null;
  }
  if (trimmed.startsWith('@@ ')) {
    const ctx = trimmed.slice(3).trim();
    return ctx || null;
  }
  return null;
}

function parsePatch(input) {
  const cleaned = stripHeredoc(input);
  const lines = cleaned.replace(/\r\n/g, '\n').split('\n');
  const hasEnvelope = lines.some((line) => line.trim() === '*** Begin Patch');
  const ops = [];
  let current = null;
  let inPatch = !hasEnvelope;

  const startOp = (op) => {
    current = op;
    ops.push(op);
  };

  const ensureChunk = (op, changeContext = null) => {
    const active = op.chunks[op.chunks.length - 1];
    if (!active || active.oldLines.length > 0 || active.newLines.length > 0 || active.changeContext != null) {
      op.chunks.push({
        changeContext,
        endOfFile: false,
        oldLines: [],
        newLines: [],
      });
    } else if (changeContext != null) {
      active.changeContext = changeContext;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '*** Begin Patch') {
      inPatch = true;
      current = null;
      continue;
    }
    if (trimmed === '*** End Patch') {
      inPatch = false;
      current = null;
      continue;
    }
    if (!inPatch) continue;
    if (trimmed.startsWith('*** Environment ID:')) continue;

    const add = trimmed.match(/^\*\*\* Add File:\s+(.+)$/);
    if (add) {
      startOp({ type: 'add', path: add[1].trim(), body: [] });
      continue;
    }
    const del = trimmed.match(/^\*\*\* Delete File:\s+(.+)$/);
    if (del) {
      startOp({ type: 'delete', path: del[1].trim() });
      current = null;
      continue;
    }
    const upd = trimmed.match(/^\*\*\* Update File:\s+(.+)$/);
    if (upd) {
      startOp({
        type: 'update',
        path: upd[1].trim(),
        moveTo: null,
        hunks: [[]],
        chunks: [],
      });
      continue;
    }
    const move = trimmed.match(/^\*\*\* Move to:\s+(.+)$/);
    if (move && current && current.type === 'update') {
      current.moveTo = move[1].trim();
      continue;
    }
    if (!current) continue;

    if (current.type === 'add') {
      current.body.push(line.startsWith('+') ? line.slice(1) : line);
      continue;
    }

    if (current.type === 'update') {
      if (trimmed === '*** End of File') {
        const lastChunk = current.chunks[current.chunks.length - 1];
        if (lastChunk) lastChunk.endOfFile = true;
        continue;
      }
      if (line.startsWith('@@')) {
        const changeContext = parseChangeContext(line);
        if (current.hunks[current.hunks.length - 1].length) current.hunks.push([]);
        ensureChunk(current, changeContext);
        continue;
      }
      if (current.chunks.length === 0) {
        current.chunks.push({ changeContext: null, endOfFile: false, oldLines: [], newLines: [] });
      }
      const chunk = current.chunks[current.chunks.length - 1];
      current.hunks[current.hunks.length - 1].push(line);
      if (line.startsWith('+')) {
        chunk.newLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        chunk.oldLines.push(line.slice(1));
      } else {
        const ctx = line.startsWith(' ') ? line.slice(1) : line;
        chunk.oldLines.push(ctx);
        chunk.newLines.push(ctx);
      }
    }
  }
  return ops;
}

function hunkToOldNew(hunkLines) {
  const oldLines = [];
  const newLines = [];
  for (const line of hunkLines) {
    if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith('-')) oldLines.push(line.slice(1));
    else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(ctx);
      newLines.push(ctx);
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

function applyUnique(haystack, oldText, newText) {
  if (!oldText) {
    const err = new Error('hunk vacío o sin contexto');
    err.code = 'hunk_empty';
    throw err;
  }
  const start = haystack.indexOf(oldText);
  if (start === -1) {
    const err = new Error('el hunk no coincide con el archivo');
    err.code = 'hunk_miss';
    throw err;
  }
  if (haystack.indexOf(oldText, start + 1) !== -1) {
    const err = new Error('el hunk aparece más de una vez');
    err.code = 'hunk_ambiguous';
    throw err;
  }
  return haystack.slice(0, start) + newText + haystack.slice(start + oldText.length);
}

// ── 4-tier OpenCode seek engine (packages/util/src/patch.ts) ────────────────

const SEEK_TIERS = [
  { name: 'exact', compare: (left, right) => left === right },
  { name: 'rstrip', compare: (left, right) => left.trimEnd() === right.trimEnd() },
  { name: 'trim', compare: (left, right) => left.trim() === right.trim() },
  { name: 'normalized', compare: (left, right) => normalizeForMatch(left.trim()) === normalizeForMatch(right.trim()) },
];

function linesMatchAt(lines, pattern, offset, compare) {
  for (let i = 0; i < pattern.length; i += 1) {
    if (!compare(lines[offset + i], pattern[i])) return false;
  }
  return true;
}

/**
 * Finds all offsets for `pattern` starting at `start` using the first matching
 * tier in `SEEK_TIERS`. When `eof` is true, checks only the exact EOF offset.
 */
function seekCandidates(lines, pattern, start, eof = false) {
  if (!pattern.length) return { tier: null, offsets: [] };
  if (eof) {
    const offset = lines.length - pattern.length;
    if (offset < start) return { tier: null, offsets: [] };
    for (const tier of SEEK_TIERS) {
      if (linesMatchAt(lines, pattern, offset, tier.compare)) {
        return { tier: tier.name, offsets: [offset] };
      }
    }
    return { tier: null, offsets: [] };
  }
  for (const tier of SEEK_TIERS) {
    const offsets = [];
    for (let offset = start; offset <= lines.length - pattern.length; offset += 1) {
      if (linesMatchAt(lines, pattern, offset, tier.compare)) {
        offsets.push(offset);
      }
    }
    if (offsets.length > 0) {
      return { tier: tier.name, offsets };
    }
  }
  return { tier: null, offsets: [] };
}

function splitLinesWithEndings(text) {
  const lines = [];
  const endings = [];
  let cursor = 0;
  const rx = /\r?\n/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    lines.push(text.slice(cursor, m.index));
    endings.push(m[0]);
    cursor = m.index + m[0].length;
  }
  const trailing = text.slice(cursor);
  const hadTrailingNewline = text.length > 0 && cursor === text.length;
  if (!hadTrailingNewline && text.length > 0) {
    lines.push(trailing);
    endings.push('');
  }
  return { lines, endings, hadTrailingNewline };
}

function reindentChunkInsert(fileLines, start, oldLines, newLines, tier) {
  if ((tier !== 'trim' && tier !== 'normalized') || !oldLines.length || !newLines.length) {
    return newLines;
  }
  const firstIdx = oldLines.findIndex((l) => l.trim().length > 0);
  if (firstIdx < 0 || start + firstIdx >= fileLines.length) return newLines;
  const fileIndent = (fileLines[start + firstIdx].match(/^[ \t]*/) || [''])[0];
  const oldIndent = (oldLines[firstIdx].match(/^[ \t]*/) || [''])[0];
  if (fileIndent.length <= oldIndent.length || !fileIndent.startsWith(oldIndent)) return newLines;
  const delta = fileIndent.slice(oldIndent.length);
  return reindentReplacement(newLines.join('\n'), delta).split('\n');
}

function serializeLinesWithEndings(lines, endings, fallbackEnding, hadTrailingNewline) {
  if (lines.length === 0) return '';
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const isLast = i === lines.length - 1;
    let ending = endings[i];
    if (!isLast) {
      if (!ending) ending = fallbackEnding;
    } else if (hadTrailingNewline) {
      if (!ending) ending = fallbackEnding;
    } else {
      ending = '';
    }
    parts.push(lines[i] + ending);
  }
  return parts.join('');
}

/**
 * Applies structured OpenCode chunks to `original`, preserving UTF-8 BOM,
 * per-line LF/CRLF endings, and literal `$` sequences.
 * Rejects unanchored ambiguous chunks with code `hunk_ambiguous`.
 */
function applyUpdateChunks(original, chunks, { pathLabel = '' } = {}) {
  const list = Array.isArray(chunks) ? chunks.filter((c) => c && (c.oldLines.length > 0 || c.newLines.length > 0)) : [];
  if (!list.length) return String(original ?? '');

  const bomSplit = splitBom(String(original ?? ''));
  const fileEnding = detectDominantEnding(bomSplit.text, '\n');
  const { lines, endings, hadTrailingNewline } = splitLinesWithEndings(bomSplit.text);

  const replacements = [];
  let lineIndex = 0;

  for (const chunk of list) {
    let anchoredByContext = false;
    if (chunk.changeContext) {
      const ctxSearch = seekCandidates(lines, [chunk.changeContext], lineIndex, false);
      if (ctxSearch.offsets.length === 0) {
        const err = new Error(`no se encontró el contexto '${chunk.changeContext}'`);
        err.code = 'hunk_miss';
        throw err;
      }
      lineIndex = ctxSearch.offsets[0] + 1;
      anchoredByContext = true;
    }

    // Pure insertion chunk (no old lines).
    if (chunk.oldLines.length === 0) {
      const insertAt = anchoredByContext ? lineIndex : lines.length;
      replacements.push({
        start: insertAt,
        remove: 0,
        insert: [...chunk.newLines],
        tier: 'exact',
      });
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekCandidates(lines, oldLines, lineIndex, Boolean(chunk.endOfFile));

    // Tolerate a single trailing blank line mismatch (mirrors OpenCode patch.ts:327).
    if (found.offsets.length === 0 && oldLines.length > 1 && oldLines[oldLines.length - 1] === '') {
      const trimmedOld = oldLines.slice(0, -1);
      const trimmedNew = newLines[newLines.length - 1] === '' ? newLines.slice(0, -1) : newLines;
      const retry = seekCandidates(lines, trimmedOld, lineIndex, Boolean(chunk.endOfFile));
      if (retry.offsets.length > 0) {
        oldLines = trimmedOld;
        newLines = trimmedNew;
        found = retry;
      }
    }

    if (found.offsets.length === 0) {
      const hint = buildEditMissHint(bomSplit.text, oldLines.join('\n'), newLines.join('\n'));
      const err = new Error(`el hunk no coincide con el archivo${hint ? `\n\n${hint}` : ''}`);
      err.code = 'hunk_miss';
      err.hint = hint;
      throw err;
    }

    // Reject unanchored ambiguous matches (e.g., identical single-line hunks
    // appearing multiple times without `@@ context` or `*** End of File`).
    if (found.offsets.length > 1 && !anchoredByContext && !chunk.endOfFile) {
      const err = new Error('el hunk aparece más de una vez');
      err.code = 'hunk_ambiguous';
      throw err;
    }

    const start = found.offsets[0];
    const insertLines = reindentChunkInsert(lines, start, oldLines, newLines, found.tier);
    replacements.push({
      start,
      remove: oldLines.length,
      insert: insertLines,
      tier: found.tier,
    });
    lineIndex = start + oldLines.length;
  }

  // Apply replacements from bottom to top while preserving per-line endings.
  replacements.sort((a, b) => a.start - b.start);
  for (let r = replacements.length - 1; r >= 0; r -= 1) {
    const { start, remove, insert } = replacements[r];
    // Preserve region endings via LCS when replacing existing lines.
    const regionLines = lines.slice(start, start + remove);
    const regionEndings = endings.slice(start, start + remove);
    const regionFallback = regionEndings.find((e) => e === CRLF || e === '\n') || fileEnding;

    let newEndings;
    if (insert.length === 0) {
      newEndings = [];
    } else if (regionLines.length > 0) {
      const regionText = regionLines
        .map((line, idx) => line + (idx < regionLines.length - 1 ? (regionEndings[idx] || regionFallback) : ''))
        .join('');
      const aligned = withRegionEndings(regionText, insert.join('\n'), regionFallback);
      const parsedAligned = splitLinesWithEndings(aligned);
      newEndings = parsedAligned.endings;
      // Preserve the final line's original trailing newline ending.
      const lastRegionEnding = regionEndings[regionEndings.length - 1] ?? regionFallback;
      if (newEndings.length > 0) {
        newEndings[newEndings.length - 1] = lastRegionEnding;
      }
    } else {
      newEndings = insert.map(() => regionFallback);
    }

    lines.splice(start, remove, ...insert);
    endings.splice(start, remove, ...newEndings);
  }

  const rebuilt = serializeLinesWithEndings(lines, endings, fileEnding, hadTrailingNewline);
  // Also preserve a BOM if the patch itself introduced one.
  const outBom = splitBom(rebuilt);
  void pathLabel;
  return joinBom(outBom.text, bomSplit.bom || outBom.bom);
}

/**
 * Pure two-phase patch planner for runners that support batch commits (such as
 * Codex CloudAgent): validates and computes ALL add / update / move / delete
 * operations in memory before any write occurs, tracking sequential updates
 * against the same file.
 */
async function planPatchOperations(input, {
  normalizePath,
  readFile,
  checkExistingForUpdate,
} = {}) {
  const ops = parsePatch(input);
  if (!ops.length) {
    const err = new Error('el parche no tiene operaciones');
    err.code = 'validation';
    throw err;
  }

  const staged = new Map(); // normalizedPath -> { content: string | null, existed: boolean }
  const summary = [];
  const readsPerformed = new Map(); // normalizedPath -> originalContent

  const safePath = (rawPath) => {
    const p = typeof normalizePath === 'function' ? normalizePath(rawPath) : String(rawPath || '').trim();
    if (!p) {
      const err = new Error(`ruta inválida o fuera del workspace: ${rawPath}`);
      err.code = 'path_traversal';
      throw err;
    }
    return p;
  };

  for (const op of ops) {
    if (op.type === 'add') {
      const rel = safePath(op.path);
      const body = op.body.join('\n');
      const content = body.length > 0 && !body.endsWith('\n') ? `${body}\n` : body;
      staged.set(rel, { content, existed: false });
      summary.push({ type: 'add', path: rel });
      continue;
    }

    if (op.type === 'delete') {
      const rel = safePath(op.path);
      const prev = staged.get(rel);
      if (prev && prev.content === null) {
        const err = new Error(`no se puede eliminar ${rel}: el archivo ya fue eliminado en este parche`);
        err.code = 'not_found';
        throw err;
      }
      if (!prev) {
        const current = await readFile(rel);
        if (current == null) {
          const err = new Error(`no se puede eliminar ${rel}: archivo no encontrado`);
          err.code = 'not_found';
          throw err;
        }
        readsPerformed.set(rel, current);
      }
      staged.set(rel, { content: null, existed: true });
      summary.push({ type: 'delete', path: rel });
      continue;
    }

    if (op.type === 'update') {
      const rel = safePath(op.path);
      const moveTo = op.moveTo ? safePath(op.moveTo) : null;
      const prev = staged.get(rel);
      let current;
      if (prev) {
        if (prev.content === null) {
          const err = new Error(`no se puede actualizar ${rel}: el archivo fue eliminado en este parche`);
          err.code = 'not_found';
          throw err;
        }
        current = prev.content;
      } else {
        current = await readFile(rel);
        if (current == null) {
          const err = new Error(`no se encontró ${rel} para actualizar`);
          err.code = 'not_found';
          throw err;
        }
        if (typeof checkExistingForUpdate === 'function') {
          checkExistingForUpdate(rel, current);
        }
        readsPerformed.set(rel, current);
      }

      const chunks = Array.isArray(op.chunks) && op.chunks.length
        ? op.chunks
        : op.hunks
          .filter((h) => h.length)
          .map((h) => {
            const { oldText, newText } = hunkToOldNew(h);
            return {
              changeContext: null,
              endOfFile: false,
              oldLines: oldText ? oldText.split('\n') : [],
              newLines: newText ? newText.split('\n') : [],
            };
          });

      let updated;
      try {
        updated = applyUpdateChunks(current, chunks, { pathLabel: rel });
      } catch (err) {
        const wrapped = new Error(`${rel}: ${err.message}`);
        wrapped.code = err.code || 'hunk_failed';
        wrapped.hint = err.hint;
        throw wrapped;
      }

      if (moveTo && moveTo !== rel) {
        staged.set(rel, { content: null, existed: true });
        staged.set(moveTo, { content: updated, existed: false });
        summary.push({ type: 'move', path: rel, moveTo });
      } else {
        staged.set(rel, { content: updated, existed: true });
        summary.push({ type: 'update', path: rel });
      }
    }
  }

  const writes = [];
  const deletes = [];
  for (const [filePath, entry] of staged.entries()) {
    if (entry.content === null) {
      if (entry.existed) deletes.push(filePath);
    } else {
      writes.push({ path: filePath, content: entry.content });
    }
  }

  return { writes, deletes, summary, readsPerformed };
}

async function applyPatchToWorkspace(workspace, input) {
  const ops = parsePatch(input);
  if (!ops.length) return toolError('validation', 'el parche no tiene operaciones');
  const done = [];
  for (const op of ops) {
    try {
      if (op.type === 'add') {
        const rel = op.path;
        if (!rel) return toolError('validation', 'Add File requiere path', done);
        const saved = await workspace.createFile(rel, op.body.join('\n'));
        done.push(`add ${saved}`);
        continue;
      }
      if (op.type === 'delete') {
        if (!op.path) return toolError('validation', 'Delete File requiere path', done);
        try {
          const removed = await workspace.removeFile(op.path);
          done.push(`delete ${removed}`);
        } catch (err) {
          return toolError(err.code || 'delete_failed', err.message || 'delete failed', done);
        }
        continue;
      }
      if (op.type === 'update') {
        if (!op.path) return toolError('validation', 'Update File requiere path', done);
        let current;
        let bytes;
        try {
          ({ content: current, bytes } = await workspace.readFileForMutation(op.path));
        } catch (err) {
          return toolError(err.code || 'read_failed', err.message || 'read failed', done);
        }
        try {
          const chunks = Array.isArray(op.chunks) && op.chunks.length ? op.chunks : [];
          if (chunks.length) {
            current = applyUpdateChunks(current, chunks, { pathLabel: op.path });
          } else {
            for (const hunk of op.hunks) {
              if (!hunk.length) continue;
              const { oldText, newText } = hunkToOldNew(hunk);
              current = applyUnique(current, oldText, newText);
            }
          }
        } catch (err) {
          return toolError(err.code || 'hunk_failed', `${op.path}: ${err.message}`, done);
        }
        if (op.moveTo && op.moveTo !== op.path) {
          const saved = await workspace.moveFileIfUnchanged(op.path, op.moveTo, current, bytes);
          done.push(`update ${op.path} -> ${saved}`);
        } else {
          const saved = await workspace.writeFileIfUnchanged(op.path, current, bytes);
          done.push(`update ${saved}`);
        }
      }
    } catch (err) {
      return toolError(err.code || 'patch_failed', err.message || 'apply_patch failed', [...done, ...(err.operations || [])]);
    }
  }
  return { ok: true, content: done.join('\n'), operations: done };
}

module.exports = {
  stripHeredoc,
  parsePatch,
  hunkToOldNew,
  applyUnique,
  applyUpdateChunks,
  planPatchOperations,
  applyPatchToWorkspace,
};
