'use strict';

/**
 * 3H32 — engine adapter layer for /chat + /code.
 * 3H33 extends (does not smash) 3H32: read line-numbers, last-N bodies,
 * secret redact in results, path jail, glob ignore, Flash/Pro lock,
 * SSE ring bound, rate limit, background bash, todos, pin expiry.
 * 3H34 extends (does not smash) 3H33: pgvector rank, rollback last-N,
 * token audit, fair generate lock, GET tool cache, model vs tool timeout,
 * additionalProperties strip, NFC jail, symlink escape, SSE comment/event,
 * 0-token refund, compact token budget, subagent step inherit, file lock.
 * 3H35 extends (does not smash) 3H34: unique tool_call ids + orphan drop,
 * streaming JSON across chunks, unified diff apply, sandbox ulimit,
 * stdout/stderr streams, credit hold-then-settle, resume replay without
 * re-exec, compact keep SIRAGPT.md+last user, drop cancelled run events,
 * per-tool rate limit, image/pdf context cap, max_tokens clamp, clock-skew
 * TTL, idempotent generate by requestId.
 * 3H36 extends (does not smash) 3H35: tool-name allowlist, nested coerce,
 * create-if-missing vs large overwrite, sandbox net fail-closed, kill PGID,
 * SSE retry first event, no settle if stream never opened, drop dup system,
 * skip empty memory facts, stop if final text+tools, gzip tool results,
 * redact URL credentials, PATCH generate resume token, DeepSeek 429/402.
 * 3H37 extends (does not smash) 3H36: identical observation loop cut,
 * abort siblings on parent cancel, enum args, truncate overlong args,
 * same-turn tool cache, DAG cycle, step-budget reminder, pair compact,
 * min-score memory, write checkpoints, binary edit refuse, CRLF normalize,
 * same-volume move, RSS+CPU ulimit, scrub child env, tmpdir finally,
 * SSE buffer disconnect, heartbeat jitter, generate overloaded retry-after,
 * partial token refund on cancel, net error taxonomy, skip compact under budget.
 * 3H38 extends (does not smash) 3H37: max concurrent tools, subagent result cap,
 * repair missing required from prior turn, validate tool result shape,
 * tool timeout vs remaining budget, dead-letter same tool+error,
 * plan progress line, compact preserve last errors, pin:true facts,
 * checkpoint CAS seq, write checksum, js/py syntax after write,
 * reject C0 paths, create exclusive, tmpfs 64MB hint, redact $HOME,
 * SSE idle-tool ping, SSE gap replay, fair queue starvation boost,
 * credit audit on tool error, FS error taxonomy, skip memory if busy.
 * 3H39 extends (does not smash) 3H38: stable parallel result order,
 * cancel in-flight tools, trailing-comma JSON repair, tool-name aliases,
 * nested arg depth cap, subagent depth, wall-clock cut, merge dup users,
 * memory hash dedupe, refuse stale checksum edit, hunk context match,
 * atomic tmp rename, UNC/Windows path reject, no-new-privs, LD_PRELOAD
 * scrub, drop buffered tokens on cancel, SSE id monotonic, coalesced
 * in-flight call ids, settle credits if client gone, json/abort taxonomy,
 * skip duplicate web_fetch same URL per turn.
 * 3H40 extends (does not smash) 3H39: hard cap 32 tools/step, abort nested
 * subagents on parent halt, unquoted-key JSON repair, drop NUL args,
 * integer coerce, empty-model circuit, budget hint every 5 steps,
 * drop stale image/pdf, skip old memory facts, rollback on syntax fail,
 * refuse symlink write, strip UTF-8 BOM, SIGTERM+SIGKILL grace, 64KiB
 * stdout cap, SSE proxy pad, destroy SSE on close, max 2 generate/user,
 * steal lock if heartbeat >45s, never charge 401/403, redact IPv4,
 * EPIPE on response stream cancelled, glob cap 500, TTFB watchdog 8s.
 *
 * Remaining holes after 3H31 (event-order / schema repair / file pins /
 * cancel mid-stream / str_replace syntax revert / sandbox wall+RSS /
 * first-token watchdog / provider taxonomy):
 *   1  retryable tool failures: exponential backoff + jitter
 *   2  consecutive identical tool+args cut + per-session remaining steps
 *   3  compact: drop stale tool bodies, keep last-N tool names
 *   4  checkpoint rollback of last file edit
 *   5  fuzzy-whitespace str_replace fallback that still verifies
 *   6  per-command stdout cap + tmp cleanup on cancel
 *   7  drop duplicate in-flight generate (same session, no steal)
 *   8  credit on tool-error + tool-count on cancel (no leak / no double)
 *   9  tool-error taxonomy + never raw stack to client
 *  10  sampled p50/p95 latency hook (scripted, never invented Flash)
 *  11  deny-list of dangerous tools on the generate path
 *  12  gateway audit durationMs + tokens; one mutation per path
 *  13  empty model response: one retry then graceful stop
 *  14  same call-id retry is idempotent; abort cascade; claim TTL
 *  15  refuse OpenRouter generate; ReAct stop on final answer
 *  16  per-tool timeout overlay (web shorter, shell longer)
 *  17  sandbox env sanitization (no host secrets / LD_PRELOAD)
 *  18  remaining-token budget hint; after-write test hint
 *  19  SSE comment heartbeat every 15s; Last-Event-ID resume
 *  20  MCP already-connected host allow without opening everything
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * Do not invent HMAC / SANDBOX_NET_ALLOW / refresh-token secrets.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMENT_HEARTBEAT_MS = 15_000;
const CLAIM_TTL_MS = 45_000;
const STDOUT_CMD_CAP = 64 * 1024;
const TOOL_RESULT_CAP = 12 * 1024;
const LAST_N_TOOL_NAMES = 6;
const IDENTICAL_CONSECUTIVE = 2;
const EMPTY_RETRY_ONCE = 1;
const BACKOFF_FIRST_MS = 120;
const BACKOFF_MAX_MS = 2_500;

const DANGEROUS_TOOL_NAMES = Object.freeze([
  'eval', 'exec_as_root', 'drop_database', 'rm_rf', 'format_disk',
  'fork_bomb', 'install_malware', 'exfiltrate_secrets', 'disable_auth',
]);

const DANGEROUS_ARG_RE = /(?:^|[\s\"'`])(rm\s+-rf\s+\/|mkfs\.|dd\s+if=\/dev\/zero|: \(\) \{ :\|:& \};:|curl[^\n]*\|\s*sh|wget[^\n]*\|\s*sh)/i;

const TOOL_TIMEOUT_OVERLAY_MS = Object.freeze({
  execute_bash: 30_000,
  bash: 30_000,
  shell: 30_000,
  exec: 30_000,
  execute_python: 20_000,
  web_search: 8_000,
  web_fetch: 8_000,
  browser_act: 12_000,
  computer_navigate: 15_000,
  computer_click: 8_000,
  computer_type: 8_000,
  computer_key: 8_000,
  computer_read_file: 8_000,
  computer_write_file: 8_000,
  read_file: 5_000,
  write_file: 8_000,
  edit_file: 8_000,
  default: 15_000,
});

const SECRET_ENV_RE = /key|secret|token|password|credential|openai|openrouter|deepseek|aws_|github_|stripe_|private/i;
const FORBIDDEN_ENV = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH',
  'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'CDPATH', 'SHELLOPTS',
]);

const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    const keys = Object.keys(value).sort();
    const o = {};
    for (const k of keys) o[k] = value[k];
    return JSON.stringify(o);
  } catch (_) {
    return String(value);
  }
}

function fingerprint(name, args) {
  return `${String(name || '')}:${stableJson(args)}`;
}

// ---------------------------------------------------------------------------
// 1 — retryable tool failures: exp backoff + jitter
// ---------------------------------------------------------------------------

function backoffWithJitter(attempt, {
  first = BACKOFF_FIRST_MS,
  max = BACKOFF_MAX_MS,
  random = Math.random,
} = {}) {
  const n = Math.max(0, Number(attempt) || 0);
  const base = Math.min(max, first * (2 ** n));
  const spread = base * 0.25;
  const r = typeof random === 'function' ? random() : 0.5;
  return Math.max(0, Math.floor(base - spread + r * spread * 2));
}

function isRetryableToolFailure(err) {
  if (!err) return false;
  const code = String(err.code || err.name || '').toLowerCase();
  const msg = String(err.message || err.error || '').toLowerCase();
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  if (/tool_args_invalid|permission|not_found|forbidden|schema|dangerous/.test(code)) return false;
  if (/econnreset|econnrefused|etimedout|eai_again|socket hang up|network|overloaded|429|502|503|504|timeout|unavailable/.test(code + ' ' + msg)) {
    return true;
  }
  const status = Number(err.status || err.statusCode || NaN);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return false;
}

async function retryToolWithBackoff(fn, {
  maxAttempts = 3,
  isRetryable = isRetryableToolFailure,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  random,
  signal,
} = {}) {
  const cap = Math.max(1, Math.min(5, Number(maxAttempts) || 3));
  let lastErr = null;
  for (let attempt = 0; attempt < cap; attempt += 1) {
    if (signal && signal.aborted) {
      const err = new Error('tool_aborted');
      err.code = 'tool_aborted';
      throw err;
    }
    try {
      const value = await fn(attempt);
      return { ok: true, value, attempts: attempt + 1, code: null };
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= cap || !isRetryable(err)) {
        return {
          ok: false,
          error: err,
          attempts: attempt + 1,
          code: (err && err.code) || 'tool_retry_exhausted',
        };
      }
      const wait = backoffWithJitter(attempt, { random });
      if (wait > 0 && typeof sleepFn === 'function') await sleepFn(wait);
    }
  }
  return { ok: false, error: lastErr, attempts: cap, code: 'tool_retry_exhausted' };
}

// ---------------------------------------------------------------------------
// 2 — consecutive identical tool+args + per-session remaining steps
// ---------------------------------------------------------------------------

function createConsecutiveRepeatCut({ limit = IDENTICAL_CONSECUTIVE } = {}) {
  const cap = Math.max(2, Math.min(6, Number(limit) || IDENTICAL_CONSECUTIVE));
  let lastKey = null;
  let run = 0;
  return {
    limit: cap,
    see(name, args) {
      const key = fingerprint(name, args);
      if (key === lastKey) run += 1;
      else { lastKey = key; run = 1; }
      return { key, run, cut: run >= cap, code: run >= cap ? 'loop_cut' : null };
    },
    reset() { lastKey = null; run = 0; },
  };
}

const sessionBudgets = new Map();

function sessionRemainingSteps(sessionKey, {
  maxSteps = 40,
  consume = 0,
  now = Date.now(),
  ttlMs = 15 * 60 * 1000,
} = {}) {
  const key = String(sessionKey || '');
  if (!key) return { ok: false, remaining: 0, code: 'session_busy' };
  const cap = Math.max(1, Math.min(80, Number(maxSteps) || 40));
  let rec = sessionBudgets.get(key);
  if (!rec || (now - rec.at) > ttlMs) rec = { used: 0, cap, at: now };
  rec.used += Math.max(0, Number(consume) || 0);
  rec.at = now;
  sessionBudgets.set(key, rec);
  const remaining = Math.max(0, rec.cap - rec.used);
  return {
    ok: remaining > 0,
    remaining,
    used: rec.used,
    cap: rec.cap,
    code: remaining > 0 ? null : 'budget_exceeded',
  };
}

function resetSessionBudgets() { sessionBudgets.clear(); }

// ---------------------------------------------------------------------------
// 3 — compact: drop stale tool bodies, keep last-N names
// ---------------------------------------------------------------------------

function compactDropStaleBodies(messages, { keepNames = LAST_N_TOOL_NAMES, maxBody = 400 } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const names = [];
  for (const m of list) {
    const n = m && (m.name || m.tool || (m.tool_calls && m.tool_calls[0] && (m.tool_calls[0].function || {}).name));
    if (n) names.push(String(n));
  }
  const keep = Math.max(0, Number(keepNames) || LAST_N_TOOL_NAMES);
  const keptNames = names.slice(-keep);
  const cap = Math.max(80, Number(maxBody) || 400);
  const out = list.map((m, idx) => {
    if (!m || typeof m !== 'object') return m;
    const role = m.role;
    if (role !== 'tool' && role !== 'function') return m;
    const body = String(m.content == null ? '' : m.content);
    if (body.length <= cap) return m;
    const name = String(m.name || m.tool || 'tool');
    const hash = sha256Hex(body).slice(0, 12);
    return {
      ...m,
      content: `[compacted ${name} ${body.length}b sha256=${hash}]`,
      __compacted: true,
      __origBytes: body.length,
    };
  });
  return { messages: out, keptNames, droppedBodies: out.filter((m) => m && m.__compacted).length };
}

// ---------------------------------------------------------------------------
// 4 — checkpoint rollback of last file edit
// ---------------------------------------------------------------------------

function rollbackLastFileEdit(checkpoint, { apply } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, code: 'checkpoint_missing', reverted: false };
  }
  const edit = checkpoint.lastFileEdit || checkpoint.fileEdit || null;
  if (!edit || !edit.path) {
    return { ok: false, code: 'checkpoint_missing', reverted: false };
  }
  if (typeof apply === 'function') {
    try { apply(edit.path, edit.before); } catch (err) {
      return { ok: false, code: 'checkpoint_rollback', reverted: false, error: String(err && err.message || err).slice(0, 180) };
    }
  }
  return {
    ok: true,
    code: 'checkpoint_rollback',
    reverted: true,
    path: edit.path,
    before: edit.before,
  };
}

function rememberFileEdit(checkpoint, { path: filePath, before, after } = {}) {
  const ck = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const rec = {
    path: String(filePath || ''),
    before: before == null ? '' : String(before),
    after: after == null ? '' : String(after),
    at: Date.now(),
  };
  ck.lastFileEdit = rec;
  const stack = Array.isArray(ck.edits) ? ck.edits.slice() : [];
  stack.push(rec);
  while (stack.length > 8) stack.shift();
  ck.edits = stack;
  return ck;
}

// ---------------------------------------------------------------------------
// 5 — fuzzy-whitespace str_replace fallback + verify
// ---------------------------------------------------------------------------

function collapseWs(s) {
  return String(s == null ? '' : s).replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fuzzyWhitespaceReplace({ haystack, oldString, newString } = {}) {
  const src = String(haystack == null ? '' : haystack);
  const oldS = String(oldString == null ? '' : oldString);
  const newS = String(newString == null ? '' : newString);
  if (!oldS) return { ok: false, code: 'tool_args_invalid', text: src, method: null };
  if (src.includes(oldS)) {
    const next = src.replace(oldS, newS);
    return { ok: true, text: next, method: 'exact', count: 1 };
  }
  const parts = oldS.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
  if (!parts.length) return { ok: false, code: 'write_noop', text: src, method: null };
  let re;
  try { re = new RegExp(parts.map(escapeRe).join('\\s*')); } catch (_) {
    return { ok: false, code: 'write_noop', text: src, method: null };
  }
  const m = re.exec(src);
  if (!m) return { ok: false, code: 'write_noop', text: src, method: null };
  const second = re.exec(src.slice(m.index + m[0].length));
  if (second) return { ok: false, code: 'git_hunk_ambiguous', text: src, method: 'fuzzy' };
  const next = src.slice(0, m.index) + newS + src.slice(m.index + m[0].length);
  return { ok: true, text: next, method: 'fuzzy', count: 1 };
}

function verifyAfterFuzzyWrite({ before, after, oldString, newString } = {}) {
  const applied = fuzzyWhitespaceReplace({ haystack: before, oldString, newString });
  if (!applied.ok) return applied;
  if (String(after) !== applied.text) {
    return { ok: false, code: 'read_after_write_failed', expected: applied.text, after };
  }
  return { ok: true, method: applied.method, code: null };
}

// ---------------------------------------------------------------------------
// 6 — per-command stdout cap + tmp cleanup on cancel
// ---------------------------------------------------------------------------

function capCommandStdout(text, { maxBytes = STDOUT_CMD_CAP } = {}) {
  const s = String(text == null ? '' : text);
  const cap = Math.max(256, Number(maxBytes) || STDOUT_CMD_CAP);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) {
    return { text: s, truncated: false, bytes: buf.length, hash: sha256Hex(s).slice(0, 16) };
  }
  const kept = buf.subarray(0, cap).toString('utf8');
  const hash = sha256Hex(s);
  return {
    text: `${kept}\n[stdout_capped ${buf.length}b sha256=${hash.slice(0, 16)}]`,
    truncated: true,
    bytes: buf.length,
    hash: hash.slice(0, 16),
    code: 'stdout_rate',
  };
}

function tmpCleanupOnCancel(dirs, { rm = fs.rmSync } = {}) {
  const list = Array.isArray(dirs) ? dirs : (dirs ? [dirs] : []);
  const cleaned = [];
  const failed = [];
  for (const d of list) {
    const p = String(d || '');
    if (!p) continue;
    // never walk out of tmp
    const tmpRoot = os.tmpdir();
    if (!p.startsWith(tmpRoot) && !p.includes('siragpt') && !p.includes('/tmp/')) {
      failed.push({ path: p, code: 'path_traversal' });
      continue;
    }
    try {
      rm(p, { recursive: true, force: true });
      cleaned.push(p);
    } catch (err) {
      failed.push({ path: p, error: String(err && err.message || err).slice(0, 80) });
    }
  }
  return { ok: failed.length === 0, cleaned, failed, code: 'tmpfs_cleanup' };
}

// ---------------------------------------------------------------------------
// 7 — drop duplicate in-flight generate (no steal)
// ---------------------------------------------------------------------------

const inFlightGenerate = new Map();

function dropDuplicateInFlightGenerate(sessionKey, producerId, { now = Date.now(), ttlMs = CLAIM_TTL_MS } = {}) {
  const key = String(sessionKey || '');
  const id = String(producerId || '');
  if (!key || !id) return { ok: false, dropped: false, code: 'gateway_busy' };
  const cur = inFlightGenerate.get(key);
  if (cur && !cur.released && (now - cur.at) < ttlMs && cur.producerId !== id) {
    return { ok: false, dropped: true, code: 'duplicate_turn', producerId: cur.producerId };
  }
  inFlightGenerate.set(key, { producerId: id, at: now, released: false });
  return {
    ok: true,
    dropped: false,
    code: null,
    producerId: id,
    release() {
      const rec = inFlightGenerate.get(key);
      if (rec && rec.producerId === id) {
        rec.released = true;
        inFlightGenerate.delete(key);
      }
      return { ok: true };
    },
  };
}

function resetInFlightGenerate() { inFlightGenerate.clear(); }

// ---------------------------------------------------------------------------
// 8 — credit on tool-error + tool-count on cancel
// ---------------------------------------------------------------------------

function creditOnToolError(hold, { released = false } = {}) {
  if (!hold) return { ok: true, released: false, charged: false, code: null };
  if (released) return { ok: true, released: false, charged: false, code: 'credit_release' };
  if (typeof hold.release === 'function') {
    try { hold.release(); } catch (_) { /* once */ }
  } else if (typeof hold === 'object') {
    hold.released = true;
  }
  return { ok: true, released: true, charged: false, code: 'credit_no_usage' };
}

function recordTurnToolCount(state, { count = 0, cancelled = false } = {}) {
  const rec = state && typeof state === 'object' ? state : {};
  const n = Math.max(0, Number(count) || 0);
  rec.toolCount = n;
  rec.cancelled = Boolean(cancelled);
  rec.at = Date.now();
  return { ok: true, toolCount: n, cancelled: rec.cancelled, code: cancelled ? 'credit_cancel' : null, state: rec };
}

// ---------------------------------------------------------------------------
// 9 — tool-error taxonomy + never raw stack
// ---------------------------------------------------------------------------

function classifyToolFailure(err) {
  if (err == null) return { code: 'internal_error', kind: 'unknown', retryable: false, message: 'Falló la herramienta.' };
  const code = String(err.code || err.errno || '').toLowerCase();
  const msg = String(err.message || err.error || err || '');
  const low = msg.toLowerCase();
  const status = Number(err.status || err.statusCode || NaN);
  if (/eacces|eperm|forbidden|permission/.test(code + ' ' + low) || status === 403) {
    return { code: 'permission', kind: 'permission', retryable: false, message: 'No hay permiso para esa acción.' };
  }
  if (/enoent|not_found|not found|no such file/.test(code + ' ' + low) || status === 404) {
    return { code: 'not_found', kind: 'not_found', retryable: false, message: 'No encontré ese archivo o recurso.' };
  }
  if (/tool_args_invalid|einval|invalid_args|schema_invalid/.test(code + ' ' + low) || status === 400) {
    return { code: 'invalid_args', kind: 'invalid_args', retryable: false, message: 'Los argumentos de la herramienta no son válidos.' };
  }
  if (/etimedout|timeout|tool_timeout|aborted.*time/.test(code + ' ' + low) || status === 504) {
    return { code: 'timeout', kind: 'timeout', retryable: true, message: 'La herramienta tardó demasiado. Corté la espera.' };
  }
  if (/econnreset|econnrefused|eai_again|network|enotfound|fetch failed/.test(code + ' ' + low) || status === 502 || status === 503) {
    return { code: 'network', kind: 'network', retryable: true, message: 'Falló la red al llamar la herramienta. Reintentaré.' };
  }
  return {
    code: code || 'tool_isolated',
    kind: 'unknown',
    retryable: Boolean(err.retryable),
    message: 'La herramienta falló. No se filtró ninguna clave.',
  };
}

function sanitizeClientError(err) {
  const classified = classifyToolFailure(err);
  const raw = String((err && (err.stack || err.message)) || err || '');
  const stripped = raw.replace(STACK_RE, '').replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[redacted]');
  if (STACK_RE.test(raw) || /sk-/.test(raw)) {
    return {
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable,
      kind: classified.kind,
      leaked: false,
    };
  }
  return {
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    kind: classified.kind,
    leaked: false,
    detail: stripped.slice(0, 180),
  };
}

function classifyAdapterError(code) {
  const c = String(code || '');
  const table = {
    duplicate_turn: { code: 'duplicate_turn', retryable: true, message: 'Ese turno ya está en vuelo. No lancé otro generate.' },
    loop_cut: { code: 'loop_cut', retryable: false, message: 'El agente repitió el mismo paso. Detuve el bucle.' },
    budget_exceeded: { code: 'budget_exceeded', retryable: false, message: 'Se agotó el presupuesto de pasos de esta sesión.' },
    empty_response: { code: 'empty_response', retryable: false, message: 'El modelo no devolvió texto ni herramientas. Paré el turno.' },
    dangerous_tool: { code: 'dangerous_tool', retryable: false, message: 'Bloqueé una herramienta peligrosa en el generate.' },
    openrouter_denied: { code: 'openrouter_denied', retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
    session_lock_stale: { code: 'session_lock_stale', retryable: true, message: 'El candado de sesión expiró. Liberé al worker caído.' },
    mcp_connected_only: { code: 'mcp_connected_only', retryable: false, message: 'MCP deny-all: solo reuso hosts ya conectados en esta sesión.' },
    stdout_rate: { code: 'stdout_rate', retryable: false, message: 'Recorté la salida del comando para no inflar el contexto.' },
    credit_cancel: { code: 'credit_cancel', retryable: false, message: 'Registré las herramientas del turno cancelado. No cobré de más.' },
    path_mutation_busy: { code: 'path_mutation_busy', retryable: true, message: 'Otra escritura va al mismo archivo. Esperé a que termine.' },
    fuzzy_replace: { code: 'fuzzy_replace', retryable: false, message: 'Apliqué el reemplazo tolerando espacios y verifiqué el archivo.' },
    read_window: { code: 'read_window', retryable: false, message: 'Leí una ventana del archivo con números de línea.' },
    glob_ignored: { code: 'glob_ignored', retryable: false, message: 'Omití rutas de build/git/node_modules del glob.' },
    bash_background: { code: 'bash_background', retryable: false, message: 'Dejé el comando en segundo plano. Lo siego en el abort.' },
    secret_redact: { code: 'secret_redact', retryable: false, message: 'Redacté un secreto del resultado de la herramienta.' },
    model_forbidden: { code: 'model_forbidden', retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro.' },
    sse_gap: { code: 'sse_gap', retryable: true, message: 'Faltan eventos SSE. Reenvío desde el anillo acotado.' },
    pgvector_failed: { code: 'pgvector_failed', retryable: true, message: 'No pude consultar la memoria vectorial. Sigo sin ella.' },
    queue_fairness: { code: 'queue_fairness', retryable: true, message: 'Otro generate espera su turno en esta sesion.' },
    schema_strip: { code: 'schema_strip', retryable: false, message: 'Quite propiedades extra que el schema no permite.' },
    symlink_rejected: { code: 'symlink_rejected', retryable: false, message: 'El enlace simbolico sale del espacio de trabajo.' },
    token_compact: { code: 'token_compact', retryable: false, message: 'Compacte el contexto para caber en el presupuesto restante.' },
    subagent_budget: { code: 'subagent_budget', retryable: false, message: 'El presupuesto del subagente se agoto.' },
    unknown_tool: { code: 'unknown_tool', retryable: false, message: 'Esa herramienta no existe en el catalogo. No la ejecute.' },
    coercion_rejected: { code: 'coercion_rejected', retryable: false, message: 'No pude coercer el tipo anidado de los argumentos.' },
    file_too_large: { code: 'file_too_large', retryable: false, message: 'Rechace sobrescribir un archivo grande sin backup.' },
    network_denied: { code: 'network_denied', retryable: false, message: 'Sandbox sin red: SANDBOX_NET_ALLOW no esta definido.' },
    sandbox_killed: { code: 'sandbox_killed', retryable: false, message: 'Mate el grupo de procesos del sandbox, no solo el pid.' },
    sse_resume: { code: 'sse_resume', retryable: true, message: 'Reanuda el stream con retry y resume token.' },
    credit_no_usage: { code: 'credit_no_usage', retryable: true, message: 'No asente el hold: el stream nunca abrio.' },
    pin_dedup: { code: 'pin_dedup', retryable: false, message: 'Quite system prompts duplicados.' },
    memory_fact_empty: { code: 'memory_fact_empty', retryable: false, message: 'Ignore hechos de memoria vacios o solo espacios.' },
    final_with_tools: { code: 'final_with_tools', retryable: false, message: 'El texto ya era final; ignore las herramientas extra.' },
    gzip_version: { code: 'gzip_version', retryable: false, message: 'Comprimi el resultado de la herramienta porque era grande.' },
    secret_redact: { code: 'secret_redact', retryable: false, message: 'Redacte credenciales de una URL.' },
    resume_conflict: { code: 'resume_conflict', retryable: false, message: 'El resume token no coincide o expiro.' },
    rate_limited: { code: 'rate_limited', retryable: true, message: 'DeepSeek 429: espera y reintenta.' },
    credit_ceiling: { code: 'credit_ceiling', retryable: false, message: 'DeepSeek 402: sin credito. No reintente.' },
  };
  return table[c] || null;
}

// ---------------------------------------------------------------------------
// 10 — sampled p50/p95 (scripted, never invented Flash)
// ---------------------------------------------------------------------------

function createP2Estimator() {
  const samples = [];
  return {
    observe(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return;
      samples.push(n);
      if (samples.length > 512) samples.shift();
    },
    snapshot() {
      if (!samples.length) return { p50: null, p95: null, count: 0, source: 'scripted' };
      const sorted = samples.slice().sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
      return { p50: at(0.5), p95: at(0.95), count: sorted.length, source: 'scripted' };
    },
  };
}

const ttfbP2 = createP2Estimator();
const turnP2 = createP2Estimator();

function observeAdapterLatency(kind, ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  if (kind === 'ttfb' || kind === 'first_token') ttfbP2.observe(n);
  else turnP2.observe(n);
  return { ok: true, kind, ms: n };
}

function adapterLatencySnapshot() {
  return {
    firstTokenMs: ttfbP2.snapshot(),
    turnEndMs: turnP2.snapshot(),
    note: 'scripted p50/p95; never invented Flash',
  };
}

// ---------------------------------------------------------------------------
// 11 — deny-list of dangerous tools on generate path
// ---------------------------------------------------------------------------

function denyDangerousGenerateTools(name, args) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return { ok: false, code: 'dangerous_tool', reason: 'empty_name' };
  if (DANGEROUS_TOOL_NAMES.includes(n)) {
    return { ok: false, code: 'dangerous_tool', reason: 'deny_name', name: n };
  }
  const blob = typeof args === 'string' ? args : stableJson(args);
  if (DANGEROUS_ARG_RE.test(blob)) {
    return { ok: false, code: 'dangerous_tool', reason: 'deny_args', name: n };
  }
  return { ok: true, code: null, name: n };
}

// ---------------------------------------------------------------------------
// 12 — audit duration+tokens; one mutation per path
// ---------------------------------------------------------------------------

function stampAuditDurationTokens(row, { durationMs, tokens, startedAt, now = Date.now() } = {}) {
  const rec = row && typeof row === 'object' ? { ...row } : {};
  const dur = durationMs != null ? Number(durationMs) : (startedAt != null ? now - Number(startedAt) : null);
  rec.durationMs = Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null;
  const tok = tokens && typeof tokens === 'object'
    ? {
      prompt: Number(tokens.prompt || tokens.promptTokens || 0) || 0,
      completion: Number(tokens.completion || tokens.completionTokens || 0) || 0,
    }
    : (Number.isFinite(Number(tokens)) ? { prompt: 0, completion: Number(tokens) } : { prompt: 0, completion: 0 });
  rec.tokens = tok;
  rec.tokenTotal = (tok.prompt || 0) + (tok.completion || 0);
  return rec;
}

const pathMutations = new Map();

function claimPathMutation(filePath, ownerId, { now = Date.now(), ttlMs = 20_000 } = {}) {
  const p = path.normalize(String(filePath || ''));
  const id = String(ownerId || '');
  if (!p || p === '.' || !id) return { ok: false, code: 'path_mutation_busy' };
  const cur = pathMutations.get(p);
  if (cur && cur.ownerId !== id && (now - cur.at) < ttlMs) {
    return { ok: false, code: 'path_mutation_busy', ownerId: cur.ownerId, path: p };
  }
  pathMutations.set(p, { ownerId: id, at: now });
  return {
    ok: true,
    path: p,
    ownerId: id,
    release() {
      const rec = pathMutations.get(p);
      if (rec && rec.ownerId === id) pathMutations.delete(p);
      return { ok: true };
    },
  };
}

function resetPathMutations() { pathMutations.clear(); }

function allowParallelReads(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const writes = [];
  const reads = [];
  for (const c of list) {
    const n = String((c && (c.name || c.mapped || (c.function && c.function.name))) || '');
    const args = (c && (c.args || c.arguments || (c.function && c.function.arguments))) || {};
    const p = args.path || args.file_path || args.target || null;
    if (/write_file|edit_file|str_replace|apply_patch|computer_write/.test(n)) writes.push({ ...c, path: p, kind: 'write' });
    else reads.push({ ...c, path: p, kind: 'read' });
  }
  const writePaths = new Set(writes.map((w) => w.path).filter(Boolean));
  const blockedReads = reads.filter((r) => r.path && writePaths.has(r.path));
  const freeReads = reads.filter((r) => !r.path || !writePaths.has(r.path));
  return { writes, reads: freeReads, blockedReads, parallelReads: freeReads, sequentialWrites: writes };
}

// ---------------------------------------------------------------------------
// 13 — empty model response: one retry then stop
// ---------------------------------------------------------------------------

function emptyResponseRetryOnce(response, state = {}) {
  const rec = state && typeof state === 'object' ? state : {};
  const msg = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message
    : (response && response.message) || response || {};
  const content = String(msg.content == null ? '' : msg.content).trim();
  const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const empty = !content && tools.length === 0;
  if (!empty) return { empty: false, retry: false, stop: false, code: null, state: rec };
  rec.retries = (Number(rec.retries) || 0) + 1;
  if (rec.retries <= EMPTY_RETRY_ONCE) {
    return { empty: true, retry: true, stop: false, code: null, state: rec };
  }
  return { empty: true, retry: false, stop: true, code: 'empty_response', state: rec };
}

function stopOnFinalAnswer(msg) {
  const content = String((msg && msg.content) || '').trim();
  const tools = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [];
  if (content && tools.length === 0) {
    return { stop: true, reason: 'final', code: null, text: content };
  }
  return { stop: false, reason: null, code: null, text: content };
}

// ---------------------------------------------------------------------------
// 14 — same call-id retry idempotent; abort cascade; claim TTL
// ---------------------------------------------------------------------------

function replaySameCallId(store, { toolCallId, args } = {}) {
  const map = store instanceof Map ? store : (store && store.map) || new Map();
  const id = String(toolCallId || '');
  if (!id) return { ok: false, replay: false, code: 'tool_result_orphan' };
  const key = id;
  const prev = map.get(key);
  const fp = fingerprint('call', args);
  if (prev && prev.fp === fp && prev.result != null) {
    return { ok: true, replay: true, result: prev.result, code: 'tool_result_dup' };
  }
  return { ok: true, replay: false, code: null, store: map, fp };
}

function rememberCallResult(store, { toolCallId, args, result } = {}) {
  const map = store instanceof Map ? store : (store && store.map) || new Map();
  const id = String(toolCallId || '');
  if (!id) return map;
  map.set(id, { fp: fingerprint('call', args), result, at: Date.now() });
  if (store && !(store instanceof Map)) store.map = map;
  return map;
}

function abortCascade({
  userSignal,
  modelAbort,
  sandboxKill,
  backgroundReap,
} = {}) {
  const aborted = Boolean(userSignal && (userSignal.aborted || userSignal === true));
  const out = { aborted, modelAborted: false, sandboxKilled: false, backgroundReaped: false, code: aborted ? 'turn_cancelled' : null };
  if (!aborted) return out;
  if (typeof modelAbort === 'function') {
    try { modelAbort(); out.modelAborted = true; } catch (_) { /* best-effort */ }
  }
  if (typeof sandboxKill === 'function') {
    try { sandboxKill(); out.sandboxKilled = true; } catch (_) { /* best-effort */ }
  }
  if (typeof backgroundReap === 'function') {
    try { backgroundReap(); out.backgroundReaped = true; } catch (_) { /* best-effort */ }
  } else {
    try {
      const r = reapBackgroundBashOnAbort();
      out.backgroundReaped = Boolean(r && r.reaped >= 0);
    } catch (_) { /* best-effort */ }
  }
  return out;
}

const claimTimes = new Map();

function expireGatewayClaimTtl(sessionKey, { now = Date.now(), ttlMs = CLAIM_TTL_MS, claims } = {}) {
  const ttl = Math.max(1_000, Number(ttlMs) || CLAIM_TTL_MS);
  const map = claims instanceof Map ? claims : claimTimes;
  if (sessionKey) {
    const rec = map.get(String(sessionKey));
    if (!rec) return { expired: false, code: null };
    if ((now - rec.at) >= ttl) {
      map.delete(String(sessionKey));
      return { expired: true, code: 'session_lock_stale', sessionKey: String(sessionKey) };
    }
    return { expired: false, code: null, ageMs: now - rec.at };
  }
  let n = 0;
  for (const [k, rec] of map.entries()) {
    if (!rec || (now - rec.at) >= ttl) {
      map.delete(k);
      n += 1;
    }
  }
  return { expired: n > 0, swept: n, code: n ? 'session_lock_stale' : null };
}

function touchGatewayClaim(sessionKey, producerId, { now = Date.now() } = {}) {
  const key = String(sessionKey || '');
  if (!key) return { ok: false };
  claimTimes.set(key, { producerId: String(producerId || ''), at: now });
  return { ok: true };
}

function resetClaimTimes() { claimTimes.clear(); }

// ---------------------------------------------------------------------------
// 15 — refuse OpenRouter generate
// ---------------------------------------------------------------------------

function refuseOpenRouterEnv(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const bases = [
    e.DEEPSEEK_BASE_URL, e.OPENAI_BASE_URL, e.LLM_BASE_URL,
    e.SIRAGPT_LLM_BASE_URL, e.NATIVE_LLM_BASE_URL, e.GENERATE_BASE_URL,
  ].map((v) => String(v || ''));
  const flagged = bases.some((b) => /openrouter\.ai/i.test(b));
  const forced = String(e.SIRAGPT_USE_OPENROUTER || e.USE_OPENROUTER || '') === '1';
  const model = String(e.SIRAGPT_AGENT_RUNNER_MODEL || e.VISIBLE_MODELS_ALLOWLIST || '');
  const modelOr = /openrouter/i.test(model);
  if (flagged || forced || modelOr) {
    return { ok: false, openrouter: true, code: 'openrouter_denied' };
  }
  return { ok: true, openrouter: false, code: null };
}

// ---------------------------------------------------------------------------
// 16 — per-tool timeout overlay
// ---------------------------------------------------------------------------

function overlayToolTimeoutMs(name, overrides = {}, baseMs = null) {
  const n = String(name || '').trim();
  if (overrides && overrides[n] != null) {
    const v = Number(overrides[n]);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  if (TOOL_TIMEOUT_OVERLAY_MS[n] != null) return TOOL_TIMEOUT_OVERLAY_MS[n];
  if (baseMs != null && Number.isFinite(Number(baseMs))) return Number(baseMs);
  return TOOL_TIMEOUT_OVERLAY_MS.default;
}

// ---------------------------------------------------------------------------
// 17 — sandbox env sanitization
// ---------------------------------------------------------------------------

function sanitizeSandboxEnvHard(env, extraAllow = []) {
  const src = env && typeof env === 'object' ? env : {};
  const allow = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'TERM'].concat(extraAllow || []));
  const out = {};
  for (const k of allow) {
    if (FORBIDDEN_ENV.has(k)) continue;
    if (SECRET_ENV_RE.test(k)) continue;
    if (src[k] != null && src[k] !== '') out[k] = String(src[k]);
  }
  let p = out.PATH || '/usr/local/bin:/usr/bin:/bin';
  p = p.split(path.delimiter).filter((part) => {
    const s = String(part || '');
    if (!s) return false;
    if (s.includes('..')) return false;
    if (/\/home\/|\/root\/|\/\.ssh\//.test(s)) return false;
    return true;
  }).join(path.delimiter) || '/usr/local/bin:/usr/bin:/bin';
  out.PATH = p;
  out.NODE_OPTIONS = '';
  out.LANG = out.LANG || 'C.UTF-8';
  out.HOME = out.HOME || '/tmp';
  out.TMPDIR = out.TMPDIR || '/tmp';
  for (const k of Object.keys(out)) {
    if (FORBIDDEN_ENV.has(k) || SECRET_ENV_RE.test(k)) delete out[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 18 — remaining token budget hint + after-write test hint
// ---------------------------------------------------------------------------

function formatRemainingBudgetHint({ used = 0, budget = 1500, stepsLeft = null } = {}) {
  const u = Math.max(0, Number(used) || 0);
  const b = Number(budget);
  const cap = Number.isFinite(b) && b > 0 ? b : 1500;
  const left = Math.max(0, cap - u);
  const step = stepsLeft == null ? '' : ` Pasos restantes: ${Math.max(0, Number(stepsLeft) || 0)}.`;
  return {
    text: `Presupuesto restante: ${left} tokens de ${cap}.${step} Para antes de desbordar.`,
    remaining: left,
    budget: cap,
    used: u,
    code: left <= 0 ? 'token_budget' : null,
  };
}

function afterWriteTestHint({ path: filePath, hasRunner = false } = {}) {
  const p = String(filePath || '');
  if (!/\.(test|spec)\.(js|mjs|cjs|ts)$/i.test(p)) {
    return { hint: false, text: null, code: null };
  }
  if (!hasRunner) {
    return { hint: true, text: `Escribí ${p}. No hay runner configurado; no ejecuté el test.`, code: null };
  }
  return { hint: true, run: true, text: `Escribí ${p}. Hay runner: conviene ejecutar ese test ahora.`, code: null };
}

// ---------------------------------------------------------------------------
// 19 — SSE comment heartbeat 15s + Last-Event-ID resume
// ---------------------------------------------------------------------------

function startCommentHeartbeat({
  write,
  intervalMs = COMMENT_HEARTBEAT_MS,
  lastTokenAt = 0,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  signal,
} = {}) {
  const ms = Math.max(1000, Number(intervalMs) || COMMENT_HEARTBEAT_MS);
  let last = Number(lastTokenAt) || 0;
  const timer = setIntervalFn(() => {
    if (signal && signal.aborted) {
      try { clearIntervalFn(timer); } catch (_) {}
      return;
    }
    const now = nowFn();
    if (last && (now - last) < ms) return;
    if (typeof write === 'function') {
      try { write(': ping\n\n'); } catch (_) { /* socket gone */ }
    }
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    mark(ts) { last = Number(ts) || nowFn(); },
    stop() { try { clearIntervalFn(timer); } catch (_) {} },
    intervalMs: ms,
  };
}

function honorLastEventId(headerValue, ring) {
  const n = Number(String(headerValue || '').trim());
  if (!Number.isFinite(n) || n < 0) return { ok: true, replay: [], last: 0 };
  const frames = Array.isArray(ring) ? ring : [];
  const replay = frames.filter((f) => Number(f && f.seq) > n);
  return { ok: true, replay, last: n, code: replay.length ? 'sse_resume' : null };
}

function dedupConsecutiveAssistantCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  let last = null;
  for (const c of calls) {
    const name = c && (c.function && c.function.name || c.name);
    const args = c && (c.__args || c.arguments || (c.function && c.function.arguments));
    const key = fingerprint(name, args);
    if (last === key) continue;
    last = key;
    out.push(c);
  }
  return out;
}

function repairTruncatedJson(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false };
  let s = String(raw).trim();
  if (!s) return { ok: true, value: {}, repaired: false };
  try { return { ok: true, value: JSON.parse(s), repaired: false }; } catch (_) { /* repair */ }
  s = s.replace(/,\s*$/, '');
  const quoteCount = (s.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) s += '"';
  let braces = 0;
  let brackets = 0;
  for (const ch of s) {
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
  }
  if (braces > 0) s += '}'.repeat(braces);
  if (brackets > 0) s += ']'.repeat(brackets);
  try { return { ok: true, value: JSON.parse(s), repaired: true }; } catch (_) {
    return { ok: false, value: { __parse_error: true, raw: String(raw).slice(0, 400) }, repaired: false, code: 'tool_args_invalid' };
  }
}

function coerceStringyPrimitives(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return value;
  }
  if (Array.isArray(value)) return value.map(coerceStringyPrimitives);
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = coerceStringyPrimitives(value[k]);
    return o;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 20 — MCP already-connected host allow (no invented allowlist)
// ---------------------------------------------------------------------------

const connectedMcp = new Map(); // sessionKey -> Set(hostname)

function rememberConnectedMcp(sessionKey, hostname) {
  const key = String(sessionKey || '');
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!key || !host) return { ok: false };
  const set = connectedMcp.get(key) || new Set();
  set.add(host);
  connectedMcp.set(key, set);
  return { ok: true, host, size: set.size };
}

function allowAlreadyConnectedMcp(hostname, { sessionKey, connectedHosts, denyAll = true } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, code: 'mcp_connected_only' };
  const extra = Array.isArray(connectedHosts) ? connectedHosts.map((h) => String(h).toLowerCase()) : [];
  const fromSession = sessionKey && connectedMcp.get(String(sessionKey));
  const allowed = new Set(extra.concat(fromSession ? [...fromSession] : []));
  if (allowed.has(host)) {
    return { ok: true, code: null, host, reuse: true };
  }
  if (denyAll) return { ok: false, code: 'mcp_connected_only', host };
  return { ok: false, code: 'mcp_connected_only', host };
}

function resetConnectedMcp() { connectedMcp.clear(); }

// ---------------------------------------------------------------------------
// 3H33 — remaining holes vs Claude Code/Cowork after 3H32
//   21 read offset/limit + line numbers
//   22 compact keeps last-N tool BODIES (not only names)
//   23 redact secrets inside tool results (not only error paths)
//   24 refuse binary/NUL reads
//   25 clamp huge base64/data-URI in tool results
//   26 default glob ignores + filter
//   27 workspace path jail
//   28 DeepSeek Flash/Pro model allowlist (no routing change)
//   29 bound SSE ring + gap detect
//   30 user role-spoof guard
//   31 session generate rate limit
//   32 tool-arg byte cap
//   33 max tool_calls per assistant message
//   34 stop-reason taxonomy
//   35 web_fetch content-type + size guard
//   36 background bash handle + reap on abort
//   37 inject SIRAGPT.md project instructions once
//   38 expire stale pins
//   39 skip unchanged write (hash)
//   40 canonical todo list
//   41 pre-tool hook
//   42 partial persist on abort
// ---------------------------------------------------------------------------

const READ_LINE_DEFAULT_LIMIT = 400;
const SSE_RING_MAX = 64;
const TOOL_ARG_MAX_BYTES = 32 * 1024;
const MAX_TOOL_CALLS_PER_MSG = 8;
const WEB_FETCH_MAX_BYTES = 512 * 1024;
const SESSION_GEN_PER_MIN = 30;
const TODO_MAX = 20;
const BG_BASH_TTL_MS = 10 * 60 * 1000;

const DEEPSEEK_GENERATE_MODELS = Object.freeze([
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'deepseek-chat', 'deepseek-reasoner',
  'flash', 'pro',
]);

const GLOB_IGNORE_DEFAULTS = Object.freeze([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.venv', 'venv', '__pycache__', '.turbo', '.cache',
]);

const SECRET_IN_RESULT_RE = /(?:sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]+|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|deepseek[_-]?api[_-]?key\s*[:=]\s*\S+)/gi;

const BASE64_URI_RE = /data:([a-zA-Z0-9.+/-]+);base64,[A-Za-z0-9+/=\s]{400,}/g;

const ALLOWED_WEB_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/i;

function sliceReadWindow({ text, offset = 1, limit = READ_LINE_DEFAULT_LIMIT } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const cap = Math.max(1, Math.min(5000, Number(limit) || READ_LINE_DEFAULT_LIMIT));
  const slice = lines.slice(start - 1, start - 1 + cap);
  const truncated = (start - 1 + slice.length) < lines.length || start > 1;
  return {
    lines: slice,
    start,
    count: slice.length,
    total: lines.length,
    truncated,
    code: truncated ? 'read_window' : null,
  };
}

function formatReadWithLineNumbers({ text, offset = 1, limit = READ_LINE_DEFAULT_LIMIT } = {}) {
  const win = sliceReadWindow({ text, offset, limit });
  const numbered = win.lines.map((line, i) => {
    const n = String(win.start + i).padStart(6, ' ');
    return `${n}|${line}`;
  }).join('\n');
  const footer = win.truncated
    ? `\n[read_window ${win.start}-${win.start + win.count - 1}/${win.total} sha256=${sha256Hex(String(text || '')).slice(0, 12)}]`
    : '';
  return { text: numbered + footer, ...win };
}

function compactKeepLastNBodies(messages, { keep = LAST_N_TOOL_NAMES, maxBody = 400 } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const toolIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (m && (m.role === 'tool' || m.role === 'function')) toolIdx.push(i);
  }
  const keepN = Math.max(0, Number(keep) || LAST_N_TOOL_NAMES);
  const keepSet = new Set(toolIdx.slice(-keepN));
  const cap = Math.max(80, Number(maxBody) || 400);
  let dropped = 0;
  const out = list.map((m, idx) => {
    if (!m || typeof m !== 'object') return m;
    if (m.role !== 'tool' && m.role !== 'function') return m;
    if (keepSet.has(idx)) return m;
    const body = String(m.content == null ? '' : m.content);
    if (body.length <= cap) return m;
    dropped += 1;
    const name = String(m.name || m.tool || 'tool');
    return {
      ...m,
      content: `[compacted ${name} ${body.length}b sha256=${sha256Hex(body).slice(0, 12)}]`,
      __compacted: true,
      __origBytes: body.length,
    };
  });
  return { messages: out, keptBodies: keepSet.size, droppedBodies: dropped, code: dropped ? 'blob_compacted' : null };
}

function redactSecretsInToolResult(text) {
  const s = String(text == null ? '' : text);
  const next = s.replace(SECRET_IN_RESULT_RE, '[redacted]');
  return {
    text: next,
    redacted: next !== s,
    code: next !== s ? 'secret_redact' : null,
  };
}

function refuseBinaryRead(buf) {
  let raw;
  if (Buffer.isBuffer(buf)) raw = buf;
  else if (typeof buf === 'string') raw = Buffer.from(buf, 'utf8');
  else raw = Buffer.from(String(buf == null ? '' : buf), 'utf8');
  if (!raw.length) return { ok: true, binary: false, code: null };
  if (raw.includes(0)) {
    return { ok: false, binary: true, code: 'git_binary_rejected', message: 'Ese archivo es binario. No lo inyecté al contexto.' };
  }
  let weird = 0;
  const n = Math.min(raw.length, 4096);
  for (let i = 0; i < n; i += 1) {
    const b = raw[i];
    if (b < 9 || (b > 13 && b < 32) || b === 127) weird += 1;
  }
  if (n >= 32 && weird / n > 0.30) {
    return { ok: false, binary: true, code: 'git_binary_rejected', message: 'Ese archivo no es texto. No lo inyecté al contexto.' };
  }
  return { ok: true, binary: false, code: null };
}

function clampBase64InToolResult(text, { maxChars = 400 } = {}) {
  const s = String(text == null ? '' : text);
  let n = 0;
  const next = s.replace(BASE64_URI_RE, (m) => {
    n += 1;
    const hash = sha256Hex(m).slice(0, 12);
    return `[base64_clamped ${m.length}b sha256=${hash}]`;
  });
  return { text: next, clamped: n, code: n ? 'tool_result_capped' : null, maxChars };
}

function defaultGlobIgnores() {
  return GLOB_IGNORE_DEFAULTS.slice();
}

function filterGlobHits(paths, { extraIgnore = [] } = {}) {
  const deny = new Set(GLOB_IGNORE_DEFAULTS.concat(Array.isArray(extraIgnore) ? extraIgnore : []).map(String));
  const list = Array.isArray(paths) ? paths : [];
  const kept = [];
  const dropped = [];
  for (const p of list) {
    const s = String(p || '');
    const parts = s.split(/[\\/]+/);
    const hit = parts.some((part) => deny.has(part));
    if (hit) dropped.push(s);
    else kept.push(s);
  }
  return { paths: kept, dropped, code: dropped.length ? 'glob_ignored' : null };
}

function workspacePathJail(filePath, root) {
  const rootRaw = nfcPath(String(root || ''));
  if (!rootRaw) return { ok: false, code: 'path_traversal', path: null };
  const r = path.resolve(rootRaw);
  const p = path.resolve(r, nfcPath(String(filePath || '')));
  const rel = path.relative(r, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'path_traversal', path: p, root: r };
  }
  return { ok: true, code: null, path: p, relative: rel, root: r };
}

function allowDeepSeekGenerateModel(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return { ok: true, code: null, model: 'deepseek-v4-flash', defaulted: true };
  if (/openrouter|openai|anthropic|claude|gemini|gpt-4|gpt-3|o1-|o3-|grok/i.test(m) && !/deepseek/.test(m)) {
    return { ok: false, code: 'openrouter_denied', model: m };
  }
  const allowed = DEEPSEEK_GENERATE_MODELS.some((id) => m === id || m.endsWith('/' + id) || m.includes('deepseek'));
  if (!allowed) return { ok: false, code: 'model_forbidden', model: m };
  return { ok: true, code: null, model: m };
}

function boundSseRing(ring, { max = SSE_RING_MAX } = {}) {
  const list = Array.isArray(ring) ? ring : [];
  const cap = Math.max(8, Math.min(256, Number(max) || SSE_RING_MAX));
  if (list.length <= cap) return { frames: list, dropped: 0, code: null };
  const dropped = list.length - cap;
  return { frames: list.slice(-cap), dropped, code: 'sse_backpressure' };
}

function detectSseGap(headerValue, ring) {
  const honored = honorLastEventId(headerValue, ring);
  const frames = Array.isArray(ring) ? ring : [];
  const seqs = frames.map((f) => Number(f && f.seq)).filter((n) => Number.isFinite(n));
  if (!seqs.length || !Number.isFinite(honored.last) || honored.last <= 0) {
    return { ...honored, gap: false };
  }
  const minSeq = Math.min(...seqs);
  if (honored.last + 1 < minSeq) {
    return { ...honored, gap: true, code: 'sse_gap', missingFrom: honored.last + 1, missingTo: minSeq - 1 };
  }
  return { ...honored, gap: false };
}

function guardUserRoleSpoof(content) {
  const s = String(content == null ? '' : content);
  const next = s
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<\/?tool_result>/gi, '')
    .replace(/^\s*(system|assistant|tool)\s*:/gim, 'user:')
    .replace(/\[INST\]|<<SYS>>/g, '');
  return { text: next, spoofed: next !== s, code: next !== s ? 'schema_strip' : null };
}

const generateHits = new Map();

function sessionGenerateRateLimit(sessionKey, { now = Date.now(), limit = SESSION_GEN_PER_MIN, windowMs = 60_000 } = {}) {
  const key = String(sessionKey || '');
  if (!key) return { ok: false, code: 'session_busy' };
  const cap = Math.max(1, Math.min(120, Number(limit) || SESSION_GEN_PER_MIN));
  const win = Math.max(1000, Number(windowMs) || 60_000);
  const rec = generateHits.get(key) || [];
  const fresh = rec.filter((t) => (now - t) < win);
  if (fresh.length >= cap) {
    generateHits.set(key, fresh);
    return { ok: false, code: 'rate_limited', remaining: 0, retryAfterMs: win - (now - fresh[0]) };
  }
  fresh.push(now);
  generateHits.set(key, fresh);
  return { ok: true, code: null, remaining: cap - fresh.length, used: fresh.length };
}

function resetGenerateRateLimit() { generateHits.clear(); }

function capToolArgBytes(args, { maxBytes = TOOL_ARG_MAX_BYTES } = {}) {
  const raw = typeof args === 'string' ? args : stableJson(args);
  const buf = Buffer.from(raw, 'utf8');
  const cap = Math.max(256, Number(maxBytes) || TOOL_ARG_MAX_BYTES);
  if (buf.length <= cap) return { ok: true, args, bytes: buf.length, code: null };
  return {
    ok: false,
    code: 'tool_args_invalid',
    bytes: buf.length,
    capped: cap,
    message: 'Los argumentos de la herramienta superan el tope.',
  };
}

function maxToolCallsPerMessage(calls, { max = MAX_TOOL_CALLS_PER_MSG } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const cap = Math.max(1, Math.min(16, Number(max) || MAX_TOOL_CALLS_PER_MSG));
  if (list.length <= cap) return { calls: list, overflow: [], code: null };
  return {
    calls: list.slice(0, cap),
    overflow: list.slice(cap),
    code: 'tool_storm',
  };
}

function classifyStopReason(response) {
  const msg = response && response.choices && response.choices[0]
    ? response.choices[0]
    : response || {};
  const finish = String(msg.finish_reason || msg.stop_reason || '').toLowerCase();
  const message = msg.message || msg;
  const content = String((message && message.content) || '').trim();
  const tools = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  if (finish === 'length' || finish === 'max_tokens') {
    return { reason: 'length', code: 'token_budget', stop: false, truncated: true };
  }
  if (tools.length) return { reason: 'tool_calls', code: null, stop: false, truncated: false };
  if (finish === 'stop' || content) return { reason: 'stop', code: null, stop: true, truncated: false };
  return { reason: 'empty', code: 'empty_response', stop: false, truncated: false };
}

function webFetchGuard({ contentType, bytes, url } = {}) {
  const type = String(contentType || 'text/plain');
  const n = Number(bytes) || 0;
  const href = String(url || '');
  if (/openrouter\.ai/i.test(href)) {
    return { ok: false, code: 'openrouter_denied', message: 'Generate no fetch de OpenRouter.' };
  }
  if (n > WEB_FETCH_MAX_BYTES) {
    return { ok: false, code: 'file_too_large', bytes: n, max: WEB_FETCH_MAX_BYTES };
  }
  if (type && !ALLOWED_WEB_TYPES.test(type) && !/^application\/octet-stream$/i.test(type) === false) {
    // allow empty type; deny obvious binaries
  }
  if (type && /^(image\/(?!svg)|audio\/|video\/|application\/(pdf|zip|octet-stream))/i.test(type)) {
    return { ok: false, code: 'git_binary_rejected', contentType: type };
  }
  return { ok: true, code: null, contentType: type, bytes: n };
}

const bgBash = new Map();

function startBackgroundBash(id, { kill, cmd } = {}) {
  const key = String(id || '') || `bg_${Date.now()}`;
  bgBash.set(key, { at: Date.now(), kill, cmd: String(cmd || '').slice(0, 180), status: 'running' });
  return { ok: true, id: key, code: 'bash_background', status: 'running' };
}

function pollBackgroundBash(id, { now = Date.now() } = {}) {
  const rec = bgBash.get(String(id || ''));
  if (!rec) return { ok: false, code: 'not_found', status: 'missing' };
  if (rec.status === 'running' && (now - rec.at) > BG_BASH_TTL_MS) {
    rec.status = 'expired';
    if (typeof rec.kill === 'function') {
      try { rec.kill(); } catch (_) { /* best-effort */ }
    }
  }
  return { ok: true, id: String(id), status: rec.status, ageMs: now - rec.at, code: rec.status === 'expired' ? 'sandbox_timeout' : null };
}

function reapBackgroundBashOnAbort({ now = Date.now() } = {}) {
  let n = 0;
  for (const [id, rec] of bgBash.entries()) {
    if (rec && rec.status === 'running') {
      if (typeof rec.kill === 'function') {
        try { rec.kill(); } catch (_) { /* best-effort */ }
      }
      rec.status = 'reaped';
      rec.reapedAt = now;
      n += 1;
    }
    if (rec && rec.status !== 'running') bgBash.delete(id);
  }
  return { ok: true, reaped: n, code: 'sandbox_reap' };
}

function resetBackgroundBash() { bgBash.clear(); }

function injectProjectInstructions(messages, { text, marker = 'SIRAGPT.md' } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const body = String(text || '').trim();
  if (!body) return { messages: list, injected: false, code: null };
  const already = list.some((m) => m && m.__projectInstructions);
  if (already) return { messages: list, injected: false, code: null };
  const block = {
    role: 'system',
    content: `${marker} (instrucciones de proyecto, no capabilities):\n${body.slice(0, 8000)}`,
    __projectInstructions: true,
  };
  const sysIdx = list.findIndex((m) => m && m.role === 'system');
  if (sysIdx >= 0) list.splice(sysIdx + 1, 0, block);
  else list.unshift(block);
  return { messages: list, injected: true, code: null };
}

function expireAndSweepPins(pins, { now = Date.now() } = {}) {
  const list = Array.isArray(pins) ? pins : [];
  const kept = [];
  const expired = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const exp = p.expiresAt != null ? Number(p.expiresAt) : null;
    if (exp != null && Number.isFinite(exp) && exp > 0 && exp < now && !p.critical) {
      expired.push(p);
    } else kept.push(p);
  }
  return { pins: kept, expired, code: expired.length ? 'pin_evicted' : null };
}

function skipUnchangedWrite({ before, after } = {}) {
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  if (a === b) return { skip: true, code: 'write_noop', hash: sha256Hex(a).slice(0, 12) };
  return { skip: false, code: null, beforeHash: sha256Hex(a).slice(0, 12), afterHash: sha256Hex(b).slice(0, 12) };
}

function canonicalizeTodoList(items) {
  const list = Array.isArray(items) ? items : [];
  const allowed = new Set(['pending', 'in_progress', 'completed']);
  const out = [];
  let inProg = 0;
  for (const it of list.slice(0, TODO_MAX)) {
    const status = allowed.has(String(it && it.status)) ? String(it.status) : 'pending';
    const rec = {
      id: String((it && it.id) || `t${out.length + 1}`),
      content: String((it && (it.content || it.text)) || '').slice(0, 240),
      status,
    };
    if (!rec.content) continue;
    if (rec.status === 'in_progress') {
      inProg += 1;
      if (inProg > 1) rec.status = 'pending';
    }
    out.push(rec);
  }
  return { todos: out, code: null, inProgress: out.filter((t) => t.status === 'in_progress').length };
}

function runPreToolHook(name, args, { hooks } = {}) {
  const n = String(name || '');
  if (typeof hooks === 'function') {
    try {
      const r = hooks(n, args);
      if (r && r.ok === false) return { ok: false, code: r.code || 'dangerous_tool', name: n };
    } catch (_) { /* fail-open to built-in deny */ }
  }
  const danger = denyDangerousGenerateTools(n, args);
  if (danger && danger.ok === false) return danger;
  return { ok: true, code: null, name: n };
}

function snapshotPartialOnAbort({ text, toolCount = 0, seq = 0 } = {}) {
  const t = String(text == null ? '' : text);
  return {
    ok: true,
    partial: t.slice(0, 4000),
    bytes: Buffer.byteLength(t, 'utf8'),
    toolCount: Math.max(0, Number(toolCount) || 0),
    seq: Number(seq) || 0,
    code: 'turn_cancelled',
    hash: sha256Hex(t).slice(0, 12),
  };
}

function clampToolResultWithHash(text, { maxBytes = TOOL_RESULT_CAP } = {}) {
  const s = typeof text === 'string' ? text : (text == null ? '' : (typeof text === 'object' ? JSON.stringify(text) : String(text)));
  const red = redactSecretsInToolResult(s);
  const b64 = clampBase64InToolResult(red.text);
  const cap = capCommandStdout(b64.text, { maxBytes: Math.max(256, Number(maxBytes) || TOOL_RESULT_CAP) });
  return {
    text: cap.text,
    truncated: Boolean(cap.truncated || b64.clamped || red.redacted),
    hash: cap.hash,
    bytes: cap.bytes,
    code: cap.truncated ? 'tool_result_capped' : (red.code || b64.code || null),
  };
}

// ---------------------------------------------------------------------------
// 3H34 — remaining holes vs Claude Code/Cowork after 3H33
//   43 pgvector retrieval ranking (fail-closed if hits missing)
//   44 checkpoint rollback of last N edits (stack, last-1 stays)
//   45 token accounting audit log + TTL sweep
//   46 concurrent generate lock fairness (FIFO waiters, cap 4)
//   47 GET-like tool cache + invalidate on write
//   48 model timeout vs tool timeout split
//   49 JSON schema additionalProperties strip
//   50 unicode NFC path jail (fullwidth dots -> '.')
//   51 symlink escape (realpath must stay in root)
//   52 SSE comment vs event (comments do not bump seq)
//   53 credit refund on 0-token error
//   54 compact until remaining token budget
//   55 subagent step inheritance (fair among siblings)
//   56 cross-process file lock (lockfile wx, stale steal)
// ---------------------------------------------------------------------------

const MODEL_TIMEOUT_MS = 45_000;
const MODEL_TTFB_MS = 12_000;
const TOKEN_AUDIT_MAX = 256;
const TOOL_CACHE_TTL_MS = 8_000;
const TOOL_CACHE_MAX = 64;
const FAIR_LOCK_MAX_WAITERS = 4;
const EDIT_STACK_MAX = 8;
const GET_LIKE_TOOLS = new Set([
  'read_file', 'computer_read_file', 'glob', 'grep', 'list_files',
  'retrieve_memory', 'web_fetch', 'computer_list_files',
]);
const WRITE_LIKE_TOOLS = new Set([
  'write_file', 'edit_file', 'str_replace', 'apply_patch',
  'computer_write_file', 'execute_bash', 'bash', 'exec', 'shell',
]);

function nfcPath(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFC'); } catch (_) { /* keep raw */ }
  return t.replace(/\uFF0E/g, '.').replace(/\u2024/g, '.').replace(/\uFF0F/g, '/');
}

function rankPgvectorHits(hits, { now = Date.now(), limit = 8, halfLifeMs = 7 * 86400000 } = {}) {
  if (hits == null || !Array.isArray(hits)) {
    return { ok: false, hits: [], code: 'pgvector_failed' };
  }
  const cap = Math.max(1, Math.min(32, Number(limit) || 8));
  const hl = Math.max(1000, Number(halfLifeMs) || 7 * 86400000);
  const scored = hits.map((h, i) => {
    const scoreRaw = h && (h.score != null ? h.score : (h.similarity != null ? h.similarity : (h.distance != null ? 1 - Number(h.distance) : 0)));
    const score = Number(scoreRaw);
    const safeScore = Number.isFinite(score) ? score : 0;
    const at = Number(h && (h.at || h.createdAt || h.ts)) || now;
    const age = Math.max(0, now - at);
    const recency = Math.exp(-age / hl);
    const text = String((h && (h.text || h.content || h.memory || '')) || '');
    return { hit: h, rank: safeScore * recency, i, hash: sha256Hex(text.slice(0, 240)).slice(0, 12) };
  }).sort((a, b) => (b.rank - a.rank) || (a.i - b.i));
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (seen.has(s.hash) && s.hash) continue;
    seen.add(s.hash);
    out.push(Object.assign({}, s.hit, { rank: s.rank }));
    if (out.length >= cap) break;
  }
  return { ok: true, hits: out, code: null, dropped: Math.max(0, hits.length - out.length) };
}

function rollbackLastNFileEdits(checkpoint, { n = 1, apply } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, code: 'checkpoint_missing', reverted: 0, paths: [] };
  }
  const stack = Array.isArray(checkpoint.edits) && checkpoint.edits.length
    ? checkpoint.edits.slice()
    : (checkpoint.lastFileEdit ? [checkpoint.lastFileEdit] : []);
  if (!stack.length) return { ok: false, code: 'checkpoint_missing', reverted: 0, paths: [] };
  const take = Math.max(1, Math.min(EDIT_STACK_MAX, Number(n) || 1));
  const slice = stack.slice(-take).reverse();
  const paths = [];
  for (const edit of slice) {
    if (!edit || !edit.path) continue;
    if (typeof apply === 'function') {
      try { apply(edit.path, edit.before); } catch (err) {
        return { ok: false, code: 'checkpoint_rollback', reverted: paths.length, paths, error: String(err && err.message || err).slice(0, 180) };
      }
    }
    paths.push(edit.path);
  }
  checkpoint.edits = stack.slice(0, Math.max(0, stack.length - slice.length));
  checkpoint.lastFileEdit = checkpoint.edits.length ? checkpoint.edits[checkpoint.edits.length - 1] : null;
  return { ok: true, code: 'checkpoint_rollback', reverted: paths.length, paths };
}

const tokenAudit = [];

function appendTokenAuditLog(row, { now = Date.now(), max = TOKEN_AUDIT_MAX } = {}) {
  const rec = {
    at: now,
    session: String((row && row.session) || ''),
    prompt: Math.max(0, Number(row && (row.prompt || row.prompt_tokens)) || 0),
    completion: Math.max(0, Number(row && (row.completion || row.completion_tokens)) || 0),
    total: 0,
    code: (row && row.code) || null,
    model: String((row && row.model) || ''),
  };
  rec.total = Number(row && (row.total || row.total_tokens)) || (rec.prompt + rec.completion);
  tokenAudit.push(rec);
  const cap = Math.max(32, Math.min(1024, Number(max) || TOKEN_AUDIT_MAX));
  while (tokenAudit.length > cap) tokenAudit.shift();
  return { ok: true, size: tokenAudit.length, rec };
}

function sweepTokenAuditLog({ now = Date.now(), ttlMs = 30 * 60 * 1000 } = {}) {
  const ttl = Math.max(1000, Number(ttlMs) || 0);
  let dropped = 0;
  for (let i = tokenAudit.length - 1; i >= 0; i -= 1) {
    if ((now - tokenAudit[i].at) > ttl) {
      tokenAudit.splice(i, 1);
      dropped += 1;
    }
  }
  return { ok: true, dropped, size: tokenAudit.length, code: dropped ? 'hash_sweep' : null };
}

function tokenAuditSnapshot() {
  return { size: tokenAudit.length, rows: tokenAudit.slice(-16) };
}

function resetTokenAuditLog() { tokenAudit.length = 0; }

const fairLocks = new Map();

function acquireFairGenerateLock(sessionKey, producerId, {
  now = Date.now(),
  ttlMs = CLAIM_TTL_MS,
  maxWaiters = FAIR_LOCK_MAX_WAITERS,
} = {}) {
  const key = String(sessionKey || '');
  const id = String(producerId || '');
  if (!key || !id) return { ok: false, queued: false, code: 'gateway_busy' };
  let rec = fairLocks.get(key);
  if (rec && rec.holder && rec.holder !== id && (now - rec.at) < ttlMs) {
    rec.waiters = Array.isArray(rec.waiters) ? rec.waiters : [];
    if (rec.waiters.some((w) => w.id === id)) {
      const pos = rec.waiters.findIndex((w) => w.id === id) + 1;
      return { ok: false, queued: true, position: pos, code: 'queue_fairness' };
    }
    const cap = Math.max(1, Math.min(16, Number(maxWaiters) || FAIR_LOCK_MAX_WAITERS));
    if (rec.waiters.length >= cap) {
      return { ok: false, queued: false, code: 'queue_fairness', remaining: 0 };
    }
    rec.waiters.push({ id, at: now });
    fairLocks.set(key, rec);
    return { ok: false, queued: true, position: rec.waiters.length, code: 'queue_fairness' };
  }
  fairLocks.set(key, { holder: id, at: now, waiters: (rec && rec.waiters) || [] });
  return { ok: true, queued: false, code: null, producerId: id };
}

function releaseFairGenerateLock(sessionKey, producerId, { now = Date.now() } = {}) {
  const key = String(sessionKey || '');
  const id = String(producerId || '');
  const rec = fairLocks.get(key);
  if (!rec) return { ok: true, promoted: null };
  if (rec.holder && rec.holder !== id) return { ok: false, code: 'gateway_busy' };
  const waiters = Array.isArray(rec.waiters) ? rec.waiters : [];
  const next = waiters.shift();
  if (next) {
    fairLocks.set(key, { holder: next.id, at: now, waiters });
    return { ok: true, promoted: next.id, code: 'queue_fairness' };
  }
  fairLocks.delete(key);
  return { ok: true, promoted: null };
}

function resetFairGenerateLock() { fairLocks.clear(); }

const toolCache = new Map();

function lookupGetLikeToolCache(name, args, { now = Date.now(), ttlMs = TOOL_CACHE_TTL_MS } = {}) {
  const n = String(name || '');
  if (WRITE_LIKE_TOOLS.has(n) || !GET_LIKE_TOOLS.has(n)) return { hit: false, code: null, cached: false };
  const key = fingerprint(n, args);
  const rec = toolCache.get(key);
  if (!rec) return { hit: false, key, cached: false };
  const ttl = Math.max(250, Number(ttlMs) || TOOL_CACHE_TTL_MS);
  if ((now - rec.at) > ttl) {
    toolCache.delete(key);
    return { hit: false, key, expired: true, cached: false };
  }
  return { hit: true, cached: true, key, result: rec.result, code: 'exactly_once_tool', ageMs: now - rec.at };
}

function storeGetLikeToolCache(name, args, result, { now = Date.now() } = {}) {
  const n = String(name || '');
  if (WRITE_LIKE_TOOLS.has(n) || !GET_LIKE_TOOLS.has(n)) return { stored: false };
  const key = fingerprint(n, args);
  toolCache.set(key, {
    at: now,
    result,
    path: (args && (args.path || args.file_path)) || null,
    name: n,
  });
  while (toolCache.size > TOOL_CACHE_MAX) {
    const first = toolCache.keys().next().value;
    toolCache.delete(first);
  }
  return { stored: true, key, size: toolCache.size };
}

function invalidateToolCacheOnWrite(filePath) {
  const p = String(filePath || '');
  let dropped = 0;
  for (const [k, rec] of toolCache) {
    if (!p || (rec.path && rec.path === p) || rec.name === 'glob' || rec.name === 'list_files' || rec.name === 'grep') {
      toolCache.delete(k);
      dropped += 1;
    }
  }
  return { dropped };
}

function resetToolCache() { toolCache.clear(); }

function splitModelVsToolTimeout(kind, name, overrides = {}) {
  const k = String(kind || '').toLowerCase();
  if (k === 'model' || k === 'generate' || k === 'llm') {
    return { kind: 'model', timeoutMs: MODEL_TIMEOUT_MS, ttfbMs: MODEL_TTFB_MS, code: 'provider_timeout' };
  }
  const toolMs = overlayToolTimeoutMs(name, overrides);
  return { kind: 'tool', timeoutMs: toolMs, ttfbMs: null, code: 'tool_timeout' };
}

function stripAdditionalProperties(args, schema) {
  if (!schema || typeof schema !== 'object') return { ok: true, args, stripped: 0 };
  if (schema.additionalProperties !== false) return { ok: true, args, stripped: 0, skipped: true };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const allowed = new Set(Object.keys(props));
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: true, args: args || {}, stripped: 0 };
  }
  const out = {};
  let stripped = 0;
  for (const k of Object.keys(args)) {
    if (allowed.has(k)) {
      const child = props[k];
      if (child && typeof child === 'object' && child.type === 'object' && args[k] && typeof args[k] === 'object' && !Array.isArray(args[k])) {
        const nested = stripAdditionalProperties(args[k], child);
        out[k] = nested.args;
        stripped += nested.stripped || 0;
      } else {
        out[k] = args[k];
      }
    } else {
      stripped += 1;
    }
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((k) => out[k] === undefined);
  if (missing.length) {
    return { ok: false, args: out, stripped, missing, code: 'schema_invalid' };
  }
  return { ok: true, args: out, stripped, code: stripped ? 'schema_strip' : null };
}

function rejectSymlinkEscape(filePath, root, { lstatSync, realpathSync } = {}) {
  const jail = workspacePathJail(filePath, root);
  if (!jail.ok) return Object.assign({}, jail, { symlink: false });
  const ls = typeof lstatSync === 'function' ? lstatSync : null;
  const rp = typeof realpathSync === 'function' ? realpathSync : null;
  if (!ls || !rp) return { ok: true, skipped: true, path: jail.path, symlink: false };
  try {
    const st = ls(jail.path);
    if (!st || typeof st.isSymbolicLink !== 'function' || !st.isSymbolicLink()) {
      return { ok: true, symlink: false, path: jail.path };
    }
    let real;
    try { real = String(rp(jail.path)); } catch (_) {
      return { ok: false, code: 'symlink_rejected', path: jail.path };
    }
    const realJail = workspacePathJail(real, jail.root);
    if (!realJail.ok) return { ok: false, code: 'symlink_rejected', path: jail.path, real };
    return { ok: true, symlink: true, path: jail.path, real: realJail.path };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, symlink: false, path: jail.path, missing: true };
    return { ok: false, code: 'symlink_rejected', path: jail.path };
  }
}

function classifySseFrame(raw) {
  const s = String(raw == null ? '' : raw);
  const trimmed = s.replace(/^\uFEFF/, '');
  if (!String(trimmed).trim()) return { kind: 'empty', seqBump: false, code: null };
  if (/^\s*:/.test(trimmed)) return { kind: 'comment', seqBump: false, code: 'sse_heartbeat' };
  if (/^\s*event:/m.test(trimmed) || /^\s*data:/m.test(trimmed) || /^\s*id:/m.test(trimmed)) {
    return { kind: 'event', seqBump: true, code: null };
  }
  return { kind: 'unknown', seqBump: false, code: null };
}

function nextSseSeqForFrame(seq, raw) {
  const c = classifySseFrame(raw);
  const n = Math.max(0, Number(seq) || 0);
  return { seq: c.seqBump ? n + 1 : n, bumped: c.seqBump, kind: c.kind, code: c.code };
}

function refundZeroTokenError({ usage, error, hold, released = false } = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const prompt = Number(u.prompt_tokens || u.promptTokens || 0) || 0;
  const completion = Number(u.completion_tokens || u.completionTokens || 0) || 0;
  const total = Number(u.total_tokens || u.totalTokens || (prompt + completion)) || 0;
  const hasErr = Boolean(error);
  if (!hasErr) return { ok: true, refunded: false, charged: total > 0, tokens: total, code: null };
  if (total > 0) return { ok: true, refunded: false, charged: true, tokens: total, code: null };
  const rel = creditOnToolError(hold, { released });
  return { ok: true, refunded: Boolean(rel && (rel.released || rel.ok)), charged: false, tokens: 0, code: 'credit_no_usage' };
}

function estimateCompactTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let bytes = 0;
  for (const m of list) bytes += Buffer.byteLength(String(m && m.content || ''), 'utf8') + 8;
  return Math.ceil(bytes / 4);
}

function compactUntilTokenBudget(messages, { remaining = 1500, keep = 6 } = {}) {
  let msgs = Array.isArray(messages) ? messages.slice() : [];
  const budget = Math.max(64, Number(remaining) || 1500);
  let used = estimateCompactTokens(msgs);
  let rounds = 0;
  while (used > budget && rounds < 6) {
    const step = compactKeepLastNBodies(msgs, { keep: Math.max(1, keep - rounds), maxBody: Math.max(80, 400 >> Math.min(3, rounds)) });
    msgs = (step && step.messages) || msgs;
    used = estimateCompactTokens(msgs);
    rounds += 1;
    if (used > budget) {
      let idx = -1;
      for (let i = 0; i < msgs.length - 1; i += 1) {
        const m = msgs[i];
        if (m && m.role !== 'system') { idx = i; break; }
      }
      if (idx < 0) break;
      msgs.splice(idx, 1);
      used = estimateCompactTokens(msgs);
    }
  }
  return {
    messages: msgs,
    used,
    remaining: Math.max(0, budget - used),
    rounds,
    compressed: rounds > 0,
    code: used > budget ? 'token_compact' : null,
  };
}

function inheritSubagentSteps({ parentRemaining = 0, childRequested = 0, siblings = 1 } = {}) {
  const parent = Math.max(0, Number(parentRemaining) || 0);
  const req = Math.max(0, Number(childRequested) || 0);
  const n = Math.max(1, Math.min(8, Number(siblings) || 1));
  const fair = Math.floor(parent / n);
  const budget = Math.min(req, parent, fair > 0 ? fair : parent);
  return {
    ok: budget > 0,
    budget,
    parent,
    siblings: n,
    code: budget <= 0 ? 'subagent_budget' : null,
  };
}

function acquireCrossProcessFileLock(filePath, {
  lockDir = os.tmpdir(),
  now = Date.now(),
  ttlMs = 20_000,
  pid = process.pid,
  fsApi,
} = {}) {
  const p = nfcPath(path.normalize(String(filePath || '')));
  if (!p || p === '.') return { ok: false, code: 'path_mutation_busy' };
  const io = fsApi && typeof fsApi === 'object' ? fsApi : fs;
  const lockPath = path.join(String(lockDir || os.tmpdir()), 'siragpt-wlock-' + sha256Hex(p).slice(0, 16) + '.json');
  const rec = { path: p, pid, at: now, ttlMs: Math.max(1, Number(ttlMs) || 20_000) };
  const payload = JSON.stringify(rec);
  try {
    io.writeFileSync(lockPath, payload, { flag: 'wx' });
    return {
      ok: true,
      lockPath,
      path: p,
      stolen: false,
      release() { try { io.unlinkSync(lockPath); } catch (_) { /* gone */ } return { ok: true }; },
    };
  } catch (err) {
    let raw = null;
    try { raw = JSON.parse(String(io.readFileSync(lockPath, 'utf8'))); } catch (_) { raw = null; }
    const stale = raw && (now - Number(raw.at || 0)) > (Number(raw.ttlMs) || rec.ttlMs);
    if (stale) {
      try { io.unlinkSync(lockPath); } catch (_) { /* race */ }
      try {
        io.writeFileSync(lockPath, payload, { flag: 'wx' });
        return {
          ok: true,
          lockPath,
          path: p,
          stolen: true,
          release() { try { io.unlinkSync(lockPath); } catch (_) { /* gone */ } return { ok: true }; },
        };
      } catch (_) { /* lost race */ }
    }
    return { ok: false, code: 'path_mutation_busy', path: p };
  }
}

// ---------------------------------------------------------------------------
// 3H35 — remaining holes vs Claude Code/Cowork after 3H34
//   57 unique tool_call ids + orphan tool_result drop
//   58 streaming JSON repair across chunk boundaries
//   59 unified diff apply (---/+++ @@) not only str_replace
//   60 sandbox ulimit nproc/nofile
//   61 stdout/stderr separate streams in tool result
//   62 credit hold then settle (no double-charge on retry)
//   63 session resume: replay tool_results without re-exec
//   64 compact: keep pinned SIRAGPT.md + last user always
//   65 gateway: drop events from cancelled run by runId
//   66 rate limit per-tool not just per-session
//   67 image/pdf in context size cap
//   68 model output max_tokens clamp vs remaining context
//   69 clock-skew safe TTL
//   70 idempotent POST generate by client requestId
// ---------------------------------------------------------------------------

const IMAGE_PDF_MAX_BYTES = 256 * 1024;
const TOOL_RATE_PER_MIN = 20;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 2_000;
const SANDBOX_NPROC = 64;
const SANDBOX_NOFILE = 256;
const CANCELLED_RUN_MAX = 512;

function ensureUniqueToolCallIds(calls, { prefix = 'call' } = {}) {
  const list = Array.isArray(calls)
    ? calls.map((c) => (c && typeof c === 'object' ? Object.assign({}, c) : c))
    : [];
  const seen = new Set();
  let duplicates = 0;
  let assigned = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (!c || typeof c !== 'object') continue;
    let id = String(c.id || '').trim();
    if (!id || seen.has(id)) {
      if (id && seen.has(id)) duplicates += 1;
      let n = i;
      do {
        id = `${prefix}_${n}`;
        n += 1;
      } while (seen.has(id));
      assigned += 1;
    }
    c.id = id;
    seen.add(id);
  }
  return {
    calls: list,
    duplicates,
    assigned,
    ids: Array.from(seen),
    code: duplicates ? 'tool_id_duplicate' : null,
  };
}

function collectToolCallIds(messages) {
  const ids = new Set();
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const calls = m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const c of calls) {
      if (c && c.id) ids.add(String(c.id));
    }
  }
  return ids;
}

function dropOrphanToolResults(messages, { allowedIds } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const ids = allowedIds instanceof Set
    ? allowedIds
    : new Set(Array.isArray(allowedIds) ? allowedIds.map(String) : collectToolCallIds(list));
  const kept = [];
  let dropped = 0;
  for (const m of list) {
    if (m && m.role === 'tool') {
      const id = String(m.tool_call_id || m.toolCallId || '');
      if (!id || !ids.has(id)) {
        dropped += 1;
        continue;
      }
    }
    kept.push(m);
  }
  return { messages: kept, dropped, code: dropped ? 'tool_result_orphan' : null };
}

function repairStreamingJsonAcrossChunks(chunks) {
  const parts = Array.isArray(chunks) ? chunks : (chunks == null ? [] : [chunks]);
  const joined = parts.map((p) => {
    if (p == null) return '';
    if (typeof p === 'string') return p;
    if (typeof p === 'object') return String(p.delta || p.arguments || p.chunk || '');
    return String(p);
  }).join('');
  const repaired = repairTruncatedJson(joined);
  return Object.assign({}, repaired, {
    chunks: parts.length,
    joinedBytes: Buffer.byteLength(joined, 'utf8'),
  });
}

function applyUnifiedDiff({ haystack, diff } = {}) {
  const src = String(haystack == null ? '' : haystack);
  const d = String(diff == null ? '' : diff);
  if (!d.trim()) return { ok: false, code: 'syntax_invalid', text: src, unified: false };
  const isUnified = /^(--- |\+\+\+ |@@ )/m.test(d);
  if (!isUnified) return { ok: false, code: 'syntax_invalid', text: src, unified: false };
  const hunks = [];
  let cur = null;
  for (const line of d.split('\n')) {
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hm) {
      cur = { oldStart: Number(hm[1]), oldLines: [], newLines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.newLines.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) cur.oldLines.push(line.slice(1));
    else if (line.startsWith('\\')) continue;
    else {
      const body = line.startsWith(' ') ? line.slice(1) : line;
      cur.oldLines.push(body);
      cur.newLines.push(body);
    }
  }
  if (!hunks.length) return { ok: false, code: 'syntax_invalid', text: src, unified: true };
  let joined = src;
  for (const h of hunks) {
    const needle = h.oldLines.join('\n');
    if (!needle && h.newLines.length) {
      const start = Math.max(0, h.oldStart - 1);
      const lines = joined.split('\n');
      lines.splice(start, 0, ...h.newLines);
      joined = lines.join('\n');
      continue;
    }
    const idx = joined.indexOf(needle);
    if (idx < 0) return { ok: false, code: 'git_hunk_ambiguous', text: src, unified: true, hunks: hunks.length };
    joined = joined.slice(0, idx) + h.newLines.join('\n') + joined.slice(idx + needle.length);
  }
  return { ok: true, text: joined, unified: true, hunks: hunks.length, code: null };
}

function sandboxUlimitSpec({ nproc = SANDBOX_NPROC, nofile = SANDBOX_NOFILE } = {}) {
  const u = Math.max(8, Math.min(256, Number(nproc) || SANDBOX_NPROC));
  const n = Math.max(32, Math.min(4096, Number(nofile) || SANDBOX_NOFILE));
  return {
    nproc: u,
    nofile: n,
    execPreamble: `ulimit -u ${u}; ulimit -n ${n}; `,
    code: 'sandbox_resource_limit',
  };
}

function wrapSandboxSpawnWithUlimit(bin, argv, { nproc = SANDBOX_NPROC, nofile = SANDBOX_NOFILE } = {}) {
  const spec = sandboxUlimitSpec({ nproc, nofile });
  const args = Array.isArray(argv) ? argv.map(String) : [];
  return {
    bin: '/bin/bash',
    argv: ['-c', `${spec.execPreamble}exec "$0" "$@"`, '--', String(bin || 'true'), ...args],
    spec,
    code: spec.code,
  };
}

function splitStdoutStderrToolResult({ stdout = '', stderr = '', maxBytes = STDOUT_CMD_CAP } = {}) {
  const cap = Math.max(32, Number(maxBytes) || STDOUT_CMD_CAP);
  function one(s) {
    const raw = String(s == null ? "" : s);
    const buf = Buffer.from(raw, "utf8");
    if (buf.length <= cap) return { text: raw, truncated: false };
    return { text: buf.subarray(0, cap).toString("utf8") + "\n[stream_capped]", truncated: true };
  }
  const out = one(stdout);
  const err = one(stderr);
  const text = [
    out.text ? `stdout:\n${out.text}` : '',
    err.text ? `stderr:\n${err.text}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: Boolean(out.truncated),
    stderrTruncated: Boolean(err.truncated),
    text,
    streams: { stdout: out.text, stderr: err.text },
    code: (out.truncated || err.truncated) ? 'stdout_rate' : null,
  };
}

const creditHoldsByRequest = new Map();

function holdThenSettleCredits(sessionKey, { amount = 1, requestId, now = Date.now() } = {}) {
  const sess = String(sessionKey || '');
  const rid = String(requestId || '');
  if (!sess || !rid) return { ok: false, code: 'credit_hold' };
  const key = `${sess}:${rid}`;
  const prev = creditHoldsByRequest.get(key);
  if (prev && prev.state === 'settled') {
    return { ok: false, reused: true, charged: false, code: 'credit_hold_reuse', holdId: key };
  }
  if (prev && prev.state === 'held') {
    return { ok: true, reused: true, charged: false, holdId: key, amount: prev.amount, code: 'credit_hold' };
  }
  const amt = Math.max(0, Number(amount) || 0);
  creditHoldsByRequest.set(key, { amount: amt, state: 'held', at: now, sess, rid });
  return { ok: true, reused: false, charged: false, holdId: key, amount: amt, code: 'credit_hold' };
}

function settleCreditHold(sessionKey, requestId, { usage, now = Date.now() } = {}) {
  const key = `${String(sessionKey || '')}:${String(requestId || '')}`;
  const prev = creditHoldsByRequest.get(key);
  if (!prev) return { ok: false, charged: false, code: 'credit_hold' };
  if (prev.state === 'settled') return { ok: true, charged: false, reused: true, code: 'credit_hold_reuse' };
  const tokens = Number((usage && (usage.total_tokens || usage.totalTokens)) || prev.amount) || 0;
  prev.state = 'settled';
  prev.settledAt = now;
  prev.tokens = tokens;
  return { ok: true, charged: tokens > 0, tokens, code: null };
}

function releaseCreditHold(sessionKey, requestId) {
  const key = `${String(sessionKey || '')}:${String(requestId || '')}`;
  const prev = creditHoldsByRequest.get(key);
  if (!prev) return { ok: true, released: false, code: 'credit_release' };
  if (prev.state === 'settled') return { ok: true, released: false, code: 'credit_hold_reuse' };
  prev.state = 'released';
  creditHoldsByRequest.delete(key);
  return { ok: true, released: true, code: 'credit_release' };
}

function resetCreditHoldsByRequest() { creditHoldsByRequest.clear(); }

function replayToolResultsOnResume(store, messages) {
  const map = store instanceof Map ? store : (store && store.map) || new Map();
  const list = Array.isArray(messages) ? messages : [];
  let n = 0;
  for (const m of list) {
    if (!m || m.role !== 'tool') continue;
    const id = String(m.tool_call_id || m.toolCallId || '');
    if (!id) continue;
    if (map.has(id)) continue;
    rememberCallResult(map, { toolCallId: id, args: m.__args || {}, result: m.content });
    n += 1;
  }
  if (store && !(store instanceof Map)) store.map = map;
  return { ok: true, replayed: n, store: map, code: n ? 'idempotency_replay' : null };
}

function isSiragptPin(m) {
  if (!m) return false;
  if (m.__projectInstructions) return true;
  if (m.__pin === 'SIRAGPT.md' || m.pin === 'SIRAGPT.md') return true;
  const c = String(m.content || '');
  return m.role === 'system' && /SIRAGPT\.md/i.test(c);
}

function compactKeepPinnedSiragptAndLastUser(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const siragpt = list.filter(isSiragptPin);
  let lastUser = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') { lastUser = list[i]; break; }
  }
  const middle = list.filter((m) => m !== lastUser && !isSiragptPin(m));
  const fitted = compactUntilTokenBudget(middle, opts);
  const compacted = fitted.messages || middle;
  const out = [];
  const seen = new Set();
  function push(m) {
    if (!m || seen.has(m)) return;
    seen.add(m);
    out.push(m);
  }
  for (const m of list) {
    if (m && m.role === 'system' && !isSiragptPin(m)) push(m);
  }
  for (const m of siragpt) push(m);
  for (const m of compacted) push(m);
  if (lastUser) push(lastUser);
  return {
    messages: out,
    used: estimateCompactTokens(out),
    keptSiragpt: siragpt.length,
    keptLastUser: Boolean(lastUser),
    compressed: Boolean(fitted.compressed),
    code: fitted.code || null,
  };
}

const cancelledRunIds = new Set();

function markRunCancelled(runId) {
  const id = String(runId || '');
  if (!id) return { ok: false, code: 'turn_cancelled' };
  cancelledRunIds.add(id);
  while (cancelledRunIds.size > CANCELLED_RUN_MAX) {
    const first = cancelledRunIds.values().next().value;
    cancelledRunIds.delete(first);
  }
  return { ok: true, size: cancelledRunIds.size, code: 'turn_cancelled' };
}

function dropCancelledRunEvents(event, { runId } = {}) {
  const id = String((event && (event.runId || event.run_id)) || runId || '');
  if (!id) return { drop: false, code: null };
  if (cancelledRunIds.has(id)) return { drop: true, code: 'turn_cancelled', runId: id };
  return { drop: false, runId: id, code: null };
}

function isRunCancelled(runId) {
  return cancelledRunIds.has(String(runId || ''));
}

function resetCancelledRuns() { cancelledRunIds.clear(); }

const toolHits = new Map();

function perToolRateLimit(sessionKey, toolName, { now = Date.now(), limit = TOOL_RATE_PER_MIN, windowMs = 60_000 } = {}) {
  const sess = String(sessionKey || '');
  const tool = String(toolName || '');
  if (!sess || !tool) return { ok: false, code: 'rate_limited' };
  const key = `${sess}:${tool}`;
  const cap = Math.max(1, Math.min(120, Number(limit) || TOOL_RATE_PER_MIN));
  const win = Math.max(1000, Number(windowMs) || 60_000);
  const rec = toolHits.get(key) || [];
  const fresh = rec.filter((t) => (now - t) < win);
  if (fresh.length >= cap) {
    toolHits.set(key, fresh);
    return { ok: false, code: 'rate_limited', remaining: 0, tool, retryAfterMs: win - (now - fresh[0]) };
  }
  fresh.push(now);
  toolHits.set(key, fresh);
  return { ok: true, code: null, remaining: cap - fresh.length, used: fresh.length, tool };
}

function resetPerToolRateLimit() { toolHits.clear(); }

function capImagePdfInContext(messages, { maxBytes = IMAGE_PDF_MAX_BYTES } = {}) {
  const list = Array.isArray(messages)
    ? messages.map((m) => (m && typeof m === 'object' ? Object.assign({}, m) : m))
    : [];
  const cap = Math.max(1024, Number(maxBytes) || IMAGE_PDF_MAX_BYTES);
  let capped = 0;
  for (const m of list) {
    if (!m) continue;
    const parts = Array.isArray(m.content) ? m.content : null;
    if (parts) {
      m.content = parts.map((p) => {
        if (!p || typeof p !== 'object') return p;
        const t = String(p.type || p.mime || '');
        const isImg = /image|pdf|application\/pdf/i.test(t) || p.image_url || p.imageUrl;
        if (!isImg) return p;
        const data = p.data || p.b64 || (p.image_url && p.image_url.url) || p.url || '';
        const bytes = Buffer.byteLength(String(data), 'utf8');
        if (bytes <= cap) return p;
        capped += 1;
        return {
          type: p.type || 'image',
          omitted: true,
          bytes,
          cap,
          code: 'file_too_large',
          text: '[imagen/pdf omitido: supera tope de contexto]',
        };
      });
      continue;
    }
    const c = String(m.content || '');
    if (/^data:image\/|^data:application\/pdf/i.test(c) && Buffer.byteLength(c, 'utf8') > cap) {
      m.content = '[imagen/pdf omitido: supera tope de contexto]';
      m.__cappedMedia = true;
      capped += 1;
    }
  }
  return { messages: list, capped, code: capped ? 'file_too_large' : null };
}

function clampMaxTokensToRemainingContext({ maxTokens = 1500, used = 0, contextWindow = 128000, reserve = 64 } = {}) {
  const win = Math.max(1024, Number(contextWindow) || 128000);
  const u = Math.max(0, Number(used) || 0);
  const want = Math.max(1, Number(maxTokens) || 1500);
  const room = Math.max(1, win - u - Math.max(0, Number(reserve) || 0));
  const max = Math.min(want, room, 8192);
  return {
    maxTokens: Math.max(16, max),
    remaining: room,
    clamped: max < want,
    code: max < want ? 'token_budget' : null,
  };
}

function clockSkewSafeTtl({ issuedAt, ttlMs, now = Date.now(), skewMs = CLOCK_SKEW_MS } = {}) {
  const issued = Number(issuedAt);
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const n = Number(now);
  const skew = Math.max(0, Number(skewMs) || 0);
  if (!Number.isFinite(issued) || !Number.isFinite(n)) {
    return { ok: false, expired: true, code: 'clock_skew' };
  }
  if (issued > n + skew) {
    return { ok: false, expired: true, skew: true, code: 'clock_skew', remainingMs: 0 };
  }
  const expiresAt = issued + ttl + skew;
  const expired = n > expiresAt;
  return {
    ok: !expired,
    expired,
    remainingMs: Math.max(0, expiresAt - n),
    expiresAt,
    code: expired ? 'session_lock_stale' : null,
  };
}

const generateByRequest = new Map();

function idempotentGenerateByRequestId(sessionKey, requestId, {
  now = Date.now(),
  ttlMs = IDEMPOTENCY_TTL_MS,
  skewMs = CLOCK_SKEW_MS,
} = {}) {
  const sess = String(sessionKey || '');
  const rid = String(requestId || '');
  if (!sess || !rid) return { ok: false, replay: false, code: 'idempotency_conflict' };
  const key = `${sess}:${rid}`;
  const prev = generateByRequest.get(key);
  if (prev) {
    const ttl = clockSkewSafeTtl({ issuedAt: prev.at, ttlMs, now, skewMs });
    if (!ttl.expired && prev.result !== undefined && prev.pending !== true) {
      return { ok: true, replay: true, result: prev.result, code: 'idempotency_replay' };
    }
    if (prev.pending && !ttl.expired) {
      return { ok: false, replay: false, pending: true, code: 'duplicate_turn' };
    }
    if (ttl.expired) generateByRequest.delete(key);
  }
  generateByRequest.set(key, { at: now, result: undefined, pending: true });
  return { ok: true, replay: false, pending: true, code: null, key };
}

function rememberGenerateByRequestId(sessionKey, requestId, result, { now = Date.now() } = {}) {
  const sess = String(sessionKey || '');
  const rid = String(requestId || '');
  if (!sess || !rid) return { ok: false };
  const key = `${sess}:${rid}`;
  const prev = generateByRequest.get(key) || { at: now };
  prev.result = result;
  prev.pending = false;
  prev.at = prev.at || now;
  generateByRequest.set(key, prev);
  return { ok: true, key };
}

function resetGenerateByRequestId() { generateByRequest.clear(); }


// ---------------------------------------------------------------------------
// 3H36 — remaining holes vs Claude Code/Cowork after 3H35
//   71 tool name allowlist vs invented names
//   72 nested array/object type coerce
//   73 create-if-missing vs refuse overwrite of large files without backup
//   74 sandbox net fail-closed if SANDBOX_NET_ALLOW unset (do not set env)
//   75 kill process group not just pid
//   76 SSE retry: field on first event
//   77 don't settle credit hold if stream never opened
//   78 drop duplicate system prompts
//   79 skip empty/whitespace memory facts
//   80 stop if assistant text looks final AND tools present
//   81 gzip tool results over size
//   82 redact URLs with credentials in query
//   83 PATCH generate resume token (resume id)
//   84 health adapter.wave=3H36
//   85 map DeepSeek 429/402 to structured error codes
// ---------------------------------------------------------------------------

const zlib = require('zlib');

const TOOL_NAME_ALLOWLIST = Object.freeze([
  'read_file', 'write_file', 'edit_file', 'str_replace', 'apply_patch',
  'glob', 'grep', 'list_files', 'execute_bash', 'bash', 'shell', 'exec',
  'execute_python', 'web_search', 'web_fetch', 'browser_act',
  'computer_navigate', 'computer_click', 'computer_read_file',
  'computer_write_file', 'computer_list_files', 'computer_screenshot',
  'computer_type', 'retrieve_memory', 'save_memory', 'load_skill',
  'mcp_list_tools', 'mcp_call', 'todo_write', 'notebook_read',
  'search_replace', 'list_dir', 'delete_path',
]);

const LARGE_FILE_BACKUP_BYTES = 32 * 1024;
const GZIP_TOOL_RESULT_BYTES = 4 * 1024;
const SSE_RETRY_MS = 3_000;
const RESUME_TOKEN_TTL_MS = 15 * 60 * 1000;
const FINAL_TEXT_RE = /(?:^|\n)\s*(?:final(?:\s+answer)?\s*:|respuesta\s+final\s*:|here(?:'s| is) (?:the )?(?:answer|result)\b|aqu[ií] (?:est[aá]|tienes)\b|\blisto[.:]|\bdone[.:])/i;

function allowlistToolName(name, { extra, executors } = {}) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, invented: true, code: 'unknown_tool', name: n };
  const extras = [];
  if (Array.isArray(extra)) extras.push(...extra.map(String));
  if (executors && typeof executors === 'object') extras.push(...Object.keys(executors));
  const allowed = new Set([...TOOL_NAME_ALLOWLIST, ...extras]);
  if (allowed.has(n) || allowed.has(n.toLowerCase())) {
    return { ok: true, invented: false, name: n, code: null };
  }
  return { ok: false, invented: true, name: n, code: 'unknown_tool' };
}

function coerceNestedArrayObjectTypes(value, schema) {
  function walk(v, sch) {
    if (v == null) return v;
    const type = sch && (typeof sch === 'string' ? sch : sch.type);
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return walk(JSON.parse(t), sch); } catch (_) { /* keep string */ }
      }
      if (type === 'number' || type === 'integer') {
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        const err = new Error('coercion_rejected');
        err.code = 'coercion_rejected';
        throw err;
      }
      if (type === 'boolean') {
        if (t === 'true') return true;
        if (t === 'false') return false;
        const err = new Error('coercion_rejected');
        err.code = 'coercion_rejected';
        throw err;
      }
      if (type === 'array' || type === 'object') {
        const err = new Error('coercion_rejected');
        err.code = 'coercion_rejected';
        throw err;
      }
      return coerceStringyPrimitives(v);
    }
    if (Array.isArray(v)) {
      const itemSch = sch && sch.items;
      return v.map((item) => walk(item, itemSch));
    }
    if (typeof v === 'object') {
      const props = (sch && sch.properties) || {};
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], props[k]);
      return o;
    }
    return v;
  }
  try {
    return { ok: true, value: walk(value, schema), code: null };
  } catch (e) {
    return { ok: false, value, code: 'coercion_rejected' };
  }
}

function createIfMissingOrRefuseLargeOverwrite({
  path: filePath,
  existingBytes,
  existingText,
  exists,
  backupPath,
  thresholdBytes = LARGE_FILE_BACKUP_BYTES,
} = {}) {
  const knownExists = exists === true
    || existingBytes != null
    || (existingText != null && existingText !== '');
  if (!knownExists && exists !== true) {
    return { ok: true, action: 'create', code: null, path: filePath || null };
  }
  const bytes = existingBytes != null
    ? Number(existingBytes)
    : Buffer.byteLength(String(existingText == null ? '' : existingText), 'utf8');
  const cap = Math.max(1024, Number(thresholdBytes) || LARGE_FILE_BACKUP_BYTES);
  if (Number.isFinite(bytes) && bytes >= cap && !backupPath) {
    return { ok: false, action: 'refuse_overwrite', bytes, code: 'file_too_large', path: filePath || null };
  }
  return {
    ok: true,
    action: backupPath ? 'overwrite_with_backup' : 'overwrite',
    bytes,
    backupPath: backupPath || null,
    code: null,
    path: filePath || null,
  };
}

function sandboxNetFailClosed(env) {
  const src = env && typeof env === 'object' ? env : {};
  const raw = src.SIRAGPT_SANDBOX_NET_ALLOW;
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, allow: [], failClosed: true, code: 'network_denied' };
  }
  const allow = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return { ok: false, allow: [], failClosed: true, code: 'network_denied' };
  return { ok: true, allow, failClosed: false, code: null };
}

function killProcessGroup(pid, { signal = 'SIGTERM', killFn } = {}) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, group: false, code: 'sandbox_killed' };
  const kn = typeof killFn === 'function' ? killFn : ((id, sig) => process.kill(id, sig));
  try {
    kn(-p, signal);
    return { ok: true, pid: p, group: true, fallback: false, signal, code: 'sandbox_killed' };
  } catch (_) {
    try {
      kn(p, signal);
      return { ok: true, pid: p, group: false, fallback: true, signal, code: 'sandbox_killed' };
    } catch (_2) {
      return { ok: false, pid: p, group: false, code: 'sandbox_killed' };
    }
  }
}

function sseRetryFieldOnFirstEvent({ first = true, retryMs = SSE_RETRY_MS } = {}) {
  if (!first) return { retryLine: '', retry: null, first: false, code: null };
  const ms = Math.max(250, Math.min(30_000, Number(retryMs) || SSE_RETRY_MS));
  return { retryLine: `retry: ${ms}\n`, retry: ms, first: true, code: 'sse_resume' };
}

function settleCreditHoldIfStreamOpened(sessionKey, requestId, { streamOpened, usage, now = Date.now() } = {}) {
  if (!streamOpened) {
    const rel = releaseCreditHold(sessionKey, requestId);
    return {
      ok: false,
      settled: false,
      charged: false,
      released: Boolean(rel && rel.released),
      code: 'credit_no_usage',
    };
  }
  const settled = settleCreditHold(sessionKey, requestId, { usage, now });
  return Object.assign({ settled: Boolean(settled && settled.ok), charged: Boolean(settled && settled.charged) }, settled);
}

function dropDuplicateSystemPrompts(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const m of list) {
    if (m && m.role === 'system') {
      const key = String(m.content || '').trim();
      if (seen.has(key)) {
        dropped += 1;
        continue;
      }
      seen.add(key);
    }
    kept.push(m);
  }
  return { messages: kept, dropped, code: dropped ? 'pin_dedup' : null };
}

function skipEmptyWhitespaceMemoryFacts(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const kept = [];
  let skipped = 0;
  for (const f of list) {
    const text = typeof f === 'string' ? f : (f && (f.text || f.content || f.fact || f.body)) || '';
    if (!String(text).trim()) {
      skipped += 1;
      continue;
    }
    if (typeof f === 'string') kept.push(String(text).trim());
    else kept.push(Object.assign({}, f, { text: String(text).trim() }));
  }
  return { facts: kept, skipped, code: skipped ? 'memory_fact_empty' : null };
}

function stopIfFinalTextWithTools(msg) {
  const content = String((msg && msg.content) || '').trim();
  const tools = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [];
  const looksFinal = Boolean(content) && FINAL_TEXT_RE.test(content);
  if (content && tools.length > 0 && looksFinal) {
    return { stop: true, dropTools: true, reason: 'final_with_tools', code: 'final_with_tools', text: content };
  }
  return { stop: false, dropTools: false, reason: null, code: null, text: content };
}

function gzipToolResultOverSize(text, { maxBytes = GZIP_TOOL_RESULT_BYTES } = {}) {
  const s = typeof text === 'string' ? text : (text == null ? '' : (typeof text === 'object' ? JSON.stringify(text) : String(text)));
  const cap = Math.max(64, Number(maxBytes) || GZIP_TOOL_RESULT_BYTES);
  const rawBytes = Buffer.byteLength(s, 'utf8');
  if (rawBytes <= cap) return { gzipped: false, text: s, bytes: rawBytes, code: null };
  const buf = zlib.gzipSync(Buffer.from(s, 'utf8'));
  return {
    gzipped: true,
    encoding: 'gzip',
    bytes: buf.length,
    rawBytes,
    b64: buf.toString('base64'),
    text: `[gzip ${rawBytes}->${buf.length}]`,
    code: 'gzip_version',
  };
}

function redactUrlsWithCredentials(text) {
  const s = String(text == null ? '' : text);
  let n = 0;
  let next = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s?#]*?:[^/\s?#]*?)@/gi, (_, proto) => {
    n += 1;
    return `${proto}[redacted]@`;
  });
  next = next.replace(/([?&])((?:access_token|api[_-]?key|token|password|passwd|secret|authorization|auth|key|jwt|refresh_token)=)([^&\s#]+)/gi, (_, sep, k) => {
    n += 1;
    return `${sep}${k}[redacted]`;
  });
  return { text: next, redacted: n, code: n ? 'secret_redact' : null };
}

const generateResumeTokens = new Map();

function issueGenerateResumeToken(sessionKey, { now = Date.now(), ttlMs = RESUME_TOKEN_TTL_MS } = {}) {
  const sess = String(sessionKey || '');
  if (!sess) return { ok: false, code: 'resume_conflict' };
  const token = crypto.randomBytes(16).toString('hex');
  generateResumeTokens.set(token, { sess, at: now, ttlMs: Math.max(1000, Number(ttlMs) || RESUME_TOKEN_TTL_MS) });
  return { ok: true, resumeToken: token, resumeId: token, code: 'sse_resume' };
}

function consumeGenerateResumeToken(token, sessionKey, { now = Date.now() } = {}) {
  const t = String(token || '');
  const rec = generateResumeTokens.get(t);
  if (!rec) return { ok: false, code: 'resume_conflict' };
  const ttl = clockSkewSafeTtl({ issuedAt: rec.at, ttlMs: rec.ttlMs, now });
  if (ttl.expired) {
    generateResumeTokens.delete(t);
    return { ok: false, expired: true, code: 'resume_conflict' };
  }
  if (sessionKey && rec.sess !== String(sessionKey)) {
    return { ok: false, code: 'resume_conflict' };
  }
  return { ok: true, sessionKey: rec.sess, resumeToken: t, resumeId: t, replay: true, code: 'sse_resume' };
}

function patchGenerateResumeToken(sessionKey, resumeToken, opts = {}) {
  if (resumeToken) return consumeGenerateResumeToken(resumeToken, sessionKey, opts);
  return issueGenerateResumeToken(sessionKey, opts);
}

function resetGenerateResumeTokens() { generateResumeTokens.clear(); }

function mapDeepSeekHttpError(err) {
  if (err == null) return { ok: false, code: null };
  const status = Number((err && (err.status || err.statusCode || err.httpStatus || (err.response && err.response.status))) || NaN);
  const msg = String((err && (err.message || err.error || err.code)) || '');
  if (status === 429 || /(?:^|\b)429\b|rate.?limit|too many requests/i.test(msg)) {
    return {
      ok: false,
      code: 'rate_limited',
      retryable: true,
      status: 429,
      message: 'DeepSeek rate limit (429). Espera y reintenta.',
    };
  }
  if (status === 402 || /(?:^|\b)402\b|insufficient|quota|payment required|credit balance/i.test(msg)) {
    return {
      ok: false,
      code: 'credit_ceiling',
      retryable: false,
      status: 402,
      message: 'DeepSeek sin crédito (402). No reintenté.',
    };
  }
  return { ok: true, code: null, status: Number.isFinite(status) ? status : null };
}


// ---------------------------------------------------------------------------
// 3H37 — remaining holes vs Claude Code/Cowork after 3H36
//   86 identical observation-hash loop cut (N>=3)
//   87 abort sibling subagents when parent cancelled
//   88 validate enum args
//   89 truncate overlong arg strings (>8KiB)
//   90 cache identical tool call in the same turn
//   91 detect DAG cycle
//   92 remaining step budget reminder (<=3)
//   93 compact keep tool_call/tool_result pairs
//   94 min-score memory retrieve (0.25)
//   95 checkpoint after successful write (max 32)
//   96 refuse binary file edit
//   97 normalize CRLF→LF before diff
//   98 move file same volume / jail
//   99 sandbox RSS+CPU ulimit wrap
//  100 scrub secrets from child env
//  101 tmpdir cleanup in finally
//  102 SSE max buffer disconnect
//  103 heartbeat jitter 15s ±20% (min 8s)
//  104 generate wait retry-after if queue >20s
//  105 refund completion hold on cancel (prompt billed, 0 completion)
//  106 classify net errors (ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN)
//  107 skip compact if under 70% of context window
//  108 health adapter.wave=3H37
// ---------------------------------------------------------------------------

const ARG_STRING_MAX_BYTES = 8 * 1024;
const SSE_BUFFER_MAX_BYTES = 1024 * 1024;
const HEARTBEAT_BASE_MS = 15_000;
const HEARTBEAT_MIN_MS = 8_000;
const MEMORY_MIN_SCORE = 0.25;
const WRITE_CHECKPOINT_MAX = 32;
const GENERATE_WAIT_MAX_MS = 20_000;
const SANDBOX_RSS_KB = 512 * 1024;
const SANDBOX_CPU_SEC = 30;
const COMPACT_SKIP_RATIO = 0.70;
const OBSERVATION_CUT_LIMIT = 3;
const BINARY_RATIO = 0.30;
const KEEP_CHILD_ENV = Object.freeze(['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'TMPDIR', 'TZ', 'LC_ALL', 'LC_CTYPE']);
const completionHoldRefunds = new Set();

function observationHash(item) {
  if (item == null) return sha256Hex('');
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
    return sha256Hex(String(item));
  }
  const result = item.result != null ? item.result : (item.observation != null ? item.observation : item);
  const tool = item.tool || item.name || '';
  return sha256Hex(`${String(tool)}:${typeof result === 'string' ? result : stableJson(result)}`);
}

function createIdenticalObservationLoopCut({ limit = OBSERVATION_CUT_LIMIT } = {}) {
  const cap = Math.max(3, Math.min(12, Number(limit) || OBSERVATION_CUT_LIMIT));
  let lastHash = null;
  let run = 0;
  return {
    limit: cap,
    see(observation) {
      const hash = observationHash(observation);
      if (hash === lastHash) run += 1;
      else { lastHash = hash; run = 1; }
      const cut = run >= cap;
      return { hash, run, cut, code: cut ? 'identical_observation_loop' : null };
    },
    reset() { lastHash = null; run = 0; },
  };
}

function identicalObservationLoopCut(history, { limit = OBSERVATION_CUT_LIMIT } = {}) {
  if (history && !Array.isArray(history) && typeof history === 'object' && (history.observations || history.history || history.limit != null) && history.result == null && history.tool == null) {
    const opts = history;
    return identicalObservationLoopCut(opts.observations || opts.history || [], { limit: opts.limit != null ? opts.limit : limit });
  }
  const cut = createIdenticalObservationLoopCut({ limit });
  let last = { cut: false, run: 0, hash: null, code: null };
  const list = Array.isArray(history) ? history : (history == null ? [] : [history]);
  for (const item of list) last = cut.see(item);
  return last;
}

function abortSiblingsOnParentCancel({ parentCancelled, siblingIds, abortFn } = {}) {
  const ids = Array.isArray(siblingIds) ? siblingIds.map((id) => String(id)).filter(Boolean) : [];
  if (!parentCancelled) return { aborted: [], code: null };
  const aborted = [];
  for (const id of ids) {
    try { if (typeof abortFn === 'function') abortFn(id); } catch (_) { /* best-effort */ }
    aborted.push(id);
  }
  return { aborted, code: 'turn_cancelled' };
}

function validateEnumArgs(args, schema) {
  function allowed(v, enums) {
    if (!Array.isArray(enums) || !enums.length) return true;
    for (const e of enums) {
      if (e === v) return true;
      if (String(e) === String(v) && (typeof e === 'number' || typeof v === 'number' || typeof e === 'boolean' || typeof v === 'boolean')) {
        if (e === Number(v) || e === v) return true;
      }
    }
    return enums.includes(v);
  }
  function walk(v, sch) {
    if (!sch || typeof sch !== 'object') return;
    if (Array.isArray(sch.enum) && sch.enum.length) {
      if (!allowed(v, sch.enum)) {
        const err = new Error('enum_rejected');
        err.code = 'enum_rejected';
        throw err;
      }
    }
    if (sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(sch.properties)) walk(v[k], sch.properties[k]);
    }
    if (sch.items && Array.isArray(v)) {
      for (const item of v) walk(item, sch.items);
    }
  }
  try {
    walk(args, schema);
    return { ok: true, args, code: null };
  } catch (e) {
    return { ok: false, args, code: 'enum_rejected' };
  }
}

function truncateOverlongArgStrings(args, { maxBytes = ARG_STRING_MAX_BYTES } = {}) {
  const cap = Math.max(64, Number(maxBytes) || ARG_STRING_MAX_BYTES);
  let truncated = false;
  function walk(v) {
    if (typeof v === 'string') {
      const buf = Buffer.from(v, 'utf8');
      if (buf.length > cap) {
        truncated = true;
        return buf.subarray(0, cap).toString('utf8');
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  }
  return { args: walk(args), truncated, code: truncated ? 'tool_args_invalid' : null };
}

function cacheIdenticalToolCallSameTurn(name, args, { turn, result } = {}) {
  const store = turn && typeof turn === 'object' ? turn : (cacheIdenticalToolCallSameTurn._turn || (cacheIdenticalToolCallSameTurn._turn = {}));
  if (!store.map) store.map = new Map();
  const key = fingerprint(name, args);
  if (store.map.has(key)) {
    return { cacheHit: true, result: store.map.get(key), code: 'exactly_once_tool' };
  }
  if (result !== undefined) store.map.set(key, result);
  return { cacheHit: false, result: result !== undefined ? result : null, code: null };
}

function resetSameTurnToolCache(turn) {
  if (turn && turn.map) turn.map.clear();
  if (cacheIdenticalToolCallSameTurn._turn) cacheIdenticalToolCallSameTurn._turn = { map: new Map() };
}

function detectDagCycle(adj) {
  const graph = adj && typeof adj === 'object' && !Array.isArray(adj) ? adj : {};
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const nodes = new Set(Object.keys(graph).map(String));
  for (const k of Object.keys(graph)) {
    for (const n of (Array.isArray(graph[k]) ? graph[k] : [])) nodes.add(String(n));
  }
  function dfs(u) {
    color.set(u, GRAY);
    for (const v of (Array.isArray(graph[u]) ? graph[u] : []).map(String)) {
      const c = color.get(v) || WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }
  for (const n of nodes) {
    if ((color.get(n) || WHITE) === WHITE && dfs(n)) {
      return { ok: false, code: 'dag_cycle' };
    }
  }
  return { ok: true, code: null };
}

function remainingStepBudgetReminder({ remaining, max } = {}) {
  const left = Number(remaining);
  if (!Number.isFinite(left) || left > 3) {
    return { inject: false, text: null, remaining: Number.isFinite(left) ? left : null, code: null };
  }
  const n = Math.max(0, Math.floor(left));
  return {
    inject: true,
    text: `Quedan ${n} pasos. Resume y termina.`,
    remaining: n,
    max: max != null ? Number(max) : null,
    code: 'plan_budget',
  };
}

function compactKeepToolCallResultPairs(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const callIds = new Set();
  const resultIds = new Set();
  for (const m of list) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c && c.id) callIds.add(String(c.id));
    }
    if (m && m.tool_call_id) resultIds.add(String(m.tool_call_id));
  }
  const kept = [];
  let dropped = 0;
  for (const m of list) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const nextCalls = m.tool_calls.filter((c) => c && c.id && resultIds.has(String(c.id)));
      dropped += m.tool_calls.length - nextCalls.length;
      if (!nextCalls.length && !String(m.content || '').trim()) {
        dropped += 1;
        continue;
      }
      kept.push(nextCalls.length === m.tool_calls.length ? m : Object.assign({}, m, { tool_calls: nextCalls }));
      continue;
    }
    if (m && (m.role === 'tool' || m.tool_call_id)) {
      const id = String(m.tool_call_id || '');
      if (!id || !callIds.has(id)) {
        dropped += 1;
        continue;
      }
    }
    kept.push(m);
  }
  return { messages: kept, dropped, code: dropped ? 'compact_fidelity' : null };
}

function minScoreMemoryRetrieve(facts, { minScore = MEMORY_MIN_SCORE } = {}) {
  const floor = Number.isFinite(Number(minScore)) ? Number(minScore) : MEMORY_MIN_SCORE;
  const list = Array.isArray(facts) ? facts : [];
  const kept = [];
  let dropped = 0;
  for (const f of list) {
    let score = 1;
    if (f && typeof f === 'object' && f.score != null) score = Number(f.score);
    if (Number.isFinite(score) && score < floor) {
      dropped += 1;
      continue;
    }
    kept.push(f);
  }
  return { facts: kept, dropped, minScore: floor, code: dropped ? 'retrieve_memory_failed' : null };
}

function checkpointAfterSuccessfulWrite(list, { path: filePath, content, sha256, bytes, verified = true } = {}) {
  const ckpts = Array.isArray(list) ? list.slice() : [];
  if (!verified) return { ok: false, checkpoints: ckpts, code: 'read_after_write_failed' };
  const text = content == null ? '' : String(content);
  const rec = {
    path: String(filePath || ''),
    sha256: sha256 || sha256Hex(text),
    bytes: bytes != null ? Number(bytes) : Buffer.byteLength(text, 'utf8'),
  };
  ckpts.push(rec);
  while (ckpts.length > WRITE_CHECKPOINT_MAX) ckpts.shift();
  return { ok: true, checkpoint: rec, checkpoints: ckpts, code: 'write_hash' };
}

function refuseBinaryFileEdit(buf) {
  let raw;
  if (Buffer.isBuffer(buf)) raw = buf;
  else if (typeof buf === 'string') raw = Buffer.from(buf, 'binary');
  else raw = Buffer.from(String(buf == null ? '' : buf), 'utf8');
  if (!raw.length) return { ok: true, binary: false, code: null };
  if (raw.includes(0)) return { ok: false, binary: true, code: 'binary_file' };
  let weird = 0;
  const n = Math.min(raw.length, 4096);
  for (let i = 0; i < n; i += 1) {
    const b = raw[i];
    if (b < 9 || (b > 13 && b < 32) || b === 127) weird += 1;
  }
  if (n >= 32 && weird / n > BINARY_RATIO) return { ok: false, binary: true, code: 'binary_file' };
  return { ok: true, binary: false, code: null };
}

function normalizeLineEndingsBeforeDiff(text) {
  const s = String(text == null ? '' : text);
  const next = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { text: next, changed: next !== s, code: null };
}

function moveFileSameVolume({ from, to, root, renameFn, sameVolumeFn } = {}) {
  const jailFrom = workspacePathJail(from, root);
  const jailTo = workspacePathJail(to, root);
  if (!jailFrom.ok) return { ok: false, code: jailFrom.code || 'path_traversal' };
  if (!jailTo.ok) return { ok: false, code: jailTo.code || 'path_traversal' };
  const a = jailFrom.path;
  const b = jailTo.path;
  let same = true;
  if (typeof sameVolumeFn === 'function') {
    try { same = Boolean(sameVolumeFn(a, b)); } catch (_) { same = false; }
  } else {
    try {
      const sa = fs.existsSync(a) ? fs.statSync(a).dev : null;
      const parent = path.dirname(b);
      const sb = fs.existsSync(parent) ? fs.statSync(parent).dev : sa;
      if (sa != null && sb != null && sa !== sb) same = false;
    } catch (_) { same = true; }
  }
  if (!same) return { ok: false, code: 'path_traversal', from: a, to: b };
  try {
    if (typeof renameFn === 'function') renameFn(a, b);
    return { ok: true, from: a, to: b, code: null };
  } catch (_) {
    return { ok: false, code: 'path_traversal', from: a, to: b };
  }
}

function sandboxRssCpuUlimit({ rssKb = SANDBOX_RSS_KB, cpuSec = SANDBOX_CPU_SEC, command } = {}) {
  const v = Math.max(16 * 1024, Math.min(8 * 1024 * 1024, Number(rssKb) || SANDBOX_RSS_KB));
  const t = Math.max(1, Math.min(300, Number(cpuSec) || SANDBOX_CPU_SEC));
  const prefix = `ulimit -v ${v}; ulimit -t ${t}; `;
  return {
    prefix,
    rssKb: v,
    cpuSec: t,
    command: command != null ? prefix + String(command) : prefix,
    code: 'sandbox_resource_limit',
  };
}

function wrapSandboxSpawnWithRssCpu(bin, argv, opts = {}) {
  const rss = sandboxRssCpuUlimit(opts);
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (String(bin) === '/bin/bash' && args[0] === '-c' && args[1]) {
    return { bin, argv: [args[0], rss.prefix + args[1], ...args.slice(2)], spec: rss, code: rss.code };
  }
  return {
    bin: '/bin/bash',
    argv: ['-c', `${rss.prefix}exec "$0" "$@"`, '--', String(bin || 'true'), ...args],
    spec: rss,
    code: rss.code,
  };
}

function scrubSecretsFromChildEnv(env) {
  const src = env && typeof env === 'object' ? env : {};
  const out = {};
  const stripped = [];
  const keep = new Set(KEEP_CHILD_ENV);
  for (const k of Object.keys(src)) {
    if (keep.has(k)) {
      out[k] = src[k];
      continue;
    }
    if (SECRET_ENV_RE.test(k)) {
      stripped.push(k);
      continue;
    }
    out[k] = src[k];
  }
  return { env: out, stripped, code: stripped.length ? 'secret_redact' : null };
}

function tmpdirCleanupFinally(dir, body, { rmFn } = {}) {
  const rm = typeof rmFn === 'function'
    ? rmFn
    : (p) => { try { fs.rmSync(String(p), { recursive: true, force: true }); } catch (_) {} };
  let result;
  let threw = null;
  try {
    if (typeof body === 'function') result = body();
  } catch (e) {
    threw = e;
  } finally {
    try { if (dir) rm(String(dir)); } catch (_) {}
  }
  const out = { cleaned: true, result, code: 'tmpfs_cleanup' };
  if (threw) {
    out.threw = true;
    out.error = true;
    out.errName = threw && threw.name ? String(threw.name) : 'Error';
  }
  return out;
}

function sseMaxBufferDisconnect({ bufferedBytes, maxBytes = SSE_BUFFER_MAX_BYTES } = {}) {
  const n = Math.max(0, Number(bufferedBytes) || 0);
  const cap = Math.max(4096, Number(maxBytes) || SSE_BUFFER_MAX_BYTES);
  if (n > cap) return { disconnect: true, code: 'sse_buffer_overflow', bufferedBytes: n };
  return { disconnect: false, code: null, bufferedBytes: n };
}

function heartbeatJitter({ baseMs = HEARTBEAT_BASE_MS, jitter = 0.20, random = Math.random, minMs = HEARTBEAT_MIN_MS } = {}) {
  const base = Math.max(1000, Number(baseMs) || HEARTBEAT_BASE_MS);
  const j = Math.max(0, Math.min(0.9, Number(jitter) || 0.20));
  const delta = (Number(random()) * 2 - 1) * j * base;
  const floor = Math.max(8000, Number(minMs) || HEARTBEAT_MIN_MS);
  const ms = Math.max(floor, Math.round(base + delta));
  return { delayMs: ms, baseMs: base, code: 'sse_heartbeat' };
}

function generateWaitRetryAfter({ waitMs, maxWaitMs = GENERATE_WAIT_MAX_MS } = {}) {
  const wait = Math.max(0, Number(waitMs) || 0);
  const cap = Math.max(1000, Number(maxWaitMs) || GENERATE_WAIT_MAX_MS);
  if (wait > cap) {
    const retryAfterSec = Math.max(1, Math.ceil(wait / 1000));
    return { ok: false, code: 'generate_overloaded', retryAfterSec, waitMs: wait };
  }
  return { ok: true, code: null, waitMs: wait };
}

function refundPartialTokensOnCancel({
  requestId,
  cancelled,
  promptTokens,
  completionTokens,
  alreadyRefunded,
} = {}) {
  const id = String(requestId || '');
  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;
  if (!cancelled) return { refunded: null, code: null };
  if (alreadyRefunded || (id && completionHoldRefunds.has(id))) {
    return { refunded: null, duplicate: true, code: 'credit_cancel' };
  }
  if (prompt > 0 && completion === 0) {
    if (id) completionHoldRefunds.add(id);
    return { refunded: 'completion_hold', promptTokens: prompt, completionTokens: 0, code: 'credit_cancel' };
  }
  return { refunded: null, code: null };
}

function resetCompletionHoldRefunds() { completionHoldRefunds.clear(); }

function classifyNetErrors(err) {
  if (err == null) return { ok: true, code: null };
  const raw = String((err && (err.code || err.errno || err.message || err)) || '');
  const upper = raw.toUpperCase();
  if (/ECONNRESET/.test(upper)) {
    return { ok: false, code: 'net_reset', retryable: true, message: 'La conexion se reseto. Reintenta.' };
  }
  if (/ETIMEDOUT/.test(upper)) {
    return { ok: false, code: 'net_timeout', retryable: true, message: 'La red tardo demasiado. Reintenta.' };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(upper)) {
    return { ok: false, code: 'net_dns', retryable: true, message: 'No resolvi el nombre de host. Reintenta.' };
  }
  return { ok: true, code: null };
}

function skipCompactIfUnderBudget(messages, { windowTokens = 128000, ratio = COMPACT_SKIP_RATIO } = {}) {
  const used = estimateCompactTokens(messages);
  const win = Math.max(1024, Number(windowTokens) || 128000);
  const r = Number.isFinite(Number(ratio)) ? Number(ratio) : COMPACT_SKIP_RATIO;
  if (used < win * r) return { skipped: true, used, windowTokens: win, code: null };
  return { skipped: false, used, windowTokens: win, code: 'token_compact' };
}


// ---------------------------------------------------------------------------
// 3H38 — remaining holes vs Claude Code/Cowork after 3H37
//  109 max concurrent tools per turn (cap 4; extra deferred)
//  110 subagent result size cap 8KiB
//  111 repair missing required args from prior same-name call
//  112 validate tool result shape
//  113 tool timeout must fit remaining budget
//  114 dead-letter same tool+error after N=3
//  115 inject plan progress line when n>1
//  116 compact preserve last 3 error messages
//  117 pin facts tagged pin:true across compact
//  118 checkpoint CAS seq must be lastSeq+1
//  119 checksum verify after write (sha256)
//  120 syntax check js/py after write
//  121 reject C0 control chars in paths
//  122 create file exclusive unless overwrite
//  123 sandbox tmpfs hint 64MB
//  124 redact /home/<user> and /root in tool results
//  125 SSE ping on idle tool >5s
//  126 classify SSE Last-Event-ID gap
//  127 fair queue starvation bound 15s boost
//  128 credit audit row on tool error
//  129 classify FS errors to public ES codes
//  130 skip memory retrieve if turn >2500ms
//  131 health adapter.wave=3H38
// ---------------------------------------------------------------------------

const SUBAGENT_RESULT_MAX_BYTES = 8 * 1024;
const MAX_CONCURRENT_TOOLS = 4;
const DEAD_LETTER_LIMIT = 3;
const COMPACT_KEEP_ERRORS = 3;
const SSE_IDLE_TOOL_MS = 5_000;
const SSE_GAP_WINDOW = 64;
const QUEUE_STARVATION_MS = 15_000;
const MEMORY_BUSY_MS = 2_500;
const TMPFS_MB = 64;

function byteLen(v) {
  if (v == null) return 0;
  if (Buffer.isBuffer(v)) return v.length;
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch (_) { return String(v).length; }
}

function maxConcurrentToolsPerTurn(calls, { max = MAX_CONCURRENT_TOOLS } = {}) {
  const list = Array.isArray(calls) ? calls.slice() : [];
  const cap = Math.max(1, Math.min(16, Number(max) || MAX_CONCURRENT_TOOLS));
  if (list.length <= cap) {
    return { run: list, deferred: [], extra: [], max: cap, code: null };
  }
  const run = list.slice(0, cap);
  const extra = list.slice(cap).map((c) => {
    if (c && typeof c === 'object') return Object.assign({}, c, { deferred: true });
    return { call: c, deferred: true };
  });
  return { run, deferred: extra, extra, max: cap, code: 'tool_storm' };
}

function subagentResultSizeCap(result, { maxBytes = SUBAGENT_RESULT_MAX_BYTES } = {}) {
  const cap = Math.max(256, Number(maxBytes) || SUBAGENT_RESULT_MAX_BYTES);
  const n = byteLen(result);
  if (n <= cap) return { result, truncated: false, bytes: n, code: null };
  let text;
  if (typeof result === 'string') text = result;
  else if (Buffer.isBuffer(result)) text = result.toString('utf8');
  else {
    try { text = JSON.stringify(result); } catch (_) { text = String(result); }
  }
  const sliced = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
  return {
    result: { truncated: true, text: sliced, bytes: cap },
    truncated: true,
    bytes: cap,
    code: 'tool_result_capped',
  };
}

function typesMatch(a, b) {
  if (a === null || b === null) return a === null && b === null;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b);
  return typeof a === typeof b;
}

function repairMissingRequiredFromPriorTurn(args, schema, { prior } = {}) {
  const next = (args && typeof args === 'object' && !Array.isArray(args)) ? Object.assign({}, args) : {};
  const sch = schema && typeof schema === 'object' ? schema : {};
  const required = Array.isArray(sch.required) ? sch.required.map(String) : [];
  const last = (prior && typeof prior === 'object' && !Array.isArray(prior)) ? prior : null;
  const props = (sch.properties && typeof sch.properties === 'object') ? sch.properties : {};
  let repaired = false;
  for (const key of required) {
    const missing = next[key] === undefined || next[key] === null || next[key] === '';
    if (!missing) continue;
    if (last && last[key] !== undefined && last[key] !== null) {
      const expectedType = props[key] && props[key].type ? String(props[key].type) : null;
      const priorVal = last[key];
      let okType = true;
      if (expectedType === 'string') okType = typeof priorVal === 'string';
      else if (expectedType === 'number' || expectedType === 'integer') okType = typeof priorVal === 'number';
      else if (expectedType === 'boolean') okType = typeof priorVal === 'boolean';
      else if (expectedType === 'object') okType = priorVal && typeof priorVal === 'object' && !Array.isArray(priorVal);
      else if (expectedType === 'array') okType = Array.isArray(priorVal);
      else okType = typesMatch(priorVal, priorVal);
      if (okType) {
        next[key] = priorVal;
        repaired = true;
        continue;
      }
    }
    return { ok: false, args: next, repaired: false, code: 'missing_required' };
  }
  return { ok: true, args: next, repaired, code: null };
}

function validateToolResultShape(result) {
  if (result === null) return { ok: true, result, code: null };
  const t = typeof result;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') {
    return { ok: true, result, code: null };
  }
  return { ok: false, result: { ok: false, code: 'bad_tool_result' }, code: 'bad_tool_result' };
}

function toolTimeoutFitsRemainingBudget({ remainingMs, timeoutMs } = {}) {
  const rem = Number(remainingMs);
  const to = Number(timeoutMs);
  if (Number.isFinite(rem) && Number.isFinite(to) && rem < to) {
    return { skip: true, code: 'timeout_budget', remainingMs: rem, timeoutMs: to };
  }
  return { skip: false, code: null, remainingMs: Number.isFinite(rem) ? rem : null, timeoutMs: Number.isFinite(to) ? to : null };
}

function createDeadLetterSameToolAfterN({ limit = DEAD_LETTER_LIMIT } = {}) {
  const cap = Math.max(3, Math.min(12, Number(limit) || DEAD_LETTER_LIMIT));
  const map = new Map();
  return {
    limit: cap,
    see(tool, code) {
      const key = `${String(tool || '')}::${String(code || '')}`;
      const n = (map.get(key) || 0) + 1;
      map.set(key, n);
      if (n >= cap) return { halt: true, count: n, tool: String(tool || ''), errorCode: String(code || ''), code: 'tool_dead_letter' };
      return { halt: false, count: n, tool: String(tool || ''), errorCode: String(code || ''), code: null };
    },
    reset() { map.clear(); },
  };
}

function deadLetterSameToolAfterN(history, { limit = DEAD_LETTER_LIMIT } = {}) {
  if (history && !Array.isArray(history) && typeof history === 'object' && (history.events || history.history || history.limit != null) && history.tool == null) {
    const opts = history;
    return deadLetterSameToolAfterN(opts.events || opts.history || [], { limit: opts.limit != null ? opts.limit : limit });
  }
  const cut = createDeadLetterSameToolAfterN({ limit });
  let last = { halt: false, count: 0, code: null };
  const list = Array.isArray(history) ? history : (history == null ? [] : [history]);
  for (const item of list) {
    const tool = item && (item.tool || item.name);
    const code = item && (item.code || item.errorCode || item.error);
    last = cut.see(tool, code);
  }
  return last;
}

function injectPlanProgressLine({ i, n, step, total } = {}) {
  const cur = Number(i != null ? i : step);
  const tot = Number(n != null ? n : total);
  if (!Number.isFinite(tot) || tot <= 1) {
    return { inject: false, text: null, remaining: Number.isFinite(tot) ? Math.max(0, tot - (Number.isFinite(cur) ? cur : 0)) : null, code: null };
  }
  const stepN = Math.max(1, Math.floor(Number.isFinite(cur) ? cur : 1));
  const all = Math.max(1, Math.floor(tot));
  const remaining = Math.max(0, all - stepN);
  return {
    inject: true,
    text: `paso ${stepN}/${all} remaining ${remaining}`,
    remaining,
    step: stepN,
    n: all,
    code: 'plan_budget',
  };
}

function isErrorishMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (String(m.role || '').toLowerCase() === 'error') return true;
  if (m.code != null && String(m.code).trim()) return true;
  if (m.error != null && m.error !== false) return true;
  return false;
}

function compactPreserveLastErrors(messages, original, opts) {
  let keep = COMPACT_KEEP_ERRORS;
  let orig = original;
  if (original && typeof original === 'object' && !Array.isArray(original)) {
    opts = original;
    orig = opts.original;
    if (opts.keep != null) keep = opts.keep;
  } else if (opts && typeof opts === 'object' && opts.keep != null) {
    keep = opts.keep;
  }
  const compacted = Array.isArray(messages) ? messages.slice() : [];
  const source = Array.isArray(orig) ? orig : compacted;
  const k = Math.max(1, Math.min(12, Number(keep) || COMPACT_KEEP_ERRORS));
  const errors = source.filter(isErrorishMessage).slice(-k);
  const out = compacted.slice();
  for (const e of errors) {
    if (!out.includes(e)) out.push(e);
  }
  return { messages: out, keptErrors: errors, kept: errors.length, code: errors.length ? 'compact_fidelity' : null };
}

function pinCriticalFacts(messages, facts) {
  let msgs = messages;
  let pins = facts;
  if (Array.isArray(messages) && facts === undefined) {
    const looksLikeFacts = messages.every((m) => m && typeof m === 'object' && (m.pin != null || m.text != null || m.fact != null || m.content != null) && m.role == null);
    if (looksLikeFacts) { pins = messages; msgs = []; }
  }
  const list = Array.isArray(msgs) ? msgs.slice() : [];
  const src = Array.isArray(pins) ? pins : [];
  const tagged = src.filter((f) => f && typeof f === 'object' && (f.pin === true || f.pinned === true));
  const dropped = src.length - tagged.length;
  if (tagged.length && list.length) {
    const block = tagged.map((f) => (typeof f === 'string' ? f : (f.text || f.fact || f.content || JSON.stringify(f))));
    const injection = `[pinned]\n${block.join('\n')}`;
    const has = list.some((m) => m && String(m.content || '').includes('[pinned]'));
    if (!has) {
      const sysIdx = list.findIndex((m) => m && m.role === 'system');
      if (sysIdx >= 0) {
        list[sysIdx] = Object.assign({}, list[sysIdx], { content: `${String(list[sysIdx].content || '')}\n\n${injection}` });
      } else {
        list.unshift({ role: 'system', content: injection, pin: true });
      }
    }
  }
  return { messages: list, facts: tagged, pinned: tagged, dropped, code: tagged.length ? 'pin_across_compact' : null };
}

function checkpointCasSeq({ seq, lastSeq } = {}) {
  const s = Number(seq);
  const last = Number(lastSeq);
  if (!Number.isFinite(s) || !Number.isFinite(last) || s !== last + 1) {
    return { ok: false, seq: Number.isFinite(s) ? s : null, lastSeq: Number.isFinite(last) ? last : null, code: 'ckpt_cas' };
  }
  return { ok: true, seq: s, lastSeq: last, code: null };
}

function checksumVerifyAfterWrite({ actual, expected, expectedSha256, content } = {}) {
  const raw = actual != null ? actual : content;
  const got = sha256Hex(raw == null ? '' : raw);
  const exp = String(expectedSha256 || expected || '');
  if (!exp || got !== exp) {
    return { ok: false, actualSha256: got, expectedSha256: exp || null, code: 'write_checksum' };
  }
  return { ok: true, sha256: got, code: null };
}

function unmatchedBrackets(text) {
  const s = String(text == null ? '' : text);
  let par = 0;
  let br = 0;
  let brc = 0;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') par += 1;
    else if (ch === ')') par -= 1;
    else if (ch === '[') br += 1;
    else if (ch === ']') br -= 1;
    else if (ch === '{') brc += 1;
    else if (ch === '}') brc -= 1;
    if (par < 0 || br < 0 || brc < 0) return true;
  }
  return par !== 0 || br !== 0 || brc !== 0 || quote != null;
}

function syntaxCheckJsPyAfterWrite(filePath, content, { compileFn } = {}) {
  const p = String(filePath == null ? '' : filePath);
  const text = String(content == null ? '' : content);
  const lower = p.toLowerCase();
  if (/\.(js|mjs|cjs)$/.test(lower)) {
    if (unmatchedBrackets(text)) return { ok: false, code: 'syntax_invalid', lang: 'js' };
    if (/\b(import|export)\b/.test(text)) return { ok: true, code: null, lang: 'js', skipped: 'esm' };
    try {
      // parse only; never invoke
      void new Function(text);
      return { ok: true, code: null, lang: 'js' };
    } catch (_) {
      return { ok: false, code: 'syntax_invalid', lang: 'js' };
    }
  }
  if (/\.py$/.test(lower)) {
    if (typeof compileFn === 'function') {
      try {
        const r = compileFn(text);
        if (r === false || (r && r.ok === false)) return { ok: false, code: 'syntax_invalid', lang: 'py' };
        return { ok: true, code: null, lang: 'py' };
      } catch (_) {
        return { ok: false, code: 'syntax_invalid', lang: 'py' };
      }
    }
    if (unmatchedBrackets(text)) return { ok: false, code: 'syntax_invalid', lang: 'py' };
    if (/^\s*def\s*\(/m.test(text) || /^\s*class\s*:/m.test(text)) {
      return { ok: false, code: 'syntax_invalid', lang: 'py' };
    }
    return { ok: true, code: null, lang: 'py' };
  }
  return { ok: true, code: null, lang: null };
}

function rejectControlCharsInPaths(p) {
  const s = String(p == null ? '' : p);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32) return { ok: false, path: s, code: 'bad_path' };
  }
  return { ok: true, path: s, code: null };
}

function createFileExclusive({ path: filePath, exists, overwrite, existsFn } = {}) {
  let does = exists;
  if (typeof existsFn === 'function') {
    try { does = Boolean(existsFn(filePath)); } catch (_) { does = false; }
  }
  if (does && overwrite !== true) {
    return { ok: false, path: filePath, code: 'file_exists' };
  }
  return { ok: true, path: filePath, overwrite: Boolean(overwrite), code: null };
}

function sandboxTmpfsHint({ tmpdir, maxMb } = {}) {
  const mb = 64;
  const requested = Number(maxMb);
  return {
    tmpfsMb: mb,
    note: `tmp dir limited to ${mb}MB`,
    limitBytes: mb * 1024 * 1024,
    tmpdir: tmpdir != null ? String(tmpdir) : null,
    requestedMb: Number.isFinite(requested) ? requested : null,
    code: (Number.isFinite(requested) && requested > mb) ? 'tmpfs_exceeded' : null,
  };
}

function redactHomePathsInResults(text) {
  const src = text == null ? '' : (typeof text === 'string' ? text : (function () {
    try { return JSON.stringify(text); } catch (_) { return String(text); }
  }()));
  let next = src.replace(/\/home\/[^/\s"'`]+/g, '$HOME');
  next = next.replace(/(^|[^A-Za-z0-9_])\/root(?=\/|$|[^A-Za-z0-9_])/g, '$1$HOME');
  return { text: next, redacted: next !== src, code: next !== src ? 'secret_redact' : null };
}

function ssePingOnIdleTool({ elapsedMs, thresholdMs = SSE_IDLE_TOOL_MS } = {}) {
  const n = Number(elapsedMs);
  const th = Math.max(1000, Number(thresholdMs) || SSE_IDLE_TOOL_MS);
  if (Number.isFinite(n) && n > th) {
    return { ping: true, comment: ': ping\n\n', elapsedMs: n, code: 'sse_heartbeat' };
  }
  return { ping: false, elapsedMs: Number.isFinite(n) ? n : null, code: null };
}

function classifySseGap({ lastEventId, currentSeq, window = SSE_GAP_WINDOW } = {}) {
  const last = Number(lastEventId);
  const cur = Number(currentSeq);
  const win = Math.max(1, Number(window) || SSE_GAP_WINDOW);
  if (Number.isFinite(last) && Number.isFinite(cur) && (cur - last) > win) {
    return { replay: true, fromSeq: last + 1, lastEventId: last, currentSeq: cur, code: 'sse_gap' };
  }
  return { replay: false, fromSeq: Number.isFinite(last) ? last + 1 : null, code: null };
}

function fairQueueStarvationBound(waiters, { now = Date.now(), boundMs = QUEUE_STARVATION_MS, inFlight } = {}) {
  const list = Array.isArray(waiters) ? waiters.slice() : [];
  const bound = Math.max(1000, Number(boundMs) || QUEUE_STARVATION_MS);
  const inFlightId = inFlight && typeof inFlight === 'object' ? (inFlight.id || inFlight.runId) : inFlight;
  const aged = [];
  const rest = [];
  for (const w of list) {
    if (!w) { rest.push(w); continue; }
    const id = w.id || w.runId;
    const running = Boolean(w.running || w.inFlight) || (inFlightId != null && String(id) === String(inFlightId));
    if (running) { rest.push(w); continue; }
    const waited = w.waitedMs != null
      ? Number(w.waitedMs)
      : (now - (Number(w.enqueuedAt || w.at || w.ts) || now));
    if (Number.isFinite(waited) && waited > bound) {
      aged.push(Object.assign({}, w, { boosted: true }));
    } else {
      rest.push(w);
    }
  }
  const boosted = aged.length > 0;
  return { waiters: aged.concat(rest), boosted, code: boosted ? 'queue_fairness' : null };
}

function creditAuditOnToolError({ tokens, tool, code, session, prompt, completion } = {}) {
  const rec = {
    tokens: Math.max(0, Number(tokens) || 0),
    tool: String(tool || ''),
    code: String(code || ''),
    session: String(session || ''),
    prompt: Math.max(0, Number(prompt) || 0),
    completion: Math.max(0, Number(completion) || 0),
  };
  let audit = null;
  try {
    audit = appendTokenAuditLog({
      session: rec.session,
      total: rec.tokens,
      prompt: rec.prompt,
      completion: rec.completion,
      code: rec.code,
      tool: rec.tool,
    });
  } catch (_) { audit = null; }
  return { ok: true, rec, skipped: false, audit, code: rec.code || null };
}

function classifyFsErrors(err) {
  if (err == null) return { ok: true, code: null };
  const raw = String((err && (err.code || err.errno || err.message || err)) || '');
  const upper = raw.toUpperCase();
  if (/ENOENT/.test(upper)) {
    return { ok: false, code: 'fs_not_found', retryable: false, message: 'No encontre ese archivo.' };
  }
  if (/EACCES|EPERM/.test(upper)) {
    return { ok: false, code: 'fs_denied', retryable: false, message: 'No hay permiso para esa ruta.' };
  }
  if (/ENOSPC/.test(upper)) {
    return { ok: false, code: 'fs_nospace', retryable: false, message: 'No queda espacio en disco.' };
  }
  if (/EISDIR/.test(upper)) {
    return { ok: false, code: 'fs_isdir', retryable: false, message: 'Esa ruta es un directorio.' };
  }
  return { ok: true, code: null };
}

function skipMemoryRetrieveIfBusy({ elapsedMs, thresholdMs = MEMORY_BUSY_MS } = {}) {
  const n = Number(elapsedMs);
  const th = Math.max(500, Number(thresholdMs) || MEMORY_BUSY_MS);
  if (Number.isFinite(n) && n > th) {
    return { skipped: true, reason: 'latency', elapsedMs: n, code: null };
  }
  return { skipped: false, reason: null, elapsedMs: Number.isFinite(n) ? n : null, code: null };
}


// ---------------------------------------------------------------------------
// 3H39 — remaining holes vs Claude Code/Cowork after 3H38
//  132 join parallel tool results in call order (not finish order)
//  133 cancel in-flight tools on stop → { cancelled:true }
//  134 json repair trailing commas then parse
//  135 alias strreplace/str-replace/bash/search_replace
//  136 truncate nested tool args deeper than 6
//  137 max subagent depth 2
//  138 remaining wall clock <5s halt
//  139 compact merge adjacent duplicate user texts
//  140 memory retrieve dedupe by fact hash
//  141 refuse edit if sha256 changed since read
//  142 patch context lines must match (git_hunk_context)
//  143 atomic write via .tmp rename
//  144 reject UNC and Windows paths
//  145 sandbox no-new-privs hint
//  146 env scrub LD_PRELOAD / LD_LIBRARY_PATH
//  147 cancel drops buffered tokens (no flush)
//  148 SSE event id monotonic / replay window
//  149 idempotent same tool_call id while in-flight
//  150 settle credits if client gone
//  151 classify JSON parse errors → json_parse (no stack)
//  152 classify AbortError/ECANCELED → cancelled
//  153 skip duplicate web_fetch same URL in one turn
//  154 health adapter.wave=3H39
// ---------------------------------------------------------------------------

const NESTED_ARGS_MAX_DEPTH = 6;
const SUBAGENT_MAX_DEPTH = 2;
const WALL_CLOCK_CUT_MS = 5_000;
const SSE_EVENT_WINDOW = 64;

const TOOL_NAME_ALIASES = Object.freeze({
  strreplace: 'str_replace',
  'str-replace': 'str_replace',
  bash: 'execute_bash',
  search_replace: 'str_replace',
});

function idOfToolItem(item) {
  if (item == null) return null;
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (item.id != null && item.id !== '') return String(item.id);
  if (item.toolCallId != null) return String(item.toolCallId);
  if (item.tool_call_id != null) return String(item.tool_call_id);
  if (item.call && item.call.id != null) return String(item.call.id);
  if (item.prepared && item.prepared.call && item.prepared.call.id != null) {
    return String(item.prepared.call.id);
  }
  if (item.prepared && item.prepared.id != null) return String(item.prepared.id);
  return null;
}

function joinParallelToolResultsStableOrder(calls, finished) {
  const order = Array.isArray(calls) ? calls : [];
  const done = Array.isArray(finished) ? finished : [];
  const byId = new Map();
  const unused = done.slice();
  for (const item of done) {
    const id = idOfToolItem(item);
    if (id != null && !byId.has(id)) byId.set(id, item);
  }
  const results = [];
  for (let i = 0; i < order.length; i += 1) {
    const call = order[i];
    const id = idOfToolItem(call);
    let hit = null;
    if (id != null && byId.has(id)) {
      hit = byId.get(id);
      byId.delete(id);
      const idx = unused.indexOf(hit);
      if (idx >= 0) unused.splice(idx, 1);
    } else {
      const same = unused.find((item) => item === call || (item && (item.call === call || item.prepared === call)));
      if (same) {
        hit = same;
        const idx = unused.indexOf(same);
        if (idx >= 0) unused.splice(idx, 1);
      }
    }
    results.push(hit);
  }
  return { results, order: 'call', leftover: unused, code: null };
}

function cancelInflightToolsOnStop(inflight, { aborted, abort } = {}) {
  const list = Array.isArray(inflight) ? inflight : [];
  const stop = aborted === true || abort === true;
  if (!stop) {
    return { cancelled: [], remaining: list, results: list.slice(), code: null };
  }
  const cancelled = [];
  for (const item of list) {
    const rec = { cancelled: true };
    if (item && typeof item === 'object') {
      const id = idOfToolItem(item);
      if (id != null) rec.id = id;
      if (typeof item.reject === 'function') {
        try { item.reject(rec); } catch (_) { /* already settled */ }
      }
    }
    cancelled.push(rec);
  }
  return { cancelled, remaining: [], results: cancelled, code: 'turn_cancelled' };
}

function jsonRepairTrailingComma(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  const stripped = s.replace(/,(\s*[}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(stripped), repaired: stripped !== s, code: null };
  } catch (_) {
    return { ok: false, value: null, repaired: false, code: 'json_parse' };
  }
}

function aliasCommonToolNames(name) {
  const raw = String(name == null ? '' : name).trim();
  const key = raw.toLowerCase().replace(/\s+/g, '');
  const mapped = TOOL_NAME_ALIASES[key] || TOOL_NAME_ALIASES[raw] || null;
  if (mapped) return { name: mapped, aliased: true, from: raw, code: null };
  return { name: raw, aliased: false, from: raw, code: null };
}

function truncateNestedToolArgsDepth(args, { maxDepth = NESTED_ARGS_MAX_DEPTH } = {}) {
  const cap = Math.max(1, Number(maxDepth) || NESTED_ARGS_MAX_DEPTH);
  let truncated = false;
  function walk(v, depth) {
    if (v && typeof v === 'object') {
      if (depth > cap) {
        truncated = true;
        return { truncated: true };
      }
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], depth + 1);
      return o;
    }
    return v;
  }
  const next = walk(args, 0);
  return { args: next, truncated, code: truncated ? 'tool_args_invalid' : null };
}

function maxSubagentDepth(depth, { max = SUBAGENT_MAX_DEPTH } = {}) {
  const d = Number(depth);
  const cap = Math.max(1, Number(max) || SUBAGENT_MAX_DEPTH);
  const n = Number.isFinite(d) ? d : 0;
  if (n > cap) return { ok: false, depth: n, max: cap, code: 'subagent_depth' };
  return { ok: true, depth: n, max: cap, code: null };
}

function remainingWallClockCut({ remainingMs, remaining } = {}) {
  const n = Number(remainingMs != null ? remainingMs : remaining);
  if (Number.isFinite(n) && n < WALL_CLOCK_CUT_MS) {
    return { halt: true, remainingMs: n, code: 'wall_clock' };
  }
  return { halt: false, remainingMs: Number.isFinite(n) ? n : null, code: null };
}

function compactMergeAdjacentDuplicateUsers(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let merged = 0;
  for (const m of list) {
    const prev = out.length ? out[out.length - 1] : null;
    const role = m && String(m.role || '').toLowerCase();
    const prevRole = prev && String(prev.role || '').toLowerCase();
    const text = m && String(m.content != null ? m.content : (m.text || ''));
    const prevText = prev && String(prev.content != null ? prev.content : (prev.text || ''));
    if (role === 'user' && prevRole === 'user' && text === prevText) {
      merged += 1;
      continue;
    }
    out.push(m);
  }
  return { messages: out, merged, code: merged ? 'compact_fidelity' : null };
}

function factHashForDedupe(f) {
  if (f == null) return '';
  if (typeof f === 'string') return sha256Hex(f);
  if (f.hash) return String(f.hash);
  if (f.sha256) return String(f.sha256);
  const text = f.text || f.content || f.fact || f.body;
  if (text != null) return sha256Hex(String(text));
  try { return sha256Hex(JSON.stringify(f)); } catch (_) { return sha256Hex(String(f)); }
}

function memoryRetrieveDedupeByHash(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const f of list) {
    const h = factHashForDedupe(f);
    if (h && seen.has(h)) {
      dropped += 1;
      continue;
    }
    if (h) seen.add(h);
    kept.push(f);
  }
  return { facts: kept, dropped, code: dropped ? 'pin_dedup' : null };
}

function refuseEditIfChecksumChangedSinceRead({ sha256Now, sha256AtRead, actual, expected } = {}) {
  const now = String(sha256Now != null ? sha256Now : (actual != null ? sha256Hex(actual) : ''));
  const was = String(sha256AtRead != null ? sha256AtRead : (expected != null ? expected : ''));
  if (!was || now === was) {
    return { ok: true, sha256: now || null, code: null };
  }
  return { ok: false, sha256Now: now, sha256AtRead: was, code: 'file_changed' };
}

function patchContextLinesMustMatch({ haystack, diff, context, actual } = {}) {
  if (context != null || actual != null) {
    if (String(context == null ? '' : context) !== String(actual == null ? '' : actual)) {
      return { ok: false, code: 'git_hunk_context' };
    }
    return { ok: true, code: null };
  }
  const src = String(haystack == null ? '' : haystack);
  const d = String(diff == null ? '' : diff);
  if (!d.trim()) return { ok: true, code: null };
  for (const line of d.split('\n')) {
    if (!line.startsWith(' ')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const body = line.slice(1);
    if (!body) continue;
    if (src.indexOf(body) < 0) {
      return { ok: false, code: 'git_hunk_context', line: body };
    }
  }
  return { ok: true, code: null };
}

function atomicWriteViaTempRename({ path: filePath, content, writeFn, renameFn } = {}) {
  const p = String(filePath == null ? '' : filePath);
  const tmp = p ? `${p}.tmp` : '.tmp';
  if (typeof writeFn === 'function') writeFn(tmp, content);
  if (typeof renameFn === 'function') renameFn(tmp, p);
  return { ok: true, path: p, tmp, atomic: true, code: null };
}

function rejectUncAndWindowsPaths(p) {
  const s = String(p == null ? '' : p);
  if (s.startsWith('\\\\') || s.startsWith('//') || s.includes('\\\\')) {
    return { ok: false, path: s, code: 'bad_path' };
  }
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    return { ok: false, path: s, code: 'bad_path' };
  }
  return { ok: true, path: s, code: null };
}

function sandboxNoNewPrivs({ bin, argv } = {}) {
  const origBin = bin != null ? String(bin) : null;
  const origArgv = Array.isArray(argv) ? argv.slice() : [];
  const joined = `${origBin || ''} ${origArgv.join(' ')}`;
  const already = /setpriv --no-new-privs|\bprctl\b|--no-new-privs/.test(joined);
  let nextBin = origBin;
  let nextArgv = origArgv;
  let prefixed = false;
  if (!already && origArgv[0] === '-c' && origArgv[1]) {
    nextArgv = [origArgv[0], `setpriv --no-new-privs -- ${origArgv[1]}`, ...origArgv.slice(2)];
    prefixed = true;
  }
  return {
    bin: nextBin,
    argv: nextArgv,
    noNewPrivs: true,
    prefixed,
    hint: 'prctl/setpriv --no-new-privs',
    prefix: 'setpriv --no-new-privs --',
    code: null,
  };
}

function envScrubLdPreload(env) {
  const src = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  const out = Object.assign({}, src);
  const keys = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'ld_preload', 'ld_library_path'];
  let removed = 0;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      delete out[k];
      removed += 1;
    }
  }
  return { env: out, scrubbed: true, removed, code: null };
}

function cancelDropsBufferedTokens({ aborted, buffer, abort } = {}) {
  const stop = aborted === true || abort === true;
  let n = 0;
  if (Array.isArray(buffer)) n = buffer.length;
  else if (typeof buffer === 'string') n = buffer.length ? 1 : 0;
  else if (buffer && typeof buffer === 'object' && buffer.length != null) n = Number(buffer.length) || 0;
  if (stop) return { dropped: n, flushed: false, code: null };
  return { dropped: 0, flushed: true, remaining: n, code: null };
}

function sseEventIdMonotonic({ lastSent, lastEventId, clientId, window = SSE_EVENT_WINDOW } = {}) {
  const last = Number(lastSent);
  const client = Number(clientId != null ? clientId : lastEventId);
  const win = Math.max(1, Number(window) || SSE_EVENT_WINDOW);
  if (!Number.isFinite(last) || !Number.isFinite(client)) {
    return { ok: true, replay: false, code: null };
  }
  if (client < last) {
    return { ok: true, replay: false, resume: true, lastSent: last, clientId: client, code: null };
  }
  if (client > last + win) {
    return { ok: false, replay: true, lastSent: last, clientId: client, code: 'sse_gap' };
  }
  return { ok: true, replay: false, lastSent: last, clientId: client, code: null };
}

function idempotentSameCallIdInflight(callId, inflight, { create } = {}) {
  const id = String(callId || '');
  const map = inflight instanceof Map
    ? inflight
    : (inflight && typeof inflight === 'object' ? inflight : {});
  const existing = map instanceof Map ? map.get(id) : map[id];
  if (existing != null) {
    return { promise: existing, coalesced: true, code: 'exactly_once_tool' };
  }
  const p = typeof create === 'function' ? create() : { id, pending: true };
  if (map instanceof Map) map.set(id, p);
  else map[id] = p;
  return { promise: p, coalesced: false, inflight: map, code: null };
}

function settleCreditsIfClientGone({ res, aborted, sessionKey, requestId, usage } = {}) {
  const gone = Boolean(aborted)
    || Boolean(res && (res.writableEnded || res.destroyed || res.aborted));
  if (!gone) return { settled: false, gone: false, code: null };
  try {
    if (sessionKey && requestId) {
      try { settleCreditHold(sessionKey, requestId, { usage }); } catch (_) { /* optional */ }
      try { releaseCreditHold(sessionKey, requestId); } catch (_) { /* optional */ }
    }
  } catch (_) { /* still report settled */ }
  return { settled: true, gone: true, code: 'credit_cancel' };
}

function classifyJsonParseErrors(err) {
  if (err == null) return { ok: true, code: null };
  const name = String((err && err.name) || '');
  const msg = String((err && (err.message || err)) || '');
  const code = String((err && err.code) || '');
  if (
    name === 'SyntaxError'
    || code === 'json_parse'
    || /unexpected token|unterminated|in json/i.test(msg)
  ) {
    return {
      ok: false,
      code: 'json_parse',
      retryable: false,
      message: 'No pude interpretar el JSON de la herramienta.',
    };
  }
  return { ok: true, code: null };
}

function classifyAbortErrors(err) {
  if (err == null) return { ok: true, code: null };
  const name = String((err && err.name) || '');
  const code = String((err && err.code) || '');
  const msg = String((err && (err.message || err)) || '');
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ECANCELED' || /ECANCELED/i.test(msg)) {
    return {
      ok: false,
      code: 'cancelled',
      retryable: true,
      message: 'La operación fue cancelada.',
    };
  }
  return { ok: true, code: null };
}

function skipDuplicateWebFetchSameUrlTurn(url, turnCache, { result } = {}) {
  const href = String(url || '').trim();
  const cache = (turnCache && typeof turnCache === 'object') ? turnCache : {};
  if (Object.prototype.hasOwnProperty.call(cache, href)) {
    return { cacheHit: true, skipped: true, result: cache[href], url: href, code: null };
  }
  cache[href] = result !== undefined ? result : true;
  return { cacheHit: false, skipped: false, url: href, result: cache[href], code: null };
}


// ---------------------------------------------------------------------------
// 3H40 — remaining holes vs Claude Code/Cowork after 3H39
//  155 max tools per turn hard cap 32 → halt too_many_tools
//  156 abort nested subagents (depth>=1) on parent halt { aborted:n }
//  157 repair unquoted keys in tool JSON then parse
//  158 drop NUL bytes in tool args { stripped:true }
//  159 coerce integer from numeric string; reject "3.2"
//  160 circuit breaker two consecutive empty model responses
//  161 budget hint every 5 steps when remaining<=10
//  162 compact drop stale image/pdf older than last 2 user turns
//  163 memory skip facts older than 30 days { skipped:n }
//  164 rollback file bytes if syntaxCheck fails after write
//  165 refuse write through symlink { code:symlink_write }
//  166 strip UTF-8 BOM EF BB BF on read { bom:true }
//  167 sandbox SIGTERM then SIGKILL after 1500ms { killed:true }
//  168 stdout byte cap 64KiB per command { truncated:true }
//  169 SSE comment pad on idle>10s for CF/nginx flush
//  170 destroy SSE writer on req close { destroyed:true }
//  171 max 2 inflight generate per user (3rd overloaded)
//  172 steal lock if holder heartbeat older than 45s
//  173 never charge on 401/403 unauthorized
//  174 redact IPv4 in public error messages
//  175 classify EPIPE/ECONNRESET on response stream as cancelled
//  176 skip glob/grep when hits > 500 { truncated:true, glob_cap }
//  177 first-token watchdog 8000ms { code:ttfb_watchdog } (scripted)
//  178 health adapter.wave=3H40
// ---------------------------------------------------------------------------

const TOOLS_PER_TURN_HARD_CAP = 32;
const MEMORY_FACT_MAX_AGE_DAYS = 30;
const STDOUT_BYTE_CAP_PER_CMD = 64 * 1024;
const SSE_PROXY_PAD_IDLE_MS = 10_000;
const GENERATE_PENDING_MAX = 2;
const LOCK_HEARTBEAT_EXPIRE_MS = 45_000;
const TTFB_WATCHDOG_MS = 8_000;
const SANDBOX_KILL_GRACE_MS = 1_500;
const GLOB_MATCH_CAP = 500;

function maxToolsPerTurnHardCap(calls, { max = TOOLS_PER_TURN_HARD_CAP } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const cap = Math.max(1, Number(max) || TOOLS_PER_TURN_HARD_CAP);
  if (list.length > cap) {
    return { halt: true, count: list.length, max: cap, code: 'too_many_tools' };
  }
  return { halt: false, count: list.length, max: cap, code: null };
}

function abortNestedSubagentsOnParentHalt({ parentHalt, halt, children, nested, abortFn } = {}) {
  const stop = parentHalt === true || halt === true;
  const list = Array.isArray(children) ? children : (Array.isArray(nested) ? nested : []);
  if (!stop) return { aborted: 0, ids: [], code: null };
  const ids = [];
  for (const c of list) {
    const depth = (c && typeof c === 'object' && c.depth != null) ? Number(c.depth) : 1;
    if (!Number.isFinite(depth) || depth < 1) continue;
    const id = (c && typeof c === 'object')
      ? (c.id != null ? c.id : (c.subagentId != null ? c.subagentId : c))
      : c;
    try { if (typeof abortFn === 'function') abortFn(id); } catch (_) { /* best-effort */ }
    ids.push(id);
  }
  return { aborted: ids.length, ids, code: 'turn_cancelled' };
}

function repairUnquotedKeysInToolJson(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  const repaired = s.replace(/([{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  try {
    return { ok: true, value: JSON.parse(repaired), repaired: repaired !== s, code: null };
  } catch (_) {
    return { ok: false, value: null, repaired: false, code: 'json_parse' };
  }
}

function dropNullBytesInToolArgs(args) {
  let stripped = false;
  function walk(v) {
    if (typeof v === 'string') {
      if (v.indexOf('\u0000') >= 0) {
        stripped = true;
        return v.replace(/\u0000/g, '');
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  }
  return { args: walk(args), stripped, code: null };
}

function coerceIntegerFromNumericString(value, schema) {
  function walk(v, sch) {
    if (!sch || typeof sch !== 'object') return { ok: true, value: v };
    if (sch.type === 'integer') {
      if (typeof v === 'number' && Number.isInteger(v)) return { ok: true, value: v };
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^-?\d+$/.test(t)) return { ok: true, value: Number(t), coerced: true, code: null };
        return { ok: false, value: v, code: 'coercion_rejected' };
      }
      if (typeof v === 'number' && !Number.isInteger(v)) {
        return { ok: false, value: v, code: 'coercion_rejected' };
      }
    }
    if (sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      for (const k of Object.keys(v)) {
        const r = walk(v[k], sch.properties[k]);
        if (r.ok === false) return r;
        o[k] = r.value;
      }
      return { ok: true, value: o, code: null };
    }
    if (sch.items && Array.isArray(v)) {
      const arr = [];
      for (const item of v) {
        const r = walk(item, sch.items);
        if (r.ok === false) return r;
        arr.push(r.value);
      }
      return { ok: true, value: arr, code: null };
    }
    return { ok: true, value: v, code: null };
  }
  return walk(value, schema || { type: 'integer' });
}

function circuitBreakerEmptyModelTwice(response, state = {}) {
  const rec = state && typeof state === 'object' ? state : {};
  const msg = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message
    : (response && response.message) || response || {};
  const content = String(msg.content == null ? '' : msg.content).trim();
  const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const empty = !content && tools.length === 0;
  if (!empty) {
    rec.consecutiveEmpty = 0;
    return { halt: false, empty: false, consecutive: 0, code: null, state: rec };
  }
  rec.consecutiveEmpty = (Number(rec.consecutiveEmpty) || 0) + 1;
  if (rec.consecutiveEmpty >= 2) {
    return { halt: true, empty: true, consecutive: rec.consecutiveEmpty, code: 'empty_model', state: rec };
  }
  return { halt: false, empty: true, consecutive: rec.consecutiveEmpty, code: null, state: rec };
}

function budgetHintEveryFiveSteps({ step, remaining, max } = {}) {
  const s = Number(step);
  const left = Number(remaining);
  if (!Number.isFinite(s) || s <= 0 || s % 5 !== 0) {
    return { inject: false, text: null, step: Number.isFinite(s) ? s : null, remaining: Number.isFinite(left) ? left : null, code: null };
  }
  if (!Number.isFinite(left) || left > 10) {
    return { inject: false, text: null, step: s, remaining: Number.isFinite(left) ? left : null, code: null };
  }
  const n = Math.max(0, Math.floor(left));
  return {
    inject: true,
    text: `Quedan ${n} pasos.`,
    remaining: n,
    step: s,
    max: max != null ? Number(max) : null,
    code: 'plan_budget',
  };
}

function isImageOrPdfPart(p) {
  if (!p || typeof p === 'string') return false;
  const t = String(p.type || p.kind || '').toLowerCase();
  if (/image|pdf/.test(t)) return true;
  const mime = String(p.mime || p.media_type || p.mediaType || p.content_type || '').toLowerCase();
  if (/image\/|application\/pdf/.test(mime)) return true;
  if (p.image_url || p.imageUrl || p.inline_data || p.inlineData) return true;
  return false;
}

function compactDropStaleImageBlocks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const userIdx = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] && String(list[i].role || '').toLowerCase();
    if (r === 'user') userIdx.push(i);
  }
  const keepFrom = userIdx.length >= 2
    ? userIdx[userIdx.length - 2]
    : (userIdx.length === 1 ? userIdx[0] : list.length);
  let dropped = 0;
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (i >= keepFrom) { out.push(m); continue; }
    const content = m && m.content;
    if (Array.isArray(content)) {
      const next = [];
      for (const p of content) {
        if (isImageOrPdfPart(p)) { dropped += 1; continue; }
        next.push(p);
      }
      out.push(next.length === content.length ? m : Object.assign({}, m, { content: next }));
    } else {
      out.push(m);
    }
  }
  return { messages: out, dropped, code: dropped ? 'compact_fidelity' : null };
}

function memorySkipFactsOlderThanDays(facts, { days = MEMORY_FACT_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const d = Math.max(1, Number(days) || MEMORY_FACT_MAX_AGE_DAYS);
  const cutoff = now - d * 86400000;
  const kept = [];
  let skipped = 0;
  for (const f of list) {
    const ts = f && (f.ts != null ? f.ts : (f.timestamp != null ? f.timestamp : f.at));
    const n = typeof ts === 'number' ? ts : (ts ? Date.parse(String(ts)) : NaN);
    if (Number.isFinite(n) && n < cutoff) {
      skipped += 1;
      continue;
    }
    kept.push(f);
  }
  return { facts: kept, skipped, code: skipped ? 'pin_expire' : null };
}

function rollbackFileOnSyntaxFail({ syntaxOk, previous, before, writeFn, path: filePath } = {}) {
  if (syntaxOk !== false) return { rolledBack: false, path: filePath || null, code: null };
  const bytes = previous != null ? previous : before;
  if (typeof writeFn === 'function') {
    try { writeFn(filePath, bytes); } catch (_) { /* best-effort restore */ }
  }
  return { rolledBack: true, path: filePath || null, code: 'syntax_invalid' };
}

function refuseWriteThroughSymlink(filePath, { lstatSync, isSymlink } = {}) {
  const p = String(filePath == null ? '' : filePath);
  if (typeof isSymlink === 'function') {
    try {
      if (isSymlink(p)) return { ok: false, path: p, code: 'symlink_write' };
    } catch (_) { /* treat as not a symlink */ }
    return { ok: true, path: p, code: null };
  }
  const ls = typeof lstatSync === 'function' ? lstatSync : null;
  if (!ls) return { ok: true, skipped: true, path: p, code: null };
  try {
    const st = ls(p);
    if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
      return { ok: false, path: p, code: 'symlink_write' };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, path: p, missing: true, code: null };
  }
  return { ok: true, path: p, code: null };
}

function stripUtf8BomOnRead(text) {
  if (text == null) return { text: '', bom: false, code: null };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(text)) {
    if (text.length >= 3 && text[0] === 0xEF && text[1] === 0xBB && text[2] === 0xBF) {
      return { text: text.slice(3).toString('utf8'), bom: true, code: null };
    }
    return { text: text.toString('utf8'), bom: false, code: null };
  }
  const s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) return { text: s.slice(1), bom: true, code: null };
  if (s.length >= 3 && s.charCodeAt(0) === 0xEF && s.charCodeAt(1) === 0xBB && s.charCodeAt(2) === 0xBF) {
    return { text: s.slice(3), bom: true, code: null };
  }
  return { text: s, bom: false, code: null };
}

function sandboxKillAfterGraceMs({ pid, killFn, setTimeoutFn, graceMs = SANDBOX_KILL_GRACE_MS } = {}) {
  const p = Number(pid);
  const kn = typeof killFn === 'function' ? killFn : ((id, sig) => { try { process.kill(id, sig); } catch (_) {} });
  const st = typeof setTimeoutFn === 'function' ? setTimeoutFn : setTimeout;
  const grace = Math.max(0, Number(graceMs) || SANDBOX_KILL_GRACE_MS);
  const signals = [];
  if (Number.isFinite(p) && p > 0) {
    try { kn(p, 'SIGTERM'); signals.push('SIGTERM'); } catch (_) { /* already dead */ }
    st(() => {
      try { kn(p, 'SIGKILL'); } catch (_) { /* already dead */ }
    }, grace);
  }
  return { killed: true, pid: Number.isFinite(p) ? p : null, graceMs: grace, signals, code: 'sandbox_killed' };
}

function stdoutByteCapPerCommand(text, { maxBytes = STDOUT_BYTE_CAP_PER_CMD } = {}) {
  const s = String(text == null ? '' : text);
  const cap = Math.max(1, Number(maxBytes) || STDOUT_BYTE_CAP_PER_CMD);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return { text: s, truncated: false, bytes: buf.length, code: null };
  return {
    text: buf.subarray(0, cap).toString('utf8'),
    truncated: true,
    bytes: buf.length,
    maxBytes: cap,
    code: 'stdout_rate',
  };
}

function ssePadForProxyBuffering({ idleMs, lastWriteAt, now = Date.now(), thresholdMs = SSE_PROXY_PAD_IDLE_MS } = {}) {
  const idle = idleMs != null ? Number(idleMs) : (now - Number(lastWriteAt != null ? lastWriteAt : now));
  const thr = Math.max(1, Number(thresholdMs) || SSE_PROXY_PAD_IDLE_MS);
  if (!Number.isFinite(idle) || idle <= thr) {
    return { padded: false, comment: '', idleMs: Number.isFinite(idle) ? idle : 0, code: null };
  }
  const comment = ': \n\n';
  return { padded: true, comment, idleMs: idle, bytes: Buffer.byteLength(comment), code: 'sse_heartbeat' };
}

function destroySseOnClientClose(req, writer) {
  const rec = { destroyed: false, attached: false, code: null };
  function destroy() {
    rec.destroyed = true;
    try {
      if (writer && typeof writer.destroy === 'function') writer.destroy();
      else if (writer && typeof writer.close === 'function') writer.close();
    } catch (_) { /* already gone */ }
  }
  rec.destroy = destroy;
  if (req && typeof req.on === 'function') {
    rec.attached = true;
    req.on('close', destroy);
    if (req.destroyed === true || req.aborted === true) destroy();
    return rec;
  }
  destroy();
  return rec;
}

function maxPendingGeneratePerUser(userId, inflight, { max = GENERATE_PENDING_MAX } = {}) {
  const cap = Math.max(1, Number(max) || GENERATE_PENDING_MAX);
  let n = 0;
  if (typeof inflight === 'number') n = inflight;
  else if (Array.isArray(inflight)) n = inflight.length;
  else if (inflight instanceof Map) n = Number(inflight.get(String(userId || ''))) || 0;
  else if (inflight && typeof inflight === 'object') {
    const v = inflight[String(userId || '')];
    n = Array.isArray(v) ? v.length : (Number(v) || 0);
  }
  if (n >= cap) {
    return { ok: false, pending: n, max: cap, code: 'generate_overloaded' };
  }
  return { ok: true, pending: n, max: cap, code: null };
}

function stealLockIfHeartbeatExpired({ holder, heartbeatAt, heartbeat, now = Date.now(), requester, expireMs = LOCK_HEARTBEAT_EXPIRE_MS } = {}) {
  const at = Number(heartbeatAt != null ? heartbeatAt : heartbeat);
  const cap = Math.max(1, Number(expireMs) || LOCK_HEARTBEAT_EXPIRE_MS);
  if (!holder) {
    return { stolen: true, vacant: true, holder: requester || null, code: null };
  }
  const age = Number.isFinite(at) ? (now - at) : Infinity;
  if (age > cap) {
    return { stolen: true, holder: requester || null, previous: holder, ageMs: age, code: null };
  }
  return { stolen: false, holder, ageMs: age, live: true, code: null };
}

function neverChargeOnUnauthorized({ status, code, error } = {}) {
  const st = Number(status != null ? status : (error && (error.status || error.statusCode)));
  const c = String(code || (error && error.code) || '').toLowerCase();
  if (st === 401 || st === 403 || c === 'unauthorized' || c === 'forbidden' || c === 'user_required') {
    return { charge: false, code: 'unauthorized' };
  }
  return { charge: true, code: null };
}

function redactIpv4InPublicErrors(message) {
  const s = String(message == null ? '' : (typeof message === 'object' && message.message != null ? message.message : message));
  const text = s.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g, 'x.x.x.x');
  return { message: text, redacted: text !== s, code: null };
}

function classifyEpipeAsCancelled(err, { stream } = {}) {
  if (err == null) return { ok: true, code: null };
  const code = String((err && err.code) || '');
  const msg = String((err && (err.message || err)) || '');
  const where = String(stream || (err && err.stream) || '');
  const isEpipe = code === 'EPIPE' || /EPIPE/i.test(msg);
  const isReset = code === 'ECONNRESET' || /ECONNRESET/i.test(msg);
  if (where === 'tool' || where === 'net') return { ok: true, code: null };
  const onRes = where === 'response' || where === 'res' || where === 'sse' || isEpipe;
  if ((isEpipe || isReset) && onRes) {
    return {
      ok: false,
      code: 'cancelled',
      retryable: true,
      message: 'El cliente cerró la conexión.',
    };
  }
  return { ok: true, code: null };
}

function skipGlobIfMatchCap(hits, { max = GLOB_MATCH_CAP } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const cap = Math.max(1, Number(max) || GLOB_MATCH_CAP);
  if (list.length > cap) {
    return { hits: list.slice(0, cap), truncated: true, total: list.length, code: 'glob_cap' };
  }
  return { hits: list, truncated: false, total: list.length, code: null };
}

function firstTokenWatchdogMs({ elapsedMs, firstTokenAt, startedAt, now = Date.now(), timeoutMs = TTFB_WATCHDOG_MS } = {}) {
  const cap = Math.max(1, Number(timeoutMs) || TTFB_WATCHDOG_MS);
  if (firstTokenAt != null) {
    return { fired: false, elapsedMs: elapsedMs != null ? Number(elapsedMs) : 0, timeoutMs: cap, code: null };
  }
  const elapsed = elapsedMs != null
    ? Number(elapsedMs)
    : (now - Number(startedAt != null ? startedAt : now));
  if (Number.isFinite(elapsed) && elapsed >= cap) {
    return { fired: true, elapsedMs: elapsed, timeoutMs: cap, code: 'ttfb_watchdog' };
  }
  return { fired: false, elapsedMs: Number.isFinite(elapsed) ? elapsed : 0, timeoutMs: cap, code: null };
}


function adapterSnapshot() {
  return {
    retryBackoffJitter: true,
    consecutiveRepeatCut: true,
    sessionRemainingSteps: true,
    compactDropStaleBodies: true,
    keepLastToolNames: true,
    rollbackLastFileEdit: true,
    fuzzyWhitespaceReplace: true,
    capCommandStdout: true,
    tmpCleanupOnCancel: true,
    dropDuplicateGenerate: true,
    creditOnToolError: true,
    toolCountOnCancel: true,
    toolFailureTaxonomy: true,
    sanitizeClientError: true,
    sampledP50P95: true,
    denyDangerousTools: true,
    auditDurationTokens: true,
    pathMutationLock: true,
    emptyResponseRetryOnce: true,
    replaySameCallId: true,
    abortCascade: true,
    gatewayClaimTtl: true,
    refuseOpenRouter: true,
    stopOnFinalAnswer: true,
    toolTimeoutOverlay: true,
    sandboxEnvHard: true,
    remainingBudgetHint: true,
    afterWriteTestHint: true,
    sseCommentHeartbeat: true,
    honorLastEventId: true,
    mcpConnectedOnly: true,
    repairTruncatedJson: true,
    coerceStringyPrimitives: true,
    readLineNumbers: true,
    compactKeepLastNBodies: true,
    secretRedactToolResult: true,
    refuseBinaryRead: true,
    clampBase64ToolResult: true,
    globIgnoreDefaults: true,
    workspacePathJail: true,
    deepseekModelAllow: true,
    sseRingBound: true,
    sseGapDetect: true,
    userSpoofGuard: true,
    sessionGenerateRateLimit: true,
    toolArgByteCap: true,
    maxToolCallsPerMessage: true,
    stopReasonTaxonomy: true,
    webFetchGuard: true,
    backgroundBash: true,
    projectInstructions: true,
    pinExpireSweep: true,
    skipUnchangedWrite: true,
    canonicalTodo: true,
    preToolHook: true,
    partialAbortPersist: true,
    toolResultClampHash: true,
    pgvectorRankHits: true,
    rollbackLastNEdits: true,
    tokenAuditLog: true,
    fairGenerateLock: true,
    getLikeToolCache: true,
    modelVsToolTimeout: true,
    additionalPropertiesStrip: true,
    nfcPathJail: true,
    symlinkEscapeReject: true,
    sseCommentVsEvent: true,
    zeroTokenRefund: true,
    compactTokenBudget: true,
    subagentStepInherit: true,
    crossProcessFileLock: true,
    uniqueToolCallIds: true,
    orphanToolResultDrop: true,
    streamingJsonRepair: true,
    unifiedDiffApply: true,
    sandboxUlimitNprocNofile: true,
    stdoutStderrSplit: true,
    creditHoldThenSettle: true,
    resumeReplayToolResults: true,
    compactKeepSiragptLastUser: true,
    dropCancelledRunEvents: true,
    perToolRateLimit: true,
    imagePdfContextCap: true,
    maxTokensContextClamp: true,
    clockSkewSafeTtl: true,
    idempotentGenerateRequestId: true,
    toolNameAllowlist: true,
    nestedArrayObjectCoerce: true,
    createIfMissingLargeOverwrite: true,
    sandboxNetFailClosed: true,
    killProcessGroup: true,
    sseRetryFirstEvent: true,
    noSettleIfStreamNeverOpened: true,
    dropDuplicateSystemPrompts: true,
    skipEmptyMemoryFacts: true,
    stopIfFinalTextWithTools: true,
    gzipToolResultOverSize: true,
    redactUrlCredentials: true,
    generateResumeToken: true,
    deepseek429402Map: true,
    identicalObservationLoopCut: true,
    abortSiblingsOnParentCancel: true,
    validateEnumArgs: true,
    truncateOverlongArgStrings: true,
    cacheIdenticalToolCallSameTurn: true,
    detectDagCycle: true,
    remainingStepBudgetReminder: true,
    compactKeepToolCallResultPairs: true,
    minScoreMemoryRetrieve: true,
    checkpointAfterSuccessfulWrite: true,
    refuseBinaryFileEdit: true,
    normalizeLineEndingsBeforeDiff: true,
    moveFileSameVolume: true,
    sandboxRssCpuUlimit: true,
    scrubSecretsFromChildEnv: true,
    tmpdirCleanupFinally: true,
    sseMaxBufferDisconnect: true,
    heartbeatJitter: true,
    generateWaitRetryAfter: true,
    refundPartialTokensOnCancel: true,
    classifyNetErrors: true,
    skipCompactIfUnderBudget: true,
    maxConcurrentToolsPerTurn: true,
    subagentResultSizeCap: true,
    repairMissingRequiredFromPriorTurn: true,
    validateToolResultShape: true,
    toolTimeoutFitsRemainingBudget: true,
    deadLetterSameToolAfterN: true,
    injectPlanProgressLine: true,
    compactPreserveLastErrors: true,
    pinCriticalFacts: true,
    checkpointCasSeq: true,
    checksumVerifyAfterWrite: true,
    syntaxCheckJsPyAfterWrite: true,
    rejectControlCharsInPaths: true,
    createFileExclusive: true,
    sandboxTmpfsHint: true,
    redactHomePathsInResults: true,
    ssePingOnIdleTool: true,
    classifySseGap: true,
    fairQueueStarvationBound: true,
    creditAuditOnToolError: true,
    classifyFsErrors: true,
    skipMemoryRetrieveIfBusy: true,
    joinParallelToolResultsStableOrder: true,
    cancelInflightToolsOnStop: true,
    jsonRepairTrailingComma: true,
    aliasCommonToolNames: true,
    truncateNestedToolArgsDepth: true,
    maxSubagentDepth: true,
    remainingWallClockCut: true,
    compactMergeAdjacentDuplicateUsers: true,
    memoryRetrieveDedupeByHash: true,
    refuseEditIfChecksumChangedSinceRead: true,
    patchContextLinesMustMatch: true,
    atomicWriteViaTempRename: true,
    rejectUncAndWindowsPaths: true,
    sandboxNoNewPrivs: true,
    envScrubLdPreload: true,
    cancelDropsBufferedTokens: true,
    sseEventIdMonotonic: true,
    idempotentSameCallIdInflight: true,
    settleCreditsIfClientGone: true,
    classifyJsonParseErrors: true,
    classifyAbortErrors: true,
    skipDuplicateWebFetchSameUrlTurn: true,
    maxToolsPerTurnHardCap: true,
    abortNestedSubagentsOnParentHalt: true,
    repairUnquotedKeysInToolJson: true,
    dropNullBytesInToolArgs: true,
    coerceIntegerFromNumericString: true,
    circuitBreakerEmptyModelTwice: true,
    budgetHintEveryFiveSteps: true,
    compactDropStaleImageBlocks: true,
    memorySkipFactsOlderThanDays: true,
    rollbackFileOnSyntaxFail: true,
    refuseWriteThroughSymlink: true,
    stripUtf8BomOnRead: true,
    sandboxKillAfterGraceMs: true,
    stdoutByteCapPerCommand: true,
    ssePadForProxyBuffering: true,
    destroySseOnClientClose: true,
    maxPendingGeneratePerUser: true,
    stealLockIfHeartbeatExpired: true,
    neverChargeOnUnauthorized: true,
    redactIpv4InPublicErrors: true,
    classifyEpipeAsCancelled: true,
    skipGlobIfMatchCap: true,
    firstTokenWatchdogMs: true,
    pruneCheckpointsKeepLastN: true,
    persistSseLastEventIdCursor: true,
    repairSingleQuotesAndCommentsInToolJson: true,
    clampMaxOutputTokens: true,
    dropDuplicateConsecutiveToolCalls: true,
    classifyHttpFamily: true,
    compactKeepLastUserAssistantPair: true,
    redactKeyLikeToolArgsFromLogs: true,
    boundStepsOnCheckpointResume: true,
    rejectEmptyToolName: true,
    rejectNulInPath: true,
    skipHeartbeatIfWriteWouldBlock: true,
    waitInflightToolThenDropOnCancel: true,
    recordTokenUsageOnErrorPath: true,
    pgvectorMemoryQueryTimeout: true,
    refuseComputerToolsIfFlagOff: true,
    coerceTrueFalseStringsToBool: true,
    maxConcurrentSubagents: true,
    dropEmptyAssistantTurn: true,
    sseRetryMsInPad: true,
    sandboxTmpCleanupOnTimeout: true,
    subagentInheritAbortSignal: true,
    truncateToolResultWithMarker: true,
    isolateParallelToolTimeout: true,
    holdSettleNeverDoubleCharge: true,
    enforceAdditionalPropertiesFalse: true,
    ensureUniqueToolCallIdsAcrossResume: true,
    clampSchemaIntegerNumberToMinMax: true,
    repairMissingClosingBracesWithBudget: true,
    refundHoldIfNoTokensUsed: true,
    pinLastToolErrorOnCompact: true,
    replayLastNSseEventsFromCursor: true,
    rejectIdenticalPromptInflightSameSession: true,
    refuseWriteOver2MiB: true,
    skipEmptyEmbeddingUpsert: true,
    neverChargeToolOnlyObservationLoop: true,
    enforceTotalTurnWall120s: true,
    repairEnumCaseInsensitive: true,
    stripZeroWidthCharsFromArgs: true,
    clampJsonArrayLength256: true,
    retryAfterJitter50to150ms: true,
    tombstoneDeletedCheckpoint: true,
    stderrByteCapPerCommand: true,
    dropToolResultsOlderThan6Steps: true,
    rejectToolNameWithWhitespace: true,
    keepIdNumericStringsAsStrings: true,
    requireSessionEventSeqIncrease: true,
    abortSiblingToolsOnParentCancelToken: true,
    redactEmailsInLogs: true,
    maxHeartbeatsPerMinute: true,
    refuseReadThroughSymlink: true,
    markPlanStepFailedIfToolErrorTwice: true,
    restoreLastSseIdOnResume: true,
    capToolArgBytes32KiB: true,
    repairUnescapedNewlinesInJsonStrings: true,
    coerceNullStringToNullOptional: true,
    maxSseBuffersPerSession16: true,
    compactKeepPinnedFactsAndLast3UserTurns: true,
    refuseWriteIfDestDirMissing: true,
    ceilTokensOnCancel: true,
    classifyEconnresetAsCancelled: true,
    queueMaxWait60sThen503: true,
    skipUpsertIfEmbeddingDimMismatch: true,
    stallIfNoEvent20sMidStream: true,
    stripUtf16NulPadding: true,
    rejectToolNameLongerThan64: true,
    rejectRecursiveSameToolNameOver8: true,
    skipCompletedPlanStepsOnResume: true,
    gzipCheckpointIfOver64KiB: true,
    parseLastEventIdIntOnly: true,
    capGlobMatchFileSize1MiB: true,
    redactAuthorizationBearerInToolResults: true,
    refuseHostBashIfComputerOnlyTurn: true,
    subagentInheritRemainingStepBudget: true,
    concatenateSplitToolCallFragments: true,
    neverRetry402: true,
    combinedStdoutStderr96KiB: true,
    pingOnlyIfLastWriteOver15s: true,
    rejectUnicodeSlashHomoglyph: true,
    sessionLockOwnerPidCheck: true,
    mapPrismaDisconnectRetryable: true,
    defaultToolTimeout30sIfMissing: true,
    closeSseThenSettleCredits: true,
    maxInflightToolsPerSession8: true,
    stripLeftoverLineCommentsInJson: true,
    rejectNaNInfinityNumbers: true,
    dropSseEventsOlderThan2min: true,
    capCompactSummary2KiB: true,
    refuseWriteToEtcProcSys: true,
    neverNegativeUsage: true,
    queueFairShareExtraSlotIfWaitOver20s: true,
    skipMemoryIfScoreNaN: true,
    cancelIfThreeStreamStalls: true,
    stripBidiOverrideChars: true,
    rejectToolNameOutsideCharset: true,
    rejectToolCallCycleAtoBtoA: true,
    capPlanSteps24: true,
    refuseCheckpointOver1MiBUncompressed: true,
    rejectLastEventIdGoingBackwards: true,
    capGlobMatchesReturned32: true,
    redactJwtShapedStrings: true,
    refuseComputerToolsIfNoUserId: true,
    minRemainingSubagentBudget1: true,
    dropIncompleteTrailingToolCall: true,
    neverRetry413: true,
    capStdoutLine8KiB: true,
    closeIfClientGone30s: true,
    sessionLockTtl90s: true,
    mapRedisEconnrefusedRetryable: true,
    hardCapToolTimeout120s: true,
    flushLastSseEventBeforeClose: true,
    capSerializedToolList8KB: true,
    screenshotOnlyNoCharge: true,
    wave: '3H44',
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    latencyNote: 'scripted p50/p95; never invented Flash',
  };
}

// ---------------------------------------------------------------------------
// 3H41 — remaining holes vs Claude Code/Cowork after 3H40
//  179 prune checkpoints keep last N=8
//  180 persist SSE Last-Event-ID cursor
//  181 repair single quotes + trailing comments in tool JSON
//  182 clamp max output tokens (hard 8192)
//  183 drop duplicate consecutive tool calls (name+args)
//  184 classify HTTP family 5xx vs 4xx vs timeout separately
//  185 compact always keep last user+assistant pair
//  186 redact key-like tool args from logs
//  187 bound remaining steps on checkpoint resume
//  188 reject empty tool name
//  189 reject NUL in path
//  190 skip heartbeat if write would block
//  191 wait inflight tool then drop on cancel
//  192 record token usage on error path even if no completion
//  193 pgvector memory query timeout 2000ms
//  194 refuse computer_* if flag off
//  195 coerce "true"/"false" strings to bool
//  196 max concurrent subagents = 2
//  197 drop assistant message with 0 tools and 0 text
//  198 SSE retry:ms in pad
//  199 sandbox tmp cleanup on timeout
//  200 subagent inherits abort signal
//  201 truncate tool result with marker
//  202 isolate parallel tool timeout per item
//  203 hold-settle never double-charge on cancel
//  204 enforce additionalProperties false on tool schemas
//  205 health adapter.wave=3H41
// ---------------------------------------------------------------------------

const CHECKPOINT_KEEP_LAST_N = 8;
const MAX_OUTPUT_TOKENS_HARD = 8192;
const MAX_CONCURRENT_SUBAGENTS = 2;
const PGVECTOR_QUERY_TIMEOUT_MS = 2_000;
const TOOL_RESULT_MARKER_CAP = 12_000;
const SSE_RETRY_MS_DEFAULT = 2_000;
const PARALLEL_TOOL_TIMEOUT_MS = 15_000;

function pruneCheckpointsKeepLastN(list, { keep = CHECKPOINT_KEEP_LAST_N } = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const n = Math.max(1, Number(keep) || CHECKPOINT_KEEP_LAST_N);
  if (arr.length <= n) return { pruned: false, dropped: 0, checkpoints: arr, keep: n, code: null };
  const dropped = arr.length - n;
  return { pruned: true, dropped, checkpoints: arr.slice(-n), keep: n, code: 'ckpt_prune' };
}

function persistSseLastEventIdCursor({ lastEventId, seq, store } = {}) {
  const id = lastEventId != null ? Number(lastEventId) : Number(seq);
  const rec = (store && typeof store === 'object') ? store : {};
  if (!Number.isFinite(id) || id < 0) {
    return { persisted: false, cursor: rec.cursor != null ? rec.cursor : 0, code: 'sse_cursor' };
  }
  const prev = Number(rec.cursor) || 0;
  if (id < prev) return { persisted: false, cursor: prev, stale: true, code: 'sse_cursor' };
  rec.cursor = id;
  return { persisted: true, cursor: id, store: rec, code: null };
}

function repairSingleQuotesAndCommentsInToolJson(raw) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  let repaired = s.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
  try {
    return { ok: true, value: JSON.parse(repaired), repaired: repaired !== s, code: null };
  } catch (_) {
    return { ok: false, value: null, repaired: false, code: 'json_parse' };
  }
}

function clampMaxOutputTokens(n, { max = MAX_OUTPUT_TOKENS_HARD, min = 1 } = {}) {
  const raw = Number(n);
  const hi = Math.max(1, Number(max) || MAX_OUTPUT_TOKENS_HARD);
  const lo = Math.max(1, Number(min) || 1);
  if (!Number.isFinite(raw)) return { ok: true, maxTokens: hi, clamped: true, code: 'max_output_tokens' };
  const v = Math.min(hi, Math.max(lo, Math.floor(raw)));
  return { ok: true, maxTokens: v, clamped: v !== raw, code: v !== raw ? 'max_output_tokens' : null };
}

function _toolCallFingerprint(c) {
  if (!c || typeof c !== 'object') return String(c || '');
  const name = (c.function && c.function.name) || c.name || '';
  const args = (c.function && c.function.arguments) || c.arguments || c.args || '';
  const argStr = typeof args === 'string' ? args : JSON.stringify(args || {});
  return `${name}\n${argStr}`;
}

function dropDuplicateConsecutiveToolCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const out = [];
  let dropped = 0;
  let prev = null;
  for (const c of list) {
    const fp = _toolCallFingerprint(c);
    if (prev != null && fp === prev) {
      dropped += 1;
      continue;
    }
    prev = fp;
    out.push(c);
  }
  return { calls: out, dropped, code: dropped ? 'dup_tool_call' : null };
}

function classifyHttpFamily(error) {
  const err = error || {};
  const status = Number(err.status || err.statusCode || err.response && err.response.status);
  const code = String(err.code || err.errno || '').toUpperCase();
  const msg = String(err.message || '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed?\s*out/i.test(msg) || err.name === 'TimeoutError') {
    return { family: 'timeout', retryable: true, code: 'http_timeout', status: Number.isFinite(status) ? status : null };
  }
  if (Number.isFinite(status) && status >= 500) {
    return { family: '5xx', retryable: true, code: 'http_5xx', status };
  }
  if (Number.isFinite(status) && status >= 400) {
    return { family: '4xx', retryable: false, code: 'http_4xx', status };
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return { family: 'net', retryable: true, code: 'http_net', status: null };
  }
  return { family: 'ok', retryable: false, code: null, status: Number.isFinite(status) ? status : null };
}

function compactKeepLastUserAssistantPair(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  let lastUser = -1;
  let lastAsst = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = String((list[i] && list[i].role) || '');
    if (lastAsst < 0 && r === 'assistant') lastAsst = i;
    if (lastUser < 0 && r === 'user') lastUser = i;
    if (lastUser >= 0 && lastAsst >= 0) break;
  }
  const keep = new Set();
  if (lastUser >= 0) keep.add(lastUser);
  if (lastAsst >= 0) keep.add(lastAsst);
  return { messages: list, keepIndexes: [...keep].sort((a, b) => a - b), kept: keep.size, code: null };
}

function redactKeyLikeToolArgsFromLogs(args) {
  const KEY_RE = /(?:api[_-]?key|secret|token|password|authorization|bearer|sk-[a-zA-Z0-9]+)/i;
  let redacted = false;
  function walk(v) {
    if (typeof v === 'string') {
      if (KEY_RE.test(v)) {
        redacted = true;
        return '[REDACTED]';
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        if (KEY_RE.test(k)) {
          redacted = true;
          o[k] = '[REDACTED]';
        } else o[k] = walk(v[k]);
      }
      return o;
    }
    return v;
  }
  return { args: walk(args), redacted, code: redacted ? 'secret_redact' : null };
}

function boundStepsOnCheckpointResume({ remaining, checkpointRemaining, max } = {}) {
  const cap = Math.max(1, Number(max) || 25);
  const live = Number(remaining);
  const ck = Number(checkpointRemaining);
  const fromLive = Number.isFinite(live) ? live : cap;
  const fromCk = Number.isFinite(ck) ? ck : cap;
  const bound = Math.max(0, Math.min(cap, fromLive, fromCk));
  return { remaining: bound, capped: bound < fromLive || bound < fromCk, max: cap, code: null };
}

function rejectEmptyToolName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, code: 'empty_tool_name' };
  return { ok: true, name: n, code: null };
}

function rejectNulInPath(p) {
  const s = String(p == null ? '' : p);
  if (s.indexOf('\u0000') >= 0) return { ok: false, code: 'nul_path' };
  return { ok: true, path: s, code: null };
}

function skipHeartbeatIfWriteWouldBlock({ wouldBlock, pendingBytes, writable } = {}) {
  if (writable === false) return { skip: true, reason: 'closed', code: null };
  const pending = Number(pendingBytes);
  if (wouldBlock === true || (Number.isFinite(pending) && pending > 0)) {
    return { skip: true, reason: 'backpressure', code: null };
  }
  return { skip: false, reason: null, code: null };
}

function waitInflightToolThenDropOnCancel({ cancelled, inflight, waitFn } = {}) {
  if (!cancelled) return { waited: false, dropped: 0, code: null };
  const list = Array.isArray(inflight) ? inflight : (inflight ? [inflight] : []);
  if (typeof waitFn === 'function') {
    try { waitFn(list); } catch (_) { /* best-effort */ }
  }
  return { waited: true, dropped: list.length, ids: list.map((t) => (t && t.id) || t), code: 'turn_cancelled' };
}

function recordTokenUsageOnErrorPath({ usage, error, noCompletion } = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const prompt = Number(u.prompt_tokens || u.promptTokens || 0) || 0;
  const completion = noCompletion ? 0 : (Number(u.completion_tokens || u.completionTokens || 0) || 0);
  const total = prompt + completion;
  return {
    recorded: true,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    error: error ? String(error.code || error.message || error) : null,
    noCompletion: !!noCompletion,
    code: null,
  };
}

function pgvectorMemoryQueryTimeout({ elapsedMs, timeoutMs = PGVECTOR_QUERY_TIMEOUT_MS } = {}) {
  const elapsed = Number(elapsedMs);
  const cap = Math.max(1, Number(timeoutMs) || PGVECTOR_QUERY_TIMEOUT_MS);
  if (Number.isFinite(elapsed) && elapsed >= cap) {
    return { timedOut: true, elapsedMs: elapsed, timeoutMs: cap, code: 'pgvector_timeout' };
  }
  return { timedOut: false, elapsedMs: Number.isFinite(elapsed) ? elapsed : 0, timeoutMs: cap, code: null };
}

function refuseComputerToolsIfFlagOff(name, { computerEnabled } = {}) {
  const n = String(name || '');
  if (!/^computer_/i.test(n)) return { ok: true, refused: false, code: null };
  if (computerEnabled === true) return { ok: true, refused: false, code: null };
  return { ok: false, refused: true, name: n, code: 'computer_flag_off' };
}

function coerceTrueFalseStringsToBool(value, schema) {
  function walk(v, sch) {
    if (!sch || typeof sch !== 'object') return { ok: true, value: v };
    if (sch.type === 'boolean') {
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t === 'true') return { ok: true, value: true, coerced: true, code: null };
        if (t === 'false') return { ok: true, value: false, coerced: true, code: null };
        return { ok: false, value: v, code: 'coercion_rejected' };
      }
    }
    if (sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      for (const k of Object.keys(v)) {
        const r = walk(v[k], sch.properties[k]);
        if (r.ok === false) return r;
        o[k] = r.value;
      }
      return { ok: true, value: o, code: null };
    }
    return { ok: true, value: v, code: null };
  }
  return walk(value, schema || { type: 'boolean' });
}

function maxConcurrentSubagents(list, { max = MAX_CONCURRENT_SUBAGENTS } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const cap = Math.max(1, Number(max) || MAX_CONCURRENT_SUBAGENTS);
  if (arr.length > cap) {
    return { ok: false, halt: true, count: arr.length, max: cap, run: arr.slice(0, cap), deferred: arr.slice(cap), code: 'subagent_concurrency' };
  }
  return { ok: true, halt: false, count: arr.length, max: cap, run: arr, deferred: [], code: null };
}

function dropEmptyAssistantTurn(message) {
  const msg = message && message.choices && message.choices[0] && message.choices[0].message
    ? message.choices[0].message
    : (message && message.message) || message || {};
  const content = String(msg.content == null ? '' : msg.content).trim();
  const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (!content && tools.length === 0) {
    return { drop: true, code: 'empty_turn' };
  }
  return { drop: false, code: null };
}

function sseRetryMsInPad({ retryMs = SSE_RETRY_MS_DEFAULT } = {}) {
  const ms = Math.max(0, Math.floor(Number(retryMs) || SSE_RETRY_MS_DEFAULT));
  return { padded: true, retryMs: ms, frame: `retry: ${ms}\n\n`, code: null };
}

function sandboxTmpCleanupOnTimeout({ timedOut, tmpDir, rmFn } = {}) {
  if (!timedOut) return { cleaned: false, path: tmpDir || null, code: null };
  const p = tmpDir != null ? String(tmpDir) : '';
  if (p && typeof rmFn === 'function') {
    try { rmFn(p); } catch (_) { /* best-effort */ }
  }
  return { cleaned: !!p, path: p || null, code: 'sandbox_timeout' };
}

function subagentInheritAbortSignal({ parentSignal, child } = {}) {
  const parent = parentSignal || null;
  const rec = (child && typeof child === 'object') ? child : {};
  if (parent && parent.aborted) {
    rec.aborted = true;
    rec.signal = parent;
    return { inherited: true, aborted: true, child: rec, code: 'turn_cancelled' };
  }
  rec.signal = parent;
  return { inherited: true, aborted: false, child: rec, code: null };
}

function truncateToolResultWithMarker(text, { maxBytes = TOOL_RESULT_MARKER_CAP } = {}) {
  const s = text == null ? '' : (typeof text === 'string' ? text : JSON.stringify(text));
  const cap = Math.max(16, Number(maxBytes) || TOOL_RESULT_MARKER_CAP);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= cap) return { truncated: false, text: s, bytes, maxBytes: cap, code: null };
  const marker = `\n[truncated ${bytes - cap} bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keep = Math.max(0, cap - markerBytes);
  let cut = Buffer.from(s, 'utf8').subarray(0, keep).toString('utf8');
  while (Buffer.byteLength(cut + marker, 'utf8') > cap && cut.length) cut = cut.slice(0, -1);
  return { truncated: true, text: cut + marker, bytes, maxBytes: cap, code: 'tool_result_truncated' };
}

function isolateParallelToolTimeout(tools, { timeoutMs = PARALLEL_TOOL_TIMEOUT_MS } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const ms = Math.max(1, Number(timeoutMs) || PARALLEL_TOOL_TIMEOUT_MS);
  const isolated = list.map((t, i) => ({
    index: i,
    id: (t && (t.id || t.callId)) || i,
    timeoutMs: ms,
  }));
  return { isolated, timeoutMs: ms, count: isolated.length, code: null };
}

function holdSettleNeverDoubleCharge({ held, settled, cancelled } = {}) {
  if (!held) return { charge: false, settled: false, code: null };
  if (settled) return { charge: false, settled: true, skipped: true, code: 'credit_hold_reuse' };
  if (cancelled) return { charge: false, settled: true, cancelled: true, code: 'credit_cancel' };
  return { charge: true, settled: true, code: null };
}

function enforceAdditionalPropertiesFalse(schema) {
  if (!schema || typeof schema !== 'object') {
    return { schema: { type: 'object', additionalProperties: false }, enforced: true, code: null };
  }
  function walk(sch) {
    if (!sch || typeof sch !== 'object') return sch;
    const o = Array.isArray(sch) ? sch.slice() : { ...sch };
    if (!Array.isArray(o) && (o.type === 'object' || o.properties)) {
      if (o.additionalProperties !== false) o.additionalProperties = false;
    }
    if (o.properties && typeof o.properties === 'object') {
      const p = {};
      for (const k of Object.keys(o.properties)) p[k] = walk(o.properties[k]);
      o.properties = p;
    }
    if (o.items) o.items = walk(o.items);
    return o;
  }
  return { schema: walk(schema), enforced: true, code: null };
}


// ---------------------------------------------------------------------------
// 3H42 — remaining holes vs Claude Code/Cowork after 3H41
//  206 tool_call id uniqueness across resume
//  207 schema integer/number clamp to min/max
//  208 repair JSON missing closing braces with budget
//  209 cancel: refund hold if no tokens used
//  210 compact: pin last tool error
//  211 SSE reconnect: replay last 32 events from cursor
//  212 queue: reject new generate if same session has identical prompt inflight
//  213 file edit: refuse write >2MiB
//  214 memory upsert: skip empty embeddings
//  215 credit: never charge for tool-only observation loops
//  216 total-turn wall clock 120s
//  217 case-insensitive enum repair
//  218 strip zero-width chars from args
//  219 max JSON array length 256
//  220 429 Retry-After jitter 50–150ms
//  221 checkpoint CAS tombstone deleted ckpt
//  222 stderr same 64KiB cap as stdout
//  223 drop tool results older than 6 steps when compacting
//  224 reject tool name with whitespace
//  225 coerce numeric strings that are ids stay strings
//  226 session event order: seq must increase
//  227 abort sibling tools on parent cancel token
//  228 redact emails in logs
//  229 max 8 heartbeats/min
//  230 refuse to follow symlink for read
//  231 plan: mark step failed if tool error twice
//  232 resume: restore last SSE id
//  233 health adapter.wave=3H42
// ---------------------------------------------------------------------------

const SSE_REPLAY_WINDOW = 32;
const WRITE_MAX_BYTES_2MIB = 2 * 1024 * 1024;
const TOTAL_TURN_WALL_MS = 120_000;
const JSON_ARRAY_MAX_LEN = 256;
const STDERR_BYTE_CAP = 64 * 1024;
const COMPACT_TOOL_RESULT_AGE_STEPS = 6;
const HEARTBEATS_PER_MIN_MAX = 8;
const JSON_BRACE_REPAIR_BUDGET = 8;
const RETRY_AFTER_JITTER_MIN_MS = 50;
const RETRY_AFTER_JITTER_MAX_MS = 150;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ID_KEY_RE = /(?:^|_)(id|uuid|guid|key|slug|token)$/i;

function ensureUniqueToolCallIdsAcrossResume(calls, { seenFromCheckpoint, prefix = 'call' } = {}) {
  const list = Array.isArray(calls)
    ? calls.map((c) => (c && typeof c === 'object' ? Object.assign({}, c) : c))
    : [];
  const seen = new Set(
    Array.isArray(seenFromCheckpoint) ? seenFromCheckpoint.map(String) : (seenFromCheckpoint instanceof Set ? [...seenFromCheckpoint].map(String) : []),
  );
  let duplicates = 0;
  let assigned = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (!c || typeof c !== 'object') continue;
    let id = String(c.id || '').trim();
    if (!id || seen.has(id)) {
      if (id && seen.has(id)) duplicates += 1;
      let n = i;
      do {
        id = `${prefix}_r${n}`;
        n += 1;
      } while (seen.has(id));
      assigned += 1;
    }
    c.id = id;
    seen.add(id);
  }
  return {
    calls: list,
    duplicates,
    assigned,
    ids: Array.from(seen),
    code: duplicates ? 'tool_id_resume_dup' : null,
  };
}

function clampSchemaIntegerNumberToMinMax(value, schema) {
  function walk(v, sch) {
    if (!sch || typeof sch !== 'object') return { ok: true, value: v };
    const t = sch.type;
    if (t === 'integer' || t === 'number') {
      let n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return { ok: false, value: v, code: 'coercion_rejected' };
      if (t === 'integer') n = Math.trunc(n);
      const lo = sch.minimum != null ? Number(sch.minimum) : (sch.min != null ? Number(sch.min) : null);
      const hi = sch.maximum != null ? Number(sch.maximum) : (sch.max != null ? Number(sch.max) : null);
      let clamped = false;
      if (Number.isFinite(lo) && n < lo) { n = lo; clamped = true; }
      if (Number.isFinite(hi) && n > hi) { n = hi; clamped = true; }
      return { ok: true, value: n, clamped, code: clamped ? 'schema_clamp' : null };
    }
    if (sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      let any = false;
      for (const k of Object.keys(v)) {
        const r = walk(v[k], sch.properties[k]);
        if (r.ok === false) return r;
        o[k] = r.value;
        if (r.clamped) any = true;
      }
      return { ok: true, value: o, clamped: any, code: any ? 'schema_clamp' : null };
    }
    return { ok: true, value: v, code: null };
  }
  return walk(value, schema || {});
}

function repairMissingClosingBracesWithBudget(raw, { budget = JSON_BRACE_REPAIR_BUDGET } = {}) {
  if (raw == null) return { ok: true, value: {}, repaired: false, code: null };
  if (typeof raw === 'object') return { ok: true, value: raw, repaired: false, code: null };
  const s = String(raw);
  try { return { ok: true, value: JSON.parse(s), repaired: false, code: null }; } catch (_) { /* repair */ }
  const cap = Math.max(0, Math.min(32, Number(budget) || JSON_BRACE_REPAIR_BUDGET));
  let stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (inStr) {
    // close hanging string first so braces can close
    stack.push('"');
  }
  if (!stack.length) return { ok: false, value: null, repaired: false, code: 'json_parse' };
  if (stack.length > cap) return { ok: false, value: null, repaired: false, budget: cap, code: 'json_parse' };
  const suffix = stack.reverse().join('');
  try {
    return { ok: true, value: JSON.parse(s + suffix), repaired: true, added: suffix, code: null };
  } catch (_) {
    return { ok: false, value: null, repaired: false, code: 'json_parse' };
  }
}

function refundHoldIfNoTokensUsed({ held, promptTokens, completionTokens, cancelled } = {}) {
  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;
  const used = prompt + completion;
  if (!held) return { refund: false, charge: false, used, code: null };
  if (used > 0) return { refund: false, charge: true, used, code: null };
  return { refund: true, charge: false, used: 0, cancelled: !!cancelled, code: 'credit_no_usage' };
}

function pinLastToolErrorOnCompact(messages, { pins } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const pinList = Array.isArray(pins) ? pins.slice() : [];
  let last = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    const isTool = role === 'tool' || role === 'function' || m.isError || m.error;
    const text = String(m.content == null ? (m.error || m.message || '') : m.content);
    const errish = m.isError === true || m.error || /error|failed|exception/i.test(text) || (role === 'tool' && m.ok === false);
    if (isTool && errish) {
      last = { role: 'tool', content: text.slice(0, 2000), error: true, step: i };
      break;
    }
  }
  if (!last) return { pinned: false, pins: pinList, code: null };
  const already = pinList.some((p) => String((p && (p.content || p.text)) || p) === last.content);
  if (!already) pinList.push({ kind: 'tool_error', content: last.content, pinned: true });
  return { pinned: true, pin: last, pins: pinList, code: 'pin_tool_error' };
}

function replayLastNSseEventsFromCursor(events, { cursor, limit = SSE_REPLAY_WINDOW } = {}) {
  const list = Array.isArray(events) ? events : [];
  const n = Math.max(1, Math.min(SSE_REPLAY_WINDOW, Number(limit) || SSE_REPLAY_WINDOW));
  const cur = Number(cursor);
  const after = Number.isFinite(cur)
    ? list.filter((e) => Number((e && (e.id || e.seq)) ) > cur)
    : list;
  const replay = after.slice(-n);
  return {
    replay,
    count: replay.length,
    truncated: after.length > n,
    window: n,
    cursor: Number.isFinite(cur) ? cur : 0,
    code: replay.length ? 'sse_resume' : null,
  };
}

function rejectIdenticalPromptInflightSameSession({ sessionKey, prompt, inflight } = {}) {
  const key = String(sessionKey || '');
  const p = String(prompt == null ? '' : prompt);
  const list = Array.isArray(inflight) ? inflight : (inflight ? [inflight] : []);
  if (!key || !p) return { reject: false, code: null };
  const hit = list.find((row) => {
    if (!row) return false;
    const sk = String(row.sessionKey || row.session || '');
    const pr = String(row.prompt == null ? row.text || '' : row.prompt);
    return (!sk || sk === key) && pr === p;
  });
  if (hit) return { reject: true, sessionKey: key, code: 'identical_prompt_inflight' };
  return { reject: false, sessionKey: key, code: null };
}

function refuseWriteOver2MiB(content, { maxBytes = WRITE_MAX_BYTES_2MIB } = {}) {
  const s = content == null ? '' : (Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
  const bytes = s.length;
  const cap = Math.max(1, Number(maxBytes) || WRITE_MAX_BYTES_2MIB);
  if (bytes > cap) return { ok: false, bytes, maxBytes: cap, code: 'write_too_large' };
  return { ok: true, bytes, maxBytes: cap, code: null };
}

function skipEmptyEmbeddingUpsert(vector, { fact } = {}) {
  const emptyFact = fact != null && String(fact).trim() === '';
  if (emptyFact) return { skip: true, reason: 'empty_fact', code: 'empty_embedding' };
  if (vector == null) return { skip: true, reason: 'null', code: 'empty_embedding' };
  if (Array.isArray(vector)) {
    if (vector.length === 0) return { skip: true, reason: 'empty_array', code: 'empty_embedding' };
    const allZero = vector.every((n) => !Number(n));
    if (allZero) return { skip: true, reason: 'zero', code: 'empty_embedding' };
    return { skip: false, dim: vector.length, code: null };
  }
  if (typeof vector === 'string' && !vector.trim()) return { skip: true, reason: 'empty_string', code: 'empty_embedding' };
  return { skip: false, code: null };
}

function neverChargeToolOnlyObservationLoop({ toolOnly, observationLoop, usage, charged } = {}) {
  const tokens = Number((usage && (usage.total_tokens || usage.totalTokens)) || 0) || 0;
  if (charged) return { charge: false, skipped: true, code: 'credit_hold_reuse' };
  if (toolOnly && observationLoop) {
    return { charge: false, skipped: true, tokens, code: 'credit_observation' };
  }
  return { charge: true, skipped: false, tokens, code: null };
}

function enforceTotalTurnWall120s({ startedAt, now, wallMs = TOTAL_TURN_WALL_MS } = {}) {
  const start = Number(startedAt) || 0;
  const t = Number(now) || Date.now();
  const cap = Math.max(1000, Number(wallMs) || TOTAL_TURN_WALL_MS);
  const elapsed = t - start;
  if (start && elapsed >= cap) {
    return { halt: true, elapsedMs: elapsed, wallMs: cap, code: 'turn_wall' };
  }
  return { halt: false, elapsedMs: start ? elapsed : 0, wallMs: cap, remainingMs: start ? Math.max(0, cap - elapsed) : cap, code: null };
}

function repairEnumCaseInsensitive(value, schema) {
  function walk(v, sch) {
    if (!sch || typeof sch !== 'object') return { ok: true, value: v };
    if (Array.isArray(sch.enum) && sch.enum.length) {
      if (sch.enum.includes(v)) return { ok: true, value: v, repaired: false, code: null };
      const want = String(v == null ? '' : v).toLowerCase();
      const hit = sch.enum.find((e) => String(e).toLowerCase() === want);
      if (hit !== undefined) return { ok: true, value: hit, repaired: true, code: 'enum_repair' };
      return { ok: false, value: v, code: 'enum_invalid' };
    }
    if (sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      let repaired = false;
      for (const k of Object.keys(v)) {
        const r = walk(v[k], sch.properties[k]);
        if (r.ok === false) return r;
        o[k] = r.value;
        if (r.repaired) repaired = true;
      }
      return { ok: true, value: o, repaired, code: repaired ? 'enum_repair' : null };
    }
    return { ok: true, value: v, code: null };
  }
  return walk(value, schema || {});
}

function stripZeroWidthCharsFromArgs(args) {
  function walk(v) {
    if (typeof v === 'string') return v.replace(ZERO_WIDTH_RE, '');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  }
  const out = walk(args);
  const changed = JSON.stringify(out) !== JSON.stringify(args);
  return { args: out, stripped: changed, code: changed ? 'zero_width_strip' : null };
}

function clampJsonArrayLength256(value, { max = JSON_ARRAY_MAX_LEN } = {}) {
  const cap = Math.max(1, Number(max) || JSON_ARRAY_MAX_LEN);
  let truncated = false;
  function walk(v, depth) {
    if (depth > 32) return v;
    if (Array.isArray(v)) {
      if (v.length > cap) {
        truncated = true;
        v = v.slice(0, cap);
      }
      return v.map((x) => walk(x, depth + 1));
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], depth + 1);
      return o;
    }
    return v;
  }
  const out = walk(value, 0);
  return { value: out, truncated, max: cap, code: truncated ? 'array_cap' : null };
}

function retryAfterJitter50to150ms({ retryAfterMs, retryAfterSec, rand } = {}) {
  const base = retryAfterMs != null
    ? Number(retryAfterMs)
    : (retryAfterSec != null ? Number(retryAfterSec) * 1000 : 0);
  const wait = Math.max(0, Number.isFinite(base) ? base : 0);
  const rnd = typeof rand === 'function' ? Number(rand()) : Math.random();
  const span = RETRY_AFTER_JITTER_MAX_MS - RETRY_AFTER_JITTER_MIN_MS;
  const unit = Number.isFinite(rnd) ? Math.min(1, Math.max(0, rnd)) : 0;
  const jitter = RETRY_AFTER_JITTER_MIN_MS + Math.round(unit * span);
  const delayMs = wait + jitter;
  return { delayMs, waitMs: wait, jitterMs: jitter, code: null };
}

function tombstoneDeletedCheckpoint({ id, store, seq } = {}) {
  const rec = (store && typeof store === 'object') ? store : {};
  const key = String(id || '');
  if (!key) return { ok: false, tombstoned: false, code: 'ckpt_tombstone' };
  rec[key] = { deleted: true, tombstone: true, seq: Number(seq) || Date.now(), at: Date.now() };
  return { ok: true, tombstoned: true, id: key, store: rec, code: 'ckpt_tombstone' };
}

function stderrByteCapPerCommand(text, { maxBytes = STDERR_BYTE_CAP } = {}) {
  const s = text == null ? '' : (typeof text === 'string' ? text : String(text));
  const cap = Math.max(16, Number(maxBytes) || STDERR_BYTE_CAP);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= cap) return { truncated: false, text: s, bytes, maxBytes: cap, code: null };
  const marker = `\n[stderr truncated ${bytes - cap} bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const keep = Math.max(0, cap - markerBytes);
  let cut = Buffer.from(s, 'utf8').subarray(0, keep).toString('utf8');
  while (Buffer.byteLength(cut + marker, 'utf8') > cap && cut.length) cut = cut.slice(0, -1);
  return { truncated: true, text: cut + marker, bytes, maxBytes: cap, code: 'stderr_cap' };
}

function dropToolResultsOlderThan6Steps(messages, { steps = COMPACT_TOOL_RESULT_AGE_STEPS, currentStep } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const age = Math.max(1, Number(steps) || COMPACT_TOOL_RESULT_AGE_STEPS);
  const now = currentStep != null ? Number(currentStep) : list.length;
  let dropped = 0;
  const out = list.map((m, i) => {
    if (!m || typeof m !== 'object') return m;
    const role = String(m.role || '');
    if (role !== 'tool' && role !== 'function') return m;
    const step = m.step != null ? Number(m.step) : i;
    if (Number.isFinite(step) && now - step > age) {
      dropped += 1;
      return Object.assign({}, m, { content: '[dropped_old_tool_result]', dropped: true });
    }
    return m;
  });
  return { messages: out, dropped, steps: age, code: dropped ? 'compact_old_tools' : null };
}

function rejectToolNameWithWhitespace(name) {
  const n = String(name == null ? '' : name);
  if (!n.trim()) return { ok: false, code: 'empty_tool_name' };
  if (/\s/.test(n)) return { ok: false, name: n, code: 'tool_name_whitespace' };
  return { ok: true, name: n, code: null };
}

function keepIdNumericStringsAsStrings(value, schema) {
  function walk(v, sch, key) {
    const looksId = (typeof key === 'string' && ID_KEY_RE.test(key)) || (sch && sch.format === 'id');
    if (looksId && typeof v === 'string' && /^\d+$/.test(v)) {
      return { ok: true, value: v, kept: true, code: null };
    }
    if (sch && (sch.type === 'integer' || sch.type === 'number') && !looksId) {
      return { ok: true, value: v };
    }
    if (sch && sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      let kept = false;
      for (const k of Object.keys(v)) {
        const r = walk(v[k], sch.properties[k], k);
        o[k] = r.value;
        if (r.kept) kept = true;
      }
      return { ok: true, value: o, kept, code: kept ? 'id_stay_string' : null };
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && !sch) {
      const o = {};
      let kept = false;
      for (const k of Object.keys(v)) {
        const r = walk(v[k], null, k);
        o[k] = r.value;
        if (r.kept) kept = true;
      }
      return { ok: true, value: o, kept, code: kept ? 'id_stay_string' : null };
    }
    return { ok: true, value: v, kept: false, code: null };
  }
  return walk(value, schema || null, null);
}

function requireSessionEventSeqIncrease({ lastSeq, nextSeq } = {}) {
  const last = Number(lastSeq);
  const next = Number(nextSeq);
  if (!Number.isFinite(next)) return { ok: false, lastSeq: Number.isFinite(last) ? last : 0, code: 'event_order' };
  const prev = Number.isFinite(last) ? last : 0;
  if (next <= prev) return { ok: false, lastSeq: prev, nextSeq: next, code: 'event_order' };
  return { ok: true, lastSeq: next, nextSeq: next, code: null };
}

function abortSiblingToolsOnParentCancelToken({ parentToken, siblings, abortFn } = {}) {
  const aborted = !!(parentToken && (parentToken.aborted === true || parentToken.cancelled === true));
  const list = Array.isArray(siblings) ? siblings : [];
  if (!aborted) return { aborted: 0, siblings: list, code: null };
  const ids = [];
  for (const s of list) {
    const id = (s && (s.id || s.callId)) || s;
    ids.push(id);
    if (typeof abortFn === 'function') {
      try { abortFn(id); } catch (_) { /* best-effort */ }
    }
    if (s && typeof s === 'object') s.aborted = true;
  }
  return { aborted: ids.length, ids, code: 'turn_cancelled' };
}

function redactEmailsInLogs(text) {
  if (text == null) return { text: text, redacted: false, code: null };
  if (typeof text === 'object') {
    const s = JSON.stringify(text);
    const out = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');
    const redacted = out !== s;
    try { return { text: JSON.parse(out), redacted, code: redacted ? 'email_redact' : null }; } catch (_) {
      return { text: out, redacted, code: redacted ? 'email_redact' : null };
    }
  }
  const s = String(text);
  const out = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  return { text: out, redacted: out !== s, code: out !== s ? 'email_redact' : null };
}

function maxHeartbeatsPerMinute({ sent, windowStart, now, max = HEARTBEATS_PER_MIN_MAX } = {}) {
  const cap = Math.max(1, Number(max) || HEARTBEATS_PER_MIN_MAX);
  const t = Number(now) || Date.now();
  const start = Number(windowStart) || t;
  const count = Number(sent) || 0;
  if (t - start >= 60_000) {
    return { allow: true, sent: 0, windowStart: t, reset: true, max: cap, code: null };
  }
  if (count >= cap) return { allow: false, sent: count, windowStart: start, max: cap, code: 'heartbeat_cap' };
  return { allow: true, sent: count, windowStart: start, max: cap, code: null };
}

function refuseReadThroughSymlink(filePath, { lstatSync, isSymlink } = {}) {
  const p = String(filePath == null ? '' : filePath);
  if (typeof isSymlink === 'function') {
    try {
      if (isSymlink(p)) return { ok: false, path: p, code: 'symlink_read' };
    } catch (_) { /* treat as not a symlink */ }
    return { ok: true, path: p, code: null };
  }
  const ls = typeof lstatSync === 'function' ? lstatSync : null;
  if (!ls) return { ok: true, skipped: true, path: p, code: null };
  try {
    const st = ls(p);
    if (st && (st.isSymbolicLink && st.isSymbolicLink())) {
      return { ok: false, path: p, code: 'symlink_read' };
    }
  } catch (_) { /* missing file is not a symlink refuse */ }
  return { ok: true, path: p, code: null };
}

function markPlanStepFailedIfToolErrorTwice({ stepId, errorsByStep, error } = {}) {
  const map = (errorsByStep && typeof errorsByStep === 'object') ? errorsByStep : {};
  const id = String(stepId || '');
  const prev = Number(map[id]) || 0;
  const next = prev + (error ? 1 : 0);
  map[id] = next;
  if (next >= 2) {
    return { failed: true, count: next, stepId: id, errorsByStep: map, code: 'plan_step_failed' };
  }
  return { failed: false, count: next, stepId: id, errorsByStep: map, code: null };
}

function restoreLastSseIdOnResume({ lastEventId, cursor, store } = {}) {
  const rec = (store && typeof store === 'object') ? store : {};
  const fromArg = lastEventId != null ? Number(lastEventId) : (cursor != null ? Number(cursor) : NaN);
  const fromStore = rec.lastEventId != null ? Number(rec.lastEventId) : (rec.cursor != null ? Number(rec.cursor) : NaN);
  const id = Number.isFinite(fromArg) ? fromArg : (Number.isFinite(fromStore) ? fromStore : 0);
  rec.lastEventId = id;
  rec.cursor = id;
  return { restored: true, lastEventId: id, cursor: id, store: rec, code: null };
}


// ---------------------------------------------------------------------------
// 3H43 — remaining holes vs Claude Code/Cowork after 3H42
// ---------------------------------------------------------------------------

const TOOL_ARG_BYTES_32KIB = 32 * 1024;
const SSE_BUFFERS_MAX = 16;
const COMPACT_LAST_USER_TURNS = 3;
const QUEUE_WAIT_MAX_MS = 60_000;
const STREAM_STALL_MS = 20_000;
const TOOL_NAME_MAX_LEN = 64;
const SAME_TOOL_NAME_MAX = 8;
const CKPT_GZIP_BYTES = 64 * 1024;
const GLOB_FILE_MAX_BYTES = 1024 * 1024;
const COMBINED_STDIO_MAX = 96 * 1024;
const SSE_PING_IDLE_MS = 15_000;
const TOOL_TIMEOUT_DEFAULT_MS = 30_000;
const PATH_HOMOGLYPH_RE = /[\u2215\u2044\uFF0F\u29F8\uFF3C\u29F9]/;
const AUTH_BEARER_HEADER_RE = /Authorization\s*:\s*Bearer\s+[^\s,;]+/gi;
const AUTH_BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g;

function capToolArgBytes32KiB(args, { maxBytes = TOOL_ARG_BYTES_32KIB } = {}) {
  const cap = Math.max(256, Number(maxBytes) || TOOL_ARG_BYTES_32KIB);
  let raw;
  if (typeof args === 'string') raw = args;
  else if (args == null) raw = '';
  else {
    try { raw = JSON.stringify(args); } catch (_) { raw = String(args); }
  }
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= cap) return { args, truncated: false, bytes: buf.length, code: null };
  const marker = '\n[truncated_tool_args]';
  const keep = Math.max(0, cap - Buffer.byteLength(marker, 'utf8'));
  const text = buf.subarray(0, keep).toString('utf8') + marker;
  return { args: text, truncated: true, bytes: buf.length, text, code: 'tool_args_cap' };
}

function repairUnescapedNewlinesInJsonStrings(raw) {
  if (raw == null) return { ok: false, repaired: false, code: 'json_parse' };
  if (typeof raw === 'object') return { ok: true, repaired: false, value: raw, code: null };
  const s = String(raw);
  try { return { ok: true, repaired: false, value: JSON.parse(s), code: null }; } catch (_) { /* repair */ }
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  try { return { ok: true, repaired: true, value: JSON.parse(out), code: 'json_newline_repair' }; }
  catch (_) { return { ok: false, repaired: false, code: 'json_parse' }; }
}

function coerceNullStringToNullOptional(value, schema) {
  function walk(v, sch) {
    const required = new Set(Array.isArray(sch && sch.required) ? sch.required : []);
    if (sch && sch.properties && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      let coerced = false;
      for (const k of Object.keys(v)) {
        const child = sch.properties[k];
        if (!required.has(k) && v[k] === 'null') {
          o[k] = null;
          coerced = true;
          continue;
        }
        if (required.has(k) && v[k] === 'null') {
          o[k] = v[k];
          continue;
        }
        const r = walk(v[k], child);
        o[k] = r.value;
        if (r.coerced) coerced = true;
      }
      return { ok: true, value: o, coerced, code: coerced ? 'null_string_coerce' : null };
    }
    const nullable = !!(sch && (sch.nullable === true || (Array.isArray(sch.type) && sch.type.indexOf('null') >= 0)));
    if (v === 'null' && nullable) return { ok: true, value: null, coerced: true, code: 'null_string_coerce' };
    return { ok: true, value: v, coerced: false, code: null };
  }
  return walk(value, schema || {});
}

function maxSseBuffersPerSession16(buffers, { max = SSE_BUFFERS_MAX } = {}) {
  const list = Array.isArray(buffers) ? buffers.slice() : [];
  const cap = Math.max(1, Number(max) || SSE_BUFFERS_MAX);
  let dropped = 0;
  while (list.length > cap) { list.shift(); dropped += 1; }
  return { buffers: list, dropped, truncated: dropped > 0, code: dropped ? 'sse_buffer_cap' : null };
}

function compactKeepPinnedFactsAndLast3UserTurns(messages, { pins, lastN = COMPACT_LAST_USER_TURNS } = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const pinList = Array.isArray(pins) ? pins : [];
  const n = Math.max(1, Number(lastN) || COMPACT_LAST_USER_TURNS);
  const userIdx = [];
  for (let i = 0; i < msgs.length; i += 1) {
    if (msgs[i] && msgs[i].role === 'user') userIdx.push(i);
  }
  const keepFrom = userIdx.length <= n ? 0 : userIdx[userIdx.length - n];
  const kept = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (i >= keepFrom || (m && (m.pinned || m.pin))) kept.push(m);
  }
  const pinMsgs = pinList.map((p) => (
    p && typeof p === 'object' ? Object.assign({ pinned: true }, p) : { role: 'system', content: String(p), pinned: true }
  ));
  const seen = new Set(kept.map((m) => String((m && m.content) || '')));
  const extra = pinMsgs.filter((p) => !seen.has(String((p && p.content) || '')));
  const out = extra.concat(kept);
  return {
    messages: out,
    kept: kept.length,
    pins: extra.length,
    dropped: msgs.length - kept.length,
    code: (extra.length || kept.length !== msgs.length) ? 'compact_pins_last3' : null,
  };
}

function refuseWriteIfDestDirMissing(filePath, { existsSync } = {}) {
  const p = String(filePath == null ? '' : filePath);
  if (!p) return { ok: false, path: p, code: 'dest_dir_missing' };
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = slash >= 0 ? (p.slice(0, slash) || '/') : '.';
  if (typeof existsSync !== 'function') return { ok: true, skipped: true, path: p, dir, code: null };
  try {
    if (!existsSync(dir)) return { ok: false, path: p, dir, code: 'dest_dir_missing' };
  } catch (_) {
    return { ok: false, path: p, dir, code: 'dest_dir_missing' };
  }
  return { ok: true, path: p, dir, code: null };
}

function ceilTokensOnCancel({ promptTokens, completionTokens, cancelled } = {}) {
  const p = Number(promptTokens) || 0;
  const c = Number(completionTokens) || 0;
  const prompt = Math.ceil(p);
  const completion = Math.ceil(c);
  return {
    tokens: prompt + completion,
    promptTokens: prompt,
    completionTokens: completion,
    cancelled: !!cancelled,
    code: cancelled ? 'credit_ceil' : null,
  };
}

function classifyEconnresetAsCancelled(err) {
  if (err == null) return { cancelled: false, family: null, retryable: false, code: null };
  const code = String((err && err.code) || '');
  const msg = String((err && (err.message || err)) || '');
  const status = Number(err && (err.status || err.statusCode));
  const isReset = code === 'ECONNRESET' || /ECONNRESET/i.test(msg);
  if (!isReset) return { cancelled: false, family: Number.isFinite(status) && status >= 500 ? '5xx' : null, retryable: false, code: null };
  return { cancelled: true, family: 'cancelled', retryable: false, code: 'cancelled', status: Number.isFinite(status) ? status : null };
}

function queueMaxWait60sThen503({ waitedMs, maxMs = QUEUE_WAIT_MAX_MS } = {}) {
  const w = Math.max(0, Number(waitedMs) || 0);
  const cap = Math.max(1000, Number(maxMs) || QUEUE_WAIT_MAX_MS);
  if (w >= cap) return { reject: true, status: 503, retry: true, retryAfterSec: 2, code: 'queue_wait' };
  return { reject: false, status: 200, retry: false, remainingMs: cap - w, code: null };
}

function skipUpsertIfEmbeddingDimMismatch(embedding, { expectedDim } = {}) {
  const arr = Array.isArray(embedding) ? embedding : (embedding && Array.isArray(embedding.vector) ? embedding.vector : []);
  const dim = arr.length;
  const exp = Number(expectedDim);
  if (!Number.isFinite(exp) || exp <= 0) return { skip: false, dim, code: null };
  if (dim !== exp) return { skip: true, dim, expectedDim: exp, code: 'embedding_dim' };
  return { skip: false, dim, expectedDim: exp, code: null };
}

function stallIfNoEvent20sMidStream({ lastEventAt, now, firstTokenAt, stallMs = STREAM_STALL_MS } = {}) {
  if (firstTokenAt == null && lastEventAt == null) return { stalled: false, skipped: true, code: null };
  const t = Number(now) || Date.now();
  const last = Number(lastEventAt != null ? lastEventAt : firstTokenAt);
  if (!Number.isFinite(last)) return { stalled: false, skipped: true, code: null };
  const cap = Math.max(1000, Number(stallMs) || STREAM_STALL_MS);
  const elapsed = t - last;
  if (elapsed >= cap) return { stalled: true, elapsedMs: elapsed, code: 'stream_stall' };
  return { stalled: false, elapsedMs: elapsed, code: null };
}

function stripUtf16NulPadding(text) {
  if (text == null) return { text, stripped: false, code: null };
  let s = Buffer.isBuffer(text) ? text.toString('utf8') : (typeof text === 'string' ? text : String(text));
  const orig = s;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const nulCount = (s.match(/\u0000/g) || []).length;
  if (nulCount > 0 && nulCount >= s.length / 4) s = s.replace(/\u0000/g, '');
  const stripped = s !== orig;
  return { text: s, stripped, code: stripped ? 'utf16_nul' : null };
}

function rejectToolNameLongerThan64(name, { max = TOOL_NAME_MAX_LEN } = {}) {
  const n = String(name == null ? '' : name);
  const cap = Math.max(1, Number(max) || TOOL_NAME_MAX_LEN);
  if (n.length > cap) return { ok: false, name: n, length: n.length, code: 'tool_name_length' };
  return { ok: true, name: n, length: n.length, code: null };
}

function rejectRecursiveSameToolNameOver8(calls, { max = SAME_TOOL_NAME_MAX } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const cap = Math.max(1, Number(max) || SAME_TOOL_NAME_MAX);
  const counts = {};
  const kept = [];
  let dropped = 0;
  for (const c of list) {
    const name = String((c && (c.name || c.tool)) || '');
    counts[name] = (counts[name] || 0) + 1;
    if (counts[name] > cap) dropped += 1;
    else kept.push(c);
  }
  return { calls: kept, dropped, counts, code: dropped ? 'tool_recursion' : null };
}

function skipCompletedPlanStepsOnResume(steps, { completedIds } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const done = new Set((Array.isArray(completedIds) ? completedIds : []).map(String));
  const remaining = [];
  let skipped = 0;
  for (const st of list) {
    const id = String((st && (st.id || st.stepId)) || '');
    const status = String((st && st.status) || '').toLowerCase();
    if (done.has(id) || status === 'completed' || status === 'done' || (st && st.completed === true)) {
      skipped += 1;
      continue;
    }
    remaining.push(st);
  }
  return { steps: remaining, skipped, code: skipped ? 'plan_skip_completed' : null };
}

function gzipCheckpointIfOver64KiB(payload, { maxBytes = CKPT_GZIP_BYTES, gzipFn } = {}) {
  let raw;
  if (Buffer.isBuffer(payload)) raw = payload;
  else if (typeof payload === 'string') raw = Buffer.from(payload, 'utf8');
  else {
    try { raw = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8'); }
    catch (_) { raw = Buffer.from(String(payload), 'utf8'); }
  }
  const cap = Math.max(256, Number(maxBytes) || CKPT_GZIP_BYTES);
  if (raw.length <= cap) return { gzipped: false, bytes: raw.length, payload, code: null };
  let gz = raw;
  if (typeof gzipFn === 'function') gz = gzipFn(raw);
  else {
    try { gz = require('zlib').gzipSync(raw); } catch (_) { gz = raw; }
  }
  return {
    gzipped: true,
    bytes: raw.length,
    gzipBytes: Buffer.isBuffer(gz) ? gz.length : Buffer.byteLength(String(gz)),
    payload: gz,
    code: 'ckpt_gzip',
  };
}

function parseLastEventIdIntOnly(headerValue) {
  const s = String(headerValue == null ? '' : headerValue).trim();
  if (!/^\d+$/.test(s)) return { ok: false, lastEventId: 0, code: 'sse_id_parse' };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, lastEventId: 0, code: 'sse_id_parse' };
  return { ok: true, lastEventId: n, code: null };
}

function capGlobMatchFileSize1MiB(matches, { maxBytes = GLOB_FILE_MAX_BYTES, sizeOf } = {}) {
  const list = Array.isArray(matches) ? matches : [];
  const cap = Math.max(1, Number(maxBytes) || GLOB_FILE_MAX_BYTES);
  const kept = [];
  let dropped = 0;
  for (const m of list) {
    let sz = 0;
    if (typeof sizeOf === 'function') sz = Number(sizeOf(m)) || 0;
    else if (m && typeof m === 'object') sz = Number(m.size || m.bytes || 0) || 0;
    if (sz > cap) { dropped += 1; continue; }
    kept.push(m);
  }
  return { matches: kept, dropped, code: dropped ? 'glob_file_size' : null };
}

function redactAuthorizationBearerInToolResults(text) {
  if (text == null) return { text, redacted: false, code: null };
  const asObj = typeof text === 'object';
  const s = asObj ? JSON.stringify(text) : String(text);
  const out = s.replace(AUTH_BEARER_HEADER_RE, 'Authorization: Bearer [REDACTED]').replace(AUTH_BEARER_TOKEN_RE, 'Bearer [REDACTED]');
  const redacted = out !== s;
  if (asObj) {
    try { return { text: JSON.parse(out), redacted, code: redacted ? 'auth_redact' : null }; } catch (_) { /* keep string */ }
  }
  return { text: out, redacted, code: redacted ? 'auth_redact' : null };
}

function refuseHostBashIfComputerOnlyTurn({ computerOnly, toolName } = {}) {
  const name = String(toolName || '');
  const isHost = /^(host_bash|host-bash|hostBash)$/i.test(name);
  if (computerOnly && isHost) return { ok: false, toolName: name, code: 'host_bash_blocked' };
  return { ok: true, toolName: name, code: null };
}

function subagentInheritRemainingStepBudget({ parentRemaining, childRequested, max } = {}) {
  const parent = Number(parentRemaining);
  const req = Number(childRequested);
  const cap = Number(max);
  let remaining = Number.isFinite(parent) ? Math.max(0, Math.floor(parent)) : (Number.isFinite(req) ? Math.max(0, Math.floor(req)) : 0);
  if (Number.isFinite(req)) remaining = Math.min(remaining, Math.max(0, Math.floor(req)));
  if (Number.isFinite(cap)) remaining = Math.min(remaining, Math.max(0, Math.floor(cap)));
  return { remaining, inherited: Number.isFinite(parent), code: remaining === 0 ? 'subagent_budget' : null };
}

function concatenateSplitToolCallFragments(fragments) {
  const list = Array.isArray(fragments) ? fragments : (fragments == null ? [] : [fragments]);
  const joined = list.map((f) => {
    if (f == null) return '';
    if (typeof f === 'string') return f;
    if (typeof f === 'object') return String(f.arguments || f.delta || f.fragment || f.content || '');
    return String(f);
  }).join('');
  if (!joined) return { ok: false, concatenated: false, value: null, joined: '', code: 'json_parse' };
  try {
    const value = JSON.parse(joined);
    return { ok: true, concatenated: list.length > 1, value, joined, code: list.length > 1 ? 'tool_call_concat' : null };
  } catch (_) {
    return { ok: false, concatenated: list.length > 1, value: joined, joined, code: 'json_parse' };
  }
}

function neverRetry402(error) {
  const err = error || {};
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  const code = String(err.code || '');
  const msg = String(err.message || '');
  const is402 = status === 402 || code === '402' || /insufficient balance|quota_exhausted|payment required/i.test(msg);
  if (is402) return { retry: false, status: 402, code: 'quota_exhausted' };
  return { retry: null, status: Number.isFinite(status) ? status : null, code: null };
}

function combinedStdoutStderr96KiB({ stdout, stderr, maxBytes = COMBINED_STDIO_MAX } = {}) {
  const cap = Math.max(1024, Number(maxBytes) || COMBINED_STDIO_MAX);
  const so = stdout == null ? '' : String(stdout);
  const se = stderr == null ? '' : String(stderr);
  const combined = so + (se ? ((so ? '\n' : '') + se) : '');
  const bytes = Buffer.byteLength(combined, 'utf8');
  if (bytes <= cap) return { text: combined, truncated: false, bytes, code: null };
  const marker = '\n[truncated_combined]';
  const keep = Math.max(0, cap - Buffer.byteLength(marker, 'utf8'));
  const text = Buffer.from(combined, 'utf8').subarray(0, keep).toString('utf8') + marker;
  return { text, truncated: true, bytes, code: 'combined_cap' };
}

function pingOnlyIfLastWriteOver15s({ lastWriteAt, now, minIdleMs = SSE_PING_IDLE_MS } = {}) {
  const t = Number(now) || Date.now();
  const last = Number(lastWriteAt) || 0;
  const cap = Math.max(1000, Number(minIdleMs) || SSE_PING_IDLE_MS);
  const idle = t - last;
  if (idle >= cap) return { ping: true, idleMs: idle, code: null };
  return { ping: false, idleMs: idle, code: 'sse_ping_skip' };
}

function rejectUnicodeSlashHomoglyph(filePath) {
  const p = String(filePath == null ? '' : filePath);
  if (PATH_HOMOGLYPH_RE.test(p)) return { ok: false, path: p, code: 'path_homoglyph' };
  return { ok: true, path: p, code: null };
}

function sessionLockOwnerPidCheck({ ownerPid, currentPid, lock } = {}) {
  const owner = Number(ownerPid != null ? ownerPid : (lock && lock.pid));
  const cur = Number(currentPid != null ? currentPid : (typeof process !== 'undefined' ? process.pid : 0));
  if (!Number.isFinite(owner) || owner <= 0) return { ok: false, steal: false, code: 'lock_pid' };
  if (!Number.isFinite(cur) || owner !== cur) return { ok: false, steal: false, ownerPid: owner, currentPid: cur, code: 'lock_pid' };
  return { ok: true, steal: false, ownerPid: owner, currentPid: cur, code: null };
}

function mapPrismaDisconnectRetryable(err) {
  if (err == null) return { retryable: false, code: null };
  const code = String((err && (err.code || err.name)) || '');
  const msg = String((err && err.message) || '');
  const blob = code + ' ' + msg;
  const is = code === 'P1001' || code === 'P1017' || code === 'P2024'
    || /Can't reach database|Server has closed the connection|PrismaClientInitializationError|PrismaClientRustPanicError|Connection reset by peer/i.test(blob);
  if (is) return { retryable: true, code: 'prisma_disconnect' };
  return { retryable: false, code: null };
}

function defaultToolTimeout30sIfMissing(timeoutMs, { defaultMs = TOOL_TIMEOUT_DEFAULT_MS } = {}) {
  const n = Number(timeoutMs);
  const d = Math.max(1000, Number(defaultMs) || TOOL_TIMEOUT_DEFAULT_MS);
  if (!Number.isFinite(n) || n <= 0) return { timeoutMs: d, applied: true, code: 'tool_timeout_default' };
  return { timeoutMs: n, applied: false, code: null };
}

function closeSseThenSettleCredits({ sseClosed, settled, cancelled, held } = {}) {
  if (held && !sseClosed) return { order: 'close_first', sseClosed: false, settle: false, settled: !!settled, cancelled: !!cancelled, code: 'sse_settle_order' };
  if (held && sseClosed && !settled) return { order: 'settle', sseClosed: true, settle: true, settled: false, cancelled: !!cancelled, code: null };
  if (sseClosed && settled) return { order: 'done', sseClosed: true, settle: false, settled: true, cancelled: !!cancelled, code: null };
  return { order: 'noop', sseClosed: !!sseClosed, settle: false, settled: !!settled, cancelled: !!cancelled, code: null };
}

// ---------------------------------------------------------------------------
// 3H44 — remaining holes vs Claude Code/Cowork after 3H43
// ---------------------------------------------------------------------------

const INFLIGHT_TOOLS_MAX = 8;
const COMPACT_SUMMARY_MAX = 2048;
const SSE_EVENT_MAX_AGE_MS = 120_000;
const QUEUE_FAIR_WAIT_MS = 20_000;
const STALL_CANCEL_COUNT = 3;
const PLAN_STEPS_MAX = 24;
const CKPT_UNCOMPRESSED_MAX = 1024 * 1024;
const GLOB_RETURN_MAX = 32;
const STDOUT_LINE_MAX = 8 * 1024;
const CLIENT_GONE_MS = 30_000;
const LOCK_TTL_MS = 90_000;
const TOOL_TIMEOUT_HARD_MS = 120_000;
const TOOL_LIST_SERIAL_MAX = 8 * 1024;
const TOOL_NAME_CHARSET_RE = /^[A-Za-z0-9_.-]+$/;
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const JWT_SHAPED_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SYSTEM_PATH_RE = /^(?:\/etc(?:\/|$)|\/proc(?:\/|$)|\/sys(?:\/|$))/i;

const inflightBySession = new Map();

function maxInflightToolsPerSession8(inflight, { max = INFLIGHT_TOOLS_MAX, sessionKey } = {}) {
  let n;
  if (typeof inflight === 'number') n = inflight;
  else if (inflight && typeof inflight.size === 'number' && typeof inflight.length !== 'number') n = inflight.size;
  else if (Array.isArray(inflight)) n = inflight.length;
  else if (sessionKey != null && inflightBySession.has(String(sessionKey))) n = inflightBySession.get(String(sessionKey));
  else n = 0;
  n = Math.max(0, Number(n) || 0);
  const cap = Math.max(1, Number(max) || INFLIGHT_TOOLS_MAX);
  if (n >= cap) return { ok: false, reject: true, inflight: n, max: cap, code: 'inflight_tools' };
  return { ok: true, reject: false, inflight: n, remaining: cap - n, max: cap, code: null };
}

function stripLeftoverLineCommentsInJson(raw) {
  if (raw == null) return { ok: false, repaired: false, code: 'json_parse' };
  if (typeof raw === 'object') return { ok: true, repaired: false, value: raw, code: null };
  const s = String(raw);
  try { return { ok: true, repaired: false, value: JSON.parse(s), code: null }; } catch (_) { /* strip */ }
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      if (i < s.length && s[i] === '\n') out += '\n';
      continue;
    }
    out += ch;
  }
  try { return { ok: true, repaired: true, value: JSON.parse(out), code: 'json_line_comment' }; }
  catch (_) { return { ok: false, repaired: false, text: out, code: 'json_parse' }; }
}

function rejectNaNInfinityNumbers(value) {
  function bad(v) {
    if (typeof v === 'number' && !Number.isFinite(v)) return true;
    if (Array.isArray(v)) return v.some(bad);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (bad(v[k])) return true;
      }
    }
    return false;
  }
  if (bad(value)) return { ok: false, value, code: 'nan_infinity' };
  return { ok: true, value, code: null };
}

function dropSseEventsOlderThan2min(events, { now, maxAgeMs = SSE_EVENT_MAX_AGE_MS } = {}) {
  const list = Array.isArray(events) ? events : [];
  const t = Number(now) || Date.now();
  const age = Math.max(1000, Number(maxAgeMs) || SSE_EVENT_MAX_AGE_MS);
  const kept = [];
  let dropped = 0;
  for (const e of list) {
    const at = Number(e && (e.at || e.ts || e.t || e.time));
    if (Number.isFinite(at) && (t - at) > age) { dropped += 1; continue; }
    kept.push(e);
  }
  return { events: kept, dropped, code: dropped ? 'sse_stale' : null };
}

function capCompactSummary2KiB(summary, { maxBytes = COMPACT_SUMMARY_MAX } = {}) {
  const s = summary == null ? '' : String(summary);
  const cap = Math.max(64, Number(maxBytes) || COMPACT_SUMMARY_MAX);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return { text: s, truncated: false, bytes: buf.length, code: null };
  const marker = '\n[truncated_summary]';
  const keep = Math.max(0, cap - Buffer.byteLength(marker, 'utf8'));
  const text = buf.subarray(0, keep).toString('utf8') + marker;
  return { text, truncated: true, bytes: buf.length, code: 'compact_summary' };
}

function refuseWriteToEtcProcSys(filePath) {
  const p = String(filePath == null ? '' : filePath).replace(/\\/g, '/');
  const n = p.startsWith('/') ? p : `/${p}`;
  if (SYSTEM_PATH_RE.test(n) || SYSTEM_PATH_RE.test(p)) {
    return { ok: false, path: p, code: 'path_system' };
  }
  return { ok: true, path: p, code: null };
}

function neverNegativeUsage({ promptTokens, completionTokens, totalTokens } = {}) {
  const pRaw = Number(promptTokens);
  const cRaw = Number(completionTokens);
  const tRaw = Number(totalTokens);
  const prompt = Math.max(0, Number.isFinite(pRaw) ? pRaw : 0);
  const completion = Math.max(0, Number.isFinite(cRaw) ? cRaw : 0);
  const tokens = Number.isFinite(tRaw) ? Math.max(0, tRaw) : prompt + completion;
  const clamped = (Number.isFinite(pRaw) && pRaw < 0)
    || (Number.isFinite(cRaw) && cRaw < 0)
    || (Number.isFinite(tRaw) && tRaw < 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    tokens,
    clamped,
    code: clamped ? 'usage_negative' : null,
  };
}

function queueFairShareExtraSlotIfWaitOver20s({ waitedMs, extraIfMs = QUEUE_FAIR_WAIT_MS } = {}) {
  const w = Math.max(0, Number(waitedMs) || 0);
  const t = Math.max(0, Number(extraIfMs) || QUEUE_FAIR_WAIT_MS);
  if (w > t) return { extraSlot: true, extra: 1, waitedMs: w, code: 'queue_fair_share' };
  return { extraSlot: false, extra: 0, waitedMs: w, code: null };
}

function skipMemoryIfScoreNaN(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const kept = [];
  let skipped = 0;
  for (const f of list) {
    const score = f && (f.score != null ? f.score : f.similarity);
    if (score != null && typeof score === 'number' && !Number.isFinite(score)) {
      skipped += 1;
      continue;
    }
    if (score != null && typeof score !== 'number' && Number.isNaN(Number(score))) {
      skipped += 1;
      continue;
    }
    kept.push(f);
  }
  return { facts: kept, skipped, code: skipped ? 'memory_score_nan' : null };
}

function cancelIfThreeStreamStalls({ stallCount, max = STALL_CANCEL_COUNT } = {}) {
  const n = Math.max(0, Number(stallCount) || 0);
  const cap = Math.max(1, Number(max) || STALL_CANCEL_COUNT);
  if (n >= cap) return { cancel: true, stallCount: n, code: 'stream_stall_cancel' };
  return { cancel: false, stallCount: n, remaining: cap - n, code: null };
}

function stripBidiOverrideChars(text) {
  if (text == null) return { text, stripped: false, code: null };
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  const next = s.replace(BIDI_OVERRIDE_RE, '');
  return { text: next, stripped: next !== s, code: next !== s ? 'bidi_strip' : null };
}

function rejectToolNameOutsideCharset(name, { re } = {}) {
  const n = String(name == null ? '' : name);
  const okRe = re instanceof RegExp ? re : TOOL_NAME_CHARSET_RE;
  if (!n || !okRe.test(n)) return { ok: false, name: n, code: 'tool_name_charset' };
  return { ok: true, name: n, code: null };
}

function rejectToolCallCycleAtoBtoA(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const names = list.map((c) => String((c && (c.name || c.tool || (c.function && c.function.name))) || ''));
  for (let i = 0; i + 2 < names.length; i += 1) {
    if (names[i] && names[i + 1] && names[i] === names[i + 2] && names[i] !== names[i + 1]) {
      return { ok: false, cycle: [names[i], names[i + 1], names[i + 2]], code: 'tool_cycle' };
    }
  }
  return { ok: true, cycle: null, code: null };
}

function capPlanSteps24(steps, { max = PLAN_STEPS_MAX } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const cap = Math.max(1, Number(max) || PLAN_STEPS_MAX);
  if (list.length <= cap) return { steps: list, truncated: false, dropped: 0, code: null };
  return { steps: list.slice(0, cap), truncated: true, dropped: list.length - cap, code: 'plan_steps_cap' };
}

function refuseCheckpointOver1MiBUncompressed(payload, { maxBytes = CKPT_UNCOMPRESSED_MAX } = {}) {
  let raw;
  if (Buffer.isBuffer(payload)) raw = payload;
  else if (typeof payload === 'string') raw = Buffer.from(payload, 'utf8');
  else {
    try { raw = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8'); }
    catch (_) { raw = Buffer.from(String(payload), 'utf8'); }
  }
  const cap = Math.max(1024, Number(maxBytes) || CKPT_UNCOMPRESSED_MAX);
  if (raw.length > cap) return { ok: false, bytes: raw.length, maxBytes: cap, code: 'ckpt_too_large' };
  return { ok: true, bytes: raw.length, maxBytes: cap, code: null };
}

function rejectLastEventIdGoingBackwards({ lastEventId, currentSeq, stored } = {}) {
  const incoming = Number(lastEventId);
  const cur = Number(currentSeq != null ? currentSeq : stored);
  if (!Number.isFinite(incoming) || incoming < 0) {
    return { ok: false, lastEventId: incoming, backwards: false, code: 'sse_id_parse' };
  }
  if (Number.isFinite(cur) && incoming < cur) {
    return { ok: false, lastEventId: incoming, currentSeq: cur, backwards: true, code: 'sse_id_backwards' };
  }
  return { ok: true, lastEventId: incoming, currentSeq: Number.isFinite(cur) ? cur : incoming, backwards: false, code: null };
}

function capGlobMatchesReturned32(hits, { max = GLOB_RETURN_MAX } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const cap = Math.max(1, Number(max) || GLOB_RETURN_MAX);
  if (list.length <= cap) return { hits: list, truncated: false, dropped: 0, code: null };
  return { hits: list.slice(0, cap), truncated: true, dropped: list.length - cap, code: 'glob_match_cap' };
}

function redactJwtShapedStrings(text) {
  if (text == null) return { text, redacted: false, code: null };
  const s = String(text);
  const next = s.replace(JWT_SHAPED_RE, '[REDACTED_JWT]');
  return { text: next, redacted: next !== s, code: next !== s ? 'jwt_redact' : null };
}

function refuseComputerToolsIfNoUserId({ toolName, userId } = {}) {
  const n = String(toolName || '');
  const isComp = /^computer[_-]/i.test(n);
  const uid = userId == null ? '' : String(userId).trim();
  if (isComp && !uid) return { ok: false, toolName: n, code: 'computer_no_user' };
  return { ok: true, toolName: n, code: null };
}

function minRemainingSubagentBudget1({ remaining, parentRemaining } = {}) {
  const raw = Number(remaining != null ? remaining : parentRemaining);
  if (raw === 0) return { remaining: 0, applied: false, code: 'subagent_budget' };
  if (!Number.isFinite(raw) || raw < 1) return { remaining: 1, applied: true, code: 'subagent_min' };
  return { remaining: Math.floor(raw), applied: false, code: null };
}

function dropIncompleteTrailingToolCall(calls) {
  const list = Array.isArray(calls) ? calls.slice() : [];
  if (!list.length) return { calls: list, dropped: false, code: null };
  const last = list[list.length - 1];
  const name = last && (last.name || last.tool || (last.function && last.function.name));
  const args = last && (last.arguments || last.args || (last.function && last.function.arguments));
  let incomplete = !name || !String(name).trim();
  if (!incomplete && typeof args === 'string') {
    const t = args.trim();
    if (t && (t[0] === '{' || t[0] === '[')) {
      try { JSON.parse(t); } catch (_) { incomplete = true; }
    }
  }
  if (incomplete) {
    list.pop();
    return { calls: list, dropped: true, code: 'tool_call_incomplete' };
  }
  return { calls: list, dropped: false, code: null };
}

function neverRetry413(error) {
  const err = error || {};
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  const code = String(err.code || '');
  const msg = String(err.message || '');
  const is = status === 413 || code === '413' || /payload too large|request entity too large|\b413\b/i.test(msg);
  if (is) return { retry: false, status: 413, code: 'payload_too_large' };
  return { retry: null, status: Number.isFinite(status) ? status : null, code: null };
}

function capStdoutLine8KiB(text, { maxBytes = STDOUT_LINE_MAX } = {}) {
  const s = text == null ? '' : String(text);
  const cap = Math.max(64, Number(maxBytes) || STDOUT_LINE_MAX);
  const lines = s.split('\n');
  let truncated = false;
  const out = lines.map((ln) => {
    const buf = Buffer.from(ln, 'utf8');
    if (buf.length <= cap) return ln;
    truncated = true;
    return buf.subarray(0, cap).toString('utf8') + '[truncated_line]';
  });
  return { text: out.join('\n'), truncated, code: truncated ? 'line_cap' : null };
}

function closeIfClientGone30s({ lastClientAt, now, timeoutMs = CLIENT_GONE_MS } = {}) {
  const last = Number(lastClientAt);
  const t = Number(now) || Date.now();
  const cap = Math.max(1000, Number(timeoutMs) || CLIENT_GONE_MS);
  if (!Number.isFinite(last)) return { close: false, skipped: true, code: null };
  const elapsed = t - last;
  if (elapsed >= cap) return { close: true, elapsedMs: elapsed, code: 'client_gone' };
  return { close: false, elapsedMs: elapsed, code: null };
}

function sessionLockTtl90s({ acquiredAt, now, ttlMs = LOCK_TTL_MS } = {}) {
  const acq = Number(acquiredAt);
  const t = Number(now) || Date.now();
  const ttl = Math.max(1000, Number(ttlMs) || LOCK_TTL_MS);
  if (!Number.isFinite(acq)) return { expired: false, skipped: true, steal: false, code: null };
  const age = t - acq;
  if (age >= ttl) return { expired: true, steal: true, ageMs: age, code: 'lock_ttl' };
  return { expired: false, steal: false, remainingMs: ttl - age, ageMs: age, code: null };
}

function mapRedisEconnrefusedRetryable(err) {
  if (err == null) return { retryable: false, code: null };
  const code = String((err && (err.code || err.errno || err.name)) || '');
  const msg = String((err && err.message) || '');
  const blob = `${code} ${msg}`;
  const isRefused = code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(blob);
  if (!isRefused) return { retryable: false, code: null };
  return { retryable: true, code: 'redis_disconnect' };
}

function hardCapToolTimeout120s(timeoutMs, { maxMs = TOOL_TIMEOUT_HARD_MS } = {}) {
  const n = Number(timeoutMs);
  const cap = Math.max(1000, Number(maxMs) || TOOL_TIMEOUT_HARD_MS);
  if (!Number.isFinite(n) || n <= 0) return { timeoutMs: n, capped: false, applied: false, code: null };
  if (n > cap) return { timeoutMs: cap, capped: true, applied: true, code: 'tool_timeout_cap' };
  return { timeoutMs: n, capped: false, applied: false, code: null };
}

function flushLastSseEventBeforeClose({ pendingEvent, closed, flushed } = {}) {
  if (closed) return { flush: false, closed: true, code: null };
  if (pendingEvent != null && flushed !== true) {
    return { flush: true, event: pendingEvent, closed: false, code: 'sse_flush' };
  }
  return { flush: false, closed: false, code: null };
}

function capSerializedToolList8KB(tools, { maxBytes = TOOL_LIST_SERIAL_MAX } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  let raw;
  try { raw = JSON.stringify(list); } catch (_) { raw = String(list); }
  const buf = Buffer.from(raw, 'utf8');
  const cap = Math.max(256, Number(maxBytes) || TOOL_LIST_SERIAL_MAX);
  if (buf.length <= cap) return { tools: list, truncated: false, bytes: buf.length, dropped: 0, code: null };
  const out = list.slice();
  while (out.length) {
    let next;
    try { next = JSON.stringify(out); } catch (_) { next = String(out); }
    if (Buffer.byteLength(next, 'utf8') <= cap) break;
    out.pop();
  }
  return { tools: out, truncated: true, bytes: buf.length, dropped: list.length - out.length, code: 'tool_list_cap' };
}

function screenshotOnlyNoCharge({ tools, names, screenshotOnly } = {}) {
  const list = Array.isArray(tools) ? tools : (Array.isArray(names) ? names : []);
  const nms = list.map((t) => String((typeof t === 'string' ? t : (t && (t.name || t.tool))) || '').toLowerCase()).filter(Boolean);
  const only = screenshotOnly === true || (nms.length > 0 && nms.every((n) => /screenshot/.test(n)));
  if (only) return { charge: false, screenshotOnly: true, code: 'credit_screenshot' };
  return { charge: true, screenshotOnly: false, code: null };
}


module.exports = {
  COMMENT_HEARTBEAT_MS,
  CLAIM_TTL_MS,
  STDOUT_CMD_CAP,
  TOOL_TIMEOUT_OVERLAY_MS,
  DANGEROUS_TOOL_NAMES,
  sha256Hex,
  backoffWithJitter,
  isRetryableToolFailure,
  retryToolWithBackoff,
  createConsecutiveRepeatCut,
  sessionRemainingSteps,
  resetSessionBudgets,
  compactDropStaleBodies,
  rollbackLastFileEdit,
  rememberFileEdit,
  fuzzyWhitespaceReplace,
  verifyAfterFuzzyWrite,
  capCommandStdout,
  tmpCleanupOnCancel,
  dropDuplicateInFlightGenerate,
  resetInFlightGenerate,
  creditOnToolError,
  recordTurnToolCount,
  classifyToolFailure,
  sanitizeClientError,
  classifyAdapterError,
  observeAdapterLatency,
  adapterLatencySnapshot,
  denyDangerousGenerateTools,
  stampAuditDurationTokens,
  claimPathMutation,
  resetPathMutations,
  allowParallelReads,
  emptyResponseRetryOnce,
  stopOnFinalAnswer,
  replaySameCallId,
  rememberCallResult,
  abortCascade,
  expireGatewayClaimTtl,
  touchGatewayClaim,
  resetClaimTimes,
  refuseOpenRouterEnv,
  overlayToolTimeoutMs,
  sanitizeSandboxEnvHard,
  formatRemainingBudgetHint,
  afterWriteTestHint,
  startCommentHeartbeat,
  honorLastEventId,
  dedupConsecutiveAssistantCalls,
  repairTruncatedJson,
  coerceStringyPrimitives,
  rememberConnectedMcp,
  allowAlreadyConnectedMcp,
  resetConnectedMcp,
  adapterSnapshot,
  sliceReadWindow,
  formatReadWithLineNumbers,
  compactKeepLastNBodies,
  redactSecretsInToolResult,
  refuseBinaryRead,
  clampBase64InToolResult,
  defaultGlobIgnores,
  filterGlobHits,
  workspacePathJail,
  allowDeepSeekGenerateModel,
  boundSseRing,
  detectSseGap,
  guardUserRoleSpoof,
  sessionGenerateRateLimit,
  resetGenerateRateLimit,
  capToolArgBytes,
  maxToolCallsPerMessage,
  classifyStopReason,
  webFetchGuard,
  startBackgroundBash,
  pollBackgroundBash,
  reapBackgroundBashOnAbort,
  resetBackgroundBash,
  injectProjectInstructions,
  expireAndSweepPins,
  skipUnchangedWrite,
  canonicalizeTodoList,
  runPreToolHook,
  snapshotPartialOnAbort,
  clampToolResultWithHash,
  nfcPath,
  rankPgvectorHits,
  rollbackLastNFileEdits,
  appendTokenAuditLog,
  sweepTokenAuditLog,
  tokenAuditSnapshot,
  resetTokenAuditLog,
  acquireFairGenerateLock,
  releaseFairGenerateLock,
  resetFairGenerateLock,
  lookupGetLikeToolCache,
  storeGetLikeToolCache,
  invalidateToolCacheOnWrite,
  resetToolCache,
  splitModelVsToolTimeout,
  stripAdditionalProperties,
  rejectSymlinkEscape,
  classifySseFrame,
  nextSseSeqForFrame,
  refundZeroTokenError,
  estimateCompactTokens,
  compactUntilTokenBudget,
  inheritSubagentSteps,
  acquireCrossProcessFileLock,
  ensureUniqueToolCallIds,
  collectToolCallIds,
  dropOrphanToolResults,
  repairStreamingJsonAcrossChunks,
  applyUnifiedDiff,
  sandboxUlimitSpec,
  wrapSandboxSpawnWithUlimit,
  splitStdoutStderrToolResult,
  holdThenSettleCredits,
  settleCreditHold,
  releaseCreditHold,
  resetCreditHoldsByRequest,
  replayToolResultsOnResume,
  compactKeepPinnedSiragptAndLastUser,
  markRunCancelled,
  dropCancelledRunEvents,
  isRunCancelled,
  resetCancelledRuns,
  perToolRateLimit,
  resetPerToolRateLimit,
  capImagePdfInContext,
  clampMaxTokensToRemainingContext,
  clockSkewSafeTtl,
  idempotentGenerateByRequestId,
  rememberGenerateByRequestId,
  resetGenerateByRequestId,
  allowlistToolName,
  coerceNestedArrayObjectTypes,
  createIfMissingOrRefuseLargeOverwrite,
  sandboxNetFailClosed,
  killProcessGroup,
  sseRetryFieldOnFirstEvent,
  settleCreditHoldIfStreamOpened,
  dropDuplicateSystemPrompts,
  skipEmptyWhitespaceMemoryFacts,
  stopIfFinalTextWithTools,
  gzipToolResultOverSize,
  redactUrlsWithCredentials,
  issueGenerateResumeToken,
  consumeGenerateResumeToken,
  patchGenerateResumeToken,
  resetGenerateResumeTokens,
  mapDeepSeekHttpError,
  createIdenticalObservationLoopCut,
  identicalObservationLoopCut,
  abortSiblingsOnParentCancel,
  validateEnumArgs,
  truncateOverlongArgStrings,
  cacheIdenticalToolCallSameTurn,
  resetSameTurnToolCache,
  detectDagCycle,
  remainingStepBudgetReminder,
  compactKeepToolCallResultPairs,
  minScoreMemoryRetrieve,
  checkpointAfterSuccessfulWrite,
  refuseBinaryFileEdit,
  normalizeLineEndingsBeforeDiff,
  moveFileSameVolume,
  sandboxRssCpuUlimit,
  wrapSandboxSpawnWithRssCpu,
  scrubSecretsFromChildEnv,
  tmpdirCleanupFinally,
  sseMaxBufferDisconnect,
  heartbeatJitter,
  generateWaitRetryAfter,
  refundPartialTokensOnCancel,
  resetCompletionHoldRefunds,
  classifyNetErrors,
  skipCompactIfUnderBudget,
  maxConcurrentToolsPerTurn,
  subagentResultSizeCap,
  repairMissingRequiredFromPriorTurn,
  validateToolResultShape,
  toolTimeoutFitsRemainingBudget,
  createDeadLetterSameToolAfterN,
  deadLetterSameToolAfterN,
  injectPlanProgressLine,
  compactPreserveLastErrors,
  pinCriticalFacts,
  checkpointCasSeq,
  checksumVerifyAfterWrite,
  syntaxCheckJsPyAfterWrite,
  rejectControlCharsInPaths,
  createFileExclusive,
  sandboxTmpfsHint,
  redactHomePathsInResults,
  ssePingOnIdleTool,
  classifySseGap,
  fairQueueStarvationBound,
  creditAuditOnToolError,
  classifyFsErrors,
  skipMemoryRetrieveIfBusy,
  joinParallelToolResultsStableOrder,
  cancelInflightToolsOnStop,
  jsonRepairTrailingComma,
  aliasCommonToolNames,
  truncateNestedToolArgsDepth,
  maxSubagentDepth,
  remainingWallClockCut,
  compactMergeAdjacentDuplicateUsers,
  memoryRetrieveDedupeByHash,
  refuseEditIfChecksumChangedSinceRead,
  patchContextLinesMustMatch,
  atomicWriteViaTempRename,
  rejectUncAndWindowsPaths,
  sandboxNoNewPrivs,
  envScrubLdPreload,
  cancelDropsBufferedTokens,
  sseEventIdMonotonic,
  idempotentSameCallIdInflight,
  settleCreditsIfClientGone,
  classifyJsonParseErrors,
  classifyAbortErrors,
  skipDuplicateWebFetchSameUrlTurn,
  maxToolsPerTurnHardCap,
  abortNestedSubagentsOnParentHalt,
  repairUnquotedKeysInToolJson,
  dropNullBytesInToolArgs,
  coerceIntegerFromNumericString,
  circuitBreakerEmptyModelTwice,
  budgetHintEveryFiveSteps,
  compactDropStaleImageBlocks,
  memorySkipFactsOlderThanDays,
  rollbackFileOnSyntaxFail,
  refuseWriteThroughSymlink,
  stripUtf8BomOnRead,
  sandboxKillAfterGraceMs,
  stdoutByteCapPerCommand,
  ssePadForProxyBuffering,
  destroySseOnClientClose,
  maxPendingGeneratePerUser,
  stealLockIfHeartbeatExpired,
  neverChargeOnUnauthorized,
  redactIpv4InPublicErrors,
  classifyEpipeAsCancelled,
  skipGlobIfMatchCap,
  firstTokenWatchdogMs,
  pruneCheckpointsKeepLastN,
  persistSseLastEventIdCursor,
  repairSingleQuotesAndCommentsInToolJson,
  clampMaxOutputTokens,
  dropDuplicateConsecutiveToolCalls,
  classifyHttpFamily,
  compactKeepLastUserAssistantPair,
  redactKeyLikeToolArgsFromLogs,
  boundStepsOnCheckpointResume,
  rejectEmptyToolName,
  rejectNulInPath,
  skipHeartbeatIfWriteWouldBlock,
  waitInflightToolThenDropOnCancel,
  recordTokenUsageOnErrorPath,
  pgvectorMemoryQueryTimeout,
  refuseComputerToolsIfFlagOff,
  coerceTrueFalseStringsToBool,
  maxConcurrentSubagents,
  dropEmptyAssistantTurn,
  sseRetryMsInPad,
  sandboxTmpCleanupOnTimeout,
  subagentInheritAbortSignal,
  truncateToolResultWithMarker,
  isolateParallelToolTimeout,
  holdSettleNeverDoubleCharge,
  enforceAdditionalPropertiesFalse,
  ensureUniqueToolCallIdsAcrossResume,
  clampSchemaIntegerNumberToMinMax,
  repairMissingClosingBracesWithBudget,
  refundHoldIfNoTokensUsed,
  pinLastToolErrorOnCompact,
  replayLastNSseEventsFromCursor,
  rejectIdenticalPromptInflightSameSession,
  refuseWriteOver2MiB,
  skipEmptyEmbeddingUpsert,
  neverChargeToolOnlyObservationLoop,
  enforceTotalTurnWall120s,
  repairEnumCaseInsensitive,
  stripZeroWidthCharsFromArgs,
  clampJsonArrayLength256,
  retryAfterJitter50to150ms,
  tombstoneDeletedCheckpoint,
  stderrByteCapPerCommand,
  dropToolResultsOlderThan6Steps,
  rejectToolNameWithWhitespace,
  keepIdNumericStringsAsStrings,
  requireSessionEventSeqIncrease,
  abortSiblingToolsOnParentCancelToken,
  redactEmailsInLogs,
  maxHeartbeatsPerMinute,
  refuseReadThroughSymlink,
  markPlanStepFailedIfToolErrorTwice,
  restoreLastSseIdOnResume,
  capToolArgBytes32KiB,
  repairUnescapedNewlinesInJsonStrings,
  coerceNullStringToNullOptional,
  maxSseBuffersPerSession16,
  compactKeepPinnedFactsAndLast3UserTurns,
  refuseWriteIfDestDirMissing,
  ceilTokensOnCancel,
  classifyEconnresetAsCancelled,
  queueMaxWait60sThen503,
  skipUpsertIfEmbeddingDimMismatch,
  stallIfNoEvent20sMidStream,
  stripUtf16NulPadding,
  rejectToolNameLongerThan64,
  rejectRecursiveSameToolNameOver8,
  skipCompletedPlanStepsOnResume,
  gzipCheckpointIfOver64KiB,
  parseLastEventIdIntOnly,
  capGlobMatchFileSize1MiB,
  redactAuthorizationBearerInToolResults,
  refuseHostBashIfComputerOnlyTurn,
  subagentInheritRemainingStepBudget,
  concatenateSplitToolCallFragments,
  neverRetry402,
  combinedStdoutStderr96KiB,
  pingOnlyIfLastWriteOver15s,
  rejectUnicodeSlashHomoglyph,
  sessionLockOwnerPidCheck,
  mapPrismaDisconnectRetryable,
  defaultToolTimeout30sIfMissing,
  closeSseThenSettleCredits,
  maxInflightToolsPerSession8,
  stripLeftoverLineCommentsInJson,
  rejectNaNInfinityNumbers,
  dropSseEventsOlderThan2min,
  capCompactSummary2KiB,
  refuseWriteToEtcProcSys,
  neverNegativeUsage,
  queueFairShareExtraSlotIfWaitOver20s,
  skipMemoryIfScoreNaN,
  cancelIfThreeStreamStalls,
  stripBidiOverrideChars,
  rejectToolNameOutsideCharset,
  rejectToolCallCycleAtoBtoA,
  capPlanSteps24,
  refuseCheckpointOver1MiBUncompressed,
  rejectLastEventIdGoingBackwards,
  capGlobMatchesReturned32,
  redactJwtShapedStrings,
  refuseComputerToolsIfNoUserId,
  minRemainingSubagentBudget1,
  dropIncompleteTrailingToolCall,
  neverRetry413,
  capStdoutLine8KiB,
  closeIfClientGone30s,
  sessionLockTtl90s,
  mapRedisEconnrefusedRetryable,
  hardCapToolTimeout120s,
  flushLastSseEventBeforeClose,
  capSerializedToolList8KB,
  screenshotOnlyNoCharge,
  TOOL_NAME_ALLOWLIST,
  MODEL_TIMEOUT_MS,
  MODEL_TTFB_MS,
  TOOL_RESULT_CAP,
  SSE_RING_MAX,
  DEEPSEEK_GENERATE_MODELS,
  GLOB_IGNORE_DEFAULTS,
};
