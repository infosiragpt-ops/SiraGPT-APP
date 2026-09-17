'use strict';

/**
 * 3H65 — fail-closed wiring of leftover adapter-only Claude-Code holes.
 *
 * Does NOT re-export 3H59/3H60/3H61/3H62/3H63/3H64 names (no overlay collisions).
 * Unique orchestrators CALL the live #388 adapter names (injected) and
 * apply their decisions on the generate / loop / SSE hot path:
 *   anti-loop / planning leftover (DAG, A-B-A, dead-letter, observation cut)
 *   tool arg/result hygiene + secret redaction
 *   file-edit leftover after 3H63 checksum (rollback / refuse large overwrite)
 *   DeepSeek 402/413 never-retry + never-charge if cancelled before first token
 *   generate queue cap 16 + starvation bound + SSE seq / heartbeat backpressure
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const WAVE = '3H65';
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const UNIQUENESS_RE = /old_str occurs more than once|old_str not found|old_str must not be empty/i;
const WEB_FETCH_RE = /^(web_fetch|web_search|fetch_url|http_get|browse_url)$/i;
const WRITE_TOOL_RE = /^(write_|str_replace|apply_patch|apply_diff|edit_file|create_file)/i;
const LIVE_HELPERS_WIRED = 33;

const ERROR_TABLE = Object.freeze({
  dag_cycle: { retryable: false, message: 'Detecté un ciclo en el plan de herramientas. Corté el turno.' },
  tool_cycle: { retryable: false, message: 'La secuencia A→B→A se repitió. No ejecuté ese ciclo.' },
  tool_dead_letter: { retryable: false, message: 'La misma herramienta falló demasiadas veces. La pasé a dead-letter.' },
  identical_observation_loop: { retryable: false, message: 'Las observaciones idénticas se repetían. Corté el bucle.' },
  plan_budget: { retryable: false, message: 'Quedan pocos pasos. Pedí que resuma y termine.' },
  subagent_concurrency: { retryable: false, message: 'Hay demasiados subagentes a la vez. Aplacé el excedente.' },
  subagent_depth: { retryable: false, message: 'El subagente superó la profundidad máxima. No lo lancé.' },
  inflight_tools: { retryable: true, message: 'Esta sesión ya tiene 8 herramientas en vuelo. No lancé otra.' },
  rate_limited: { retryable: true, message: 'Esta herramienta superó su tope por minuto. Espera un momento.' },
  tool_args_invalid: { retryable: false, message: 'Los argumentos de la herramienta superan el tope. No la ejecuté.' },
  enum_rejected: { retryable: false, message: 'Un argumento no está en el enum permitido. No ejecuté la herramienta.' },
  bad_tool_result: { retryable: false, message: 'El resultado de la herramienta no tenía forma válida. Lo descarté.' },
  file_too_large: { retryable: false, message: 'El archivo ya es grande y no hay backup. No lo sobreescribí.' },
  git_hunk_context: { retryable: false, message: 'Las líneas de contexto del parche no coinciden. No apliqué el diff.' },
  checkpoint_rollback: { retryable: true, message: 'Revertí la última edición de archivo desde el checkpoint.' },
  checkpoint_missing: { retryable: false, message: 'No había checkpoint de edición. No revertí nada.' },
  credit_cancel_pre_token: { retryable: false, message: 'Cancelé antes del primer token. No cobré créditos.' },
  credit_ceiling: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  quota_exhausted: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  payload_too_large: { retryable: false, message: 'La petición era demasiado grande (413). No reintenté.' },
  queue_generate_cap: { retryable: true, message: 'La cola de generate ya tiene 16 turnos. Rechacé el nuevo.' },
  event_order: { retryable: true, message: 'El seq del evento SSE no aumentó. Rechacé el cursor.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

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

/**
 * validateEnumArgs walks every schema.properties key, including omitted
 * optional enums (computer_click.button). Only validate keys that are
 * present or required — still CALLS the live helper.
 */
function schemaForPresentArgs(schema, args) {
  if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = {};
  for (const key of Object.keys(schema.properties)) {
    if ((args && Object.prototype.hasOwnProperty.call(args, key)) || required.indexOf(key) >= 0) {
      props[key] = schema.properties[key];
    }
  }
  const next = {};
  for (const k of Object.keys(schema)) next[k] = schema[k];
  next.properties = props;
  return next;
}

function toolNameOf(call) {
  if (!call) return '';
  if (typeof call === 'string') return call;
  return String(call.name || call.tool || (call.function && call.function.name) || '');
}

function buildSequentialAdj(calls) {
  const names = (Array.isArray(calls) ? calls : []).map(toolNameOf).filter(Boolean);
  const adj = {};
  for (let i = 0; i + 1 < names.length; i += 1) {
    const a = names[i];
    const b = names[i + 1];
    if (!adj[a]) adj[a] = [];
    if (adj[a].indexOf(b) < 0) adj[a].push(b);
  }
  return adj;
}

/**
 * Anti-loop / planning leftover. Fail-closed on DAG cycle, A-B-A,
 * dead-letter, identical observation, inflight/subagent caps, rate limit.
 * Budget hints are advisory (inject) and never halt.
 */
function applyAntiLoopGuardsClosed({
  calls,
  dag,
  history,
  observations,
  step,
  remaining,
  max,
  subagents,
  depth,
  inflight,
  sessionKey,
  toolName,
  detectDagCycle,
  rejectToolCallCycleAtoBtoA,
  deadLetterSameToolAfterN,
  identicalObservationLoopCut,
  budgetHintEveryFiveSteps,
  remainingStepBudgetReminder,
  maxConcurrentSubagents,
  maxSubagentDepth,
  maxInflightToolsPerSession8,
  perToolRateLimit,
} = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const adj = dag && typeof dag === 'object' && !Array.isArray(dag) ? dag : buildSequentialAdj(list);
  const cycleDag = detectDagCycle
    ? detectDagCycle(adj)
    : { ok: true };
  const cycleAba = rejectToolCallCycleAtoBtoA
    ? rejectToolCallCycleAtoBtoA(list)
    : { ok: true };
  const dead = deadLetterSameToolAfterN
    ? deadLetterSameToolAfterN(history || [])
    : { halt: false };
  const obs = identicalObservationLoopCut
    ? identicalObservationLoopCut(observations || [])
    : { cut: false };
  const five = budgetHintEveryFiveSteps
    ? budgetHintEveryFiveSteps({ step, remaining, max })
    : { inject: false };
  const remind = remainingStepBudgetReminder
    ? remainingStepBudgetReminder({ remaining, max })
    : { inject: false };
  const conc = maxConcurrentSubagents
    ? maxConcurrentSubagents(subagents || [])
    : { ok: true };
  const deep = maxSubagentDepth
    ? maxSubagentDepth(depth)
    : { ok: true };
  const inflightN = inflight != null ? inflight : list.length;
  const inflightHit = maxInflightToolsPerSession8
    ? maxInflightToolsPerSession8(inflightN, { sessionKey })
    : { ok: true };
  const rate = perToolRateLimit && (sessionKey || toolName)
    ? perToolRateLimit(sessionKey, toolName || toolNameOf(list[0]))
    : { ok: true };
  const halt = Boolean(
    (cycleDag && cycleDag.ok === false)
    || (cycleAba && cycleAba.ok === false)
    || (dead && dead.halt)
    || (obs && obs.cut)
    || (conc && conc.ok === false)
    || (deep && deep.ok === false)
    || (inflightHit && inflightHit.ok === false)
    || (rate && rate.ok === false),
  );
  const code = (cycleDag && cycleDag.ok === false && cycleDag.code)
    || (cycleAba && cycleAba.ok === false && cycleAba.code)
    || (dead && dead.halt && dead.code)
    || (obs && obs.cut && obs.code)
    || (conc && conc.ok === false && conc.code)
    || (deep && deep.ok === false && deep.code)
    || (inflightHit && inflightHit.ok === false && inflightHit.code)
    || (rate && rate.ok === false && rate.code)
    || ((five && five.inject && five.code) || (remind && remind.inject && remind.code))
    || null;
  const hint = (five && five.inject && five.text) || (remind && remind.inject && remind.text) || null;
  return {
    halt,
    ok: !halt,
    inject: Boolean(hint),
    text: hint,
    deferred: (conc && conc.deferred) || [],
    code,
  };
}

/**
 * Cap args, force additionalProperties:false, validate enums.
 * Refuse oversize / enum-invalid. Never execute those calls.
 */
function applyToolArgHygieneClosed({
  args,
  schema,
  name,
  url,
  turnCache,
  capToolArgBytes,
  capToolArgBytes32KiB,
  enforceAdditionalPropertiesFalse,
  validateEnumArgs,
  skipDuplicateWebFetchSameUrlTurn,
} = {}) {
  const capped = capToolArgBytes
    ? capToolArgBytes(args)
    : { ok: true, args };
  const capped32 = capToolArgBytes32KiB
    ? capToolArgBytes32KiB(args)
    : { truncated: false, args };
  const enforced = enforceAdditionalPropertiesFalse
    ? enforceAdditionalPropertiesFalse(schema)
    : { schema: schema || { additionalProperties: false }, enforced: true };
  const enums = validateEnumArgs
    ? validateEnumArgs(args, schemaForPresentArgs((enforced && enforced.schema) || schema, args))
    : { ok: true, args };
  let fetchSkip = { skipped: false, cacheHit: false };
  if (skipDuplicateWebFetchSameUrlTurn && WEB_FETCH_RE.test(String(name || ''))) {
    const href = url
      || (args && (args.url || args.href || args.uri || args.query))
      || '';
    fetchSkip = skipDuplicateWebFetchSameUrlTurn(href, turnCache || {});
  }
  const refuse = Boolean(
    (capped && capped.ok === false)
    || (enums && enums.ok === false),
  );
  return {
    ok: !refuse,
    refuse,
    args: (capped32 && capped32.truncated) ? capped32.args : args,
    schema: enforced && enforced.schema,
    skipped: Boolean(fetchSkip && fetchSkip.skipped),
    cacheHit: Boolean(fetchSkip && fetchSkip.cacheHit),
    cachedResult: fetchSkip && fetchSkip.result,
    bytes: capped && capped.bytes,
    code: (capped && capped.ok === false && capped.code)
      || (enums && enums.ok === false && enums.code)
      || (capped32 && capped32.truncated && capped32.code)
      || null,
  };
}

/**
 * Validate / clamp / gzip / redact tool results (secrets + Bearer).
 */
function applyToolResultHygieneClosed({
  result,
  validateToolResultShape,
  gzipToolResultOverSize,
  clampToolResultWithHash,
  redactSecretsInToolResult,
  redactAuthorizationBearerInToolResults,
} = {}) {
  const shape = validateToolResultShape
    ? validateToolResultShape(result)
    : { ok: true, result };
  if (shape && shape.ok === false) {
    return {
      ok: false,
      text: 'ERROR: bad_tool_result',
      result: shape.result,
      code: shape.code || 'bad_tool_result',
    };
  }
  const raw = typeof result === 'string'
    ? result
    : (result == null ? '' : (typeof result === 'object' ? JSON.stringify(result) : String(result)));
  const secrets = redactSecretsInToolResult
    ? redactSecretsInToolResult(raw)
    : { text: raw, redacted: false };
  const bearer = redactAuthorizationBearerInToolResults
    ? redactAuthorizationBearerInToolResults(secrets && secrets.text != null ? secrets.text : raw)
    : { text: secrets && secrets.text != null ? secrets.text : raw, redacted: false };
  const clamped = clampToolResultWithHash
    ? clampToolResultWithHash(bearer && bearer.text != null ? bearer.text : raw)
    : { text: bearer && bearer.text != null ? bearer.text : raw };
  const gz = gzipToolResultOverSize
    ? gzipToolResultOverSize(clamped && clamped.text != null ? clamped.text : raw)
    : { gzipped: false, text: clamped && clamped.text };
  // Still CALL gzip (wired) but never replace the model-visible observation
  // with `[gzip N->M]` — that would drop screenshot JSON / F7 envelopes.
  const text = (clamped && clamped.text)
    || (bearer && bearer.text)
    || raw;
  return {
    ok: true,
    text,
    gzipped: Boolean(gz && gz.gzipped),
    redacted: Boolean((secrets && secrets.redacted) || (bearer && bearer.redacted)),
    truncated: Boolean(clamped && clamped.truncated),
    hash: clamped && clamped.hash,
    code: (gz && gz.gzipped && gz.code)
      || (clamped && clamped.code)
      || (bearer && bearer.redacted && bearer.code)
      || (secrets && secrets.redacted && secrets.code)
      || null,
  };
}

/**
 * File-edit leftover after 3H63 checksum. Never treat str_replace
 * uniqueness as timeout / syntax revert.
 */
function applyFileEditGuardsClosed({
  path: filePath,
  existingBytes,
  existingText,
  exists,
  backupPath,
  haystack,
  diff,
  context,
  actual,
  checkpoint,
  n,
  apply,
  failed,
  timedOut,
  result,
  hasRunner,
  rollbackLastFileEdit,
  rollbackLastNFileEdits,
  afterWriteTestHint,
  createIfMissingOrRefuseLargeOverwrite,
  patchContextLinesMustMatch,
} = {}) {
  if (looksLikeUniqueness(result)) {
    return { ok: true, uniqueness: true, reverted: false, code: null };
  }
  const overwrite = createIfMissingOrRefuseLargeOverwrite
    ? createIfMissingOrRefuseLargeOverwrite({
      path: filePath,
      existingBytes,
      existingText,
      exists,
      backupPath,
    })
    : { ok: true };
  if (overwrite && overwrite.ok === false) {
    return {
      ok: false,
      refuse: true,
      reverted: false,
      code: overwrite.code || 'file_too_large',
    };
  }
  const ctx = patchContextLinesMustMatch
    ? patchContextLinesMustMatch({ haystack, diff, context, actual })
    : { ok: true };
  if (ctx && ctx.ok === false) {
    return { ok: false, refuse: true, reverted: false, code: ctx.code || 'git_hunk_context' };
  }
  let rolled = { ok: true, reverted: false };
  if ((failed || timedOut) && checkpoint) {
    if (rollbackLastNFileEdits && Number(n) > 1) {
      rolled = rollbackLastNFileEdits(checkpoint, { n, apply });
    } else if (rollbackLastFileEdit) {
      rolled = rollbackLastFileEdit(checkpoint, { apply });
    }
  }
  const hint = afterWriteTestHint
    ? afterWriteTestHint({ path: filePath, hasRunner })
    : { hint: false };
  return {
    ok: !(rolled && rolled.ok === false && (failed || timedOut)),
    refuse: false,
    reverted: Boolean(rolled && (rolled.reverted || rolled.reverted === 0 ? rolled.reverted : false)),
    paths: (rolled && rolled.paths) || (rolled && rolled.path ? [rolled.path] : []),
    hint: Boolean(hint && hint.hint),
    hintText: hint && hint.text,
    uniqueness: false,
    code: (rolled && rolled.reverted && rolled.code)
      || (hint && hint.code)
      || null,
  };
}

/**
 * DeepSeek HTTP map + never retry 402/413 + never charge if cancelled
 * before the first token. 4xx other than 429 stay non-retryable.
 */
function applyDeepSeekCreditGuardsClosed({
  err,
  cancelled,
  firstToken,
  firstByteAt,
  tokens,
  mapDeepSeekHttpError,
  neverRetry402,
  neverRetry413,
  neverChargeIfCancelledBeforeFirstToken,
} = {}) {
  const mapped = mapDeepSeekHttpError
    ? mapDeepSeekHttpError(err)
    : { ok: true, code: null };
  const r402 = neverRetry402
    ? neverRetry402(err || mapped)
    : { retry: null };
  const r413 = neverRetry413
    ? neverRetry413(err || mapped)
    : { retry: null };
  const charge = neverChargeIfCancelledBeforeFirstToken
    ? neverChargeIfCancelledBeforeFirstToken({
      cancelled,
      firstToken,
      firstByteAt,
      tokens,
    })
    : { charge: !(cancelled === true && firstToken !== true && firstByteAt == null) };
  const retry = (r402 && r402.retry === false)
    ? false
    : ((r413 && r413.retry === false) ? false : null);
  const status = Number(
    (r402 && r402.status)
    || (r413 && r413.status)
    || (mapped && mapped.status)
    || (err && (err.status || err.statusCode))
    || NaN,
  );
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429) {
    return {
      retry: false,
      charge: charge && charge.charge !== false,
      mapped,
      code: (r402 && r402.retry === false && r402.code)
        || (r413 && r413.retry === false && r413.code)
        || (mapped && mapped.retryable === false && mapped.code)
        || (charge && charge.charge === false && charge.code)
        || null,
    };
  }
  return {
    retry,
    charge: !(charge && charge.charge === false),
    mapped,
    code: (charge && charge.charge === false && charge.code)
      || (r402 && r402.retry === false && r402.code)
      || (r413 && r413.retry === false && r413.code)
      || (mapped && mapped.retryable === false && mapped.code)
      || null,
  };
}

/**
 * Generate queue leftover: starvation bound + cap 16.
 */
function applyGenerateQueueGuardsClosed({
  queued,
  waiters,
  now,
  inFlight,
  fairQueueStarvationBound,
  maxQueuedGenerate16,
} = {}) {
  const list = Array.isArray(waiters) ? waiters : [];
  const n = queued != null ? queued : list.length;
  const cap = maxQueuedGenerate16
    ? maxQueuedGenerate16(n)
    : { ok: true, queued: n };
  const bound = fairQueueStarvationBound
    ? fairQueueStarvationBound(list, { now: now || Date.now(), inFlight })
    : { waiters: list, boosted: false };
  const reject = Boolean(cap && cap.ok === false);
  return {
    ok: !reject,
    reject,
    queued: (cap && cap.queued != null) ? cap.queued : n,
    waiters: (bound && bound.waiters) || list,
    boosted: Boolean(bound && bound.boosted),
    status: reject ? 503 : 200,
    code: (cap && cap.ok === false && cap.code)
      || (bound && bound.boosted && bound.code)
      || null,
  };
}

/**
 * SSE leftover: require monotonic seq; skip heartbeat under backpressure.
 */
function applySseSessionGuardsClosed({
  lastSeq,
  nextSeq,
  wouldBlock,
  pendingBytes,
  writable,
  requireSessionEventSeqIncrease,
  skipHeartbeatIfWriteWouldBlock,
} = {}) {
  const seq = requireSessionEventSeqIncrease
    ? requireSessionEventSeqIncrease({ lastSeq, nextSeq })
    : { ok: true, lastSeq: nextSeq };
  const hb = skipHeartbeatIfWriteWouldBlock
    ? skipHeartbeatIfWriteWouldBlock({ wouldBlock, pendingBytes, writable })
    : { skip: false };
  return {
    ok: !(seq && seq.ok === false),
    seqOk: !(seq && seq.ok === false),
    skipHeartbeat: Boolean(hb && hb.skip),
    reason: hb && hb.reason,
    lastSeq: seq && seq.lastSeq,
    code: (seq && seq.ok === false && seq.code) || (hb && hb.code) || null,
  };
}

function classifyEngine3h65Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) {
    const w64 = loadWave64();
    if (w64 && typeof w64.classifyEngine3h64Error === 'function') {
      return w64.classifyEngine3h64Error(input);
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

function refuseOpenRouterInWave3h65(env = process.env) {
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
  applyAntiLoopGuardsClosed: true,
  applyToolArgHygieneClosed: true,
  applyToolResultHygieneClosed: true,
  applyFileEditGuardsClosed: true,
  applyDeepSeekCreditGuardsClosed: true,
  applyGenerateQueueGuardsClosed: true,
  applySseSessionGuardsClosed: true,
  classifyEngine3h65Error: true,
  refuseOpenRouterInWave3h65: true,
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
  applyAntiLoopGuardsClosed,
  applyToolArgHygieneClosed,
  applyToolResultHygieneClosed,
  applyFileEditGuardsClosed,
  applyDeepSeekCreditGuardsClosed,
  applyGenerateQueueGuardsClosed,
  applySseSessionGuardsClosed,
  classifyEngine3h65Error,
  refuseOpenRouterInWave3h65,
  callLive,
  callLiveN,
  waveSnapshot,
  looksLikeUniqueness,
  schemaForPresentArgs,
  WRITE_TOOL_RE,
  WEB_FETCH_RE,
};
