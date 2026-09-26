'use strict';

/**
 * turn-failures/tap — observe one user turn from the outside.
 *
 * `TurnTap` wraps the Express response of a turn route (res.write / res.json)
 * and reconstructs what the user actually received: visible text, error
 * frames, stages, artifacts, first-byte time. Deep code (ai-service provider
 * retries, the image loader, agentic tool failures) adds context through
 * `noteTurn(kind, data)` without any plumbing — the tap is the
 * AsyncLocalStorage store of the request.
 *
 * Everything here is best-effort: a tap bug must never change a response.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const MAX_VISIBLE = 24_000;
const MAX_NOTES = 40;
const MAX_STAGES = 15;
const MAX_FRAME_PARSE = 600_000;

function parseDataFrames(chunk) {
  let text;
  if (typeof chunk === 'string') text = chunk;
  else if (chunk && typeof chunk === 'object' && typeof chunk.length === 'number' && chunk.length < MAX_FRAME_PARSE && typeof chunk.toString === 'function') {
    try { text = chunk.toString('utf8'); } catch (_) { return []; }
  } else return [];
  if (!text || text.length > MAX_FRAME_PARSE || text.indexOf('data:') === -1) return [];
  const frames = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      if (raw[0] !== '{') continue;
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') frames.push(obj);
      } catch (_) { /* partial frame — ignore */ }
    }
  }
  return frames;
}

function shortText(value, max) {
  if (value == null) return '';
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

class TurnTap {
  constructor({ route, req = null, startedAt = Date.now(), context = {} } = {}) {
    this.id = crypto.randomUUID();
    this.route = route || 'turno';
    this.startedAt = startedAt;
    this.lastActivityAt = startedAt;
    this.firstVisibleAt = null;
    this.firstProviderAt = null;
    this.visibleText = '';
    this.errorFrames = [];
    this.stages = [];
    this.notes = [];
    this.doneFrame = null;
    this.frameArtifacts = 0;
    this.statusCode = null;
    this.jsonBody = null;
    this.finished = false;
    this.sinCierreRecorded = false;
    this.context = {
      method: req && req.method ? String(req.method) : 'POST',
      endpoint: req ? String((req.baseUrl || '') + (req.path || '')) || String(req.originalUrl || '').split('?')[0] : '',
      reqId: req ? (req.requestId || req.id || (req.headers && req.headers['x-request-id']) || null) : null,
      userAgent: req && req.headers ? req.headers['user-agent'] || null : null,
      userId: req && req.user ? (req.user.id || req.user.userId || null) : null,
      userEmail: req && req.user ? req.user.email || null : null,
      ...context,
    };
  }

  set(patch) {
    if (!patch || typeof patch !== 'object') return this;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.context[key] = value;
    }
    return this;
  }

  note(kind, data) {
    if (!kind) return this;
    this.notes.push({ kind: String(kind).slice(0, 60), at: Date.now(), data: data && typeof data === 'object' ? data : (data == null ? null : { value: String(data).slice(0, 300) }) });
    if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
    return this;
  }

  observeFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    const now = Date.now();
    const type = typeof frame.type === 'string' ? frame.type : '';
    if (type !== 'usage') this.lastActivityAt = now;
    if (frame.error || type === 'error') {
      this.errorFrames.push({
        code: shortText(frame.code || frame.error_code || '', 80),
        message: shortText(frame.message || frame.error || '', 300),
        recovered: frame.recovered === true,
        at: now,
      });
      return;
    }
    if (type === 'stage') {
      this.stages.push({ label: shortText(frame.label || '', 140), tool: frame.tool ? shortText(frame.tool, 60) : undefined, at: now });
      if (this.stages.length > MAX_STAGES) this.stages.splice(0, this.stages.length - MAX_STAGES);
      return;
    }
    if (type === 'reasoning_delta' || type === 'tool_call_delta') {
      if (this.firstProviderAt == null) this.firstProviderAt = now;
      return;
    }
    if (type === 'done') {
      this.doneFrame = { ok: frame.ok !== false, code: shortText(frame.code || '', 60) };
      if (typeof frame.content === 'string' && frame.content) this.visibleText = shortText(frame.content, MAX_VISIBLE);
      if (Array.isArray(frame.files)) this.frameArtifacts += frame.files.length;
      return;
    }
    if (type === 'final') {
      if (typeof frame.content === 'string') this.visibleText = shortText(frame.content, MAX_VISIBLE);
      if (frame.file) this.frameArtifacts += 1;
      return;
    }
    if (type === 'file_artifact' || (frame.artifact && typeof frame.artifact === 'object')) {
      this.frameArtifacts += 1;
      return;
    }
    if (typeof frame.content === 'string' && frame.content.length) {
      if (this.firstProviderAt == null) this.firstProviderAt = now;
      if (this.firstVisibleAt == null) this.firstVisibleAt = now;
      if (frame.replace === true) this.visibleText = shortText(frame.content, MAX_VISIBLE);
      else if (this.visibleText.length < MAX_VISIBLE) this.visibleText = shortText(this.visibleText + frame.content, MAX_VISIBLE);
    }
  }

  observeWrite(chunk) {
    const frames = parseDataFrames(chunk);
    for (const frame of frames) this.observeFrame(frame);
  }
}

/**
 * Wrap res.write/res.json so every frame the turn sends passes through the
 * tap. Must be installed BEFORE other write wrappers capture `res.write`
 * (the generate route's mirror guard stores it as `res._siraRawWrite`), so
 * both normal frames and raw error frames are observed.
 */
function attachResponseTap(tap, res) {
  if (!tap || !res || res.__siraTurnTapInstalled) return;
  res.__siraTurnTapInstalled = true;
  if (typeof res.write === 'function') {
    const prevWrite = res.write;
    res.write = function tappedWrite(chunk, ...rest) {
      try { tap.observeWrite(chunk); } catch (_) { /* advisory */ }
      return prevWrite.call(this, chunk, ...rest);
    };
  }
  if (typeof res.json === 'function') {
    const prevJson = res.json;
    res.json = function tappedJson(body) {
      try {
        tap.statusCode = Number(res.statusCode) || null;
        tap.jsonBody = body && typeof body === 'object' ? body : null;
      } catch (_) { /* advisory */ }
      return prevJson.call(this, body);
    };
  }
}

// ── In-flight registry (for «sin_cierre») ──────────────────────────────
const inflight = new Map();

function registerInflight(tap) {
  inflight.set(tap.id, tap);
  if (inflight.size > 5000) {
    const oldest = inflight.keys().next().value;
    inflight.delete(oldest);
  }
}

function unregisterInflight(tap) {
  if (tap) inflight.delete(tap.id);
}

function listInflight() {
  return Array.from(inflight.values());
}

function enterTurn(tap) {
  try { als.enterWith(tap); } catch (_) { /* ALS unavailable — notes become no-ops */ }
}

function currentTurn() {
  try { return als.getStore() || null; } catch (_) { return null; }
}

function runWithTurn(tap, fn) {
  return als.run(tap, fn);
}

module.exports = {
  TurnTap,
  attachResponseTap,
  parseDataFrames,
  registerInflight,
  unregisterInflight,
  listInflight,
  enterTurn,
  currentTurn,
  runWithTurn,
};
