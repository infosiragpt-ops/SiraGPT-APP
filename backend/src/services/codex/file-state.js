'use strict';

const crypto = require('node:crypto');

const signalScopes = new WeakMap();
const runnerScopes = new WeakMap();
const fallbackScopes = new Map();

function normalizeWorkspacePath(path) {
  const value = String(path || '').replaceAll('\\', '/').trim();
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\0')) return null;
  const segments = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length ? segments.join('/') : null;
}

function fingerprint(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

class FileStateTracker {
  constructor() {
    this.snapshots = new Map();
  }

  markRead(path, content) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return null;
    const snapshot = {
      path: normalized,
      fingerprint: fingerprint(content),
      readAt: Date.now(),
    };
    this.snapshots.set(normalized, snapshot);
    return snapshot;
  }

  markWritten(path, content) {
    return this.markRead(path, content);
  }

  forget(path) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized) this.snapshots.delete(normalized);
  }

  checkEdit(path, currentContent) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return { ok: false, reason: 'unsafe_path' };
    const snapshot = this.snapshots.get(normalized);
    if (!snapshot) return { ok: false, reason: 'not_read', path: normalized };
    const currentFingerprint = fingerprint(currentContent);
    if (snapshot.fingerprint !== currentFingerprint) {
      return {
        ok: false,
        reason: 'changed_since_read',
        path: normalized,
        readFingerprint: snapshot.fingerprint,
        currentFingerprint,
      };
    }
    return { ok: true, path: normalized, snapshot };
  }

  clear() {
    this.snapshots.clear();
  }
}

function projectTracker(container, project) {
  const key = String(project || '');
  let tracker = container.get(key);
  if (!tracker) {
    tracker = new FileStateTracker();
    container.set(key, tracker);
  }
  return tracker;
}

function trackerForContext(ctx = {}) {
  if (ctx.fileStateTracker && typeof ctx.fileStateTracker.checkEdit === 'function') {
    return ctx.fileStateTracker;
  }
  if (ctx.signal && typeof ctx.signal === 'object') {
    let byProject = signalScopes.get(ctx.signal);
    if (!byProject) {
      byProject = new Map();
      signalScopes.set(ctx.signal, byProject);
    }
    return projectTracker(byProject, ctx.project);
  }
  if (ctx.runner && typeof ctx.runner === 'object') {
    let byProject = runnerScopes.get(ctx.runner);
    if (!byProject) {
      byProject = new Map();
      runnerScopes.set(ctx.runner, byProject);
    }
    return projectTracker(byProject, ctx.project);
  }
  return projectTracker(fallbackScopes, ctx.project);
}

function shouldEnforceFileState(ctx = {}) {
  return Boolean(
    ctx.fileStateTracker
    || ctx.signal
    || ctx.llmTurn
    || ctx.enforceFileState,
  );
}

function resetFileStateForTests() {
  fallbackScopes.clear();
}

// ---------------------------------------------------------------------------
// OT-11 (docs/code/claude-code-parity.md) — standalone tracker factory with
// instructive Spanish hints for the model, plus a dependency-free safe glob
// compiler. Additive API: the class-based exports above stay untouched.
// ---------------------------------------------------------------------------

const HINTS = {
  unsafe_path: (path) =>
    `La ruta "${path}" no es válida dentro del workspace. `
    + 'Usa una ruta relativa al proyecto (sin "/" inicial, sin ".." y sin unidad de disco), '
    + 'por ejemplo "src/app.ts".',
  not_read: (path) =>
    `Todavía no has leído "${path}" en esta sesión. `
    + 'Léelo primero con read_file antes de escribirlo o editarlo: '
    + 'así trabajas sobre el contenido real y evitas sobrescribir código que no conoces.',
  stale: (path) =>
    `El contenido de "${path}" cambió después de tu última lectura `
    + '(otro paso o subagente pudo modificarlo). '
    + 'Vuelve a leerlo con read_file y aplica tu edición sobre la versión actual del archivo.',
};

/**
 * createFileStateTracker() — read-before-write guard, Claude Code style.
 *
 * - recordRead(path, content): guarda el sha256 del contenido leído.
 * - assertWritable(path, currentContent): {ok:true} cuando el archivo fue
 *   leído y su contenido actual coincide con lo leído; si no,
 *   {ok:false, reason:'not_read'|'stale', hint} con un mensaje instructivo
 *   en español pensado para mostrarse al modelo.
 * - invalidate(path): olvida la lectura registrada (p. ej. tras un cambio externo).
 * - snapshot(): objeto plano { [path]: sha256hex } para logging/persistencia.
 */
function createFileStateTracker() {
  const tracker = new FileStateTracker();

  return {
    recordRead(path, content) {
      return tracker.markRead(path, content);
    },

    assertWritable(path, currentContent) {
      const state = tracker.checkEdit(path, currentContent);
      if (state.ok) return { ok: true };
      const shownPath = state.path || String(path || '');
      if (state.reason === 'unsafe_path') {
        // Fuera del contrato not_read|stale sólo queda la ruta inválida: se
        // reporta como not_read (nunca hubo lectura válida) con hint específico.
        return { ok: false, reason: 'not_read', hint: HINTS.unsafe_path(shownPath) };
      }
      if (state.reason === 'not_read') {
        return { ok: false, reason: 'not_read', hint: HINTS.not_read(shownPath) };
      }
      return { ok: false, reason: 'stale', hint: HINTS.stale(shownPath) };
    },

    invalidate(path) {
      tracker.forget(path);
    },

    snapshot() {
      const out = {};
      for (const [path, snap] of tracker.snapshots) out[path] = snap.fingerprint;
      return out;
    },
  };
}

const GLOB_MAX_PATTERN_CHARS = 1024;
const GLOB_REGEX_SPECIALS = /[.+^$()|[\]\\]/;
const NEVER_MATCH_RE = /^\0never\0$/; // NUL nunca aparece en rutas — no matchea nada

function normalizeMatchPath(path) {
  return String(path ?? '').replaceAll('\\', '/').trim().replace(/^\.\//, '');
}

/**
 * Traduce un fragmento de glob (sin llaves) a fuente de regex.
 * `*` matchea dentro de un segmento, `**` cruza segmentos, `?` un carácter
 * que no sea "/". Todo lo demás se escapa literalmente.
 */
function globFragmentToRegexSource(fragment) {
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const c = fragment[i];
    if (c === '*') {
      if (fragment[i + 1] === '*') {
        const atSegmentStart = i === 0 || fragment[i - 1] === '/';
        let j = i + 2;
        while (fragment[j] === '*') j += 1; // colapsa corridas de 3+ asteriscos
        if (atSegmentStart && fragment[j] === '/') {
          out += '(?:[^/]+/)*'; // `**/` — cero o más segmentos completos
          i = j + 1;
        } else {
          out += '.*'; // `**` suelto o final — cualquier cosa, incluidas barras
          i = j;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (GLOB_REGEX_SPECIALS.test(c) || c === '{' || c === '}') {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * compileGlob(pattern) → RegExp anclada y segura, sin dependencias.
 * Soporta `*`, `**`, `?` y `{a,b}` (alternación no anidada); cualquier otro
 * carácter se escapa, así que los metacaracteres de regex nunca inyectan
 * comportamiento. Patrones no-string, vacíos o gigantes compilan a una regex
 * que no matchea nada.
 */
function compileGlob(pattern) {
  if (typeof pattern !== 'string') return NEVER_MATCH_RE;
  const normalized = normalizeMatchPath(pattern);
  if (!normalized || normalized.length > GLOB_MAX_PATTERN_CHARS || normalized.includes('\0')) {
    return NEVER_MATCH_RE;
  }
  let source = '';
  let i = 0;
  while (i < normalized.length) {
    if (normalized[i] === '{') {
      const end = normalized.indexOf('}', i + 1);
      if (end === -1) {
        source += '\\{';
        i += 1;
        continue;
      }
      const alternatives = normalized
        .slice(i + 1, end)
        .split(',')
        .map((alt) => globFragmentToRegexSource(alt));
      source += `(?:${alternatives.join('|')})`;
      i = end + 1;
    } else {
      const next = normalized.indexOf('{', i);
      const chunk = next === -1 ? normalized.slice(i) : normalized.slice(i, next);
      source += globFragmentToRegexSource(chunk);
      i += chunk.length;
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return NEVER_MATCH_RE;
  }
}

/** matchPaths(paths, pattern) — filtra rutas por glob (rutas normalizadas antes de comparar). */
function matchPaths(paths, pattern) {
  if (!Array.isArray(paths)) return [];
  const re = compileGlob(pattern);
  return paths.filter((p) => re.test(normalizeMatchPath(p)));
}

module.exports = {
  FileStateTracker,
  fingerprint,
  normalizeWorkspacePath,
  trackerForContext,
  shouldEnforceFileState,
  resetFileStateForTests,
  createFileStateTracker,
  compileGlob,
  matchPaths,
};
