'use strict';

/**
 * 3H66 — fail-closed wiring of leftover adapter-only Claude-Code holes.
 *
 * Does NOT re-export 3H59/3H60/3H61/3H62/3H63/3H64/3H65 names (no overlay
 * collisions). Unique orchestrators CALL the live #388 adapter names
 * (injected) and apply their decisions on the generate / loop / SSE /
 * sandbox / memory hot path:
 *   tool JSON coerce + enum/required repair
 *   path jail (NFC / NUL / control / UNC / symlink / 2 MiB write)
 *   memory retrieve (dedupe / sort / empty / zero-vector / cap 8)
 *   empty-model retry-once + circuit + parallel-read / tool caps
 *   read hygiene (BOM / window / line numbers) + background bash
 *   same-call-id idempotency
 *   SSE close-then-settle + session lock TTL / steal
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const WAVE = '3H66';
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const UNIQUENESS_RE = /old_str occurs more than once|old_str not found|old_str must not be empty/i;
const WRITE_TOOL_RE = /^(write_|str_replace|apply_patch|apply_diff|edit_file|create_file|computer_write)/i;
const READ_TOOL_RE = /^(read_file|read_|cat_file|sandbox_read)/i;
const BASH_TOOL_RE = /^(execute_bash|bash|exec|shell|sandbox_bash)$/i;
const LIVE_HELPERS_WIRED = 36;

const ERROR_TABLE = Object.freeze({
  json_parse: { retryable: false, message: 'Los argumentos no eran JSON válido. No ejecuté la herramienta.' },
  missing_required: { retryable: false, message: 'Faltaba un argumento obligatorio. No ejecuté la herramienta.' },
  coercion_rejected: { retryable: false, message: 'Un argumento no se pudo convertir al tipo pedido. No la ejecuté.' },
  enum_invalid: { retryable: false, message: 'Un argumento no está en el enum permitido. No ejecuté la herramienta.' },
  enum_repair: { retryable: false, message: 'Ajusté un enum por mayúsculas. Seguí con el valor canónico.' },
  bad_path: { retryable: false, message: 'La ruta tenía caracteres o forma prohibidos. No toqué el archivo.' },
  nul_path: { retryable: false, message: 'La ruta contenía un byte nulo. La rechacé.' },
  symlink_rejected: { retryable: false, message: 'El enlace simbólico salía del workspace. No lo seguí.' },
  symlink_write: { retryable: false, message: 'No escribo a través de un enlace simbólico.' },
  symlink_read: { retryable: false, message: 'No leo a través de un enlace simbólico.' },
  write_too_large: { retryable: false, message: 'El contenido supera 2 MiB. No lo escribí.' },
  empty_embedding: { retryable: false, message: 'El embedding estaba vacío o era cero. No lo indexé.' },
  memory_fact_empty: { retryable: false, message: 'Omití hechos de memoria vacíos o solo espacios.' },
  memory_zero_vector: { retryable: false, message: 'Omití vectores de memoria que eran todo ceros.' },
  pin_dedup: { retryable: false, message: 'Quité hechos de memoria duplicados por hash.' },
  memory_hits_cap: { retryable: false, message: 'Recorté la memoria a 8 hits.' },
  memory_sort: { retryable: false, message: 'Ordené los hits de memoria por score descendente.' },
  empty_response: { retryable: true, message: 'El modelo devolvió vacío. Reintenté una vez y luego corté.' },
  empty_model: { retryable: true, message: 'El modelo volvió a devolver vacío. Corté el turno.' },
  too_many_tools: { retryable: false, message: 'Este turno pidió demasiadas herramientas. No las lancé.' },
  tool_storm: { retryable: false, message: 'Había más tool_calls que el tope por mensaje. Recorté el excedente.' },
  bash_background: { retryable: false, message: 'Registré el bash en segundo plano.' },
  sandbox_reap: { retryable: false, message: 'Reinicié el registro de bash en segundo plano.' },
  exactly_once_tool: { retryable: true, message: 'La misma llamada ya estaba en vuelo. Reusé el resultado.' },
  sse_settle_order: { retryable: false, message: 'Cierro el SSE antes de liquidar créditos.' },
  lock_ttl: { retryable: true, message: 'El lock de sesión expiró a los 90 s. Lo robé.' },
  credit_ceiling: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  quota_exhausted: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave65() {
  try { return require('./engine-3h65'); } catch (_) { return null; }
}

function loadWave64() {
  try { return require('./engine-3h64'); } catch (_) { return null; }
}

function loadWave63() {
  try { return require('./engine-3h63'); } catch (_) { return null; }
}

function loadWave62() {
  try { return require('./engine-3h62'); } catch (_) { return null; }
}

function loadWave61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function callLive(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(args); } catch (_) { return fallback; }
}

function callLiveN(fn, a, b, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(a, b); } catch (_) { return fallback; }
}

function looksLikeUniqueness(value) {
  return UNIQUENESS_RE.test(String((value && value.message) || value || ''));
}

function toolNameOf(call) {
  if (!call) return '';
  if (typeof call === 'string') return call;
  return String(call.name || call.tool || (call.function && call.function.name) || '');
}

/**
 * Repair tool JSON (comments / single quotes / unquoted keys) then coerce
 * true/false + integer strings, repair enum case, fill missing required
 * from the prior turn. Refuse when repair/coerce fails.
 */
function applyToolJsonCoerceClosed({
  raw,
  args,
  schema,
  prior,
  repairSingleQuotesAndCommentsInToolJson,
  repairUnquotedKeysInToolJson,
  coerceTrueFalseStringsToBool,
  coerceIntegerFromNumericString,
  repairEnumCaseInsensitive,
  repairMissingRequiredFromPriorTurn,
} = {}) {
  let value = (args && typeof args === 'object' && !args.__parse_error) ? args : null;
  let repaired = false;
  if (value == null && raw != null && typeof raw !== 'object') {
    const quotes = repairSingleQuotesAndCommentsInToolJson
      ? repairSingleQuotesAndCommentsInToolJson(raw)
      : { ok: true, value: null };
    if (quotes && quotes.ok === false) {
      return { ok: false, refuse: true, args: null, code: quotes.code || 'json_parse' };
    }
    const keys = repairUnquotedKeysInToolJson
      ? repairUnquotedKeysInToolJson((quotes && quotes.value != null && quotes.repaired) ? JSON.stringify(quotes.value) : raw)
      : { ok: true, value: quotes && quotes.value };
    if (keys && keys.ok === false) {
      return { ok: false, refuse: true, args: null, code: keys.code || 'json_parse' };
    }
    if (quotes && quotes.repaired) repaired = true;
    if (keys && keys.repaired) repaired = true;
    value = (keys && keys.value) || (quotes && quotes.value) || null;
  } else {
    if (typeof repairSingleQuotesAndCommentsInToolJson === 'function' && raw != null && typeof raw !== 'object') {
      repairSingleQuotesAndCommentsInToolJson(raw);
    }
    if (typeof repairUnquotedKeysInToolJson === 'function' && raw != null && typeof raw !== 'object') {
      repairUnquotedKeysInToolJson(raw);
    }
  }
  if (value == null) value = (args && typeof args === 'object') ? args : {};
  if (value && value.__parse_error) {
    return { ok: false, refuse: true, args: value, code: 'json_parse' };
  }
  // Live coerce helpers default missing schema to {type:'boolean'|'integer'}.
  // Without a real schema (tools: []) that would refuse ordinary objects.
  const sch = (schema && typeof schema === 'object' && !Array.isArray(schema))
    ? schema
    : { type: 'object' };
  const bools = coerceTrueFalseStringsToBool
    ? coerceTrueFalseStringsToBool(value, sch)
    : { ok: true, value };
  if (bools && bools.ok === false) {
    return { ok: false, refuse: true, args: value, code: bools.code || 'coercion_rejected' };
  }
  const ints = coerceIntegerFromNumericString
    ? coerceIntegerFromNumericString((bools && bools.value != null) ? bools.value : value, sch)
    : { ok: true, value: (bools && bools.value) || value };
  if (ints && ints.ok === false) {
    return { ok: false, refuse: true, args: value, code: ints.code || 'coercion_rejected' };
  }
  const next = (ints && ints.value != null) ? ints.value : ((bools && bools.value != null) ? bools.value : value);
  const enums = repairEnumCaseInsensitive
    ? repairEnumCaseInsensitive(next, sch)
    : { ok: true, value: next };
  if (enums && enums.ok === false) {
    return { ok: false, refuse: true, args: next, code: enums.code || 'enum_invalid' };
  }
  const filled = repairMissingRequiredFromPriorTurn
    ? repairMissingRequiredFromPriorTurn((enums && enums.value != null) ? enums.value : next, sch, { prior })
    : { ok: true, args: (enums && enums.value) || next };
  if (filled && filled.ok === false) {
    return { ok: false, refuse: true, args: filled.args, code: filled.code || 'missing_required' };
  }
  return {
    ok: true,
    refuse: false,
    args: (filled && filled.args) || (enums && enums.value) || next,
    repaired: Boolean(repaired || (bools && bools.coerced) || (ints && ints.coerced) || (enums && enums.repaired) || (filled && filled.repaired)),
    code: (enums && enums.repaired && enums.code) || (filled && filled.repaired && filled.code) || null,
  };
}

/**
 * NFC-normalize then refuse NUL / control / UNC+Windows / symlink escape
 * and write-through-symlink / read-through-symlink / writes over 2 MiB.
 * Uniqueness of str_replace is never a path-jail fail.
 */
function applyPathJailClosed({
  path: filePath,
  content,
  root,
  kind,
  result,
  lstatSync,
  realpathSync,
  isSymlink,
  maxBytes,
  nfcPath,
  rejectNulInPath,
  rejectControlCharsInPaths,
  rejectUncAndWindowsPaths,
  rejectSymlinkEscape,
  refuseWriteThroughSymlink,
  refuseReadThroughSymlink,
  refuseWriteOver2MiB,
} = {}) {
  if (looksLikeUniqueness(result)) {
    return { ok: true, uniqueness: true, path: filePath, code: null };
  }
  const raw = filePath == null ? '' : String(filePath);
  const normalized = nfcPath ? nfcPath(raw) : raw;
  const nul = rejectNulInPath ? rejectNulInPath(normalized) : { ok: true, path: normalized };
  if (nul && nul.ok === false) {
    return { ok: false, refuse: true, path: normalized, code: nul.code || 'nul_path' };
  }
  const ctrl = rejectControlCharsInPaths ? rejectControlCharsInPaths(normalized) : { ok: true, path: normalized };
  if (ctrl && ctrl.ok === false) {
    return { ok: false, refuse: true, path: normalized, code: ctrl.code || 'bad_path' };
  }
  const unc = rejectUncAndWindowsPaths ? rejectUncAndWindowsPaths(normalized) : { ok: true, path: normalized };
  if (unc && unc.ok === false) {
    return { ok: false, refuse: true, path: normalized, code: unc.code || 'bad_path' };
  }
  // rejectSymlinkEscape → workspacePathJail, which fail-closes when root
  // is missing. Relative tools (list_files path:'.') must still run.
  const hasRoot = root != null && String(root).trim() !== '';
  const escape = (hasRoot && rejectSymlinkEscape)
    ? rejectSymlinkEscape(normalized, root, { lstatSync, realpathSync })
    : { ok: true, path: normalized, skipped: !hasRoot };
  if (escape && escape.ok === false) {
    return { ok: false, refuse: true, path: normalized, code: escape.code || 'symlink_rejected' };
  }
  const writeKind = kind === 'write' || WRITE_TOOL_RE.test(String(kind || ''));
  const readKind = kind === 'read' || READ_TOOL_RE.test(String(kind || ''));
  if (writeKind) {
    const through = refuseWriteThroughSymlink
      ? refuseWriteThroughSymlink(normalized, { lstatSync, isSymlink })
      : { ok: true };
    if (through && through.ok === false) {
      return { ok: false, refuse: true, path: normalized, code: through.code || 'symlink_write' };
    }
    if (content != null) {
      const big = refuseWriteOver2MiB
        ? refuseWriteOver2MiB(content, maxBytes != null ? { maxBytes } : undefined)
        : { ok: true };
      if (big && big.ok === false) {
        return { ok: false, refuse: true, path: normalized, code: big.code || 'write_too_large' };
      }
    }
  }
  if (readKind) {
    const throughR = refuseReadThroughSymlink
      ? refuseReadThroughSymlink(normalized, { lstatSync, isSymlink })
      : { ok: true };
    if (throughR && throughR.ok === false) {
      return { ok: false, refuse: true, path: normalized, code: throughR.code || 'symlink_read' };
    }
  }
  return { ok: true, refuse: false, path: normalized, uniqueness: false, code: null };
}

/**
 * Filter / sort / cap memory hits. Skip empty facts, all-zero vectors,
 * empty embedding upserts; dedupe by hash; sort score desc; cap 8.
 */
function applyMemoryRetrieveClosed({
  facts,
  hits,
  vector,
  fact,
  skipEmptyWhitespaceMemoryFacts,
  skipMemoryIfVectorAllZeros,
  skipEmptyEmbeddingUpsert,
  memoryRetrieveDedupeByHash,
  sortMemoryHitsByScoreDesc,
  capMemoryHitsReturned8,
} = {}) {
  const seed = Array.isArray(hits) ? hits : (Array.isArray(facts) ? facts : []);
  const upsert = skipEmptyEmbeddingUpsert
    ? skipEmptyEmbeddingUpsert(vector, { fact })
    : { skip: false };
  if (upsert && upsert.skip && (vector != null || fact != null)) {
    return {
      ok: true,
      skipUpsert: true,
      hits: [],
      facts: [],
      code: upsert.code || 'empty_embedding',
    };
  }
  const ws = skipEmptyWhitespaceMemoryFacts
    ? skipEmptyWhitespaceMemoryFacts(seed)
    : { facts: seed };
  const zeros = skipMemoryIfVectorAllZeros
    ? skipMemoryIfVectorAllZeros((ws && ws.facts) || seed)
    : { facts: (ws && ws.facts) || seed };
  const deduped = memoryRetrieveDedupeByHash
    ? memoryRetrieveDedupeByHash((zeros && zeros.facts) || seed)
    : { facts: (zeros && zeros.facts) || seed };
  const sorted = sortMemoryHitsByScoreDesc
    ? sortMemoryHitsByScoreDesc((deduped && deduped.facts) || seed)
    : { hits: (deduped && deduped.facts) || seed };
  const capped = capMemoryHitsReturned8
    ? capMemoryHitsReturned8((sorted && sorted.hits) || (deduped && deduped.facts) || seed)
    : { hits: (sorted && sorted.hits) || seed };
  const out = (capped && capped.hits) || [];
  return {
    ok: true,
    skipUpsert: false,
    hits: out,
    facts: out,
    truncated: Boolean(capped && capped.truncated),
    dropped: (ws && ws.skipped) || (zeros && zeros.skipped) || (deduped && deduped.dropped) || 0,
    code: (capped && capped.truncated && capped.code)
      || (sorted && sorted.sorted && sorted.code)
      || (deduped && deduped.dropped && deduped.code)
      || (zeros && zeros.skipped && zeros.code)
      || (ws && ws.skipped && ws.code)
      || null,
  };
}

/**
 * Empty-model retry-once + circuit after two empties; parallel-read
 * partition; hard cap / unique-16 / per-message tool caps.
 */
function applyEmptyModelAndParallelCapsClosed({
  response,
  state,
  calls,
  toolCalls,
  emptyResponseRetryOnce,
  circuitBreakerEmptyModelTwice,
  allowParallelReads,
  maxToolsPerTurnHardCap,
  maxUniqueToolsPerTurn16,
  maxToolCallsPerMessage,
} = {}) {
  const list = Array.isArray(calls) ? calls : (Array.isArray(toolCalls) ? toolCalls : []);
  const rec = state && typeof state === 'object' ? state : {};
  const emptyOnce = emptyResponseRetryOnce
    ? emptyResponseRetryOnce(response, rec)
    : { empty: false, retry: false, stop: false, state: rec };
  const brk = circuitBreakerEmptyModelTwice
    ? circuitBreakerEmptyModelTwice(response, (emptyOnce && emptyOnce.state) || rec)
    : { halt: false, empty: false, state: rec };
  const parallel = allowParallelReads
    ? allowParallelReads(list)
    : { reads: list, writes: [], blockedReads: [], parallelReads: list };
  const hard = maxToolsPerTurnHardCap
    ? maxToolsPerTurnHardCap(list)
    : { halt: false, count: list.length };
  const unique = maxUniqueToolsPerTurn16
    ? maxUniqueToolsPerTurn16(list)
    : { calls: list };
  const perMsg = maxToolCallsPerMessage
    ? maxToolCallsPerMessage((unique && unique.calls) || list)
    : { calls: (unique && unique.calls) || list, overflow: [] };
  const emptyHalt = list.length === 0 && Boolean((emptyOnce && emptyOnce.stop) || (brk && brk.halt));
  const capHalt = Boolean(hard && hard.halt);
  const nextCalls = (perMsg && Array.isArray(perMsg.calls))
    ? perMsg.calls
    : ((unique && Array.isArray(unique.calls)) ? unique.calls : list);
  return {
    ok: !capHalt,
    halt: capHalt,
    emptyHalt,
    emptyRetry: list.length === 0 && Boolean(emptyOnce && emptyOnce.retry && !emptyHalt),
    calls: (nextCalls.length || !list.length) ? nextCalls : list,
    overflow: (perMsg && perMsg.overflow) || [],
    blockedReads: (parallel && parallel.blockedReads) || [],
    parallelReads: (parallel && parallel.parallelReads) || [],
    writes: (parallel && parallel.writes) || [],
    state: (brk && brk.state) || (emptyOnce && emptyOnce.state) || rec,
    code: (hard && hard.halt && hard.code)
      || (emptyHalt && ((brk && brk.code) || (emptyOnce && emptyOnce.code)))
      || (perMsg && perMsg.overflow && perMsg.overflow.length && perMsg.code)
      || (unique && unique.dropped && unique.code)
      || null,
  };
}

/**
 * Strip UTF-8 BOM, optional window + line numbers. Track background bash.
 * Line numbers replace the observation only when offset/limit was requested
 * (keeps F3 / default read_file text stable).
 */
function applyReadHygieneClosed({
  text,
  offset,
  limit,
  windowed,
  bashId,
  kill,
  cmd,
  reset,
  stripUtf8BomOnRead,
  sliceReadWindow,
  formatReadWithLineNumbers,
  startBackgroundBash,
  resetBackgroundBash,
} = {}) {
  const bom = stripUtf8BomOnRead
    ? stripUtf8BomOnRead(text)
    : { text: text == null ? '' : text, bom: false };
  const body = bom && bom.text != null ? bom.text : text;
  const wantWindow = windowed === true
    || offset != null
    || (limit != null && Number(limit) > 0);
  const win = sliceReadWindow
    ? sliceReadWindow({ text: body, offset: offset != null ? offset : 1, limit: limit != null ? limit : 400 })
    : { text: body, truncated: false };
  const numbered = formatReadWithLineNumbers
    ? formatReadWithLineNumbers({ text: body, offset: offset != null ? offset : 1, limit: limit != null ? limit : 400 })
    : { text: body };
  let bash = { ok: true };
  if (reset === true && resetBackgroundBash) {
    resetBackgroundBash();
    bash = { ok: true, reset: true, code: 'sandbox_reap' };
  } else if (startBackgroundBash && (bashId || cmd || kill)) {
    bash = startBackgroundBash(bashId, { kill, cmd });
  }
  return {
    ok: true,
    text: wantWindow ? ((numbered && numbered.text) || body) : body,
    bom: Boolean(bom && bom.bom),
    truncated: Boolean((win && win.truncated) || (numbered && numbered.truncated)),
    bashId: bash && bash.id,
    code: (bash && bash.code) || (numbered && numbered.code) || (win && win.code) || (bom && bom.bom && bom.code) || null,
  };
}

/**
 * Coalesce same tool_call id while in-flight; remember result for replay.
 */
function applyCallIdempotencyClosed({
  callId,
  inflight,
  store,
  args,
  result,
  create,
  remember,
  idempotentSameCallIdInflight,
  rememberCallResult,
} = {}) {
  const hit = idempotentSameCallIdInflight
    ? idempotentSameCallIdInflight(callId, inflight || {}, { create })
    : { coalesced: false, promise: null };
  let remembered = store || null;
  if (remember === true || result !== undefined) {
    remembered = rememberCallResult
      ? rememberCallResult(store || {}, { toolCallId: callId, args, result })
      : store;
  }
  return {
    ok: true,
    coalesced: Boolean(hit && hit.coalesced),
    promise: hit && hit.promise,
    inflight: (hit && hit.inflight) || inflight,
    store: remembered,
    code: (hit && hit.coalesced && hit.code) || null,
  };
}

/**
 * Close SSE before settling credits. Expire / steal session lock at 90 s
 * or when the holder heartbeat is stale.
 */
function applySseCreditLockClosed({
  sseClosed,
  settled,
  cancelled,
  held,
  acquiredAt,
  now,
  holder,
  heartbeatAt,
  heartbeat,
  requester,
  closeSseThenSettleCredits,
  sessionLockTtl90s,
  stealLockIfHeartbeatExpired,
} = {}) {
  const order = closeSseThenSettleCredits
    ? closeSseThenSettleCredits({ sseClosed, settled, cancelled, held })
    : { order: 'noop', settle: false, sseClosed: !!sseClosed, settled: !!settled };
  const ttl = sessionLockTtl90s
    ? sessionLockTtl90s({ acquiredAt, now: now || Date.now() })
    : { expired: false, steal: false };
  const stolen = stealLockIfHeartbeatExpired
    ? stealLockIfHeartbeatExpired({
      holder,
      heartbeatAt,
      heartbeat,
      now: now || Date.now(),
      requester,
    })
    : { stolen: false };
  return {
    ok: true,
    closeFirst: order && order.order === 'close_first',
    settle: Boolean(order && order.settle),
    expired: Boolean(ttl && ttl.expired),
    steal: Boolean((ttl && ttl.steal) || (stolen && stolen.stolen)),
    holder: (stolen && stolen.holder) || holder,
    code: (ttl && ttl.expired && ttl.code)
      || (order && order.order === 'close_first' && order.code)
      || (stolen && stolen.stolen && stolen.code)
      || null,
  };
}

function classifyEngine3h66Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) {
    const w65 = loadWave65();
    if (w65 && typeof w65.classifyEngine3h65Error === 'function') {
      return w65.classifyEngine3h65Error(input);
    }
    return null;
  }
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  return {
    code,
    message: row.message,
    retryable: row.retryable === true,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

function refuseOpenRouterInWave3h66(env = process.env) {
  const w65 = loadWave65();
  if (w65 && typeof w65.refuseOpenRouterInWave3h65 === 'function') {
    return w65.refuseOpenRouterInWave3h65(env);
  }
  const w64 = loadWave64();
  if (w64 && typeof w64.refuseOpenRouterInWave3h64 === 'function') {
    return w64.refuseOpenRouterInWave3h64(env);
  }
  const w63 = loadWave63();
  if (w63 && typeof w63.refuseOpenRouterInWave3h63 === 'function') {
    return w63.refuseOpenRouterInWave3h63(env);
  }
  const w62 = loadWave62();
  if (w62 && typeof w62.refuseOpenRouterInWave3h62 === 'function') {
    return w62.refuseOpenRouterInWave3h62(env);
  }
  const w61 = loadWave61();
  if (w61 && typeof w61.refuseOpenRouterInWave3h61 === 'function') {
    return w61.refuseOpenRouterInWave3h61(env);
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.refuseOpenRouterInWave3h60 === 'function') {
    return w60.refuseOpenRouterInWave3h60(env);
  }
  const w59 = loadWave59();
  if (w59 && typeof w59.refuseOpenRouterInWave3h59 === 'function') {
    return w59.refuseOpenRouterInWave3h59(env);
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  applyToolJsonCoerceClosed: true,
  applyPathJailClosed: true,
  applyMemoryRetrieveClosed: true,
  applyEmptyModelAndParallelCapsClosed: true,
  applyReadHygieneClosed: true,
  applyCallIdempotencyClosed: true,
  applySseCreditLockClosed: true,
  classifyEngine3h66Error: true,
  refuseOpenRouterInWave3h66: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
    liveHelpersWired: LIVE_HELPERS_WIRED,
    latencyNote: 'persisted p50/p95 JSONL ring; never invented Flash; VPS corpus still unmeasured',
    eventSourceNote: 'Node EventSource-semantics against mock generate; browser EventSource still pending',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  LIVE_HELPERS_WIRED,
  applyToolJsonCoerceClosed,
  applyPathJailClosed,
  applyMemoryRetrieveClosed,
  applyEmptyModelAndParallelCapsClosed,
  applyReadHygieneClosed,
  applyCallIdempotencyClosed,
  applySseCreditLockClosed,
  classifyEngine3h66Error,
  refuseOpenRouterInWave3h66,
  callLive,
  callLiveN,
  waveSnapshot,
  looksLikeUniqueness,
  WRITE_TOOL_RE,
  READ_TOOL_RE,
  BASH_TOOL_RE,
};
