'use strict';

/**
 * 3H30 — engine correctness layer for /chat + /code.
 *
 * Remaining holes after 3H29 (sandbox isolation / loop stall / exactly-once /
 * session wait / credit hold-once):
 *   1  cancel-in-flight (turn_superseded) + nested stopWhen mid-child
 *   2  tool-result cap with stable hash footer; unknown tool + closest alias
 *   3  DAG cycle detect (dag_cycle) so waitDagReady cannot hang
 *   4  memory retrieve skips expired pins + foreign namespace; compact keeps last N tool-errors
 *   5  checkpoint write atomic (temp+rename); truncated file does not corrupt
 *   6  read-after-write unique-hunk compare → write_noop
 *   7  sandbox spawn fail classified sandbox_spawn; orphan tmp reaper on start
 *   8  SSE Last-Event-ID idempotent replay; heartbeat during tool execution
 *   9  out-of-order frames buffered then flushed in seq; nack/gap on missing id
 *  10  failed LLM HTTP 5xx with no usage object releases hold (credit_no_usage)
 *  11  public ES codes, never raw traces
 *  12  scripted cancel-to-idle p50/p95 (never invented Flash)
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter. DeepSeek Flash/Pro only.
 * Interpreter stays `local`. Do not invent HMAC/MCP/SANDBOX_NET_ALLOW secrets.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_RESULT_MAX_BYTES = 32 * 1024;
const HASH_FOOTER_BYTES = 96;
const LAST_TOOL_ERRORS = 3;
const TMP_SWEEP_MAX_AGE_MS = 10 * 60 * 1000;
const SANDBOX_TMP_PREFIXES = Object.freeze([
  path.join(os.tmpdir(), 'siragpt-sandbox'),
  path.join(os.tmpdir(), 'siragpt-sandbox-reap'),
  path.join(os.tmpdir(), 'sira-aw-'),
]);
const KNOWN_TOOLS = Object.freeze([
  'execute_bash', 'execute_python', 'read_file', 'write_file', 'str_replace',
  'edit_file', 'retrieve_memory', 'grep', 'apply_patch', 'create_presentation',
  'add_slide', 'set_slide_background', 'bash', 'shell', 'cat', 'write', 'read',
]);
const TOOL_ALIASES = Object.freeze({
  bash: 'execute_bash',
  shell: 'execute_bash',
  run: 'execute_bash',
  cmd: 'execute_bash',
  sh: 'execute_bash',
  read: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  save: 'write_file',
  memory: 'retrieve_memory',
  recall: 'retrieve_memory',
  patch: 'apply_patch',
  apply: 'apply_patch',
});

const cancelIdleSamples = [];

function percentile(samples, p) {
  const list = (Array.isArray(samples) ? samples : []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

function observeCancelToIdleMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return snapshotCancelToIdle();
  cancelIdleSamples.push(n);
  if (cancelIdleSamples.length > 200) cancelIdleSamples.shift();
  return snapshotCancelToIdle();
}

function snapshotCancelToIdle() {
  return {
    count: cancelIdleSamples.length,
    p50: percentile(cancelIdleSamples, 50),
    p95: percentile(cancelIdleSamples, 95),
    note: 'scripted cancel-to-idle; never invented Flash',
  };
}

function resetCancelToIdle() {
  cancelIdleSamples.length = 0;
}

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

// ---------------------------------------------------------------------------
// Cap 1 — cancel-in-flight + nested stopWhen mid-child
// ---------------------------------------------------------------------------

function stopWhenParentExhausted({
  parentRemaining = 0,
  childUsed = 0,
  midChild = false,
} = {}) {
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const used = Math.max(0, Number(childUsed) || 0);
  const leftover = Math.max(0, parent - used);
  if (parent <= 0 || leftover <= 0) {
    return {
      stop: true,
      ok: false,
      leftover: 0,
      parent,
      used,
      midChild: Boolean(midChild),
      code: 'subagent_budget',
      reason: midChild ? 'parent_exhausted_mid_child' : 'parent_exhausted',
    };
  }
  return { stop: false, ok: true, leftover, parent, used, midChild: Boolean(midChild), code: null };
}

function createCancellableSessionGate({ maxConcurrent = 1 } = {}) {
  const controllers = new Map();
  const running = new Map();
  const events = new Map();
  const tails = new Map();
  void maxConcurrent;
  return {
    async run(sessionId, operation, { supersede = true } = {}) {
      const key = String(sessionId || '').trim() || 'anon';
      const started = Date.now();
      const prevCtl = controllers.get(key);
      if (supersede && prevCtl && !prevCtl.signal.aborted) {
        try { prevCtl.abort('turn_superseded'); } catch (_) { /* ignore */ }
        observeCancelToIdleMs(Date.now() - started);
      }
      const ctl = typeof AbortController === 'function' ? new AbortController() : { abort() {}, signal: { aborted: false } };
      controllers.set(key, ctl);
      const prev = tails.get(key) || Promise.resolve();
      const runPromise = prev.catch(() => {}).then(async () => {
        if (ctl.signal.aborted) {
          return { ok: false, superseded: true, code: 'turn_superseded', skipped: true };
        }
        running.set(key, (running.get(key) || 0) + 1);
        try {
          return await operation({
            sessionId: key,
            signal: ctl.signal,
            abort: () => { try { ctl.abort('turn_superseded'); } catch (_) {} },
            emit: (ev) => this.emit(key, ev),
            code: null,
          });
        } finally {
          running.set(key, Math.max(0, (running.get(key) || 1) - 1));
          if ((running.get(key) || 0) === 0) running.delete(key);
          if (controllers.get(key) === ctl) controllers.delete(key);
        }
      });
      tails.set(key, runPromise.then(() => undefined, () => undefined));
      return runPromise;
    },
    cancel(sessionId, reason = 'turn_superseded') {
      const key = String(sessionId || '').trim() || 'anon';
      const ctl = controllers.get(key);
      const t0 = Date.now();
      if (ctl && !ctl.signal.aborted) {
        try { ctl.abort(reason); } catch (_) { /* ignore */ }
        observeCancelToIdleMs(Date.now() - t0);
        return { ok: true, code: 'turn_superseded', cancelled: true };
      }
      return { ok: true, cancelled: false, code: null };
    },
    emit(sessionId, ev) {
      const key = String(sessionId || '').trim() || 'anon';
      const list = events.get(key) || [];
      const stamped = { ...(ev && typeof ev === 'object' ? ev : { value: ev }), sessionId: key, at: Date.now(), turnSeq: list.length + 1 };
      list.push(stamped);
      events.set(key, list);
      return stamped;
    },
    snapshot(sessionId) {
      const key = String(sessionId || '').trim() || 'anon';
      const ctl = controllers.get(key);
      return {
        running: running.get(key) || 0,
        aborted: Boolean(ctl && ctl.signal && ctl.signal.aborted),
        events: (events.get(key) || []).slice(),
        code: (ctl && ctl.signal && ctl.signal.aborted) ? 'turn_superseded' : ((running.get(key) || 0) > 0 ? 'session_busy' : null),
      };
    },
  };
}

const sharedCancelGate = createCancellableSessionGate();
function getSharedCancelGate() { return sharedCancelGate; }

function classifyTurnSuperseded(signalOrErr) {
  if (!signalOrErr) return null;
  if (signalOrErr.aborted === true || signalOrErr.code === 'turn_superseded') {
    return { code: 'turn_superseded', retryable: false, message: 'Un mensaje nuevo canceló este turno. El anterior no se filtró.' };
  }
  const reason = signalOrErr.reason || signalOrErr.message || signalOrErr;
  if (String(reason) === 'turn_superseded' || /turn_superseded/.test(String(reason))) {
    return { code: 'turn_superseded', retryable: false, message: 'Un mensaje nuevo canceló este turno. El anterior no se filtró.' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cap 2 — tool result hash footer + unknown tool closest alias
// ---------------------------------------------------------------------------

function capToolResultWithHash(text, maxBytes = TOOL_RESULT_MAX_BYTES) {
  const s = text == null ? '' : String(text);
  const buf = Buffer.from(s, 'utf8');
  const cap = Math.max(64, Number(maxBytes) || TOOL_RESULT_MAX_BYTES);
  if (buf.length <= cap) {
    return { ok: true, text: s, truncated: false, bytes: buf.length, hash: sha256Hex(s), code: null };
  }
  const fullHash = sha256Hex(s);
  const footerBudget = Math.min(HASH_FOOTER_BYTES, Math.floor(cap / 4));
  const bodyCap = Math.max(16, cap - footerBudget);
  let cut = buf.subarray(0, bodyCap).toString('utf8');
  while (Buffer.byteLength(cut, 'utf8') > bodyCap && cut.length) cut = cut.slice(0, cut.length - 1);
  const restHash = sha256Hex(buf.subarray(bodyCap));
  const footer = `\n[truncated sha256=${fullHash.slice(0, 16)} rest=${restHash.slice(0, 16)} bytes=${buf.length} cap=${cap} — pide el resto con este hash]`;
  return {
    ok: false,
    text: `${cut}${footer}`,
    truncated: true,
    bytes: buf.length,
    cappedBytes: cap,
    hash: fullHash,
    restHash,
    code: 'tool_result_capped',
  };
}

function closestToolAlias(name, catalog = KNOWN_TOOLS) {
  const raw = String(name || '').trim();
  if (!raw) return { suggestion: null, distance: Infinity };
  const key = raw.toLowerCase();
  if (TOOL_ALIASES[key]) return { suggestion: TOOL_ALIASES[key], distance: 0, aliased: true };
  let best = null;
  let bestD = Infinity;
  const pool = Array.from(new Set([].concat(catalog || [], Object.keys(TOOL_ALIASES), Object.values(TOOL_ALIASES))));
  for (const cand of pool) {
    const c = String(cand || '').trim();
    if (!c) continue;
    const d = levenshtein(key, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const max = Math.max(2, Math.floor(key.length / 2));
  if (bestD > max) return { suggestion: null, distance: bestD };
  return { suggestion: TOOL_ALIASES[best] || best, distance: bestD };
}

function resolveUnknownTool(name, { executors = null, catalog = KNOWN_TOOLS } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return { ok: false, code: 'tool_unknown', name: raw, mapped: null, suggestion: null };
  const key = raw.toLowerCase();
  const aliased = TOOL_ALIASES[key] || raw;
  const has = (n) => {
    if (!n) return false;
    if (executors && typeof executors === 'object') {
      return typeof executors[n] === 'function' || Object.prototype.hasOwnProperty.call(executors, n);
    }
    return catalog.map((c) => String(c).toLowerCase()).includes(String(n).toLowerCase()) || Boolean(TOOL_ALIASES[String(n).toLowerCase()]);
  };
  if (has(aliased) || has(raw)) {
    return { ok: true, code: null, name: aliased, mapped: aliased, aliased: aliased !== raw, suggestion: null };
  }
  const close = closestToolAlias(raw, catalog.concat(executors ? Object.keys(executors) : []));
  return {
    ok: false,
    code: 'tool_unknown',
    name: raw,
    mapped: aliased,
    suggestion: close.suggestion,
    distance: close.distance,
    message: close.suggestion
      ? `Herramienta desconocida "${raw}". ¿Quisiste decir "${close.suggestion}"?`
      : `Herramienta desconocida "${raw}".`,
  };
}

// ---------------------------------------------------------------------------
// Cap 3 — DAG cycle detect
// ---------------------------------------------------------------------------

function detectDagCycle(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const nodes = new Map();
  for (const t of list) {
    const id = String((t && (t.id || t.name)) || '');
    if (!id) continue;
    const deps = Array.isArray(t && (t.deps || t.dependsOn)) ? (t.deps || t.dependsOn).map(String) : [];
    nodes.set(id, deps);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  let found = null;
  function dfs(id) {
    if (found) return;
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      found = { cycle: true, path: stack.slice(idx).concat(id), code: 'dag_cycle' };
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const d of (nodes.get(id) || [])) {
      if (!nodes.has(d) && !visiting.has(d)) continue;
      dfs(d);
      if (found) return;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) dfs(id);
  if (found) return found;
  return { cycle: false, path: [], code: null };
}

function waitDagReadySafe(tasks, doneIds) {
  const cycle = detectDagCycle(tasks);
  if (cycle.cycle) {
    return { ok: false, ready: [], blocked: [], code: 'dag_cycle', cycle: cycle.path };
  }
  try {
    return require('./engine-completion').waitDagReady(tasks, doneIds);
  } catch (_) {
    const list = Array.isArray(tasks) ? tasks : [];
    const done = new Set((doneIds || []).map(String));
    const ready = [];
    const blocked = [];
    for (const t of list) {
      const id = String((t && (t.id || t.name)) || '');
      if (!id || done.has(id)) continue;
      const deps = Array.isArray(t && (t.deps || t.dependsOn)) ? (t.deps || t.dependsOn) : [];
      const waitingOn = deps.map(String).filter((d) => d && !done.has(d));
      if (waitingOn.length) blocked.push({ id, waitingOn });
      else ready.push(id);
    }
    if (!ready.length && blocked.length) return { ok: false, ready, blocked, code: 'dag_blocked' };
    return { ok: true, ready, blocked, code: blocked.length ? 'dag_wait' : null };
  }
}

// ---------------------------------------------------------------------------
// Cap 4 — expired pins, namespace ACL, compact keep last N tool-errors
// ---------------------------------------------------------------------------

function isPinExpired(pin, now = Date.now()) {
  if (!pin || typeof pin !== 'object') return false;
  const t = Number(now) || Date.now();
  if (pin.expired === true) return true;
  const exp = pin.expiresAt != null ? Number(pin.expiresAt) : (pin.expiry != null ? Number(pin.expiry) : null);
  if (Number.isFinite(exp) && exp > 0) {
    if (t > 1e12 && exp < 1e12) return (exp * 1000) <= t;
    return exp <= t;
  }
  const ttl = pin.ttlMs != null ? Number(pin.ttlMs) : (pin.ttl != null ? Number(pin.ttl) : null);
  const at = Number(pin.at || pin.ts || pin.createdAt || pin.updatedAt) || 0;
  if (Number.isFinite(ttl) && ttl >= 0 && at && (t - at) >= ttl) return true;
  return false;
}

function retrieveSkipExpiredPins(hits, now = Date.now()) {
  const list = Array.isArray(hits) ? hits : [];
  const kept = [];
  const expired = [];
  for (const h of list) {
    if (isPinExpired(h, now)) expired.push(h);
    else kept.push(h);
  }
  return { hits: kept, pins: kept, expired: expired.length, code: expired.length ? 'pin_evict' : null };
}

function filterMemoryAclNamespace(hits, { userId = null, namespace = null } = {}) {
  const uid = String(userId || '').trim();
  const ns = String(namespace || uid || '').trim();
  const list = Array.isArray(hits) ? hits : [];
  const kept = [];
  let denied = 0;
  for (const h of list) {
    if (h == null) continue;
    if (typeof h !== 'object') {
      if (uid) kept.push(h);
      else denied += 1;
      continue;
    }
    const owner = h.userId || h.user_id || h.ownerId || h.owner_id || '';
    const space = h.namespace || h.ns || h.tenant || '';
    if (owner && uid && String(owner) !== uid) { denied += 1; continue; }
    if (space && ns && String(space) !== ns) { denied += 1; continue; }
    if (space && uid && !ns && String(space) !== uid) { denied += 1; continue; }
    if (owner && !uid) { denied += 1; continue; }
    kept.push(h);
  }
  return { hits: kept, pins: kept, denied, code: denied ? 'memory_acl_denied' : null };
}

function isToolErrorMessage(m) {
  if (!m) return false;
  const role = String(m.role || '');
  const content = String(m.content || '');
  if (role === 'tool' && /^ERROR[:\s]/i.test(content)) return true;
  if (role === 'tool' && /\b(tool_unknown|tool_timeout|tool_isolated|schema_invalid)\b/.test(content)) return true;
  if (m.isError || m.error === true) return true;
  return false;
}

function compactKeepLastToolErrors(compacted, original, { keep = LAST_TOOL_ERRORS } = {}) {
  const out = Array.isArray(compacted) ? compacted.slice() : [];
  const src = Array.isArray(original) ? original : [];
  const n = Math.max(0, Number(keep) || LAST_TOOL_ERRORS);
  const errors = src.filter(isToolErrorMessage);
  const last = errors.slice(-n);
  const seen = new Set(out.map((m) => `${m && m.role}:${String(m && m.content || '').slice(0, 80)}`));
  for (const e of last) {
    const key = `${e.role}:${String(e.content || '').slice(0, 80)}`;
    if (seen.has(key)) continue;
    out.push(e);
    seen.add(key);
  }
  return {
    messages: out,
    keptToolErrors: last.length,
    code: last.length ? 'compact_fidelity' : null,
  };
}

// ---------------------------------------------------------------------------
// Cap 5 — atomic checkpoint write (temp + rename)
// ---------------------------------------------------------------------------

function atomicCheckpointWrite(filePath, rec, {
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
  unlinkSync = fs.unlinkSync,
  mkdirSync = fs.mkdirSync,
} = {}) {
  const dest = String(filePath || '');
  if (!dest || dest.includes('\0')) return { ok: false, code: 'path_traversal' };
  const dir = path.dirname(dest);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { /* may exist */ }
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(rec && typeof rec === 'object' ? rec : { value: rec });
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, dest);
    return { ok: true, path: dest, code: null, bytes: Buffer.byteLength(body, 'utf8') };
  } catch (err) {
    try { unlinkSync(tmp); } catch (_) { /* leftover tmp */ }
    return { ok: false, code: 'ckpt_cas', error: String(err && err.message || err) };
  }
}

function readCheckpointFile(filePath, { readFileSync = fs.readFileSync } = {}) {
  const dest = String(filePath || '');
  if (!dest) return { ok: false, rec: null, code: 'checkpoint_missing' };
  let raw;
  try { raw = readFileSync(dest, 'utf8'); } catch (err) {
    return { ok: false, rec: null, code: 'checkpoint_missing', error: String(err && err.message || err) };
  }
  if (!raw || !String(raw).trim()) return { ok: false, rec: null, code: 'checkpoint_corrupt', truncated: true };
  try {
    const rec = JSON.parse(String(raw));
    if (!rec || typeof rec !== 'object') return { ok: false, rec: null, code: 'checkpoint_corrupt' };
    return { ok: true, rec, code: null };
  } catch (_) {
    return { ok: false, rec: null, code: 'checkpoint_corrupt', truncated: true };
  }
}

// ---------------------------------------------------------------------------
// Cap 6 — read-after-write unique hunk compare → write_noop
// ---------------------------------------------------------------------------

function uniqueHunkEqual(before, after, hunk = null) {
  const b = before == null ? '' : String(before);
  const a = after == null ? '' : String(after);
  if (hunk && typeof hunk === 'object') {
    const oldH = hunk.old != null ? String(hunk.old) : (hunk.previous != null ? String(hunk.previous) : null);
    const newH = hunk.new != null ? String(hunk.new) : (hunk.next != null ? String(hunk.next) : null);
    if (oldH != null && newH != null && oldH === newH) return true;
    if (oldH != null && newH != null && a === b) return true;
  }
  return a === b;
}

function readAfterWriteCompare({ before = '', after = '', hunk = null } = {}) {
  if (uniqueHunkEqual(before, after, hunk)) {
    return { ok: false, changed: false, noop: true, code: 'write_noop' };
  }
  return { ok: true, changed: true, noop: false, code: null };
}

async function writeWithNoopDetect(args = {}) {
  const integ = (() => { try { return require('./engine-integrity'); } catch (_) { return null; } })();
  const before = args.before != null ? args.before : null;
  const body = args.content == null ? '' : String(args.content);
  if (before != null && uniqueHunkEqual(before, body, args.hunk || { old: before, new: body })) {
    return { ok: false, code: 'write_noop', wrote: false, noop: true, reverted: false };
  }
  let out;
  if (integ && typeof integ.writeWithSyntaxRevert === 'function') {
    out = await integ.writeWithSyntaxRevert(args);
  } else {
    if (typeof args.writeFile === 'function') await args.writeFile(args.relPath, body);
    out = { ok: true, wrote: true, code: null, reverted: false };
  }
  if (out && out.ok && typeof args.readFile === 'function') {
    let after;
    try { after = await args.readFile(args.relPath); } catch (_) { after = body; }
    const cmp = readAfterWriteCompare({ before: before == null ? '' : before, after, hunk: args.hunk || { old: before, new: body } });
    if (cmp.noop) return { ok: false, code: 'write_noop', wrote: true, noop: true, reverted: false };
  } else if (out && out.ok && before != null && uniqueHunkEqual(before, body, args.hunk)) {
    return { ok: false, code: 'write_noop', wrote: true, noop: true, reverted: false };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cap 7 — sandbox spawn classify + orphan tmp reaper
// ---------------------------------------------------------------------------

function classifySandboxSpawn(err) {
  if (!err) return { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' };
  const code = String(err.code || err.errno || '');
  const msg = String(err.message || err);
  if (code === 'sandbox_spawn' || code === 'sandbox_spawn_failed') {
    return { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' };
  }
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || /spawn.*(enoent|failed)/i.test(msg)) {
    return { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' };
  }
  return { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' };
}

function orphanTmpReaperOnStart({
  now = Date.now(),
  maxAgeMs = TMP_SWEEP_MAX_AGE_MS,
  tmpDir = os.tmpdir(),
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  rmSync = fs.rmSync,
  prefixes = null,
} = {}) {
  const swept = [];
  const ageCap = Math.max(0, Number(maxAgeMs) || TMP_SWEEP_MAX_AGE_MS);
  const t = Number(now) || Date.now();
  const names = [];
  try { names.push(...readdirSync(tmpDir)); } catch (_) { return { ok: true, swept, code: null }; }
  const pref = Array.isArray(prefixes) && prefixes.length
    ? prefixes
    : ['siragpt-sandbox', 'sira-aw-', 'siragpt-ckpt-'];
  for (const name of names) {
    const hit = pref.some((p) => String(name).startsWith(String(p).split(/[/\\]/).pop() || p) || String(name).includes('siragpt-sandbox') || String(name).startsWith('sira-aw-') || String(name).startsWith('siragpt-ckpt-'));
    if (!hit && !/^siragpt-sandbox/.test(name) && !/^sira-aw-/.test(name) && !/^siragpt-ckpt-/.test(name)) continue;
    const full = path.join(tmpDir, name);
    let st;
    try { st = statSync(full); } catch (_) { continue; }
    const mtime = Number(st.mtimeMs || (st.mtime && st.mtime.getTime && st.mtime.getTime()) || 0);
    if (mtime && (t - mtime) < ageCap) continue;
    try { rmSync(full, { recursive: true, force: true }); swept.push(full); } catch (_) { /* ignore */ }
  }
  try {
    const resil = require('./engine-resilience');
    if (resil && typeof resil.sweepOrphanSandboxTmp === 'function') {
      const extra = resil.sweepOrphanSandboxTmp({ maxAgeMs: ageCap, now: t });
      if (extra && Array.isArray(extra.swept)) for (const d of extra.swept) if (!swept.includes(d)) swept.push(d);
    }
  } catch (_) { /* optional */ }
  return { ok: true, swept, code: swept.length ? 'sandbox_cleanup' : null };
}

try { orphanTmpReaperOnStart(); } catch (_) { /* startup reaper best-effort */ }

// ---------------------------------------------------------------------------
// Cap 8 — SSE idempotent replay + tool heartbeat
// ---------------------------------------------------------------------------

function sseIdempotentReplay(frames, lastEventId) {
  const list = Array.isArray(frames) ? frames : [];
  const last = Math.max(0, Number(lastEventId) || 0);
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const f of list) {
    const seq = Number(f && (f.seq != null ? f.seq : f.id));
    if (!Number.isFinite(seq) || seq <= 0) continue;
    if (seq <= last) { duplicates += 1; continue; }
    if (seen.has(seq)) { duplicates += 1; continue; }
    seen.add(seq);
    out.push(f);
  }
  out.sort((a, b) => Number(a.seq != null ? a.seq : a.id) - Number(b.seq != null ? b.seq : b.id));
  return {
    frames: out,
    nextSeq: out.length ? Number(out[out.length - 1].seq != null ? out[out.length - 1].seq : out[out.length - 1].id) : last,
    duplicates,
    code: duplicates ? 'sse_duplicate' : null,
  };
}

function startToolHeartbeat(onEvent, {
  intervalMs = 5_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (typeof onEvent !== 'function') return { stop() {}, beat() { return null; }, stopped: true, kind: 'tool' };
  let stopped = false;
  let seq = 0;
  const beat = () => {
    if (stopped) return null;
    seq += 1;
    const frame = { type: 'heartbeat', inflight: 'tool', at: now(), seq, code: 'sse_heartbeat' };
    try { onEvent(frame); } catch (_) { stop(); return null; }
    return frame;
  };
  const handle = setIntervalFn(beat, Math.max(500, Number(intervalMs) || 5_000));
  if (handle && typeof handle.unref === 'function') handle.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    try { clearIntervalFn(handle); } catch (_) { /* ignore */ }
  }
  return { stop, beat, get stopped() { return stopped; }, get seq() { return seq; }, kind: 'tool' };
}

function tagHeartbeatInflight(frame, kind) {
  const src = frame && typeof frame === 'object' ? { ...frame } : { type: 'heartbeat' };
  src.type = 'heartbeat';
  src.inflight = kind === 'sandbox' ? 'sandbox' : (kind === 'tool' ? 'tool' : 'generate');
  src.code = src.code || 'sse_heartbeat';
  return src;
}

// ---------------------------------------------------------------------------
// Cap 9 — out-of-order buffer then flush; nack/gap
// ---------------------------------------------------------------------------

function createFrameSequencer(startSeq = 0) {
  let next = Math.max(0, Number(startSeq) || 0) + 1;
  const buf = new Map();
  return {
    push(frame) {
      const src = frame && typeof frame === 'object' ? { ...frame } : { value: frame };
      const seq = Number(src.seq != null ? src.seq : src.id);
      if (!Number.isFinite(seq) || seq <= 0) {
        src.seq = next;
        const flushed = [src];
        next += 1;
        return { flushed, buffered: buf.size, code: null };
      }
      if (seq < next) {
        return { flushed: [], buffered: buf.size, duplicate: true, code: 'sse_duplicate' };
      }
      if (seq === next) {
        const flushed = [src];
        next += 1;
        while (buf.has(next)) {
          flushed.push(buf.get(next));
          buf.delete(next);
          next += 1;
        }
        return { flushed, buffered: buf.size, code: null };
      }
      buf.set(seq, src);
      return { flushed: [], buffered: buf.size, code: 'event_order' };
    },
    nack(missingId) {
      const want = Number(missingId);
      if (!Number.isFinite(want) || want <= 0) {
        return { ok: false, code: 'sse_gap', missing: [] };
      }
      if (want >= next || buf.has(want)) {
        return { ok: false, code: 'sse_gap', missing: [want], nack: true };
      }
      return { ok: true, code: null, missing: [] };
    },
    snapshot() {
      return { next, buffered: [...buf.keys()].sort((a, b) => a - b) };
    },
  };
}

function nackGap(frames, lastId, requestedId) {
  const list = Array.isArray(frames) ? frames : [];
  const want = Number(requestedId);
  const last = Math.max(0, Number(lastId) || 0);
  if (!Number.isFinite(want) || want <= 0) return { ok: false, code: 'sse_gap', missing: [], nack: true };
  const have = new Set(list.map((f) => Number(f && (f.seq != null ? f.seq : f.id))).filter((n) => Number.isFinite(n) && n > 0));
  if (want <= last) return { ok: true, code: 'sse_duplicate', duplicate: true, missing: [] };
  if (!have.has(want)) return { ok: false, code: 'sse_gap', missing: [want], nack: true };
  return { ok: true, code: null, missing: [] };
}

// ---------------------------------------------------------------------------
// Cap 10 — 5xx LLM without usage object → release hold, do not settle used
// ---------------------------------------------------------------------------

function hasUsageObject(responseOrErr) {
  const src = responseOrErr || {};
  const u = src.usage || src.token_usage || (src.response && src.response.usage) || null;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  const keys = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'promptTokens', 'completionTokens', 'totalTokens'];
  return keys.some((k) => u[k] != null && Number.isFinite(Number(u[k])));
}

function httpStatusOf(responseOrErr) {
  const src = responseOrErr || {};
  return Number(src.status || src.statusCode || src.httpStatus || (src.response && src.response.status) || NaN);
}

function creditOnLlmFailure(responseOrErr, hold) {
  const status = httpStatusOf(responseOrErr);
  const has = hasUsageObject(responseOrErr);
  if (status >= 500 && status <= 599 && !has) {
    let released = null;
    if (hold && typeof hold.release === 'function') {
      try { released = hold.release(); } catch (_) { released = { ok: false }; }
    }
    return {
      ok: true,
      settle: false,
      used: 0,
      releaseHold: true,
      released,
      code: 'credit_no_usage',
    };
  }
  return { ok: true, settle: true, releaseHold: false, used: null, code: null };
}

function extractUsageOrRelease(response, hold) {
  const gate = creditOnLlmFailure(response, hold);
  if (gate.code === 'credit_no_usage') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, settle: false, code: 'credit_no_usage' };
  }
  try {
    const u = require('./engine-reliability').extractUsage(response);
    return { ...u, totalTokens: (u.promptTokens || 0) + (u.completionTokens || 0), settle: true, code: null };
  } catch (_) {
    const raw = (response && (response.usage || response.token_usage)) || {};
    const prompt = Number(raw.prompt_tokens || raw.input_tokens || 0) || 0;
    const completion = Number(raw.completion_tokens || raw.output_tokens || 0) || 0;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, settle: true, code: null };
  }
}

// ---------------------------------------------------------------------------
// Snapshot / classify
// ---------------------------------------------------------------------------

function correctnessSnapshot() {
  return {
    turnSuperseded: true,
    cancelInFlight: true,
    stopWhenMidChild: true,
    toolResultHashFooter: true,
    toolUnknownAlias: true,
    dagCycle: true,
    pinTtlSkip: true,
    memoryNamespaceAcl: true,
    compactKeepToolErrors: true,
    atomicCheckpoint: true,
    writeNoop: true,
    sandboxSpawn: true,
    orphanTmpReaper: true,
    sseIdempotentReplay: true,
    toolHeartbeat: true,
    frameReorderBuffer: true,
    nackGap: true,
    creditNoUsage: true,
    cancelToIdle: true,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    cancelIdle: snapshotCancelToIdle(),
  };
}

function classifyCorrectnessError(code) {
  const c = String(code || '');
  const table = {
    turn_superseded: { code: 'turn_superseded', retryable: false, message: 'Un mensaje nuevo canceló este turno. El anterior no se filtró.' },
    tool_unknown: { code: 'tool_unknown', retryable: false, message: 'No reconozco esa herramienta. Te sugerí la más cercana.' },
    dag_cycle: { code: 'dag_cycle', retryable: false, message: 'El plan tiene una dependencia circular. Lo detuve para que no se cuelgue.' },
    write_noop: { code: 'write_noop', retryable: false, message: 'La escritura no cambió el archivo. No la cuento como éxito.' },
    sandbox_spawn: { code: 'sandbox_spawn', retryable: true, message: 'No pude arrancar el sandbox.' },
    sse_duplicate: { code: 'sse_duplicate', retryable: false, message: 'Ese evento ya se entregó. No lo repetí.' },
    credit_no_usage: { code: 'credit_no_usage', retryable: true, message: 'El proveedor falló sin reportar uso. Liberé la reserva; no cobré tokens.' },
    checkpoint_corrupt: { code: 'checkpoint_corrupt', retryable: false, message: 'El punto de restauración estaba incompleto. No lo usé.' },
  };
  return table[c] || null;
}

module.exports = {
  TOOL_RESULT_MAX_BYTES,
  LAST_TOOL_ERRORS,
  KNOWN_TOOLS,
  TOOL_ALIASES,
  stopWhenParentExhausted,
  createCancellableSessionGate,
  getSharedCancelGate,
  classifyTurnSuperseded,
  capToolResultWithHash,
  closestToolAlias,
  resolveUnknownTool,
  detectDagCycle,
  waitDagReadySafe,
  isPinExpired,
  retrieveSkipExpiredPins,
  filterMemoryAclNamespace,
  isToolErrorMessage,
  compactKeepLastToolErrors,
  atomicCheckpointWrite,
  readCheckpointFile,
  uniqueHunkEqual,
  readAfterWriteCompare,
  writeWithNoopDetect,
  classifySandboxSpawn,
  orphanTmpReaperOnStart,
  sseIdempotentReplay,
  startToolHeartbeat,
  tagHeartbeatInflight,
  createFrameSequencer,
  nackGap,
  hasUsageObject,
  creditOnLlmFailure,
  extractUsageOrRelease,
  observeCancelToIdleMs,
  snapshotCancelToIdle,
  resetCancelToIdle,
  correctnessSnapshot,
  classifyCorrectnessError,
  sha256Hex,
  levenshtein,
};
