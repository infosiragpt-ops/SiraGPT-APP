'use strict';

/**
 * Workspace-jailed read / write / edit for SiraCode.
 *
 * Contract inspired by OpenCode file tools (anomalyco/opencode, MIT, commit
 * 4cf9db957485dd51a5b195fb6e2c1e03d8da1107):
 * read(path, offset, limit) with canonical look-alike recovery, fuzzy ENOENT
 * suggestions & hierarchical AGENTS.md/CLAUDE.md discovery; write(path, content);
 * edit(path, old_str, new_str) with graduated match ladder, LCS line-ending
 * preservation & actionable missHint; plus batched atomic `multiedit`.
 * Unique occurrence, size caps, binary reject, path jail. Native CommonJS —
 * not a copy of vendor/opencode read.ts / write.ts / edit.ts.
 * No Effect, no LSP, no Snapshot, no OpenRouter.
 */

const fs = require('fs/promises');
const path = require('path');
const { jailRealPath, isInsideRoot, MAX_FILE_BYTES } = require('./workspace');
const { truncateToolResult } = require('./tool-result');
const { applyEdit } = require('../codex/edit-matching');
const {
  canonicalFileName,
  suggestSimilarNames,
  formatMissingPathHint,
  discoverScopedInstructions,
  formatScopedInstructionsBlock,
} = require('../codex/opencode-coding-intel');

const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_CHARS = 2_000;
const BINARY_SNIFF_BYTES = 8_192;
const MAX_MULTI_EDITS = 32;
const MAX_MULTI_FILES = 16;
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.7z', '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.pyc', '.woff', '.woff2', '.bin', '.dat',
]);

// Track surfaced scoped instruction files per session (or workspace) so each
// nested AGENTS.md/CLAUDE.md is injected once cleanly without repetition.
const scopedInstructionsSeen = new WeakMap();

function seenInstructionsFor(ctx, workspace) {
  const key = (ctx && ctx.session && typeof ctx.session === 'object') ? ctx.session : workspace;
  if (!key || typeof key !== 'object') return new Set();
  let set = scopedInstructionsSeen.get(key);
  if (!set) {
    set = new Set();
    scopedInstructionsSeen.set(key, set);
  }
  return set;
}

const ERRORS = Object.freeze({
  validation_path: 'path es obligatorio',
  validation_old: 'old_str es obligatorio',
  validation_identical: 'old_str y new_str son idénticos',
  path_traversal: 'ruta fuera del workspace',
  path_invalid: 'path inválido',
  not_a_file: 'no es un archivo',
  not_found: 'archivo no encontrado',
  file_too_large: 'archivo demasiado grande',
  binary: 'no se puede leer un archivo binario',
  offset_range: 'offset fuera de rango',
  edit_miss: 'old_str no aparece en el archivo',
  edit_ambiguous: 'old_str aparece más de una vez',
  read_failed: 'no se pudo leer el archivo',
  write_failed: 'no se pudo escribir el archivo',
  edit_failed: 'no se pudo editar el archivo',
  validation_edits: 'edits debe ser una lista',
  validation_edits_empty: 'edits no puede estar vacía',
  validation_edits_limit: 'demasiadas ediciones en el lote',
  validation_files_limit: 'demasiados archivos en el lote',
  multiedit_failed: 'no se pudo aplicar el lote',
  multiedit_partial: 'el lote no se aplicó; se restauraron los archivos',
  file_changed: 'El archivo cambió. Léelo de nuevo antes de editarlo.',
});

function cap(text) {
  return truncateToolResult(text).content;
}

function toolError(code, message, extra = {}) {
  const hint = typeof extra.hint === 'string' && extra.hint.trim() ? extra.hint.trim() : '';
  const content = hint ? `ERROR: ${message}\n\n${hint}` : `ERROR: ${message}`;
  const out = { ok: false, code, error: message, content };
  if (hint) out.hint = hint;
  if (Array.isArray(extra.suggestions) && extra.suggestions.length) {
    out.suggestions = extra.suggestions;
  }
  return out;
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
}

function pickPath(args) {
  return String((args && (args.path || args.filePath || args.file_path || args.filename)) || '').trim();
}

function pickContent(args) {
  if (!args) return '';
  if (args.content != null) return String(args.content);
  if (args.contents != null) return String(args.contents);
  return '';
}

function looksBinary(buf, relPath) {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  if (!buf || !buf.length) return false;
  const slice = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  if (slice.includes(0)) return true;
  let control = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const b = slice[i];
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  return control / slice.length > 0.3;
}

function normalizeNewlines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function detectLineEnding(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function applyLineEnding(text, ending) {
  const unix = normalizeNewlines(text);
  return ending === '\r\n' ? unix.replace(/\n/g, '\r\n') : unix;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
    if (needle.length === 0) break;
  }
  return count;
}

function replaceUnique(haystack, oldStr, newStr, { replaceAll = false } = {}) {
  if (oldStr === newStr) {
    const err = new Error(ERRORS.validation_identical);
    err.code = 'validation';
    throw err;
  }
  if (!oldStr) {
    const err = new Error(ERRORS.validation_old);
    err.code = 'validation';
    throw err;
  }
  const first = haystack.indexOf(oldStr);
  if (first === -1) {
    const err = new Error(ERRORS.edit_miss);
    err.code = 'edit_miss';
    throw err;
  }
  if (replaceAll) {
    let out = '';
    let from = 0;
    let next = first;
    while (next !== -1) {
      out += haystack.slice(from, next) + newStr;
      from = next + oldStr.length;
      next = haystack.indexOf(oldStr, from);
    }
    return out + haystack.slice(from);
  }
  const second = haystack.indexOf(oldStr, first + 1);
  if (second !== -1) {
    const err = new Error(ERRORS.edit_ambiguous);
    err.code = 'edit_ambiguous';
    throw err;
  }
  return haystack.slice(0, first) + newStr + haystack.slice(first + oldStr.length);
}

/**
 * Applies a single edit using the graduated OpenCode ladder (exact →
 * crlf-normalized → unicode-normalized → trailing-ws → line-trimmed with LCS
 * line-ending preservation), rejecting identical/empty/ambiguous edits and
 * attaching an actionable Spanish missHint on miss.
 */
function applyGraduatedEdit(current, oldStr, newStr, { replaceAll = false } = {}) {
  if (oldStr === newStr) {
    const err = new Error(ERRORS.validation_identical);
    err.code = 'validation';
    throw err;
  }
  if (!oldStr) {
    const err = new Error(ERRORS.validation_old);
    err.code = 'validation';
    throw err;
  }
  const res = applyEdit(current, oldStr, newStr, { replaceAll });
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      const err = new Error(ERRORS.edit_ambiguous);
      err.code = 'edit_ambiguous';
      throw err;
    }
    const err = new Error(ERRORS.edit_miss);
    err.code = 'edit_miss';
    if (res.hint) err.hint = res.hint;
    throw err;
  }
  return {
    text: res.next,
    replacements: res.occurrences,
    strategy: res.strategy,
  };
}

function formatReadOutput(lines, { offset, totalLines, truncated, cut }) {
  const start = offset;
  const numbered = lines.map((line, i) => {
    const body = line.length > MAX_LINE_CHARS
      ? `${line.slice(0, MAX_LINE_CHARS)}…`
      : line;
    return `Línea ${start + i}: ${body}`;
  });
  const last = start + Math.max(0, lines.length) - 1;
  if (cut) {
    numbered.push('');
    numbered.push('(Salida limitada por tamaño. Usa offset y limit para leer por partes.)');
  } else if (truncated) {
    numbered.push('');
    numbered.push(`(Mostrando líneas ${start}-${last} de ${totalLines}. Usa offset=${last + 1} para continuar.)`);
  }
  return numbered.join('\n');
}

function mapFsError(err, fallbackCode, fallbackMessage) {
  if (!err) return toolError(fallbackCode, fallbackMessage);
  const extra = err.hint ? { hint: err.hint } : {};
  if (err.code === 'ENOENT') return toolError('not_found', ERRORS.not_found, extra);
  if (err.code === 'EISDIR') return toolError('not_a_file', ERRORS.not_a_file, extra);
  if (ERRORS[err.code]) return toolError(err.code, err.message || ERRORS[err.code], extra);
  return toolError(err.code || fallbackCode, err.message || fallbackMessage, extra);
}

async function resolveTarget(workspace, relPath) {
  const rel = String(relPath || '').trim();
  if (!rel) {
    const err = new Error(ERRORS.validation_path);
    err.code = 'validation';
    throw err;
  }
  if (typeof workspace.resolveSafe === 'function') {
    return workspace.resolveSafe(rel);
  }
  return jailRealPath(workspace.root, rel);
}

async function findCanonicalAlternate(workspace, abs) {
  const dir = path.dirname(abs);
  if (!isInsideRoot(workspace.root, dir)) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const wanted = canonicalFileName(path.basename(abs));
  const matches = entries.filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && canonicalFileName(entry.name) === wanted,
  );
  if (matches.length !== 1) return null;
  const relDir = path.relative(workspace.root, dir).replace(/\\/g, '/');
  const altRel = relDir && relDir !== '.' ? `${relDir}/${matches[0].name}` : matches[0].name;
  try {
    return { rel: altRel, abs: await resolveTarget(workspace, altRel) };
  } catch {
    return null;
  }
}

async function diagnoseMissingWorkspaceFile(workspace, abs, requestedRel) {
  const root = path.resolve(workspace.root);
  const relPosix = String(requestedRel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  const parentAbs = path.dirname(abs);
  const base = path.basename(abs);

  const readDirNames = async (dirAbs) => {
    if (!isInsideRoot(root, dirAbs)) return null;
    try {
      const entries = await fs.readdir(dirAbs, { withFileTypes: true });
      return entries.filter((e) => e.name && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return null;
    }
  };

  const siblings = await readDirNames(parentAbs);
  if (siblings !== null) {
    const similar = suggestSimilarNames(siblings, base, 3);
    const dirRel = path.posix.dirname(relPosix);
    const suggestions = similar.map((entry) => (dirRel && dirRel !== '.' ? `${dirRel}/${entry}` : entry));
    return {
      suggestions,
      hint: formatMissingPathHint({ suggestions }),
    };
  }

  // Parent directory does not exist: walk upward within the workspace jail.
  let childAbs = parentAbs;
  let ancestorAbs = path.dirname(childAbs);
  while (ancestorAbs !== childAbs && isInsideRoot(root, ancestorAbs)) {
    // eslint-disable-next-line no-await-in-loop
    const entries = await readDirNames(ancestorAbs);
    if (entries !== null) {
      const missingRel = path.relative(root, childAbs).replace(/\\/g, '/') || '.';
      const nearestRel = path.relative(root, ancestorAbs).replace(/\\/g, '/') || '.';
      const similar = suggestSimilarNames(entries, path.basename(childAbs), 3);
      const suggestions = similar.map((entry) => (nearestRel !== '.' ? `${nearestRel}/${entry}` : entry));
      return {
        suggestions,
        hint: formatMissingPathHint({
          missingFolder: missingRel,
          nearestFolder: nearestRel,
          suggestions,
        }),
      };
    }
    if (ancestorAbs === root) break;
    childAbs = ancestorAbs;
    ancestorAbs = path.dirname(childAbs);
  }

  return { suggestions: [], hint: '' };
}

async function runRead(workspace, args, ctx = {}) {
  const rel = pickPath(args);
  if (!rel) return toolError('validation', ERRORS.validation_path);
  try {
    let abs = await resolveTarget(workspace, rel);
    let effectiveRel = rel;
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const alternate = await findCanonicalAlternate(workspace, abs);
        if (alternate) {
          abs = alternate.abs;
          effectiveRel = alternate.rel;
          st = await fs.lstat(abs);
        } else {
          const diag = await diagnoseMissingWorkspaceFile(workspace, abs, rel);
          return toolError('not_found', ERRORS.not_found, diag);
        }
      } else {
        return mapFsError(err, 'not_found', ERRORS.not_found);
      }
    }
    if (st.isSymbolicLink()) {
      // resolveTarget already followed and jailed; lstat of the final path
      // should be the real file. A leftover link is still refused if it
      // points nowhere or outside — jailRealPath throws path_traversal.
      st = await fs.stat(abs);
    }
    if (st.isDirectory()) return toolError('not_a_file', ERRORS.not_a_file);
    if (!st.isFile()) return toolError('not_a_file', ERRORS.not_a_file);
    if (st.size > MAX_FILE_BYTES) return toolError('file_too_large', ERRORS.file_too_large);

    const buf = await fs.readFile(abs);
    if (looksBinary(buf, effectiveRel)) return toolError('binary', ERRORS.binary);

    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    const totalLines = allLines.length;
    const rawOffset = Number(args && args.offset);
    const rawLimit = Number(args && args.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 1;
    const explicitLimit = Number.isFinite(rawLimit) && rawLimit > 0;
    const limit = explicitLimit ? Math.floor(rawLimit) : DEFAULT_READ_LIMIT;
    if (offset > totalLines && totalLines > 0) {
      return toolError('offset_range', `${ERRORS.offset_range} (${offset} > ${totalLines} líneas)`);
    }
    const start = offset - 1;
    const slice = allLines.slice(start, start + limit);
    const truncated = start + slice.length < totalLines;
    let content = formatReadOutput(slice, {
      offset,
      totalLines,
      truncated,
      cut: false,
    });
    const saved = path.relative(workspace.root, abs).replace(/\\/g, '/') || effectiveRel;

    // Best-effort hierarchical AGENTS.md / CLAUDE.md discovery (OpenCode read.ts).
    let scopedPaths = [];
    try {
      const discovered = await discoverScopedInstructions({
        targetRelPath: saved,
        seenSet: seenInstructionsFor(ctx, workspace),
        readFile: async (candidate) => {
          const candAbs = await resolveTarget(workspace, candidate);
          const candStat = await fs.lstat(candAbs);
          if (candStat.isSymbolicLink() || !candStat.isFile() || candStat.size > MAX_FILE_BYTES) return null;
          return fs.readFile(candAbs, 'utf8');
        },
      });
      if (discovered.length > 0) {
        scopedPaths = discovered.map((item) => item.path);
        content = `${content}\n\n${formatScopedInstructionsBlock(discovered)}`;
      }
    } catch {
      // Discovery failures never fail a read.
    }

    return toolOk(content, {
      path: saved,
      text,
      offset,
      limit: slice.length,
      totalLines,
      truncated,
      ...(scopedPaths.length ? { scopedInstructions: scopedPaths } : {}),
    });
  } catch (err) {
    return mapFsError(err, 'read_failed', ERRORS.read_failed);
  }
}

async function runWrite(workspace, args) {
  const rel = pickPath(args);
  if (!rel) return toolError('validation', ERRORS.validation_path);
  const text = pickContent(args);
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return toolError('file_too_large', ERRORS.file_too_large);
  }
  try {
    await resolveTarget(workspace, rel);
    const saved = await workspace.writeFile(rel, text);
    return toolOk(`wrote ${saved}`, { path: saved, text });
  } catch (err) {
    return mapFsError(err, 'write_failed', ERRORS.write_failed);
  }
}

async function runEdit(workspace, args) {
  const rel = pickPath(args);
  const oldRaw = args && (args.old_str != null ? args.old_str : args.oldString);
  const newRaw = args && (args.new_str != null
    ? args.new_str
    : (args.newString != null ? args.newString : args.content));
  const replaceAll = Boolean(args && (args.replaceAll === true || args.replace_all === true));
  if (!rel) return toolError('validation', ERRORS.validation_path);
  if (oldRaw == null || String(oldRaw) === '') {
    return toolError('validation', ERRORS.validation_old);
  }
  const oldStr = String(oldRaw);
  const newStr = String(newRaw == null ? '' : newRaw);
  if (oldStr === newStr) {
    return toolError('validation', ERRORS.validation_identical);
  }
  try {
    const { content: current, bytes } = await workspace.readFileForMutation(rel);
    const applied = applyGraduatedEdit(current, oldStr, newStr, { replaceAll });
    if (Buffer.byteLength(applied.text, 'utf8') > MAX_FILE_BYTES) {
      return toolError('file_too_large', ERRORS.file_too_large);
    }
    const saved = await workspace.writeFileIfUnchanged(rel, applied.text, bytes);
    return toolOk(`edited ${saved}`, {
      path: saved,
      text: applied.text,
      replaceAll,
      replacements: applied.replacements,
      strategy: applied.strategy,
    });
  } catch (err) {
    return mapFsError(err, 'edit_failed', ERRORS.edit_failed);
  }
}

function pickEditPath(item, fallback) {
  return String((item && (item.path || item.filePath || item.file_path || item.filename))
    || fallback
    || '').trim();
}

function pickOldNew(item) {
  const oldRaw = item && (item.old_str != null
    ? item.old_str
    : (item.oldString != null ? item.oldString : item.old));
  const newRaw = item && (item.new_str != null
    ? item.new_str
    : (item.newString != null
      ? item.newString
      : (item.content != null ? item.content : item.new)));
  return {
    oldRaw,
    newRaw: newRaw == null ? '' : newRaw,
    replaceAll: Boolean(item && (item.replaceAll === true || item.replace_all === true)),
  };
}

function normalizeEdits(args) {
  const fallbackPath = pickPath(args);
  const raw = args && (args.edits || args.changes || args.replacements);
  if (raw == null) {
    return { ok: false, code: 'validation', error: ERRORS.validation_edits };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'validation', error: ERRORS.validation_edits };
  }
  if (!raw.length) {
    return { ok: false, code: 'validation', error: ERRORS.validation_edits_empty };
  }
  if (raw.length > MAX_MULTI_EDITS) {
    return { ok: false, code: 'validation', error: ERRORS.validation_edits_limit };
  }
  const edits = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] || {};
    const rel = pickEditPath(item, fallbackPath);
    const pair = pickOldNew(item);
    if (!rel) return { ok: false, code: 'validation', error: ERRORS.validation_path };
    if (pair.oldRaw == null || String(pair.oldRaw) === '') {
      return { ok: false, code: 'validation', error: ERRORS.validation_old };
    }
    edits.push({
      path: rel,
      old_str: String(pair.oldRaw),
      new_str: String(pair.newRaw),
      replaceAll: pair.replaceAll,
      index: i,
    });
  }
  const files = new Set(edits.map((item) => item.path));
  if (files.size > MAX_MULTI_FILES) {
    return { ok: false, code: 'validation', error: ERRORS.validation_files_limit };
  }
  return { ok: true, edits };
}

function applyEditsInMemory(current, edits) {
  let next = current;
  let replacements = 0;
  for (const edit of edits) {
    const applied = applyGraduatedEdit(next, edit.old_str, edit.new_str, { replaceAll: edit.replaceAll });
    next = applied.text;
    replacements += applied.replacements;
  }
  return { text: next, replacements };
}

async function snapshotForEdit(workspace, rel) {
  if (typeof workspace.readFileForMutation === 'function') {
    return workspace.readFileForMutation(rel);
  }
  const content = await workspace.readFile(rel);
  return { content, bytes: Buffer.from(content, 'utf8') };
}

async function commitIfUnchanged(workspace, rel, next, expected) {
  if (typeof workspace.writeFileIfUnchanged === 'function') {
    return workspace.writeFileIfUnchanged(rel, next, expected);
  }
  return workspace.writeFile(rel, next);
}

async function restoreIfUnchanged(workspace, rel, original, writtenText) {
  const writtenBytes = Buffer.from(writtenText, 'utf8');
  try {
    await commitIfUnchanged(workspace, rel, original, writtenBytes);
  } catch {
    // Another writer won after our commit; do not clobber newer bytes.
  }
}

async function runMultiedit(workspace, args) {
  const normalized = normalizeEdits(args || {});
  if (!normalized.ok) return toolError(normalized.code, normalized.error);
  const byFile = new Map();
  for (const edit of normalized.edits) {
    const list = byFile.get(edit.path) || [];
    list.push(edit);
    byFile.set(edit.path, list);
  }

  const planned = [];
  try {
    for (const [rel, fileEdits] of byFile) {
      await resolveTarget(workspace, rel);
      const snapshot = await snapshotForEdit(workspace, rel);
      const applied = applyEditsInMemory(snapshot.content, fileEdits);
      if (Buffer.byteLength(applied.text, 'utf8') > MAX_FILE_BYTES) {
        return toolError('file_too_large', ERRORS.file_too_large);
      }
      planned.push({
        path: rel,
        original: snapshot.content,
        expected: snapshot.bytes,
        text: applied.text,
        replacements: applied.replacements,
      });
    }
  } catch (err) {
    return mapFsError(err, 'multiedit_failed', ERRORS.multiedit_failed);
  }

  const written = [];
  try {
    for (const file of planned) {
      const saved = await commitIfUnchanged(workspace, file.path, file.text, file.expected);
      written.push({ ...file, path: saved });
    }
  } catch (err) {
    for (const file of written) {
      await restoreIfUnchanged(workspace, file.path, file.original, file.text);
    }
    const mapped = mapFsError(err, 'multiedit_failed', ERRORS.multiedit_failed);
    return { ...mapped, code: written.length ? 'multiedit_partial' : mapped.code };
  }

  const total = written.reduce((sum, file) => sum + file.replacements, 0);
  const names = written.map((file) => file.path).join(', ');
  return toolOk(`editados ${names} (${total} reemplazo${total === 1 ? '' : 's'})`, {
    paths: written.map((file) => file.path),
    files: written.map((file) => ({
      path: file.path,
      replacements: file.replacements,
    })),
    replacements: total,
    edits: normalized.edits.length,
  });
}

module.exports = {
  DEFAULT_READ_LIMIT,
  MAX_LINE_CHARS,
  BINARY_SNIFF_BYTES,
  BINARY_EXTS,
  MAX_MULTI_EDITS,
  MAX_MULTI_FILES,
  ERRORS,
  looksBinary,
  countOccurrences,
  replaceUnique,
  applyGraduatedEdit,
  formatReadOutput,
  normalizeEdits,
  applyEditsInMemory,
  runRead,
  runWrite,
  runEdit,
  runMultiedit,
};
