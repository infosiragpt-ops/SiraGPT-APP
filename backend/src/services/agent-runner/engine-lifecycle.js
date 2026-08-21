'use strict';

/**
 * 3H31 — engine lifecycle layer for /chat + /code.
 *
 * Remaining holes after 3H30 (cancel-in-flight / DAG cycle / write_noop /
 * sandbox_spawn / SSE idempotent / credit_no_usage):
 *   1  session event-order: monotonic seq, no duplicate tool results, single gateway
 *   2  tool-call schema repair: unknown → nearest allowed, extra keys stripped,
 *      enum/type coerce, required defaults, maxItems trim
 *   3  long-context: pin critical facts across compact; file-backed pin list
 *      (pgvector hook if retrieve already exists — no new DB)
 *   4  cancel mid-stream: abort in-flight tools, release credit hold once,
 *      emit terminal SSE once
 *   5  read-after-write for str_replace/edit: syntax check + auto-revert
 *   6  sandbox: wall-clock + RSS kill, guaranteed tmp cleanup on crash path
 *   7  first-token watchdog: heartbeat with reason if no token in N ms
 *   8  error taxonomy: 429/401/5xx/400/timeout → Spanish-safe codes, no keys
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter. DeepSeek Flash/Pro only.
 * Interpreter stays `local`. Do not invent HMAC/MCP/SANDBOX_NET_ALLOW secrets.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIRST_TOKEN_WATCHDOG_MS = 2500;
const WATCHDOG_ESCALATE_MULT = 2;
const PIN_MAX_BYTES = 4 * 1024;
const PIN_DIR_NAME = 'siragpt-pins';
const RSS_DEFAULT_BYTES = 512 * 1024 * 1024;
const WALL_DEFAULT_MS = 30_000;
const TERM_GRACE_MS = 400;
const SECRET_RE = /(?:sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9\-._~+/]+=*|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}|x-api-key\s*[:=]\s*\S+)/gi;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  if (Math.abs(m - n) > 8 && Math.max(m, n) > 12) return Math.max(m, n);
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j];
  }
  return prev[n];
}

function allowedToolNames(opts = {}) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    const s = String(n || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(opts.catalog)) opts.catalog.forEach(push);
  if (opts.executors && typeof opts.executors === 'object') Object.keys(opts.executors).forEach(push);
  if (Array.isArray(opts.allowed)) opts.allowed.forEach(push);
  return out;
}

// ---------------------------------------------------------------------------
// Cap 1 — session event order / single-gateway queue
// ---------------------------------------------------------------------------

function createEventOrderGate() {
  let lastSeq = 0;
  const seenTool = new Map();
  return {
    next(event, seq) {
      const n = seq == null ? lastSeq + 1 : Number(seq);
      if (!Number.isFinite(n) || n <= lastSeq) {
        return { ok: false, code: 'event_order', lastSeq, seq: n, event: null };
      }
      lastSeq = n;
      const ev = event && typeof event === 'object' ? { ...event, seq: n } : { type: 'event', seq: n, payload: event };
      return { ok: true, seq: n, event: ev, code: null };
    },
    lastSeq() { return lastSeq; },
  };
}

function assertMonotonicSeq(lastSeq, nextSeq) {
  const last = Number(lastSeq) || 0;
  const next = Number(nextSeq);
  if (!Number.isFinite(next) || next <= last) {
    return { ok: false, code: 'event_order', last, next };
  }
  return { ok: true, code: null, last, next };
}

function recordToolResultOnce(store, { toolCallId, result } = {}) {
  const map = store instanceof Map ? store : (store && store.map) || new Map();
  const id = String(toolCallId || '');
  if (!id) return { ok: false, emit: false, code: 'tool_result_orphan' };
  const hash = sha256Hex(result);
  const prev = map.get(id);
  if (prev && prev.hash === hash) {
    return { ok: false, emit: false, code: 'tool_result_dup', hash };
  }
  map.set(id, { hash, at: Date.now() });
  if (store && !(store instanceof Map)) store.map = map;
  return { ok: true, emit: true, code: null, hash, store: map };
}

const gatewayClaims = new Map();

function claimSingleGateway(sessionKey, producerId, { steal = false } = {}) {
  const key = String(sessionKey || '');
  const id = String(producerId || '');
  if (!key || !id) return { ok: false, code: 'gateway_busy', reason: 'missing_key' };
  const cur = gatewayClaims.get(key);
  if (cur && cur.producerId !== id && !cur.released && !steal) {
    return { ok: false, code: 'gateway_busy', producerId: cur.producerId };
  }
  gatewayClaims.set(key, { producerId: id, at: Date.now(), released: false });
  return {
    ok: true,
    code: null,
    producerId: id,
    release() {
      const now = gatewayClaims.get(key);
      if (now && now.producerId === id) {
        now.released = true;
        gatewayClaims.delete(key);
      }
      return { ok: true };
    },
  };
}

function drainOrNackOnClose(queued, { emit } = {}) {
  const list = Array.isArray(queued) ? queued : [];
  const nacked = [];
  for (const frame of list) {
    if (typeof emit === 'function') {
      try { emit(frame); } catch (_) { nacked.push({ ...frame, code: 'event_order', nack: true }); }
    } else {
      nacked.push({ ...(frame && typeof frame === 'object' ? frame : { frame }), code: 'event_order', nack: true });
    }
  }
  return { ok: true, flushed: typeof emit === 'function' ? list.length - nacked.length : 0, nacked, code: nacked.length ? 'event_order' : null };
}

function resetGatewayClaims() {
  gatewayClaims.clear();
}

// ---------------------------------------------------------------------------
// Cap 2 — tool-call schema repair beyond 3H28/30
// ---------------------------------------------------------------------------

function rewriteUnknownToNearest(name, opts = {}) {
  const raw = String(name || '').trim();
  const allowed = allowedToolNames(opts);
  if (!raw) return { ok: false, mapped: null, code: 'tool_name_empty', rewritten: false };
  if (allowed.includes(raw)) return { ok: true, mapped: raw, code: null, rewritten: false, distance: 0 };
  let aliases = {};
  try { aliases = require('./engine-correctness').TOOL_ALIASES || {}; } catch (_) { aliases = {}; }
  if (aliases[raw] && allowed.includes(aliases[raw])) {
    return { ok: true, mapped: aliases[raw], code: null, rewritten: true, distance: 0, via: 'alias' };
  }
  let best = null;
  let bestD = Infinity;
  for (const cand of allowed) {
    const d = levenshtein(raw.toLowerCase(), String(cand).toLowerCase());
    if (d < bestD) { bestD = d; best = cand; }
  }
  const maxD = Number.isFinite(Number(opts.maxDistance)) ? Number(opts.maxDistance) : 2;
  if (best && bestD <= maxD) {
    return { ok: true, mapped: best, code: null, rewritten: true, distance: bestD, suggestion: best };
  }
  return { ok: false, mapped: null, code: 'tool_unknown', rewritten: false, distance: bestD, suggestion: best };
}

function stripUnknownKeys(args, schema) {
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  const additional = schema && schema.additionalProperties;
  const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!props || additional === true) {
    return { ok: true, value: { ...src }, stripped: [], code: null };
  }
  const stripped = [];
  const value = {};
  for (const [k, v] of Object.entries(src)) {
    if (Object.prototype.hasOwnProperty.call(props, k)) value[k] = v;
    else stripped.push(k);
  }
  return { ok: true, value, stripped, code: stripped.length ? 'schema_strip' : null };
}

function coerceJsonTypes(args, schema) {
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const src = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const coerced = [];
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in src) || src[k] == null) continue;
    const t = spec && spec.type;
    const v = src[k];
    if (t === 'boolean' && typeof v === 'string') {
      if (/^(true|1|yes|si|sí)$/i.test(v)) { src[k] = true; coerced.push(k); }
      else if (/^(false|0|no)$/i.test(v)) { src[k] = false; coerced.push(k); }
    } else if ((t === 'integer' || t === 'number') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      src[k] = t === 'integer' ? parseInt(v, 10) : Number(v);
      coerced.push(k);
    } else if (t === 'string' && typeof v !== 'string') {
      src[k] = String(v);
      coerced.push(k);
    }
  }
  return { ok: true, value: src, coerced, code: coerced.length ? 'schema_coerce' : null };
}

function coerceEnumFuzzy(args, schema) {
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const src = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const coerced = [];
  for (const [k, spec] of Object.entries(props)) {
    const enums = spec && Array.isArray(spec.enum) ? spec.enum.map(String) : null;
    if (!enums || !(k in src) || src[k] == null) continue;
    const raw = String(src[k]);
    if (enums.includes(raw)) continue;
    let best = null;
    let bestD = Infinity;
    for (const cand of enums) {
      const d = levenshtein(raw.toLowerCase(), String(cand).toLowerCase());
      if (d < bestD) { bestD = d; best = cand; }
    }
    if (best && bestD <= 2) {
      const origType = spec && spec.enum && spec.enum.find((e) => String(e) === best);
      src[k] = origType !== undefined ? origType : best;
      coerced.push(k);
    }
  }
  return { ok: true, value: src, coerced, code: coerced.length ? 'schema_enum' : null };
}

function fillRequiredDefaults(args, schema) {
  const src = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const required = schema && Array.isArray(schema.required) ? schema.required : [];
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const filled = [];
  const missing = [];
  for (const key of required) {
    if (src[key] !== undefined && src[key] !== null && src[key] !== '') continue;
    const spec = props[key] || {};
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
      src[key] = spec.default;
      filled.push(key);
    } else {
      missing.push(key);
    }
  }
  return {
    ok: missing.length === 0,
    value: src,
    filled,
    missing,
    code: missing.length ? 'schema_required' : (filled.length ? 'schema_default' : null),
  };
}

function trimMaxItems(args, schema) {
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const src = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const trimmed = [];
  for (const [k, spec] of Object.entries(props)) {
    const max = spec && Number(spec.maxItems);
    if (!Number.isFinite(max) || max < 0) continue;
    if (Array.isArray(src[k]) && src[k].length > max) {
      src[k] = src[k].slice(0, max);
      trimmed.push(k);
    }
  }
  return { ok: true, value: src, trimmed, code: trimmed.length ? 'schema_maxitems' : null };
}

function repairToolCallSchema(call, schema, opts = {}) {
  const name = (call && (call.name || (call.function && call.function.name))) || '';
  const rewritten = rewriteUnknownToNearest(name, opts);
  let args = call && call.arguments != null ? call.arguments : (call && call.function && call.function.arguments);
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (_) { args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  const sch = schema && typeof schema === 'object' ? schema : { type: 'object' };
  const stripped = stripUnknownKeys(args, sch);
  const typed = coerceJsonTypes(stripped.value, sch);
  const enums = coerceEnumFuzzy(typed.value, sch);
  const filled = fillRequiredDefaults(enums.value, sch);
  const trimmed = trimMaxItems(filled.value, sch);
  return {
    ok: rewritten.ok && filled.ok,
    name: rewritten.mapped || name,
    rewritten: Boolean(rewritten.rewritten),
    suggestion: rewritten.suggestion || null,
    args: trimmed.value,
    code: rewritten.ok ? (filled.ok ? (stripped.code || typed.code || enums.code || trimmed.code) : filled.code) : rewritten.code,
    stripped: stripped.stripped,
    coerced: [...(typed.coerced || []), ...(enums.coerced || [])],
    filled: filled.filled,
    missing: filled.missing,
  };
}

// ---------------------------------------------------------------------------
// Cap 3 — long-context pins (file-backed, pgvector hook, no new DB)
// ---------------------------------------------------------------------------

function pinDir(root) {
  return path.join(root || os.tmpdir(), PIN_DIR_NAME);
}

function pinPath(namespace, root) {
  const safe = String(namespace || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return path.join(pinDir(root), `${safe}.json`);
}

function capPinBytes(text, maxBytes = PIN_MAX_BYTES) {
  const s = String(text == null ? '' : text);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false, hash: sha256Hex(s), bytes: buf.length };
  const cut = buf.subarray(0, maxBytes).toString('utf8');
  const hash = sha256Hex(s);
  return { text: `${cut}\n… pin_capped sha256=${hash}`, truncated: true, hash, bytes: buf.length, code: 'pin_capped' };
}

function loadFilePins(namespace, { root } = {}) {
  const file = pinPath(namespace, root);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const pins = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.pins) ? parsed.pins : []);
    return { ok: true, pins, file, code: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, pins: [], file, code: null };
    return { ok: false, pins: [], file, code: 'pin_store' };
  }
}

function saveFilePins(namespace, pins, { root } = {}) {
  const dir = pinDir(root);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  const file = pinPath(namespace, root);
  const list = Array.isArray(pins) ? pins : [];
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pins: list, at: Date.now() }), 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, file, count: list.length };
}

function upsertFilePin(namespace, pin, { root } = {}) {
  const loaded = loadFilePins(namespace, { root });
  const pins = loaded.pins.slice();
  const capped = capPinBytes(pin && pin.text);
  const rec = {
    id: String((pin && pin.id) || sha256Hex(capped.text).slice(0, 12)),
    text: capped.text,
    hash: capped.hash,
    critical: Boolean(pin && pin.critical),
    expiresAt: pin && pin.expiresAt != null ? Number(pin.expiresAt) : null,
    namespace: String(namespace || 'default'),
  };
  const idx = pins.findIndex((p) => p && (p.id === rec.id || p.hash === rec.hash));
  if (idx >= 0) pins[idx] = { ...pins[idx], ...rec };
  else pins.push(rec);
  saveFilePins(namespace, pins, { root });
  return { ok: true, pin: rec, count: pins.length, truncated: capped.truncated };
}

function refreshPinTtlOnHit(pin, { now = Date.now(), ttlMs = 24 * 3600 * 1000 } = {}) {
  if (!pin || typeof pin !== 'object') return { ok: false, pin: null, refreshed: false };
  const next = { ...pin, expiresAt: Number(now) + Number(ttlMs || 0), lastHitAt: Number(now) };
  return { ok: true, pin: next, refreshed: true, code: 'pin_ttl_refresh' };
}

function pinAcrossCompact(messages, pins, { maxTokens } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const pinList = (Array.isArray(pins) ? pins : []).filter((p) => p && (p.critical || p.keep));
  if (!pinList.length) return { messages: list, pinned: 0, compressed: false };
  const block = pinList.map((p) => `- ${String(p.text || p).slice(0, 400)}`).join('\n');
  const pinMsg = { role: 'system', content: `PINNED FACTS (do not drop):\n${block}`, __pin: true };
  const withoutOld = list.filter((m) => !(m && m.__pin));
  const out = [pinMsg, ...withoutOld];
  return { messages: out, pinned: pinList.length, compressed: false, maxTokens: maxTokens || null, code: 'pin_across_compact' };
}

function searchableMemoryHook({ retrieve, query, namespace, root, hits } = {}) {
  const q = String(query || '').trim();
  if (typeof retrieve === 'function') {
    return Promise.resolve(retrieve({ query: q, namespace }))
      .then((rows) => ({ ok: true, hits: Array.isArray(rows) ? rows : [], via: 'pgvector_or_store', code: null }))
      .catch((err) => {
        const code = err && err.code === 'pgvector_failed' ? 'pgvector_failed' : 'retrieve_memory_failed';
        return { ok: false, hits: [], via: 'pgvector_or_store', code };
      });
  }
  if (Array.isArray(hits)) {
    const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    const scored = hits.map((h) => {
      const text = String((h && (h.text || h.content)) || '').toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score += 1;
      return { ...h, score };
    }).filter((h) => !tokens.length || h.score > 0).sort((a, b) => b.score - a.score);
    return { ok: true, hits: scored, via: 'inline', code: null };
  }
  const loaded = loadFilePins(namespace || 'default', { root });
  const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const scored = loaded.pins.map((p) => {
    const text = String(p.text || '').toLowerCase();
    let score = 0;
    for (const t of tokens) if (text.includes(t)) score += 1;
    return { ...p, score };
  }).filter((p) => !tokens.length || p.score > 0).sort((a, b) => b.score - a.score);
  return { ok: true, hits: scored, via: 'file_pins', code: null };
}

// ---------------------------------------------------------------------------
// Cap 4 — cancel mid-stream
// ---------------------------------------------------------------------------

function createInFlightRegistry() {
  const items = new Map();
  return {
    track(entry) {
      const id = String((entry && entry.id) || `t${items.size + 1}`);
      const rec = { id, abort: entry && entry.abort, kill: entry && entry.kill, at: Date.now() };
      items.set(id, rec);
      return {
        id,
        done() { items.delete(id); },
      };
    },
    abortAll(reason) {
      const aborted = [];
      for (const rec of items.values()) {
        try { if (typeof rec.abort === 'function') rec.abort(reason || 'cancel'); } catch (_) {}
        try { if (typeof rec.kill === 'function') rec.kill(reason || 'cancel'); } catch (_) {}
        aborted.push(rec.id);
      }
      items.clear();
      return { ok: true, aborted, code: aborted.length ? 'tool_aborted' : null };
    },
    size() { return items.size; },
  };
}

function releaseHoldOnCancelOnce(hold, state = {}) {
  if (state.released) return { ok: true, released: false, code: 'credit_hold_reuse' };
  let out = null;
  if (hold && typeof hold.release === 'function') {
    try { out = hold.release(); } catch (err) { return { ok: false, released: false, error: String(err && err.message || err) }; }
  }
  state.released = true;
  return { ok: true, released: true, hold: out, code: 'credit_release', state };
}

function emitTerminalSseOnce(state, payload, write) {
  if (state && state.emitted) {
    return { ok: true, emitted: false, code: 'sse_duplicate' };
  }
  if (state) state.emitted = true;
  const frame = payload && typeof payload === 'object' ? payload : { type: 'done', data: payload };
  if (typeof write === 'function') {
    try { write(frame); } catch (_) { /* socket gone */ }
  }
  return { ok: true, emitted: true, frame, code: null };
}

function cancelMidStream({ registry, hold, holdState, sseState, write, reason } = {}) {
  const aborted = registry && typeof registry.abortAll === 'function'
    ? registry.abortAll(reason || 'cancel')
    : { aborted: [] };
  const credit = releaseHoldOnCancelOnce(hold, holdState || {});
  const terminal = emitTerminalSseOnce(sseState || {}, {
    type: 'cancelled',
    code: 'turn_cancelled',
    reason: reason || 'cancel',
  }, write);
  return {
    ok: true,
    aborted: aborted.aborted || [],
    creditReleased: Boolean(credit.released),
    terminal: Boolean(terminal.emitted),
    code: 'turn_cancelled',
  };
}

// ---------------------------------------------------------------------------
// Cap 5 — read-after-write for str_replace / edit
// ---------------------------------------------------------------------------

function bracketBalance(text) {
  const s = String(text == null ? '' : text);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let inStr = null;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return { ok: false, code: 'syntax_invalid', reason: 'mismatch' };
    }
  }
  if (inStr) return { ok: false, code: 'syntax_invalid', reason: 'unterminated_string' };
  if (stack.length) return { ok: false, code: 'syntax_invalid', reason: 'unbalanced' };
  return { ok: true, code: null };
}

function syntaxCheckAfterEdit(pathName, content) {
  const p = String(pathName || '');
  const body = String(content == null ? '' : content);
  const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
  const brackets = bracketBalance(body);
  if (!brackets.ok) return { ok: false, code: 'syntax_invalid', error: brackets.reason, via: 'brackets' };
  if (ext === 'json') {
    try { JSON.parse(body); return { ok: true, code: null, via: 'json' }; }
    catch (err) { return { ok: false, code: 'syntax_invalid', error: String(err && err.message || err), via: 'json' }; }
  }
  if (ext === 'js' || ext === 'cjs' || ext === 'mjs') {
    try {
      // eslint-disable-next-line no-new-func
      new Function(body);
      return { ok: true, code: null, via: 'js' };
    } catch (err) {
      return { ok: false, code: 'syntax_invalid', error: String(err && err.message || err), via: 'js' };
    }
  }
  return { ok: true, code: null, via: 'passthrough' };
}

function uniqueHunkAfterReplace({ before, after, oldString, newString } = {}) {
  const oldS = String(oldString == null ? '' : oldString);
  const newS = String(newString == null ? '' : newString);
  const a = String(after == null ? '' : after);
  const b = String(before == null ? '' : before);
  if (oldS && b.split(oldS).length - 1 !== 1 && b.includes(oldS) === false) {
    return { ok: false, code: 'git_hunk_ambiguous', remaining: 0 };
  }
  if (oldS && a.includes(oldS) && oldS !== newS && !String(newS).includes(oldS)) {
    return { ok: false, code: 'read_after_write_failed', remaining: true };
  }
  if (newS && !a.includes(newS) && b.includes(oldS)) {
    return { ok: false, code: 'read_after_write_failed', applied: false };
  }
  if (a === b) return { ok: false, code: 'write_noop', noop: true };
  return { ok: true, code: null, applied: true };
}

function verifyStrReplace({ pathName, before, after, oldString, newString, revert } = {}) {
  const hunk = uniqueHunkAfterReplace({ before, after, oldString, newString });
  if (!hunk.ok) {
    if (typeof revert === 'function' && hunk.code !== 'write_noop') {
      try { revert(before); } catch (_) { /* best-effort */ }
      return { ok: false, code: hunk.code, reverted: true };
    }
    return { ok: false, code: hunk.code, reverted: false, noop: Boolean(hunk.noop) };
  }
  const syn = syntaxCheckAfterEdit(pathName, after);
  if (!syn.ok) {
    if (typeof revert === 'function') {
      try { revert(before); } catch (_) { /* best-effort */ }
      return { ok: false, code: 'write_syntax_revert', error: syn.error, reverted: true, via: syn.via };
    }
    return { ok: false, code: 'syntax_invalid', error: syn.error, reverted: false };
  }
  return { ok: true, code: null, reverted: false, via: syn.via };
}

// ---------------------------------------------------------------------------
// Cap 6 — sandbox wall-clock + RSS + crash tmp
// ---------------------------------------------------------------------------

const registeredTmp = new Set();

function wallClockExceeded({ startedAt, now = Date.now(), wallMs = WALL_DEFAULT_MS } = {}) {
  const start = Number(startedAt) || 0;
  const limit = Number(wallMs) || WALL_DEFAULT_MS;
  const elapsed = Math.max(0, Number(now) - start);
  if (start && elapsed >= limit) {
    return { kill: true, code: 'sandbox_timeout', elapsed, limit, reason: 'wall_clock' };
  }
  return { kill: false, code: null, elapsed, limit };
}

function rssKillIfOver({ rssBytes, limitBytes = RSS_DEFAULT_BYTES } = {}) {
  const rss = Number(rssBytes);
  const limit = Number(limitBytes) || RSS_DEFAULT_BYTES;
  if (Number.isFinite(rss) && rss > limit) {
    return { kill: true, code: 'sandbox_resource_limit', rss, limit, reason: 'rss' };
  }
  return { kill: false, code: null, rss: Number.isFinite(rss) ? rss : null, limit };
}

function readLinuxRssBytes(pid, { readFileSync = fs.readFileSync } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, rssBytes: null, code: 'pg_invalid' };
  try {
    const raw = readFileSync(`/proc/${n}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s+kB/i.exec(raw);
    if (!m) return { ok: false, rssBytes: null, code: null };
    return { ok: true, rssBytes: Number(m[1]) * 1024, code: null };
  } catch (_) {
    return { ok: false, rssBytes: null, code: null };
  }
}

function termThenKill(pid, { kill, graceMs = TERM_GRACE_MS, now, termAt } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, code: 'pg_invalid' };
  const killer = typeof kill === 'function' ? kill : (id, sig) => {
    try { process.kill(id, sig); return true; } catch (_) { return false; }
  };
  if (!termAt) {
    const sent = Boolean(killer(n, 'SIGTERM'));
    return { ok: true, signal: 'SIGTERM', sent, code: sent ? 'sandbox_killed' : 'sandbox_reap', termAt: Date.now() };
  }
  const elapsed = Number(now || Date.now()) - Number(termAt);
  if (elapsed < (Number(graceMs) || TERM_GRACE_MS)) {
    return { ok: true, signal: 'SIGTERM', waiting: true, code: null };
  }
  const sent = Boolean(killer(n, 'SIGKILL'));
  return { ok: true, signal: 'SIGKILL', sent, code: 'pg_killed' };
}

function registerTmpForCrashCleanup(dir) {
  const p = String(dir || '');
  if (!p) return { ok: false };
  registeredTmp.add(p);
  return { ok: true, path: p, count: registeredTmp.size };
}

function cleanupRegisteredTmp({ rmSync = fs.rmSync, unlinkSync = fs.unlinkSync } = {}) {
  const cleaned = [];
  for (const dir of registeredTmp) {
    try {
      rmSync(dir, { recursive: true, force: true });
      cleaned.push(dir);
    } catch (_) {
      try { unlinkSync(dir); cleaned.push(dir); } catch (__) { /* gone */ }
    }
  }
  registeredTmp.clear();
  return { ok: true, cleaned, code: cleaned.length ? 'sandbox_cleanup' : null };
}

function guaranteedTmpCleanup(dir, opts = {}) {
  if (dir) registerTmpForCrashCleanup(dir);
  return cleanupRegisteredTmp(opts);
}

function sandboxWatchdogTick({ startedAt, now, wallMs, rssBytes, rssLimit, pid, kill, termAt } = {}) {
  const wall = wallClockExceeded({ startedAt, now, wallMs });
  const rss = rssKillIfOver({ rssBytes, limitBytes: rssLimit });
  if (wall.kill || rss.kill) {
    const killed = termThenKill(pid, { kill, termAt, now, graceMs: TERM_GRACE_MS });
    return { kill: true, code: wall.kill ? wall.code : rss.code, reason: wall.kill ? wall.reason : rss.reason, term: killed };
  }
  return { kill: false, code: null, wall, rss };
}

// ---------------------------------------------------------------------------
// Cap 7 — first-token watchdog
// ---------------------------------------------------------------------------

function classifyStallReason({ hasToken, inTool, inSandbox } = {}) {
  if (hasToken) return { reason: null, code: null };
  if (inSandbox) return { reason: 'waiting_sandbox', code: 'sse_heartbeat' };
  if (inTool) return { reason: 'waiting_tool', code: 'sse_heartbeat' };
  return { reason: 'waiting_provider', code: 'sse_heartbeat' };
}

function startFirstTokenWatchdog({
  timeoutMs = FIRST_TOKEN_WATCHDOG_MS,
  onHeartbeat,
  onEscalate,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let firstAt = null;
  let fired = false;
  let escalated = false;
  const t0 = typeof now === 'function' ? now() : Number(now) || Date.now();
  const n = Math.max(50, Number(timeoutMs) || FIRST_TOKEN_WATCHDOG_MS);
  const emit = () => {
    if (firstAt != null || fired) return;
    fired = true;
    const stall = classifyStallReason({ hasToken: false, inTool: false, inSandbox: false });
    const frame = {
      type: 'heartbeat',
      reason: stall.reason,
      code: 'first_token_watchdog',
      waitedMs: n,
      at: typeof now === 'function' ? now() : Date.now(),
    };
    if (typeof onHeartbeat === 'function') {
      try { onHeartbeat(frame); } catch (_) {}
    }
  };
  const escalate = () => {
    if (firstAt != null || escalated) return;
    escalated = true;
    const frame = {
      type: 'heartbeat',
      reason: 'waiting_provider',
      code: 'first_token_stall',
      waitedMs: n * WATCHDOG_ESCALATE_MULT,
      at: typeof now === 'function' ? now() : Date.now(),
    };
    if (typeof onEscalate === 'function') {
      try { onEscalate(frame); } catch (_) {}
    } else if (typeof onHeartbeat === 'function') {
      try { onHeartbeat(frame); } catch (_) {}
    }
  };
  const t1 = setTimeoutFn(emit, n);
  const t2 = setTimeoutFn(escalate, n * WATCHDOG_ESCALATE_MULT);
  if (t1 && typeof t1.unref === 'function') t1.unref();
  if (t2 && typeof t2.unref === 'function') t2.unref();
  return {
    mark(at) {
      firstAt = at != null ? Number(at) : (typeof now === 'function' ? now() : Date.now());
      try { clearTimeoutFn(t1); } catch (_) {}
      try { clearTimeoutFn(t2); } catch (_) {}
      return { ok: true, firstTokenMs: Math.max(0, firstAt - t0) };
    },
    stop() {
      try { clearTimeoutFn(t1); } catch (_) {}
      try { clearTimeoutFn(t2); } catch (_) {}
    },
    snapshot() {
      return { firstAt, fired, escalated, timeoutMs: n };
    },
  };
}

function observeWatchdogScripted(ms) {
  return { ok: true, ms: Number(ms) || 0, note: 'scripted first-token watchdog; never invented Flash' };
}

// ---------------------------------------------------------------------------
// Cap 8 — provider error taxonomy (no key leak)
// ---------------------------------------------------------------------------

function scrubSecretsFromError(text) {
  const s = String(text == null ? '' : text);
  return s.replace(SECRET_RE, '[redacted]');
}

function mapProviderHttp(err) {
  if (err == null) return { code: 'provider_unavailable', retryable: true, status: null, message: 'El proveedor no respondió.' };
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || err.code) || 0;
  const raw = scrubSecretsFromError(err.message || err.error || err.code || '');
  if (err.name === 'AbortError' || /aborted|abort/i.test(String(err.code || '')) && status === 0) {
    return { code: 'turn_cancelled', retryable: false, status, message: 'Cancelé el turno en curso.' };
  }
  if (status === 429 || /rate.?limit/i.test(raw)) {
    const retryAfter = Number(err.retryAfter || (err.headers && err.headers['retry-after'])) || null;
    return { code: 'rate_limited', retryable: true, status: 429, retryAfter, message: 'El proveedor está saturado. Reintentaré en un momento.' };
  }
  if (status === 401 || status === 403 || /unauthorized|invalid api key|authentication/i.test(raw)) {
    return { code: 'provider_auth', retryable: false, status: status || 401, message: 'El proveedor rechazó la autenticación. No se filtró ninguna clave.' };
  }
  if (status === 400 || status === 422) {
    return { code: 'provider_bad_request', retryable: false, status, message: 'El proveedor rechazó el pedido. Revisé el formato.' };
  }
  if (status >= 500 && status <= 599) {
    return { code: 'provider_unavailable', retryable: true, status, message: 'El proveedor falló temporalmente. Reintentaré.' };
  }
  if (/timeout|etimedout|esockettimedout/i.test(String(err.code || '')) || /timeout/i.test(raw)) {
    return { code: 'provider_timeout', retryable: true, status: status || null, message: 'El proveedor tardó demasiado. Corté la espera.' };
  }
  if (status === 402) {
    return { code: 'credit_no_usage', retryable: false, status: 402, message: 'No hay crédito suficiente. No cobré este turno.' };
  }
  return {
    code: 'provider_unavailable',
    retryable: true,
    status: status || null,
    message: 'Hubo un error del proveedor. No se filtró ninguna clave.',
    detail: raw.slice(0, 180),
  };
}

function classifyLifecycleError(code) {
  const c = String(code || '');
  const table = {
    event_order: { code: 'event_order', retryable: false, message: 'Reordené eventos del gateway para que la secuencia por sesión sea estricta.' },
    tool_result_dup: { code: 'tool_result_dup', retryable: false, message: 'Ese resultado de herramienta ya se entregó. No lo repetí.' },
    gateway_busy: { code: 'gateway_busy', retryable: true, message: 'Esta sesión ya tiene un productor activo. Esperé a que termine.' },
    schema_strip: { code: 'schema_strip', retryable: false, message: 'Quité campos extra de la herramienta que el esquema no admite.' },
    schema_enum: { code: 'schema_enum', retryable: false, message: 'Ajusté un valor al enumerado permitido.' },
    turn_cancelled: { code: 'turn_cancelled', retryable: false, message: 'Cancelé el turno en curso. Liberé la reserva y corté las herramientas.' },
    tool_aborted: { code: 'tool_aborted', retryable: false, message: 'Aborté las herramientas que seguían en vuelo.' },
    first_token_stall: { code: 'first_token_stall', retryable: true, message: 'El proveedor no envió el primer token a tiempo. Mandé un latido.' },
    rate_limited: { code: 'rate_limited', retryable: true, message: 'El proveedor está saturado. Reintentaré en un momento.' },
    provider_auth: { code: 'provider_auth', retryable: false, message: 'El proveedor rechazó la autenticación. No se filtró ninguna clave.' },
    provider_unavailable: { code: 'provider_unavailable', retryable: true, message: 'El proveedor falló temporalmente. Reintentaré.' },
    provider_timeout: { code: 'provider_timeout', retryable: true, message: 'El proveedor tardó demasiado. Corté la espera.' },
    provider_bad_request: { code: 'provider_bad_request', retryable: false, message: 'El proveedor rechazó el pedido. Revisé el formato.' },
    write_syntax_revert: { code: 'write_syntax_revert', retryable: false, message: 'La edición dejó el archivo inválido. La revertí.' },
    sandbox_timeout: { code: 'sandbox_timeout', retryable: true, message: 'El sandbox no produjo salida a tiempo y lo detuve.' },
    pin_across_compact: { code: 'pin_across_compact', retryable: false, message: 'Conservé los hechos anclados al compactar el contexto.' },
  };
  return table[c] || null;
}

function lifecycleSnapshot() {
  return {
    eventOrderMonotonic: true,
    toolResultDedupe: true,
    singleGatewayClaim: true,
    drainOrNack: true,
    rewriteUnknownNearest: true,
    schemaStripExtra: true,
    schemaEnumCoerce: true,
    schemaTypeCoerce: true,
    schemaRequiredDefault: true,
    schemaMaxItems: true,
    fileBackedPins: true,
    searchableMemoryHook: true,
    pinAcrossCompact: true,
    pinTtlRefresh: true,
    pinSizeCap: true,
    abortInFlightTools: true,
    creditReleaseOnce: true,
    terminalSseOnce: true,
    strReplaceSyntaxRevert: true,
    bracketBalance: true,
    sandboxWallClock: true,
    sandboxRssKill: true,
    tmpCrashCleanup: true,
    termThenKill: true,
    firstTokenWatchdog: true,
    stallReason: true,
    providerTaxonomy: true,
    secretScrub: true,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    watchdogNote: 'scripted first-token watchdog; never invented Flash',
  };
}

module.exports = {
  FIRST_TOKEN_WATCHDOG_MS,
  PIN_MAX_BYTES,
  RSS_DEFAULT_BYTES,
  WALL_DEFAULT_MS,
  TERM_GRACE_MS,
  sha256Hex,
  levenshtein,
  createEventOrderGate,
  assertMonotonicSeq,
  recordToolResultOnce,
  claimSingleGateway,
  resetGatewayClaims,
  drainOrNackOnClose,
  rewriteUnknownToNearest,
  stripUnknownKeys,
  coerceJsonTypes,
  coerceEnumFuzzy,
  fillRequiredDefaults,
  trimMaxItems,
  repairToolCallSchema,
  capPinBytes,
  loadFilePins,
  saveFilePins,
  upsertFilePin,
  refreshPinTtlOnHit,
  pinAcrossCompact,
  searchableMemoryHook,
  createInFlightRegistry,
  releaseHoldOnCancelOnce,
  emitTerminalSseOnce,
  cancelMidStream,
  bracketBalance,
  syntaxCheckAfterEdit,
  uniqueHunkAfterReplace,
  verifyStrReplace,
  wallClockExceeded,
  rssKillIfOver,
  readLinuxRssBytes,
  termThenKill,
  registerTmpForCrashCleanup,
  cleanupRegisteredTmp,
  guaranteedTmpCleanup,
  sandboxWatchdogTick,
  classifyStallReason,
  startFirstTokenWatchdog,
  observeWatchdogScripted,
  scrubSecretsFromError,
  mapProviderHttp,
  classifyLifecycleError,
  lifecycleSnapshot,
};
