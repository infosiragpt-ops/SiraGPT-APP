/**
 * task-contract-resolver — turn a raw user message into a validated
 * TaskContract (see task-contract-schema.js).
 *
 * Pipeline:
 *   user message
 *     → OpenAI chat.completions.create with
 *         temperature: 0,
 *         response_format: { type: "json_schema", json_schema: { ..., strict: true } }
 *     → ajv.validate against the same schema (defense-in-depth)
 *     → TaskContract or null
 *
 * When the LLM is unavailable, the schema validation fails, OR the
 * resolver is told to skip it (tests), we return the heuristic
 * `fallback` profile: a TaskContract synthesised from the legacy
 * regex router (user-intent-alignment.js / agentic-execution-profile.js).
 *
 * Temperature is 0 by design: this is classification, not generation.
 * Drift here poisons every downstream stage.
 */

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const {
  taskContractSchema,
  TASK_CONTRACT_VERSION,
  EXTENSIONS,
  MIME_TYPES,
} = require("./task-contract-schema");

let cachedValidator = null;
function getValidator() {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    useDefaults: true,
  });
  addFormats(ajv);
  cachedValidator = ajv.compile(taskContractSchema);
  return cachedValidator;
}

const RESOLVER_SYSTEM_PROMPT = `You are siraGPT's Intent Router. Your ONLY job is to turn the user's message into a strict TaskContract JSON that the task agent will execute against.

HARD RULES:
- Return ONLY the JSON. No prose, no markdown fences.
- The contract is a CLOSED ROUTE. If the user says "SVG de una casa", required_extension MUST be "svg" and mime_type MUST be "image/svg+xml" — NEVER a substitute like "docx" or "png".
- If the user explicitly names a format (excel, word, ppt, pdf, svg), you MUST lock required_extension + mime_type to that exact format and add a forbidden_outputs entry rejecting every OTHER file format they could have meant.
- artifact_type must be the best-fit category from the enum. When the user wants a concrete answer in the chat with no file, use "text-answer" + required_extension=null + mime_type=null + delivery_mode="inline-chat".
- success_tests must be concrete and machine-checkable. Every user-named constraint becomes a deterministic test (e.g. "30 filas" → min_rows with value 30; "abrir en Word" → opens_as_docx; "SVG renderizable" → parses_as_svg).
- Add a forbidden_format_absent deterministic test for every wrong extension the model might substitute.
- ambiguity_level="high" + 1–3 clarifying_questions ONLY when you genuinely cannot infer the artifact_type or required_extension. Otherwise "low" or "medium".
- Respond in the user's language for the user_intent, content_requirements, forbidden_outputs, and test descriptions. English for the schema enum values.

FORMAT ROUTING MATRIX (use these defaults unless the user overrides):
- SVG / vector illustration → artifact_type=svg, ext=svg, mime=image/svg+xml, delivery_mode=downloadable-file or inline-chat
- Word / informe / carta → artifact_type=document, ext=docx, mime=application/vnd.openxmlformats-officedocument.wordprocessingml.document
- Excel / base de datos / tabla / .xlsx → artifact_type=spreadsheet, ext=xlsx, mime=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
- PowerPoint / presentación / slides → artifact_type=presentation, ext=pptx, mime=application/vnd.openxmlformats-officedocument.presentationml.presentation
- PDF / exportar a PDF → artifact_type=pdf, ext=pdf, mime=application/pdf
- CSV / plantilla simple → artifact_type=spreadsheet, ext=csv, mime=text/csv
- Código (python/node/etc.) → artifact_type=code, ext=py|js|ts|..., mime=text/x-python|application/javascript|...
- Búsqueda de información / fuentes sin archivo → artifact_type=data-search, ext=null, mime=null
- Explicación / pregunta conversacional → artifact_type=text-answer, ext=null, mime=null, delivery_mode=inline-chat`;

const FEW_SHOT_EXAMPLES = [
  {
    user: "créame un SVG de una casa con techo rojo y dos ventanas",
    contract: {
      version: "1.0",
      user_intent: "Generar un SVG de una casa con techo rojo y dos ventanas.",
      artifact_type: "svg",
      required_extension: "svg",
      mime_type: "image/svg+xml",
      delivery_mode: "downloadable-file",
      content_requirements: [
        "Archivo SVG válido que se renderice en navegador.",
        "Dibujo reconocible de una casa: cuerpo, techo, puerta.",
        "Techo de color rojo.",
        "Dos ventanas visibles.",
      ],
      forbidden_outputs: [
        "No entregar .docx / .pdf / .png en lugar del SVG.",
        "No devolver sólo descripción en texto; debe ser archivo SVG real.",
      ],
      ambiguity_level: "low",
      clarifying_questions: [],
      success_tests: [
        { id: "extension_match", type: "deterministic", description: "El archivo entregado termina en .svg.", check: "extension_match", parameters: "{\"value\":\"svg\"}" },
        { id: "mime_match", type: "deterministic", description: "MIME type real del archivo es image/svg+xml.", check: "mime_magic_match", parameters: "{\"value\":\"image/svg+xml\"}" },
        { id: "svg_parseable", type: "deterministic", description: "Contiene <svg> y parsea como XML válido.", check: "parses_as_svg", parameters: "" },
        { id: "forbidden_docx", type: "deterministic", description: "No se entrega un Word en lugar del SVG.", check: "forbidden_format_absent", parameters: "{\"extensions\":[\"docx\",\"pdf\",\"png\"]}" },
        { id: "renders_house", type: "semantic", description: "Al renderizarlo, se ve una casa con techo rojo y dos ventanas.", check: "semantic_match", parameters: "" },
      ],
    },
  },
  {
    user: "Hazme un Excel con 30 artículos académicos sobre alfa de Cronbach, columnas N°, autores, título, año, revista, DOI",
    contract: {
      version: "1.0",
      user_intent: "Excel con 30 artículos sobre alfa de Cronbach con columnas N°, autores, título, año, revista, DOI.",
      artifact_type: "spreadsheet",
      required_extension: "xlsx",
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      delivery_mode: "downloadable-file",
      content_requirements: [
        "El Excel contiene al menos 30 filas de datos (sin contar header).",
        "Columnas exactas: N°, autores, título, año, revista, DOI.",
        "Cada fila es un artículo real con DOI verificable.",
        "DOIs son enlaces canónicos https://doi.org/…",
      ],
      forbidden_outputs: [
        "No entregar .docx / .pdf en lugar del .xlsx.",
        "No inventar DOIs ni artículos no verificados.",
      ],
      ambiguity_level: "low",
      clarifying_questions: [],
      success_tests: [
        { id: "extension_match", type: "deterministic", description: "Archivo .xlsx.", check: "extension_match", parameters: "{\"value\":\"xlsx\"}" },
        { id: "mime_match", type: "deterministic", description: "MIME real openxmlformats spreadsheet.", check: "mime_magic_match", parameters: "{\"value\":\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"}" },
        { id: "opens_as_xlsx", type: "deterministic", description: "Se abre correctamente como xlsx (ZIP con workbook.xml).", check: "opens_as_xlsx", parameters: "" },
        { id: "min_rows_31", type: "deterministic", description: "Al menos 31 filas (30 datos + header).", check: "min_rows", parameters: "{\"value\":31}" },
        { id: "min_columns_6", type: "deterministic", description: "Al menos 6 columnas.", check: "min_columns", parameters: "{\"value\":6}" },
        { id: "forbidden_word_pdf", type: "deterministic", description: "No se entrega Word o PDF en lugar.", check: "forbidden_format_absent", parameters: "{\"extensions\":[\"docx\",\"pdf\",\"csv\"]}" },
      ],
    },
  },
  {
    user: "explícame qué es el teorema de Bayes",
    contract: {
      version: "1.0",
      user_intent: "Explicar qué es el teorema de Bayes.",
      artifact_type: "text-answer",
      required_extension: null,
      mime_type: null,
      delivery_mode: "inline-chat",
      content_requirements: [
        "Explicación conceptual clara en lenguaje natural.",
        "Incluye la fórmula P(A|B) = P(B|A) P(A) / P(B).",
        "Al menos un ejemplo numérico.",
      ],
      forbidden_outputs: [
        "No adjuntar archivos Word/Excel/PDF: el usuario pidió una explicación inline.",
      ],
      ambiguity_level: "low",
      clarifying_questions: [],
      success_tests: [
        { id: "inline_only", type: "deterministic", description: "No se adjunta ningún archivo.", check: "forbidden_format_absent", parameters: "{\"extensions\":[\"docx\",\"xlsx\",\"pptx\",\"pdf\"]}" },
        { id: "mentions_bayes", type: "deterministic", description: "El texto menciona 'Bayes'.", check: "contains_text", parameters: "{\"value\":\"Bayes\"}" },
        { id: "has_formula", type: "deterministic", description: "Incluye la fórmula P(A|B).", check: "contains_regex", parameters: "{\"pattern\":\"P\\\\s*\\\\(\\\\s*A\\\\s*\\\\|\\\\s*B\\\\s*\\\\)\"}" },
      ],
    },
  },
];

function fewShotMessages() {
  const msgs = [];
  for (const ex of FEW_SHOT_EXAMPLES) {
    msgs.push({ role: "user", content: ex.user });
    msgs.push({ role: "assistant", content: JSON.stringify(ex.contract) });
  }
  return msgs;
}

function safeParseJson(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(t); } catch { return null; }
}

// The contract resolver runs BEFORE the agent emits its first step event, so
// a slow/hung provider here is invisible to the user ("Analizando solicitud"
// with 0 steps) until the client's 90s idle watchdog aborts. We cap the LLM
// call so a stall drops us into the deterministic heuristic fallback fast
// instead of freezing the whole run. The underlying request is also bounded
// by the client's own timeout (agent-task-runner buildOpenAICompatibleClient);
// this race is a second, tighter ceiling specific to the planning phase.
const DEFAULT_RESOLVER_TIMEOUT_MS = 30_000;

function resolverTimeoutMs(explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const env = Number.parseInt(process.env.AGENT_TASK_CONTRACT_TIMEOUT_MS || "", 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_RESOLVER_TIMEOUT_MS;
}

/**
 * Resolve `promise`, but reject with a timeout error if it does not settle
 * within `ms`. A non-positive / non-finite `ms` disables the cap. The timer
 * is unref'd so it never keeps the process alive, and always cleared.
 */
function raceWithTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`task-contract-resolver timed out after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Resolve a TaskContract for a raw user message.
 *
 * @param {object} args
 * @param {string} args.goal — the user message / task goal
 * @param {OpenAI} [args.openai] — OpenAI client (optional; without it we fall back)
 * @param {string} [args.model="gpt-4o-mini"]
 * @param {string[]} [args.fileIds] — ids of already-uploaded files (passed as hint)
 * @param {function} [args.fallback] — ({goal, fileIds}) => TaskContract
 *
 * @returns {Promise<{
 *   contract: object,
 *   source: "llm"|"fallback"|"regex",
 *   validationErrors?: Array<{instancePath: string, message: string}>,
 *   durationMs: number,
 * }>}
 */
async function resolveTaskContract({ goal, openai, model = "gpt-4o-mini", fileIds, fallback, timeoutMs, env = process.env, deps = {} }) {
  const t0 = Date.now();
  const effTimeoutMs = resolverTimeoutMs(timeoutMs);
  const hint = Array.isArray(fileIds) && fileIds.length > 0
    ? `\n\n(The user has ${fileIds.length} uploaded file${fileIds.length === 1 ? "" : "s"} attached to this conversation.)`
    : "";

  // Pick the right (client, model) tuple for Structured Outputs. The
  // caller often hands us a generic provider client (DeepSeek,
  // OpenRouter, Anthropic-shim, Gemini-shim) that does NOT accept
  // OpenAI model identifiers. Calling `openai.chat.completions.create({ model: "gpt-4o-mini" })`
  // against the DeepSeek base URL fails fast with HTTP 400 ("the
  // supported API model names are deepseek-v4-pro or deepseek-v4-flash").
  //
  // Strategy, in priority order (see pickResolverRuntime):
  //   1. If the caller's client looks like DeepSeek's baseURL, remap
  //      the model to deepseek-v4-flash (cheap, structured-outputs
  //      compatible, same JSON-schema mode).
  //   2. Caller's client is OpenAI-native AND OpenAI's key is healthy →
  //      honor (client, model).
  //   3. Otherwise walk the runtime ladder (OpenAI → DeepSeek → Cerebras →
  //      Gemini) and build a side-channel client on the first provider
  //      whose key is configured and not rejected/unfunded
  //      (provider-key-health + billing-failover memos). Prod 2026-09-28:
  //      every request spent a 429 «You have no credits remaining» on the
  //      dead OpenAI key before falling back to the heuristic.
  //   4. Nothing healthy → skip the LLM entirely (heuristic fallback).
  let effectiveOpenai = openai;
  let effectiveModel = model;
  let effectiveProvider = null;
  let effectiveKey = '';
  try {
    const picked = pickResolverRuntime({ openai, model, env, deps });
    effectiveOpenai = picked.client;
    effectiveModel = picked.model;
    effectiveProvider = picked.provider;
    effectiveKey = picked.key;
    if (picked.skipped) {
      logResolverFailureOnce(`skip:${picked.skipped}`, `[task-contract-resolver] LLM resolve skipped: ${picked.skipped}; using the heuristic contract`);
    }
  } catch (_e) {
    // Defensive: never abort the resolver because of introspection.
  }

  // Try LLM with Structured Outputs first.
  if (effectiveOpenai && typeof effectiveOpenai.chat?.completions?.create === "function" && typeof goal === "string" && goal.trim().length > 0) {
    try {
      const request = (responseFormat) => raceWithTimeout(effectiveOpenai.chat.completions.create({
        model: effectiveModel,
        temperature: 0,
        max_tokens: 1400,
        messages: [
          { role: "system", content: RESOLVER_SYSTEM_PROMPT },
          ...fewShotMessages(),
          { role: "user", content: goal + hint },
        ],
        response_format: responseFormat,
      }), effTimeoutMs);
      // OpenAI Structured Outputs (strict json_schema) where the provider
      // takes it; DeepSeek only takes JSON mode (prod 2026-09-29: «400 This
      // response_format type is unavailable now»). Either way ajv validates
      // below, so JSON mode loses no safety.
      const format = resolverResponseFormat(effectiveProvider);
      let resp;
      try {
        resp = await request(format);
      } catch (err) {
        if (format.type !== "json_object" && isResponseFormatRejection(err)) {
          resp = await request(JSON_OBJECT_FORMAT);
        } else {
          throw err;
        }
      }
      const raw = resp?.choices?.[0]?.message?.content;
      const parsed = safeParseJson(raw);
      if (parsed) {
        const validate = getValidator();
        const ok = validate(parsed);
        if (ok) {
          return { contract: parsed, source: "llm", durationMs: Date.now() - t0 };
        }
        return {
          contract: fallback ? fallback({ goal, fileIds }) : makeEmptyContract(goal),
          source: "fallback",
          validationErrors: (validate.errors || []).map(e => ({ instancePath: e.instancePath, message: e.message })),
          durationMs: Date.now() - t0,
        };
      }
    } catch (err) {
      // Memoise a dead/unfunded key so the next request skips this
      // provider without a round-trip, then log — once per reason per
      // 10 min, not per request — and fall back.
      noteResolverProviderFailure({ provider: effectiveProvider, key: effectiveKey, err, env, deps });
      const status = Number(err?.status || err?.statusCode) || null;
      logResolverFailureOnce(
        `fail:${effectiveProvider || 'client'}:${status || 'err'}:${String(err?.message || err).slice(0, 80)}`,
        `[task-contract-resolver] LLM resolve failed${effectiveProvider ? ` (${effectiveProvider}:${effectiveModel})` : ''}: ${err?.message || err}`,
      );
    }
  }

  const contract = fallback ? fallback({ goal, fileIds }) : makeEmptyContract(goal);
  return { contract, source: "fallback", durationMs: Date.now() - t0 };
}

// ── Response format per provider ─────────────────────────────────────────

const JSON_OBJECT_FORMAT = Object.freeze({ type: "json_object" });

function resolverResponseFormat(provider) {
  if (String(provider || "").toLowerCase() === "deepseek") return JSON_OBJECT_FORMAT;
  return {
    type: "json_schema",
    json_schema: {
      name: "TaskContract",
      strict: true,
      schema: toStrictOpenAISchema(taskContractSchema),
    },
  };
}

/** A 400 that rejects the response_format itself (not the prompt). */
function isResponseFormatRejection(err) {
  const status = Number(err?.status || err?.statusCode) || null;
  return status === 400 && /response_format|json_schema|structured output/i.test(String(err?.message || ""));
}

// ── Runtime ladder (key health aware) ────────────────────────────────────

const RESOLVER_LOG_DEBOUNCE_MS = 10 * 60 * 1000;
const resolverLogMemo = new Map(); // reason → last logged at

function logResolverFailureOnce(reason, line, now = Date.now()) {
  const last = resolverLogMemo.has(reason) ? resolverLogMemo.get(reason) : null;
  if (last !== null && now - last < RESOLVER_LOG_DEBOUNCE_MS) {
    try { console.debug(line); } catch (_) { /* ignore */ }
    return false;
  }
  resolverLogMemo.set(reason, now);
  console.warn(line);
  return true;
}

function resolverRuntimeLadder(env = process.env) {
  return [
    { provider: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseURL: null, model: null },
    { provider: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    {
      provider: 'Cerebras',
      apiKeyEnv: 'CEREBRAS_API_KEY',
      baseURL: env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
      model: env.AGENT_TASK_CEREBRAS_MODEL || env.FREE_IA_MODEL_ID || 'gpt-oss-120b',
    },
    {
      provider: 'Gemini',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    },
  ];
}

function resolverDeps(deps = {}) {
  return {
    keyHealth: deps.keyHealth || require('../../utils/provider-key-health'),
    billing: deps.billing || require('../ai/billing-failover'),
    createClient: deps.createClient || defaultCreateClient,
  };
}

function defaultCreateClient(target, env) {
  const OpenAI = require('openai');
  const opts = { apiKey: env[target.apiKeyEnv] };
  if (target.baseURL) opts.baseURL = target.baseURL;
  const timeoutMs = Number.parseInt(env.AGENT_TASK_LLM_TIMEOUT_MS || '', 10);
  opts.timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  opts.maxRetries = 1;
  const client = new OpenAI(opts);
  if (target.provider === 'OpenAI') {
    try { return require('../ai/openai-sampling-params').wrapOpenAIChatClient(client); } catch (_) { return client; }
  }
  return client;
}

// Placeholder keys (CI dummies, templates) never build a side channel — the
// same rule as embedding-provider, so offline suites stay offline.
const PLACEHOLDER_KEY_RE = /dummy|not-used|ci-dummy|test-key|^your_|^sk-xxx|^changeme$/i;

/** Why the provider must be skipped right now, or null when usable. */
function providerBlockedReason(target, env, { keyHealth, billing }) {
  const key = String(env[target.apiKeyEnv] || '').trim();
  if (!key || PLACEHOLDER_KEY_RE.test(key)) return 'no_key';
  try {
    if (keyHealth.isRejected(target.provider, key)) {
      const reason = typeof keyHealth.rejectionReason === 'function' ? keyHealth.rejectionReason(target.provider, key) : null;
      return reason === 'billing' ? 'unfunded' : 'key_rejected';
    }
  } catch (_) { /* advisory */ }
  try {
    if (billing.isOutOfCredit(target.provider, env)) return 'unfunded';
  } catch (_) { /* advisory */ }
  return null;
}

function pickResolverRuntime({ openai, model, env = process.env, deps = {} } = {}) {
  const d = resolverDeps(deps);
  const baseURL = openai?.baseURL || openai?.client?.baseURL || openai?._options?.baseURL || '';
  const isDeepseek = /(^|\.)deepseek\.com/i.test(String(baseURL));
  const isOpenAINative = Boolean(openai) && (!baseURL || /(^|\.)openai\.com/i.test(String(baseURL)));
  const ladder = resolverRuntimeLadder(env);
  const openaiTarget = ladder[0];

  if (openai && isDeepseek) {
    return {
      client: openai,
      model: /pro/i.test(String(model)) ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
      provider: 'DeepSeek',
      key: String(env.DEEPSEEK_API_KEY || '').trim(),
      skipped: null,
    };
  }

  const openaiBlocked = providerBlockedReason(openaiTarget, env, d);
  if (isOpenAINative && (!openaiBlocked || openaiBlocked === 'no_key')) {
    // The caller's own OpenAI client (its key may not be in env — e.g. a
    // per-user key); honor it unless OpenAI is known to be dead/unfunded.
    return { client: openai, model, provider: 'OpenAI', key: String(env.OPENAI_API_KEY || '').trim(), skipped: null };
  }

  const blocked = [];
  for (const target of ladder) {
    const why = providerBlockedReason(target, env, d);
    if (why) { if (why !== 'no_key') blocked.push(`${target.provider}:${why}`); continue; }
    let client = null;
    try { client = d.createClient(target, env); } catch (_) { client = null; }
    if (!client) continue;
    return {
      client,
      model: target.provider === 'OpenAI' ? (model || 'gpt-4o-mini') : target.model,
      provider: target.provider,
      key: String(env[target.apiKeyEnv] || '').trim(),
      skipped: null,
    };
  }

  if (openai && !isOpenAINative) {
    // Unknown caller client (OpenRouter, custom…) and no side channel: keep
    // the legacy behaviour and try it as-is.
    return { client: openai, model, provider: null, key: '', skipped: null };
  }
  return {
    client: null,
    model,
    provider: null,
    key: '',
    skipped: blocked.length ? `no funded provider (${blocked.join(', ')})` : 'no provider configured',
  };
}

function noteResolverProviderFailure({ provider, key, err, env = process.env, deps = {} }) {
  if (!provider || !err) return;
  const d = resolverDeps(deps);
  try {
    if (d.billing.isBillingError(err)) { d.billing.markOutOfCredit(provider, err, env); return; }
  } catch (_) { /* advisory */ }
  try {
    if (key && d.keyHealth.isInvalidKeyError(err)) d.keyHealth.markRejected(provider, key, err, env);
  } catch (_) { /* advisory */ }
}

function __resetResolverForTests() { resolverLogMemo.clear(); }

/**
 * OpenAI's json_schema mode is stricter than general ajv — every
 * property must be listed in `required`, and `additionalProperties`
 * must be false. We enforce that here so the prompt doesn't diverge
 * from what the API will accept.
 *
 * Note: `oneOf` is NOT supported by OpenAI's structured outputs at
 * any nesting level — the schema must use `anyOf` for nullable
 * string-enum properties (see `required_extension` / `mime_type` in
 * task-contract-schema.js). This pass leaves them alone.
 */
function toStrictOpenAISchema(root) {
  function visit(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      copy[k] = visit(v);
    }
    if (copy.type === "object" && copy.properties && !copy.additionalProperties) {
      copy.additionalProperties = false;
    }
    // OpenAI strict mode demands `required` enumerate EVERY property
    // key - not just the semantically required ones. Overwrite any
    // partial `required` array the schema author wrote (e.g.
    // success_tests.items declares [`id`, `type`, `description`] but
    // also exposes `check` and `parameters`) so the API stops
    // rejecting the call with "Missing `check`".
    if (copy.type === "object" && copy.properties) {
      copy.required = Object.keys(copy.properties);
    }
    return copy;
  }
  return visit(root);
}

/** Synthesise a minimal valid contract when we have no LLM at all. */
function makeEmptyContract(goal) {
  return {
    version: TASK_CONTRACT_VERSION,
    user_intent: String(goal || "Atender la solicitud del usuario.").slice(0, 400),
    artifact_type: "text-answer",
    required_extension: null,
    mime_type: null,
    delivery_mode: "inline-chat",
    content_requirements: ["Responder a la solicitud del usuario de forma útil."],
    forbidden_outputs: ["No inventar datos ni fuentes."],
    ambiguity_level: "medium",
    clarifying_questions: [],
    success_tests: [
      {
        id: "non_empty_answer",
        type: "deterministic",
        description: "La respuesta inline no está vacía.",
        check: "contains_regex",
        parameters: "{\"pattern\":\"\\\\S\"}",
      },
    ],
  };
}

/**
 * Validate an externally-supplied contract against the schema.
 * Returns { ok, errors }.
 */
function validateContract(contract) {
  const validate = getValidator();
  const ok = validate(contract);
  return {
    ok: Boolean(ok),
    errors: ok ? [] : (validate.errors || []).map(e => ({ instancePath: e.instancePath, message: e.message, params: e.params })),
  };
}

module.exports = {
  resolveTaskContract,
  pickResolverRuntime,
  resolverRuntimeLadder,
  logResolverFailureOnce,
  RESOLVER_LOG_DEBOUNCE_MS,
  __resetResolverForTests,
  validateContract,
  makeEmptyContract,
  toStrictOpenAISchema,
  resolverResponseFormat,
  isResponseFormatRejection,
  FEW_SHOT_EXAMPLES,
  RESOLVER_SYSTEM_PROMPT,
};
