'use strict';

/**
 * Privacy boundary for /api/ai/generate telemetry.
 *
 * Generate handles prompts, documents and tenant identifiers. Those values are
 * useful to the product, but they do not belong in operational logs. This
 * module deliberately accepts a small, flat allowlist of counters, booleans
 * and enum-like values. Everything else is dropped before it reaches Pino.
 */

const { logger: defaultLogger } = require('../../middleware/logger');

const NUMERIC_LIMITS = Object.freeze({
  attachmentCount: [0, 100_000],
  assistantFileCount: [0, 100_000],
  attempt: [0, 1_000],
  cacheableBlockCount: [0, 100_000],
  confidence: [0, 100],
  contradictedCount: [0, 1_000_000],
  delayMs: [0, 604_800_000],
  documentCount: [0, 100_000],
  droppedMessageCount: [0, 1_000_000],
  durationMs: [0, 604_800_000],
  fidelityTotal: [0, 1_000_000],
  historyMessageCount: [0, 1_000_000],
  imageCount: [0, 100_000],
  keptMessageCount: [0, 1_000_000],
  maxAttempts: [0, 1_000],
  patternCount: [0, 1_000_000],
  promptChars: [0, 100_000_000],
  recoveredCount: [0, 1_000_000],
  responseChars: [0, 100_000_000],
  score: [0, 100],
  sourceCount: [0, 1_000_000],
  status: [100, 599],
  systemBlockCount: [0, 1_000_000],
  systemPromptChars: [0, 100_000_000],
  threadTurnCount: [0, 1_000_000],
  tokenCount: [0, 1_000_000_000],
  unsupportedCount: [0, 1_000_000],
});
const NUMERIC_FIELDS = new Set(Object.keys(NUMERIC_LIMITS));

const BOOLEAN_FIELDS = new Set([
  'authenticated',
  'canPersist',
  'hasChat',
  'hasFiles',
  'hasIdempotencyKey',
  'hasStream',
  'publicWeb',
  'regenerate',
  'resume',
  'retryable',
  'success',
]);

const ENUM_VALUES = Object.freeze({
  action: new Set([
    'allow', 'annotate', 'ask', 'auto_select', 'block', 'correct',
    'count_region_rows', 'difference_rows', 'escalate', 'execute', 'fallback',
    'filter', 'keep', 'max_period_for_row', 'max_total_row', 'min_total_row',
    'none', 'pass', 'replace', 'rewrite', 'skip', 'sum_rows', 'transform',
    'unknown',
  ]),
  detectedLanguage: new Set([
    'ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr',
    'uk', 'unknown', 'vi', 'zh',
  ]),
  errorCode: new Set([
    'abort_err', 'aborted', 'econnrefused', 'econnreset', 'etimedout',
    'rate_limit_exceeded', 'timeout', 'unknown',
  ]),
  errorName: new Set([
    'abort_error', 'aggregate_error', 'error', 'provider_request_error',
    'range_error', 'reference_error', 'syntax_error', 'timeout_error',
    'type_error', 'unknown_error',
  ]),
  grade: new Set(['a', 'b', 'c', 'd', 'e', 'f', 'pass', 'fail', 'unknown']),
  language: new Set([
    'ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr',
    'uk', 'unknown', 'vi', 'zh',
  ]),
  mode: new Set([
    'agentic', 'auto', 'build', 'conversar', 'direct', 'escalate', 'extended',
    'fast', 'off', 'plan', 'planificar', 'self_consistency', 'standard',
    'thinking', 'unknown',
  ]),
  outcome: new Set([
    'aborted', 'completed', 'degraded', 'failed', 'replayed', 'skipped',
    'success', 'unknown',
  ]),
  phase: new Set([
    'admission', 'context', 'generation', 'persistence', 'postprocess',
    'preflight', 'routing', 'unknown',
  ]),
  reasonCode: new Set([
    'auto_select', 'capacity_exceeded', 'duplicate', 'duplicate_turn',
    'escalate', 'fair_queue', 'idempotency_conflict', 'not_applied',
    'queue_fairness', 'queue_wait', 'rate_limited', 'timeout', 'unknown',
  ]),
  resolvedLanguage: new Set([
    'ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr',
    'uk', 'unknown', 'vi', 'zh',
  ]),
  route: new Set([
    'agentic', 'build', 'conversar', 'direct', 'planificar', 'public_web',
    'unknown',
  ]),
  source: new Set([
    'default', 'detector', 'explicit', 'explicit_instruction', 'fallback',
    'fallback_locale', 'extractive', 'heuristic', 'heuristic_override',
    'heuristic_vague', 'judge', 'llm', 'message_detection', 'policy',
    'request_abort', 'response_close', 'skip', 'thread', 'thread_preference',
    'unknown', 'user',
  ]),
});
const ENUM_FIELDS = new Set(Object.keys(ENUM_VALUES));

const ENUM_VALUE_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const EVENT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ALLOWED_EVENTS = new Set([
  'agentic.degraded',
  'agentic.loop_failed',
  'artifacts.generation_declined',
  'artifacts.generation_failed',
  'artifacts.vision_image_read_failed',
  'attribution.completed',
  'attribution.confidence_calibrated',
  'attribution.failed',
  'attribution.intent_graph_completed',
  'attribution.intent_graph_failed',
  'autonomy.codex_delegation_failed',
  'autonomy.goal_escalation_failed',
  'capabilities.openclaw_kernel_unavailable',
  'client.detached',
  'connections.custom_lookup_failed',
  'connections.custom_relookup_failed',
  'constraints.extracted',
  'constraints.verification_completed',
  'constraints.verification_failed',
  'context.background_compaction_completed',
  'context.compacted',
  'context.compaction_failed',
  'context.compaction_not_applied',
  'context.custom_gpt_loaded',
  'context.fitted',
  'context.project_loaded',
  'cowork.enrichment_failed',
  'document.creation_failed',
  'document.creation_started',
  'document.history_fallback_completed',
  'document.history_fallback_started',
  'document.image_history_added',
  'document.image_history_empty',
  'document.image_history_failed',
  'document.image_history_found',
  'document.image_history_parse_failed',
  'document.image_history_scan_started',
  'documents.enrichment_budget_applied',
  'documents.enrichment_budget_failed',
  'documents.enrichment_completed',
  'documents.enrichment_degraded',
  'documents.history_recovery_failed',
  'documents.professional_analyzer_unavailable',
  'documents.reattach_failed',
  'documents.reattached',
  'documents.recovered_context_failed',
  'documents.recovered_from_history',
  'documents.uploaded_context_failed',
  'faithfulness.check_failed',
  'faithfulness.completed',
  'feedback.exemplars_unavailable',
  'fidelity.failed',
  'fidelity.warning',
  'filters.post_hook_failed',
  'filters.pre_hook_failed',
  'history.files_parse_failed',
  'history.image_added',
  'history.image_missing',
  'history.image_processing_failed',
  'history.load_failed',
  'idempotency.active_turn_replayed',
  'idempotency.active_turn_wait_failed',
  'idempotency.completed_turn_check_failed',
  'idempotency.completed_turn_replayed',
  'idempotency.payload_conflict',
  'idempotency.stale_turn_dropped',
  'intent.typo_repaired',
  'language.resolved',
  'memory.cross_chat_recalled',
  'memory.cross_chat_recall_failed',
  'memory.document_block_failed',
  'memory.extraction_schedule_failed',
  'memory.orchestration_unavailable',
  'memory.recall_failed',
  'metrics.stream_record_failed',
  'middleware.organization_budget_failed',
  'middleware.organization_quota_failed',
  'middleware.organization_rate_limit_failed',
  'ownership.precheck_failed',
  'persistence.abort_save_failed',
  'persistence.abort_saved',
  'persistence.agent_run_failed',
  'persistence.chat_missing',
  'persistence.completed',
  'persistence.duplicate_skipped',
  'persistence.empty_assistant_skipped',
  'persistence.exhausted',
  'persistence.failed',
  'persistence.idempotency_conflict',
  'persistence.retry_crashed',
  'persistence.retry_scheduled',
  'persistence.started',
  'preferences.organization_lookup_failed',
  'profile.inference_applied',
  'profile.load_failed',
  'prompt.budget_applied',
  'prompt.budget_failed',
  'prompt.built',
  'prompt.kernel_pruned',
  'prompt.kernel_pruning_failed',
  'prompt.short_chitchat_slimmed',
  'prompt.token_preflight_failed',
  'public_web.grounding_unavailable',
  'public_web.usage_record_failed',
  'queue.rejected',
  'quota.attachment_exempt',
  'rag.operational_unavailable',
  'rag.rerank_failed',
  'rag.reranked',
  'reasoning.confidence_calibrated',
  'reasoning.decision_completed',
  'reasoning.document_compute_upgraded',
  'reasoning.orchestrator_failed',
  'reasoning.test_time_compute_applied',
  'reasoning.test_time_compute_skipped',
  'reasoning.trivial_kept_direct',
  'reasoning.user_override_applied',
  'recovery.attachment_after_stream_error',
  'recovery.attachment_after_stream_error_failed',
  'recovery.attachment_applied',
  'recovery.attachment_failed',
  'recovery.direct_normalization_applied',
  'recovery.direct_normalization_failed',
  'recovery.extracted_field_applied',
  'recovery.extracted_field_failed',
  'recovery.spreadsheet_direct',
  'recovery.spreadsheet_failed',
  'recovery.spreadsheet_follow_up',
  'request.accepted',
  'request.failed',
  'response.minimum_content_guard',
  'resume.open_failed',
  'resume.replay_failed',
  'resume.signing_secret_missing',
  'routing.gateway_selected',
  'routing.intent_triage_completed',
  'routing.intent_triage_failed',
  'routing.intent_triage_persistence_failed',
  'routing.reroute_skipped',
  'routing.rerouted',
  'routing.tool_capable_model_restored',
  'saliency.classification_failed',
  'security.adversarial_analysis_failed',
  'security.prompt_injection_detector_failed',
  'security.prompt_injection_suspected',
  'stream.aborted',
  'stream.failed',
  'stream.registered',
  'stream.unregistered',
  'tasks.enterprise_contract_unavailable',
  'understanding.packet_unavailable',
  'usage.trailer_write_failed',
  'vision.images_stripped',
  'vision.runtime_selected',
  'web_search.unavailable',
  'invalid_event',
  'telemetry_failed',
]);

function toEnumValue(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return ENUM_VALUE_RE.test(normalized) ? normalized : null;
}

function toControlledEnum(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return ENUM_VALUE_RE.test(candidate) ? candidate : null;
}

function normalizeEvent(event) {
  const candidate = typeof event === 'string' ? event.trim().toLowerCase() : '';
  return EVENT_RE.test(candidate) && ALLOWED_EVENTS.has(candidate) ? candidate : 'invalid_event';
}

function sanitizeGenerateFields(fields) {
  try {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
      if (NUMERIC_FIELDS.has(key)) {
        if (typeof value !== 'number') continue;
        if (Number.isFinite(value)) {
          const [minimum, maximum] = NUMERIC_LIMITS[key];
          if (key === 'status' && (value < minimum || value > maximum)) continue;
          safe[key] = Math.min(maximum, Math.max(minimum, value));
        }
        continue;
      }
      if (BOOLEAN_FIELDS.has(key)) {
        if (typeof value === 'boolean') safe[key] = value;
        continue;
      }
      if (ENUM_FIELDS.has(key)) {
        const normalized = toControlledEnum(value);
        if (normalized && ENUM_VALUES[key].has(normalized)) safe[key] = normalized;
      }
    }
    return safe;
  } catch (_error) {
    return {};
  }
}

function safeErrorFields(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return { errorName: 'error' };
  }

  try {
    const normalizedName = toEnumValue(error.name) || 'error';
    const fields = {
      errorName: ENUM_VALUES.errorName.has(normalizedName) ? normalizedName : 'error',
    };
    const errorCode = toEnumValue(error.code);
    if (errorCode && ENUM_VALUES.errorCode.has(errorCode)) fields.errorCode = errorCode;
    const rawStatus = error.status ?? error.statusCode;
    if (typeof rawStatus === 'number' && Number.isFinite(rawStatus) && rawStatus >= 100 && rawStatus <= 599) {
      fields.status = rawStatus;
    }
    return fields;
  } catch (_error) {
    return { errorName: 'error' };
  }
}

function summarizeGenerateRequest(input) {
  try {
    const {
      prompt,
      files,
      chatId,
      streamId,
      idempotencyKey,
      regenerate,
      resume,
      publicWeb,
      authenticated,
    } = input && typeof input === 'object' ? input : {};
    return {
      promptChars: typeof prompt === 'string' ? prompt.length : 0,
      attachmentCount: Array.isArray(files) ? files.length : 0,
      hasChat: Boolean(chatId),
      hasStream: Boolean(streamId),
      hasIdempotencyKey: Boolean(idempotencyKey),
      regenerate: regenerate === true,
      resume: resume === true,
      publicWeb: publicWeb === true,
      authenticated: authenticated === true,
    };
  } catch (_error) {
    return {
      promptChars: 0,
      attachmentCount: 0,
      hasChat: false,
      hasStream: false,
      hasIdempotencyKey: false,
      regenerate: false,
      resume: false,
      publicWeb: false,
      authenticated: false,
    };
  }
}

function createGenerateLogger(options) {
  let sink = defaultLogger;
  try {
    const logger = options && typeof options === 'object' ? options.logger : null;
    if (logger && typeof logger === 'object') sink = logger;
  } catch (_error) {
    sink = defaultLogger;
  }

  function emit(level, event, fields) {
    try {
      const payload = {
        event: `ai.generate.${normalizeEvent(event)}`,
        ...sanitizeGenerateFields(fields),
      };
      if (sink && typeof sink[level] === 'function') sink[level](payload, 'ai.generate');
      return payload;
    } catch (_error) {
      // Telemetry is best-effort and must never break a user turn.
      return { event: 'ai.generate.telemetry_failed' };
    }
  }

  return Object.freeze({
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    warnError: (event, error, fields) => emit('warn', event, {
      ...sanitizeGenerateFields(fields),
      ...safeErrorFields(error),
    }),
    error: (event, error, fields) => emit('error', event, {
      ...sanitizeGenerateFields(fields),
      ...safeErrorFields(error),
    }),
  });
}

module.exports = {
  BOOLEAN_FIELDS,
  ALLOWED_EVENTS,
  ENUM_FIELDS,
  ENUM_VALUES,
  NUMERIC_FIELDS,
  NUMERIC_LIMITS,
  createGenerateLogger,
  safeErrorFields,
  sanitizeGenerateFields,
  summarizeGenerateRequest,
};
