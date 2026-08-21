'use strict';

const CODES = Object.freeze({
  USER_REQUIRED: 'user_required',
  EMPTY_PROMPT: 'empty_prompt',
  PROMPT_TOO_LONG: 'prompt_too_long',
  SESSION_ABORTED: 'session_aborted',
  SESSION_QUEUE_FULL: 'session_queue_full',
  CRON_TIMEOUT: 'cron_timeout',
  CRON_BUSY: 'cron_busy',
  CRON_DISPATCH_UNAVAILABLE: 'cron_dispatch_unavailable',
  SANDBOX_NO_BACKEND: 'sandbox_no_backend',
  SANDBOX_LANGUAGE_NOT_ALLOWED: 'sandbox_language_not_allowed',
  SANDBOX_CODE_TOO_LONG: 'sandbox_code_too_long',
  SKILL_FORBIDDEN: 'skill_forbidden',
  MODEL_FORBIDDEN: 'model_forbidden',
  TURN_TIMEOUT: 'turn_timeout',
  DUPLICATE_TURN: 'duplicate_turn',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  WEBHOOK_HMAC_FAILED: 'webhook_hmac_failed',
  DELIVERY_ID_TOO_LONG: 'delivery_id_too_long',
  CRON_JOB_ID_TOO_LONG: 'cron_job_id_too_long',
  PAYLOAD_TOO_LONG: 'payload_too_long',
  FORBIDDEN: 'forbidden',
  EMPTY_TEXT: 'empty_text',
  INVALID_SKILL_NAME: 'invalid_skill_name',
  CHAT_ID_TOO_LONG: 'chat_id_too_long',
  RETRY_UNAVAILABLE: 'retry_unavailable',
  LOOP_CUT: 'loop_cut',
  TOOL_ARGS_INVALID: 'tool_args_invalid',
  BUDGET_EXCEEDED: 'budget_exceeded',
  CHECKPOINT_ROLLBACK: 'checkpoint_rollback',
  SYNTAX_INVALID: 'syntax_invalid',
  READ_AFTER_WRITE_FAILED: 'read_after_write_failed',
  CHECKPOINT_MISSING: 'checkpoint_missing',
  TOOL_TIMEOUT: 'tool_timeout',
  SANDBOX_KILLED: 'sandbox_killed',
  FILE_TOO_LARGE: 'file_too_large',
  CHECKPOINT_EXPIRED: 'checkpoint_expired',
  RESUME_CONFLICT: 'resume_conflict',
  SCHEMA_INVALID: 'schema_invalid',
  MEMORY_ACL_DENIED: 'memory_acl_denied',
  SSE_GAP: 'sse_gap',
  USAGE_DRIFT: 'usage_drift',
  SUBAGENT_ISOLATED: 'subagent_isolated',
  SANDBOX_RESOURCE_LIMIT: 'sandbox_resource_limit',
  SYMLINK_REJECTED: 'symlink_rejected',
  COERCION_REJECTED: 'coercion_rejected',
  DLQ_EXHAUSTED: 'dlq_exhausted',
  FENCE_CONFLICT: 'fence_conflict',
  NETWORK_DENIED: 'network_denied',
  PATH_TRAVERSAL: 'path_traversal',
  DUPLICATE_EVENT: 'duplicate_event',
  REPLAY_WINDOW: 'replay_window',
  AUDIT_SKIP: 'audit_skip',
  BLOB_COMPACTED: 'blob_compacted',
  FENCE_EXPIRED: 'fence_expired',
  DLQ_REPLAY: 'dlq_replay',
  PGVECTOR_FAILED: 'pgvector_failed',
  TMPFS_EXCEEDED: 'tmpfs_exceeded',
  CREDIT_MISMATCH: 'credit_mismatch',
  CREDIT_CEILING: 'credit_ceiling',
  STDOUT_RATE: 'stdout_rate',
  HASH_EXPIRED: 'hash_expired',
  DLQ_POISON: 'dlq_poison',
  GZIP_VERSION: 'gzip_version',
  HASH_SWEEP: 'hash_sweep',
  RETRIEVE_MEMORY_FAILED: 'retrieve_memory_failed',
  TMPFS_CLEANUP: 'tmpfs_cleanup',
  TIMEOUT_TABLE: 'timeout_table',
  TURN_DEADLINE: 'turn_deadline',
  UNKNOWN_TOOL: 'unknown_tool',
  TOOL_RESULT_CAPPED: 'tool_result_capped',
  TOOL_ISOLATED: 'tool_isolated',
  CKPT_CAS: 'ckpt_cas',
  PIN_EVICTED: 'pin_evicted',
  PG_KILLED: 'pg_killed',
  ERROR_BUDGET: 'error_budget',
  CIRCUIT_OPEN: 'circuit_open',
  QUEUE_LEASE: 'queue_lease',
  QUEUE_CANCEL: 'queue_cancel',
  SSE_BACKPRESSURE: 'sse_backpressure',
  SSE_DRAIN: 'sse_drain',
  WRITE_HASH: 'write_hash',
  CREDIT_HOLD: 'credit_hold',
  CREDIT_RELEASE: 'credit_release',
  STDERR_RATE: 'stderr_rate',
  PLAN_REVISED: 'plan_revised',
  TOKEN_COMPACT: 'token_compact',
  TOOL_REPAIR_EXHAUSTED: 'tool_repair_exhausted',
  TOKEN_BUDGET: 'token_budget',
  SSE_ORPHAN: 'sse_orphan',
  SSE_RESUME: 'sse_resume',
  SUBAGENT_TYPE: 'subagent_type',
  SUBAGENT_BUDGET: 'subagent_budget',
  SUBAGENT_TOOL_DENIED: 'subagent_tool_denied',
  SKILL_DISCLOSE: 'skill_disclose',
  IDEMPOTENCY_REPLAY: 'idempotency_replay',
  SLEEP_COMPACT: 'sleep_compact',
  GIT_APPLY_DIRTY: 'git_apply_dirty',
  GIT_SYNTAX_REVERT: 'git_syntax_revert',
  GIT_HUNK_AMBIGUOUS: 'git_hunk_ambiguous',
  GIT_BINARY_REJECTED: 'git_binary_rejected',
  CODEX_ENGINE_STOP: 'codex_engine_stop',
  CODEX_OPENROUTER_DENIED: 'codex_openrouter_denied',
  CODEX_FIRST_BYTE: 'codex_first_byte',
  SANDBOX_STREAM: 'sandbox_stream',
  SANDBOX_REAP: 'sandbox_reap',
  SANDBOX_CLEANUP: 'sandbox_cleanup',
  SSE_DRAIN_TIMEOUT: 'sse_drain_timeout',
  SSE_HEARTBEAT: 'sse_heartbeat',
  QUEUE_FAIRNESS: 'queue_fairness',
  RETRIEVE_BEFORE: 'retrieve_before',
  PIN_DEDUP: 'pin_dedup',
  CREDIT_CANCEL: 'credit_cancel',
  RESUME_RECREATE: 'resume_recreate',
  WRITE_SYNTAX_REVERT: 'write_syntax_revert',
  PLAN_BUDGET: 'plan_budget',
  FIRST_BYTE_REAL: 'first_byte_real',
  TOOL_STORM: 'tool_storm',
  DAG_BLOCKED: 'dag_blocked',
  DAG_WAIT: 'dag_wait',
  COMPACT_FIDELITY: 'compact_fidelity',
  EVENT_ORDER: 'event_order',
  CONCURRENT_TURN: 'concurrent_turn',
  LOOP_STALL: 'loop_stall',
  SANDBOX_TIMEOUT: 'sandbox_timeout',
  TOOL_ID_DUPLICATE: 'tool_id_duplicate',
  TOOL_NAME_EMPTY: 'tool_name_empty',
  TOOL_RESULT_ORPHAN: 'tool_result_orphan',
  SESSION_BUSY: 'session_busy',
  PIN_EVICT: 'pin_evict',
  EXACTLY_ONCE_TOOL: 'exactly_once_tool',
  CREDIT_HOLD_REUSE: 'credit_hold_reuse',
  TURN_SUPERSEDED: 'turn_superseded',
  TOOL_UNKNOWN: 'tool_unknown',
  DAG_CYCLE: 'dag_cycle',
  WRITE_NOOP: 'write_noop',
  SANDBOX_SPAWN: 'sandbox_spawn',
  SSE_DUPLICATE: 'sse_duplicate',
  CREDIT_NO_USAGE: 'credit_no_usage',
  CHECKPOINT_CORRUPT: 'checkpoint_corrupt',
  TOOL_RESULT_DUP: 'tool_result_dup',
  GATEWAY_BUSY: 'gateway_busy',
  SCHEMA_STRIP: 'schema_strip',
  TURN_CANCELLED: 'turn_cancelled',
  TOOL_ABORTED: 'tool_aborted',
  FIRST_TOKEN_STALL: 'first_token_stall',
  RATE_LIMITED: 'rate_limited',
  PROVIDER_AUTH: 'provider_auth',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_BAD_REQUEST: 'provider_bad_request',
  PIN_ACROSS_COMPACT: 'pin_across_compact',
  EMPTY_RESPONSE: 'empty_response',
  DANGEROUS_TOOL: 'dangerous_tool',
  OPENROUTER_DENIED: 'openrouter_denied',
  SESSION_LOCK_STALE: 'session_lock_stale',
  MCP_CONNECTED_ONLY: 'mcp_connected_only',
  PATH_MUTATION_BUSY: 'path_mutation_busy',
  FUZZY_REPLACE: 'fuzzy_replace',
  TOOL_NETWORK: 'network',
  TOOL_PERMISSION: 'permission',
  TOOL_NOT_FOUND: 'not_found',
  TOOL_INVALID_ARGS: 'invalid_args',
  TOOL_TIMEOUT_KIND: 'timeout',
  READ_WINDOW: 'read_window',
  GLOB_IGNORED: 'glob_ignored',
  BASH_BACKGROUND: 'bash_background',
  SECRET_REDACT: 'secret_redact',
  SSE_GAP_DETECT: 'sse_gap',
  FILE_LOCK_BUSY: 'path_mutation_busy',
  ZERO_TOKEN_REFUND: 'credit_no_usage',
  SSE_COMMENT: 'sse_heartbeat',
  PGVECTOR_RANK: 'pgvector_failed',
  CLOCK_SKEW: 'clock_skew',
  UNIFIED_DIFF: 'git_hunk_ambiguous',
  SANDBOX_ULIMIT: 'sandbox_resource_limit',
  MEDIA_CAPPED: 'file_too_large',
  REQUEST_IDEMPOTENT: 'idempotency_replay',
  PER_TOOL_RATE: 'rate_limited',
  RUN_EVENT_DROPPED: 'turn_cancelled',
  MEMORY_FACT_EMPTY: 'memory_fact_empty',
  FINAL_WITH_TOOLS: 'final_with_tools',
  DEEPSEEK_RATE: 'rate_limited',
  DEEPSEEK_PAYMENT: 'credit_ceiling',
  RESUME_TOKEN: 'sse_resume',
  URL_CREDENTIAL: 'secret_redact',
  SANDBOX_NET_CLOSED: 'network_denied',
  PROCESS_GROUP_KILL: 'sandbox_killed',
  STREAM_NEVER_OPENED: 'credit_no_usage',
  TOOL_NAME_INVENTED: 'unknown_tool',
  LARGE_OVERWRITE: 'file_too_large',
  NESTED_COERCE: 'coercion_rejected',
  SSE_RETRY_FIRST: 'sse_resume',
  GZIP_TOOL_RESULT: 'gzip_version',
  DUP_SYSTEM_PROMPT: 'pin_dedup',
  IDENTICAL_OBSERVATION_LOOP: 'identical_observation_loop',
  ENUM_REJECTED: 'enum_rejected',
  BINARY_FILE: 'binary_file',
  SSE_BUFFER_OVERFLOW: 'sse_buffer_overflow',
  GENERATE_OVERLOADED: 'generate_overloaded',
  NET_RESET: 'net_reset',
  NET_TIMEOUT: 'net_timeout',
  NET_DNS: 'net_dns',
  COMPLETION_HOLD_REFUND: 'credit_cancel',
  MISSING_REQUIRED: 'missing_required',
  BAD_TOOL_RESULT: 'bad_tool_result',
  TIMEOUT_BUDGET: 'timeout_budget',
  TOOL_DEAD_LETTER: 'tool_dead_letter',
  WRITE_CHECKSUM: 'write_checksum',
  BAD_PATH: 'bad_path',
  FILE_EXISTS: 'file_exists',
  FS_NOT_FOUND: 'fs_not_found',
  FS_DENIED: 'fs_denied',
  FS_NOSPACE: 'fs_nospace',
  FS_ISDIR: 'fs_isdir',
  SUBAGENT_DEPTH: 'subagent_depth',
  WALL_CLOCK: 'wall_clock',
  FILE_CHANGED: 'file_changed',
  GIT_HUNK_CONTEXT: 'git_hunk_context',
  JSON_PARSE: 'json_parse',
  CANCELLED: 'cancelled',
  TOO_MANY_TOOLS: 'too_many_tools',
  EMPTY_MODEL: 'empty_model',
  COERCION_REJECTED: 'coercion_rejected',
  SYMLINK_WRITE: 'symlink_write',
  UNAUTHORIZED: 'unauthorized',
  GLOB_CAP: 'glob_cap',
  TTFB_WATCHDOG: 'ttfb_watchdog',
  CKPT_PRUNE: 'ckpt_prune',
  SSE_CURSOR: 'sse_cursor',
  MAX_OUTPUT_TOKENS: 'max_output_tokens',
  DUP_TOOL_CALL: 'dup_tool_call',
  HTTP_5XX: 'http_5xx',
  HTTP_4XX: 'http_4xx',
  HTTP_TIMEOUT: 'http_timeout',
  EMPTY_TOOL_NAME: 'empty_tool_name',
  NUL_PATH: 'nul_path',
  PGVECTOR_TIMEOUT: 'pgvector_timeout',
  COMPUTER_FLAG_OFF: 'computer_flag_off',
  SUBAGENT_CONCURRENCY: 'subagent_concurrency',
  EMPTY_TURN: 'empty_turn',
  TOOL_RESULT_TRUNCATED: 'tool_result_truncated',
  TOOL_ID_RESUME_DUP: 'tool_id_resume_dup',
  SCHEMA_CLAMP: 'schema_clamp',
  WRITE_TOO_LARGE: 'write_too_large',
  IDENTICAL_PROMPT_INFLIGHT: 'identical_prompt_inflight',
  EMPTY_EMBEDDING: 'empty_embedding',
  CREDIT_OBSERVATION: 'credit_observation',
  TURN_WALL: 'turn_wall',
  ENUM_REPAIR: 'enum_repair',
  ENUM_INVALID: 'enum_invalid',
  ARRAY_CAP: 'array_cap',
  CKPT_TOMBSTONE: 'ckpt_tombstone',
  STDERR_CAP: 'stderr_cap',
  COMPACT_OLD_TOOLS: 'compact_old_tools',
  TOOL_NAME_WHITESPACE: 'tool_name_whitespace',
  EVENT_ORDER: 'event_order',
  EMAIL_REDACT: 'email_redact',
  HEARTBEAT_CAP: 'heartbeat_cap',
  SYMLINK_READ: 'symlink_read',
  PLAN_STEP_FAILED: 'plan_step_failed',
  PIN_TOOL_ERROR: 'pin_tool_error',
  TOOL_ARGS_CAP: 'tool_args_cap',
  JSON_NEWLINE_REPAIR: 'json_newline_repair',
  NULL_STRING_COERCE: 'null_string_coerce',
  SSE_BUFFER_CAP: 'sse_buffer_cap',
  COMPACT_PINS_LAST3: 'compact_pins_last3',
  DEST_DIR_MISSING: 'dest_dir_missing',
  CREDIT_CEIL: 'credit_ceil',
  QUEUE_WAIT: 'queue_wait',
  EMBEDDING_DIM: 'embedding_dim',
  STREAM_STALL: 'stream_stall',
  UTF16_NUL: 'utf16_nul',
  TOOL_NAME_LENGTH: 'tool_name_length',
  TOOL_RECURSION: 'tool_recursion',
  PLAN_SKIP_COMPLETED: 'plan_skip_completed',
  CKPT_GZIP: 'ckpt_gzip',
  SSE_ID_PARSE: 'sse_id_parse',
  GLOB_FILE_SIZE: 'glob_file_size',
  AUTH_REDACT: 'auth_redact',
  HOST_BASH_BLOCKED: 'host_bash_blocked',
  SUBAGENT_BUDGET: 'subagent_budget',
  TOOL_CALL_CONCAT: 'tool_call_concat',
  COMBINED_CAP: 'combined_cap',
  PATH_HOMOGLYPH: 'path_homoglyph',
  LOCK_PID: 'lock_pid',
  PRISMA_DISCONNECT: 'prisma_disconnect',
  TOOL_TIMEOUT_DEFAULT: 'tool_timeout_default',
  SSE_SETTLE_ORDER: 'sse_settle_order',
});

function isRetryable(code) {
  const c = String(code || '');
  return c === CODES.CRON_TIMEOUT
    || c === CODES.CRON_BUSY
    || c === CODES.CRON_DISPATCH_UNAVAILABLE
    || c === CODES.SESSION_QUEUE_FULL
    || c === CODES.TURN_TIMEOUT
    || c === 'sandbox_queue_timeout'
    || c === 'remote_unreachable'
    || c === 'chat_run_worker_unavailable'
    || c === CODES.CHECKPOINT_ROLLBACK
    || c === 'provider_unavailable'
    || c === CODES.FENCE_EXPIRED
    || c === CODES.DLQ_REPLAY
    || c === CODES.PGVECTOR_FAILED
    || c === CODES.RETRIEVE_MEMORY_FAILED
    || c === CODES.HASH_SWEEP
    || c === CODES.TOOL_ISOLATED
    || c === CODES.QUEUE_LEASE
    || c === CODES.SSE_DRAIN_TIMEOUT
    || c === CODES.SANDBOX_REAP
    || c === CODES.RATE_LIMITED
    || c === CODES.PROVIDER_UNAVAILABLE
    || c === CODES.PROVIDER_TIMEOUT
    || c === CODES.FIRST_TOKEN_STALL
    || c === CODES.GATEWAY_BUSY
    || c === CODES.SESSION_LOCK_STALE
    || c === 'network'
    || c === 'timeout'
    || c === CODES.PATH_MUTATION_BUSY
    || c === 'duplicate_turn'
    || c === CODES.SSE_GAP
    || c === 'sse_gap'
    || c === CODES.QUEUE_FAIRNESS
    || c === 'queue_fairness'
    || c === 'credit_no_usage'
    || c === 'clock_skew'
    || c === 'rate_limited'
    || c === 'idempotency_replay'
    || c === 'sse_resume'
    || c === 'net_reset'
    || c === 'net_timeout'
    || c === 'net_dns'
    || c === 'generate_overloaded'
    || c === 'sse_buffer_overflow'
    || c === 'turn_wall'
    || c === 'identical_prompt_inflight'
    || c === 'queue_wait'
    || c === 'stream_stall'
    || c === 'prisma_disconnect';
}

function publicError(code, extra) {
  const c = String(code || 'internal_error');
  const body = { ok: false, error: c, code: c, retryable: isRetryable(c) };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return body;
}

function httpStatusFor(code) {
  const c = String(code || '');
  if (c === CODES.USER_REQUIRED) return 401;
  if (c === CODES.FORBIDDEN) return 403;
  if (c === CODES.SESSION_QUEUE_FULL || c === CODES.CRON_BUSY || c === CODES.GENERATE_OVERLOADED || c === 'generate_overloaded') return 429;
  if (c === CODES.TURN_TIMEOUT || c === CODES.CRON_TIMEOUT || c === CODES.CRON_DISPATCH_UNAVAILABLE) return 504;
  if (c === 'hmac_secret_missing' || c === 'queue_wait') return 503;
  if (c === CODES.WEBHOOK_HMAC_FAILED || c === 'hmac_invalid') return 401;
  if (c === CODES.RETRY_UNAVAILABLE) return 409;
  if (c === CODES.PAYLOAD_TOO_LONG || c === CODES.CHAT_ID_TOO_LONG) return 413;
  return 400;
}

module.exports = { CODES, isRetryable, publicError, httpStatusFor };
