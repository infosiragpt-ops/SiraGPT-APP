'use strict';

/**
 * 3H28 — engine completion layer for /chat + /code.
 *
 * Remaining holes after 3H27:
 *   1  tool-storm cap + leftover results so the loop still completes
 *   2  malformed/partial tool-call on ReAct fences + extra shapes
 *   3  DAG wait at runtime (never run a blocked node)
 *   4  compact preserving assistant/tool pairs
 *   5  checkpoint rollback N-deep (pop, then restore previous)
 *   6  git dirty refuse on write_file / str_replace / edit_file
 *   8  SSE drop-under-load (do not stall the producer)
 *   9  gateway per-session monotonic event seq
 *  12  concurrent-turn p50/p95 (scripted, never invented Flash)
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter. DeepSeek Flash/Pro only.
 */

const crypto = require('crypto');

const STORM_MAX = 8;
const STORM_PARALLEL = 4;
const SSE_HIGH_WATER = 64;
const ROLLBACK_MAX = 8;
const TOKEN_CHARS = 4;

const concurrentTurns = {
  inflight: 0,
  samples: [],
  byBucket: { 1: [], 2: [], 4: [], 8: [] },
};

function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  return Math.ceil(Buffer.byteLength(s, 'utf8') / TOKEN_CHARS);
}

function capToolStorm(calls, { max = STORM_MAX } = {}) {
  const list = Array.isArray(calls) ? calls.slice() : [];
  const cap = Math.max(1, Math.min(40, Number(max) || STORM_MAX));
  if (list.length <= cap) {
    return { keep: list, overflow: [], dropped: 0, code: null };
  }
  return {
    keep: list.slice(0, cap),
    overflow: list.slice(cap),
    dropped: list.length - cap,
    code: 'tool_storm',
  };
}

function stormOverflowResult(prepared) {
  const name = (prepared && (prepared.mapped
    || (prepared.call && prepared.call.function && prepared.call.function.name))) || 'tool';
  return {
    prepared,
    result: `ERROR: tool_storm: demasiadas herramientas en este turno (${name}). Reintenta en el siguiente.`,
    f7Image: null,
    overflow: true,
    code: 'tool_storm',
  };
}

async function runToolStorm(preparedAll, executePrepared, { maxParallel = STORM_PARALLEL, maxBatch = STORM_MAX } = {}) {
  const jobs = Array.isArray(preparedAll) ? preparedAll : [];
  const exec = typeof executePrepared === 'function'
    ? executePrepared
    : async () => ({ result: 'ERROR: missing executor' });
  const storm = capToolStorm(jobs, { max: maxBatch });
  const keep = storm.keep;
  const overflow = storm.overflow.map(stormOverflowResult);
  const parallel = Math.max(1, Math.min(16, Number(maxParallel) || STORM_PARALLEL));
  const out = [];
  for (let i = 0; i < keep.length; i += parallel) {
    const slice = keep.slice(i, i + parallel);
    const settled = await Promise.allSettled(slice.map((p) => Promise.resolve().then(() => exec(p))));
    for (let j = 0; j < settled.length; j += 1) {
      const s = settled[j];
      if (s.status === 'fulfilled') {
        out.push(s.value);
      } else {
        const msg = s.reason && (s.reason.message || s.reason.code)
          ? String(s.reason.message || s.reason.code)
          : 'isolated';
        out.push({
          prepared: slice[j],
          result: `ERROR: tool_isolated: ${msg}`,
          f7Image: null,
          isolated: true,
          code: 'tool_isolated',
        });
      }
    }
  }
  return { executed: out.concat(overflow), dropped: storm.dropped, code: storm.code, parallel };
}

function normalizePartialToolCall(call, iteration, idx) {
  const src = call && typeof call === 'object' ? call : {};
  const fn = src.function && typeof src.function === 'object' ? src.function : {};
  let name = String(fn.name || src.name || src.tool || src.tool_name || '').trim();
  let argsRaw = fn.arguments;
  if (argsRaw == null) argsRaw = src.arguments != null ? src.arguments : src.args;
  if (argsRaw == null) argsRaw = src.input != null ? src.input : src.params;
  if (argsRaw == null && src.delta && typeof src.delta === 'object') {
    const d = src.delta.function || src.delta;
    if (!name) name = String(d.name || '').trim();
    if (argsRaw == null) argsRaw = d.arguments;
  }
  if (typeof argsRaw === 'object' && argsRaw && !Array.isArray(argsRaw) && !argsRaw.__parse_error) {
    argsRaw = JSON.stringify(argsRaw);
  }
  let repaired;
  try {
    repaired = require('./engine-reliability').repairToolArgs(argsRaw);
  } catch (_) {
    try {
      repaired = { ok: true, value: JSON.parse(String(argsRaw || '{}')), repaired: false };
    } catch (_) {
      repaired = { ok: false, value: { __parse_error: true, raw: String(argsRaw || '').slice(0, 500) } };
    }
  }
  if (!name) name = 'unknown';
  return {
    id: String(src.id || `call_${iteration}_${idx}`),
    type: 'function',
    function: {
      name,
      arguments: repaired.ok ? JSON.stringify(repaired.value) : String(argsRaw == null ? '{}' : argsRaw),
    },
    __repaired: Boolean(repaired.repaired),
    __parse_error: repaired.ok ? false : true,
    __args: repaired.ok ? repaired.value : { __parse_error: true, raw: String(argsRaw || '').slice(0, 500) },
    __partial: Boolean(src.delta || src.partial || src.incomplete),
  };
}

function repairReactFence(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, value: null, code: 'tool_args_invalid' };
  try {
    return { ok: true, value: JSON.parse(s), repaired: false, code: null };
  } catch (_) { /* repair */ }
  try {
    const out = require('./engine-reliability').repairToolArgs(s);
    if (out.ok && out.value && typeof out.value === 'object' && !out.value.__parse_error) {
      return { ok: true, value: out.value, repaired: true, code: null };
    }
  } catch (_) { /* fall through */ }
  return { ok: false, value: null, code: 'tool_args_invalid' };
}

function decodeGatewayFrame(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, frame: raw, repaired: false, code: null };
  }
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, frame: null, code: 'tool_args_invalid' };
  try {
    return { ok: true, frame: JSON.parse(s), repaired: false, code: null };
  } catch (_) { /* repair */ }
  try {
    const out = require('./engine-reliability').repairToolArgs(s);
    if (out.ok && out.value && typeof out.value === 'object' && !out.value.__parse_error) {
      return { ok: true, frame: out.value, repaired: true, code: null };
    }
  } catch (_) { /* fall through */ }
  return { ok: false, frame: null, code: 'tool_args_invalid', error: 'JSON malformado' };
}

function waitDagReady(tasks, doneIds) {
  const list = Array.isArray(tasks) ? tasks : [];
  try {
    const cycle = require('./engine-correctness').detectDagCycle(list);
    if (cycle && cycle.cycle) {
      return { ok: false, ready: [], blocked: [], code: 'dag_cycle', cycle: cycle.path };
    }
  } catch (_) { /* optional */ }
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
  if (!ready.length && blocked.length) {
    return { ok: false, ready, blocked, code: 'dag_blocked' };
  }
  return { ok: true, ready, blocked, code: blocked.length ? 'dag_wait' : null };
}

function pickReadyNode(remaining, doneIds) {
  const dag = waitDagReady(remaining, doneIds);
  if (!dag.ok || !dag.ready.length) {
    return { ok: false, node: null, remaining, code: dag.code || 'dag_blocked', dag };
  }
  const id = dag.ready[0];
  const node = (remaining || []).find((n) => String(n && n.id) === id);
  const rest = (remaining || []).filter((n) => String(n && n.id) !== id);
  return { ok: true, node, remaining: rest, code: dag.code, dag };
}

function collectPairs(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const groups = [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const bundle = [m];
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') {
        bundle.push(list[j]);
        j += 1;
      }
      groups.push({
        kind: 'pair',
        messages: bundle,
        tokens: bundle.reduce((n, x) => n + estimateTokens(x && x.content || ''), 0),
      });
      i = j;
      continue;
    }
    groups.push({
      kind: 'solo',
      messages: [m],
      tokens: estimateTokens(m && m.content || ''),
    });
    i += 1;
  }
  return groups;
}

function compactPreservingPairs(messages, { maxTokens = 4000 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Math.max(64, Number(maxTokens) || 4000);
  const groups = collectPairs(list);
  const before = groups.reduce((n, g) => n + g.tokens, 0);
  if (before <= cap) {
    return {
      messages: list.slice(), compressed: false, removedTurns: 0,
      beforeTokens: before, afterTokens: before, code: null,
    };
  }
  const head = [];
  const rest = [];
  for (const g of groups) {
    const m = g.messages[0];
    if (m && m.role === 'system' && head.length < 2) head.push(g);
    else rest.push(g);
  }
  const kept = [];
  let used = head.reduce((n, g) => n + g.tokens, 0);
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const g = rest[i];
    if (used + g.tokens > cap && kept.length) break;
    if (used + g.tokens > cap) continue;
    kept.push(g);
    used += g.tokens;
  }
  kept.reverse();
  const out = [];
  for (const g of head.concat(kept)) out.push(...g.messages);
  const after = out.reduce((n, m) => n + estimateTokens(m && m.content || ''), 0);
  return {
    messages: out,
    compressed: true,
    removedTurns: Math.max(0, list.length - out.length),
    beforeTokens: before,
    afterTokens: after,
    code: 'compact_fidelity',
  };
}

function createNDeepCheckpoint({ max = ROLLBACK_MAX } = {}) {
  const cap = Math.max(1, Number(max) || ROLLBACK_MAX);
  let stack = [];
  return {
    save(state) {
      const snap = {
        id: `ckpt_${Date.now()}_${stack.length}_${crypto.randomBytes(3).toString('hex')}`,
        at: Date.now(),
        iteration: state && state.iteration,
        messages: Array.isArray(state && state.messages) ? state.messages.map((m) => ({ ...m })) : [],
        steps: Array.isArray(state && state.steps) ? state.steps.slice() : [],
        usage: state && state.usage ? { ...state.usage } : { promptTokens: 0, completionTokens: 0 },
      };
      stack.push(snap);
      while (stack.length > cap) stack.shift();
      return snap.id;
    },
    latest() { return stack.length ? stack[stack.length - 1] : null; },
    depth() { return stack.length; },
    rollback() { return stack.length ? stack[stack.length - 1] : null; },
    pop() { return stack.pop() || null; },
    size() { return stack.length; },
    restore(messages) {
      const snap = stack.length ? stack[stack.length - 1] : null;
      if (!snap) return null;
      if (Array.isArray(messages) && Array.isArray(snap.messages)) {
        messages.splice(0, messages.length, ...snap.messages.map((m) => ({ ...m })));
      }
      return snap;
    },
    rollbackN(n = 1) {
      const k = Math.max(1, Number(n) || 1);
      if (!stack.length) return { ok: false, code: 'checkpoint_missing', state: null, depth: 0 };
      let last = null;
      for (let i = 0; i < k && stack.length; i += 1) last = stack.pop();
      const snap = stack.length ? stack[stack.length - 1] : last;
      return { ok: true, state: snap, popped: last, depth: stack.length, code: 'checkpoint_rollback' };
    },
    restoreN(messages, n = 1) {
      const out = this.rollbackN(n);
      if (!out.ok || !out.state) return null;
      if (Array.isArray(messages) && Array.isArray(out.state.messages)) {
        messages.splice(0, messages.length, ...out.state.messages.map((m) => ({ ...m })));
      }
      return out.state;
    },
  };
}

function assertGitCleanForWrite({ relPath, gitStatus = null } = {}) {
  if (typeof gitStatus !== 'function') {
    return { ok: true, skipped: true, code: null };
  }
  let status;
  try { status = gitStatus(relPath); } catch (err) {
    return { ok: false, code: 'git_apply_dirty', error: String(err && err.message || err) };
  }
  const raw = status && typeof status === 'object' ? status : { dirty: Boolean(status) };
  if (raw.symlink || raw.isSymlink) return { ok: false, code: 'symlink_rejected', error: 'no escribo sobre symlink' };
  if (raw.binary) return { ok: false, code: 'git_binary_rejected', error: 'archivo binario' };
  if (raw.dirty || raw.unstaged || raw.uncommitted) {
    return { ok: false, code: 'git_apply_dirty', error: `el archivo ${relPath} tiene cambios sin commit` };
  }
  return { ok: true, skipped: false, code: null };
}

function sseDropUnderLoad({ pending = 0, highWater = SSE_HIGH_WATER, backpressured = false, closed = false } = {}) {
  if (closed) return { drop: true, emit: false, code: 'sse_orphan' };
  const water = Math.max(8, Number(highWater) || SSE_HIGH_WATER);
  const n = Math.max(0, Number(pending) || 0);
  if (backpressured && n >= water) {
    return { drop: true, emit: false, dropped: n - water + 1, code: 'sse_backpressure' };
  }
  return { drop: false, emit: true, code: null };
}

const sessionSeqs = new Map();

function nextSessionSeq(sessionKey) {
  const key = String(sessionKey || '') || '_global';
  const n = (sessionSeqs.get(key) || 0) + 1;
  sessionSeqs.set(key, n);
  return n;
}

function resetSessionSeq(sessionKey) {
  if (sessionKey == null) sessionSeqs.clear();
  else sessionSeqs.delete(String(sessionKey));
}

function stampMonotonicSeq(lastSeq, requested) {
  const last = Math.max(0, Number(lastSeq) || 0);
  const want = requested == null ? last + 1 : Number(requested);
  if (!Number.isFinite(want) || want !== last + 1) {
    return { seq: last + 1, reordered: true, code: 'event_order' };
  }
  return { seq: want, reordered: false, code: null };
}

function concurrencyBucket(n) {
  const v = Math.max(1, Number(n) || 1);
  if (v >= 8) return 8;
  if (v >= 4) return 4;
  if (v >= 2) return 2;
  return 1;
}

function beginConcurrentTurn() {
  concurrentTurns.inflight += 1;
  return concurrentTurns.inflight;
}

function endConcurrentTurn(latencyMs, inflight = null) {
  const n = inflight != null ? Number(inflight) : concurrentTurns.inflight;
  concurrentTurns.inflight = Math.max(0, concurrentTurns.inflight - 1);
  const ms = Number(latencyMs);
  if (!Number.isFinite(ms) || ms < 0) return snapshotConcurrentTurns();
  concurrentTurns.samples.push(ms);
  if (concurrentTurns.samples.length > 256) concurrentTurns.samples.shift();
  const b = concurrencyBucket(n);
  concurrentTurns.byBucket[b].push(ms);
  if (concurrentTurns.byBucket[b].length > 128) concurrentTurns.byBucket[b].shift();
  return snapshotConcurrentTurns();
}

function percentile(vals, p) {
  const list = (vals || []).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil(p * list.length) - 1));
  return list[idx];
}

function snapshotConcurrentTurns() {
  const all = concurrentTurns.samples;
  const out = {
    inflight: concurrentTurns.inflight,
    count: all.length,
    p50: percentile(all, 0.5),
    p95: percentile(all, 0.95),
    buckets: {},
    note: 'scripted concurrent-turn samples; never invented Flash numbers',
  };
  for (const [k, vals] of Object.entries(concurrentTurns.byBucket)) {
    out.buckets[k] = { count: vals.length, p50: percentile(vals, 0.5), p95: percentile(vals, 0.95) };
  }
  return out;
}

function resetConcurrentTurns() {
  concurrentTurns.inflight = 0;
  concurrentTurns.samples = [];
  concurrentTurns.byBucket = { 1: [], 2: [], 4: [], 8: [] };
  return snapshotConcurrentTurns();
}

function completionSnapshot() {
  return {
    toolStormCap: true,
    toolStormComplete: true,
    toolStormParallel: true,
    partialToolCall: true,
    reactFenceRepair: true,
    gatewayFrameRepair: true,
    dagWait: true,
    compactFidelity: true,
    rollbackNDeep: true,
    gitDirtyWriters: true,
    sseDropUnderLoad: true,
    sessionEventSeq: true,
    eventOrderMonotonic: true,
    concurrentTurnLatency: true,
    openrouterGenerate: false,
    interpreter: 'local',
    concurrent: snapshotConcurrentTurns(),
  };
}

module.exports = {
  STORM_MAX,
  STORM_PARALLEL,
  SSE_HIGH_WATER,
  capToolStorm,
  stormOverflowResult,
  runToolStorm,
  normalizePartialToolCall,
  repairReactFence,
  decodeGatewayFrame,
  waitDagReady,
  pickReadyNode,
  collectPairs,
  compactPreservingPairs,
  createNDeepCheckpoint,
  assertGitCleanForWrite,
  sseDropUnderLoad,
  nextSessionSeq,
  resetSessionSeq,
  stampMonotonicSeq,
  beginConcurrentTurn,
  endConcurrentTurn,
  snapshotConcurrentTurns,
  resetConcurrentTurns,
  completionSnapshot,
};
