/**
 * react-agent — an iterative Thought → Action → Observation loop over
 * a pluggable tool registry, driven by OpenAI tool/function calling.
 *
 * Shape:
 *   run(openai, { query, tools, maxSteps, maxRuntimeMs, onStepStart, onStepDone, onStep })
 *     → { finalAnswer, steps[], stoppedReason }
 *
 * Tools are plain objects:
 *   {
 *     name:         "web_search",          // stable identifier
 *     description:  "Free-text web search; returns JSON list of snippets",
 *     parameters:   { ...JSON Schema... }, // OpenAI tool-call format
 *     execute:      async (args, ctx) => result
 *   }
 *
 * The loop is bounded: at most `maxSteps` tool calls before we force a
 * `finalize` — this is the single most important safety property, since
 * a buggy tool or a confused model can otherwise drift forever.
 *
 * `onStepStart(step)` fires before tool execution, `onStepDone(step)`
 * fires after observations are available, and `onStep(step)` is kept
 * as the legacy completed-step callback. The full trace is returned
 * for logging / replay.
 *
 * Why roll a loop instead of using the Assistants API:
 *   - Assistants is a stateful resource with its own lifecycle; we want
 *     stateless, predictable runs that are easy to test and deploy.
 *   - This gives us full control over the tool-call budget, the system
 *     prompt, and the failure semantics.
 */

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

// ── Trace compaction ────────────────────────────────────────────────────
// The running `messages` array grows by one assistant message + one tool
// message per tool call, every step. On long autonomous runs (maxSteps
// 30–60) this overflows the model's context window, which surfaces as a
// hard `model_error` abort mid-task — the single most common way a
// multi-step run dies before it can finalize. Compaction caps the trace by
// summarizing OLDER complete rounds while preserving the head (system +
// query) and the most recent rounds verbatim, so the assistant→tool
// pairing the OpenAI API requires is never broken.
const DEFAULT_COMPACT_MAX_CHARS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_COMPACT_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? v : 60000; // ~15k tokens of trace
})();
const DEFAULT_COMPACT_TAIL_ROUNDS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_COMPACT_TAIL_ROUNDS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
})();
const COMPACT_DISABLED = process.env.SIRAGPT_REACT_COMPACT_DISABLED === '1';

// ── Finalize-guard circuit breaker ───────────────────────────────────────
// When the model calls `finalize`, the finalize guard can reject it and feed
// back repair instructions, then the loop continues. There was NO limit on
// how many times the guard could reject finalize, so an unsatisfiable guard
// (e.g. a simple chat request misrouted into the heavy document pipeline with
// a weak model that can never produce the evidence the guard demands) spins
// for the entire step/runtime budget — burning ~50 min of LLM calls on a
// runaway loop while the client already gave up at ~90s ("dejó de responder").
// These caps force a degraded-but-real finalize once the guard has clearly
// become unsatisfiable, instead of grinding to max_steps.
const MAX_FINALIZE_REJECTIONS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_MAX_FINALIZE_REJECTIONS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 8; // absolute cap across the run
})();
const MAX_CONSEC_FINALIZE_REJECTIONS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_MAX_CONSEC_FINALIZE_REJECTIONS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3; // cap with no intervening tool progress
})();

// ── A2: parallel tool execution ──────────────────────────────────────────────
// Independent READ-ONLY / idempotent tool calls in a single step are dispatched
// concurrently (bounded) instead of strictly one-by-one. Mutating/stateful
// tools (bash, file writes, patches, browser actions, sub-agent spawns, the
// `finalize` sentinel) always run sequentially to avoid races. Observations are
// still processed in the model's original order, so tool_call_id pairing,
// error budgets and the finalize guard are unchanged.
const TOOL_PARALLEL_DISABLED = ['0', 'off', 'false', 'no'].includes(
  String(process.env.SIRAGPT_TOOL_PARALLEL || '').trim().toLowerCase()
);
const TOOL_PARALLEL_MAX = Math.max(2, Number(process.env.SIRAGPT_TOOL_PARALLEL_MAX) || 4);
const PARALLEL_SAFE_RX = /^(web_search|read_url|web_extract|deep_search|github_search|scientific_search|x_search|rag_retrieve|search_docs|search_code|get_symbol|list_files|read_file|list_dir|glob_files|code_grep|docintel|deep_analyze|memory_recall|session_search|session_list|session_history|sunat_)/i;

function isParallelSafeTool(name) {
  const n = String(name || '');
  return n !== 'finalize' && PARALLEL_SAFE_RX.test(n);
}

// Per-call cap on how long the prefetch BATCH waits for any single tool. A
// hung read-only tool used to stall the whole Promise.all until the step
// budget burned; past the cap the batch returns and hands back the still-
// pending promise (`{__pending}`) so the main loop awaits it only when that
// call's result is actually consumed — no re-dispatch, no double budget.
// Known trade-off: if the run ends before consuming a straggler (finalize,
// abort, runtime budget), the dispatch keeps running in the background until
// it settles on its own; acceptable because only read-only/idempotent tools
// are prefetched and the inner catch guarantees no unhandled rejection.
function prefetchCallTimeoutMs() {
  const v = Number(process.env.SIRAGPT_TOOL_PREFETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 8000;
}
const PREFETCH_PENDING = Symbol('prefetch_pending');

/**
 * Concurrently dispatch the read-only/idempotent tool calls of one step,
 * returning a Map<call.id, dispatchResult | {__pending: Promise}>. Mutating
 * calls are skipped here (they run inline, sequentially, in the main loop).
 * Bounded by TOOL_PARALLEL_MAX; each batch waits at most
 * PREFETCH_CALL_TIMEOUT_MS for stragglers (partial results, never a stall).
 */
async function prefetchParallelDispatch(registry, toolCalls, ctx, exhaustedTools) {
  const out = new Map();
  if (TOOL_PARALLEL_DISABLED || !Array.isArray(toolCalls)) return out;
  const safe = toolCalls.filter((c) => {
    const n = c && c.function && c.function.name;
    return isParallelSafeTool(n) && !(exhaustedTools && exhaustedTools.has(n)) && c.id != null;
  });
  if (safe.length < 2) return out; // nothing to gain from parallelism
  for (let i = 0; i < safe.length; i += TOOL_PARALLEL_MAX) {
    const chunk = safe.slice(i, i + TOOL_PARALLEL_MAX);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(chunk.map((call) => {
      const dispatched = (async () => {
        try {
          return await dispatchTool(registry, call.function?.name, call.function?.arguments, ctx);
        } catch (e) {
          return { error: `tool_execution_failed: ${e && e.message ? e.message : String(e)}` };
        }
      })();
      let capTimer;
      const cap = new Promise((resolve) => {
        capTimer = setTimeout(() => resolve(PREFETCH_PENDING), prefetchCallTimeoutMs());
      });
      return Promise.race([dispatched, cap]).then((d) => {
        clearTimeout(capTimer);
        return d === PREFETCH_PENDING
          ? { id: call.id, d: { __pending: dispatched } }
          : { id: call.id, d };
      });
    }));
    for (const r of results) if (r && r.id != null) out.set(r.id, r.d);
  }
  return out;
}

// ── A3: one-shot tool fallback ───────────────────────────────────────────────
// When a tool fails with a HARD error, try ONE compatible alternative (same
// args) before counting the failure. The alternative's own arg validation
// guards against incompatible schemas (a mismatch just returns {error} and we
// keep the original). Mostly the search/read families, whose args line up.
const TOOL_FALLBACK_DISABLED = ['0', 'off', 'false', 'no'].includes(
  String(process.env.SIRAGPT_TOOL_FALLBACK || '').trim().toLowerCase()
);
const TOOL_FALLBACK_MAP = Object.freeze({
  web_search: 'deep_search',
  deep_search: 'web_search',
  scientific_search: 'web_search',
  github_search: 'web_search',
  x_search: 'web_search',
  read_url: 'web_extract',
  web_extract: 'read_url',
  rag_retrieve: 'search_docs',
  search_docs: 'rag_retrieve',
  docintel_analyze: 'deep_analyze',
  deep_analyze: 'docintel_analyze',
});

function fallbackToolFor(name) {
  return TOOL_FALLBACK_MAP[String(name || '')] || null;
}

const Ajv = require('ajv');
const { sanitizeToolParameters } = require('./ai-product-os/tool-schema-sanitizer');
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const schemaValidatorCache = new Map();
// Bound the compiled-validator cache so dynamic / per-GPT tool schemas (custom
// GPT Actions each carry a unique parameters schema) can't grow it without
// limit across turns. LRU: a cache hit refreshes recency; on overflow the
// least-recently-used schema is evicted. Generous default keeps every stable
// built-in tool resident. Override with SIRAGPT_SCHEMA_VALIDATOR_CACHE_MAX.
const SCHEMA_VALIDATOR_CACHE_MAX = Math.max(
  64,
  Number(process.env.SIRAGPT_SCHEMA_VALIDATOR_CACHE_MAX) || 512,
);

// ── Tool-error classification for the per-run error budget ─────────────────
// A flaky upstream blip (timeout, 429, 5xx, provider overload) is NOT the same
// as a deterministically broken tool (bad args, validation, 4xx, not found).
// Counting both equally retired a tool after 5 transient blips, dead-ending
// doc-QA turns when a provider was briefly slow (seen in the live E2E).
// Terminal errors hit the budget at full weight; transient ones at a fraction,
// so a tool survives several blips but a truly-broken one still dies fast.
// Detection delegates to the canonical single-source-of-truth classifier
// (task-error-classifier) so the agent loop, retries, and circuit breaker all
// agree on what "transient" means. Unknown shapes → 'terminal'.
const { classifyTaskError } = require('../utils/task-error-classifier');
const TRANSIENT_TOOL_ERROR_WEIGHT = (() => {
  const w = Number(process.env.SIRAGPT_TRANSIENT_TOOL_ERROR_WEIGHT);
  return Number.isFinite(w) && w > 0 && w <= 1 ? w : 0.34;
})();

/**
 * Classify a tool error as 'transient' (retryable upstream blip) or 'terminal'
 * (deterministic). Accepts string | Error | `{error|message|code|status}`.
 * @param {*} err
 * @returns {'transient'|'terminal'}
 */
function classifyToolError(err) {
  if (err == null) return 'terminal';
  // Normalise the various tool-error shapes into what classifyTaskError reads
  // (.message / .code / .statusCode / .name) — dispatch errors can be a string
  // or an object using `.error`/`.status`.
  let probe;
  if (typeof err === 'string') probe = { message: err };
  else if (err instanceof Error) probe = err;
  else if (typeof err === 'object') {
    probe = {
      message: err.error || err.message || err.reason || '',
      code: err.code,
      statusCode: err.status ?? err.statusCode,
      name: err.name,
    };
  } else probe = { message: String(err) };
  return classifyTaskError(probe).retryable ? 'transient' : 'terminal';
}

// ── Run-loop pacing constants ───────────────────────────────────────────────
// Consecutive calls to already-exhausted tools tolerated before the loop
// narrows tool_choice to finalize (env: SIRAGPT_EXHAUSTED_REPOLL_LIMIT).
const EXHAUSTED_REPOLL_LIMIT = (() => {
  const v = Number(process.env.SIRAGPT_EXHAUSTED_REPOLL_LIMIT);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
})();
// Floor for the adaptive per-step timeout: even with almost no runtime left,
// give the (forced-finalize) completion a real chance to land.
const MIN_STEP_TIMEOUT_MS = 5000;
// Wall-clock headroom reserved when clamping a step to the remaining runtime,
// covering tool dispatch + bookkeeping after the completion returns.
const STEP_RUNTIME_BUFFER_MS = 2000;

const FINALIZE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The final answer, in markdown.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence level.' },
  },
  required: ['answer'],
  additionalProperties: false,
};
const SYSTEM_PROMPT = `You are a rigorous research agent. Solve the user's request by deciding which tool to call next, observing the result, then deciding again. Keep going until you can give a confident, well-grounded answer.

Rules:
- For multi-part tasks, start your FIRST thought with a one-line plan (e.g. "Plan: search → read top source → compare → finalize") and update it briefly when your approach changes.
- Prefer gathering 2–3 pieces of evidence before finalizing, unless the query is trivial.
- Do NOT fabricate tool calls — only call tools that appear in the tools list.
- Do NOT repeat a tool call with identical arguments — vary the arguments or switch tools instead.
- If a tool result says it was truncated, refine the request (narrower query, fewer results, pagination) rather than re-requesting the same output.
- When you have enough evidence, call the \`finalize\` tool with a well-structured final answer (markdown). Do NOT write the final answer as plain text in the assistant message — only via \`finalize\`.
- Every tool call must be justified by a short natural-language thought in the assistant message preceding the call.
- Keep thoughts concise (1–2 sentences). Save the depth for the final answer.`;

/**
 * Turn a plain tool object into the OpenAI tool-call schema.
 */
function toOpenAITool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // Normalize to a cross-provider-safe JSON Schema so a tool that works
      // on GPT-4o also works on weaker / stricter backends (Llama free tier,
      // Anthropic, Gemini). See tool-schema-sanitizer.js.
      parameters: sanitizeToolParameters(tool.parameters),
    },
  };
}

function stableSchemaKey(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSchemaKey).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSchemaKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatorForTool(tool) {
  const schema = tool?.parameters;
  if (!schema || typeof schema !== 'object') return null;
  const cacheKey = stableSchemaKey(schema);
  const cached = schemaValidatorCache.get(cacheKey);
  if (cached) {
    // Refresh recency (Map keeps insertion order) so hot schemas survive eviction.
    schemaValidatorCache.delete(cacheKey);
    schemaValidatorCache.set(cacheKey, cached);
    return cached;
  }
  const validator = ajv.compile(schema);
  // Evict the least-recently-used entry once the cache is full.
  if (schemaValidatorCache.size >= SCHEMA_VALIDATOR_CACHE_MAX) {
    const oldest = schemaValidatorCache.keys().next().value;
    if (oldest !== undefined) schemaValidatorCache.delete(oldest);
  }
  schemaValidatorCache.set(cacheKey, validator);
  return validator;
}

function formatValidationErrors(errors = []) {
  return errors
    .map((err) => {
      const at = err.instancePath || '/';
      const detail = err.params && err.params.missingProperty
        ? `${err.message}: ${err.params.missingProperty}`
        : err.message;
      return `${at} ${detail}`.trim();
    })
    .join('; ');
}

function validateToolArgs(tool, args) {
  let validator;
  try {
    validator = validatorForTool(tool);
  } catch (err) {
    return { ok: false, error: `invalid_tool_schema: ${err.message || err}` };
  }
  if (!validator) return { ok: true };
  const ok = validator(args);
  if (ok) return { ok: true };
  return { ok: false, error: `invalid_tool_args: ${formatValidationErrors(validator.errors)}` };
}

/**
 * Execute a single tool by name. Errors are caught and returned as a
 * structured observation so the model can read them in the next turn
 * and course-correct, rather than throwing out of the loop.
 */
async function dispatchTool(registry, name, argsRaw, ctx) {
  if (ctx?.signal?.aborted) {
    return { error: 'aborted' };
  }
  if (ctx?.toolGate && name !== 'finalize') {
    const auth = ctx.toolGate.authorize(name, ctx.toolAuthCtx || {});
    if (!auth?.ok) {
      return { error: auth?.reason || 'tool_denied' };
    }
  }
  const tool = registry.find(t => t.name === name);
  if (!tool) {
    return { error: `unknown_tool: ${name}` };
  }
  let args = {};
  try {
    args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {});
  } catch (e) {
    return { error: `invalid_json_args: ${e.message}` };
  }
  const validation = validateToolArgs(tool, args);
  if (!validation.ok) {
    return { error: validation.error };
  }
  // Budget is consumed only AFTER lookup + arg validation: a malformed or
  // unknown call must not burn a tool-call slot the model could still use
  // with corrected arguments on the next turn.
  if (ctx?.checkToolBudget && name !== 'finalize') {
    const usage = ctx.toolUsageMap || {};
    const budget = ctx.checkToolBudget(name, usage);
    if (budget && budget.ok === false) {
      return { error: budget.reason || 'tool_budget_exceeded' };
    }
    usage[name] = (Number(usage[name]) || 0) + 1;
    ctx.toolUsageMap = usage;
  }
  try {
    const result = await tool.execute(args, ctx);
    return { result };
  } catch (e) {
    return { error: `tool_execution_failed: ${e.message}` };
  }
}

/**
 * Rough char-count of a message array. We use chars (not a tokenizer) on
 * purpose: it's dependency-free, deterministic, and a 4:1 char:token ratio
 * is a safe over-estimate that keeps us comfortably under context limits.
 */
function estimateMessagesChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += String(m && m.content ? m.content : '').length;
    }
  }
  return total;
}

/**
 * Condense a single tool observation (the JSON content of a `role:'tool'`
 * message) into a one-line gist: keep error codes verbatim, otherwise list
 * the top-level result keys. Never throws.
 */
function summarizeObservation(content) {
  let str = content;
  if (typeof str !== 'string') {
    try { str = JSON.stringify(str); } catch { return 'unserializable'; }
  }
  let obj = null;
  try { obj = JSON.parse(str); } catch { /* not JSON — fall through */ }
  if (obj && typeof obj === 'object') {
    if (obj.error) return `error=${String(obj.error).slice(0, 100)}`;
    const keys = Object.keys(obj).slice(0, 8);
    return keys.length ? `ok keys=[${keys.join(',')}]` : 'ok';
  }
  return String(str).slice(0, 120).replace(/\s+/g, ' ').trim();
}

// ── ACI observation formatting (SWE-agent, arXiv:2405.15793) ───────────────
// Three measured findings from the Agent-Computer Interface work, applied to
// how tool observations are fed back to the model:
//   1. Silent truncation misleads — a JSON cut mid-string reads as complete
//      data. Over the cap we return an EXPLICIT envelope (total size, shown
//      head/tail, and an instruction to refine) so the model redirects
//      instead of trusting a mangled prefix.
//   2. Empty output is ambiguous (success? failure?) — replace it with an
//      explicit "ran successfully, no output" note.
//   3. Stale observations are worse than useless (old state actively
//      misleads, and distractor context degrades the model) — collapse every
//      tool observation older than the last OBS_KEEP_ROUNDS rounds to a
//      one-line gist, keeping thoughts/actions (the plan) intact. This is
//      ALWAYS-ON aging, independent of the char-budget compaction below,
//      which only fires on overflow.
const DEFAULT_OBS_MAX_CHARS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_OBS_MAX_CHARS);
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : 8000;
})();
const OBS_KEEP_ROUNDS = (() => {
  const v = Number(process.env.SIRAGPT_REACT_OBS_KEEP_ROUNDS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 5;
})();
const OBS_ELIDE_DISABLED = process.env.SIRAGPT_REACT_OBS_ELIDE_DISABLED === '1';
const ELIDED_OBS_PREFIX = '[stale observation elided]';
// Below this size an old observation is kept verbatim — eliding it would not
// meaningfully shrink the trace and could drop still-useful detail.
const OBS_ELIDE_MIN_CHARS = 200;

/**
 * Serialize a tool observation for the model. Never silently truncates:
 * over-cap output becomes an explicit envelope with orientation metadata
 * (total size, shown head/tail) and a refine instruction; empty output
 * becomes an explicit success note. Always returns a string ≤ ~maxChars.
 */
function formatObservation(observation, maxChars = DEFAULT_OBS_MAX_CHARS) {
  let obsStr;
  try {
    obsStr = JSON.stringify(observation);
  } catch {
    obsStr = JSON.stringify({ error: 'non_serializable_tool_output', type: typeof observation });
  }
  if (
    obsStr === undefined || obsStr === 'null' || obsStr === '{}'
    || obsStr === '""' || obsStr === '[]' || obsStr === '{"result":null}'
    || obsStr === '{"result":""}' || obsStr === '{"result":{}}' || obsStr === '{"result":[]}'
  ) {
    return JSON.stringify({ ok: true, note: 'Tool ran successfully and produced no output.' });
  }
  if (obsStr.length <= maxChars) return obsStr;
  // Reserve room for the envelope itself; split the budget ~80/20 head/tail
  // so the model sees how the output starts AND how it ends.
  const budget = Math.max(500, maxChars - 400);
  const headLen = Math.floor(budget * 0.8);
  const tailLen = budget - headLen;
  return JSON.stringify({
    truncated: true,
    total_chars: obsStr.length,
    shown_chars: budget,
    note: `Tool output was too large (${obsStr.length} chars) and was truncated. Do NOT re-request the same output — refine the call instead (narrower query, fewer results, a specific range or page).`,
    head: obsStr.slice(0, headLen),
    tail: obsStr.slice(-tailLen),
  });
}

/**
 * Collapse tool observations older than the last `keepRounds` assistant
 * rounds to a one-line gist (in place). Thoughts and tool_calls are never
 * touched — the plan/action history survives, only obsolete state goes.
 * Idempotent (already-elided messages are skipped) and pairing-safe (the
 * message keeps its role/tool_call_id, only `content` shrinks).
 * Returns the number of observations elided.
 */
function elideStaleObservations(messages, keepRounds = OBS_KEEP_ROUNDS) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const assistantIdx = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i] && messages[i].role === 'assistant') assistantIdx.push(i);
  }
  if (assistantIdx.length <= keepRounds) return 0;
  // Tool messages BEFORE the first of the last `keepRounds` rounds are stale.
  const cutoff = assistantIdx[assistantIdx.length - keepRounds];
  let elided = 0;
  for (let i = 0; i < cutoff; i += 1) {
    const m = messages[i];
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.length <= OBS_ELIDE_MIN_CHARS) continue;
    if (m.content.startsWith(ELIDED_OBS_PREFIX)) continue;
    m.content = `${ELIDED_OBS_PREFIX} ${summarizeObservation(m.content)}`;
    elided += 1;
  }
  return elided;
}

// ── Duplicate-call cache / loop breaker ─────────────────────────────────────
// Recovery probability collapses after the model starts repeating itself
// (90.5% → 57.2% after a single failure in the SWE-agent measurements), and a
// model re-issuing the SAME read-only call burns steps, latency and credits
// for an identical result. Successful read-only calls are cached per run by
// (tool, args) signature; an identical repeat short-circuits to the cached
// result wrapped in an explicit do-not-repeat warning. Mutating tools are
// exempt — re-running `run_tests` or `host_bash` with the same args is
// legitimate. The cache also makes observation aging safe: if the model
// re-requests data whose observation was elided, it gets the full result
// back instantly instead of being blocked.
const DUP_CALL_CACHE_MAX = 50;

function toolCallSignature(name, argsRaw) {
  let args = argsRaw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); } catch { return `${name}::${argsRaw}`; }
  }
  return `${name}::${stableSchemaKey(args || {})}`;
}

/**
 * Summarize one "round" — an assistant message plus the tool messages that
 * answer its tool_calls — into a compact line: the thought (truncated) and
 * each `toolName→gist`.
 */
function summarizeRound(round) {
  const assistant = round.find((m) => m && m.role === 'assistant');
  const thought = assistant && typeof assistant.content === 'string'
    ? assistant.content.trim().slice(0, 140)
    : '';
  const calls = assistant && Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  const toolMsgs = round.filter((m) => m && m.role === 'tool');
  const parts = [];
  for (let i = 0; i < calls.length; i += 1) {
    const name = calls[i] && calls[i].function ? calls[i].function.name : 'tool';
    const obs = toolMsgs[i] ? summarizeObservation(toolMsgs[i].content) : '(no observation)';
    parts.push(`${name}→${obs}`);
  }
  const callSummary = parts.join('; ') || (thought ? '' : '(no tool calls)');
  if (thought && callSummary) return `${thought} | ${callSummary}`;
  return thought || callSummary;
}

/**
 * Compact a ReAct message trace so it fits a char budget without breaking
 * the OpenAI assistant→tool pairing invariant.
 *
 * Strategy:
 *   - Preserve the HEAD verbatim: every leading message up to (but not
 *     including) the first assistant turn — i.e. the system prompt and the
 *     user query.
 *   - Split the remainder into rounds at each assistant message. A round is
 *     [assistant, ...its tool/user replies], which is the atomic unit the
 *     API needs kept together.
 *   - Keep the last `tailRounds` rounds verbatim (recent context the model
 *     is actively reasoning over).
 *   - Replace the older middle rounds with ONE summary `user` message that
 *     lists what was already done, so the model keeps continuity but pays a
 *     fraction of the tokens.
 *
 * Returns the original array (same reference) when no compaction is needed
 * or when it would not actually shrink the payload — callers can cheaply
 * detect a no-op via identity.
 */
function compactMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length < 4) return messages;
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? opts.maxChars
    : DEFAULT_COMPACT_MAX_CHARS;
  const tailRounds = Number.isFinite(opts.tailRounds) && opts.tailRounds >= 1
    ? Math.floor(opts.tailRounds)
    : DEFAULT_COMPACT_TAIL_ROUNDS;

  if (estimateMessagesChars(messages) <= maxChars) return messages;

  // Head: leading non-assistant messages (system + first user query).
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd].role !== 'assistant') headEnd += 1;
  if (headEnd === 0) return messages; // malformed (no head) — leave untouched
  const head = messages.slice(0, headEnd);
  const rest = messages.slice(headEnd);

  // Split the rest into rounds at assistant boundaries.
  const rounds = [];
  let current = null;
  for (const m of rest) {
    if (m.role === 'assistant') {
      if (current) rounds.push(current);
      current = [m];
    } else if (current) {
      current.push(m);
    } else {
      current = [m];
    }
  }
  if (current) rounds.push(current);

  if (rounds.length <= tailRounds) return messages; // not enough history to fold
  const tail = rounds.slice(rounds.length - tailRounds);
  const middle = rounds.slice(0, rounds.length - tailRounds);
  if (middle.length === 0) return messages;

  const lines = middle.map((round, idx) => `  ${idx + 1}. ${summarizeRound(round)}`);
  const summaryMessage = {
    role: 'user',
    content:
      `[CONTEXTO COMPACTADO] Para no exceder la ventana de contexto se resumieron `
      + `${middle.length} pasos previos (las herramientas y observaciones recientes se `
      + `conservan completas abajo). Resumen de lo ya hecho:\n${lines.join('\n')}\n`
      + `Continúa desde aquí sin repetir trabajo ya realizado.`,
  };

  const compacted = head.concat([summaryMessage], ...tail);
  // Only adopt the compacted form if it genuinely shrinks the payload.
  if (estimateMessagesChars(compacted) >= estimateMessagesChars(messages)) return messages;
  return compacted;
}

/**
 * Build an honest, reason-aware degraded answer for a run that stopped
 * without finalizing and produced no answer of its own. Keeps the user from
 * ever receiving a silent empty "completed" message.
 */
// ── Native tool-call parsing ────────────────────────────────────────────────
// Some models surface tool calls in their NATIVE token format inside
// `message.content` instead of OpenAI `tool_calls` — notably Moonshot Kimi K2.6
// via OpenRouter: `<|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>{…}<|tool_call_end|>`.
// Others use Hermes/Qwen-style `<tool_call>{"name":…,"arguments":…}</tool_call>`.
// Parsing these lets ANY such model drive the agentic loop instead of leaking
// raw markup as the "answer" (and looping until the time budget). Exported for
// unit testing.
const KIMI_TOOLCALL_RE = /<\|tool_call_begin\|>\s*(?:functions\.)?([\w.-]+)\s*:\s*(\d+)\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
const XML_TOOLCALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function hasNativeToolCalls(content) {
  return typeof content === 'string'
    && (content.includes('<|tool_call_begin|>') || /<tool_call>/.test(content));
}

function stripNativeToolCallMarkup(content) {
  return String(content == null ? '' : content)
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, ' ')
    .replace(KIMI_TOOLCALL_RE, ' ')
    .replace(XML_TOOLCALL_RE, ' ')
    .replace(/<\|tool_call[^|]*\|>/g, ' ')
    .replace(/<\|tool_calls_section_(?:begin|end)\|>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNativeToolCalls(content) {
  const text = String(content == null ? '' : content);
  const toolCalls = [];
  let m;
  KIMI_TOOLCALL_RE.lastIndex = 0;
  while ((m = KIMI_TOOLCALL_RE.exec(text)) !== null) {
    const name = m[1];
    const idx = m[2];
    let args = (m[3] || '').trim();
    try { JSON.parse(args); } catch { if (!args) args = '{}'; }
    toolCalls.push({ id: `call_native_${idx}_${name}`.slice(0, 60), type: 'function', function: { name, arguments: args } });
  }
  if (toolCalls.length === 0) {
    XML_TOOLCALL_RE.lastIndex = 0;
    let i = 0;
    while ((m = XML_TOOLCALL_RE.exec(text)) !== null) {
      try {
        const obj = JSON.parse(m[1]);
        const name = obj.name || obj.tool || obj.function;
        if (!name) continue;
        const rawArgs = obj.arguments != null ? obj.arguments : (obj.parameters != null ? obj.parameters : {});
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
        toolCalls.push({ id: `call_native_${i++}_${name}`.slice(0, 60), type: 'function', function: { name, arguments: args } });
      } catch { /* skip malformed */ }
    }
  }
  return { toolCalls, cleanedContent: stripNativeToolCallMarkup(text) };
}

function buildDegradedAnswer(stoppedReason) {
  const reason = String(stoppedReason || '');
  if (reason.startsWith('runtime_budget')) {
    return 'No alcancé a completar la tarea dentro del tiempo disponible. Te dejo lo procesado hasta ahora; si necesitas el resultado completo, vuelve a intentarlo o acota la solicitud.';
  }
  if (reason.startsWith('model_error')) {
    return 'Hubo un problema temporal con el modelo y no pude completar la respuesta. Por favor vuelve a intentarlo; si el problema persiste, reformula la solicitud.';
  }
  if (reason === 'aborted') {
    return 'La tarea se canceló antes de completarse.';
  }
  if (reason === 'no_message') {
    return 'El modelo no devolvió una respuesta utilizable. Por favor vuelve a intentarlo o reformula la solicitud.';
  }
  // max_steps, empty reason, guard-blocked, anything else.
  return 'No logré cerrar la tarea dentro del presupuesto de pasos disponible. Te respondo con lo que alcancé a determinar; si necesitas más profundidad, reformula la solicitud o divídela en partes más pequeñas.';
}

/**
 * Run the ReAct loop.
 *
 * @param {OpenAI} openai — an instantiated OpenAI client
 * @param {object} opts
 * @param {string} opts.query
 * @param {Array<Tool>} opts.tools
 * @param {number} [opts.maxSteps=8]
 * @param {function} [opts.onStep]
 * @param {object}   [opts.ctx]            passed as 2nd arg to every tool.execute
 * @param {string}   [opts.model="gpt-4o"] model to drive the loop
 * @param {string}   [opts.extraSystem]   appended to the system prompt (query-specific guidance)
 * @param {function} [opts.finalizeGuard] validates finalize calls before allowing termination
 * @param {string}   [opts.initialToolChoice] optional tool name to force on the first model step
 * @param {'native'|'prompted'} [opts.toolCallMode='native'] — 'prompted' drives
 *   models WITHOUT native function calling: tools are described in the system
 *   prompt, the trace is converted to a provider-safe transcript (no `tools`,
 *   no `tool_choice`, no role:'tool'), and fenced ```tool_call JSON blocks are
 *   parsed back into OpenAI-shaped tool_calls. See agents/prompted-tool-calling.
 */
async function run(openai, opts) {
  const {
    query,
    tools,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    onStepStart = () => {},
    onStepDone = () => {},
    onStep = () => {},
    ctx = {},
    model = 'gpt-4o',
    extraSystem = '',
    finalizeGuard = null,
    initialToolChoice = null,
    toolCallMode = 'native',
    // Capability-gated: when true the native payload carries
    // parallel_tool_calls so multi-call steps are explicit. Omitted (never
    // `false`) otherwise — several providers 4xx on the unknown parameter.
    parallelToolCalls = false,
    compactMaxChars = DEFAULT_COMPACT_MAX_CHARS,
    compactTailRounds = DEFAULT_COMPACT_TAIL_ROUNDS,
    onCompact = () => {},
    deferredTools = [],
  } = opts;

  if (!query) throw new Error('react-agent: query is required');
  if (!Array.isArray(tools)) throw new Error('react-agent: tools must be an array');

  // `finalize` is always present. Even if a caller forgets to include
  // it in their toolset, the agent still has a way to terminate
  // cleanly — otherwise we'd have to resort to forced stops.
  const registry = tools.concat([{
    name: 'finalize',
    description: 'Emit the final answer to the user and stop. Call this when you have enough evidence.',
    parameters: FINALIZE_TOOL_PARAMETERS,
    execute: async (args) => args, // pass-through; the loop reads this and terminates
  }]);

  // ── Deferred tool loading (tool-search pattern) ─────────────────────────
  // With a large toolset the JSON-schema definitions alone can dominate the
  // context window. Callers can pass most tools as `deferredTools`: they are
  // EXCLUDED from the schema until the model activates them through the
  // `search_tools` meta-tool (match by capability keywords → top hits join
  // the live registry; the schema — and the prompted-tools block — refresh on
  // the next step). Measured upstream at ~85% schema-token savings.
  const deferredPool = (Array.isArray(deferredTools) ? deferredTools : [])
    .filter((t) => t && t.name && typeof t.execute === 'function');
  let toolsSchemaDirty = false;
  if (deferredPool.length > 0) {
    registry.push({
      name: 'search_tools',
      description:
        `Discover and activate additional tools. Beyond the tools listed, ${deferredPool.length} more exist `
        + '(media/image/chart generation, documents, repository/code editing, browser, sessions, …). '
        + 'Call with a short capability query (e.g. "generate image", "edit repo file", "create excel"); '
        + 'matching tools become callable immediately after.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Capability you need, a few keywords.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query }) => {
        const words = String(query || '').toLowerCase().split(/[^a-z0-9_áéíóúñ]+/).filter((w) => w.length > 2);
        if (words.length === 0) return { found: 0, note: 'Provide capability keywords.' };
        const activeNames = new Set(registry.map((t) => t.name));
        const scored = deferredPool
          .filter((t) => !activeNames.has(t.name))
          .map((t) => {
            const name = String(t.name).toLowerCase();
            const hay = `${name} ${String(t.description || '').toLowerCase()}`;
            let score = 0;
            for (const w of words) {
              if (name.includes(w)) score += 3;
              else if (hay.includes(w)) score += 1;
            }
            return { t, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
        if (scored.length === 0) {
          return { found: 0, note: 'No tools matched. Try different capability keywords (e.g. "image", "document", "repository", "browser").' };
        }
        for (const { t } of scored) {
          registry.push(t);
          registryNames.add(t.name);
        }
        toolsSchemaDirty = true;
        return {
          activated: scored.map(({ t }) => ({
            name: t.name,
            description: String(t.description || '').slice(0, 180),
          })),
          note: 'These tools are callable from your next message onward.',
        };
      },
    });
  }

  let toolsSchema = registry.map(toOpenAITool);

  // Prompted tool-calling (fallback ladder rung 2): the registry is described
  // in the system prompt and calls are parsed from fenced JSON blocks. The
  // internal `messages` trace stays CANONICAL (assistant.tool_calls +
  // role:'tool') so compaction, observation aging and the duplicate cache work
  // unchanged — only the per-request payload is converted.
  const prompted = toolCallMode === 'prompted';
  const promptedTC = prompted ? require('./agents/prompted-tool-calling') : null;
  const registryNames = new Set(registry.map((t) => t.name));
  let promptedBlock = prompted ? promptedTC.buildPromptedToolsBlock(registry) : '';

  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT
        + (extraSystem ? `\n\n${extraSystem}` : '')
        + (promptedBlock ? `\n\n${promptedBlock}` : ''),
    },
    { role: 'user',   content: query },
  ];

  const steps = [];
  let finalAnswer = null;
  let stoppedReason = 'max_steps';
  const startedAt = Date.now();

  // Prevent infinite loops when tools fail silently and the model
  // keeps making the same call. Track tool error frequency per step.
  const toolErrorBudget = new Map();
  const MAX_TOOL_ERRORS = 5; // consecutive errors → declare the tool unavailable
  // Tools that burned through their error budget. Instead of hard-aborting
  // the whole task (which dead-ends the user with "tool X failed N times in a
  // row"), we mark the tool unavailable, tell the model to answer without it,
  // and let it finalize from whatever it has. The finalize guard is told too
  // (via unavailableTools) so a required-but-broken tool stops blocking
  // termination forever. This keeps a single chat thread usable when one tool
  // (e.g. docintel_retrieve on an image or a text-less document) keeps failing.
  const exhaustedTools = new Set();
  // Finalize-guard rejection tracking (see MAX_FINALIZE_REJECTIONS above).
  let finalizeRejectionsTotal = 0;
  let finalizeRejectionsConsecutive = 0;
  // Escape hatch for exhausted-tool re-polling: some models keep calling a
  // tool we already declared unavailable, re-reading the same observation
  // forever. After EXHAUSTED_REPOLL_LIMIT consecutive such calls we force
  // tool_choice=finalize instead of burning the remaining steps.
  let exhaustedRepolls = 0;
  let forceFinalize = false;
  // Duplicate-call cache: signature → already-formatted observation string of
  // a SUCCESSFUL read-only call. Identical repeats short-circuit to the cache
  // with a do-not-repeat warning; ≥EXHAUSTED_REPOLL_LIMIT consecutive repeats
  // mean the model is looping and we force finalize (same escape hatch as
  // exhausted-tool re-polling).
  const dupCallCache = new Map();
  let duplicateRepolls = 0;
  // Recent provider latencies (ms) — used to stop exploring when the trend
  // says there is no runtime left for another full step (see toolChoice).
  const stepDurations = [];

  for (let step = 0; step < maxSteps; step++) {
    const stepStartedAt = Date.now();
    if (ctx?.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > maxRuntimeMs) {
      stoppedReason = 'runtime_budget_exhausted';
      break;
    }

    // ACI observation aging: collapse tool outputs older than the last
    // OBS_KEEP_ROUNDS rounds to one-line gists, every step, regardless of
    // total size — old state misleads more than it helps, and the duplicate
    // cache below restores any elided result the model genuinely re-needs.
    if (!OBS_ELIDE_DISABLED) {
      try { elideStaleObservations(messages); } catch { /* aging must never break the loop */ }
    }

    // Deferred tools activated on the previous step → refresh the schema
    // (and, in prompted mode, the tools block inside the system message)
    // before this completion call.
    if (toolsSchemaDirty) {
      toolsSchema = registry.map(toOpenAITool);
      if (prompted) {
        promptedBlock = promptedTC.buildPromptedToolsBlock(registry);
        messages[0] = {
          role: 'system',
          content: SYSTEM_PROMPT
            + (extraSystem ? `\n\n${extraSystem}` : '')
            + (promptedBlock ? `\n\n${promptedBlock}` : ''),
        };
      }
      toolsSchemaDirty = false;
    }

    // Keep the trace under the context budget. At the top of an iteration
    // the array always ends on a complete round (every assistant turn from
    // the previous step already has its tool replies appended), so folding
    // older rounds here can never orphan a tool message.
    if (!COMPACT_DISABLED) {
      const compacted = compactMessages(messages, {
        maxChars: compactMaxChars,
        tailRounds: compactTailRounds,
      });
      if (compacted !== messages && compacted.length < messages.length) {
        const removed = messages.length - compacted.length;
        messages.length = 0;
        messages.push(...compacted);
        try {
          onCompact({ step, removedMessages: removed, chars: estimateMessagesChars(messages) });
        } catch { /* telemetry must never break the loop */ }
      }
    }

    // If we're at the last step, force a finalize by narrowing the
    // tool choice — the model can't keep exploring past the budget. The same
    // narrowing fires when the exhausted-repoll escape tripped, or when the
    // recent provider latency trend says another exploration step would blow
    // the runtime budget mid-flight ("dejó de responder").
    const isLast = step === maxSteps - 1;
    const remainingMs = maxRuntimeMs - (Date.now() - startedAt);
    const recentDurations = stepDurations.slice(-3);
    const avgStepMs = recentDurations.length
      ? recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length
      : 0;
    const outOfRuntimeForAnotherStep =
      avgStepMs > 0 && (remainingMs - STEP_RUNTIME_BUFFER_MS) < avgStepMs * 1.5;
    if (outOfRuntimeForAnotherStep && !isLast && !forceFinalize) {
      try { console.log(`[react-agent] forcing finalize: ~${Math.round(avgStepMs)}ms/step trend vs ${remainingMs}ms left (step ${step})`); } catch { /* noop */ }
    }
    // Latch: once the trend says there is no room for another step, stay in
    // finalize mode — a fast guard-rejected finalize would otherwise lower the
    // average and let the loop resume exploring with no runtime left.
    if (outOfRuntimeForAnotherStep) forceFinalize = true;
    const shouldForceInitialTool =
      step === 0
      && initialToolChoice
      && registry.some((tool) => tool && tool.name === initialToolChoice);
    const toolChoice = (isLast || forceFinalize || outOfRuntimeForAnotherStep)
      ? { type: 'function', function: { name: 'finalize' } }
      : (shouldForceInitialTool ? { type: 'function', function: { name: initialToolChoice } } : 'auto');

    let resp;
    // Per-step wall-clock timeout. A single hung/slow provider completion
    // must NOT exceed the chat UI's 90s "stale" threshold (agentic-steps.tsx)
    // — otherwise the user sees "El asistente dejó de responder" while the
    // loop is still blocked on one call. On timeout we abort the call, mark
    // model_error, and break → the caller streams a degraded answer / the
    // route falls back to a plain completion. Env: REACT_STEP_TIMEOUT_MS.
    // The per-step cap is additionally clamped to the REMAINING run budget
    // (minus a buffer) so a slow final step can't blow the wall clock: better
    // to time out one step and degrade than to overshoot maxRuntimeMs.
    const envStepTimeoutMs = Number(process.env.REACT_STEP_TIMEOUT_MS) || 60000;
    // The floor applies only to the remaining-runtime clamp (a forced-finalize
    // completion still gets a real chance to land) — an explicit env value
    // below the floor is honored as configured.
    const stepTimeoutMs = Math.min(
      envStepTimeoutMs,
      Math.max(MIN_STEP_TIMEOUT_MS, remainingMs - STEP_RUNTIME_BUFFER_MS)
    );
    const stepCtl = new AbortController();
    const stepTimer = setTimeout(() => {
      try { stepCtl.abort(new Error('step_timeout')); } catch { /* noop */ }
    }, stepTimeoutMs);
    const onParentAbort = () => { try { stepCtl.abort(); } catch { /* noop */ } };
    if (ctx?.signal) {
      if (ctx.signal.aborted) onParentAbort();
      else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    try {
      if (prompted) {
        // Provider-safe payload: no tools/tool_choice params, no role:'tool'
        // messages. Forced narrowing (finalize / initial tool) is emulated
        // with an explicit instruction appended to the transcript.
        const forceToolName = (toolChoice && typeof toolChoice === 'object' && toolChoice.function)
          ? toolChoice.function.name
          : null;
        resp = await openai.chat.completions.create({
          model,
          messages: promptedTC.toPromptedTranscript(messages, { forceToolName }),
          temperature: 0.3,
        }, { signal: stepCtl.signal });
      } else {
        resp = await openai.chat.completions.create({
          model,
          messages,
          tools: toolsSchema,
          tool_choice: toolChoice,
          ...(parallelToolCalls === true ? { parallel_tool_calls: true } : {}),
          temperature: 0.3,
        }, { signal: stepCtl.signal });
      }
    } catch (err) {
      const timedOut = stepCtl.signal.aborted && !(ctx?.signal && ctx.signal.aborted);
      stoppedReason = timedOut
        ? `model_error: step_timeout_${stepTimeoutMs}ms`
        : `model_error: ${err.message}`;
      break;
    } finally {
      clearTimeout(stepTimer);
      if (ctx?.signal) {
        try { ctx.signal.removeEventListener('abort', onParentAbort); } catch { /* noop */ }
      }
    }

    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (!msg) { stoppedReason = 'no_message'; break; }

    // Normalise NATIVE tool-call formats → OpenAI `tool_calls`. Models like
    // Moonshot Kimi K2.6 (via OpenRouter) emit tool calls as tokens inside
    // `content` rather than structured `tool_calls`; without this they leak
    // raw markup as the answer and loop until the time budget. We also strip
    // the markup from `content` so the visible thought/answer stays clean.
    if ((!msg.tool_calls || msg.tool_calls.length === 0) && hasNativeToolCalls(msg.content)) {
      const parsed = parseNativeToolCalls(msg.content);
      msg.content = parsed.cleanedContent;
      if (parsed.toolCalls.length > 0) {
        msg.tool_calls = parsed.toolCalls;
        try { console.log(`[react-agent] parsed ${parsed.toolCalls.length} native tool call(s) from content (model=${model})`); } catch (_) { /* noop */ }
      }
    }

    // Prompted mode: parse fenced ```tool_call JSON blocks (or bare JSON
    // objects carrying a "tool" key) into OpenAI-shaped tool_calls. Names are
    // validated against the registry so quoted JSON in prose is never
    // mistaken for a call. Unique ids per step keep tool_call_id pairing sane.
    if (prompted && (!msg.tool_calls || msg.tool_calls.length === 0)
        && promptedTC.hasPromptedToolCalls(msg.content)) {
      const parsed = promptedTC.parsePromptedToolCalls(msg.content, registryNames);
      if (parsed.toolCalls.length > 0) {
        msg.content = parsed.cleanedContent;
        msg.tool_calls = parsed.toolCalls.map((c, i) => ({
          ...c,
          id: `call_p${step}_${i}_${c.function.name}`.slice(0, 60),
        }));
        try { console.log(`[react-agent] parsed ${msg.tool_calls.length} prompted tool call(s) from content (model=${model})`); } catch (_) { /* noop */ }
      }
    }

    // Persist the thought + any tool_calls so the NEXT turn has full
    // context — this is how the model "sees" its own trace.
    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    const thought = (msg.content || '').trim();

    if (toolCalls.length === 0) {
      // Model decided to answer in-place. That's a violation of the
      // contract (must use finalize). When a finalizeGuard is active,
      // do not let plain text bypass deterministic tool-use gates;
      // feed a repair instruction back into the loop instead.
      const plainStepRecord = { step, thought, actions: [] };
      if (typeof finalizeGuard === 'function') {
        let guard;
        try {
          guard = await finalizeGuard({
            answer: thought || '',
            confidence: null,
            steps: steps.concat([plainStepRecord]),
            currentStep: plainStepRecord,
            unavailableTools: Array.from(exhaustedTools),
            ctx,
          });
        } catch (err) {
          guard = { ok: false, message: `finalize guard failed: ${err.message || err}` };
        }
        if (!guard?.ok) {
          steps.push(plainStepRecord);
          onStep(plainStepRecord);
          onStepDone(plainStepRecord);
          messages.push({
            role: 'user',
            content: JSON.stringify({
              error: 'plain_text_finalize_guard_failed',
              message: guard?.message || 'Plain-text finalization blocked by execution policy.',
              missingTools: guard?.missingTools || [],
              requiredTools: guard?.requiredTools || [],
              repairInstructions: guard?.repairInstructions || 'Call the missing tools, inspect observations, then call finalize.',
            }),
          });
          continue;
        }
      }
      // With no guard, preserve legacy behavior for simple providers.
      finalAnswer = thought || '(agent returned empty message)';
      stoppedReason = 'plain_text_finalize';
      steps.push(plainStepRecord);
      onStep(plainStepRecord);
      onStepDone(plainStepRecord);
      break;
    }

    const stepRecord = { step, thought, actions: [] };
    onStepStart({
      step,
      thought,
      actions: toolCalls.map(call => ({
        tool: call.function?.name,
        args: call.function?.arguments || '',
      })),
    });
    let finalized = false;

    // A2: pre-dispatch the independent read-only tool calls of this step
    // concurrently. Their results are consumed in original order below, so
    // nothing about ordering, budgets, or the finalize guard changes.
    let prefetched = new Map();
    if (!ctx?.signal?.aborted) {
      try {
        prefetched = await prefetchParallelDispatch(registry, toolCalls, ctx, exhaustedTools);
        if (prefetched.size > 1) {
          console.log(`[react-agent] parallel-dispatched ${prefetched.size} read-only tools (step ${step})`);
        }
      } catch (_prefetchErr) { prefetched = new Map(); }
    }

    for (const call of toolCalls) {
      if (ctx?.signal?.aborted) {
        stoppedReason = 'aborted';
        finalized = true;
        break;
      }
      if (Date.now() - startedAt > maxRuntimeMs) {
        stoppedReason = 'runtime_budget_exhausted';
        finalized = true;
        break;
      }

      const toolName = call.function?.name;

      // A tool that already exhausted its error budget is unavailable: do not
      // re-invoke it (it would just fail again, wasting latency/credits).
      // Feed back a clear instruction so the model pivots to another tool or
      // finalizes with what it has.
      if (toolName !== 'finalize' && exhaustedTools.has(toolName)) {
        exhaustedRepolls += 1;
        if (exhaustedRepolls >= EXHAUSTED_REPOLL_LIMIT && !forceFinalize) {
          // The model is stuck re-polling unavailable tools. Stop feeding it
          // the same observation: next turn the tool choice is narrowed to
          // finalize (see toolChoice above) so the run terminates with a real
          // answer instead of looping to the step budget.
          forceFinalize = true;
          try { console.warn(`[react-agent] ${exhaustedRepolls} consecutive exhausted-tool calls — forcing finalize next step`); } catch { /* noop */ }
        }
        const observation = {
          error: 'tool_unavailable',
          tool: toolName,
          message: `The tool "${toolName}" is unavailable for this task after repeated failures. Do not call it again. Answer the user directly with the information you already have (use other tools or your own reasoning), then call finalize.`,
        };
        stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: formatObservation(observation),
        });
        continue;
      }
      // Any call that is NOT an exhausted re-poll means the model pivoted.
      exhaustedRepolls = 0;

      // Duplicate read-only call with identical args: short-circuit to the
      // cached result instead of re-executing. The model gets the data it
      // asked for (so re-reading after observation aging still works) plus an
      // explicit do-not-repeat warning; persistent repeats trip the same
      // forced-finalize escape as exhausted-tool re-polling.
      if (toolName !== 'finalize' && isParallelSafeTool(toolName)) {
        const sig = toolCallSignature(toolName, call.function?.arguments);
        const cached = dupCallCache.get(sig);
        if (cached) {
          duplicateRepolls += 1;
          if (duplicateRepolls >= EXHAUSTED_REPOLL_LIMIT && !forceFinalize) {
            forceFinalize = true;
            try { console.warn(`[react-agent] ${duplicateRepolls} consecutive duplicate tool calls — forcing finalize next step`); } catch { /* noop */ }
          }
          const observation = {
            warning: 'duplicate_tool_call',
            message: `You already called "${toolName}" with these exact arguments in step ${cached.step}. The cached result is returned below. Do NOT repeat identical calls — change the arguments or use a different tool.`,
            cached_result: cached.content,
          };
          stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: formatObservation(observation),
          });
          continue;
        }
      }
      duplicateRepolls = 0;

      let dispatch = prefetched.has(call.id)
        ? prefetched.get(call.id)
        : await dispatchTool(registry, toolName, call.function?.arguments, ctx);
      // A prefetched call that outlived the batch cap hands back its pending
      // promise — await it here, where the result is actually needed.
      if (dispatch && dispatch.__pending) dispatch = await dispatch.__pending;

      // A3: one-shot fallback to a compatible alternative tool on a hard error
      // (not abort/finalize). If the alternative succeeds, we use its result and
      // the failure is never counted. Same args; the alternative's own arg
      // validation protects against schema mismatches. SIRAGPT_TOOL_FALLBACK=0
      // disables.
      if (
        dispatch.error
        && toolName !== 'finalize'
        && !TOOL_FALLBACK_DISABLED
        && !/abort/i.test(String(dispatch.error))
      ) {
        const altName = fallbackToolFor(toolName);
        if (altName && altName !== toolName && !exhaustedTools.has(altName) && registry.some((t) => t && t.name === altName)) {
          try {
            const altDispatch = await dispatchTool(registry, altName, call.function?.arguments, ctx);
            if (altDispatch && !altDispatch.error) {
              console.log(`[react-agent] tool fallback ${toolName} → ${altName} recovered (step ${step})`);
              const altResult = (altDispatch.result && typeof altDispatch.result === 'object' && !Array.isArray(altDispatch.result))
                ? { ...altDispatch.result, _recovered_from: toolName, _recovered_via: altName }
                : altDispatch.result;
              dispatch = { result: altResult };
            }
          } catch (_fallbackErr) { /* keep the original error */ }
        }
      }

      let observation = dispatch.error
        ? { error: dispatch.error }
        : dispatch.result;

      // Track consecutive tool errors per tool to prevent infinite loops.
      // Transient blips weigh a fraction so a flaky upstream isn't retired as
      // fast as a deterministically broken tool (see classifyToolError).
      if (dispatch.error) {
        const errWeight = classifyToolError(dispatch.error) === 'transient' ? TRANSIENT_TOOL_ERROR_WEIGHT : 1;
        const errCount = (toolErrorBudget.get(toolName) || 0) + errWeight;
        toolErrorBudget.set(toolName, errCount);
        if (errCount >= MAX_TOOL_ERRORS && toolName !== 'finalize') {
          // Degrade gracefully instead of dead-ending the task: declare the
          // tool unavailable and let the model finalize from what it has. The
          // finalize guard waives this tool (see unavailableTools below) so a
          // required-but-broken tool no longer blocks termination.
          exhaustedTools.add(toolName);
          stoppedReason = `tool_unavailable:${toolName}`;
          const failures = Math.round(errCount);
          observation = {
            error: 'tool_unavailable',
            tool: toolName,
            failures,
            lastError: dispatch.error,
            message: `The tool "${toolName}" failed ${failures} times in a row and is now unavailable. Stop calling it. Provide the best possible answer to the user directly (use other tools or your own reasoning), then call finalize.`,
          };
        }
      } else {
        toolErrorBudget.delete(toolName);
        // A successful non-finalize tool call is genuine progress: reset the
        // consecutive finalize-rejection counter so a run that keeps moving
        // forward is only ever stopped by the absolute cap, never the soft one.
        if (toolName !== 'finalize') finalizeRejectionsConsecutive = 0;
      }

      if (toolName === 'finalize' && !dispatch.error && typeof finalizeGuard === 'function') {
        const proposedAction = { tool: toolName, args: call.function?.arguments || '', observation };
        const proposedSteps = steps.concat([{ ...stepRecord, actions: stepRecord.actions.concat([proposedAction]) }]);
        let guard;
        try {
          guard = await finalizeGuard({
            answer: dispatch.result?.answer || '',
            confidence: dispatch.result?.confidence || null,
            steps: proposedSteps,
            currentStep: stepRecord,
            unavailableTools: Array.from(exhaustedTools),
            ctx,
          });
        } catch (err) {
          guard = { ok: false, message: `finalize guard failed: ${err.message || err}` };
        }
        if (!guard?.ok) {
          finalizeRejectionsTotal += 1;
          finalizeRejectionsConsecutive += 1;
          if (
            finalizeRejectionsConsecutive >= MAX_CONSEC_FINALIZE_REJECTIONS ||
            finalizeRejectionsTotal >= MAX_FINALIZE_REJECTIONS
          ) {
            // Circuit breaker: the finalize guard has rejected this answer too
            // many times. Treating it as unsatisfiable, we accept the model's
            // current answer (degraded) rather than spin to the step/runtime
            // budget. Leave `observation` as the finalize result (no error) so
            // the terminator below fires and the user gets a real answer.
            stoppedReason = `finalized_guard_breaker:${finalizeRejectionsConsecutive}/${finalizeRejectionsTotal}`;
            try {
              console.warn(
                `[react-agent] finalize guard rejected ${finalizeRejectionsConsecutive} times in a row `
                + `(${finalizeRejectionsTotal} total) — tripping breaker and accepting degraded answer: `
                + `${guard?.message || 'blocked by execution policy'}`
              );
            } catch { /* logging must never crash the run */ }
          } else {
            observation = {
              error: 'finalize_guard_failed',
              message: guard?.message || 'Finalization blocked by execution policy.',
              missingTools: guard?.missingTools || [],
              requiredTools: guard?.requiredTools || [],
              repairInstructions: guard?.repairInstructions || 'Run the missing tool calls, then call finalize again.',
            };
          }
        } else {
          finalizeRejectionsConsecutive = 0;
        }
      }

      stepRecord.actions.push({ tool: toolName, args: call.function?.arguments || '', observation });

      // Feed the observation back as a tool message so the next model
      // call sees what happened. OpenAI requires tool messages to
      // reference the originating tool_call_id. formatObservation never
      // truncates silently: over-cap output becomes an explicit envelope
      // with a refine instruction, empty output an explicit success note.
      const obsContent = formatObservation(observation);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: obsContent,
      });

      // Remember successful read-only results so an identical repeat can be
      // served from cache (see the duplicate short-circuit above).
      if (!dispatch.error && toolName !== 'finalize' && isParallelSafeTool(toolName)
          && !(observation && typeof observation === 'object' && observation.error)) {
        if (dupCallCache.size >= DUP_CALL_CACHE_MAX) {
          dupCallCache.delete(dupCallCache.keys().next().value);
        }
        dupCallCache.set(toolCallSignature(toolName, call.function?.arguments), { step, content: obsContent });
      }

      if (toolName === 'finalize' && !dispatch.error && !observation.error) {
        finalAnswer = dispatch.result?.answer || '';
        stoppedReason = 'finalized';
        finalized = true;
        break;
      }
    }

    steps.push(stepRecord);
    onStep(stepRecord);
    onStepDone(stepRecord);

    stepDurations.push(Date.now() - stepStartedAt);
    if (finalized) break;
  }

  // Safety net: NEVER return an empty/null answer. A run can stop without a
  // real finalize for many reasons — exhausted tools, max_steps, runtime
  // budget, a model error, a guard that kept rejecting. In every one of those
  // cases the old code returned `finalAnswer = null`, which on the task path
  // surfaced as a `status:'completed'` message with no body (the `if
  // (finalMarkdown)` gate dropped it). Always hand back a short, honest
  // degraded answer so the caller has something real to show.
  if (finalAnswer == null || String(finalAnswer).trim() === '') {
    if (exhaustedTools.size > 0) {
      const toolList = Array.from(exhaustedTools).join(', ');
      finalAnswer = `No pude usar ${toolList} en esta tarea (falló de forma repetida). Te respondo con la información disponible; si necesitas más precisión, vuelve a intentarlo o reformula la solicitud.`;
      if (!stoppedReason || stoppedReason === 'max_steps') {
        stoppedReason = `degraded_no_finalize:${toolList}`;
      }
    } else {
      finalAnswer = buildDegradedAnswer(stoppedReason);
      if (!stoppedReason || stoppedReason === 'max_steps') {
        // Unconditional: `stoppedReason || 'degraded_no_finalize'` kept
        // 'max_steps' (truthy left operand), so a run that hit the step cap
        // without ever finalising reported a plain 'max_steps' instead of the
        // degraded-no-finalize signal (cf. the exhaustedTools branch above,
        // which assigns degraded_no_finalize:… unconditionally).
        stoppedReason = 'degraded_no_finalize';
      }
    }
  }

  return { finalAnswer, steps, stoppedReason, exhaustedTools: Array.from(exhaustedTools) };
}

module.exports = {
  run,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_RUNTIME_MS,
  SYSTEM_PROMPT,
  // Compiled-schema validator cache (bounded LRU) — exported for unit tests.
  validatorForTool,
  SCHEMA_VALIDATOR_CACHE_MAX,
  _schemaValidatorCacheSize: () => schemaValidatorCache.size,
  // Native tool-call parsing (Kimi/Hermes formats) — exported for unit tests.
  parseNativeToolCalls,
  hasNativeToolCalls,
  stripNativeToolCallMarkup,
  // Tool-error classification for the weighted per-run error budget.
  classifyToolError,
  // ACI observation formatting (SWE-agent) — exported for tests.
  formatObservation,
  elideStaleObservations,
  toolCallSignature,
  DEFAULT_OBS_MAX_CHARS,
  OBS_KEEP_ROUNDS,
  ELIDED_OBS_PREFIX,
  // Exported for unit testing + reuse by other loops (agent-core, executor).
  compactMessages,
  estimateMessagesChars,
  DEFAULT_COMPACT_MAX_CHARS,
  DEFAULT_COMPACT_TAIL_ROUNDS,
  // A2: parallel tool execution (exported for tests).
  isParallelSafeTool,
  prefetchParallelDispatch,
  TOOL_PARALLEL_MAX,
  prefetchCallTimeoutMs,
  // Run-loop pacing (exported for tests).
  EXHAUSTED_REPOLL_LIMIT,
  MIN_STEP_TIMEOUT_MS,
  STEP_RUNTIME_BUFFER_MS,
  // A3: tool fallback (exported for tests).
  fallbackToolFor,
  TOOL_FALLBACK_MAP,
};
