'use strict';

/**
 * Workspace-jailed read / write / edit for SiraCode.
 *
 * Contract inspired by OpenCode file tools (anomalyco/opencode, MIT):
 * read(path, offset, limit), write(path, content), edit(path, old_str, new_str)
 * plus batched `multiedit` (edits[] applied atomically inside the jail).
 * Unique occurrence, size caps, binary reject, path jail. Native
 * CommonJS — not a copy of vendor/opencode read.ts / write.ts / edit.ts.
 * No Effect, no LSP, no Snapshot, no OpenRouter.
 */

const fs = require('fs/promises');
const path = require('path');
const { jailRealPath, MAX_FILE_BYTES } = require('./workspace');
const { truncateToolResult } = require('./tool-result');

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
});

function cap(text) {
  return truncateToolResult(text).content;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
}

function pickPath(args) {
  return String((args && (args.path || args.filePath || args.filename)) || '').trim();
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
  const second = haystack.indexOf(oldStr, first + oldStr.length);
  if (second !== -1) {
    const err = new Error(ERRORS.edit_ambiguous);
    err.code = 'edit_ambiguous';
    throw err;
  }
  return haystack.slice(0, first) + newStr + haystack.slice(first + oldStr.length);
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
  if (err.code === 'ENOENT') return toolError('not_found', ERRORS.not_found);
  if (err.code === 'EISDIR') return toolError('not_a_file', ERRORS.not_a_file);
  if (ERRORS[err.code]) return toolError(err.code, err.message || ERRORS[err.code]);
  return toolError(err.code || fallbackCode, err.message || fallbackMessage);
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

async function runRead(workspace, args) {
  const rel = pickPath(args);
  if (!rel) return toolError('validation', ERRORS.validation_path);
  try {
    const abs = await resolveTarget(workspace, rel);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      return mapFsError(err, 'not_found', ERRORS.not_found);
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
    if (looksBinary(buf, rel)) return toolError('binary', ERRORS.binary);

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
    const content = formatReadOutput(slice, {
      offset,
      totalLines,
      truncated,
      cut: false,
    });
    const saved = path.relative(workspace.root, abs).replace(/\\/g, '/') || rel;
    return toolOk(content, {
      path: saved,
      text,
      offset,
      limit: slice.length,
      totalLines,
      truncated,
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
  try {
    const current = await workspace.readFile(rel);
    const ending = detectLineEnding(current);
    const needle = applyLineEnding(oldStr, ending);
    const replacement = applyLineEnding(newStr, ending);
    const next = replaceUnique(current, needle, replacement, { replaceAll });
    if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
      return toolError('file_too_large', ERRORS.file_too_large);
    }
    const saved = await workspace.writeFile(rel, next);
    return toolOk(`edited ${saved}`, {
      path: saved,
      text: next,
      replaceAll,
      replacements: replaceAll ? countOccurrences(current, needle) : 1,
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
  const ending = detectLineEnding(current);
  let next = current;
  let replacements = 0;
  for (const edit of edits) {
    const needle = applyLineEnding(edit.old_str, ending);
    const replacement = applyLineEnding(edit.new_str, ending);
    const before = next;
    next = replaceUnique(next, needle, replacement, { replaceAll: edit.replaceAll });
    replacements += edit.replaceAll ? countOccurrences(before, needle) : 1;
  }
  return { text: next, replacements };
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
      const current = await workspace.readFile(rel);
      const applied = applyEditsInMemory(current, fileEdits);
      if (Buffer.byteLength(applied.text, 'utf8') > MAX_FILE_BYTES) {
        return toolError('file_too_large', ERRORS.file_too_large);
      }
      planned.push({
        path: rel,
        original: current,
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
      const saved = await workspace.writeFile(file.path, file.text);
      written.push({ ...file, path: saved });
    }
  } catch (err) {
    for (const file of written) {
      try {
        await workspace.writeFile(file.path, file.original);
      } catch {
        // best-effort restore; the batch still fails
      }
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
  formatReadOutput,
  normalizeEdits,
  applyEditsInMemory,
  runRead,
  runWrite,
  runEdit,
  runMultiedit,
};
