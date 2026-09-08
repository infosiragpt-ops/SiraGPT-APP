'use strict';

/**
 * 3H29 — engine resilience layer for /chat + /code.
 *
 * Remaining holes after 3H28 (tool-storm / DAG / compact pairs / rollback N /
 * git dirty write+str_replace+edit / SSE drop / event seq):
 *   1  loop stall / idle-turn cut + subagent inherit parent remaining
 *   2  more malformed tool shapes (stringified args, empty name, dup id, orphan result)
 *   4  pin LRU keeps critical + recency/score tie-break; compact keeps system+pins
 *   5  exactly-once tool id across resume (in-flight marker)
 *   6  git dirty refuse on remaining writers (create_presentation/add_slide/set_slide_background)
 *   7  local sandbox isolation without new secrets (pg kill, ring, rlimit, nnp, tmp, idle)
 *   8  heartbeat while a long sandbox exec runs (tag inflight sandbox vs generate)
 *   9  per-session second turn waits; events do not interleave
 *  10  credit hold once per turn_id; storm cancel settles used + leftover
 *  11  public ES codes, never raw traces
 *  12  scripted p50/p95 tagged by inflight (never invented Flash)
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter. DeepSeek Flash/Pro only.
 * Interpreter stays `local`. Never claims gVisor/runsc unless actually used.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDLE_MS_DEFAULT = 45_000;
const RING_MAX_BYTES = 1024 * 1024;
const PIN_LRU_MAX = 12;
const RSS_BYTES_DEFAULT = 512 * 1024 * 1024;
const CPU_SEC_DEFAULT = 30;
const SANDBOX_IDLE_MS = 8_000;
const TMP_SWEEP_MAX_AGE_MS = 10 * 60 * 1000;
const TMP_MARKER_DIR = path.join(os.tmpdir(), 'siragpt-sandbox-reap');
const HB_GAP_MS = 5_000;
const TOKEN_CHARS = 4;

const inflightLatency = {
  generate: [],
  sandbox: [],
};

function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  return Math.ceil(Buffer.byteLength(s, 'utf8') / TOKEN_CHARS);
}

function percentile(samples, p) {
  const list = (Array.isArray(samples) ? samples : []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

function observeInflightMs(kind, ms) {
  const k = kind === 'sandbox' ? 'sandbox' : 'generate';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return snapshotInflightLatency();
  inflightLatency[k].push(n);
  if (inflightLatency[k].length > 200) inflightLatency[k].shift();
  return snapshotInflightLatency();
}

function snapshotInflightLatency() {
  return {
    generate: {
      count: inflightLatency.generate.length,
      p50: percentile(inflightLatency.generate, 50),
      p95: percentile(inflightLatency.generate, 95),
      note: 'scripted; never invented Flash',
    },
    sandbox: {
      count: inflightLatency.sandbox.length,
      p50: percentile(inflightLatency.sandbox, 50),
      p95: percentile(inflightLatency.sandbox, 95),
      note: 'scripted sandbox exec; never invented Flash',
    },
  };
}

function resetInflightLatency() {
  inflightLatency.generate = [];
  inflightLatency.sandbox = [];
}

// ---------------------------------------------------------------------------
// Cap 1 — loop stall / idle-turn cut + inherit parent remaining
// ---------------------------------------------------------------------------

function detectLoopStall({
  lastTokenAt = 0,
  lastToolResultAt = 0,
  startedAt = 0,
  now = Date.now(),
  idleMs = IDLE_MS_DEFAULT,
} = {}) {
  const idle = Math.max(250, Number(idleMs) || IDLE_MS_DEFAULT);
  const t = Number(now) || Date.now();
  const tokenAt = Number(lastTokenAt) || 0;
  const toolAt = Number(lastToolResultAt) || 0;
  const start = Number(startedAt) || 0;
  const last = Math.max(tokenAt, toolAt, start);
  const gap = last ? (t - last) : 0;
  const hasToken = tokenAt > 0;
  const hasTool = toolAt > 0;
  if (!last) return { stop: false, code: null, idleMs: 0, reason: 'no_clock' };
  if (gap >= idle && !hasToken && !hasTool) {
    return { stop: true, code: 'loop_stall', idleMs: gap, reason: 'no_token_no_tool' };
  }
  if (gap >= idle) {
    return { stop: true, code: 'loop_stall', idleMs: gap, reason: 'wall_idle' };
  }
  return { stop: false, code: null, idleMs: gap, remainingMs: idle - gap };
}

async function withIdleCut(promise, {
  idleMs = IDLE_MS_DEFAULT,
  signal = null,
  onStall = null,
} = {}) {
  const idle = Math.max(250, Number(idleMs) || IDLE_MS_DEFAULT);
  let timer = null;
  const stall = new Promise((resolve) => {
    timer = setTimeout(() => {
      const err = new Error('loop_stall');
      err.code = 'loop_stall';
      if (typeof onStall === 'function') {
        try { onStall(err); } catch (_) { /* never hang */ }
      }
      resolve({ stalled: true, error: err, code: 'loop_stall' });
    }, idle);
    // Keep the timer referenced so a hung generate cannot empty the event loop.
  });
  try {
    const raced = await Promise.race([
      Promise.resolve().then(() => promise).then((value) => ({ stalled: false, value })),
      stall,
    ]);
    if (raced && raced.stalled) return raced;
    return raced;
  } finally {
    try { if (timer) clearTimeout(timer); } catch (_) { /* ignore */ }
    void signal;
  }
}

function inheritParentRemaining({
  parentRemaining = 0,
  childRequested = null,
  childUsed = 0,
} = {}) {
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const used = Math.max(0, Number(childUsed) || 0);
  const leftover = Math.max(0, parent - used);
  let want = leftover;
  if (childRequested != null && childRequested !== '') {
    const r = Number(childRequested);
    if (Number.isFinite(r) && r >= 0) want = r;
  }
  const budget = Math.min(leftover, Math.max(0, want));
  if (parent <= 0 || leftover <= 0 || budget <= 0) {
    return { ok: false, budget: 0, leftover, parent, used, code: 'subagent_budget' };
  }
  if (budget > leftover) {
    return { ok: false, budget: leftover, leftover, parent, used, code: 'subagent_budget' };
  }
  return { ok: true, budget, leftover, parent, used, code: null };
}

// ---------------------------------------------------------------------------
// Cap 2 — malformed tool shapes
// ---------------------------------------------------------------------------

function parseMaybeJson(raw) {
  if (raw == null) return { ok: false, value: null };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, value: raw, repaired: false };
  const s = String(raw).trim();
  if (!s) return { ok: true, value: {}, repaired: false };
  try {
    const once = JSON.parse(s);
    if (typeof once === 'string') {
      try {
        const twice = JSON.parse(once);
        if (twice && typeof twice === 'object') return { ok: true, value: twice, repaired: true, doubleEncoded: true };
      } catch (_) { /* keep once */ }
    }
    if (once && typeof once === 'object') return { ok: true, value: once, repaired: typeof raw === 'string' };
    return { ok: true, value: { value: once }, repaired: true };
  } catch (_) {
    return { ok: false, value: { __parse_error: true, raw: s.slice(0, 500) }, code: 'tool_args_invalid' };
  }
}

function repairMalformedToolTurn(calls, results) {
  const list = Array.isArray(calls) ? calls.slice() : [];
  const out = [];
  const errors = [];
  const seenIds = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const src = list[i] && typeof list[i] === 'object' ? { ...list[i] } : {};
    const fn = src.function && typeof src.function === 'object' ? { ...src.function } : {};
    let name = String(fn.name || src.name || src.tool || '').trim();
    if (!name) {
      errors.push({ index: i, code: 'tool_name_empty', id: src.id || null });
      out.push({
        ...src,
        function: { name: '', arguments: fn.arguments || '{}' },
        __rejected: true,
        __code: 'tool_name_empty',
        id: String(src.id || `empty_${i}`),
      });
      continue;
    }
    const parsed = parseMaybeJson(fn.arguments != null ? fn.arguments : (src.arguments != null ? src.arguments : src.input));
    fn.name = name;
    fn.arguments = parsed.ok ? JSON.stringify(parsed.value) : String(fn.arguments || '{}');
    let id = String(src.id || `call_${i}`);
    if (seenIds.has(id)) {
      const next = `${id}__dup_${i}`;
      errors.push({ index: i, code: 'tool_id_duplicate', id, renamed: next });
      id = next;
      src.__code = 'tool_id_duplicate';
      src.__renamed = true;
    }
    seenIds.add(id);
    out.push({
      ...src,
      id,
      type: src.type || 'function',
      function: fn,
      __args: parsed.ok ? parsed.value : { __parse_error: true },
      __parse_error: !parsed.ok,
      __repaired: Boolean(parsed.repaired || src.__renamed),
    });
  }
  const orphans = [];
  const resultList = Array.isArray(results) ? results : [];
  for (const r of resultList) {
    const tid = String((r && (r.tool_call_id || r.id || r.callId)) || '');
    if (!tid || !seenIds.has(tid)) {
      orphans.push({ id: tid || null, code: 'tool_result_orphan' });
    }
  }
  const code = errors.find((e) => e.code === 'tool_name_empty')
    ? 'tool_name_empty'
    : (errors.find((e) => e.code === 'tool_id_duplicate')
      ? 'tool_id_duplicate'
      : (orphans.length ? 'tool_result_orphan' : (errors.length ? 'tool_args_invalid' : null)));
  return {
    ok: !errors.some((e) => e.code === 'tool_name_empty'),
    calls: out,
    errors,
    orphans,
    code,
  };
}

// ---------------------------------------------------------------------------
// Cap 4 — pin LRU keeps critical + recency/score; compact keeps system+pins
// ---------------------------------------------------------------------------

function pinRank(p) {
  const score = Number(p && p.score);
  const at = Number(p && (p.at || p.ts || p.updatedAt)) || 0;
  const pinned = Boolean(p && (p.critical || p.pinned || p.pin));
  return {
    critical: pinned,
    score: Number.isFinite(score) ? score : 0,
    at,
  };
}

function evictPinsKeepingCritical(pins, max = PIN_LRU_MAX) {
  const list = Array.isArray(pins) ? pins.slice() : [];
  const cap = Math.max(1, Number(max) || PIN_LRU_MAX);
  const critical = [];
  const rest = [];
  for (const p of list) {
    if (p && (p.critical || p.pinned || p.pin)) critical.push(p);
    else rest.push(p);
  }
  rest.sort((a, b) => {
    const ra = pinRank(a);
    const rb = pinRank(b);
    if (rb.score !== ra.score) return rb.score - ra.score;
    return rb.at - ra.at;
  });
  const kept = critical.slice();
  let evicted = 0;
  for (const p of rest) {
    if (kept.length < cap) kept.push(p);
    else evicted += 1;
  }
  if (critical.length > cap) {
    return {
      pins: critical.slice(),
      evicted: Math.max(0, list.length - critical.length),
      keptCritical: critical.length,
      code: 'pin_evict',
      overflowCritical: true,
    };
  }
  const code = evicted || list.length > kept.length ? 'pin_evict' : null;
  return { pins: kept, evicted: Math.max(0, list.length - kept.length), keptCritical: critical.length, code };
}

function scoreTieBreak(a, b) {
  const ra = pinRank(a);
  const rb = pinRank(b);
  if (ra.critical !== rb.critical) return ra.critical ? -1 : 1;
  if (rb.score !== ra.score) return rb.score - ra.score;
  return rb.at - ra.at;
}

function compactKeepingSystemAndPins(messages, { maxTokens = 4000, pins = [] } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const cap = Math.max(64, Number(maxTokens) || 4000);
  const system = [];
  const pinned = [];
  const rest = [];
  for (const m of list) {
    if (!m) continue;
    const content = String(m.content || '');
    if (m.role === 'system' && /PINNED FACTS/.test(content)) pinned.push(m);
    else if (m.role === 'system') system.push(m);
    else rest.push(m);
  }
  let pairs;
  try {
    pairs = require('./engine-completion').compactPreservingPairs(rest, { maxTokens: cap });
  } catch (_) {
    pairs = { messages: rest, compressed: rest.length > 8, code: null };
  }
  const facts = Array.isArray(pins) ? pins.filter((p) => p && (typeof p === 'string' ? p.trim() : (p.text || p.content))) : [];
  if (facts.length && !pinned.length) {
    const block = `[PINNED FACTS — do not drop]\n${facts.map((f) => `- ${String(typeof f === 'string' ? f : (f.text || f.content || '')).slice(0, 400)}`).join('\n')}`;
    pinned.push({ role: 'system', content: block });
  }
  const head = system.slice(0, 4).concat(pinned);
  const out = head.concat(pairs.messages || rest);
  const after = out.reduce((n, m) => n + estimateTokens(m && m.content || ''), 0);
  return {
    messages: out,
    compressed: Boolean(pairs.compressed) || out.length < list.length,
    beforeTokens: list.reduce((n, m) => n + estimateTokens(m && m.content || ''), 0),
    afterTokens: after,
    keptSystem: system.length,
    keptPins: pinned.length,
    code: 'compact_fidelity',
  };
}

// ---------------------------------------------------------------------------
// Cap 5 — exactly-once tool id (resume must not re-run a completed tool)
// ---------------------------------------------------------------------------

function createExactlyOnceToolStore(initial) {
  const done = new Map();
  const inflight = new Set();
  if (initial && typeof initial === 'object') {
    const recs = initial.done || initial;
    const entries = recs instanceof Map ? recs.entries() : Object.entries(recs || {});
    for (const [id, result] of entries) done.set(String(id), result);
  }
  return {
    markInFlight(toolId) {
      const id = String(toolId || '');
      if (!id) return { ok: false, code: 'tool_args_invalid' };
      if (done.has(id)) return { ok: false, skip: true, code: 'exactly_once_tool', result: done.get(id) };
      inflight.add(id);
      return { ok: true, skip: false, code: null, inflight: true };
    },
    recordResult(toolId, result) {
      const id = String(toolId || '');
      if (!id) return { ok: false, code: 'tool_args_invalid' };
      done.set(id, result);
      inflight.delete(id);
      return { ok: true, code: 'exactly_once_tool' };
    },
    shouldSkip(toolId) {
      const id = String(toolId || '');
      if (done.has(id)) {
        return { skip: true, code: 'exactly_once_tool', result: done.get(id) };
      }
      return { skip: false, code: null };
    },
    snapshot() {
      return {
        done: Object.fromEntries(done.entries()),
        inflight: [...inflight],
      };
    },
  };
}

function resumeSkipCompleted(store, toolId) {
  const st = store && typeof store.shouldSkip === 'function' ? store : createExactlyOnceToolStore(store);
  return st.shouldSkip(toolId);
}

// ---------------------------------------------------------------------------
// Cap 6 — git dirty remaining writers
// ---------------------------------------------------------------------------

const EXTRA_GIT_WRITERS = Object.freeze([
  'create_presentation',
  'add_slide',
  'set_slide_background',
  'create_file',
  'delete_file',
  'move_file',
  'notebook_edit',
]);

function assertGitCleanExtraWriter({ name, relPath, gitStatus = null } = {}) {
  const tool = String(name || '');
  if (!EXTRA_GIT_WRITERS.includes(tool) && !/create_presentation|add_slide|set_slide_background/.test(tool)) {
    return { ok: true, skipped: true, code: null };
  }
  try {
    return require('./engine-completion').assertGitCleanForWrite({ relPath, gitStatus });
  } catch (_) {
    if (typeof gitStatus !== 'function') return { ok: true, skipped: true, code: null };
    try {
      const status = gitStatus(relPath);
      const dirty = Boolean(status && (status.dirty || status.modified || status.unstaged));
      if (dirty) return { ok: false, code: 'git_apply_dirty', error: 'working tree sucio; no escribo' };
      return { ok: true, code: null };
    } catch (err) {
      return { ok: false, code: 'git_apply_dirty', error: String(err && err.message || err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Cap 7 — sandbox isolation (no new secrets, no fake gVisor)
// ---------------------------------------------------------------------------

function createByteRing(maxBytes = RING_MAX_BYTES) {
  const cap = Math.max(1, Number(maxBytes) || RING_MAX_BYTES);
  const chunks = [];
  let total = 0;
  let dropped = 0;
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk == null ? '' : chunk), 'utf8');
      if (!buf.length) return { bytes: total, dropped };
      chunks.push(buf);
      total += buf.length;
      while (total > cap && chunks.length) {
        const first = chunks.shift();
        total -= first.length;
        dropped += first.length;
      }
      return { bytes: total, dropped, truncated: dropped > 0 };
    },
    toString() {
      if (!chunks.length) return '';
      return Buffer.concat(chunks).toString('utf8');
    },
    snapshot() { return { bytes: total, dropped, cap, dropOldest: true }; },
  };
}

function hasPrlimit() {
  try {
    return fs.existsSync('/usr/bin/prlimit') || fs.existsSync('/bin/prlimit');
  } catch (_) { return false; }
}

function resolveSandboxLimits({ rssBytes = RSS_BYTES_DEFAULT, cpuSec = CPU_SEC_DEFAULT } = {}) {
  const rss = Math.max(16 * 1024 * 1024, Number(rssBytes) || RSS_BYTES_DEFAULT);
  const cpu = Math.max(1, Number(cpuSec) || CPU_SEC_DEFAULT);
  const prlimit = hasPrlimit();
  return {
    rssBytes: rss,
    cpuSec: cpu,
    method: prlimit ? 'prlimit' : 'rlimit_fallback',
    applied: false,
    usesRunsc: false,
    interpreter: 'local',
    noNewPrivs: process.platform === 'linux',
    umask: 0o077,
  };
}

function linuxSpawnHints() {
  const limits = resolveSandboxLimits();
  return {
    detached: process.platform !== 'win32',
    umask: limits.umask,
    noNewPrivs: limits.noNewPrivs,
    usesRunsc: false,
    interpreter: 'local',
    envScrub: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function pythonRlimitPreamble({ rssBytes = RSS_BYTES_DEFAULT, cpuSec = CPU_SEC_DEFAULT } = {}) {
  const rss = Math.max(16 * 1024 * 1024, Number(rssBytes) || RSS_BYTES_DEFAULT);
  const cpu = Math.max(1, Number(cpuSec) || CPU_SEC_DEFAULT);
  return `
import resource as _r, os as _os
try:
    _r.setrlimit(_r.RLIMIT_AS, (${rss}, ${rss}))
except Exception:
    pass
try:
    _r.setrlimit(_r.RLIMIT_CPU, (${cpu}, ${cpu}))
except Exception:
    pass
try:
    _os.umask(0o077)
except Exception:
    pass
try:
    if hasattr(_os, 'set_inheritable'):
        pass
except Exception:
    pass
del _r, _os
`.trimStart();
}

function killProcessGroup(pid, { kill = null, platform = process.platform } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, killed: false, code: 'pg_invalid' };
  const killer = typeof kill === 'function' ? kill : (id, sig) => {
    try { process.kill(id, sig || 'SIGKILL'); return true; } catch (_) { return false; }
  };
  const signals = [];
  if (platform !== 'win32') {
    signals.push(Boolean(killer(-n, 'SIGTERM')));
    signals.push(Boolean(killer(-n, 'SIGKILL')));
  }
  signals.push(Boolean(killer(n, 'SIGKILL')));
  const grandchildren = [];
  if (platform !== 'win32') {
    try {
      const proc = '/proc';
      if (fs.existsSync(proc)) {
        for (const name of fs.readdirSync(proc)) {
          if (!/^\d+$/.test(name)) continue;
          const child = Number(name);
          if (child === n) continue;
          try {
            const stat = fs.readFileSync(path.join(proc, name, 'stat'), 'utf8');
            const ppid = Number((stat.split(')')[1] || '').trim().split(/\s+/)[1]);
            if (ppid === n) {
              grandchildren.push(child);
              try { killer(child, 'SIGKILL'); } catch (_) { /* ignore */ }
              try { killer(-child, 'SIGKILL'); } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* /proc optional */ }
  }
  const killed = signals.some(Boolean) || grandchildren.length > 0;
  return {
    ok: true,
    killed,
    pid: n,
    grandchildren,
    code: killed ? 'pg_killed' : 'sandbox_timeout',
  };
}

function registerSandboxTmp(dir) {
  const d = String(dir || '');
  if (!d) return { ok: false, code: 'sandbox_cleanup' };
  try {
    fs.mkdirSync(TMP_MARKER_DIR, { recursive: true, mode: 0o700 });
    const marker = path.join(TMP_MARKER_DIR, `${path.basename(d)}.marker`);
    fs.writeFileSync(marker, JSON.stringify({ dir: d, at: Date.now() }), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, marker, code: null };
  } catch (err) {
    return { ok: false, code: 'sandbox_cleanup', error: String(err && err.message || err) };
  }
}

function cleanupSandboxTmp(dir) {
  const d = String(dir || '');
  if (d) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* swallow */ }
  }
  try {
    const marker = path.join(TMP_MARKER_DIR, `${path.basename(d)}.marker`);
    try { fs.unlinkSync(marker); } catch (_) { /* ignore */ }
  } catch (_) { /* ignore */ }
  return { ok: true, code: 'sandbox_cleanup' };
}

function sweepOrphanSandboxTmp({ maxAgeMs = TMP_SWEEP_MAX_AGE_MS, now = Date.now() } = {}) {
  const swept = [];
  try {
    if (!fs.existsSync(TMP_MARKER_DIR)) return { ok: true, swept, code: null };
    for (const name of fs.readdirSync(TMP_MARKER_DIR)) {
      const marker = path.join(TMP_MARKER_DIR, name);
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) { rec = null; }
      const at = Number(rec && rec.at) || 0;
      const dir = rec && rec.dir;
      if (!dir) {
        try { fs.unlinkSync(marker); } catch (_) { /* ignore */ }
        continue;
      }
      const ageCap = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs)) : TMP_SWEEP_MAX_AGE_MS;
      if (at && (now - at) < ageCap) continue;
      cleanupSandboxTmp(dir);
      swept.push(dir);
    }
  } catch (_) { /* optional */ }
  return { ok: true, swept, code: swept.length ? 'sandbox_cleanup' : null };
}

function detectIdleTimeout({ lastByteAt = 0, now = Date.now(), idleMs = SANDBOX_IDLE_MS } = {}) {
  const idle = Math.max(200, Number(idleMs) || SANDBOX_IDLE_MS);
  const last = Number(lastByteAt) || 0;
  const t = Number(now) || Date.now();
  if (!last) return { stop: false, code: null, reason: 'no_bytes_yet' };
  const gap = t - last;
  if (gap >= idle) return { stop: true, code: 'sandbox_timeout', idleMs: gap, reason: 'no_bytes' };
  return { stop: false, code: null, remainingMs: idle - gap };
}

function sandboxInterpreterMeta() {
  let runsc = false;
  try { runsc = fs.existsSync('/usr/bin/runsc') || fs.existsSync('/usr/local/bin/runsc'); } catch (_) { runsc = false; }
  return {
    interpreter: 'local',
    usesRunsc: false,
    runscPresent: runsc,
    note: 'gVisor runsc is the agent-runner docker driver, not this interpreter path',
  };
}

// ---------------------------------------------------------------------------
// Cap 8 — heartbeat while long sandbox exec runs
// ---------------------------------------------------------------------------

function startExecHeartbeat(onEvent, {
  intervalMs = HB_GAP_MS,
  kind = 'sandbox',
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (typeof onEvent !== 'function') return { stop() {}, beat() { return null; }, stopped: true, kind };
  let stopped = false;
  let seq = 0;
  const beat = () => {
    if (stopped) return null;
    seq += 1;
    const frame = {
      type: 'heartbeat',
      inflight: kind === 'sandbox' ? 'sandbox' : 'generate',
      at: now(),
      seq,
      code: 'sse_heartbeat',
    };
    try { onEvent(frame); } catch (_) { stop(); return null; }
    return frame;
  };
  const handle = setIntervalFn(beat, Math.max(500, Number(intervalMs) || HB_GAP_MS));
  if (handle && typeof handle.unref === 'function') handle.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    try { clearIntervalFn(handle); } catch (_) { /* ignore */ }
  }
  return { stop, beat, get stopped() { return stopped; }, get seq() { return seq; }, kind: kind === 'sandbox' ? 'sandbox' : 'generate' };
}

function tagHeartbeatInflight(frame, kind) {
  const src = frame && typeof frame === 'object' ? { ...frame } : { type: 'heartbeat' };
  src.type = 'heartbeat';
  src.inflight = kind === 'sandbox' ? 'sandbox' : 'generate';
  src.code = src.code || 'sse_heartbeat';
  return src;
}

// ---------------------------------------------------------------------------
// Cap 9 — per-session second turn waits; no event interleave
// ---------------------------------------------------------------------------

function createSessionTurnGate({ maxConcurrent = 1 } = {}) {
  const tails = new Map();
  const running = new Map();
  const events = new Map();
  const cap = Math.max(1, Number(maxConcurrent) || 1);
  return {
    async run(sessionId, operation) {
      const key = String(sessionId || '').trim() || 'anon';
      const inflight = running.get(key) || 0;
      const prev = tails.get(key) || Promise.resolve();
      const runPromise = prev.catch(() => {}).then(async () => {
        running.set(key, (running.get(key) || 0) + 1);
        try {
          return await operation({
            sessionId: key,
            emit: (ev) => this.emit(key, ev),
            busy: inflight >= cap,
            code: inflight >= cap ? 'session_busy' : null,
          });
        } finally {
          running.set(key, Math.max(0, (running.get(key) || 1) - 1));
          if ((running.get(key) || 0) === 0) running.delete(key);
        }
      });
      tails.set(key, runPromise.then(() => undefined, () => undefined));
      return runPromise;
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
      return {
        running: running.get(key) || 0,
        events: (events.get(key) || []).slice(),
        code: (running.get(key) || 0) > 0 ? 'session_busy' : null,
      };
    },
    assertNoInterleave(sessionId) {
      const snap = this.snapshot(sessionId);
      const seqs = snap.events.map((e) => Number(e.turnSeq) || 0);
      for (let i = 1; i < seqs.length; i += 1) {
        if (seqs[i] < seqs[i - 1]) return { ok: false, code: 'event_order' };
      }
      return { ok: true, events: snap.events, code: null };
    },
  };
}

const sharedSessionGate = createSessionTurnGate();
function getSharedSessionGate() { return sharedSessionGate; }

// ---------------------------------------------------------------------------
// Cap 10 — credit hold once per turn_id; storm cancel settle+release
// ---------------------------------------------------------------------------

function holdCreditsOnce(map, turnId, amount, createHold) {
  const st = map && typeof map.set === 'function' ? map : new Map();
  const id = String(turnId || '').trim();
  if (!id) {
    const hold = typeof createHold === 'function' ? createHold() : { reserve() { return { ok: true }; } };
    try { hold.reserve(amount); } catch (_) { /* optional */ }
    return { ok: true, reused: false, hold, code: null, anonymous: true };
  }
  if (st.has(id)) {
    return { ok: true, reused: true, hold: st.get(id), code: 'credit_hold_reuse' };
  }
  const hold = typeof createHold === 'function' ? createHold() : null;
  if (!hold || typeof hold.reserve !== 'function') {
    return { ok: false, reused: false, hold: null, code: 'credit_hold' };
  }
  const reserved = hold.reserve(amount);
  if (reserved && reserved.ok === false) return { ok: false, reused: false, hold, code: reserved.code || 'credit_hold' };
  st.set(id, hold);
  return { ok: true, reused: false, hold, code: null };
}

function settleStormCancel(hold, { used = 0, aborted = true } = {}) {
  if (!hold) return { ok: true, skipped: true, code: null };
  const n = Math.max(0, Number(used) || 0);
  let settled = null;
  let released = null;
  if (aborted && typeof hold.settle === 'function') {
    try { settled = hold.settle(n); } catch (_) { settled = { ok: false }; }
  }
  if (typeof hold.release === 'function') {
    try { released = hold.release(); } catch (_) { released = { ok: false }; }
  }
  const leftover = settled && settled.leftover != null
    ? settled.leftover
    : (released && released.released != null ? released.released : 0);
  return { ok: true, used: n, settled, released, leftover, code: 'credit_cancel' };
}

// ---------------------------------------------------------------------------
// Snapshot / classify helpers
// ---------------------------------------------------------------------------

function resilienceSnapshot() {
  return {
    loopStall: true,
    idleTurnCut: true,
    inheritParentRemaining: true,
    malformedToolShapes: true,
    pinKeepCritical: true,
    pinScoreTieBreak: true,
    compactKeepPins: true,
    exactlyOnceTool: true,
    gitDirtyExtraWriters: true,
    sandboxProcessGroup: true,
    sandboxByteRing: true,
    sandboxRlimitFallback: true,
    sandboxNoNewPrivs: true,
    sandboxTmpSweep: true,
    sandboxIdleTimeout: true,
    sandboxUsesRunsc: false,
    sandboxHeartbeat: true,
    sessionTurnWait: true,
    creditHoldOnce: true,
    creditStormCancel: true,
    inflightLatency: true,
    interpreter: 'local',
    openrouterGenerate: false,
    inflight: snapshotInflightLatency(),
    sandbox: sandboxInterpreterMeta(),
  };
}

function classifyResilienceError(code) {
  const c = String(code || '');
  const table = {
    loop_stall: { code: 'loop_stall', retryable: false, message: 'El bucle se quedó sin tokens ni resultados de herramientas. Lo detuve.' },
    sandbox_timeout: { code: 'sandbox_timeout', retryable: true, message: 'El sandbox no produjo salida a tiempo y lo detuve.' },
    tool_id_duplicate: { code: 'tool_id_duplicate', retryable: false, message: 'Había identificadores de herramienta duplicados en el mismo turno. Los reparé.' },
    tool_name_empty: { code: 'tool_name_empty', retryable: false, message: 'Una herramienta llegó sin nombre. No la ejecuté.' },
    tool_result_orphan: { code: 'tool_result_orphan', retryable: false, message: 'Llegó un resultado de herramienta sin llamada coincidente. Lo ignoré.' },
    session_busy: { code: 'session_busy', retryable: true, message: 'Hay otro turno de esta sesión en curso. Este espera su turno.' },
    pin_evict: { code: 'pin_evict', retryable: false, message: 'Quité recuerdos menos importantes del contexto y conservé los anclados.' },
    exactly_once_tool: { code: 'exactly_once_tool', retryable: false, message: 'Esa herramienta ya produjo un resultado. No la volví a ejecutar.' },
    credit_hold_reuse: { code: 'credit_hold_reuse', retryable: false, message: 'Reusé la reserva de créditos de este turno; no cobré dos veces.' },
    sandbox_cleanup: { code: 'sandbox_cleanup', retryable: false, message: 'Limpié directorios temporales del sandbox.' },
  };
  return table[c] || null;
}

try { sweepOrphanSandboxTmp(); } catch (_) { /* startup sweep best-effort */ }

module.exports = {
  IDLE_MS_DEFAULT,
  RING_MAX_BYTES,
  EXTRA_GIT_WRITERS,
  detectLoopStall,
  withIdleCut,
  inheritParentRemaining,
  parseMaybeJson,
  repairMalformedToolTurn,
  evictPinsKeepingCritical,
  scoreTieBreak,
  compactKeepingSystemAndPins,
  createExactlyOnceToolStore,
  resumeSkipCompleted,
  assertGitCleanExtraWriter,
  createByteRing,
  resolveSandboxLimits,
  linuxSpawnHints,
  pythonRlimitPreamble,
  killProcessGroup,
  registerSandboxTmp,
  cleanupSandboxTmp,
  sweepOrphanSandboxTmp,
  detectIdleTimeout,
  sandboxInterpreterMeta,
  startExecHeartbeat,
  tagHeartbeatInflight,
  createSessionTurnGate,
  getSharedSessionGate,
  holdCreditsOnce,
  settleStormCancel,
  observeInflightMs,
  snapshotInflightLatency,
  resetInflightLatency,
  resilienceSnapshot,
  classifyResilienceError,
};
