/**
 * agent-core — generic LLM-based agent with the four-component
 * architecture from Liu et al., "Large Language Model-Based Agents for
 * Software Engineering: A Survey" (2024), §2.1 and §5.1:
 *
 *   Planning   — decompose a goal into sub-steps and schedule them
 *   Memory     — record thoughts, actions, observations across turns
 *   Perception — ingest inputs (we only support text here)
 *   Action     — invoke external tools to change/read the environment
 *
 * Concretely this is a ReAct loop (Yao et al., 2023):
 *   while not done and n < maxIters:
 *     think = LLM(system + memory + goal)                  # plan
 *     if think.tool: obs = tools[think.tool](think.args)   # act + perceive
 *     memory.append({ think, tool, args, obs })            # memorise
 *     if think.final: return think.final
 *
 * Production hardening vs a naïve ReAct:
 *   - Robust JSON extraction: a proper string/escape-aware parser with
 *     three fallbacks (direct parse → code-fence → balanced brace scan
 *     that tracks strings). No more "silently returns null because a
 *     brace appeared inside a string literal".
 *   - Retries with exponential backoff on transient LLM errors
 *     (rate limit, 5xx, network). Capped so we don't spin forever.
 *   - Per-request tool-result cache keyed by hash(name, args). If the
 *     LLM calls read_file("foo.js") twice, we only hit RAG once.
 *   - Same-response loop breaker: if the LLM emits identical output two
 *     turns in a row, we feed a nudge and exit if it persists on a third.
 *   - Streaming hook via `onStep(step)` for real-time UI feedback.
 *   - Token estimation per step so callers can budget context.
 *   - Tool errors become observations (not throws) so the LLM can react.
 *
 * Memory is an append-only scratchpad bounded by maxIters. For long-
 * horizon memory layer gist-memory.js or long-term-memory.js on top.
 */

const crypto = require('crypto');

const DEFAULT_MAX_ITERS = 8;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 1400;
const MAX_OBSERVATION_CHARS = 4000;

// Retry policy — roughly: 1s, 2s, 4s, with jitter. Caps total wait at ~7s.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;

// ─── JSON extraction (string-aware) ────────────────────────────────────────

/**
 * Find the first top-level `{...}` block in `text`, tracking string state
 * so braces inside strings don't throw off the balance. Returns the JSON
 * string or null. `\\`-escapes inside strings are honoured.
 */
function findBalancedJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort JSON extraction from an LLM response. Three passes:
 *   1. Direct JSON.parse  — for well-behaved models.
 *   2. Code-fence strip   — some models wrap output in ```json … ```.
 *   3. Balanced-brace scan — finds the first {...} even if prose precedes.
 * Returns a parsed object or null.
 */
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  try { return JSON.parse(trimmed); } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const balanced = findBalancedJSON(trimmed);
  if (balanced) {
    try { return JSON.parse(balanced); } catch {}
  }
  return null;
}

// ─── LLM call with retry ───────────────────────────────────────────────────

function isTransientLLMError(err) {
  if (!err) return false;
  // OpenAI SDK v4 attaches `status` on APIError.
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;

  const netPattern = /timeout|econnreset|econnrefused|ehostunreach|enetunreach|eai_again/i;
  const code = err.code || err.error?.code || '';
  if (typeof code === 'string' && netPattern.test(code)) return true;

  const msg = String(err.message || err);
  if (netPattern.test(msg)) return true;
  if (/rate[-\s]?limit|temporarily unavailable|connection reset|overloaded/i.test(msg)) return true;
  return false;
}

async function callLLMWithRetry(openai, params) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientLLMError(err) || attempt === RETRY_MAX_ATTEMPTS - 1) throw err;
      const base = RETRY_BASE_MS * Math.pow(2, attempt);
      const jitter = Math.random() * 250;
      await new Promise(r => setTimeout(r, base + jitter));
    }
  }
  throw lastErr;
}

// ─── System prompt template ────────────────────────────────────────────────

function renderToolSchema(schema) {
  // Render the schema as a compact hint the LLM can follow without
  // needing a full JSON Schema spec. Accepts either a plain object of
  // "field: description" strings or a nested object.
  if (!schema || typeof schema !== 'object') return '{}';
  try { return JSON.stringify(schema); } catch { return '{}'; }
}

function buildSystemPrompt({ role, toolSpecs, finalSchema }) {
  const toolsBlock = toolSpecs.length === 0
    ? '(no tools available — respond directly with a final answer)'
    : toolSpecs.map(t => `- ${t.name}: ${t.description}\n  args: ${renderToolSchema(t.schema)}`).join('\n');

  const finalBlock = finalSchema
    ? `\n\nWhen you are ready to finish, reply with STRICT JSON:\n${JSON.stringify({ final: finalSchema }, null, 2)}`
    : `\n\nWhen you are ready to finish, reply with STRICT JSON:\n{"final": "<your final answer>"}`;

  return `${role}

On each turn, reply with STRICT JSON of one of these shapes:
{"thought":"<one sentence on what to do next>","tool":"<tool_name>","args":{...}}
{"thought":"<one sentence>","final":<your result>}

Available tools:
${toolsBlock}
${finalBlock}

Rules:
- Output JSON only. No markdown, no prose outside the JSON.
- Prefer calling a tool when you need data. Prefer finalising when you have enough.
- If a tool errors, read the observation and try a different approach.
- Do not call the same tool with the same args twice in a row — the result will be the same.`;
}

// ─── Trace / memory ────────────────────────────────────────────────────────

function approxTokens(text) {
  // Rough heuristic: 1 token ≈ 4 characters for English, closer to 3 for
  // code-heavy text. We don't need accuracy — this is for budget tracking
  // and UI display, not billing.
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.5);
}

class AgentTrace {
  constructor() {
    this.steps = [];
    this.totalLLMTokens = 0;
    this.totalDurationMs = 0;
  }
  append(step) {
    const withTiming = { ...step, at: Date.now() };
    this.steps.push(withTiming);
    return withTiming;
  }
  toMessages() {
    return this.steps.flatMap(s => {
      const msgs = [];
      if (s.think || s.tool || s.final !== undefined) {
        const payload = s.final !== undefined
          ? { thought: s.think || '', final: s.final }
          : { thought: s.think || '', ...(s.tool ? { tool: s.tool, args: s.args } : {}) };
        msgs.push({ role: 'assistant', content: JSON.stringify(payload) });
      }
      if (s.observation !== undefined) {
        const obs = typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation);
        msgs.push({ role: 'user', content: `Observation: ${obs.slice(0, MAX_OBSERVATION_CHARS)}` });
      }
      return msgs;
    });
  }
}

// ─── Tool-call cache (per run) ─────────────────────────────────────────────

function argsHash(name, args) {
  let payload;
  try { payload = JSON.stringify(args || {}); } catch { payload = String(args); }
  return `${name}:${crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16)}`;
}

// ─── Main run() ────────────────────────────────────────────────────────────

/**
 * Run an agent to completion against a goal.
 *
 * @param {object} args
 * @param {object} args.openai — OpenAI-shaped client (required)
 * @param {string} [args.role] — the agent's role / persona
 * @param {string} args.goal — the task description (user-facing)
 * @param {Array}  [args.tools=[]] — [{ name, description, schema, handler(args, ctx) }]
 * @param {number} [args.maxIters=8]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.temperature=0.1]
 * @param {number} [args.maxTokens=1400] — per-LLM-call response cap
 * @param {object} [args.context={}] — opaque object forwarded to tool.handler as ctx
 * @param {object} [args.finalSchema] — optional shape hint for the final answer
 * @param {function} [args.onStep] — called after each step with the step object
 *                                   (fire-and-forget; errors in onStep are swallowed)
 *
 * @returns {Promise<{
 *   final: any|null,
 *   trace: Array,
 *   iterations: number,
 *   terminatedBy: 'final'|'maxIters'|'error'|'loop',
 *   stats: {
 *     toolCalls: number,
 *     toolCacheHits: number,
 *     approxPromptTokens: number,
 *     approxCompletionTokens: number,
 *     durationMs: number,
 *   }
 * }>}
 */
async function run({
  openai, role, goal, tools = [],
  maxIters = DEFAULT_MAX_ITERS, model = DEFAULT_MODEL,
  temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS,
  context = {}, finalSchema = null, onStep = null,
}) {
  if (!openai) throw new Error('agent-core.run: openai client is required');
  if (!goal) throw new Error('agent-core.run: goal is required');

  const toolSpecs = tools.map(t => ({ name: t.name, description: t.description, schema: t.schema }));
  const toolByName = new Map(tools.map(t => [t.name, t]));

  const system = buildSystemPrompt({
    role: role || 'You are a helpful software engineering assistant.',
    toolSpecs,
    finalSchema,
  });

  const trace = new AgentTrace();
  const toolCache = new Map();
  const stats = {
    toolCalls: 0,
    toolCacheHits: 0,
    approxPromptTokens: 0,
    approxCompletionTokens: 0,
    durationMs: 0,
  };
  const startAt = Date.now();

  let terminatedBy = 'maxIters';
  let final = null;
  let n = 0;
  let lastRawResponse = null;
  let sameResponseStreak = 0;

  for (n = 1; n <= maxIters; n++) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Goal: ${goal}` },
      ...trace.toMessages(),
    ];

    // Estimate prompt tokens for telemetry.
    for (const m of messages) stats.approxPromptTokens += approxTokens(m.content);

    let raw;
    const llmStart = Date.now();
    try {
      const resp = await callLLMWithRetry(openai, {
        model, temperature, max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages,
      });
      raw = resp.choices?.[0]?.message?.content || '';
      stats.approxCompletionTokens += approxTokens(raw);
    } catch (err) {
      const step = trace.append({ error: `LLM call failed: ${err.message || err}`, durationMs: Date.now() - llmStart });
      safeOnStep(onStep, step);
      terminatedBy = 'error';
      break;
    }

    // Same-response loop detection. If the LLM is emitting an identical
    // response two turns in a row, nudge it; persist on a third → abort.
    if (raw === lastRawResponse) {
      sameResponseStreak++;
      if (sameResponseStreak >= 2) {
        const step = trace.append({
          think: '(aborting — model stuck emitting the same output)',
          observation: 'Aborted: model produced identical output twice in a row.',
          durationMs: Date.now() - llmStart,
        });
        safeOnStep(onStep, step);
        terminatedBy = 'loop';
        break;
      }
    } else {
      sameResponseStreak = 0;
      lastRawResponse = raw;
    }

    const parsed = extractJSON(raw);
    if (!parsed) {
      const step = trace.append({
        think: '(unparseable output)',
        observation: 'Your last reply was not valid JSON. Reply again with STRICT JSON only, no prose.',
        durationMs: Date.now() - llmStart,
      });
      safeOnStep(onStep, step);
      continue;
    }

    if (parsed.final !== undefined) {
      final = parsed.final;
      const step = trace.append({ think: parsed.thought || '', final, durationMs: Date.now() - llmStart });
      safeOnStep(onStep, step);
      terminatedBy = 'final';
      break;
    }

    const toolName = parsed.tool;
    const tool = toolName ? toolByName.get(toolName) : null;
    if (!tool) {
      const step = trace.append({
        think: parsed.thought || '',
        tool: toolName || null,
        args: parsed.args,
        observation: toolName
          ? `Unknown tool "${toolName}". Available: ${toolSpecs.map(t => t.name).join(', ')}`
          : 'No tool specified. Either call a tool or return {"final": ...}.',
        durationMs: Date.now() - llmStart,
      });
      safeOnStep(onStep, step);
      continue;
    }

    // Tool-result cache — same (tool, args) in one run() returns the
    // memoised observation. Saves RAG/LLM calls for repeated reads.
    const cacheKey = argsHash(toolName, parsed.args);
    let observation;
    let cacheHit = false;
    const toolStart = Date.now();
    if (toolCache.has(cacheKey)) {
      observation = toolCache.get(cacheKey);
      cacheHit = true;
      stats.toolCacheHits++;
    } else {
      try {
        observation = await tool.handler(parsed.args || {}, context);
      } catch (err) {
        observation = { error: err.message || 'tool error' };
      }
      toolCache.set(cacheKey, observation);
      stats.toolCalls++;
    }

    const step = trace.append({
      think: parsed.thought || '',
      tool: toolName,
      args: parsed.args,
      observation,
      cacheHit,
      durationMs: Date.now() - toolStart,
    });
    safeOnStep(onStep, step);
  }

  stats.durationMs = Date.now() - startAt;

  return {
    final,
    trace: trace.steps,
    iterations: n > maxIters ? maxIters : n,
    terminatedBy,
    stats,
  };
}

function safeOnStep(onStep, step) {
  if (typeof onStep !== 'function') return;
  try { onStep(step); } catch (err) { /* swallow — streaming must never break the loop */ }
}

module.exports = {
  run,
  AgentTrace,
  extractJSON,
  findBalancedJSON,
  buildSystemPrompt,
  isTransientLLMError,
  callLLMWithRetry,
  approxTokens,
  DEFAULT_MAX_ITERS,
  DEFAULT_MODEL,
  RETRY_MAX_ATTEMPTS,
};
