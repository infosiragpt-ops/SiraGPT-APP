'use strict';

/**
 * Session memory compaction + ranked retrieval for SiraGPT.
 *
 * Native rewrite of the Hermes MEMORY/USER *idea* (bounded profile vs
 * agent log, fold older log text when the store is full). Not a dump of
 * NousResearch/hermes-agent — no Python memory_tool, no OpenRouter, no
 * paid summarizer on the default path.
 *
 * Layers:
 *   profile  — USER facts. Never folded. Overflow fails closed.
 *   log      — recent MEMORY notes. Oldest rows fold into a compact note.
 *   notes    — compacted summaries. Lowest retrieval priority.
 *
 * Retrieval rank (stable, no LLM): profile > recent log > compacted notes,
 * then token overlap, then recency. Summarizer is injectable so unit tests
 * never call a network model.
 */

const crypto = require('crypto');

const curated = require('./hermes-curated-memory');
const writeGuard = require('./memory-write-guard');

const FACT_MAX_CHARS = writeGuard.FACT_MAX_CHARS;
const WRITE_MAX_PER_WINDOW = writeGuard.WRITE_MAX_PER_WINDOW;
const WRITE_WINDOW_MS = writeGuard.WRITE_WINDOW_MS;
const NOTE_MAX_CHARS = 400;
const NOTES_STORE_LIMIT = 1800;
const DEFAULT_KEEP_RECENT = 2;

const LAYER_RANK = Object.freeze({
  profile: 0,
  log: 1,
  notes: 2,
});

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nowMs(opts = {}) {
  const n = Number(opts.now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function fail(code, error, extra = {}) {
  return {
    ok: false,
    success: false,
    code,
    error,
    ...extra,
  };
}

function missingUser(action) {
  return fail('E_PARAMS', `Falta el usuario para ${action}.`);
}

function checkFactSize(text, opts = {}) {
  return writeGuard.checkFactSize(text, opts);
}

function checkWriteRate(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return missingUser('guardar memoria');
  return writeGuard.checkWriteRate(id, {
    now: nowMs(opts),
    maxWrites: opts.maxWrites,
    windowMs: opts.windowMs,
    record: opts.record,
  });
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function overlapScore(haystack, terms) {
  if (!terms.length) return 1;
  const normalized = String(haystack || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let hits = 0;
  for (const term of terms) {
    if (normalized.includes(term)) hits += 1;
  }
  return hits / terms.length;
}

function defaultSummarize(entries, opts = {}) {
  const maxChars = positiveInt(opts.maxChars, NOTE_MAX_CHARS);
  const parts = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const text = typeof entry === 'string' ? entry : entry && entry.text;
      return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 72);
    })
    .filter(Boolean);
  if (!parts.length) return '';
  const body = `Resumen de ${parts.length} notas: ${parts.join(' · ')}`;
  if (body.length <= maxChars) return body;
  if (maxChars <= 1) return '…';
  return `${body.slice(0, maxChars - 1)}…`;
}

function resolveSummarizer(opts = {}) {
  return typeof opts.summarizer === 'function' ? opts.summarizer : defaultSummarize;
}

function noteId() {
  return `note_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeNote(note) {
  if (!note) return null;
  if (typeof note === 'string') {
    const text = note.trim();
    if (!text) return null;
    return { id: noteId(), text, sourceCount: 0, createdAt: 0 };
  }
  const text = String(note.text || '').trim();
  if (!text) return null;
  return {
    id: String(note.id || noteId()),
    text,
    sourceCount: Number.isFinite(Number(note.sourceCount)) ? Number(note.sourceCount) : 0,
    createdAt: Number(note.createdAt) || 0,
  };
}

function notesCharCount(notes) {
  if (!notes.length) return 0;
  return notes.map((note) => note.text).join('\n').length;
}

function sessionLayers(userId) {
  const id = normalizeUserId(userId);
  if (!id) {
    return { profile: [], log: [], notes: [] };
  }
  const live = curated.read(id);
  const profile = live.ok && live.user
    ? live.user.entries.map((text, index) => ({ text, index, createdAt: index }))
    : [];
  const log = live.ok && live.memory
    ? live.memory.entries.map((text, index) => ({ text, index, createdAt: index }))
    : [];
  const notes = curated.listNotes(id).map((note, index) => ({
    ...note,
    index,
  }));
  return { profile, log, notes };
}

function logWouldExceed(entries, nextText, limit) {
  const probe = [...entries, nextText];
  if (!probe.length) return false;
  return probe.join('\n§\n').length > limit;
}

function applySummarizer(summarizer, entries, ctx) {
  try {
    const result = summarizer(entries, ctx);
    if (result && typeof result.then === 'function') {
      return result.then((value) => ({ ok: true, text: value }));
    }
    return { ok: true, text: result };
  } catch {
    return fail(
      'E_PARAMS',
      'Falló la compactación de memoria. Inténtalo de nuevo.',
    );
  }
}

function acceptSummary(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!text) {
    return fail(
      'E_PARAMS',
      'Falló la compactación de memoria. El resumen quedó vacío.',
    );
  }
  const scan = curated.scanMemoryContent(text);
  if (scan) {
    return fail(
      'E_CONTENT',
      'No se pudo compactar: el resumen no es seguro para guardar.',
    );
  }
  return { ok: true, text };
}

function persistCompactedLog(userId, recent, note, opts = {}) {
  const rewritten = curated.rewriteTarget(userId, 'memory', recent);
  if (!rewritten.ok) {
    return fail('E_PARAMS', 'No se pudo compactar la bitácora. Inténtalo de nuevo.');
  }

  const currentNotes = curated.listNotes(userId);
  const nextNotes = [...currentNotes, note];
  const notesLimit = positiveInt(opts.notesLimit, NOTES_STORE_LIMIT);
  if (notesCharCount(nextNotes) > notesLimit && currentNotes.length) {
    const folded = defaultSummarize(
      currentNotes.map((row) => row.text).concat(note.text),
      { maxChars: Math.min(NOTE_MAX_CHARS, notesLimit) },
    );
    const foldedNote = normalizeNote({
      text: folded,
      sourceCount: currentNotes.reduce((sum, row) => sum + (row.sourceCount || 1), 0) + note.sourceCount,
      createdAt: note.createdAt,
    });
    curated.setNotes(userId, foldedNote ? [foldedNote] : [note]);
  } else {
    curated.setNotes(userId, nextNotes);
  }

  return {
    ok: true,
    success: true,
    compacted: note.sourceCount,
    note: note.text,
    kept: recent.length,
  };
}

function finishCompact(userId, older, recent, summaryResult, opts) {
  if (!summaryResult.ok) return summaryResult;
  const accepted = acceptSummary(summaryResult.text);
  if (!accepted.ok) return accepted;
  const note = normalizeNote({
    text: accepted.text.slice(0, positiveInt(opts.noteMaxChars, NOTE_MAX_CHARS)),
    sourceCount: older.length,
    createdAt: nowMs(opts),
  });
  if (!note) {
    return fail('E_PARAMS', 'Falló la compactación de memoria. El resumen quedó vacío.');
  }
  return persistCompactedLog(userId, recent, note, opts);
}

function compactLog(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return missingUser('compactar memoria');

  const keepRecent = Math.max(1, positiveInt(opts.keepRecent, DEFAULT_KEEP_RECENT));
  const live = curated.read(id, { target: 'memory' });
  const entries = live.ok ? [...live.entries] : [];
  const limit = positiveInt(opts.logLimit, curated.MEMORY_CHAR_LIMIT);
  const used = entries.join('\n§\n').length;
  const overCap = used > limit || (opts.nextText && logWouldExceed(entries, opts.nextText, limit));

  if (!opts.force && !overCap) {
    return { ok: false, skipped: true, reason: 'under_cap', used, limit };
  }
  if (entries.length <= keepRecent) {
    return fail(
      'E_PARAMS',
      'No hay entradas antiguas para compactar.',
      { skipped: true, used, limit },
    );
  }

  const older = entries.slice(0, -keepRecent);
  const recent = entries.slice(-keepRecent);
  const summarizer = resolveSummarizer(opts);
  const summaryResult = applySummarizer(summarizer, older, {
    maxChars: positiveInt(opts.noteMaxChars, NOTE_MAX_CHARS),
    userId: id,
    layer: 'log',
  });

  if (summaryResult && typeof summaryResult.then === 'function') {
    return summaryResult
      .then((resolved) => finishCompact(id, older, recent, resolved, opts))
      .catch(() => fail(
        'E_PARAMS',
        'Falló la compactación de memoria. Inténtalo de nuevo.',
      ));
  }
  return finishCompact(id, older, recent, summaryResult, opts);
}

function resolveLayer(layer) {
  const value = String(layer || 'log').toLowerCase();
  if (value === 'profile' || value === 'user') return 'profile';
  if (value === 'log' || value === 'memory') return 'log';
  return null;
}

async function record(userId, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return missingUser('guardar memoria');

  const layer = resolveLayer(opts.layer || opts.target);
  if (!layer) {
    return fail('E_PARAMS', 'La capa debe ser "profile" o "log".');
  }

  const text = String(opts.content || opts.fact || '').trim();
  if (!text) {
    return fail('E_PARAMS', 'El contenido no puede estar vacío.');
  }

  const scan = curated.scanMemoryContent(text);
  if (scan) return fail('E_CONTENT', scan);

  const size = checkFactSize(text, opts);
  if (!size.ok) return size;

  if (opts.rateLimit !== false) {
    const rate = checkWriteRate(id, opts);
    if (!rate.ok) return rate;
  }

  const target = layer === 'profile' ? 'user' : 'memory';
  const limit = layer === 'profile'
    ? positiveInt(opts.profileLimit, curated.USER_CHAR_LIMIT)
    : positiveInt(opts.logLimit, curated.MEMORY_CHAR_LIMIT);

  const live = curated.read(id, { target });
  const entries = live.ok ? [...live.entries] : [];
  if (logWouldExceed(entries, text, limit)) {
    if (layer === 'profile') {
      return fail(
        'E_PARAMS',
        `El perfil está lleno (${live.used || 0}/${limit}). No se compactan los datos de perfil.`,
        { used: live.used || 0, limit, status: 400 },
      );
    }
    const compacted = await Promise.resolve(compactLog(id, {
      ...opts,
      nextText: text,
      logLimit: limit,
    }));
    if (!compacted.ok) {
      return fail(
        compacted.code || 'E_PARAMS',
        compacted.error || 'No se pudo compactar la bitácora. Inténtalo de nuevo.',
        { used: live.used, limit },
      );
    }
  }

  const added = curated.add(id, { target, content: text, rateLimit: false });
  if (!added.ok) {
    const stillOver = /exceed|límite|superar/i.test(String(added.error || ''));
    return fail(
      added.code || 'E_PARAMS',
      stillOver
        ? `La bitácora está en ${added.used || live.used || 0}/${limit} caracteres. Compacta o elimina una entrada primero.`
        : (added.error || 'No se pudo guardar la memoria.'),
      { used: added.used, limit: added.limit || limit },
    );
  }

  return {
    ok: true,
    success: true,
    layer,
    message: layer === 'profile' ? 'Dato de perfil guardado.' : 'Nota de bitácora guardada.',
    ...added,
  };
}

function retrieve(userId, query, opts = {}) {
  const id = normalizeUserId(userId);
  if (!id) return { ...missingUser('recuperar memoria'), hits: [] };

  const limit = Math.min(25, positiveInt(opts.limit, 8));
  const terms = tokenize(query);
  const layers = sessionLayers(id);
  const items = [];

  for (const row of layers.profile) {
    items.push({ layer: 'profile', text: row.text, createdAt: row.createdAt });
  }
  for (const row of layers.log) {
    items.push({ layer: 'log', text: row.text, createdAt: row.createdAt });
  }
  for (const row of layers.notes) {
    items.push({ layer: 'notes', text: row.text, createdAt: row.createdAt || row.index || 0 });
  }

  const hits = items
    .map((item) => ({
      ...item,
      score: overlapScore(item.text, terms),
    }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((a, b) => {
      const layerDelta = LAYER_RANK[a.layer] - LAYER_RANK[b.layer];
      if (layerDelta) return layerDelta;
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || 0) - (a.createdAt || 0);
    })
    .slice(0, limit);

  return { ok: true, success: true, hits, count: hits.length };
}

function readSession(userId) {
  const id = normalizeUserId(userId);
  if (!id) return { ok: false, ...missingUser('leer memoria') };
  const layers = sessionLayers(id);
  return {
    ok: true,
    success: true,
    profile: layers.profile.map((row) => row.text),
    log: layers.log.map((row) => row.text),
    notes: layers.notes.map((row) => ({
      id: row.id,
      text: row.text,
      sourceCount: row.sourceCount,
      createdAt: row.createdAt,
    })),
  };
}

function neutralizeNote(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203a')
    .trim();
}

function renderNotesBlock(userId) {
  const notes = curated.listNotes(userId);
  if (!notes.length) return '';
  const lines = notes.map((note) => neutralizeNote(note.text));
  const used = notesCharCount(notes);
  const pct = Math.min(100, Math.round((used / NOTES_STORE_LIMIT) * 100));
  return [
    '══════════════════════════════════════════════',
    `NOTAS COMPACTADAS [${pct}% — ${used}/${NOTES_STORE_LIMIT} chars]`,
    '══════════════════════════════════════════════',
    ...lines,
  ].join('\n');
}

function status(userId) {
  const base = {
    pattern: 'hermes-session-compaction',
    layers: ['profile', 'log', 'notes'],
    ranking: ['profile', 'log', 'notes'],
    factMaxChars: FACT_MAX_CHARS,
    writeMaxPerWindow: WRITE_MAX_PER_WINDOW,
    writeWindowMs: WRITE_WINDOW_MS,
    noteMaxChars: NOTE_MAX_CHARS,
  };
  const id = normalizeUserId(userId);
  if (!id) return base;
  const session = readSession(id);
  return {
    ...base,
    profileCount: session.profile.length,
    logCount: session.log.length,
    notesCount: session.notes.length,
  };
}

function resetForTests() {
  writeGuard.resetMemoryWriteGuardForTests();
}

module.exports = {
  FACT_MAX_CHARS,
  WRITE_MAX_PER_WINDOW,
  WRITE_WINDOW_MS,
  NOTE_MAX_CHARS,
  NOTES_STORE_LIMIT,
  DEFAULT_KEEP_RECENT,
  LAYER_RANK,
  checkFactSize,
  checkWriteRate,
  defaultSummarize,
  compactLog,
  record,
  retrieve,
  readSession,
  renderNotesBlock,
  status,
  resetForTests,
};
