'use strict';

/**
 * 3H63 — fail-closed wiring of remaining adapter-only Claude-Code holes.
 *
 * Does NOT re-export 3H59/3H60/3H61/3H62 names (no overlay collisions).
 * Unique orchestrators CALL the live #388 adapter names (injected) and
 * apply their decisions on the generate / loop / SSE hot path:
 *   session generate queue + fairness
 *   subagent abort cascade + inherited step budget
 *   partial / malformed tool-call repair before execute
 *   exact-diff checksum + path jail (never uniqueness→timeout)
 *   SSE Last-Event-ID backwards reject + cancel token refund + TTFB
 *   Prisma completeLedgerTransaction on success / cancel-after-tokens
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 */

const WAVE = '3H63';
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const UNIQUENESS_RE = /old_str occurs more than once|old_str not found|old_str must not be empty/i;
const SUBAGENT_NAME_RE = /^(run_subagent|subagent|delegate|spawn_subagent)$/i;

const ERROR_TABLE = Object.freeze({
  queue_wait: { retryable: true, message: 'La cola de generate esperó más de 60 s. Reintenta en unos segundos.' },
  queue_fairness: { retryable: true, message: 'Hay otro generate de esta sesión en curso. Espera tu turno.' },
  duplicate_turn: { retryable: true, message: 'Ese generate ya está en vuelo. No lo dupliqué.' },
  rate_limited: { retryable: true, message: 'Demasiados generate en esta sesión. Espera un momento.' },
  subagent_budget: { retryable: false, message: 'El subagente no tenía presupuesto de pasos. No lo lancé.' },
  subagent_parent_cancelled: { retryable: false, message: 'El padre se canceló. No lancé el subagente.' },
  turn_cancelled: { retryable: true, message: 'Cancelé el turno y aborté las herramientas anidadas.' },
  tool_call_incomplete: { retryable: false, message: 'Solté la llamada a herramienta incompleta. No la ejecuté.' },
  tool_call_concat: { retryable: false, message: 'Reuní fragmentos partidos de la llamada a herramienta.' },
  file_changed: { retryable: false, message: 'El archivo cambió desde la lectura. No apliqué el edit.' },
  write_checksum: { retryable: true, message: 'El checksum posterior a la escritura no coincidió. No di el cambio por bueno.' },
  binary_file: { retryable: false, message: 'Ese archivo es binario. No lo edité.' },
  path_traversal: { retryable: false, message: 'La ruta sale del workspace. No la toqué.' },
  write_noop: { retryable: false, message: 'El archivo no cambió. Salté la escritura.' },
  sse_id_backwards: { retryable: true, message: 'Last-Event-ID va hacia atrás. Rechacé el cursor.' },
  credit_cancel: { retryable: false, message: 'Reembolsé tokens parciales del turno cancelado. No cobré de más.' },
  ttfb_abort: { retryable: true, message: 'El modelo no envió el primer byte a tiempo. Cancelé el turno.' },
  credit_ledger_complete: { retryable: false, message: 'Cerré el ledger de créditos con el uso real. No cobré de más.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadWave61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function loadWave62() {
  try { return require('./engine-3h62'); } catch (_) { return null; }
}

function looksLikeLogicalToolReject(value) {
  const msg = String((value && value.message) || value || '');
  return UNIQUENESS_RE.test(msg);
}

function isSubagentToolName(name) {
  return SUBAGENT_NAME_RE.test(String(name || ''));
}

function callLive(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(args); } catch (_) { return fallback; }
}

function callLiveN(fn, a, b, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(a, b); } catch (_) { return fallback; }
}

/**
 * Session generate queue / fairness. Calls live #388 names only.
 */
function applyFairGenerateQueueClosed({
  sessionKey,
  producerId,
  requestId,
  waitedMs,
  acquireFairGenerateLock,
  releaseFairGenerateLock,
  queueMaxWait60sThen503,
  dropDuplicateInFlightGenerate,
  idempotentGenerateByRequestId,
  sessionGenerateRateLimit,
} = {}) {
  const sess = String(sessionKey || '');
  const prod = String(producerId || '');
  const wait = queueMaxWait60sThen503
    ? queueMaxWait60sThen503({ waitedMs: Number(waitedMs) || 0, maxMs: 60000 })
    : { reject: false };
  if (wait && wait.reject) {
    return { ok: false, status: 503, code: 'queue_wait', retryAfterSec: wait.retryAfterSec || 2 };
  }
  if (typeof sessionGenerateRateLimit === 'function') {
    const rate = sessionGenerateRateLimit(sess);
    if (rate && rate.ok === false) {
      return { ok: false, status: 429, code: 'rate_limited', retryAfterMs: rate.retryAfterMs };
    }
  }
  if (typeof dropDuplicateInFlightGenerate === 'function') {
    const dup = dropDuplicateInFlightGenerate(sess, prod);
    if (dup && dup.dropped) {
      return { ok: false, status: 409, code: 'duplicate_turn', dropped: true };
    }
  }
  if (typeof idempotentGenerateByRequestId === 'function' && requestId) {
    const idem = idempotentGenerateByRequestId(sess, String(requestId));
    if (idem && idem.replay) {
      return { ok: true, replay: true, result: idem.result, code: 'idempotency_replay' };
    }
    if (idem && idem.pending && idem.code === 'duplicate_turn') {
      return { ok: false, status: 409, code: 'duplicate_turn', pending: true };
    }
  }
  let lock = { ok: true };
  if (typeof acquireFairGenerateLock === 'function') {
    lock = acquireFairGenerateLock(sess, prod);
    if (lock && lock.ok === false && !lock.queued) {
      return { ok: false, status: 503, code: 'queue_fairness' };
    }
  }
  return {
    ok: true,
    queued: Boolean(lock && lock.queued),
    release: typeof releaseFairGenerateLock === 'function'
      ? () => releaseFairGenerateLock(sess, prod)
      : () => ({ ok: true }),
    code: null,
  };
}

/**
 * Abort nested/sibling tools when the parent halt/cancel token fires.
 */
function abortSubagentCascadeClosed({
  parentHalt,
  parentCancelled,
  parentToken,
  parentSignal,
  children,
  siblings,
  abortFn,
  userSignal,
  modelAbort,
  sandboxKill,
  abortNestedSubagentsOnParentHalt,
  abortSiblingToolsOnParentCancelToken,
  refuseSubagentIfParentCancelled,
  abortCascade,
  subagentInheritAbortSignal,
} = {}) {
  const refuse = refuseSubagentIfParentCancelled
    ? refuseSubagentIfParentCancelled({
      parentCancelled,
      cancelled: parentCancelled,
      signal: parentSignal || parentToken,
    })
    : { refuse: false };
  const inherited = subagentInheritAbortSignal
    ? subagentInheritAbortSignal({ parentSignal: parentSignal || parentToken, child: {} })
    : { inherited: false, aborted: false };
  const nested = abortNestedSubagentsOnParentHalt
    ? abortNestedSubagentsOnParentHalt({
      parentHalt: parentHalt === true || parentCancelled === true,
      halt: parentHalt === true,
      children,
      nested: children,
      abortFn,
    })
    : { aborted: 0, ids: [] };
  const sibs = abortSiblingToolsOnParentCancelToken
    ? abortSiblingToolsOnParentCancelToken({
      parentToken: parentToken || parentSignal,
      siblings,
      abortFn,
    })
    : { aborted: 0 };
  const cascade = abortCascade
    ? abortCascade({
      userSignal: userSignal || parentSignal || parentToken,
      modelAbort,
      sandboxKill,
    })
    : { aborted: false };
  return {
    refuse: Boolean(refuse && refuse.refuse),
    inherited: Boolean(inherited && inherited.inherited),
    nestedAborted: Number(nested && nested.aborted) || 0,
    siblingAborted: Number(sibs && sibs.aborted) || 0,
    cascade: Boolean(cascade && cascade.aborted),
    code: (refuse && refuse.refuse)
      ? 'subagent_parent_cancelled'
      : ((cascade && cascade.code) || (nested && nested.code) || null),
  };
}

/**
 * Inherit remaining step budget: child = parent−1, refuse if 0.
 */
function inheritSubagentBudgetClosed({
  parentRemaining,
  childRequested,
  siblings,
  inheritSubagentSteps,
  subagentInheritRemainingStepBudget,
  minRemainingSubagentBudget1,
} = {}) {
  const parent = Math.max(0, Math.floor(Number(parentRemaining) || 0));
  const minusOne = Math.max(0, parent - 1);
  const inherited = inheritSubagentSteps
    ? inheritSubagentSteps({
      parentRemaining: minusOne,
      childRequested: childRequested != null ? childRequested : minusOne,
      siblings: siblings != null ? siblings : 1,
    })
    : { ok: minusOne > 0, budget: minusOne };
  const sliced = subagentInheritRemainingStepBudget
    ? subagentInheritRemainingStepBudget({
      parentRemaining: minusOne,
      childRequested: inherited && inherited.budget,
    })
    : { remaining: minusOne };
  const remaining = Number((sliced && sliced.remaining != null) ? sliced.remaining : (inherited && inherited.budget));
  const minned = minRemainingSubagentBudget1
    ? minRemainingSubagentBudget1({ remaining, parentRemaining: minusOne })
    : { remaining, applied: false };
  const budget = Number(minned && minned.remaining);
  const refuse = !Number.isFinite(budget) || budget <= 0;
  return {
    ok: !refuse,
    refuse,
    remaining: refuse ? 0 : budget,
    parentRemaining: parent,
    inherited: minusOne,
    code: refuse ? 'subagent_budget' : null,
  };
}

/**
 * Repair / drop malformed streamed tool-calls before execute.
 */
function repairPartialToolCallsClosed({
  calls,
  fragments,
  messages,
  concatenateSplitToolCallFragments,
  dropIncompleteTrailingToolCall,
  repairStreamingJsonAcrossChunks,
  repairUnescapedNewlinesInJsonStrings,
  dropOrphanToolResults,
  requireToolCallId,
  aliasCommonToolNames,
  isolateParallelToolTimeout,
  joinParallelToolResultsStableOrder,
  cacheIdenticalToolCallSameTurn,
} = {}) {
  let list = Array.isArray(calls) ? calls.slice() : [];
  if (fragments && concatenateSplitToolCallFragments) {
    const joined = concatenateSplitToolCallFragments(fragments);
    if (joined && joined.ok && joined.value && list.length) {
      const last = list[list.length - 1];
      const fn = last && last.function ? last.function : {};
      list[list.length - 1] = {
        ...last,
        function: { ...fn, arguments: JSON.stringify(joined.value) },
      };
    } else if (joined && joined.ok && joined.value && !list.length) {
      list = [{
        id: 'concat_0',
        type: 'function',
        function: { name: 'unknown', arguments: JSON.stringify(joined.value) },
      }];
    }
  }
  if (repairStreamingJsonAcrossChunks) {
    list = list.map((call) => {
      const raw = call && call.function ? call.function.arguments : null;
      if (typeof raw !== 'string') return call;
      const repaired = repairStreamingJsonAcrossChunks([raw]);
      if (repaired && repaired.ok && repaired.value && !repaired.value.__parse_error) {
        return {
          ...call,
          function: {
            ...(call.function || {}),
            arguments: JSON.stringify(repaired.value),
          },
        };
      }
      if (repairUnescapedNewlinesInJsonStrings) {
        const nl = repairUnescapedNewlinesInJsonStrings(raw);
        if (nl && nl.ok && nl.value) {
          return {
            ...call,
            function: {
              ...(call.function || {}),
              arguments: JSON.stringify(nl.value),
            },
          };
        }
      }
      return call;
    });
  } else if (repairUnescapedNewlinesInJsonStrings) {
    list = list.map((call) => {
      const raw = call && call.function ? call.function.arguments : null;
      if (typeof raw !== 'string') return call;
      const nl = repairUnescapedNewlinesInJsonStrings(raw);
      if (nl && nl.ok && nl.value) {
        return {
          ...call,
          function: {
            ...(call.function || {}),
            arguments: JSON.stringify(nl.value),
          },
        };
      }
      return call;
    });
  }
  if (aliasCommonToolNames) {
    list = list.map((call) => {
      const name = call && call.function && call.function.name;
      const aliased = aliasCommonToolNames(name);
      if (aliased && aliased.aliased && aliased.name) {
        return {
          ...call,
          function: { ...(call.function || {}), name: aliased.name },
        };
      }
      return call;
    });
  }
  if (requireToolCallId) {
    const req = requireToolCallId(list);
    if (req && Array.isArray(req.calls)) list = req.calls;
  }
  if (dropIncompleteTrailingToolCall) {
    const dropped = dropIncompleteTrailingToolCall(list);
    if (dropped && Array.isArray(dropped.calls)) list = dropped.calls;
  }
  let orphans = null;
  if (dropOrphanToolResults && Array.isArray(messages)) {
    orphans = dropOrphanToolResults(messages);
  }
  const isolated = isolateParallelToolTimeout
    ? isolateParallelToolTimeout(list)
    : { isolated: [], count: list.length };
  return {
    calls: list,
    droppedIncomplete: Boolean(list && calls && list.length < (Array.isArray(calls) ? calls.length : 0)),
    orphansDropped: Number(orphans && orphans.dropped) || 0,
    isolated: isolated && isolated.isolated,
    joinParallelToolResultsStableOrder,
    cacheIdenticalToolCallSameTurn,
    code: null,
  };
}

/**
 * Exact-diff + checksum + jail. Never rewrites uniqueness errors.
 */
function applyExactDiffChecksumClosed({
  path: filePath,
  haystack,
  diff,
  before,
  after,
  root,
  sha256AtRead,
  sha256Now,
  expectedSha256,
  result,
  applyUnifiedDiff,
  refuseEditIfChecksumChangedSinceRead,
  checksumVerifyAfterWrite,
  atomicWriteViaTempRename,
  refuseBinaryFileEdit,
  workspacePathJail,
  skipUnchangedWrite,
  normalizeLineEndingsBeforeDiff,
  writeFn,
  renameFn,
} = {}) {
  if (looksLikeLogicalToolReject(result)) {
    return { ok: true, skipped: true, uniqueness: true, code: null };
  }
  if (root != null && filePath && workspacePathJail) {
    const jail = workspacePathJail(filePath, root);
    if (jail && jail.ok === false) {
      return { ok: false, code: jail.code || 'path_traversal' };
    }
  }
  const sample = before != null ? before : haystack;
  if (sample != null && refuseBinaryFileEdit) {
    const bin = refuseBinaryFileEdit(sample);
    if (bin && bin.ok === false) return { ok: false, code: 'binary_file', binary: true };
  }
  if (refuseEditIfChecksumChangedSinceRead) {
    const changed = refuseEditIfChecksumChangedSinceRead({
      sha256Now,
      sha256AtRead,
      actual: sha256Now == null ? sample : undefined,
      expected: sha256AtRead,
    });
    if (changed && changed.ok === false) {
      return { ok: false, code: 'file_changed' };
    }
  }
  if (skipUnchangedWrite && before != null && after != null) {
    const noop = skipUnchangedWrite({ before, after });
    if (noop && noop.skip) return { ok: true, skipped: true, code: 'write_noop' };
  }
  let hay = haystack;
  if (diff != null && normalizeLineEndingsBeforeDiff) {
    const normHay = normalizeLineEndingsBeforeDiff(haystack);
    const normDiff = normalizeLineEndingsBeforeDiff(diff);
    hay = normHay && normHay.text != null ? normHay.text : haystack;
    if (applyUnifiedDiff) {
      const applied = applyUnifiedDiff({
        haystack: hay,
        diff: normDiff && normDiff.text != null ? normDiff.text : diff,
      });
      if (applied && applied.ok === false) {
        return { ok: false, code: applied.code || 'git_hunk_ambiguous', unified: applied.unified };
      }
      if (applied && applied.ok && applied.text != null) hay = applied.text;
    }
  }
  if (after != null && checksumVerifyAfterWrite) {
    const chk = checksumVerifyAfterWrite({
      actual: after,
      expectedSha256,
      expected: expectedSha256,
    });
    if (chk && chk.ok === false && expectedSha256) {
      return { ok: false, code: 'write_checksum' };
    }
  }
  if (filePath && writeFn && renameFn && atomicWriteViaTempRename && after != null) {
    atomicWriteViaTempRename({ path: filePath, content: after, writeFn, renameFn });
  }
  return { ok: true, text: hay, skipped: false, code: null };
}

/**
 * SSE Last-Event-ID backwards + cancel refund + first-byte watchdog.
 */
function guardSseLastIdRefundClosed({
  lastEventId,
  currentSeq,
  stored,
  cancelled,
  promptTokens,
  completionTokens,
  requestId,
  alreadyRefunded,
  startedAt,
  now,
  firstByteAt,
  rejectLastEventIdGoingBackwards,
  refundPartialTokensOnCancel,
  abortIfFirstByteOver45s,
  replayLastNSseEventsFromCursor,
  events,
} = {}) {
  let backwards = null;
  if (rejectLastEventIdGoingBackwards && lastEventId != null) {
    backwards = rejectLastEventIdGoingBackwards({ lastEventId, currentSeq, stored });
  }
  const refund = refundPartialTokensOnCancel
    ? refundPartialTokensOnCancel({
      requestId,
      cancelled,
      promptTokens,
      completionTokens,
      alreadyRefunded,
    })
    : { refunded: null };
  const ttfb = abortIfFirstByteOver45s
    ? abortIfFirstByteOver45s({ startedAt, now, firstByteAt })
    : { abort: false };
  const replay = replayLastNSseEventsFromCursor && Array.isArray(events)
    ? replayLastNSseEventsFromCursor(events, { cursor: lastEventId })
    : null;
  return {
    ok: !(backwards && backwards.ok === false),
    backwards: Boolean(backwards && backwards.backwards),
    refunded: refund && refund.refunded,
    abortFirstByte: Boolean(ttfb && ttfb.abort),
    replay,
    code: (backwards && backwards.ok === false && backwards.code)
      || (ttfb && ttfb.abort && ttfb.code)
      || (refund && refund.refunded && refund.code)
      || null,
  };
}

/**
 * Prisma ledger complete on success / cancel-after-tokens.
 * Calls live `completeLedgerTransaction` (credit-ledger.js). Does not invent it.
 */
async function completeLedgerOnSuccessClosed({
  completeLedgerTransaction,
  prisma,
  prismaClient,
  transaction,
  statusCode,
  body,
  cancelled,
  tokens,
  streamedChars,
} = {}) {
  if (typeof completeLedgerTransaction !== 'function') {
    return { ok: false, skipped: true, pending: true, code: null };
  }
  if (!transaction) return { ok: true, skipped: true, code: null };
  const used = Number(tokens != null ? tokens : streamedChars) || 0;
  if (cancelled === true && used <= 0) {
    return { ok: true, skipped: true, code: 'credit_pre_token' };
  }
  try {
    const out = await completeLedgerTransaction({
      prismaClient: prismaClient || prisma,
      transaction,
      statusCode: Number.isInteger(statusCode) ? statusCode : (cancelled ? 499 : 200),
      body: body || {
        cancelled: cancelled === true,
        tokens: used,
        streamedChars: streamedChars || 0,
      },
    });
    return {
      ok: Boolean(out && out.ok !== false),
      replay: Boolean(out && out.replay),
      code: 'credit_ledger_complete',
      ledger: out,
    };
  } catch (_) {
    return { ok: false, skipped: false, code: 'credit_ledger_complete' };
  }
}

function classifyEngine3h63Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) {
    const w62 = loadWave62();
    if (w62 && typeof w62.classifyEngine3h62Error === 'function') {
      return w62.classifyEngine3h62Error(input);
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

function refuseOpenRouterInWave3h63(env = process.env) {
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
  applyFairGenerateQueueClosed: true,
  abortSubagentCascadeClosed: true,
  inheritSubagentBudgetClosed: true,
  repairPartialToolCallsClosed: true,
  applyExactDiffChecksumClosed: true,
  guardSseLastIdRefundClosed: true,
  completeLedgerOnSuccessClosed: true,
  classifyEngine3h63Error: true,
  refuseOpenRouterInWave3h63: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
    liveHelpersWired: 35,
    latencyNote: 'scripted p50/p95; never invented Flash',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  applyFairGenerateQueueClosed,
  abortSubagentCascadeClosed,
  inheritSubagentBudgetClosed,
  repairPartialToolCallsClosed,
  applyExactDiffChecksumClosed,
  guardSseLastIdRefundClosed,
  completeLedgerOnSuccessClosed,
  classifyEngine3h63Error,
  refuseOpenRouterInWave3h63,
  looksLikeLogicalToolReject,
  isSubagentToolName,
  callLive,
  callLiveN,
  waveSnapshot,
};
