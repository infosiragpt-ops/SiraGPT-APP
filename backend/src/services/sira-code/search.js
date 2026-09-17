'use strict';

/**
 * Workspace-jailed grep / glob for SiraCode.
 *
 * Contract inspired by OpenCode search leaves (anomalyco/opencode, MIT):
 * grep(pattern, path, include, limit) and glob(pattern, path, limit),
 * bounded results, line previews. Native CommonJS walker — not a copy of
 * vendor/opencode grep.ts / glob.ts / ripgrep.ts. No Effect, no rg binary,
 * no OpenRouter.
 */

const fs = require('fs/promises');
const path = require('path');
const { jailPath, SKIP_DIRS, MAX_FILE_BYTES } = require('./workspace');

const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 100;
const MAX_LINE_PREVIEW = 2_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_WALK_FILES = 2_000;
const MAX_WALK_DEPTH = 12;
const BINARY_SNIFF_BYTES = 8_192;
const GLOB_SHELL_CHARS = /[;&|`$]/;

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.floor(n));
}

function clampTimeout(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(n));
}

function toPosix(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isInsideRoot(root, abs) {
  const rootReal = path.resolve(root);
  const resolved = path.resolve(abs);
  return resolved === rootReal || resolved.startsWith(rootReal + path.sep);
}

function expandBracePatterns(pattern) {
  const raw = String(pattern || '');
  const found = raw.match(/\{([^{}]+)\}/);
  if (!found) return [raw];
  const [token, inner] = [found[0], found[1]];
  const variants = [];
  for (const part of inner.split(',')) {
    variants.push(...expandBracePatterns(raw.replace(token, part)));
  }
  return variants;
}

function globPieceToRegExp(pattern) {
  let pat = toPosix(pattern);
  if (!pat) return null;
  const hasSlash = pat.includes('/');
  if (!hasSlash && !pat.startsWith('**')) pat = `**/${pat}`;
  let body = '';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      body += '[^/]*';
    } else if (ch === '?') {
      body += '[^/]';
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${body}$`);
}

function compileGlob(pattern) {
  const variants = expandBracePatterns(String(pattern || '').trim());
  const regexes = [];
  for (const variant of variants) {
    const re = globPieceToRegExp(variant);
    if (re) regexes.push(re);
  }
  return regexes;
}

function matchGlob(relPath, pattern) {
  const target = toPosix(relPath);
  if (!target || !pattern) return false;
  return compileGlob(pattern).some((re) => re.test(target));
}

function assertPlainGlob(pattern) {
  if (GLOB_SHELL_CHARS.test(pattern)) {
    const err = new Error('el glob debe ser un patrón de archivos, no un comando');
    err.code = 'validation';
    throw err;
  }
}

function makeDeadline(opts = {}) {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const started = now();
  const signal = opts.signal;
  return {
    timeoutMs,
    check() {
      if (signal && signal.aborted) {
        const err = new Error('búsqueda cancelada');
        err.code = 'aborted';
        throw err;
      }
      if (now() - started >= timeoutMs) {
        const err = new Error('la búsqueda superó el tiempo máximo');
        err.code = 'timeout';
        throw err;
      }
    },
  };
}

async function resolveSearchRoot(workspace, relPath) {
  const root = workspace.root;
  const rel = String(relPath == null || relPath === '' ? '.' : relPath).trim() || '.';
  const abs = jailPath(root, rel);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const missing = new Error('ruta no encontrada');
      missing.code = 'path_not_found';
      throw missing;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      const bad = new Error('ruta fuera del workspace');
      bad.code = 'path_traversal';
      throw bad;
    }
    if (!isInsideRoot(root, real)) {
      const bad = new Error('ruta fuera del workspace');
      bad.code = 'path_traversal';
      throw bad;
    }
    st = await fs.stat(real);
    return { abs: real, rel: toPosix(path.relative(root, real)) || '.', isFile: st.isFile(), isDir: st.isDirectory() };
  }
  return {
    abs,
    rel: toPosix(path.relative(root, abs)) || '.',
    isFile: st.isFile(),
    isDir: st.isDirectory(),
  };
}

async function walkFiles(workspace, startAbs, opts, onFile) {
  const root = workspace.root;
  const deadline = opts.deadline;
  const maxFiles = Number.isFinite(Number(opts.maxWalkFiles)) ? Number(opts.maxWalkFiles) : MAX_WALK_FILES;
  let visited = 0;
  let partial = false;

  async function walk(dir, depth) {
    deadline.check();
    if (depth > MAX_WALK_DEPTH) {
      partial = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      partial = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      deadline.check();
      if (visited >= maxFiles) {
        partial = true;
        return;
      }
      if (!entry.name || entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isInsideRoot(root, child)) continue;
      visited += 1;
      const rel = toPosix(path.relative(root, child));
      const keepGoing = await onFile(rel, child);
      if (keepGoing === false) return;
    }
  }

  await walk(startAbs, 0);
  return { visited, partial };
}

function looksBinary(buf) {
  const slice = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  return slice.includes(0);
}

function previewLine(text) {
  const line = String(text == null ? '' : text).replace(/\r/g, '');
  if (line.length <= MAX_LINE_PREVIEW) return { text: line, truncated: false };
  return { text: `${line.slice(0, MAX_LINE_PREVIEW)}…`, truncated: true };
}

async function readSearchableFile(abs, maxBytes) {
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) return { skip: 'symlink' };
  if (!st.isFile()) return { skip: 'not_file' };
  if (st.size > maxBytes) return { skip: 'too_large' };
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) return { skip: 'binary' };
  return { text: buf.toString('utf8') };
}

function compileGrepRegex(pattern, ignoreCase) {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    const err = new Error('el patrón de búsqueda no es una expresión regular válida');
    err.code = 'validation';
    throw err;
  }
}

function formatGrepOutput(items, { truncated, partial }) {
  if (!items.length) return 'Sin coincidencias';
  const lines = [`Se encontraron ${items.length} coincidencias`];
  let current = '';
  for (const hit of items) {
    if (current !== hit.path) {
      if (current) lines.push('');
      current = hit.path;
      lines.push(`${hit.path}:`);
    }
    lines.push(`  Línea ${hit.line}: ${hit.text}`);
  }
  if (truncated) {
    lines.push('');
    lines.push('(Resultados truncados: se muestran las primeras coincidencias. Usa un path o patrón más específico.)');
  }
  if (partial) {
    lines.push('');
    lines.push('(Algunas rutas no se pudieron leer y se omitieron.)');
  }
  return lines.join('\n');
}

function formatGlobOutput(items, { truncated, partial }) {
  if (!items.length) return 'Sin archivos';
  const lines = items.map((item) => item.path);
  if (truncated) {
    lines.push('');
    lines.push('(Resultados truncados: se muestran los primeros archivos. Usa un path o patrón más específico.)');
  }
  if (partial) {
    lines.push('');
    lines.push('(El listado puede estar incompleto porque algunas rutas no se pudieron leer.)');
  }
  return lines.join('\n');
}

async function searchGrep(workspace, args = {}, ctx = {}) {
  const pattern = String(args.pattern || args.query || '');
  if (!pattern) return toolError('validation', 'el patrón es obligatorio');
  const include = String(args.include || args.glob || '').trim();
  if (include) {
    try {
      assertPlainGlob(include);
    } catch (err) {
      return toolError(err.code || 'validation', err.message);
    }
  }
  const limit = clampLimit(args.limit);
  const ignoreCase = args.ignoreCase === true || args.caseInsensitive === true;
  const maxBytes = Number.isFinite(Number(ctx.maxFileBytes)) && Number(ctx.maxFileBytes) > 0
    ? Number(ctx.maxFileBytes)
    : MAX_FILE_BYTES;
  let regex;
  try {
    regex = compileGrepRegex(pattern, ignoreCase);
  } catch (err) {
    return toolError(err.code || 'validation', err.message);
  }

  const deadline = makeDeadline({
    timeoutMs: args.timeoutMs != null ? args.timeoutMs : ctx.timeoutMs,
    signal: ctx.signal,
    now: ctx.now,
  });

  let target;
  try {
    deadline.check();
    target = await resolveSearchRoot(workspace, args.path);
  } catch (err) {
    return toolError(err.code || 'path_invalid', err.message || 'ruta inválida');
  }

  const items = [];
  let truncated = false;
  let partial = false;

  const consider = async (rel, abs) => {
    deadline.check();
    if (include && !matchGlob(rel, include)) return true;
    let read;
    try {
      read = await readSearchableFile(abs, maxBytes);
    } catch {
      partial = true;
      return true;
    }
    if (read.skip) {
      if (read.skip === 'too_large' || read.skip === 'binary') partial = true;
      return true;
    }
    const fileLines = read.text.split('\n');
    for (let i = 0; i < fileLines.length; i += 1) {
      deadline.check();
      regex.lastIndex = 0;
      if (!regex.test(fileLines[i])) continue;
      const preview = previewLine(fileLines[i]);
      items.push({
        path: rel,
        line: i + 1,
        text: preview.text,
        linePreviewTruncated: preview.truncated,
      });
      if (items.length >= limit) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  try {
    if (target.isFile) {
      const rel = target.rel === '.' ? toPosix(path.basename(target.abs)) : target.rel;
      await consider(rel, target.abs);
    } else if (target.isDir) {
      const walked = await walkFiles(workspace, target.abs, {
        deadline,
        maxWalkFiles: ctx.maxWalkFiles,
      }, consider);
      if (walked.partial) partial = true;
    } else {
      return toolError('not_a_file', 'no es un archivo ni un directorio');
    }
  } catch (err) {
    return toolError(err.code || 'search_failed', err.message || 'la búsqueda falló');
  }

  return {
    ok: true,
    content: formatGrepOutput(items, { truncated, partial }),
    items,
    truncated,
    partial,
    matches: items.length,
  };
}

async function searchGlob(workspace, args = {}, ctx = {}) {
  const pattern = String(args.pattern || args.glob || '').trim();
  if (!pattern) return toolError('validation', 'el patrón es obligatorio');
  try {
    assertPlainGlob(pattern);
  } catch (err) {
    return toolError(err.code || 'validation', err.message);
  }
  const limit = clampLimit(args.limit);
  const deadline = makeDeadline({
    timeoutMs: args.timeoutMs != null ? args.timeoutMs : ctx.timeoutMs,
    signal: ctx.signal,
    now: ctx.now,
  });

  let target;
  try {
    deadline.check();
    target = await resolveSearchRoot(workspace, args.path);
  } catch (err) {
    return toolError(err.code || 'path_invalid', err.message || 'ruta inválida');
  }
  if (target.isFile) {
    const rel = target.rel === '.' ? toPosix(path.basename(target.abs)) : target.rel;
    const items = matchGlob(rel, pattern) || matchGlob(path.basename(rel), pattern)
      ? [{ path: rel }]
      : [];
    return {
      ok: true,
      content: formatGlobOutput(items, { truncated: false, partial: false }),
      items,
      truncated: false,
      partial: false,
    };
  }
  if (!target.isDir) return toolError('not_a_directory', 'no es un directorio');

  const items = [];
  let truncated = false;
  let partial = false;
  try {
    const walked = await walkFiles(workspace, target.abs, {
      deadline,
      maxWalkFiles: ctx.maxWalkFiles,
    }, async (rel) => {
      if (!matchGlob(rel, pattern)) return true;
      items.push({ path: rel });
      if (items.length >= limit) {
        truncated = true;
        return false;
      }
      return true;
    });
    if (walked.partial) partial = true;
  } catch (err) {
    return toolError(err.code || 'search_failed', err.message || 'la búsqueda falló');
  }

  return {
    ok: true,
    content: formatGlobOutput(items, { truncated, partial }),
    items,
    truncated,
    partial,
  };
}

module.exports = {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_LINE_PREVIEW,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_WALK_FILES,
  compileGlob,
  matchGlob,
  expandBracePatterns,
  searchGrep,
  searchGlob,
};
