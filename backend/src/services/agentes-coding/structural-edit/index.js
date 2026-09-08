'use strict';

/**
 * agentes-coding/structural-edit — ast-grep pattern search/replace.
 *
 * Preview stays inside the coding-sandbox session jail. Apply writes
 * only through sandbox.writeFile after path-escape checks. The CLI is
 * never invoked with --update-all.
 *
 * MIT pattern from ast-grep/ast-grep. Thin Node wrapper + injectable
 * exec. No monorepo dump. Flag: AGENTES_CODING_V2 (default OFF).
 *
 * See docs/agentes-coding-struct-edit.md
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const {
  MAX_PATHS,
  MAX_MATCHES,
  MAX_FILE_BYTES,
  DEFAULT_TIMEOUT_MS,
  inferLang,
  normalizeLang,
  validatePattern,
  validateRewrite,
  skipPath,
  clampInt,
} = require('./patterns');
const { createSgRunner, buildSgArgv, parseSgJson } = require('./runner');

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

function jailReportedPath(rawPath) {
  return jailRelPath(rawPath);
}

function applyMatchesToText(original, matches) {
  const usable = (matches || []).filter((m) => typeof m.replacement === 'string');
  if (!usable.length) return original;
  const withRange = usable.filter((m) => Number.isInteger(m.start) && Number.isInteger(m.end) && m.end >= m.start);
  if (withRange.length === usable.length) {
    const sorted = [...withRange].sort((a, b) => b.start - a.start);
    let text = original;
    for (const m of sorted) {
      if (m.start > text.length || m.end > text.length) continue;
      text = `${text.slice(0, m.start)}${m.replacement}${text.slice(m.end)}`;
    }
    return text;
  }
  let text = original;
  for (const m of usable) {
    if (!m.text) continue;
    const idx = text.indexOf(m.text);
    if (idx < 0) continue;
    text = `${text.slice(0, idx)}${m.replacement}${text.slice(idx + m.text.length)}`;
  }
  return text;
}

function buildDiffs(fileContents, matches) {
  const byPath = new Map();
  for (const match of matches || []) {
    const rel = jailReportedPath(match.path);
    if (!byPath.has(rel)) byPath.set(rel, []);
    byPath.get(rel).push(match);
  }
  const diffs = [];
  for (const [rel, group] of byPath) {
    const original = fileContents.get(rel);
    if (typeof original !== 'string') continue;
    const proposed = applyMatchesToText(original, group);
    diffs.push({
      path: rel,
      original,
      proposed,
      matchCount: group.length,
      changed: proposed !== original,
    });
  }
  diffs.sort((a, b) => a.path.localeCompare(b.path));
  return diffs;
}

async function collectSessionFiles(sandbox, sessionId, opts = {}) {
  if (!sandbox || typeof sandbox.listFiles !== 'function' || typeof sandbox.readFile !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  const root = opts.path || '.';
  jailRelPath(root, { forList: true });
  const listed = await sandbox.listFiles(sessionId, root);
  const all = (listed || [])
    .map((f) => (typeof f === 'string' ? f : f && f.path))
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+/, ''))
    .filter((p) => p && !skipPath(p));

  const requested = Array.isArray(opts.paths) ? opts.paths : (opts.file ? [opts.file] : []);
  const wanted = new Set();
  for (const raw of requested) {
    wanted.add(jailRelPath(raw));
  }

  const lang = opts.lang ? normalizeLang(opts.lang) : null;
  const picked = [];
  for (const rel of all) {
    if (wanted.size && !wanted.has(rel)) continue;
    const fileLang = inferLang(rel, lang);
    if (!fileLang) continue;
    if (lang && fileLang !== lang && !(lang === 'javascript' && fileLang === 'javascript')) {
      if (lang === 'typescript' && fileLang === 'tsx') {
        /* tsx is accepted for typescript patterns */
      } else if (fileLang !== lang) {
        continue;
      }
    }
    picked.push({ path: rel, lang: fileLang });
    if (picked.length >= clampInt(opts.maxFiles, MAX_PATHS, 1, MAX_PATHS)) break;
  }
  if (wanted.size && !picked.length) {
    fail('E_PARAMS', 'No hay archivos válidos dentro de la sesión para el patrón.');
  }

  const files = [];
  const contents = new Map();
  for (const item of picked) {
    const buf = await sandbox.readFile(sessionId, item.path);
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    if (text.length > MAX_FILE_BYTES) continue;
    files.push({ path: item.path, content: text, lang: item.lang });
    contents.set(item.path, text);
  }
  return { files, contents, scanned: files.length };
}

function pickLang(files, explicit) {
  if (explicit) return normalizeLang(explicit);
  const first = files[0] && files[0].lang;
  return first || normalizeLang('javascript');
}

async function runPreview({ files, contents, pattern, rewrite, lang, runner, timeoutMs }) {
  const argv = buildSgArgv({
    pattern,
    rewrite,
    lang,
    paths: files.map((f) => f.path),
  });
  let result;
  try {
    result = await runner({
      pattern,
      rewrite,
      lang,
      paths: files.map((f) => f.path),
      files,
      cwd: undefined,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      argv,
    });
  } catch (err) {
    if (err instanceof CodingSandboxError) throw err;
    if (err && err.code === 'E_TIMEOUT') fail('E_TIMEOUT');
    fail('E_STRUCT_EDIT_FAILED', err && err.message ? String(err.message) : undefined);
  }
  const rawMatches = (result && result.matches) || [];
  if (rawMatches.length > MAX_MATCHES) fail('E_QUOTA', 'Demasiadas coincidencias estructurales.');
  const matches = rawMatches.map((m) => ({
    ...m,
    path: jailReportedPath(m.path),
  }));
  const diffs = rewrite != null && rewrite !== '' ? buildDiffs(contents, matches) : [];
  return {
    ok: true,
    matches,
    diffs,
    scanned: files.length,
    lang,
    pattern,
    rewrite: rewrite || undefined,
  };
}

async function previewSession(sandbox, sessionId, opts = {}) {
  const pattern = validatePattern(opts.pattern);
  const rewrite = validateRewrite(opts.rewrite);
  const { files, contents, scanned } = await collectSessionFiles(sandbox, sessionId, opts);
  if (!files.length) {
    return {
      ok: true,
      matches: [],
      diffs: [],
      scanned,
      lang: opts.lang ? normalizeLang(opts.lang) : undefined,
      pattern,
      rewrite: rewrite || undefined,
    };
  }
  const lang = pickLang(files, opts.lang);
  const runner = typeof opts.runner === 'function' ? opts.runner : createSgRunner({ env: opts.env, exec: opts.exec });
  return runPreview({
    files,
    contents,
    pattern,
    rewrite,
    lang,
    runner,
    timeoutMs: opts.timeoutMs,
  });
}

function normalizeIncomingDiffs(diffs) {
  if (!Array.isArray(diffs) || !diffs.length) {
    fail('E_PARAMS', 'Faltan las diferencias a aplicar.');
  }
  return diffs.map((d) => {
    if (!d || typeof d !== 'object') fail('E_PARAMS', 'Diferencia estructural inválida.');
    const path = jailRelPath(d.path);
    if (typeof d.proposed !== 'string') fail('E_PARAMS', 'Falta el texto propuesto.');
    return {
      path,
      original: typeof d.original === 'string' ? d.original : null,
      proposed: d.proposed,
    };
  });
}

async function applySession(sandbox, sessionId, opts = {}) {
  if (!sandbox || typeof sandbox.writeFile !== 'function' || typeof sandbox.readFile !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  let diffs;
  if (Array.isArray(opts.diffs) && opts.diffs.length) {
    diffs = normalizeIncomingDiffs(opts.diffs);
  } else if (opts.pattern && opts.rewrite != null) {
    const preview = await previewSession(sandbox, sessionId, opts);
    diffs = (preview.diffs || [])
      .filter((d) => d.changed)
      .map((d) => ({ path: d.path, original: d.original, proposed: d.proposed }));
    if (!diffs.length) {
      return { ok: true, applied: [], skipped: [] };
    }
  } else {
    fail('E_PARAMS', 'Indica diffs o un patrón con reescritura.');
  }

  const applied = [];
  const skipped = [];
  for (const diff of diffs) {
    const rel = jailRelPath(diff.path);
    let current;
    try {
      const buf = await sandbox.readFile(sessionId, rel);
      current = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    } catch (err) {
      if (err instanceof CodingSandboxError) throw err;
      fail('E_STRUCT_EDIT_FAILED', `No se pudo leer ${rel}.`);
    }
    if (diff.original != null && current !== diff.original) {
      fail('E_CONTENT', `El archivo ${rel} cambió desde la previsualización.`);
    }
    if (current === diff.proposed) {
      skipped.push({ path: rel, reason: 'unchanged' });
      continue;
    }
    const written = await sandbox.writeFile(sessionId, rel, diff.proposed);
    applied.push({ path: rel, bytes: written && written.bytes });
  }
  return { ok: true, applied, skipped };
}

async function previewForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return previewSession(sandbox, sessionId, { ...opts, env, runner: extras.runner, exec: extras.exec });
}

async function applyForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return applySession(sandbox, sessionId, { ...opts, env, runner: extras.runner, exec: extras.exec });
}

module.exports = {
  previewSession,
  applySession,
  previewForRequest,
  applyForRequest,
  requireEnabled,
  applyMatchesToText,
  buildDiffs,
  jailReportedPath,
  collectSessionFiles,
  createSgRunner,
  buildSgArgv,
  parseSgJson,
  CodingSandboxError,
};
