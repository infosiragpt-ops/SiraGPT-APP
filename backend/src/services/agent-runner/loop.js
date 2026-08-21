'use strict';

const { throwIfAborted } = require('../../utils/abort-signals');
let activityTextFor;
try { ({ activityTextFor } = require('../agents/activity-labels')); }
catch (_) { activityTextFor = ({ thought, label }) => thought || label || 'Pensando…'; }
const { parseReact, looksLikeToolUnsupportedError } = require('./react');
const {
  MAX_VERIFICATION_RETRIES,
  needsVerification,
  verificationNudge,
} = require('./verify');
const {
  repairToolArgs,
  normalizeToolCalls,
  isTransientLlmError,
  backoffMs,
  createRepeatGuard,
  createStepBudget,
  pinCriticalFacts,
  compactMessagesIfNeeded,
  createCheckpoint,
  createUsageAccumulator,
  classifyLoopError,
  sleep,
  observeFirstToken,
  observeTurnEnd,
  STEP_BUDGET_DEFAULT,
} = require('./engine-reliability');
const {
  retrieveMemoryForLoop,
  memoryHitsToPins,
  restoreMessagesFromCheckpoint,
  canRunToolsInParallel,
  persistUsage,
} = require('./engine-durability');
const {
  validateToolArgs,
  toolSchemaFor,
  aclMemoryHits,
  createResumeLock,
  assertResumeSafe,
  observeToolExec,
} = require('./engine-hardening');
const {
  coerceToolArgs,
  createSessionFence,
  createRetryTracker,
  filterMemoryByScore,
  assertFenceSafe,
} = require('./engine-next');
const {
  heartbeatFence,
  stealStaleFence,
  rankMemoryByScoreRecency,
  withToolTimeout,
  toolTimeoutMs,
  assertToolEnum,
  scheduleDlqReplay,
  assertCreditCeiling,
} = require('./engine-layer');
const {
  stealStaleFenceMetered,
  recordFenceSteal,
  enforceCreditCeiling,
  cleanupTmpfsOnCancel,
  scheduleDlqReplayCapped,
} = require('./engine-ops');
const {
  assertTurnWallClock,
  mapToolAlias,
  capToolResult,
  isolateParallelTools,
  createErrorBudget,
  createToolCircuit,
  createCreditHold,
  observeFirstByte,
  dedupMemoryHits,
  evictPinsLru,
} = require('./engine-parity');
const {
  repairToolCallWithFeedback,
  createToolRepairBudget,
  assertTurnTokenBudget,
  evaluateStopConditions,
  createStepTelemetry,
} = require('./engine-control');
const {
  resolveSubagentType,
  sliceSubagentBudget,
  assertSubagentToolAllowed,
  filterExecutorsForSubagent,
  sleepTimeCompact,
} = require('./engine-advance');
const {
  retrieveBeforeGenerate,
  autoResumeLatest,
  casSwapLatest,
  checkpointStateWithPins,
  restorePinsFromCheckpoint,
  accountCreditsOnCancel,
  remainingPlanBudget,
  observeRealFirstByte,
  persistFirstByteSamples,
} = require('./engine-integrity');
const {
  capToolStorm,
  runToolStorm,
  compactPreservingPairs,
  createNDeepCheckpoint,
  beginConcurrentTurn,
  endConcurrentTurn,
  normalizePartialToolCall,
} = require('./engine-completion');
const {
  detectLoopStall,
  withIdleCut,
  inheritParentRemaining,
  repairMalformedToolTurn,
  evictPinsKeepingCritical,
  compactKeepingSystemAndPins,
  createExactlyOnceToolStore,
  holdCreditsOnce,
  settleStormCancel,
  startExecHeartbeat,
  observeInflightMs,
} = require('./engine-resilience');
const {
  stopWhenParentExhausted,
  capToolResultWithHash,
  resolveUnknownTool,
  compactKeepLastToolErrors,
  startToolHeartbeat,
  extractUsageOrRelease,
  creditOnLlmFailure,
  classifyTurnSuperseded,
} = require('./engine-correctness');
const {
  rewriteUnknownToNearest,
  repairToolCallSchema,
  pinAcrossCompact,
  searchableMemoryHook,
  createInFlightRegistry,
  cancelMidStream,
  verifyStrReplace,
  startFirstTokenWatchdog,
  mapProviderHttp,
  createEventOrderGate,
  recordToolResultOnce,
} = require('./engine-lifecycle');
const {
  retryToolWithBackoff,
  createConsecutiveRepeatCut,
  sessionRemainingSteps,
  compactDropStaleBodies,
  rollbackLastFileEdit,
  rememberFileEdit,
  fuzzyWhitespaceReplace,
  capCommandStdout,
  tmpCleanupOnCancel,
  dropDuplicateInFlightGenerate,
  creditOnToolError,
  recordTurnToolCount,
  classifyToolFailure,
  sanitizeClientError,
  denyDangerousGenerateTools,
  claimPathMutation,
  emptyResponseRetryOnce,
  replaySameCallId,
  rememberCallResult,
  abortCascade,
  expireGatewayClaimTtl,
  touchGatewayClaim,
  overlayToolTimeoutMs,
  formatRemainingBudgetHint,
  afterWriteTestHint,
  dedupConsecutiveAssistantCalls,
  repairTruncatedJson,
  coerceStringyPrimitives,
  observeAdapterLatency,
  compactKeepLastNBodies,
  formatReadWithLineNumbers,
  redactSecretsInToolResult,
  refuseBinaryRead,
  filterGlobHits,
  workspacePathJail,
  allowDeepSeekGenerateModel,
  sessionGenerateRateLimit,
  capToolArgBytes,
  maxToolCallsPerMessage,
  classifyStopReason,
  webFetchGuard,
  injectProjectInstructions,
  expireAndSweepPins,
  skipUnchangedWrite,
  runPreToolHook,
  snapshotPartialOnAbort,
  reapBackgroundBashOnAbort,
  guardUserRoleSpoof,
  clampToolResultWithHash,
  rankPgvectorHits,
  rollbackLastNFileEdits,
  appendTokenAuditLog,
  acquireFairGenerateLock,
  lookupGetLikeToolCache,
  storeGetLikeToolCache,
  invalidateToolCacheOnWrite,
  splitModelVsToolTimeout,
  stripAdditionalProperties,
  rejectSymlinkEscape,
  refundZeroTokenError,
  compactUntilTokenBudget,
  inheritSubagentSteps,
  acquireCrossProcessFileLock,
  ensureUniqueToolCallIds,
  dropOrphanToolResults,
  repairStreamingJsonAcrossChunks,
  applyUnifiedDiff,
  splitStdoutStderrToolResult,
  holdThenSettleCredits,
  settleCreditHold,
  releaseCreditHold,
  replayToolResultsOnResume,
  compactKeepPinnedSiragptAndLastUser,
  dropCancelledRunEvents,
  markRunCancelled,
  perToolRateLimit,
  capImagePdfInContext,
  clampMaxTokensToRemainingContext,
  estimateCompactTokens,
  clockSkewSafeTtl,
  idempotentGenerateByRequestId,
  rememberGenerateByRequestId,
  allowlistToolName,
  coerceNestedArrayObjectTypes,
  createIfMissingOrRefuseLargeOverwrite,
  settleCreditHoldIfStreamOpened,
  dropDuplicateSystemPrompts,
  skipEmptyWhitespaceMemoryFacts,
  stopIfFinalTextWithTools,
  gzipToolResultOverSize,
  redactUrlsWithCredentials,
  mapDeepSeekHttpError,
  createIdenticalObservationLoopCut,
  abortSiblingsOnParentCancel,
  validateEnumArgs,
  truncateOverlongArgStrings,
  cacheIdenticalToolCallSameTurn,
  detectDagCycle,
  remainingStepBudgetReminder,
  compactKeepToolCallResultPairs,
  minScoreMemoryRetrieve,
  checkpointAfterSuccessfulWrite,
  refuseBinaryFileEdit,
  normalizeLineEndingsBeforeDiff,
  skipCompactIfUnderBudget,
  refundPartialTokensOnCancel,
  classifyNetErrors,
  maxConcurrentToolsPerTurn,
  subagentResultSizeCap,
  repairMissingRequiredFromPriorTurn,
  validateToolResultShape,
  toolTimeoutFitsRemainingBudget,
  createDeadLetterSameToolAfterN,
  injectPlanProgressLine,
  compactPreserveLastErrors,
  pinCriticalFacts: pinCriticalFactsTagged,
  checkpointCasSeq,
  checksumVerifyAfterWrite,
  syntaxCheckJsPyAfterWrite,
  rejectControlCharsInPaths,
  createFileExclusive,
  redactHomePathsInResults,
  ssePingOnIdleTool,
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
  idempotentSameCallIdInflight,
  skipDuplicateWebFetchSameUrlTurn,
  settleCreditsIfClientGone,
  classifyJsonParseErrors,
  classifyAbortErrors,
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
  skipGlobIfMatchCap,
  firstTokenWatchdogMs,
  redactIpv4InPublicErrors,
  classifyEpipeAsCancelled,
  neverChargeOnUnauthorized,
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
} = require('./engine-adapter');

const MAX_ITERATIONS_DEFAULT = 25;

// Keep tool-call turns SHORT. Providers reserve max_tokens up front;
// a large reservation (3072+) 402s a low balance. 1500 is enough for a
// tool call + args on native deepseek-v4-flash. Never OpenRouter.
const MAX_TOKENS_DEFAULT = 1500;
const LLM_RETRY_MAX = 3;

function resolveAgentRunnerMaxTokens(env = process.env) {
  const raw = Number(env.SIRAGPT_AGENT_RUNNER_MAX_TOKENS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(256, Math.min(8192, Math.floor(raw)));
  }
  return MAX_TOKENS_DEFAULT;
}

/**
 * Out-of-credit detection for OpenRouter (HTTP 402 / "can only afford") and
 * Anthropic ("credit balance is too low"). These are NOT transient: retrying
 * burns latency without any chance of success, so the loop must stop
 * immediately and surface the reason.
 */
function isLlmCreditError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || err.response?.status || (err.code === 402 ? 402 : NaN));
  if (status === 402) return true;
  const message = String(err.message || err.error?.message || '').toLowerCase();
  return /\b402\b|credit balance is too low|insufficient credits?|requires more credits|can only afford|payment required/i.test(message);
}

function previewOf(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeParseArgs(raw) {
  const repaired = repairToolArgs(raw);
  if (repaired.ok) return repaired.value;
  return { __parse_error: true, raw: String(raw).slice(0, 500) };
}

function asNativeCalls(calls, iteration) {
  return calls.map((c, idx) => ({
    id: `react_${iteration}_${idx}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
  }));
}

async function callModel({ client, model, messages, tools, signal, maxTokens }) {
  let max_tokens = maxTokens || resolveAgentRunnerMaxTokens();
  try {
    const used = estimateCompactTokens(messages);
    const clamped = clampMaxTokensToRemainingContext({ maxTokens: max_tokens, used, contextWindow: 128000 });
    if (clamped && clamped.maxTokens) max_tokens = clamped.maxTokens;
    const outCap = clampMaxOutputTokens(max_tokens, { max: 8192 });
    if (outCap && outCap.maxTokens) max_tokens = outCap.maxTokens;
  } catch (_) {}
  const create = (useModel, withTools) => client.chat.completions.create({
    model: useModel,
    messages,
    ...(withTools ? { tools, tool_choice: 'auto' } : {}),
    max_tokens,
  }, signal ? { signal } : undefined);

  const attemptOnce = async (useModel) => {
    try {
      return await create(useModel, true);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (!looksLikeToolUnsupportedError(err)) throw err;
      return create(useModel, false);
    }
  };

  const withTransientRetry = async (useModel) => {
    let lastErr;
    for (let attempt = 0; attempt < LLM_RETRY_MAX; attempt += 1) {
      if (signal?.aborted) throwIfAborted(signal);
      try {
        return await attemptOnce(useModel);
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        if (isLlmCreditError(err)) throw err;
        try {
          const mapped = mapProviderHttp(err);
          const net = classifyNetErrors(err);
          const fam = classifyHttpFamily(err);
          if (fam && fam.family === 'timeout') throw Object.assign(err, { code: fam.code, publicMessage: fam.code });
          if (fam && fam.family === '5xx') throw Object.assign(err, { code: fam.code, publicMessage: fam.code });
          if (net && net.code) throw Object.assign(err, { code: net.code, publicMessage: net.message });
          try { recordTokenUsageOnErrorPath({ usage: err && err.usage, error: err, noCompletion: true }); } catch (_) {}
          const ds = mapDeepSeekHttpError(err);
          if (ds && ds.code === 'credit_ceiling') throw Object.assign(err, { code: ds.code, publicMessage: ds.message });
          if (ds && ds.code === 'rate_limited' && attempt >= LLM_RETRY_MAX - 1) throw Object.assign(err, { code: ds.code, publicMessage: ds.message });
          if (mapped && mapped.code === 'provider_auth') throw Object.assign(err, { code: mapped.code, publicMessage: mapped.message });
          if (mapped && mapped.code === 'rate_limited' && attempt >= LLM_RETRY_MAX - 1) throw Object.assign(err, { code: mapped.code, publicMessage: mapped.message });
        } catch (mapErr) {
          if (mapErr && mapErr.code === 'provider_auth') throw mapErr;
          if (mapErr && mapErr.code === 'rate_limited') throw mapErr;
        }
        if (!isTransientLlmError(err)) throw err;
        if (attempt >= LLM_RETRY_MAX - 1) throw err;
        await sleep(backoffMs(attempt, { jitter: false }), signal);
      }
    }
    throw lastErr;
  };

  try {
    return await withTransientRetry(model);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    let proFallbackModel = null;
    try { ({ proFallbackModel } = require('./native-llm')); } catch (_) { proFallbackModel = null; }
    const pro = proFallbackModel && proFallbackModel(model);
    const looksMissing = /not found|does not exist|invalid model|unknown model/i.test(String(err && err.message || ''));
    if (pro && (isLlmCreditError(err) || looksMissing)) {
      try {
        return await withTransientRetry(pro);
      } catch (proErr) {
        if (signal && signal.aborted) throw proErr;
        throw isLlmCreditError(err) ? err : proErr;
      }
    }
    throw err;
  }
}

/**
 * Generic LLM → tool_call → tool_result → LLM loop.
 * Native OpenRouter/OpenAI function calling first; ReAct text fallback when
 * the model (or the provider) cannot emit tool_calls.
 */
async function runAgentLoop({
  client,
  model,
  messages,
  tools,
  executors,
  maxIterations = MAX_ITERATIONS_DEFAULT,
  onEvent = () => {},
  signal,
  pins = [],
  maxToolSteps = STEP_BUDGET_DEFAULT,
  threadId = null,
  checkpointStore = null,
  resumeFrom = null,
  memoryRetrieve = null,
  userId = null,
  chatId = null,
  streamId = null,
  onCleanup = null,
  kv = null,
  resumeLock = null,
  sessionFence = null,
  toolTimeoutOverrides = null,
  nowMs = null,
  creditCeiling = null,
  tmpfsPaths = null,
  tmpfsUnlink = null,
  startedAtMs = null,
  turnDeadlineMs = null,
  errorBudgetMax = null,
  toolCircuitThreshold = null,
  processGroup = null,
  creditHold = null,
  tokenBudget = null,
  persistStep = null,
  prisma = null,
  messageId = null,
  repairMaxAttempts = null,
  subagentType = null,
  persistMemory = null,
  sleepCompact = true,
} = {}) {
  if (!client?.chat?.completions?.create) throw new Error('runAgentLoop: client is required');
  const cap = Math.max(1, Math.min(50, Number(maxIterations) || MAX_ITERATIONS_DEFAULT));
  const steps = [];
  let finalText = '';
  let stoppedReason = 'max_iterations';
  let verificationAttempts = 0;
  const startedAt = startedAtMs != null ? Number(startedAtMs) : Date.now();
  let concurrentInflight = 1;
  try { concurrentInflight = beginConcurrentTurn(); } catch (_) { concurrentInflight = 1; }
  let firstTokenMs = null;
  let streamOpened = false;
  let lastTokenAt = 0;
  let lastToolResultAt = 0;
  const orderGate = createEventOrderGate();
  const toolResultStore = new Map();
  const inFlightTools = createInFlightRegistry();
  const holdReleaseState = {};
  const terminalSseState = {};
  const origOnEvent = onEvent;
  onEvent = (ev) => {
    try {
      const seqd = orderGate.next(ev);
      if (!seqd.ok) return;
      ev = seqd.event || ev;
    } catch (_) { /* keep original */ }
    try {
      const drop = dropCancelledRunEvents(ev, { runId: streamId || threadId });
      if (drop && drop.drop) return;
    } catch (_) { /* keep original */ }
    try {
      if (ev && (ev.type === 'token' || ev.type === 'delta' || ev.type === 'text' || ev.type === 'assistant_delta')) {
        streamOpened = true;
      }
    } catch (_) {}
    try {
      if (ev && (ev.type === 'tool_result' || ev.type === 'observation') && (ev.toolCallId || ev.id)) {
        const rec = recordToolResultOnce(toolResultStore, { toolCallId: ev.toolCallId || ev.id, result: ev.result || ev.preview || ev.text });
        if (rec && rec.emit === false) return;
      }
    } catch (_) { /* keep original */ }
    origOnEvent(ev);
  };
  const toolOnce = createExactlyOnceToolStore();
  const loopIdleMs = Number(process.env.SIRAGPT_LOOP_IDLE_MS) || 45000;
  const usage = createUsageAccumulator();
  const errorBudget = errorBudgetMax != null ? createErrorBudget({ max: errorBudgetMax }) : null;
  const toolCircuit = toolCircuitThreshold != null ? createToolCircuit({ threshold: toolCircuitThreshold }) : null;
  const creditHolds = new Map();
  const holdOnce = holdCreditsOnce(
    creditHolds,
    String(threadId || streamId || chatId || '') || '',
    creditCeiling != null ? Number(creditCeiling) || 0 : 0,
    () => creditHold || (creditCeiling != null ? createCreditHold({ ceiling: creditCeiling }) : { reserve() { return { ok: true }; }, settle() { return { ok: true, leftover: 0 }; }, release() { return { ok: true, released: 0 }; } }),
  );
  const hold = creditHold || holdOnce.hold || (creditCeiling != null ? createCreditHold({ ceiling: creditCeiling }) : null);
  const repairBudget = createToolRepairBudget({ maxAttempts: repairMaxAttempts == null ? 3 : repairMaxAttempts });
  const stepTelemetry = createStepTelemetry({ persist: persistStep, prisma, messageId });
  const subagent = resolveSubagentType(subagentType);
  try {
    const depthGate = maxSubagentDepth((subagent && (subagent.depth != null ? subagent.depth : subagentType && subagentType.depth)) || (subagentType && subagentType.depth) || 0);
    if (depthGate && depthGate.ok === false) {
      onEvent({ type: 'error', code: 'subagent_depth', message: classifyLoopError({ code: 'subagent_depth' }).message, retryable: false, iteration: 0 });
    }
  } catch (_) {}
  let subagentSpec = null;
  if (subagent.ok && subagent.type) {
    subagentSpec = sliceSubagentBudget({ parentRemaining: maxToolSteps, type: subagent.type });
    if (subagentSpec.ok && subagentSpec.budget > 0) {
      const inherited = inheritParentRemaining({
        parentRemaining: maxToolSteps,
        childRequested: subagentSpec.budget,
      });
      maxToolSteps = inherited.ok ? inherited.budget : 0;
      try {
        const fair = inheritSubagentSteps({
          parentRemaining: inherited.parent != null ? inherited.parent : maxToolSteps,
          childRequested: maxToolSteps,
          siblings: 1,
        });
        if (fair && fair.ok && Number.isFinite(fair.budget)) maxToolSteps = Math.min(maxToolSteps, fair.budget);
        else if (fair && fair.ok === false) maxToolSteps = 0;
      } catch (_) {}
      subagentSpec = { ...subagentSpec, budget: maxToolSteps, inherited: true };
      try {
        const mid = stopWhenParentExhausted({ parentRemaining: inherited.parent, childUsed: inherited.used, midChild: true });
        if (mid.stop) maxToolSteps = 0;
      } catch (_) { /* optional */ }
    }
    const filtered = filterExecutorsForSubagent(executors, subagent.type);
    if (filtered && filtered.executors) executors = filtered.executors;
  }
  if (hold && creditCeiling != null && !(holdOnce && holdOnce.reused)) {
    try {
      if (!(holdOnce && holdOnce.hold === hold && holdOnce.reused === false && !holdOnce.anonymous)) {
        /* holdCreditsOnce already reserved when turn_id present; skip double-hold */
      }
    } catch (_) { /* optional */ }
  }
  const repeatGuard = createRepeatGuard();
  const stepBudget = createStepBudget({ maxSteps: maxToolSteps });
  const checkpoint = (function makeCkpt() {
    try { return createNDeepCheckpoint({ max: 8 }); } catch (_) { return createCheckpoint(); }
  }());
  let compactedTurns = 0;
  let memoryHits = 0;
  let resumedFrom = null;
  let lastPersistedId = null;
  let lastCkptVersion = 0;
  const pinList = Array.isArray(pins) ? pins.slice() : [];
  const retryTracker = createRetryTracker({ maxRetries: 3 });

  if (Array.isArray(pinList) && pinList.length) {
    const pinned = pinCriticalFacts(messages, pinList);
    messages.splice(0, messages.length, ...pinned);
  }

  let resumeLockHandle = resumeLock;
  if (!resumeLockHandle && kv && threadId && resumeFrom) {
    try { resumeLockHandle = createResumeLock(kv); } catch (_) { resumeLockHandle = null; }
  }
  let fenceHandle = sessionFence;
  let fenceToken = null;
  if (!fenceHandle && kv && threadId) {
    try { fenceHandle = createSessionFence(kv); } catch (_) { fenceHandle = null; }
  }
  if (fenceHandle && threadId) {
    try {
      let safety = await assertFenceSafe({ fence: fenceHandle, sessionKey: threadId });
      if (!safety.ok && kv) {
        try {
          const stolen = await stealStaleFenceMetered(kv, threadId, { now: nowMs != null ? nowMs : Date.now(), ttlSec: fenceHandle.ttlSec });
          if (stolen && stolen.ok) {
            onEvent({
              type: 'error',
              code: 'fence_expired',
              message: classifyLoopError({ code: 'fence_expired' }).message,
              retryable: true,
              iteration: 0,
            });
            safety = await assertFenceSafe({ fence: fenceHandle, sessionKey: threadId });
          }
        } catch (_) { /* keep original conflict */ }
      }
      if (!safety.ok) {
        const classified = classifyLoopError({ code: 'fence_conflict' });
        onEvent({
          type: 'error',
          message: classified.message,
          code: classified.code,
          retryable: classified.retryable,
          iteration: 0,
        });
      } else {
        fenceToken = safety.token;
        try {
          if (kv && fenceToken) await heartbeatFence(kv, threadId, fenceToken, { now: nowMs != null ? nowMs : Date.now(), ttlSec: fenceHandle.ttlSec });
        } catch (_) { /* optional */ }
      }
    } catch (_) { /* fail-open: loop still runs */ }
  }
  if (!checkpointStore && threadId) {
    try {
      const dur = require('./engine-durability');
      checkpointStore = dur.createDurableCheckpointStore({
        kv: kv || (typeof dur.getSharedKv === 'function' ? dur.getSharedKv() : null),
        threadId,
      });
    } catch (_) { checkpointStore = checkpointStore; }
  }
  if (!resumeFrom && checkpointStore && typeof checkpointStore.latest === 'function') {
    try {
      const auto = await autoResumeLatest({ checkpointStore, resumeFrom });
      if (auto && auto.ok && auto.id && auto.source === 'recreate') {
        resumeFrom = auto.id;
        onEvent({
          type: 'session_resumed',
          checkpointId: auto.id,
          source: 'recreate',
          code: 'resume_recreate',
          label: 'Sesión reanudada tras recreate',
        });
      }
    } catch (_) { /* optional */ }
  }
  if (resumeFrom && checkpointStore && typeof checkpointStore.get === 'function') {
    try {
      const safety = await assertResumeSafe({ lock: resumeLockHandle, threadId });
      if (!safety.ok) {
        const classified = classifyLoopError({ code: 'resume_conflict' });
        onEvent({
          type: 'error',
          message: classified.message,
          code: classified.code,
          retryable: classified.retryable,
          iteration: 0,
        });
      } else {
        const snap = await checkpointStore.get(resumeFrom);
        if (snap && snap.expired) {
          const classified = classifyLoopError({ code: 'checkpoint_expired' });
          onEvent({
            type: 'error',
            message: classified.message,
            code: classified.code,
            retryable: classified.retryable,
            iteration: 0,
          });
        } else if (snap) {
          const restored = restoreMessagesFromCheckpoint(messages, snap);
           try {
             const bound = boundStepsOnCheckpointResume({ remaining: maxToolSteps, checkpointRemaining: snap && (snap.remainingSteps || snap.maxToolSteps), max: MAX_ITERATIONS_DEFAULT });
             if (bound && bound.remaining != null) maxToolSteps = bound.remaining;
           } catch (_) {}
           try {
             const ckList = (snap && Array.isArray(snap.checkpoints)) ? snap.checkpoints : (checkpoint ? [checkpoint] : []);
             pruneCheckpointsKeepLastN(ckList, { keep: 8 });
           } catch (_) {}
          if (restored.ok) {
            resumedFrom = resumeFrom;
            try {
              const pinRest = restorePinsFromCheckpoint(snap);
              if (pinRest.ok && pinRest.pins.length) {
                pinRest.pins.forEach((p) => pinList.push(p.text || p));
              }
            } catch (_) { /* pins optional */ }
            try {
              const done = (snap && (snap.toolResults || (snap.state && snap.state.toolResults))) || null;
              const recs = done && (done.done || done);
              if (recs && typeof recs === 'object') {
                for (const [id, result] of Object.entries(recs)) {
                  toolOnce.recordResult(id, result);
                }
              }
            } catch (_) { /* exactly-once hydrate */ }
            onEvent({
              type: 'session_resumed',
              checkpointId: resumeFrom,
              restored: restored.restored,
              label: 'Sesión reanudada',
            });
          }
        } else {
          const classified = classifyLoopError({ code: 'checkpoint_missing' });
          onEvent({
            type: 'error',
            message: classified.message,
            code: classified.code,
            retryable: classified.retryable,
            iteration: 0,
          });
        }
      }
    } catch (err) {
      const classified = classifyLoopError({ code: 'checkpoint_missing' });
      onEvent({
        type: 'error',
        message: classified.message,
        code: classified.code,
        retryable: classified.retryable,
        iteration: 0,
      });
    }
  }

  // F3: a user cancel (Stop button → AbortSignal) must stop the loop AND
  // leave a trace. `bail` emits exactly one 'cancelled' stage event before
  // rethrowing so the SSE stream shows "Cancelado" instead of dying silently.
  let cancelledEmitted = false;
  let emptyState = {};
  const consecutiveCut = createConsecutiveRepeatCut({ limit: 2 });
  const observationCut = createIdenticalObservationLoopCut({ limit: 3 });
  const sameTurnCache = {};
  const writeCheckpoints = [];
  const lastToolArgsByName = {};
  const deadLetterCut = createDeadLetterSameToolAfterN({ limit: 3 });
  let ckptSeq = 0;
  const inflightCallIds = {};
  const webFetchTurnCache = {};
  const readChecksumByPath = {};
  let emptyModelState = {};
  const callReplayStore = new Map();
  const turnToolState = { toolCount: 0 };
  const sessionDup = dropDuplicateInFlightGenerate(String(threadId || streamId || 'anon'), `loop_${startedAt}`);
  if (sessionDup && sessionDup.dropped) {
    const classified = classifyLoopError({ code: 'duplicate_turn' });
    onEvent({ type: 'error', code: 'duplicate_turn', message: classified.message, retryable: true, iteration: 0 });
    return { ok: false, code: 'duplicate_turn', stoppedReason: 'duplicate_turn' };
  }
  try {
    const stale = expireGatewayClaimTtl(String(threadId || streamId || 'anon'));
    if (stale && stale.expired) {
      onEvent({ type: 'error', code: 'session_lock_stale', message: classifyLoopError({ code: 'session_lock_stale' }).message, retryable: true, iteration: 0 });
    }
  } catch (_) {}
  try { touchGatewayClaim(String(threadId || streamId || 'anon'), `loop_${startedAt}`); } catch (_) {}
  try {
    const rate = sessionGenerateRateLimit(String(threadId || streamId || 'anon'));
    if (rate && rate.ok === false) {
      const classified = classifyLoopError({ code: 'rate_limited' });
      onEvent({ type: 'error', code: 'rate_limited', message: classified.message, retryable: true, iteration: 0 });
      return { ok: false, code: 'rate_limited', stoppedReason: 'rate_limited' };
    }
  } catch (_) {}
  const generateRequestId = String(streamId || threadId || `loop_${startedAt}`);
  try {
    const idem = idempotentGenerateByRequestId(String(threadId || streamId || 'anon'), generateRequestId);
    if (idem && idem.replay) {
      return idem.result || { ok: true, code: 'idempotency_replay', stoppedReason: 'idempotency_replay' };
    }
  } catch (_) {}
  try {
    holdThenSettleCredits(String(threadId || streamId || 'anon'), { amount: 1, requestId: generateRequestId });
  } catch (_) {}
  try {
    const media = capImagePdfInContext(messages);
    if (media && media.messages) messages.splice(0, messages.length, ...media.messages);
  } catch (_) {}
  try {
    const resumed = replayToolResultsOnResume(callReplayStore, messages);
    if (resumed && resumed.replayed) {
      onEvent({ type: 'info', code: 'idempotency_replay', replayed: resumed.replayed, iteration: 0, label: 'Reanudando herramientas' });
    }
  } catch (_) {}
  try {
    const gate = allowDeepSeekGenerateModel(model);
    if (gate && gate.ok === false) {
      const classified = classifyLoopError({ code: gate.code || 'openrouter_denied' });
      onEvent({ type: 'error', code: gate.code || 'openrouter_denied', message: classified.message, retryable: false, iteration: 0 });
      return { ok: false, code: gate.code || 'openrouter_denied', stoppedReason: gate.code };
    }
  } catch (_) {}
  try {
    if (Array.isArray(messages) && messages.length) {
      const lastU = [...messages].reverse().find((m) => m && m.role === 'user');
      if (lastU) {
        const g = guardUserRoleSpoof(lastU.content);
        if (g && g.spoofed) lastU.content = g.text;
      }
      const inj = injectProjectInstructions(messages, { text: '' });
      if (inj && inj.messages) messages.splice(0, messages.length, ...inj.messages);
    }
  } catch (_) {}
  const bail = (iteration) => {
    if (!signal?.aborted) return;
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      try {
        cancelMidStream({
          registry: inFlightTools,
          hold,
          holdState: holdReleaseState,
          sseState: terminalSseState,
          write: (frame) => origOnEvent({ ...frame, iteration, label: 'Cancelado' }),
          reason: 'user',
        });
        try {
          abortCascade({
            userSignal: signal,
            modelAbort: () => { try { if (signal && typeof signal.throwIfAborted === 'function') { /* parent already aborted */ } } catch (_) {} },
            sandboxKill: () => { try { tmpCleanupOnCancel([]); } catch (_) {} },
            backgroundReap: () => { try { reapBackgroundBashOnAbort(); } catch (_) {} },
          });
        } catch (_) {}
        try {
          abortSiblingsOnParentCancel({
            parentCancelled: true,
            siblingIds: (typeof subagent === 'object' && subagent && Array.isArray(subagent.siblings)) ? subagent.siblings : [],
          });
        } catch (_) {}
        try {
          abortNestedSubagentsOnParentHalt({
            parentHalt: true,
            children: (typeof subagent === 'object' && subagent && Array.isArray(subagent.children))
              ? subagent.children
              : (typeof subagent === 'object' && subagent && Array.isArray(subagent.nested))
                ? subagent.nested
                : [],
          });
        } catch (_) {}
        try {
          cancelInflightToolsOnStop(Object.values(inflightCallIds), { aborted: true });
        } catch (_) {}
        try {
          settleCreditsIfClientGone({
            aborted: true,
            sessionKey: String(threadId || streamId || 'anon'),
            requestId: generateRequestId,
          });
        } catch (_) {}
        try {
          const snapC = (usage && typeof usage.snapshot === 'function') ? usage.snapshot() : {};
          refundPartialTokensOnCancel({
            requestId: generateRequestId,
            cancelled: true,
            promptTokens: snapC.promptTokens || 0,
            completionTokens: snapC.completionTokens || 0,
          });
        } catch (_) {}
        try { recordTurnToolCount(turnToolState, { count: turnToolState.toolCount || 0, cancelled: true }); } catch (_) {}
        try { snapshotPartialOnAbort({ text: finalText, toolCount: turnToolState.toolCount || 0 }); } catch (_) {}
        try { markRunCancelled(String(streamId || threadId || generateRequestId)); } catch (_) {}
        try { releaseCreditHold(String(threadId || streamId || 'anon'), generateRequestId); } catch (_) {}
      } catch (_) { /* best-effort */ }
      try { onEvent({ type: 'cancelled', iteration, label: 'Cancelado' }); } catch (_) { /* trace only */ }
    }
    throwIfAborted(signal);
  };

  const persistCkpt = async (id, extra = {}) => {
    if (!checkpointStore || typeof checkpointStore.put !== 'function' || !id) return;
    try {
      try {
        const cas = checkpointCasSeq({ seq: ckptSeq + 1, lastSeq: ckptSeq });
        if (cas && cas.ok === false) {
          onEvent({ type: 'error', code: 'ckpt_cas', message: classifyLoopError({ code: 'ckpt_cas' }).message, retryable: false, iteration: extra.iteration || 0 });
          return;
        }
        ckptSeq += 1;
      } catch (_) {}
      const putRes = await checkpointStore.put({
        checkpointId: id,
        parentCheckpointId: lastPersistedId,
        expectedVersion: lastCkptVersion,
        state: checkpointStateWithPins({
          messages: Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [],
          steps: steps.slice(),
          iteration: extra.iteration,
          usage: usage.snapshot(),
        }, pinList),
        metadata: { threadId: threadId || extra.threadId || null, source: 'agent-runner' },
      });
      if (putRes && putRes.ok === false && putRes.code === 'ckpt_cas') {
        onEvent({
          type: 'error',
          code: 'ckpt_cas',
          message: classifyLoopError({ code: 'ckpt_cas' }).message,
          retryable: false,
          iteration: extra.iteration || 0,
        });
        return;
      }
      lastPersistedId = id;
      if (putRes && putRes.version != null) lastCkptVersion = putRes.version;
    } catch (_) { /* fail-open: in-memory ckpt still holds */ }
  };

  const finish = (extra = {}) => {
    const turnEndMs = Date.now() - startedAt;
    try { if (firstTokenMs != null) observeFirstToken(firstTokenMs); } catch (_) { /* optional */ }
    try { if (firstTokenMs != null) observeAdapterLatency('ttfb', firstTokenMs); } catch (_) {}
    try { observeTurnEnd(turnEndMs); } catch (_) { /* optional */ }
    try { observeAdapterLatency('turn', turnEndMs); } catch (_) {}
    try { recordTurnToolCount(turnToolState, { count: turnToolState.toolCount || 0, cancelled: Boolean(signal && signal.aborted) }); } catch (_) {}
    try { if (sessionDup && typeof sessionDup.release === 'function') sessionDup.release(); } catch (_) {}
    try { endConcurrentTurn(turnEndMs, concurrentInflight); } catch (_) { /* optional */ }
    const ckpt = checkpoint.latest();
    try {
      if (fenceHandle && fenceToken && typeof fenceHandle.release === 'function') {
        Promise.resolve(fenceHandle.release(threadId, fenceToken)).catch(() => {});
        fenceToken = null;
      }
    } catch (_) { /* ignore */ }
    try {
      if (hold && typeof hold.settle === 'function') {
        const snap = usage.snapshot();
        hold.settle((snap.promptTokens || 0) + (snap.completionTokens || 0));
      }
    } catch (_) { /* optional */ }
    try {
      const snapR = usage.snapshot() || {};
      refundPartialTokensOnCancel({
        requestId: generateRequestId,
        cancelled: Boolean(signal && signal.aborted) || /cancel/.test(String(extra.stoppedReason || stoppedReason || '')),
        promptTokens: snapR.promptTokens || 0,
        completionTokens: snapR.completionTokens || 0,
      });
    } catch (_) {}
    try {
      const snap = usage.snapshot() || {};
      settleCreditHoldIfStreamOpened(String(threadId || streamId || 'anon'), generateRequestId, {
        streamOpened,
        usage: { total_tokens: (snap.promptTokens || 0) + (snap.completionTokens || 0) },
      });
    } catch (_) {}
    try {
      rememberGenerateByRequestId(String(threadId || streamId || 'anon'), generateRequestId, {
        ok: true,
        stoppedReason: extra.stoppedReason || stoppedReason,
        iterations: extra.iterations != null ? extra.iterations : cap,
      });
    } catch (_) {}
    try { Promise.resolve(stepTelemetry.flush()).catch(() => {}); } catch (_) { /* fail-open */ }
    let sleepCompactResult = null;
    if (sleepCompact !== false) {
      try {
        sleepCompactResult = sleepTimeCompact({
          messages,
          pins: pinList,
          persistMemory,
          userId,
          chatId,
          reason: extra.stoppedReason || stoppedReason,
        });
      } catch (_) { sleepCompactResult = { ok: false, skipped: true }; }
    }
    return {
      finalText,
      iterations: extra.iterations != null ? extra.iterations : cap,
      steps,
      stoppedReason: extra.stoppedReason || stoppedReason,
      verificationAttempts,
      usage: usage.snapshot(),
      firstTokenMs,
      turnEndMs,
      compactedTurns,
      checkpointId: ckpt && ckpt.id,
      canResume: Boolean(ckpt),
      stepBudget: { used: stepBudget.used(), cap: stepBudget.cap },
      memoryHits,
      resumedFrom,
      sleepCompact: sleepCompactResult,
      subagentType: subagent && subagent.type || null,
      ...extra,
    };
  };

  const runCleanup = async () => {
    try {
      if (fenceHandle && fenceToken && typeof fenceHandle.release === 'function') {
        await fenceHandle.release(threadId, fenceToken);
      }
    } catch (_) { /* ignore */ }
    try {
      if (Array.isArray(tmpfsPaths) && tmpfsPaths.length) {
        cleanupTmpfsOnCancel(tmpfsPaths, tmpfsUnlink ? { unlink: tmpfsUnlink } : {});
      }
    } catch (_) { /* guaranteed attempt */ }
    try {
      if (processGroup && typeof processGroup.killOnCancel === 'function') processGroup.killOnCancel();
    } catch (_) { /* guaranteed attempt */ }
    try {
      if (hold && typeof hold.release === 'function') hold.release();
    } catch (_) { /* guaranteed attempt */ }
    if (typeof onCleanup !== 'function') return;
    try { await onCleanup(); } catch (_) { /* guaranteed attempt */ }
  };

  try {
  for (let iteration = 1; iteration <= cap; iteration += 1) {
    bail(iteration);
    try {
      const wall = assertTurnWallClock(startedAt, nowMs != null ? nowMs : Date.now(), turnDeadlineMs);
      try {
        const remainMs = (turnDeadlineMs != null ? Number(turnDeadlineMs) - Date.now() : (wall && wall.remainingMs));
        const cut = remainingWallClockCut({ remainingMs: remainMs });
        if (cut && cut.halt) {
          const classified = classifyLoopError({ code: 'wall_clock' });
          stoppedReason = 'wall_clock';
          finalText = classified.message;
          onEvent({ type: 'error', code: 'wall_clock', message: classified.message, retryable: false, iteration });
          onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Tiempo del turno agotado' });
          return finish({ iterations: iteration, stoppedReason: 'wall_clock', errorCode: 'wall_clock' });
        }
      } catch (_) {}
      if (wall && wall.stop) {
        const classified = classifyLoopError({ code: 'turn_deadline' });
        stoppedReason = 'turn_deadline';
        finalText = classified.message;
        onEvent({
          type: 'error',
          code: 'turn_deadline',
          message: classified.message,
          retryable: false,
          iteration,
        });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Tiempo del turno agotado' });
        return finish({ iterations: iteration, stoppedReason: 'turn_deadline', errorCode: 'turn_deadline' });
      }
    } catch (_) { /* optional */ }
    try {
      const usedTok = (usage.snapshot().totalTokens) || 0;
      const stop = evaluateStopConditions({
        iteration,
        maxIterations: cap,
        tokensUsed: usedTok,
        tokenBudget,
        wallStop: false,
        errorBudgetStop: Boolean(errorBudget && typeof errorBudget.remaining === "function" && errorBudget.remaining() <= 0),
        custom: (subagent && subagent.type) ? () => {
          if (stepBudget.used() >= stepBudget.cap) return { stop: true, reason: 'subagent_budget' };
          const plan = remainingPlanBudget({
            parentRemaining: stepBudget.cap,
            childUsed: stepBudget.used(),
            childCap: subagentSpec && subagentSpec.budget,
          });
          if (!plan.ok) return { stop: true, reason: 'plan_budget' };
          try {
            const mid = stopWhenParentExhausted({
              parentRemaining: maxToolSteps,
              childUsed: stepBudget.used(),
              midChild: true,
            });
            if (mid.stop) return { stop: true, reason: 'subagent_budget' };
          } catch (_) { /* optional */ }
          return { stop: false };
        } : null,
      });
      if (stop && stop.stop) {
        const classified = classifyLoopError({ code: stop.reason });
        stoppedReason = stop.reason;
        finalText = classified.message;
        onEvent({ type: 'error', code: stop.reason, message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Condicion de paro' });
        return finish({ iterations: iteration, stoppedReason: stop.reason, errorCode: stop.reason });
      }
    } catch (_) { /* optional */ }
    try {
      if (kv && fenceToken && threadId) await heartbeatFence(kv, threadId, fenceToken, { ttlSec: fenceHandle.ttlSec, now: nowMs != null ? nowMs : Date.now() });
    } catch (_) { /* optional */ }
    onEvent({ type: 'iteration_start', iteration, label: 'Pensando…', seq: iteration });

    if (iteration === 1) {
      try {
        const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
        const hookedRecall = async (q) => {
          const hook = searchableMemoryHook({
            retrieve: typeof memoryRetrieve === 'function' ? memoryRetrieve : null,
            query: (q && q.query) || (lastUser && lastUser.content) || q,
            namespace: String(userId || chatId || 'default'),
          });
          const resolved = hook && typeof hook.then === 'function' ? await hook : hook;
          return (resolved && resolved.hits) || [];
        };
        let skipMem = null;
        try { skipMem = skipMemoryRetrieveIfBusy({ elapsedMs: Date.now() - startedAt }); } catch (_) { skipMem = null; }
        const before = (skipMem && skipMem.skipped)
          ? { ok: true, pins: [], skipped: true, code: null }
          : await retrieveBeforeGenerate({
          query: lastUser && lastUser.content,
          userId,
          chatId,
          recall: hookedRecall,
        });
        if (!before.ok) {
          const classified = classifyLoopError({ code: before.code || 'retrieve_before' });
          onEvent({
            type: 'error',
            code: classified.code,
            retryable: classified.retryable,
            message: classified.message,
            iteration,
          });
        } else {
          const extraPins = Array.isArray(before.pins) ? before.pins : [];
          if (extraPins.length) {
            try {
              const ranked = rankPgvectorHits(extraPins);
              if (ranked && ranked.ok && Array.isArray(ranked.hits)) {
                extraPins.splice(0, extraPins.length, ...ranked.hits);
              } else if (ranked && ranked.ok === false) {
                extraPins.splice(0, extraPins.length);
              }
              const facts = skipEmptyWhitespaceMemoryFacts(extraPins);
              if (facts && Array.isArray(facts.facts)) extraPins.splice(0, extraPins.length, ...facts.facts);
              const scored = minScoreMemoryRetrieve(extraPins);
              if (scored && Array.isArray(scored.facts)) extraPins.splice(0, extraPins.length, ...scored.facts);
              const deduped = memoryRetrieveDedupeByHash(extraPins);
              if (deduped && Array.isArray(deduped.facts)) extraPins.splice(0, extraPins.length, ...deduped.facts);
              const aged = memorySkipFactsOlderThanDays(extraPins);
              if (aged && Array.isArray(aged.facts)) extraPins.splice(0, extraPins.length, ...aged.facts);
            } catch (_) {}
            memoryHits = extraPins.length;
            extraPins.forEach((p) => pinList.push(p));
            const evicted = evictPinsKeepingCritical(pinList, 12);
            pinList.splice(0, pinList.length, ...(evicted.pins || pinList));
            messages.splice(0, messages.length, ...pinCriticalFacts(messages, pinList));
            onEvent({
              type: 'memory_retrieved',
              iteration,
              count: extraPins.length,
              code: before.code || 'retrieve_before',
              label: 'Memoria recuperada',
            });
          }
        }
      } catch (memErr) {
        const memCode = (memErr && memErr.code === 'pgvector_failed') ? 'pgvector_failed' : 'retrieve_before';
        const classified = classifyLoopError({ code: memCode });
        onEvent({
          type: 'error',
          code: classified.code,
          retryable: classified.retryable,
          message: classified.message,
          iteration,
        });
      }
    }

    let compact;
    try {
      try {
        const skipC = skipCompactIfUnderBudget(messages);
        if (skipC && skipC.skipped) compact = { compressed: false, messages, skipped: true };
      } catch (_) {}
      if (!(compact && compact.skipped)) {
        compact = compactKeepingSystemAndPins(messages, { maxTokens: 12000, pins: pinList });
        if (!compact.compressed) compact = compactPreservingPairs(messages, { maxTokens: 12000 });
        if (!compact.compressed) compact = compactMessagesIfNeeded(messages);
        try {
          const kept = compactKeepLastToolErrors(compact.messages || messages, messages, { keep: 3 });
          if (kept && kept.messages) compact = { ...compact, messages: kept.messages, keptToolErrors: kept.keptToolErrors };
        } catch (_) { /* optional */ }
        try {
          const pinned = pinAcrossCompact(compact.messages || messages, pinList);
          if (pinned && pinned.messages) compact = { ...compact, messages: pinned.messages, pinned: pinned.pinned };
        } catch (_) { /* optional */ }
        try {
          const dropped = compactDropStaleBodies(compact.messages || messages, { keepNames: 6, maxBody: 400 });
          if (dropped && dropped.messages) compact = { ...compact, messages: dropped.messages, keptNames: dropped.keptNames };
          const keptBodies = compactKeepLastNBodies(compact.messages || messages, { keep: 6, maxBody: 400 });
          if (keptBodies && keptBodies.messages) compact = { ...compact, messages: keptBodies.messages, keptBodies: keptBodies.keptBodies };
          try {
            const leftTok = formatRemainingBudgetHint({
              used: (usage.snapshot() && usage.snapshot().totalTokens) || 0,
              budget: tokenBudget || resolveAgentRunnerMaxTokens(),
            });
            const fitted = compactUntilTokenBudget(compact.messages || messages, { remaining: (leftTok && leftTok.remaining) || 1500, keep: 6 });
            if (fitted && fitted.messages) compact = { ...compact, messages: fitted.messages, compressed: compact.compressed || fitted.compressed, afterTokens: fitted.used };
            const pinnedKeep = compactKeepPinnedSiragptAndLastUser(compact.messages || messages, { remaining: (leftTok && leftTok.remaining) || 1500, keep: 6 });
            if (pinnedKeep && pinnedKeep.messages) compact = { ...compact, messages: pinnedKeep.messages, compressed: compact.compressed || pinnedKeep.compressed, afterTokens: pinnedKeep.used, keptSiragpt: pinnedKeep.keptSiragpt };
            const dedupSys = dropDuplicateSystemPrompts(compact.messages || messages);
            if (dedupSys && dedupSys.messages) compact = { ...compact, messages: dedupSys.messages };
          } catch (_) {}
          try {
            const swept = expireAndSweepPins(pinList || []);
            if (swept && Array.isArray(swept.pins)) pinList.splice(0, pinList.length, ...swept.pins);
          } catch (_) {}
        } catch (_) { /* optional */ }
      }
      try {
        const pairs = compactKeepToolCallResultPairs((compact && compact.messages) || messages);
        if (pairs && pairs.messages) compact = { ...(compact || {}), messages: pairs.messages };
      } catch (_) {}
      try {
        const errs = compactPreserveLastErrors((compact && compact.messages) || messages, messages, { keep: 3 });
        if (errs && errs.messages) compact = { ...(compact || {}), messages: errs.messages, keptErrors: errs.keptErrors };
      } catch (_) {}
      try {
        const mergedUsers = compactMergeAdjacentDuplicateUsers((compact && compact.messages) || messages);
        if (mergedUsers && mergedUsers.messages) compact = { ...(compact || {}), messages: mergedUsers.messages };
      } catch (_) {}
      try {
        const staleImg = compactDropStaleImageBlocks((compact && compact.messages) || messages);
        try {
          const keepPair = compactKeepLastUserAssistantPair((compact && compact.messages) || messages);
          if (keepPair && keepPair.messages) compact = { ...(compact || {}), messages: keepPair.messages, keepIndexes: keepPair.keepIndexes };
        } catch (_) {}
        if (staleImg && staleImg.messages) compact = { ...(compact || {}), messages: staleImg.messages };
      } catch (_) {}
      try {
        const pinned38 = pinCriticalFactsTagged((compact && compact.messages) || messages, pinList);
        if (pinned38 && pinned38.messages) compact = { ...(compact || {}), messages: pinned38.messages };
      } catch (_) {}
    } catch (_) {
      compact = compactMessagesIfNeeded(messages);
    }
    if (compact.compressed) {
      compactedTurns += compact.removedTurns || 0;
      messages.splice(0, messages.length, ...compact.messages);
      if (pinList.length) {
        messages.splice(0, messages.length, ...pinCriticalFacts(messages, pinList));
      }
      onEvent({
        type: 'context_compacted',
        iteration,
        removedTurns: compact.removedTurns || 0,
        beforeTokens: compact.beforeTokens,
        afterTokens: compact.afterTokens,
        label: 'Contexto compactado',
      });
    }

    try {
      const stall = detectLoopStall({
        lastTokenAt,
        lastToolResultAt,
        startedAt,
        now: Date.now(),
        idleMs: loopIdleMs,
      });
      if (stall && stall.stop) {
        const classified = classifyLoopError({ code: 'loop_stall' });
        stoppedReason = 'loop_stall';
        finalText = classified.message;
        onEvent({ type: 'error', code: 'loop_stall', message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Bucle detenido por inactividad' });
        return finish({ iterations: iteration, stoppedReason: 'loop_stall', errorCode: 'loop_stall' });
      }
    } catch (_) { /* optional */ }

    try {
      const left = sessionRemainingSteps(String(threadId || streamId || 'anon'), { consume: 0 });
      const hint = formatRemainingBudgetHint({
        used: (usage.snapshot() && usage.snapshot().totalTokens) || 0,
        budget: tokenBudget || resolveAgentRunnerMaxTokens(),
        stepsLeft: left && left.remaining,
      });
      try {
        const stepRem = remainingStepBudgetReminder({ remaining: left && left.remaining });
        if (stepRem && stepRem.inject && messages.length && messages[0] && messages[0].role === 'system') {
          const sys0 = String(messages[0].content || '');
          if (!sys0.includes('Quedan ') && stepRem.text) {
            messages[0] = { ...messages[0], content: `${sys0}\n\n${stepRem.text}` };
          }
        }
        const every5 = budgetHintEveryFiveSteps({ step: iteration, remaining: left && left.remaining });
        if (every5 && every5.inject && messages.length && messages[0] && messages[0].role === 'system') {
          const sys5 = String(messages[0].content || '');
          if (every5.text && !sys5.includes(every5.text)) {
            messages[0] = { ...messages[0], content: `${sys5}\n\n${every5.text}` };
          }
        }
        const planProg = injectPlanProgressLine({ i: iteration, n: cap });
        if (planProg && planProg.inject && messages.length && messages[0] && messages[0].role === 'system') {
          const sysP = String(messages[0].content || '');
          if (planProg.text && !sysP.includes('paso ') && !sysP.includes(planProg.text)) {
            messages[0] = { ...messages[0], content: `${sysP}\n\n${planProg.text}` };
          }
        }
      } catch (_) {}
      if (hint && hint.text && messages.length && messages[0] && messages[0].role === 'system') {
        const sys = String(messages[0].content || '');
        if (!sys.includes('Presupuesto restante:')) {
          messages[0] = { ...messages[0], content: `${sys}\n\n${hint.text}` };
        } else {
          messages[0] = { ...messages[0], content: sys.replace(/Presupuesto restante:[^\n]*/, hint.text) };
        }
      }
    } catch (_) { /* optional */ }

    let response;
    try {
      const genStarted = Date.now();
      const genHb = startExecHeartbeat((frame) => {
        try { onEvent({ ...frame, iteration, label: 'Generando' }); } catch (_) {}
      }, { kind: 'generate', intervalMs: 15000 });
      const tokenWd = startFirstTokenWatchdog({
        timeoutMs: (function () { try { return splitModelVsToolTimeout('model').ttfbMs || 2500; } catch (_) { return 2500; } }()),
        onHeartbeat: (frame) => { try { onEvent({ ...frame, iteration, label: 'Esperando proveedor' }); } catch (_) {} },
        onEscalate: (frame) => { try { onEvent({ ...frame, iteration, label: 'Proveedor lento' }); } catch (_) {} },
      });
      try {
        const raced = await withIdleCut(
          callModel({ client, model, messages, tools, signal }),
          { idleMs: loopIdleMs, signal },
        );
        if (raced && raced.stalled) {
          const classified = classifyLoopError({ code: 'loop_stall' });
          stoppedReason = 'loop_stall';
          finalText = classified.message;
          onEvent({ type: 'error', code: 'loop_stall', message: classified.message, retryable: false, iteration });
          onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Bucle detenido por inactividad' });
          return finish({ iterations: iteration, stoppedReason: 'loop_stall', errorCode: 'loop_stall' });
        }
        response = raced && raced.value != null ? raced.value : raced;
      } finally {
        try { genHb.stop(); } catch (_) {}
        try { tokenWd.stop(); } catch (_) {}
        try { observeInflightMs('generate', Date.now() - genStarted); } catch (_) {}
        try {
          const wd40 = firstTokenWatchdogMs({
            elapsedMs: Date.now() - genStarted,
            firstTokenAt: firstTokenMs,
            timeoutMs: 8000,
          });
          if (wd40 && wd40.fired) {
            onEvent({ type: 'error', code: 'ttfb_watchdog', message: classifyLoopError({ code: 'ttfb_watchdog' }).message, retryable: true, iteration });
          }
        } catch (_) {}
      }
      lastTokenAt = Date.now();
      bail(iteration);
      if (firstTokenMs == null) {
        firstTokenMs = Date.now() - startedAt;
        try { tokenWd.mark(Date.now()); } catch (_) {}
        try { observeFirstByte(firstTokenMs); } catch (_) { /* optional */ }
        try { observeRealFirstByte(firstTokenMs, { source: 'loop' }); } catch (_) { /* optional */ }
        try { if (kv) persistFirstByteSamples(kv).catch(() => {}); } catch (_) { /* optional */ }
      }
      {
        const usageGate = extractUsageOrRelease(response, hold);
        if (usageGate && usageGate.code === 'credit_no_usage') {
          const classified = classifyLoopError({ code: 'credit_no_usage' });
          onEvent({ type: 'error', code: 'credit_no_usage', message: classified.message, retryable: true, iteration });
        } else {
          usage.add(response);
        }
        try {
          const snap = usage.snapshot() || {};
          appendTokenAuditLog({
            session: String(threadId || streamId || 'anon'),
            prompt: snap.promptTokens,
            completion: snap.completionTokens,
            total: snap.totalTokens,
            model: model,
          });
        } catch (_) {}
      }
      try {
        const tok = assertTurnTokenBudget(usage.snapshot().totalTokens, tokenBudget);
        if (tok && tok.stop) {
          const classified = classifyLoopError({ code: 'token_budget' });
          onEvent({ type: 'error', code: 'token_budget', message: classified.message, retryable: false, iteration });
          stoppedReason = 'token_budget';
          finalText = classified.message;
          onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Presupuesto de tokens' });
          return finish({ iterations: iteration, stoppedReason: 'token_budget', errorCode: 'token_budget' });
        }
      } catch (_) { /* optional */ }
      try {
        const ceil = enforceCreditCeiling(usage.snapshot(), creditCeiling);
        if (!ceil.ok || ceil.stop) {
          const classified = classifyLoopError({ code: 'credit_ceiling' });
          onEvent({
            type: 'error',
            code: classified.code,
            message: classified.message,
            retryable: false,
            iteration,
          });
          stoppedReason = 'credit_ceiling';
          finalText = classified.message;
          onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Techo de tokens' });
          return finish({ iterations: iteration, stoppedReason: 'credit_ceiling', errorCode: 'credit_ceiling' });
        }
      } catch (_) { /* optional */ }
    } catch (err) {
      if (signal?.aborted) bail(iteration);
      const classified = classifyLoopError(err);
      onEvent({
        type: 'error',
        message: classified.message,
        code: classified.code,
        retryable: classified.retryable,
        iteration,
      });
      if (isLlmCreditError(err)) {
        // Out of credits: no retry can succeed. Stop the loop NOW and hand
        // the reason to the caller so the user gets an honest message
        // instead of a silent fallback to the generic pipeline.
        return finish({
          iterations: iteration,
          stoppedReason: 'llm_402',
          errorMessage: classified.message,
          errorCode: classified.code,
        });
      }
      const wrapped = Object.assign(err instanceof Error ? err : new Error(classified.message), {
        code: classified.code,
        publicMessage: classified.message,
      });
      throw wrapped;
    }

    const msg = response?.choices?.[0]?.message || {};
    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    let viaReact = false;
    if (!toolCalls.length) {
      const parsed = parseReact(msg.content);
      if (parsed.length) {
        toolCalls = asNativeCalls(parsed, iteration);
        viaReact = true;
      }
    }
    if (Array.isArray(toolCalls) && toolCalls.length) {
      toolCalls = toolCalls.map((c, idx) => {
        try { return normalizePartialToolCall(c, iteration, idx); } catch (_) { return c; }
      });
      try {
        const repairedTurn = repairMalformedToolTurn(toolCalls, []);
        if (repairedTurn.calls) toolCalls = repairedTurn.calls.filter((c) => !c.__rejected);
        if (repairedTurn.code) {
          onEvent({
            type: 'error',
            code: repairedTurn.code,
            message: classifyLoopError({ code: repairedTurn.code }).message,
            retryable: false,
            iteration,
          });
        }
      } catch (_) { /* optional */ }
    }
    toolCalls = normalizeToolCalls(toolCalls, iteration);
    try { toolCalls = dedupConsecutiveAssistantCalls(toolCalls); } catch (_) {}
    try {
      const uniq = ensureUniqueToolCallIds(toolCalls);
      if (uniq && uniq.calls) toolCalls = uniq.calls;
      if (uniq && uniq.duplicates) {
        onEvent({ type: 'error', code: 'tool_id_duplicate', message: classifyLoopError({ code: 'tool_id_duplicate' }).message, retryable: false, iteration });
      }
    } catch (_) {}
    try {
      const orphans = dropOrphanToolResults(messages, { allowedIds: toolCalls.map((c) => c && c.id).filter(Boolean) });
      if (orphans && orphans.dropped && orphans.messages) messages.splice(0, messages.length, ...orphans.messages);
    } catch (_) {}
    try {
      const finTools = stopIfFinalTextWithTools({ content: msg.content, tool_calls: toolCalls });
      if (finTools && finTools.stop) {
        onEvent({ type: 'info', code: 'final_with_tools', message: classifyLoopError({ code: 'final_with_tools' }).message, retryable: false, iteration });
        toolCalls = [];
      }
    } catch (_) {}
    try {
      toolCalls = (Array.isArray(toolCalls) ? toolCalls : []).filter((c) => {
        const n = (c && c.function && c.function.name) || (c && c.name) || '';
        const allow = allowlistToolName(n, { extra: Object.keys(executors || {}) });
        if (allow && allow.ok === false) {
          onEvent({ type: 'error', code: 'unknown_tool', message: classifyLoopError({ code: 'unknown_tool' }).message, retryable: false, iteration, name: n });
          return false;
        }
        const emptyN = rejectEmptyToolName(n);
        if (emptyN && emptyN.ok === false) {
          onEvent({ type: 'error', code: 'empty_tool_name', message: 'Nombre de herramienta vacío.', retryable: false, iteration });
          return false;
        }
        const comp = refuseComputerToolsIfFlagOff(n, { computerEnabled: !!(opts && opts.computerEnabled) });
        if (comp && comp.refused) {
          onEvent({ type: 'error', code: 'computer_flag_off', message: 'computer_* desactivado.', retryable: false, iteration, name: n });
          return false;
        }
        return true;
      });
      const deduped = dropDuplicateConsecutiveToolCalls(toolCalls);
      if (deduped && Array.isArray(deduped.calls)) toolCalls = deduped.calls;
    } catch (_) {}
    try {
      const storm = maxToolCallsPerMessage(toolCalls, { max: 8 });
      if (storm && storm.calls) {
        if (storm.overflow && storm.overflow.length) {
          onEvent({ type: 'error', code: 'tool_storm', message: classifyLoopError({ code: 'tool_storm' }).message, retryable: false, iteration });
        }
        toolCalls = storm.calls;
      }
      const hardCap = maxToolsPerTurnHardCap(toolCalls, { max: 32 });
      if (hardCap && hardCap.halt) {
        const classified = classifyLoopError({ code: 'too_many_tools' });
        stoppedReason = 'too_many_tools';
        finalText = classified.message;
        onEvent({ type: 'error', code: 'too_many_tools', message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Demasiadas herramientas' });
        return finish({ iterations: iteration, stoppedReason: 'too_many_tools', errorCode: 'too_many_tools' });
      }
    } catch (_) {}
    try {
      const stopR = classifyStopReason(response);
      if (stopR && stopR.reason === 'length') {
        onEvent({ type: 'error', code: 'token_budget', message: classifyLoopError({ code: 'token_budget' }).message, retryable: false, iteration });
      }
    } catch (_) {}

    try {
      emptyState = emptyState || {};
      const emptyGate = emptyResponseRetryOnce(response, emptyState);
      emptyState = emptyGate.state || emptyState;
      if (emptyGate.stop) {
        const classified = classifyLoopError({ code: 'empty_response' });
        stoppedReason = 'empty_response';
        finalText = classified.message;
        onEvent({ type: 'error', code: 'empty_response', message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Sin respuesta' });
        return finish({ iterations: iteration, stoppedReason: 'empty_response', errorCode: 'empty_response' });
      }
      if (emptyGate.retry) {
        onEvent({ type: 'retry', reason: 'empty_response', attempt: emptyState.retries, label: 'Reintento por respuesta vacía' });
        continue;
      }
      emptyModelState = emptyModelState || {};
      const emptyBr = circuitBreakerEmptyModelTwice(response, emptyModelState);
      emptyModelState = emptyBr.state || emptyModelState;
      if (emptyBr && emptyBr.halt) {
        const classified = classifyLoopError({ code: 'empty_model' });
        stoppedReason = 'empty_model';
        finalText = classified.message;
        onEvent({ type: 'error', code: 'empty_model', message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Modelo vacío' });
        return finish({ iterations: iteration, stoppedReason: 'empty_model', errorCode: 'empty_model' });
      }
      const emptyTurn = dropEmptyAssistantTurn(response);
      if (emptyTurn && emptyTurn.drop && !(emptyBr && emptyBr.halt)) {
        onEvent({ type: 'info', code: 'empty_turn', message: 'Turno vacío omitido.', retryable: true, iteration });
      }
    } catch (_) { /* optional */ }

    if (!toolCalls.length) {
      const gate = needsVerification(steps);
      if (gate.needed && verificationAttempts < MAX_VERIFICATION_RETRIES) {
        verificationAttempts += 1;
        onEvent({
          type: 'retry',
          reason: gate.reason,
          attempt: verificationAttempts,
          label: 'Verificando resultado',
        });
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({
          role: 'user',
          content: verificationNudge(verificationAttempts, gate.reason),
        });
        continue;
      }
      finalText = String(msg.content || '').trim();
      if (gate.needed) {
        stoppedReason = 'verification_failed';
        if (!finalText) {
          finalText = 'No pude verificar que el cambio se aplicó de verdad. Revisa el archivo o inténtalo de nuevo.';
        }
        onEvent({
          type: 'final',
          text: finalText,
          iterations: iteration,
          label: 'Error verificado',
          verified: false,
        });
      } else {
        stoppedReason = 'final';
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Listo', verified: true });
      }
      messages.push({ role: 'assistant', content: msg.content || '' });
      return finish({ iterations: iteration, stoppedReason });
    }

    if (msg.content) {
      onEvent({
        type: 'thought',
        iteration,
        label: activityTextFor({ thought: msg.content, label: previewOf(msg.content, 80) || 'Pensando…' }),
        preview: previewOf(msg.content, 240),
      });
    }

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls,
    });

    const ckptId = checkpoint.save({ iteration, messages, steps, usage: usage.snapshot(), toolResults: toolOnce.snapshot() });
    await persistCkpt(ckptId, { iteration });

    const mappedName = (call) => {
      const name = call?.function?.name || 'unknown';
      try {
        const nearest = rewriteUnknownToNearest(name, { executors });
        if (nearest && nearest.ok && nearest.mapped) {
          if (nearest.rewritten) call.__rewritten = nearest.mapped;
          return nearest.mapped;
        }
        if (nearest && nearest.code === 'tool_unknown') {
          call.__unknown = true;
          call.__suggestion = nearest.suggestion;
          call.__unknownCode = 'tool_unknown';
        }
      } catch (_) { /* keep 3H30 */ }
      try {
        const resolved = resolveUnknownTool(name, { executors });
        if (resolved && resolved.ok && resolved.mapped) return resolved.mapped;
        if (resolved && resolved.code === 'tool_unknown') {
          call.__unknown = true;
          call.__suggestion = resolved.suggestion;
          call.__unknownCode = 'tool_unknown';
        }
      } catch (_) { /* keep legacy */ }
      try {
        const aliased = mapToolAlias(name, { executors });
        if (aliased && aliased.ok && aliased.name) return aliased.name;
      } catch (_) { /* keep legacy */ }
      try {
        const common = aliasCommonToolNames(name);
        if (common && common.name) return common.name;
      } catch (_) { /* keep legacy */ }
      return name === 'bash' ? 'execute_bash' : name;
    };

    const prepareCall = (call) => {
      const mapped = mappedName(call);
      const args = call.__args || safeParseArgs(call?.function?.arguments);
      try {
        const schema = toolSchemaFor(tools, mapped) || toolSchemaFor(tools, call?.function?.name);
        const repaired = repairToolCallSchema({ name: mapped, arguments: args }, schema || { type: 'object' }, { executors });
        if (repaired && repaired.args) {
          return { call, mapped: repaired.name || mapped, args: repaired.args, schemaRepair: repaired };
        }
      } catch (_) { /* keep parsed args */ }
      return { call, mapped, args };
    };

    const executePrepared = async (prepared) => {
      const { call, mapped, args } = prepared;
      const name = call?.function?.name || 'unknown';
      const executor = executors[mapped] || executors[name];
      let result;
      const toolId = String((call && call.id) || '');
      try {
        const skip = toolOnce.shouldSkip(toolId);
        if (skip && skip.skip) {
          return { prepared, result: skip.result, f7Image: null, skipped: true, code: 'exactly_once_tool' };
        }
        if (toolId) toolOnce.markInFlight(toolId);
      } catch (_) { /* optional */ }
      const subDeny = (subagent && subagent.type) ? assertSubagentToolAllowed(subagent.type, mapped) : { ok: true };
      try {
        const replay = replaySameCallId(callReplayStore, { toolCallId: toolId, args });
        if (replay && replay.replay) {
          return { prepared, result: replay.result, f7Image: null, skipped: true, code: 'tool_result_dup' };
        }
      } catch (_) {}
      try {
        if (toolId) {
          const coal = idempotentSameCallIdInflight(toolId, inflightCallIds);
          if (coal && coal.coalesced) {
            return { prepared, result: coal.promise && coal.promise.result, f7Image: null, skipped: true, coalesced: true, code: 'exactly_once_tool' };
          }
        }
      } catch (_) {}
      try {
        const danger = denyDangerousGenerateTools(mapped, args);
        if (danger && danger.ok === false) {
          const classified = classifyLoopError({ code: 'dangerous_tool' });
          return { prepared, result: 'ERROR: dangerous_tool: ' + classified.message, f7Image: null };
        }
        const pre = runPreToolHook(mapped, args);
        if (pre && pre.ok === false) {
          return { prepared, result: 'ERROR: ' + (pre.code || 'dangerous_tool'), f7Image: null };
        }
        const argCap = capToolArgBytes(args);
        if (argCap && argCap.ok === false) {
          return { prepared, result: 'ERROR: tool_args_invalid', f7Image: null };
        }
        const filePath = args && (args.path || args.file_path || args.target);
        try {
          if (filePath) {
            const badP = rejectControlCharsInPaths(filePath);
            if (badP && badP.ok === false) {
              return { prepared, result: 'ERROR: bad_path', f7Image: null };
            }
            const unc = rejectUncAndWindowsPaths(filePath);
            if (unc && unc.ok === false) {
              return { prepared, result: 'ERROR: bad_path', f7Image: null };
            }
            const sl = refuseWriteThroughSymlink(filePath, {});
            if (sl && sl.ok === false) {
              return { prepared, result: 'ERROR: symlink_write', f7Image: null };
            }
          }
        } catch (_) {}
        const wsRoot = process.env.SIRAGPT_WORKSPACE_ROOT || process.env.SIRAGPT_CODE_ROOT || '';
        if (filePath && wsRoot) {
          const jail = workspacePathJail(filePath, wsRoot);
          if (jail && jail.ok === false) {
            return { prepared, result: 'ERROR: path_traversal', f7Image: null };
          }
          try {
            const sym = rejectSymlinkEscape(filePath, wsRoot, {});
            if (sym && sym.ok === false) {
              return { prepared, result: 'ERROR: symlink_rejected', f7Image: null };
            }
          } catch (_) {}
        }
      } catch (_) {}
      const schema = toolSchemaFor(tools, mapped) || toolSchemaFor(tools, name);
      try {
        const stripped = stripAdditionalProperties(args, schema);
        if (stripped && stripped.ok === false) {
          return { prepared, result: 'ERROR: schema_invalid', f7Image: null };
        }
        if (stripped && stripped.ok && stripped.args) args = stripped.args;
      } catch (_) {}
      const schemaCheck = schema ? validateToolArgs(schema, args) : { ok: true };
      let repairedArgs = args;
      let repairOut = null;
      if (args.__parse_error || (schema && !schemaCheck.ok)) {
        const seen = repairBudget.see(mapped);
        repairOut = repairToolCallWithFeedback({
          name: mapped,
          args,
          schema,
          attempt: seen.count,
          maxAttempts: repairBudget.max,
        });
        if (repairOut.ok) {
          repairedArgs = repairOut.args;
        }
      }
      if (subDeny && subDeny.ok === false) {
        result = 'ERROR: ' + subDeny.code + ': ' + (subDeny.error || 'subagent_tool_denied');
      } else if (toolCircuit && toolCircuit.isOpen(mapped)) {
        result = 'ERROR: circuit_open: esta herramienta está en circuito abierto para el resto del turno.';
      } else if (!executor || call.__unknown) {
        const suggestion = call.__suggestion ? ` closest=${call.__suggestion}` : '';
        result = `ERROR: tool_unknown: unknown tool "${name}".${suggestion}`;
      } else if (repairOut && !repairOut.ok) {
        result = repairOut.feedback || `ERROR: ${repairOut.code}`;
        if (repairOut.code === 'tool_repair_exhausted') {
          stoppedReason = 'tool_repair_exhausted';
        }
      } else if (args.__parse_error && !(repairOut && repairOut.ok)) {
        result = `ERROR: tool_args_invalid: tool arguments were not valid JSON: ${args.raw}`;
      } else if (schema && !schemaCheck.ok && !(repairOut && repairOut.ok)) {
        result = `ERROR: ${schemaCheck.code}: ${schemaCheck.error}`;
      } else {
        let runArgs = repairedArgs;
        try {
          const coerced = coerceToolArgs(schema || { type: 'object' }, args);
          if (!coerced.ok) {
            result = `ERROR: ${coerced.code}: ${coerced.error}`;
          } else {
            runArgs = coerced.value || args;
          }
        } catch (_) { /* keep args */ }
        if (result != null) {
          // coercion_rejected already set; skip executor
        } else {
          const enumCheck = assertToolEnum(schema || { type: 'object' }, runArgs);
          if (!enumCheck.ok) {
            result = `ERROR: ${enumCheck.code}: ${enumCheck.error}`;
          } else try {
            try {
              const en = validateEnumArgs(runArgs, schema || { type: 'object' });
              if (en && en.ok === false) result = `ERROR: enum_rejected`;
            } catch (_) {}
            try {
              const tr = truncateOverlongArgStrings(runArgs);
              if (tr && tr.args) runArgs = tr.args;
            } catch (_) {}
            try {
              const repairedReq = repairMissingRequiredFromPriorTurn(runArgs, schema || { type: 'object' }, { prior: lastToolArgsByName[mapped] });
              if (repairedReq && repairedReq.ok === false) result = `ERROR: missing_required`;
              else if (repairedReq && repairedReq.args) runArgs = repairedReq.args;
            } catch (_) {}
            if (result != null) { /* enum rejected */ } else
            bail(iteration);
            const toolStarted = Date.now();
            const timeoutMs = splitModelVsToolTimeout('tool', mapped, toolTimeoutOverrides || {}).timeoutMs
              || overlayToolTimeoutMs(mapped, toolTimeoutOverrides || {}, toolTimeoutMs(mapped, toolTimeoutOverrides || {}));
            try {
              const remainMs = (turnDeadlineMs != null ? Number(turnDeadlineMs) - Date.now() : null);
              const fit = toolTimeoutFitsRemainingBudget({ remainingMs: remainMs, timeoutMs });
              if (fit && fit.skip) result = `ERROR: timeout_budget`;
            } catch (_) {}
            const sandboxish = /execute_python|execute_bash|bash/.test(String(mapped || ''));
            const execHb = sandboxish
              ? startExecHeartbeat((frame) => {
                try { onEvent({ ...frame, iteration, tool: mapped, label: 'Sandbox' }); } catch (_) {}
              }, { kind: 'sandbox', intervalMs: 8000 })
              : startToolHeartbeat((frame) => {
                try { onEvent({ ...frame, iteration, tool: mapped, label: 'Herramienta' }); } catch (_) {}
              }, { intervalMs: 8000 });
            const tracked = inFlightTools.track({
              id: toolId || `${mapped}:${Date.now()}`,
              abort: () => { try { if (signal && typeof signal.throwIfAborted === 'function') { /* user signal */ } } catch (_) {} },
            });
            const writePath = runArgs.path || runArgs.file_path || runArgs.target;
            const isWrite = /write_file|edit_file|str_replace|apply_patch/.test(String(mapped || ''));
            let pathLock = { ok: true, release() {} };
            if (isWrite && writePath) {
              try {
                const gate = createIfMissingOrRefuseLargeOverwrite({
                  path: String(writePath),
                  existingBytes: runArgs && (runArgs.existingBytes || runArgs.existing_bytes),
                  existingText: runArgs && (runArgs.existingText || runArgs.existing_text || runArgs.before),
                  exists: runArgs && runArgs.exists,
                  backupPath: runArgs && (runArgs.backupPath || runArgs.backup_path),
                });
                if (gate && gate.ok === false) {
                  result = `ERROR: file_too_large: ${classifyLoopError({ code: 'file_too_large' }).message}`;
                }
              } catch (_) {}
              try {
                const excl = createFileExclusive({
                  path: String(writePath),
                  exists: runArgs && runArgs.exists,
                  overwrite: runArgs && (runArgs.overwrite === true || runArgs.overwrite === 'true'),
                });
                if (excl && excl.ok === false) result = `ERROR: file_exists`;
              } catch (_) {}
              try { pathLock = claimPathMutation(String(writePath), toolId || mapped); } catch (_) {}
              if (pathLock && pathLock.ok === false) {
                result = `ERROR: path_mutation_busy: ${classifyLoopError({ code: 'path_mutation_busy' }).message}`;
              }
              try {
                const xlock = acquireCrossProcessFileLock(String(writePath), {});
                if (xlock && xlock.ok === false) {
                  result = `ERROR: path_mutation_busy: ${classifyLoopError({ code: 'path_mutation_busy' }).message}`;
                } else if (xlock && typeof xlock.release === 'function') {
                  const inner = pathLock && pathLock.release ? pathLock.release.bind(pathLock) : () => {};
                  pathLock = { ok: true, release() { try { xlock.release(); } catch (_) {} try { inner(); } catch (_) {} } };
                }
              } catch (_) {}
            }
            try {
              if (!isWrite && result == null) {
                const cached = lookupGetLikeToolCache(mapped, runArgs);
                if (cached && cached.hit) {
                  result = cached.result;
                }
              }
            } catch (_) {}
            try {
              if (result == null) {
                const hit = cacheIdenticalToolCallSameTurn(mapped, runArgs, { turn: sameTurnCache });
                if (hit && hit.cacheHit) result = hit.result;
              }
            } catch (_) {}
            try {
              if (result == null) {
                try {
                  const chunks = (runArgs && runArgs.__chunks) || (typeof runArgs === 'string' ? [runArgs] : null);
                  if (chunks) {
                    const streamed = repairStreamingJsonAcrossChunks(chunks);
                    if (streamed && streamed.ok && streamed.value && typeof streamed.value === 'object') {
                      runArgs = streamed.value;
                    }
                  }
                  const repairedJson = repairTruncatedJson(runArgs);
                  if (repairedJson && repairedJson.ok && repairedJson.repaired && typeof runArgs === 'string') {
                    runArgs = repairedJson.value;
                  }
                  try {
                    const comma = jsonRepairTrailingComma(typeof runArgs === 'string' ? runArgs : runArgs);
                    if (comma && comma.ok && comma.value && typeof runArgs === 'string') runArgs = comma.value;
                    else if (comma && comma.ok === false) result = `ERROR: json_parse`;
                  } catch (parseErr) {
                    try {
                      const jp = classifyJsonParseErrors(parseErr);
                      if (jp && jp.code) result = `ERROR: json_parse`;
                    } catch (_) {}
                  }
                  try {
                    const unq = repairUnquotedKeysInToolJson(typeof runArgs === 'string' ? runArgs : runArgs);
                    try {
                      const sq = repairSingleQuotesAndCommentsInToolJson(typeof runArgs === 'string' ? runArgs : runArgs);
                      if (sq && sq.ok && sq.value && typeof runArgs === 'string') runArgs = JSON.stringify(sq.value);
                      else if (sq && sq.ok && sq.value && typeof runArgs === 'object') runArgs = sq.value;
                    } catch (_) {}
                    try {
                      const schemaFalse = enforceAdditionalPropertiesFalse(schema);
                      if (schemaFalse && schemaFalse.schema) schema = schemaFalse.schema;
                    } catch (_) {}
                    try {
                      const boolc = coerceTrueFalseStringsToBool(runArgs, schema || { type: 'object' });
                      if (boolc && boolc.ok && boolc.value !== undefined) runArgs = boolc.value;
                    } catch (_) {}
                    try {
                      const safeLog = redactKeyLikeToolArgsFromLogs(runArgs);
                      if (safeLog && safeLog.redacted) { /* never log raw keys */ }
                    } catch (_) {}
                    try {
                      const pth = (runArgs && (runArgs.path || runArgs.file_path || runArgs.target)) || '';
                      const nulp = rejectNulInPath(pth);
                      if (nulp && nulp.ok === false) result = `ERROR: nul_path`;
                    } catch (_) {}
                    if (unq && unq.ok && unq.value && typeof runArgs === 'string') runArgs = unq.value;
                    else if (unq && unq.ok === false) result = `ERROR: json_parse`;
                  } catch (_) {}
                  try {
                    const nul = dropNullBytesInToolArgs(runArgs);
                    if (nul && nul.args !== undefined) runArgs = nul.args;
                  } catch (_) {}
                  runArgs = coerceStringyPrimitives(runArgs);
                  try {
                    const coercedInt = coerceIntegerFromNumericString(runArgs, schema || { type: 'object' });
                    if (coercedInt && coercedInt.ok === false) result = `ERROR: coercion_rejected`;
                    else if (coercedInt && coercedInt.value !== undefined) runArgs = coercedInt.value;
                  } catch (_) {}
                  try {
                    const depth = truncateNestedToolArgsDepth(runArgs);
                    if (depth && depth.args) runArgs = depth.args;
                  } catch (_) {}
                  const nested = coerceNestedArrayObjectTypes(runArgs);
                  if (nested && nested.ok === false) {
                    result = `ERROR: coercion_rejected`;
                  } else if (nested && nested.value !== undefined) {
                    runArgs = nested.value;
                  }
                } catch (_) {}
                try {
                  const toolRate = perToolRateLimit(String(threadId || streamId || 'anon'), mapped);
                  if (toolRate && toolRate.ok === false) {
                    result = 'ERROR: rate_limited';
                  }
                } catch (_) {}
                const retried = await retryToolWithBackoff(async () => {
                  return withToolTimeout(
                    (sig) => executor(runArgs, {
                      signal: sig || signal,
                      onChunk: (chunk, stream) => {
                        try {
                          const capped = capCommandStdout(chunk, { maxBytes: 64 * 1024 });
                          onEvent({
                            type: stream === 'stderr' ? 'tool_stderr' : 'tool_stdout',
                            iteration,
                            tool: mapped,
                            preview: previewOf(capped.text, 240),
                            label: 'Ejecutando',
                          });
                        } catch (_) { /* UI must never fail the tool */ }
                      },
                    }),
                    timeoutMs,
                    signal,
                  );
                }, { maxAttempts: 3, signal, sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)) });
                if (retried && retried.ok) result = retried.value;
                else {
                  const classified = classifyToolFailure(retried && retried.error);
                  result = `ERROR: ${classified.code}: ${classified.message}`;
                  try {
                    const fsE = classifyFsErrors(retried && retried.error);
                    if (fsE && fsE.code) result = `ERROR: ${fsE.code}: ${fsE.message}`;
                  } catch (_) {}
                  try { creditOnToolError(hold); } catch (_) {}
                  try {
                    const snapT = (usage && typeof usage.snapshot === 'function') ? usage.snapshot() : {};
                    creditAuditOnToolError({
                      tokens: (snapT.promptTokens || 0) + (snapT.completionTokens || 0),
                      tool: mapped,
                      code: classified.code,
                      session: String(threadId || streamId || ''),
                      prompt: snapT.promptTokens || 0,
                      completion: snapT.completionTokens || 0,
                    });
                  } catch (_) {}
                }
              }
            } finally {
              try { if (pathLock && typeof pathLock.release === 'function') pathLock.release(); } catch (_) {}
              try { tracked.done(); } catch (_) {}
              try { execHb.stop(); } catch (_) {}
              try { observeInflightMs(sandboxish ? 'sandbox' : 'generate', Date.now() - toolStarted); } catch (_) {}
            }
            try { observeToolExec(Date.now() - toolStarted); } catch (_) { /* optional */ }
            try {
              if (/apply_patch|edit_file|str_replace/.test(String(mapped || ''))) {
                const diffText = (runArgs && (runArgs.diff || runArgs.patch || runArgs.unified_diff)) || '';
                if (/^(--- |\+\+\+ )/m.test(String(diffText))) {
                  const srcRaw = (result && typeof result === 'object') ? (result.before || result.content || result.after || '') : '';
                  const norm = normalizeLineEndingsBeforeDiff(srcRaw);
                  const src = (norm && norm.text != null) ? norm.text : srcRaw;
                  const ctxMatch = patchContextLinesMustMatch({ haystack: src, diff: diffText });
                  if (ctxMatch && ctxMatch.ok === false) {
                    result = `ERROR: git_hunk_context`;
                  }
                  const applied = applyUnifiedDiff({ haystack: src, diff: diffText });
                  if (result && String(result).startsWith('ERROR: git_hunk_context')) {
                    /* keep context mismatch */
                  } else if (applied && applied.ok) {
                    result = Object.assign({}, (result && typeof result === 'object') ? result : {}, { after: applied.text, __unified: true });
                  } else if (applied && applied.ok === false) {
                    result = `ERROR: ${applied.code}: unified diff`;
                  }
                }
              }
            } catch (_) {}
            try {
              if (result && typeof result === 'object' && (result.stdout != null || result.stderr != null)) {
                result = splitStdoutStderrToolResult(result);
              }
            } catch (_) {}
            try {
              if (/str_replace|edit_file|write_file/.test(String(mapped || '')) && result && typeof result === 'object') {
                const chk = verifyStrReplace({
                  pathName: runArgs.path || runArgs.file_path || runArgs.target,
                  before: result.before,
                  after: result.after || result.content,
                  oldString: runArgs.old_string || runArgs.oldString,
                  newString: runArgs.new_string || runArgs.newString,
                });
                if (chk && chk.ok === false) {
                  try {
                    const fuzzy = fuzzyWhitespaceReplace({
                      haystack: result.before,
                      oldString: runArgs.old_string || runArgs.oldString,
                      newString: runArgs.new_string || runArgs.newString,
                    });
                    if (fuzzy && fuzzy.ok) {
                      result = { ...result, after: fuzzy.text, __fuzzy: true };
                    } else {
                      result = `ERROR: ${chk.code}: ${chk.error || chk.code}`;
                      try {
                        rollbackLastNFileEdits(checkpoint.latest && checkpoint.latest() || {}, { n: 3 });
                      } catch (_) {}
                    }
                  } catch (_) {
                    result = `ERROR: ${chk.code}: ${chk.error || chk.code}`;
                  }
                }
                try {
                  rememberFileEdit(checkpoint.latest && checkpoint.latest() || {}, {
                    path: runArgs.path || runArgs.file_path || runArgs.target,
                    before: result && result.before,
                    after: result && (result.after || result.content),
                  });
                } catch (_) {}
                try {
                  const afterText = result && (result.after || result.content);
                  const binEdit = refuseBinaryFileEdit(afterText == null ? '' : afterText);
                  if (binEdit && binEdit.ok === false) result = `ERROR: binary_file`;
                  else {
                    const ck = checkpointAfterSuccessfulWrite(writeCheckpoints, {
                      path: runArgs.path || runArgs.file_path || runArgs.target,
                      content: afterText,
                      verified: true,
                    });
                    if (ck && ck.checkpoints) {
                      writeCheckpoints.length = 0;
                      writeCheckpoints.push(...ck.checkpoints);
                    }
                    try {
                      if (ck && ck.checkpoint && ck.checkpoint.sha256) {
                        const sum = checksumVerifyAfterWrite({ actual: afterText, expectedSha256: ck.checkpoint.sha256 });
                        if (sum && sum.ok === false) result = `ERROR: write_checksum`;
                      }
                    } catch (_) {}
                    try {
                      const syn = syntaxCheckJsPyAfterWrite(runArgs.path || runArgs.file_path || runArgs.target, afterText);
                      if (syn && syn.ok === false) {
                        try {
                          const rb = rollbackFileOnSyntaxFail({
                            syntaxOk: false,
                            previous: result && result.before,
                            path: runArgs.path || runArgs.file_path || runArgs.target,
                          });
                          if (rb && rb.rolledBack) result = Object.assign({}, (result && typeof result === 'object') ? result : {}, { rolledBack: true, code: 'syntax_invalid' });
                        } catch (_) {}
                        result = `ERROR: syntax_invalid`;
                      }
                    } catch (_) {}
                  }
                } catch (_) {}
                try { invalidateToolCacheOnWrite(runArgs.path || runArgs.file_path || runArgs.target); } catch (_) {}
                try {
                  const hint = afterWriteTestHint({
                    path: runArgs.path || runArgs.file_path,
                    hasRunner: Boolean(executors.execute_bash || executors.bash),
                  });
                  if (hint && hint.hint) {
                    onEvent({ type: 'info', code: 'after_write_test', message: hint.text, iteration, tool: mapped });
                  }
                } catch (_) {}
              }
            } catch (_) { /* optional */ }
          } catch (err) {
            if (signal?.aborted) bail(iteration);
            if (mapped === 'retrieve_memory') {
              const memCode = (err && err.code === 'pgvector_failed') ? 'pgvector_failed' : 'retrieve_memory_failed';
              const classified = classifyLoopError({ code: memCode });
              result = `ERROR: ${classified.code}: ${classified.message}`;
            } else {
              let classified;
              try { classified = classifyToolFailure(err); } catch (_) { classified = classifyLoopError(err); }
              try {
                const jp = classifyJsonParseErrors(err);
                if (jp && jp.code) classified = jp;
              } catch (_) {}
              try {
                const ab = classifyAbortErrors(err);
                if (ab && ab.code) classified = ab;
              } catch (_) {}
              try {
                const ep = classifyEpipeAsCancelled(err, { stream: 'response' });
                if (ep && ep.code) classified = ep;
              } catch (_) {}
              const publicErr = sanitizeClientError(err);
              let pubMsg = publicErr && publicErr.message;
              try {
                const red = redactIpv4InPublicErrors(pubMsg);
                if (red && red.message) pubMsg = red.message;
              } catch (_) {}
              result = `ERROR: ${classified.code}: ${pubMsg}`;
              try {
                const nochg = neverChargeOnUnauthorized({ status: err && (err.status || err.statusCode), code: classified && classified.code, error: err });
                if (!(nochg && nochg.charge === false)) creditOnToolError(hold);
              } catch (_) { try { creditOnToolError(hold); } catch (_2) {} }
            }
          }
        }
      }
      let f7Image = null;
      if (result && typeof result === 'object' && result.__f7Image) {
        f7Image = result.__f7Image;
        result = String(result.text || '[imagen capturada]');
      }
      try {
        if (/read_file|computer_read/.test(String(mapped || '')) && typeof result === 'string') {
          const bin = refuseBinaryRead(result);
          if (bin && bin.ok === false) result = 'ERROR: git_binary_rejected';
          else {
            try {
              const bom = stripUtf8BomOnRead(result);
              if (bom && bom.text != null) result = bom.text;
            } catch (_) {}
            const numbered = formatReadWithLineNumbers({
              text: result,
              offset: Number((args && (args.offset || args.line)) || 1),
              limit: Number((args && args.limit) || 400),
            });
            if (numbered && numbered.text) result = numbered.text;
          }
        }
        if (/glob|list_files|grep/.test(String(mapped || ''))) {
          const paths = Array.isArray(result) ? result : (result && result.paths) || String(result || '').split('\n');
          const filtered = filterGlobHits(paths);
          const cappedG = skipGlobIfMatchCap(filtered && filtered.paths ? filtered.paths : paths);
          const nextPaths = (cappedG && cappedG.hits) || (filtered && filtered.paths) || [];
          result = Array.isArray(result) ? nextPaths : nextPaths.join('\n');
        }
        if (/web_fetch/.test(String(mapped || ''))) {
          try {
            const href = (args && (args.url || args.href)) || (runArgs && (runArgs.url || runArgs.href));
            const dup = skipDuplicateWebFetchSameUrlTurn(href, webFetchTurnCache, { result });
            if (dup && dup.cacheHit) {
              result = dup.result;
            }
          } catch (_) {}
        }
        if (/web_fetch/.test(String(mapped || '')) && result && typeof result === 'object') {
          const g = webFetchGuard({ contentType: result.contentType || result.type, bytes: (result.body || result.text || '').length, url: args && args.url });
          if (g && g.ok === false) result = 'ERROR: ' + g.code;
        }
        try {
          if (/write_file|edit_file|str_replace|apply_patch/.test(String(mapped || ''))) {
            const pth = runArgs && (runArgs.path || runArgs.file_path || runArgs.target);
            const nowHash = result && (result.sha256 || result.hash);
            const atRead = pth ? readChecksumByPath[String(pth)] : null;
            if (atRead || nowHash) {
              const stale = refuseEditIfChecksumChangedSinceRead({
                sha256Now: nowHash,
                sha256AtRead: atRead,
                actual: result && (result.before || result.content),
              });
              if (stale && stale.ok === false) result = `ERROR: file_changed`;
            }
            try {
              atomicWriteViaTempRename({
                path: pth,
                content: result && (result.after || result.content),
              });
            } catch (_) {}
          }
        } catch (_) {}
        try {
          if (/read_file/.test(String(mapped || '')) && result && typeof result === 'object') {
            const pth = runArgs && (runArgs.path || runArgs.file_path || runArgs.target);
            const h = result.sha256 || result.hash;
            if (pth && h) readChecksumByPath[String(pth)] = h;
          }
        } catch (_) {}
        if (/write_file|edit_file/.test(String(mapped || '')) && result && typeof result === 'object') {
          const skip = skipUnchangedWrite({ before: result.before, after: result.after || result.content });
          if (skip && skip.skip) result = { ...result, noop: true, code: 'write_noop' };
        }
        const red = redactSecretsInToolResult(typeof result === 'string' ? result : JSON.stringify(result));
        if (red && red.redacted) result = red.text;
        try {
          const urls = redactUrlsWithCredentials(typeof result === 'string' ? result : JSON.stringify(result));
          if (urls && urls.redacted) result = urls.text;
        } catch (_) {}
        try {
          const gz = gzipToolResultOverSize(typeof result === 'string' ? result : result);
          if (gz && gz.gzipped) result = gz.text;
        } catch (_) {}
        const hashed = clampToolResultWithHash(result);
        if (hashed && hashed.truncated) result = hashed.text;
        else {
          const capped = capToolResult(result);
          if (capped && capped.truncated) result = capped.text;
          try {
            const marked = truncateToolResultWithMarker(result, { maxBytes: 12000 });
            if (marked && marked.truncated) result = marked.text;
          } catch (_) {}
        }
      } catch (_) { /* keep raw */ }
      try { if (toolId) toolOnce.recordResult(toolId, result); } catch (_) {}
      try { rememberCallResult(callReplayStore, { toolCallId: toolId, args, result }); } catch (_) {}
      try { if (result != null && !String(result).startsWith('ERROR:')) storeGetLikeToolCache(mapped, args, result); } catch (_) {}
      try { if (result != null && !String(result).startsWith('ERROR:')) cacheIdenticalToolCallSameTurn(mapped, args, { turn: sameTurnCache, result }); } catch (_) {}
      try { if (runArgs && mapped) lastToolArgsByName[mapped] = runArgs; } catch (_) {}
      try {
        const shape = validateToolResultShape(result);
        if (shape && shape.ok === false) result = shape.result || { ok: false, code: 'bad_tool_result' };
      } catch (_) {}
      try {
        if (subagent || subagentType || /subagent|delegate/.test(String(mapped || ''))) {
          const cappedSub = subagentResultSizeCap(result);
          if (cappedSub && cappedSub.truncated) result = cappedSub.result;
        }
      } catch (_) {}
      try {
        const home = redactHomePathsInResults(typeof result === 'string' ? result : result);
        if (home && home.redacted) result = home.text;
      } catch (_) {}
      try {
        const ping = ssePingOnIdleTool({ elapsedMs: Date.now() - (typeof toolStarted === 'number' ? toolStarted : Date.now()) });
        if (ping && ping.ping) onEvent({ type: 'ping', ping: true, code: 'sse_heartbeat', iteration });
      } catch (_) {}
      try {
        const obs = observationCut.see({ tool: mapped, result });
        if (obs && obs.cut) {
          stoppedReason = 'identical_observation_loop';
          onEvent({ type: 'error', code: 'identical_observation_loop', message: classifyLoopError({ code: 'identical_observation_loop' }).message, retryable: false, iteration });
        }
      } catch (_) {}
      try {
        const errCode = (result && result.code) || (typeof result === 'string' && result.startsWith('ERROR:') ? String(result).split(/[:\s]+/)[1] : null);
        if (errCode) {
          const dead = deadLetterCut.see(mapped, errCode);
          if (dead && dead.halt) {
            stoppedReason = 'tool_dead_letter';
            onEvent({ type: 'error', code: 'tool_dead_letter', message: classifyLoopError({ code: 'tool_dead_letter' }).message, retryable: false, iteration });
          }
        }
      } catch (_) {}
      try { turnToolState.toolCount = (turnToolState.toolCount || 0) + 1; } catch (_) {}
      lastToolResultAt = Date.now();
      return { prepared, result, f7Image };
    };

    const consumeGuards = (prepared) => {
      if (stepBudget.exceeded() || stepBudget.consume(1)) {
        return { cut: 'budget_exceeded' };
      }
      const seen = repeatGuard.see(prepared.mapped, prepared.args);
      if (seen.cut) return { cut: 'loop_cut', seen };
      try {
        const consec = consecutiveCut.see(prepared.mapped, prepared.args);
        if (consec.cut) return { cut: 'loop_cut', seen: consec };
      } catch (_) {}
      try {
        const dag = (prepared.args && prepared.args.__dag) || null;
        if (dag) {
          const cyc = detectDagCycle(dag);
          if (cyc && cyc.ok === false) return { cut: 'dag_cycle' };
        }
      } catch (_) {}
      try {
        const left = sessionRemainingSteps(String(threadId || streamId || 'anon'), { consume: 1 });
        if (left && left.ok === false) return { cut: 'budget_exceeded' };
      } catch (_) {}
      return { cut: null, seen };
    };

    let repairStop = false;
    const commitResult = (prepared, result, f7Image, viaReactFlag) => {
      const { call, mapped, args } = prepared;
      const ok = !String(result).startsWith('ERROR:');
      if (!ok) {
        try {
          const fp = retryTracker.fingerprint(mapped);
          const rec = retryTracker.recordFailure(fp);
          if (rec.exhausted) {
            const classified = classifyLoopError({ code: 'dlq_exhausted' });
            onEvent({
              type: 'error',
              code: 'dlq_exhausted',
              tool: mapped,
              count: rec.count,
              message: classified.message,
              retryable: classified.retryable,
              iteration,
            });
            try {
              const plan = scheduleDlqReplayCapped({ exhausted: true, retries: rec.count }, { jitter: false, maxAttempts: 3 });
              if (!plan.ok) {
                /* already exhausted; classified above */
              }
            } catch (_) { /* optional */ }
          } else {
            try {
              const plan = scheduleDlqReplayCapped({ retries: rec.count, error: 'tool_failed' }, { jitter: false, maxAttempts: 3 });
              if (plan.ok) {
                onEvent({
                  type: 'error',
                  code: 'dlq_replay',
                  tool: mapped,
                  delayMs: plan.delayMs,
                  message: classifyLoopError({ code: 'dlq_replay' }).message,
                  retryable: true,
                  iteration,
                });
              } else if (plan && plan.code === 'dlq_poison') {
                const classified = classifyLoopError({ code: 'dlq_poison' });
                onEvent({
                  type: 'error',
                  code: 'dlq_poison',
                  tool: mapped,
                  count: rec.count,
                  message: classified.message,
                  retryable: false,
                  iteration,
                });
              }
            } catch (_) { /* optional */ }
          }
        } catch (_) { /* optional */ }
      } else {
        try { retryTracker.reset(retryTracker.fingerprint(mapped)); } catch (_) { /* optional */ }
      }
      try { if (toolCircuit) toolCircuit.record(mapped, ok); } catch (_) { /* optional */ }
      try {
        if (errorBudget) {
          const bud = errorBudget.record(ok);
          if (bud && bud.stop) {
            const classified = classifyLoopError({ code: 'error_budget' });
            onEvent({
              type: 'error',
              code: 'error_budget',
              tool: mapped,
              message: classified.message,
              retryable: false,
              iteration,
            });
          }
        }
      } catch (_) { /* optional */ }
      if (!ok && /tool_args_invalid/.test(String(result))) {
        const rolled = checkpoint.restoreN
          ? checkpoint.restoreN(messages, 1)
          : (checkpoint.restore ? checkpoint.restore(messages) : checkpoint.rollback());
        if (rolled && Array.isArray(rolled.messages)) {
          if (!checkpoint.restoreN && !checkpoint.restore) {
            restoreMessagesFromCheckpoint(messages, rolled);
          }
          onEvent({
            type: 'checkpoint_rollback',
            iteration,
            checkpointId: rolled.id,
            restored: messages.length,
            depth: typeof checkpoint.depth === 'function' ? checkpoint.depth() : undefined,
            label: 'Revirtiendo argumentos inválidos',
          });
        }
      }
      steps.push({ iteration, tool: mapped, args, ok, resultPreview: previewOf(result, 400), viaReact: viaReactFlag });
      try {
        stepTelemetry.record({
          stepIndex: steps.length,
          type: 'tool_call',
          toolName: mapped,
          args,
          result: previewOf(result, 400),
          status: ok ? 'completed' : 'error',
          isError: !ok,
        });
      } catch (_) { /* fail-open */ }
      onEvent({
        type: 'tool_result',
        iteration,
        tool: mapped,
        ok,
        preview: previewOf(result, 400),
        label: ok ? 'Verificando resultado' : 'Reintentando',
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${iteration}_${mapped}`,
        content: String(result),
      });
      if (stoppedReason === 'tool_repair_exhausted' || /tool_repair_exhausted/.test(String(result))) {
        const classified = classifyLoopError({ code: 'tool_repair_exhausted' });
        stoppedReason = 'tool_repair_exhausted';
        finalText = classified.message;
        onEvent({ type: 'error', code: 'tool_repair_exhausted', tool: mapped, message: classified.message, retryable: false, iteration });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Reparacion agotada' });
        repairStop = true;
      }
      if (f7Image) {
        try {
          const { buildImageDataMessage } = require('./multimodal');
          messages.push(buildImageDataMessage([f7Image]));
        } catch (_) { /* F7 module absent — the text result was delivered */ }
      }
    };

    const storm = capToolStorm(toolCalls.map(prepareCall), { max: 8 });
    const preparedAll = storm.keep;
    if (storm.dropped) {
      onEvent({
        type: 'error',
        code: 'tool_storm',
        message: classifyLoopError({ code: 'tool_storm' }).message,
        retryable: false,
        iteration,
        dropped: storm.dropped,
      });
    }
    let stopNow = null;
    for (const prepared of preparedAll) {
      bail(iteration);
      const guard = consumeGuards(prepared);
      if (guard.cut === 'budget_exceeded') {
        stoppedReason = 'budget_exceeded';
        onEvent({
          type: 'budget_exceeded',
          code: 'budget_exceeded',
          iterations: iteration,
          maxIterations: cap,
          toolSteps: stepBudget.used(),
          toolStepCap: stepBudget.cap,
          label: 'Presupuesto del agente agotado',
        });
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Listo' });
        stopNow = finish({ iterations: iteration, stoppedReason: 'budget_exceeded' });
        break;
      }
      if (guard.cut === 'loop_cut') {
        stoppedReason = 'loop_cut';
        const classified = classifyLoopError({ code: 'loop_cut' });
        onEvent({
          type: 'loop_cut',
          code: 'loop_cut',
          iteration,
          tool: prepared.mapped,
          count: guard.seen && guard.seen.count,
          label: classified.message,
        });
        finalText = classified.message;
        onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Bucle detenido' });
        stopNow = finish({ iterations: iteration, stoppedReason: 'loop_cut', errorCode: 'loop_cut' });
        break;
      }
      onEvent({
        type: 'tool_call',
        iteration,
        tool: prepared.mapped,
        args: prepared.args,
        preview: previewOf(prepared.args.code || prepared.args.command || prepared.args.path || prepared.args.color || prepared.args),
        label: activityTextFor({
          tool: prepared.mapped,
          args: prepared.args,
          label: prepared.mapped === 'render_preview' ? 'Verificando resultado' : 'Ejecutando código',
        }),
        viaReact,
        repaired: Boolean(prepared.call.__repaired),
      });
    }
    if (stopNow) return stopNow;

    const parallel = canRunToolsInParallel(preparedAll.map((p) => p.call));
    let stormCalls = preparedAll;
    try {
      const conc = maxConcurrentToolsPerTurn(preparedAll, { max: 4 });
      try {
        isolateParallelToolTimeout(stormCalls || preparedAll, { timeoutMs: 15000 });
      } catch (_) {}
      try {
        const kids = (opts && opts.subagents) || [];
        const conc = maxConcurrentSubagents(kids, { max: 2 });
        if (conc && conc.halt) onEvent({ type: 'info', code: 'subagent_concurrency', deferred: true, count: (conc.deferred || []).length, iteration });
        for (const kid of (conc && conc.run) || []) {
          try { subagentInheritAbortSignal({ parentSignal: signal, child: kid }); } catch (_) {}
        }
      } catch (_) {}
      if (conc && Array.isArray(conc.run)) stormCalls = conc.run;
      if (conc && Array.isArray(conc.deferred) && conc.deferred.length) {
        onEvent({ type: 'info', code: 'tool_storm', deferred: true, count: conc.deferred.length, iteration });
      }
    } catch (_) {}
    let run;
    try {
      run = await runToolStorm(stormCalls, executePrepared, {
        maxParallel: parallel ? 4 : 1,
        maxBatch: 8,
      });
    } catch (stormErr) {
      try {
        const snap = usage.snapshot();
        settleStormCancel(hold, {
          used: (snap.promptTokens || 0) + (snap.completionTokens || 0),
          aborted: true,
        });
      } catch (_) { /* optional */ }
      throw stormErr;
    }
    if (signal?.aborted) {
      try {
        waitInflightToolThenDropOnCancel({ cancelled: true, inflight: stormCalls || preparedAll });
        holdSettleNeverDoubleCharge({ held: true, settled: false, cancelled: true });
      } catch (_) {}
      try {
        const snap = usage.snapshot();
        settleStormCancel(hold, {
          used: (snap.promptTokens || 0) + (snap.completionTokens || 0),
          aborted: true,
        });
      } catch (_) { /* optional */ }
    }
    let executed = run.executed || [];
    try {
      const { stormOverflowResult } = require('./engine-completion');
      for (const extra of (storm.overflow || [])) executed.push(stormOverflowResult(extra));
    } catch (_) { /* overflow already in run.executed when uncapped */ }
    try {
      if (signal && signal.aborted) {
        const stopped = cancelInflightToolsOnStop(executed, { aborted: true });
        if (stopped && Array.isArray(stopped.results)) {
          executed = executed.map((item, i) => {
            const rec = stopped.results[i];
            if (rec && rec.cancelled) return Object.assign({}, item, { result: rec, cancelled: true });
            return item;
          });
        }
      }
    } catch (_) {}
    try {
      const ordered = joinParallelToolResultsStableOrder(stormCalls, executed);
      if (ordered && Array.isArray(ordered.results)) {
        executed = ordered.results.filter(Boolean);
      }
    } catch (_) {}
    for (const item of executed) {
      commitResult(item.prepared, item.result, item.f7Image, viaReact);
    }
    if (repairStop || stoppedReason === 'tool_repair_exhausted') {
      return finish({ iterations: iteration, stoppedReason: 'tool_repair_exhausted', errorCode: 'tool_repair_exhausted' });
    }
    if (errorBudget && errorBudget.remaining() <= 0) {
      const classified = classifyLoopError({ code: 'error_budget' });
      stoppedReason = 'error_budget';
      finalText = classified.message;
      onEvent({ type: 'final', text: finalText, iterations: iteration, label: 'Presupuesto de errores' });
      return finish({ iterations: iteration, stoppedReason: 'error_budget', errorCode: 'error_budget' });
    }
  }

  bail(cap);
  if (stoppedReason === 'max_iterations') {
    onEvent({
      type: 'budget_exceeded',
      code: 'budget_exceeded',
      iterations: cap,
      maxIterations: cap,
      label: 'Presupuesto del agente agotado',
    });
  }
  onEvent({ type: 'final', text: finalText, iterations: cap, label: 'Listo' });
  return finish({ iterations: cap, stoppedReason });
  } catch (err) {
    const turnEndMs = Date.now() - startedAt;
    try { if (firstTokenMs != null) observeFirstToken(firstTokenMs); } catch (_) { /* optional */ }
    try { observeTurnEnd(turnEndMs); } catch (_) { /* optional */ }
    try { endConcurrentTurn(turnEndMs, concurrentInflight); } catch (_) { /* optional */ }
    try {
      const gate = creditOnLlmFailure(err, hold);
      try {
        const snap = usage.snapshot() || {};
        refundZeroTokenError({
          usage: { promptTokens: snap.promptTokens, completionTokens: snap.completionTokens, totalTokens: snap.totalTokens },
          error: err,
          hold,
        });
        try { releaseCreditHold(String(threadId || streamId || 'anon'), generateRequestId); } catch (_) {}
      } catch (_) {}
      if (gate && gate.code === 'credit_no_usage') {
        /* released hold; do not settle as used tokens */
      } else {
        const snap = usage.snapshot();
        settleStormCancel(hold, {
          used: (snap.promptTokens || 0) + (snap.completionTokens || 0),
          aborted: true,
        });
        accountCreditsOnCancel({ hold, usage, aborted: true });
      }
    } catch (_) { /* optional */ }
    try { await runCleanup(); } catch (_) { /* ignore */ }
    try {
      const sup = classifyTurnSuperseded(err) || classifyTurnSuperseded(signal);
      if (sup) {
        err.code = err.code || 'turn_superseded';
      }
    } catch (_) { /* optional */ }
    if (err && typeof err === 'object') {
      err.usage = usage.snapshot();
      err.firstTokenMs = firstTokenMs;
      err.turnEndMs = turnEndMs;
      err.checkpointId = (checkpoint.latest() && checkpoint.latest().id) || null;
    }
    try {
      if (kv && streamId) await persistUsage(kv, streamId, usage.snapshot());
    } catch (_) { /* optional */ }
    throw err;
  }
}

module.exports = {
  runAgentLoop,
  MAX_ITERATIONS_DEFAULT,
  MAX_VERIFICATION_RETRIES,
  MAX_TOKENS_DEFAULT,
  resolveAgentRunnerMaxTokens,
  isLlmCreditError,
};
