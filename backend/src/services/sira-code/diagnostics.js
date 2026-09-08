'use strict';

/**
 * Workspace-jailed diagnostics summary for SiraCode.
 *
 * Contract inspired by OpenCode LSP.Diagnostic.pretty / report
 * (anomalyco/opencode, MIT): severity labels ERROR/WARN/INFO/HINT,
 * 1-based [line:col], per-file cap, `<diagnostics file="…">` blocks.
 * Native CommonJS — not a copy of vendor/opencode/src/lsp/diagnostic.ts
 * or the Effect LSP client. No OpenRouter.
 *
 * Optional injectable runner (`ctx.diagnosticsRunner` / `ctx.runner`)
 * so tests and later LSP hosts supply issues without spawning a server.
 * The default runner is an in-process syntax pass (JSON + JS).
 */

const fs = require('fs/promises');
const path = require('path');
const { compileFunction } = require('node:vm');
const { jailPath, jailRealPath, isInsideRoot, SKIP_DIRS, MAX_FILE_BYTES } = require('./workspace');
const { truncateToolResult } = require('./tool-result');
const { FORBIDDEN_DISPLAY } = require('./display');

const SEVERITY_LABEL = Object.freeze({
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'HINT',
});

const SEVERITY_FROM_NAME = Object.freeze({
  error: 1,
  errors: 1,
  err: 1,
  warn: 2,
  warning: 2,
  warnings: 2,
  info: 3,
  information: 3,
  hint: 4,
  hints: 4,
  all: 0,
});

const MAX_PER_FILE = 20;
const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 200;
const MAX_FILES_IN_OUTPUT = 40;
const MAX_WALK_FILES = 400;
const MAX_WALK_DEPTH = 12;
const MAX_MESSAGE_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;
const BINARY_SNIFF_BYTES = 8_192;
const SYNTAX_EXTS = new Set(['.json', '.js', '.cjs', '.mjs']);

const ERRORS = Object.freeze({
  path_traversal: 'ruta fuera del workspace',
  path_invalid: 'path inválido',
  path_not_found: 'ruta no encontrada',
  not_a_file: 'no es un archivo',
  runner_failed: 'el runner de diagnósticos falló',
  runner_shape: 'el runner debe devolver una lista o un mapa de diagnósticos',
  aborted: 'diagnósticos cancelados',
  timeout: 'los diagnósticos superaron el tiempo máximo',
  failed: 'no se pudieron leer los diagnósticos',
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

function toPosix(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
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

function makeDeadline(opts = {}) {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const started = now();
  const signal = opts.signal;
  return {
    timeoutMs,
    check() {
      if (signal && signal.aborted) {
        const err = new Error(ERRORS.aborted);
        err.code = 'aborted';
        throw err;
      }
      if (now() - started >= timeoutMs) {
        const err = new Error(ERRORS.timeout);
        err.code = 'timeout';
        throw err;
      }
    },
  };
}

function normalizeSeverity(value, fallback = 1) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    return n >= 1 && n <= 4 ? n : fallback;
  }
  const key = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SEVERITY_FROM_NAME, key)) {
    const mapped = SEVERITY_FROM_NAME[key];
    return mapped === 0 ? fallback : mapped;
  }
  return fallback;
}

function minSeverityFromFilter(raw) {
  if (raw == null || raw === '') return 0;
  const key = String(raw).trim().toLowerCase();
  if (key === 'all') return 0;
  if (Object.prototype.hasOwnProperty.call(SEVERITY_FROM_NAME, key)) {
    return SEVERITY_FROM_NAME[key];
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 4) return Math.floor(n);
  return 0;
}

function sanitizeMessage(text) {
  let out = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!out) return 'diagnóstico';
  if (FORBIDDEN_DISPLAY.test(out)) {
    out = out.replace(FORBIDDEN_DISPLAY, 'Modelo');
  }
  if (out.length > MAX_MESSAGE_CHARS) out = `${out.slice(0, MAX_MESSAGE_CHARS)}…`;
  return out;
}

function offsetToLineCol(text, offset) {
  const safe = Math.max(0, Math.min(Number(offset) || 0, String(text || '').length));
  const slice = String(text || '').slice(0, safe);
  const lines = slice.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function parseSyntaxLocation(err, text) {
  const msg = String((err && err.message) || '');
  const paren = msg.match(/\((\d+):(\d+)\)/);
  if (paren) return { line: Number(paren[1]), col: Number(paren[2]) };
  const pos = msg.match(/position\s+(\d+)/i);
  if (pos && text != null) return offsetToLineCol(text, Number(pos[1]));
  const stack = String((err && err.stack) || '');
  const fileLine = stack.match(/:(\d+)(?::(\d+))?/);
  if (fileLine) return { line: Number(fileLine[1]), col: Number(fileLine[2] || 1) };
  return { line: 1, col: 1 };
}

function pretty(diagnostic) {
  const severity = SEVERITY_LABEL[normalizeSeverity(diagnostic && diagnostic.severity)] || 'ERROR';
  const line = Math.max(1, Number(diagnostic && diagnostic.line) || 1);
  const col = Math.max(1, Number(diagnostic && diagnostic.col) || 1);
  return `${severity} [${line}:${col}] ${sanitizeMessage(diagnostic && diagnostic.message)}`;
}

function reportFile(file, issues, { errorsOnly = false } = {}) {
  const filtered = (Array.isArray(issues) ? issues : [])
    .filter((item) => !errorsOnly || normalizeSeverity(item.severity) === 1);
  if (!filtered.length) return '';
  const limited = filtered.slice(0, MAX_PER_FILE);
  const more = filtered.length - MAX_PER_FILE;
  const suffix = more > 0 ? `\n... y ${more} más` : '';
  return `<diagnostics file="${toPosix(file)}">\n${limited.map(pretty).join('\n')}${suffix}\n</diagnostics>`;
}

function countBySeverity(items) {
  const counts = { errors: 0, warnings: 0, infos: 0, hints: 0 };
  for (const item of items) {
    const sev = normalizeSeverity(item.severity);
    if (sev === 1) counts.errors += 1;
    else if (sev === 2) counts.warnings += 1;
    else if (sev === 3) counts.infos += 1;
    else counts.hints += 1;
  }
  return counts;
}

function formatCountPart(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatSummaryHeader(items, fileCount) {
  if (!items.length) return 'Sin diagnósticos';
  const counts = countBySeverity(items);
  const parts = [];
  if (counts.errors) parts.push(formatCountPart(counts.errors, 'error', 'errores'));
  if (counts.warnings) parts.push(formatCountPart(counts.warnings, 'aviso', 'avisos'));
  if (counts.infos) parts.push(formatCountPart(counts.infos, 'info', 'infos'));
  if (counts.hints) parts.push(formatCountPart(counts.hints, 'pista', 'pistas'));
  const files = formatCountPart(fileCount, 'archivo', 'archivos');
  return `Se encontraron ${parts.join(', ')} en ${files}`;
}

function formatDiagnostics(items, { truncated = false, partial = false } = {}) {
  if (!items.length) return 'Sin diagnósticos';
  const byFile = new Map();
  for (const item of items) {
    const file = toPosix(item.path) || '.';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(item);
  }
  const files = [...byFile.keys()].slice(0, MAX_FILES_IN_OUTPUT);
  const lines = [formatSummaryHeader(items, byFile.size), ''];
  for (const file of files) {
    const block = reportFile(file, byFile.get(file));
    if (block) lines.push(block);
  }
  if (byFile.size > MAX_FILES_IN_OUTPUT) {
    lines.push(`... y ${byFile.size - MAX_FILES_IN_OUTPUT} archivos más`);
  }
  if (truncated) {
    lines.push('');
    lines.push('(Resultados truncados: se muestran los primeros diagnósticos. Usa path o severity para acotar.)');
  }
  if (partial) {
    lines.push('');
    lines.push('(Algunas rutas no se pudieron leer y se omitieron.)');
  }
  return lines.join('\n').trim();
}

function pathFromUriOrPath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.startsWith('file:')) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s.replace(/^file:\/\//, '');
    }
  }
  return s;
}

function relativizeInside(root, absOrRel) {
  const raw = pathFromUriOrPath(absOrRel);
  if (!raw) return null;
  const rootReal = path.resolve(root);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootReal, raw);
  if (!isInsideRoot(rootReal, abs)) return null;
  return toPosix(path.relative(rootReal, abs)) || path.basename(abs);
}

function normalizeDiagnostic(raw, fallbackPath, root) {
  if (!raw || typeof raw !== 'object') return null;
  const range = raw.range && raw.range.start ? raw.range.start : null;
  const line = range
    ? Number(range.line) + 1
    : Number(raw.line != null ? raw.line : raw.lineNumber);
  const col = range
    ? Number(range.character) + 1
    : Number(raw.col != null ? raw.col : (raw.column != null ? raw.column : raw.character));
  const sourcePath = raw.path || raw.file || raw.filePath || raw.uri || fallbackPath;
  const rel = relativizeInside(root, sourcePath) || relativizeInside(root, fallbackPath);
  if (!rel) return null;
  const message = sanitizeMessage(raw.message || raw.msg || raw.reason);
  return {
    path: rel,
    severity: normalizeSeverity(raw.severity != null ? raw.severity : raw.level),
    line: Number.isFinite(line) && line >= 1 ? Math.floor(line) : 1,
    col: Number.isFinite(col) && col >= 1 ? Math.floor(col) : 1,
    message,
    source: raw.source ? String(raw.source).slice(0, 40) : undefined,
    code: raw.code != null ? String(raw.code).slice(0, 40) : undefined,
  };
}

function coerceRunnerPayload(raw, root) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => normalizeDiagnostic(item, item && (item.path || item.file), root))
      .filter(Boolean);
  }
  if (typeof raw === 'object') {
    const out = [];
    for (const [file, issues] of Object.entries(raw)) {
      const list = Array.isArray(issues) ? issues : [];
      for (const item of list) {
        const diag = normalizeDiagnostic(item, file, root);
        if (diag) out.push(diag);
      }
    }
    return out;
  }
  const err = new Error(ERRORS.runner_shape);
  err.code = 'validation';
  throw err;
}

async function resolveTarget(workspace, relPath) {
  const root = workspace.root;
  const rel = String(relPath == null || relPath === '' ? '.' : relPath).trim() || '.';
  let abs;
  try {
    abs = await jailRealPath(root, rel);
  } catch (err) {
    if (err && (err.code === 'path_traversal' || err.code === 'path_invalid')) throw err;
    if (String(err && err.message || '').includes('fuera')) {
      const bad = new Error(ERRORS.path_traversal);
      bad.code = 'path_traversal';
      throw bad;
    }
    throw err;
  }
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const missing = new Error(ERRORS.path_not_found);
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
      const bad = new Error(ERRORS.path_traversal);
      bad.code = 'path_traversal';
      throw bad;
    }
    const rootReal = await fs.realpath(root).catch(() => path.resolve(root));
    if (!isInsideRoot(rootReal, real)) {
      const bad = new Error(ERRORS.path_traversal);
      bad.code = 'path_traversal';
      throw bad;
    }
    abs = real;
    st = await fs.stat(abs);
  }
  if (!st.isFile() && !st.isDirectory()) {
    const bad = new Error(ERRORS.not_a_file);
    bad.code = 'not_a_file';
    throw bad;
  }
  return {
    abs,
    rel: toPosix(path.relative(root, abs)) || '.',
    isFile: st.isFile(),
    isDir: st.isDirectory(),
  };
}

function looksBinary(buf) {
  const slice = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  return slice.includes(0);
}

function neutralizeModuleSyntax(src) {
  return String(src)
    .replace(/^\s*import\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\s*$/gm, ';')
    .replace(/^\s*export\s+\{[\s\S]*?\}\s*;?\s*$/gm, ';')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '');
}

function syntaxIssuesFor(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text);
      return [];
    } catch (err) {
      const loc = parseSyntaxLocation(err, text);
      return [{
        path: rel,
        severity: 1,
        line: loc.line,
        col: loc.col,
        message: sanitizeMessage(err.message),
        source: 'json',
      }];
    }
  }
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    try {
      compileFunction(neutralizeModuleSyntax(text), [], { filename: rel });
      return [];
    } catch (err) {
      const loc = parseSyntaxLocation(err, text);
      return [{
        path: rel,
        severity: 1,
        line: loc.line,
        col: loc.col,
        message: sanitizeMessage(err.message),
        source: 'syntax',
      }];
    }
  }
  return [];
}

async function defaultDiagnosticsRunner(workspace, target, deadline, opts = {}) {
  const items = [];
  let partial = false;
  const maxBytes = Number.isFinite(Number(opts.maxFileBytes)) && Number(opts.maxFileBytes) > 0
    ? Number(opts.maxFileBytes)
    : MAX_FILE_BYTES;

  const consider = async (rel, abs) => {
    deadline.check();
    const ext = path.extname(rel).toLowerCase();
    if (!SYNTAX_EXTS.has(ext)) return true;
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      partial = true;
      return true;
    }
    if (st.isSymbolicLink()) return true;
    if (!st.isFile() || st.size > maxBytes) {
      if (st.isFile() && st.size > maxBytes) partial = true;
      return true;
    }
    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      partial = true;
      return true;
    }
    if (looksBinary(buf)) {
      partial = true;
      return true;
    }
    items.push(...syntaxIssuesFor(rel, buf.toString('utf8')));
    return true;
  };

  if (target.isFile) {
    await consider(target.rel === '.' ? toPosix(path.basename(target.abs)) : target.rel, target.abs);
    return { items, partial };
  }

  let visited = 0;
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
    for (const entry of entries) {
      deadline.check();
      if (visited >= MAX_WALK_FILES) {
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
      if (!isInsideRoot(workspace.root, child)) continue;
      visited += 1;
      const rel = toPosix(path.relative(workspace.root, child));
      await consider(rel, child);
    }
  }

  await walk(target.abs, 0);
  return { items, partial };
}

function pickRunner(ctx = {}) {
  if (typeof ctx.diagnosticsRunner === 'function') return ctx.diagnosticsRunner;
  if (typeof ctx.runner === 'function') return ctx.runner;
  return null;
}

async function runDiagnostics(workspace, args = {}, ctx = {}) {
  const deadline = makeDeadline({
    timeoutMs: args.timeoutMs != null ? args.timeoutMs : ctx.timeoutMs,
    signal: ctx.signal,
    now: ctx.now,
  });
  const limit = clampLimit(args.limit);
  const minSeverity = minSeverityFromFilter(args.severity);

  let target;
  try {
    deadline.check();
    target = await resolveTarget(workspace, args.path);
  } catch (err) {
    return toolError(err.code || 'path_invalid', err.message || ERRORS.path_invalid);
  }

  let collected;
  let partial = false;
  const runner = pickRunner(ctx);
  try {
    deadline.check();
    if (runner) {
      let raw;
      try {
        raw = await runner({
          workspace,
          root: workspace.root,
          path: target.rel,
          target,
          signal: ctx.signal,
        });
      } catch (err) {
        if (err && (err.code === 'aborted' || err.code === 'timeout')) throw err;
        return toolError('runner_failed', ERRORS.runner_failed);
      }
      collected = coerceRunnerPayload(raw, workspace.root);
    } else {
      const scanned = await defaultDiagnosticsRunner(workspace, target, deadline, {
        maxFileBytes: ctx.maxFileBytes,
      });
      collected = scanned.items;
      partial = scanned.partial;
    }
  } catch (err) {
    return toolError(err.code || 'diagnostics_failed', err.message || ERRORS.failed);
  }

  const filtered = [];
  let truncated = false;
  for (const item of collected) {
    if (minSeverity > 0 && normalizeSeverity(item.severity) > minSeverity) continue;
    try {
      jailPath(workspace.root, item.path);
    } catch {
      continue;
    }
    filtered.push(item);
    if (filtered.length >= limit) {
      truncated = true;
      break;
    }
  }

  const counts = countBySeverity(filtered);
  const files = new Set(filtered.map((item) => item.path));
  return toolOk(formatDiagnostics(filtered, { truncated, partial }), {
    diagnostics: filtered,
    counts: { ...counts, files: files.size, total: filtered.length },
    truncated,
    partial,
    path: target.rel,
  });
}

module.exports = {
  SEVERITY_LABEL,
  MAX_PER_FILE,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_MESSAGE_CHARS,
  ERRORS,
  pretty,
  reportFile,
  formatDiagnostics,
  formatSummaryHeader,
  normalizeSeverity,
  minSeverityFromFilter,
  normalizeDiagnostic,
  coerceRunnerPayload,
  sanitizeMessage,
  offsetToLineCol,
  parseSyntaxLocation,
  neutralizeModuleSyntax,
  syntaxIssuesFor,
  runDiagnostics,
};
