/**
 * tool-manifest — strict declaration schema for every tool the task
 * agent can call. A ToolManifest describes purpose, typed inputs,
 * typed outputs, allowed / forbidden output formats, expected
 * errors, acceptance tests, usage limits, positive/negative
 * examples, and recovery policy.
 *
 * The agent MUST use a declared tool for anything that has a
 * manifest; it is not allowed to produce a free-form substitute
 * (e.g. writing a file by printing base64 to stdout when
 * create_document exists).
 *
 * This file:
 *   - defines the JSON Schema of a manifest (ajv-validated)
 *   - registers the manifests for the 8 tools currently wired into
 *     the agent (python_exec, bash_exec, web_search, create_document,
 *     rag_retrieve, self_rag_answer, verify_artifact, run_tests)
 *
 * Future tools register via `registerToolManifest(m)` so the
 * catalogue stays discoverable via GET /api/agent/skills.
 */

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const toolManifestSchema = {
  $id: "https://siragpt.io/schemas/tool-manifest.v1.json",
  type: "object",
  title: "ToolManifest",
  additionalProperties: false,
  required: [
    "name",
    "purpose",
    "inputs",
    "outputs",
    "allowed_formats",
    "forbidden_formats",
    "expected_errors",
    "acceptance_tests",
    "usage_limits",
    "examples_positive",
    "examples_negative",
    "recovery_policy",
  ],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 60, pattern: "^[a-z][a-z0-9_]*$" },
    purpose: { type: "string", minLength: 10, maxLength: 400 },
    inputs: {
      type: "object",
      description: "JSON-Schema describing the parameters the tool accepts.",
      additionalProperties: true,
    },
    outputs: {
      type: "object",
      description: "JSON-Schema describing the payload the tool returns.",
      additionalProperties: true,
    },
    allowed_formats: {
      type: "array",
      items: { type: "string", maxLength: 40 },
      maxItems: 20,
      uniqueItems: true,
      description: "Extensions or MIME types this tool may produce. Empty when the tool doesn't write files.",
    },
    forbidden_formats: {
      type: "array",
      items: { type: "string", maxLength: 40 },
      maxItems: 20,
      uniqueItems: true,
      description: "Extensions the tool must NEVER produce (e.g. web_search must never write a .docx).",
    },
    expected_errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "description"],
        properties: {
          code: { type: "string", maxLength: 40 },
          description: { type: "string", maxLength: 200 },
          repair_hint: { type: "string", maxLength: 240 },
        },
      },
      maxItems: 20,
    },
    acceptance_tests: {
      type: "array",
      items: { type: "string", minLength: 5, maxLength: 240 },
      maxItems: 15,
      description: "What a successful call looks like (e.g. 'returns ok:true and a non-empty stdout').",
    },
    usage_limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeout_ms_default: { type: "integer", minimum: 100, maximum: 3600000 },
        timeout_ms_max: { type: "integer", minimum: 100, maximum: 3600000 },
        max_calls_per_task: { type: "integer", minimum: 1, maximum: 500 },
        requires_auth: { type: "boolean" },
        requires_network: { type: "boolean" },
      },
    },
    examples_positive: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["when", "call"],
        properties: {
          when: { type: "string", maxLength: 240 },
          call: { type: "object", additionalProperties: true },
        },
      },
      maxItems: 5,
    },
    examples_negative: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["when", "why"],
        properties: {
          when: { type: "string", maxLength: 240 },
          why: { type: "string", maxLength: 240 },
        },
      },
      maxItems: 5,
    },
    recovery_policy: {
      type: "object",
      additionalProperties: false,
      required: ["on_timeout", "on_error"],
      properties: {
        on_timeout: { type: "string", maxLength: 240 },
        on_error: { type: "string", maxLength: 240 },
        max_retries: { type: "integer", minimum: 0, maximum: 10 },
      },
    },
    // v1.1 — enterprise governance fields (all OPTIONAL, additive).
    side_effect_level: {
      type: "string",
      enum: ["none", "local-fs", "remote-read", "remote-write", "destructive"],
      description: "How the tool affects the outside world. Destructive tools trigger requires_confirmation by default.",
    },
    requires_confirmation: {
      type: "boolean",
      description: "True when the orchestrator must surface a HITL approval before calling this tool.",
    },
    sandbox_required: {
      type: "boolean",
      description: "True when the tool must run inside the code-sandbox (stripped env, timeouts, no real creds).",
    },
    audit_policy: {
      type: "string",
      enum: ["off", "sample", "every-call", "every-call-plus-args"],
      description: "How much of the invocation the audit-log captures.",
    },
    scopes: {
      type: "array",
      items: {
        type: "string",
        pattern: "^[a-z][a-z0-9_.:-]{1,64}$",
      },
      maxItems: 20,
      description: "OAuth-style scopes the caller must hold (e.g. 'rag.read', 'files.write', 'web.external').",
    },
    data_classes: {
      type: "array",
      items: {
        type: "string",
        enum: ["public", "internal", "confidential", "pii", "phi", "financial", "secret"],
      },
      maxItems: 8,
      description: "Data classes the tool can touch — enforced at dispatch against the session's clearance.",
    },
  },
};

// ─── Built-in manifests for the 8 wired tools ───────────────────────────

const BUILTIN_MANIFESTS = {
  python_exec: {
    name: "python_exec",
    purpose: "Run a short Python 3 snippet in an isolated sandbox (10 s default) and return stdout/stderr/exit code.",
    inputs: { type: "object", required: ["source"], properties: { source: { type: "string" }, timeoutMs: { type: "integer" }, stdin: { type: "string" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, stdout: { type: "string" }, stderr: { type: "string" }, exitCode: { type: "integer" } } },
    allowed_formats: [],
    forbidden_formats: ["docx", "xlsx", "pptx", "pdf", "svg"],
    expected_errors: [
      { code: "timeout", description: "Wall-clock budget exceeded.", repair_hint: "Increase timeoutMs up to 60000 or decompose the work." },
      { code: "import_error", description: "A Python module is not installed.", repair_hint: "Prefer stdlib or well-known deps (pandas, numpy, openpyxl)." },
    ],
    acceptance_tests: [
      "returns ok:true on a hello-world print",
      "returns ok:false and a stderr on a SyntaxError",
    ],
    usage_limits: { timeout_ms_default: 10000, timeout_ms_max: 60000, max_calls_per_task: 120, requires_auth: false, requires_network: false },
    examples_positive: [{ when: "quick data-wrangling with pandas", call: { source: "import pandas as pd\nprint(pd.DataFrame({'a':[1,2,3]}).sum())" } }],
    examples_negative: [{ when: "writing an xlsx directly", why: "use create_document — python_exec does not persist files as artifacts." }],
    recovery_policy: { on_timeout: "Return ok:false, timedOut:true. Agent should simplify or split the script.", on_error: "Surface stderr verbatim; no retry unless the error is transient.", max_retries: 0 },
  },
  bash_exec: {
    name: "bash_exec",
    purpose: "Run a short Node.js snippet in the sandbox for JSON shaping / simple computation.",
    inputs: { type: "object", required: ["source"], properties: { source: { type: "string" }, timeoutMs: { type: "integer" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, stdout: { type: "string" }, stderr: { type: "string" } } },
    allowed_formats: [],
    forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
    expected_errors: [{ code: "timeout", description: "Wall-clock budget exceeded." }],
    acceptance_tests: ["returns ok:true on `console.log('hi')`"],
    usage_limits: { timeout_ms_default: 8000, timeout_ms_max: 30000, max_calls_per_task: 60, requires_auth: false, requires_network: false },
    examples_positive: [{ when: "JSON shaping", call: { source: "console.log(JSON.stringify({a:1}))" } }],
    examples_negative: [{ when: "shelling out via child_process", why: "not supported; use python_exec with subprocess if you really need it." }],
    recovery_policy: { on_timeout: "Return ok:false, timedOut:true.", on_error: "Surface stderr.", max_retries: 0 },
  },
  web_search: {
    name: "web_search",
    purpose: "Multi-provider agentic academic search (Scopus + OpenAlex + SciELO + Semantic + Crossref + PubMed + DOAJ).",
    inputs: { type: "object", required: ["query"], properties: { query: { type: "string" }, topK: { type: "integer" }, target: { type: "integer" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, sources: { type: "array" }, stats: { type: "object" } } },
    allowed_formats: [],
    forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
    expected_errors: [{ code: "rate_limited", description: "Provider rate-limit hit." }],
    acceptance_tests: ["returns ≥ 1 source with title/doi/url for a well-formed query"],
    usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 10, requires_auth: true, requires_network: true },
    examples_positive: [{ when: "user asks for academic citations", call: { query: "alfa de Cronbach psychometrics", topK: 15 } }],
    examples_negative: [{ when: "user wants Wikipedia-style facts only", why: "prefer rag_retrieve over scholarly search." }],
    recovery_policy: { on_timeout: "Return ok:false with partial sources if any.", on_error: "Skip failing providers; continue with the rest.", max_retries: 1 },
  },
  create_document: {
    name: "create_document",
    purpose: "Write a downloadable file via a Python script that saves to os.environ[\"OUT_PATH\"]. Runs the TaskContract ArtifactReviewer before returning.",
    inputs: { type: "object", required: ["filename", "python"], properties: { filename: { type: "string" }, python: { type: "string" }, description: { type: "string" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, filename: { type: "string" }, downloadUrl: { type: "string" }, contractReview: { type: "object" } } },
    allowed_formats: ["svg", "docx", "xlsx", "pptx", "pdf", "csv", "md", "txt", "json", "html"],
    forbidden_formats: [],
    expected_errors: [
      { code: "missing_out_path", description: "Script did not write os.environ['OUT_PATH']." },
      { code: "contract_review_failed", description: "Artifact didn't match TaskContract.success_tests.", repair_hint: "Regenerate the file with a corrected script based on contractReview.failedTests." },
    ],
    acceptance_tests: ["returns ok:true with contractReview.passed === true"],
    usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 60000, max_calls_per_task: 8, requires_auth: true, requires_network: false },
    examples_positive: [{ when: "user asks for an Excel", call: { filename: "report.xlsx", python: "import openpyxl,os\nwb=openpyxl.Workbook()\nwb.active.append(['A','B'])\nwb.save(os.environ['OUT_PATH'])" } }],
    examples_negative: [{ when: "the user wants a chat answer", why: "use finalize with markdown instead — do not manufacture files the contract did not request." }],
    recovery_policy: { on_timeout: "Return ok:false, timedOut:true.", on_error: "Surface stderr + repairHint. Agent MUST repair before finalize.", max_retries: 3 },
  },
  rag_retrieve: {
    name: "rag_retrieve",
    purpose: "Return raw chunks from the user's RAG collection.",
    inputs: { type: "object", required: ["query"], properties: { query: { type: "string" }, k: { type: "integer" }, collection: { type: "string" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, hits: { type: "array" } } },
    allowed_formats: [],
    forbidden_formats: [],
    expected_errors: [{ code: "not_authenticated", description: "ctx.userId missing." }],
    acceptance_tests: ["returns ok:true and hits array (possibly empty) for a logged-in user"],
    usage_limits: { timeout_ms_default: 12000, timeout_ms_max: 30000, max_calls_per_task: 15, requires_auth: true, requires_network: true },
    examples_positive: [{ when: "the agent needs raw chunks to mix with web data", call: { query: "chapter on Cronbach alpha", k: 6 } }],
    examples_negative: [{ when: "user asks for a concrete grounded answer", why: "use self_rag_answer so the critic loop runs." }],
    recovery_policy: { on_timeout: "Return empty hits.", on_error: "Surface the error.", max_retries: 1 },
  },
  self_rag_answer: {
    name: "self_rag_answer",
    purpose: "Grounded answer using Self-RAG reflection tokens ISREL/ISSUP/ISUSE (ICLR 2024).",
    inputs: { type: "object", required: ["question"], properties: { question: { type: "string" }, k: { type: "integer" }, maxSegments: { type: "integer" }, retrieveMode: { type: "string", enum: ["adaptive", "always", "never"] }, hardConstraints: { type: "boolean" }, beamSize: { type: "integer" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, answer: { type: "string" }, segments: { type: "array" }, summary: { type: "string" } } },
    allowed_formats: [],
    forbidden_formats: [],
    expected_errors: [{ code: "empty_retrieval", description: "No passages matched the question." }],
    acceptance_tests: ["returns ok:true with at least one supported segment for an answerable question"],
    usage_limits: { timeout_ms_default: 60000, timeout_ms_max: 180000, max_calls_per_task: 10, requires_auth: true, requires_network: true },
    examples_positive: [{ when: "user asks a factual question against uploaded docs", call: { question: "¿cuál es la tasa de éxito reportada?", retrieveMode: "always" } }],
    examples_negative: [{ when: "user just wants raw text chunks", why: "use rag_retrieve instead." }],
    recovery_policy: { on_timeout: "Return ok:false with what segments we have.", on_error: "Surface stderr; do not fabricate citations.", max_retries: 0 },
  },
  verify_artifact: {
    name: "verify_artifact",
    purpose: "Re-read a previously-produced artifact and return a structured summary (sheet counts, paragraph counts, etc.).",
    inputs: { type: "object", required: ["artifactId"], properties: { artifactId: { type: "string" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, sizeBytes: { type: "integer" } } },
    allowed_formats: [],
    forbidden_formats: [],
    expected_errors: [{ code: "artifact_not_found", description: "No artifact matched the given id." }],
    acceptance_tests: ["returns ok:true with sizeBytes > 0"],
    usage_limits: { timeout_ms_default: 12000, timeout_ms_max: 30000, max_calls_per_task: 10, requires_auth: true, requires_network: false },
    examples_positive: [{ when: "after create_document on xlsx", call: { artifactId: "abc123" } }],
    examples_negative: [{ when: "verifying an artifact that was not created in this task", why: "the artifact owner check will reject it." }],
    recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface stderr.", max_retries: 0 },
  },
  run_tests: {
    name: "run_tests",
    purpose: "Execute unit tests against a generated source snippet (python or node); returns passed/failed counts + per-failure detail.",
    inputs: { type: "object", required: ["language", "source", "testSource"], properties: { language: { type: "string" }, source: { type: "string" }, testSource: { type: "string" }, timeoutMs: { type: "integer" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, passed: { type: "integer" }, failed: { type: "integer" }, failures: { type: "array" } } },
    allowed_formats: [],
    forbidden_formats: [],
    expected_errors: [{ code: "unsupported_language", description: "Only python / javascript / node supported." }],
    acceptance_tests: ["passes 1 of 1 _check that evaluates to true"],
    usage_limits: { timeout_ms_default: 10000, timeout_ms_max: 60000, max_calls_per_task: 30, requires_auth: false, requires_network: false },
    examples_positive: [{ when: "after code generation", call: { language: "python", source: "def add(a,b): return a+b", testSource: "_check('1+1', add(1,1)==2)" } }],
    examples_negative: [{ when: "trying to run a long benchmark", why: "exceed max timeout; split into smaller chunks." }],
    recovery_policy: { on_timeout: "Return ok:false with what was printed.", on_error: "Surface stderr.", max_retries: 0 },
  },
};

let ajvValidator = null;
function getValidator() {
  if (ajvValidator) return ajvValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  ajvValidator = ajv.compile(toolManifestSchema);
  return ajvValidator;
}

function validateManifest(manifest) {
  const validate = getValidator();
  const ok = validate(manifest);
  return { ok: Boolean(ok), errors: ok ? [] : (validate.errors || []) };
}

function getManifest(name) {
  return BUILTIN_MANIFESTS[name] || null;
}

function listManifests() {
  return Object.values(BUILTIN_MANIFESTS).map(m => ({
    name: m.name,
    purpose: m.purpose,
    allowed_formats: m.allowed_formats,
    forbidden_formats: m.forbidden_formats,
    usage_limits: m.usage_limits,
  }));
}

/**
 * Register a tool manifest at runtime. The file's docstring promises
 * this hook so plugins / experimental tools can join the catalogue
 * without editing this file. Validates the manifest against the
 * schema first; rejects on duplicate name unless `overwrite: true`.
 */
function registerToolManifest(manifest, { overwrite = false } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('registerToolManifest: manifest must be an object');
  }
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`registerToolManifest: invalid manifest — ${detail}`);
  }
  if (BUILTIN_MANIFESTS[manifest.name] && !overwrite) {
    throw new Error(`registerToolManifest: duplicate manifest name '${manifest.name}' (pass overwrite:true to replace)`);
  }
  BUILTIN_MANIFESTS[manifest.name] = manifest;
  return manifest;
}

function unregisterToolManifest(name) {
  if (!BUILTIN_MANIFESTS[name]) return false;
  delete BUILTIN_MANIFESTS[name];
  return true;
}

/**
 * Aggregate registry stats — counts by side_effect_level, by
 * audit_policy, and total scopes/data_classes the agent could
 * conceivably touch. Useful for the /api/agent/skills endpoint
 * and for dashboards that want a "what can this agent do" view.
 */
function getRegistryStats() {
  const stats = {
    totalTools: 0,
    bySideEffect: {},
    byAuditPolicy: {},
    requiresAuth: 0,
    requiresNetwork: 0,
    sandboxRequired: 0,
    requiresConfirmation: 0,
    uniqueScopes: new Set(),
    uniqueDataClasses: new Set(),
  };
  for (const manifest of Object.values(BUILTIN_MANIFESTS)) {
    stats.totalTools++;
    const effect = manifest.side_effect_level || 'unspecified';
    stats.bySideEffect[effect] = (stats.bySideEffect[effect] || 0) + 1;
    const audit = manifest.audit_policy || 'unspecified';
    stats.byAuditPolicy[audit] = (stats.byAuditPolicy[audit] || 0) + 1;
    if (manifest.usage_limits?.requires_auth) stats.requiresAuth++;
    if (manifest.usage_limits?.requires_network) stats.requiresNetwork++;
    if (manifest.sandbox_required) stats.sandboxRequired++;
    if (manifest.requires_confirmation) stats.requiresConfirmation++;
    for (const scope of manifest.scopes || []) stats.uniqueScopes.add(scope);
    for (const cls of manifest.data_classes || []) stats.uniqueDataClasses.add(cls);
  }
  return {
    ...stats,
    uniqueScopes: Array.from(stats.uniqueScopes).sort(),
    uniqueDataClasses: Array.from(stats.uniqueDataClasses).sort(),
  };
}

/**
 * Check whether one more call to `toolName` would exceed the
 * per-task max_calls_per_task budget. `usageMap` is a plain
 * { [toolName]: count } map the caller maintains across the task.
 * Returns { ok, current, max }. When the manifest has no limit,
 * always allows.
 */
function checkToolUsageBudget(toolName, usageMap = {}) {
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };
  const max = manifest.usage_limits?.max_calls_per_task;
  const current = Number(usageMap[toolName]) || 0;
  if (!Number.isFinite(max) || max <= 0) return { ok: true, current, max: null };
  if (current >= max) return { ok: false, reason: 'budget_exhausted', current, max };
  return { ok: true, current, max };
}

/**
 * Increment a tool's usage counter. Returns the new count plus a
 * flag indicating whether the budget is now exhausted. Pure helper —
 * mutates `usageMap` in place so callers can chain checks across a
 * task's lifetime without re-reading the manifest each call.
 */
function incrementToolUsage(toolName, usageMap = {}, n = 1) {
  if (!toolName || !usageMap) return { ok: false, reason: 'invalid_args' };
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };
  const max = manifest.usage_limits?.max_calls_per_task;
  const current = (Number(usageMap[toolName]) || 0) + Number(n || 0);
  usageMap[toolName] = current;
  if (Number.isFinite(max) && max > 0 && current >= max) {
    return { ok: true, current, max, exhausted: true };
  }
  return { ok: true, current, max: Number.isFinite(max) ? max : null, exhausted: false };
}

/**
 * How many calls remain in the per-task budget. Returns Infinity
 * when the manifest declares no limit. Used by the planner to pick
 * a tool that still has headroom over one that's nearly maxed.
 */
function getRemainingBudget(toolName, usageMap = {}) {
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };
  const max = manifest.usage_limits?.max_calls_per_task;
  const current = Number(usageMap[toolName]) || 0;
  if (!Number.isFinite(max) || max <= 0) {
    return { ok: true, current, max: null, remaining: Infinity };
  }
  return { ok: true, current, max, remaining: Math.max(0, max - current) };
}

/**
 * Enforce the manifest's `forbidden_formats` against the filename
 * a tool is about to produce. Catches the `web_search → docx`
 * class of bug at dispatch instead of after the artifact lands.
 */
function checkOutputFormat(toolName, filename) {
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (!ext) return { ok: true };
  const forbidden = Array.isArray(manifest.forbidden_formats) ? manifest.forbidden_formats : [];
  if (forbidden.includes(ext)) return { ok: false, reason: 'forbidden_format', extension: ext };
  const allowed = Array.isArray(manifest.allowed_formats) ? manifest.allowed_formats : [];
  if (allowed.length > 0 && !allowed.includes(ext)) {
    return { ok: false, reason: 'format_not_allowed', extension: ext, allowed };
  }
  return { ok: true };
}

/**
 * Validate a requested timeout against the manifest's
 * usage_limits.timeout_ms_max. Returns a clamped value the caller
 * should actually use, plus a flag indicating whether it was
 * adjusted. When the manifest declares no max, the request passes
 * through unchanged. Used by the dispatcher to keep callers from
 * exhausting the sandbox with a 10-minute python_exec.
 */
function checkTimeoutBudget(toolName, requestedMs) {
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };
  const max = manifest.usage_limits?.timeout_ms_max;
  const def = manifest.usage_limits?.timeout_ms_default;
  const requested = Number(requestedMs);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: true, effectiveMs: Number.isFinite(def) ? def : null, clamped: false };
  }
  if (Number.isFinite(max) && requested > max) {
    return { ok: false, reason: 'timeout_exceeds_max', requestedMs: requested, max, effectiveMs: max, clamped: true };
  }
  return { ok: true, effectiveMs: requested, clamped: false };
}

/**
 * List tools whose usage count has reached or exceeded their cap.
 * Used by the planner/dispatcher to surface a warning when the
 * agent is about to lock itself out of a tool family. Returns an
 * array of { name, current, max } sorted by saturation descending.
 */
function getToolsExceedingBudget(usageMap = {}) {
  const out = [];
  for (const [name, manifest] of Object.entries(BUILTIN_MANIFESTS)) {
    const max = manifest.usage_limits?.max_calls_per_task;
    if (!Number.isFinite(max) || max <= 0) continue;
    const current = Number(usageMap[name]) || 0;
    if (current >= max) out.push({ name, current, max, saturation: 1 });
  }
  return out;
}

/**
 * Per-tool usage breakdown: counts, caps, and percent consumed.
 * Returns an array sorted by saturation descending so the most
 * pressured tools surface first in dashboards.
 */
function summarizeUsage(usageMap = {}) {
  const rows = [];
  for (const [name, manifest] of Object.entries(BUILTIN_MANIFESTS)) {
    const current = Number(usageMap[name]) || 0;
    if (current === 0) continue;
    const max = manifest.usage_limits?.max_calls_per_task;
    const saturation = Number.isFinite(max) && max > 0 ? current / max : null;
    rows.push({ name, current, max: Number.isFinite(max) ? max : null, saturation });
  }
  rows.sort((a, b) => (b.saturation ?? -1) - (a.saturation ?? -1));
  return rows;
}

/**
 * Discovery helpers — return the names of manifests matching a
 * given attribute. Useful for the /api/agent/skills endpoint when
 * the UI wants to render "tools that need approval" or "tools that
 * touch confidential data" without re-implementing the filter.
 */
function findToolsByScope(scope) {
  return Object.values(BUILTIN_MANIFESTS)
    .filter((m) => Array.isArray(m.scopes) && m.scopes.includes(scope))
    .map((m) => m.name);
}

function findToolsByDataClass(cls) {
  return Object.values(BUILTIN_MANIFESTS)
    .filter((m) => Array.isArray(m.data_classes) && m.data_classes.includes(cls))
    .map((m) => m.name);
}

function findToolsBySideEffect(level) {
  return Object.values(BUILTIN_MANIFESTS)
    .filter((m) => m.side_effect_level === level)
    .map((m) => m.name);
}

function findToolsByOutputFormat(format) {
  const ext = String(format || '').toLowerCase();
  return Object.values(BUILTIN_MANIFESTS)
    .filter((m) => Array.isArray(m.allowed_formats) && m.allowed_formats.includes(ext))
    .map((m) => m.name);
}

/**
 * Authorize a tool call against the caller's clearance. Returns
 * { ok, reason? }. Reasons are stable strings so the caller can
 * branch on them. Missing fields default to "allow" so legacy
 * manifests don't break the agent.
 */
function authorizeToolCall(toolName, {
  scopes = [],
  dataClearance = ['public', 'internal', 'confidential', 'pii', 'phi', 'financial', 'secret'],
  approvalGranted = false,
} = {}) {
  const manifest = getManifest(toolName);
  if (!manifest) return { ok: false, reason: 'unknown_tool' };

  const requiredScopes = Array.isArray(manifest.scopes) ? manifest.scopes : [];
  const heldScopes = new Set(Array.isArray(scopes) ? scopes : []);
  const missingScopes = requiredScopes.filter((scope) => !heldScopes.has(scope));
  if (missingScopes.length) {
    return { ok: false, reason: 'missing_scopes', missingScopes };
  }

  const requiredClasses = Array.isArray(manifest.data_classes) ? manifest.data_classes : [];
  const allowedClasses = new Set(Array.isArray(dataClearance) ? dataClearance : []);
  const blockedClasses = requiredClasses.filter((cls) => !allowedClasses.has(cls));
  if (blockedClasses.length) {
    return { ok: false, reason: 'data_class_denied', blockedClasses };
  }

  if (manifest.requires_confirmation && !approvalGranted) {
    return { ok: false, reason: 'requires_confirmation' };
  }

  if (manifest.side_effect_level === 'destructive' && !approvalGranted) {
    return { ok: false, reason: 'destructive_requires_approval' };
  }

  return { ok: true };
}

// ─── Manifests for the 7 visual/media generation tools ──────────────────
// These tools are defined in visual-media-tools.js and wired into
// task-tools.js, but they need manifests for full discovery through
// the enterprise tool-registry and skill-system.

function getVisualMediaManifests() {
  return {
    generate_image: {
      name: "generate_image",
      purpose: "Generate an image from a text description using DALL-E or configured AI provider. Saves as downloadable PNG artifact.",
      inputs: {
        type: "object", required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          style: { type: "string", enum: ["realistic","vivid","natural","photographic","digital-art","anime","oil-painting","line-art"] },
          aspectRatio: { type: "string", enum: ["square","wide","portrait"] },
          quality: { type: "string", enum: ["standard","hd"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["png"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_result", description: "AI image service returned no content.", repair_hint: "Simplify the prompt or try a different style." },
        { code: "service_error", description: "AI image provider error." },
      ],
      acceptance_tests: ["returns ok:true with a non-empty downloadUrl for a simple prompt"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 10, requires_auth: true, requires_network: true },
      examples_positive: [{ when: "user asks for an illustration", call: { prompt: "A futuristic city at sunset with flying cars", style: "vivid", aspectRatio: "wide" } }],
      examples_negative: [{ when: "user wants a PDF document", why: "use create_document instead — generate_image only returns PNG." }],
      recovery_policy: { on_timeout: "Return ok:false. Agent may retry with a simpler prompt.", on_error: "Surface the error message. Do not fabricate an image.", max_retries: 1 },
      side_effect_level: "remote-read",
      scopes: ["ai.image"],
      data_classes: ["public"],
    },
    create_chart: {
      name: "create_chart",
      purpose: "Generate a data chart (bar, line, pie, scatter, histogram, area, radar, donut, bubble, horizontal_bar, funnel, gauge, waterfall) as an SVG file artifact.",
      inputs: {
        type: "object", required: ["chartType","title","labels","datasets"],
        properties: {
          chartType: { type: "string", enum: ["bar","line","pie","scatter","histogram","area","radar","donut","bubble","horizontal_bar","funnel","gauge","waterfall","heatmap","treemap"] },
          title: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          datasets: { type: "array", items: { type: "object" } },
          xLabel: { type: "string" }, yLabel: { type: "string" },
          stacked: { type: "boolean" },
          theme: { type: "string", enum: ["professional","vibrant","pastel","dark","minimal"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_data", description: "Datasets have no values.", repair_hint: "Provide at least one data point per series." },
        { code: "mismatched_labels", description: "Labels and data lengths don't match." },
      ],
      acceptance_tests: ["returns ok:true with a valid SVG when datasets have values"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 10, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a sales chart", call: { chartType: "bar", title: "Sales 2024", labels: ["Q1","Q2","Q3"], datasets: [{label:"Revenue", data:[120,180,240]}] } }],
      examples_negative: [{ when: "user wants to chart live API data", why: "first fetch the data with web_search or python_exec, then call create_chart." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Return ok:false with the error. Agent should retry with simpler data.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_organigram: {
      name: "create_organigram",
      purpose: "Generate an organizational chart from a nested JSON hierarchy as an SVG artifact.",
      inputs: {
        type: "object", required: ["title","structure"],
        properties: {
          title: { type: "string" },
          structure: { type: "object", description: "Nested JSON: { name, role, children: [...] }" },
          scheme: { type: "string", enum: ["professional","warm","cool","modern"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "invalid_structure", description: "Structure is not a valid nested object." },
        { code: "too_deep", description: "Org chart exceeds max depth." },
      ],
      acceptance_tests: ["returns ok:true for a simple 3-level hierarchy"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user needs a company org chart", call: { title: "Acme Corp", structure: { name:"CEO", role:"Chief Executive", children:[{name:"CTO",role:"Technology",children:[{name:"Dev Lead"}]}] } } }],
      examples_negative: [{ when: "user wants a flowchart", why: "use create_mermaid_diagram or create_chart instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error. Agent should simplify the structure.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_mermaid_diagram: {
      name: "create_mermaid_diagram",
      purpose: "Generate a diagram from Mermaid syntax (flowchart, sequence, class, state, ER, Gantt, pie, timeline, gitgraph, requirementDiagram). Returns SVG or self-contained HTML.",
      inputs: {
        type: "object", required: ["diagramType","definition"],
        properties: {
          diagramType: { type: "string", enum: ["flowchart","sequenceDiagram","classDiagram","stateDiagram","erDiagram","gantt","pie","timeline","gitgraph","requirementDiagram"] },
          title: { type: "string" },
          definition: { type: "string" },
          direction: { type: "string", enum: ["TB","BT","LR","RL"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["svg","html"],
      forbidden_formats: [],
      expected_errors: [
        { code: "invalid_syntax", description: "Mermaid syntax error." },
        { code: "render_failed", description: "Mermaid CLI or sandbox render failed." },
      ],
      acceptance_tests: ["returns ok:true for a valid flowchart definition"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 8, requires_auth: false, requires_network: true },
      examples_positive: [{ when: "user needs a flowchart", call: { diagramType: "flowchart", title: "Login Flow", definition: "A[Start] --> B{Is valid?}\nB -->|Yes| C[Login]\nB -->|No| D[Error]" } }],
      examples_negative: [{ when: "user wants a photo", why: "use generate_image — mermaid is for graph/flow diagrams only." }],
      recovery_policy: { on_timeout: "Fall back to HTML CDN rendering.", on_error: "Surface the Mermaid error; agent should fix syntax.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public"],
    },
    create_infographic_svg: {
      name: "create_infographic_svg",
      purpose: "Generate a professional SVG infographic from structured sections. Supports headings, paragraphs, bullet lists, progress bars, stats, and quote blocks.",
      inputs: {
        type: "object", required: ["title","sections"],
        properties: {
          title: { type: "string" },
          sections: { type: "array", items: { type: "object" }, description: "Array of section objects with type, heading, content fields." },
          theme: { type: "string", enum: ["professional","vibrant","minimal","dark"] },
          width: { type: "integer" },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "invalid_section", description: "A section is missing required fields." },
        { code: "overflow", description: "Content exceeds canvas size." },
      ],
      acceptance_tests: ["returns ok:true for a 3-section infographic"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a visual summary", call: { title: "Key Metrics 2024", sections: [{type:"stat",heading:"Revenue",content:"$2.4M"},{type:"list",heading:"Highlights",content:["Growth 40%","New markets"]}] } }],
      examples_negative: [{ when: "user wants raw data", why: "use create_chart for data visualizations or create_document for tables." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Return ok:false; agent should simplify content.", max_retries: 0 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public"],
    },
    create_dashboard_html: {
      name: "create_dashboard_html",
      purpose: "Generate an interactive HTML dashboard with Chart.js visualizations, sortable tables, and metric cards. Useful for real-time data monitoring and reporting.",
      inputs: {
        type: "object", required: ["title","metrics","charts"],
        properties: {
          title: { type: "string" },
          metrics: { type: "array", items: { type: "object" }, description: "Metric cards: { label, value, change?, icon? }" },
          charts: { type: "array", items: { type: "object" }, description: "Charts: { type, title, labels, datasets }" },
          theme: { type: "string", enum: ["light","dark","blue","green"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" } } },
      allowed_formats: ["html"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_metrics", description: "No metrics provided." },
        { code: "chart_render_error", description: "Chart data is malformed." },
      ],
      acceptance_tests: ["returns ok:true with valid HTML when metrics and charts are provided"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user needs a business dashboard", call: { title: "Sales Dashboard", metrics: [{label:"Revenue",value:"$1.2M",change:"+12%"}], charts: [{type:"bar",title:"Monthly",labels:["Jan","Feb"],datasets:[{label:"Sales",data:[200,300]}]}] } }],
      examples_negative: [{ when: "user wants a single number", why: "just answer in chat — dashboards are for multi-metric views." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Return ok:false with details.", max_retries: 0 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    generate_video: {
      name: "generate_video",
      purpose: "Generate a short video from a text description. If VIDEO_API_URL is configured, generates via API; otherwise produces a storyboard SVG with scene-by-scene breakdown.",
      inputs: {
        type: "object", required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          title: { type: "string" },
          style: { type: "string" },
          duration: { type: "integer", minimum: 2, maximum: 60, default: 10 },
          aspectRatio: { type: "string", enum: ["16:9","9:16","1:1","4:3"] },
        },
      },
      outputs: { type: "object", properties: {
        ok: { type: "boolean" },
        downloadUrl: { type: "string" },
        filename: { type: "string" },
        storyboard: { type: "boolean" },
        message: { type: "string" },
      } },
      allowed_formats: ["mp4","svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "no_api_configured", description: "VIDEO_API_URL not set.", repair_hint: "Generates storyboard instead." },
        { code: "api_error", description: "Video API returned an error." },
      ],
      acceptance_tests: ["returns ok:true producing a storyboard SVG when VIDEO_API_URL is not set"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 300000, max_calls_per_task: 3, requires_auth: true, requires_network: true },
      examples_positive: [{ when: "user wants a product demo video", call: { prompt: "Product walkthrough showing key features", title: "Demo", duration: 15, aspectRatio: "16:9" } }],
      examples_negative: [{ when: "user wants a real-time animation", why: "use create_dashboard_html or animate with CSS instead." }],
      recovery_policy: { on_timeout: "Return ok:false or generate storyboard if API unavailable.", on_error: "Surface the error; fall back to storyboard.", max_retries: 1 },
      side_effect_level: "remote-read",
      scopes: ["ai.video","files.write"],
      data_classes: ["public"],
    },
    create_timeline: {
      name: "create_timeline",
      purpose: "Generate a horizontal or vertical timeline of dated events as an SVG artifact. Use for project roadmaps, historical events, milestones, or any chronological sequence.",
      inputs: {
        type: "object", required: ["title","events"],
        properties: {
          title: { type: "string" },
          events: { type: "array", items: { type: "object" }, description: "Events: { date, title, description?, category?, color? }" },
          orientation: { type: "string", enum: ["horizontal","vertical"] },
          theme: { type: "string", enum: ["professional","modern","warm","cool","dark"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, events: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_events", description: "events array is empty.", repair_hint: "Provide at least one event with date and title." },
      ],
      acceptance_tests: ["returns ok:true for a 4-event horizontal timeline"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a project roadmap", call: { title: "Roadmap 2026", events: [{date:"Q1",title:"Beta"},{date:"Q2",title:"GA"}] } }],
      examples_negative: [{ when: "user wants a Gantt chart with dependencies", why: "use create_mermaid_diagram with diagramType:gantt instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error; agent should simplify events.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_kanban_board: {
      name: "create_kanban_board",
      purpose: "Generate a Kanban board with columns and cards as an SVG artifact. Use for sprint planning, task tracking, or any column-based workflow visualization.",
      inputs: {
        type: "object", required: ["title","columns"],
        properties: {
          title: { type: "string" },
          columns: { type: "array", items: { type: "object" }, description: "Columns: { name, color?, cards: [{title, description?, priority?, assignee?, tags?}] }" },
          theme: { type: "string", enum: ["light","dark","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, columns: { type: "integer" }, cards: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_columns", description: "columns array is empty.", repair_hint: "Provide at least one column." },
      ],
      acceptance_tests: ["returns ok:true for a 3-column board with cards"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a sprint board", call: { title: "Sprint 12", columns: [{name:"To Do",cards:[{title:"Design",priority:"high"}]},{name:"Done",cards:[]}] } }],
      examples_negative: [{ when: "user wants a Gantt timeline", why: "use create_timeline or create_mermaid_diagram with diagramType:gantt." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_comparison_table: {
      name: "create_comparison_table",
      purpose: "Generate a side-by-side comparison table as an SVG artifact with check/cross indicators, highlighted recommended column, and theme variants. Use for plan/feature/vendor comparisons.",
      inputs: {
        type: "object", required: ["title","columns","rows"],
        properties: {
          title: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "object" }, description: "Rows: { feature, values:[...], highlight? }. Boolean values render as ✓/✗." },
          highlightColumn: { type: "integer", minimum: 0 },
          theme: { type: "string", enum: ["professional","modern","minimal","dark"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, columns: { type: "integer" }, rows: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_columns", description: "columns array is empty.", repair_hint: "Provide at least one column header." },
        { code: "empty_rows", description: "rows array is empty.", repair_hint: "Provide at least one row." },
      ],
      acceptance_tests: ["returns ok:true for a 3-column × 4-row plan comparison"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants to compare pricing plans", call: { title: "Plans", columns: ["Free","Pro"], rows: [{feature:"API",values:[false,true]}], highlightColumn: 1 } }],
      examples_negative: [{ when: "user wants a freeform table inside a document", why: "use create_document with markdown table syntax." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_process_flow: {
      name: "create_process_flow",
      purpose: "Generate a step-by-step process flow as an SVG artifact. Numbered steps with arrows/chevrons/circles. Use for onboarding flows, customer journeys, or workflow documentation.",
      inputs: {
        type: "object", required: ["title","steps"],
        properties: {
          title: { type: "string" },
          steps: { type: "array", items: { type: "object" }, description: "Steps: { label, description?, icon?, color? }" },
          orientation: { type: "string", enum: ["horizontal","vertical"] },
          style: { type: "string", enum: ["arrows","chevrons","circles"] },
          theme: { type: "string", enum: ["professional","modern","warm","minimal"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, steps: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_steps", description: "steps array is empty.", repair_hint: "Provide at least one step with a label." },
      ],
      acceptance_tests: ["returns ok:true for a 4-step horizontal arrow flow"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants an onboarding flow", call: { title: "Onboarding", steps: [{label:"Sign Up"},{label:"Verify"},{label:"Activate"}], style: "arrows" } }],
      examples_negative: [{ when: "user wants a parallel/branching flow with conditions", why: "use create_mermaid_diagram with diagramType:flowchart instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_swot_analysis: {
      name: "create_swot_analysis",
      purpose: "Generate a SWOT analysis as a 2x2 SVG matrix (Strengths/Weaknesses internal, Opportunities/Threats external). Use for business strategy reviews, market positioning, product retrospectives, or competitive analyses.",
      inputs: {
        type: "object", required: ["title","strengths","weaknesses","opportunities","threats"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          strengths: { type: "array", items: { type: "string" }, description: "1-8 internal positive factors." },
          weaknesses: { type: "array", items: { type: "string" }, description: "1-8 internal negative factors." },
          opportunities: { type: "array", items: { type: "string" }, description: "1-8 external positive factors." },
          threats: { type: "array", items: { type: "string" }, description: "1-8 external negative factors." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_quadrants", description: "all four quadrants are empty.", repair_hint: "Provide at least one item in any of strengths/weaknesses/opportunities/threats." },
        { code: "invalid_input_types", description: "one of strengths/weaknesses/opportunities/threats is not an array.", repair_hint: "Pass arrays of strings for each quadrant." },
      ],
      acceptance_tests: ["returns ok:true for a SWOT with at least one item in any quadrant"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a SWOT for a product launch", call: { title: "Launch SWOT", strengths: ["Strong brand"], weaknesses: ["Limited inventory"], opportunities: ["New market segment"], threats: ["Competitor pricing"] } }],
      examples_negative: [{ when: "user wants a PESTEL or Porter's Five Forces analysis", why: "use create_infographic_svg with the appropriate section layout instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_bcg_matrix: {
      name: "create_bcg_matrix",
      purpose: "Generate a BCG (Boston Consulting Group) portfolio matrix SVG: Market Share × Market Growth with products plotted as bubbles (size = revenue) in 4 quadrants (Stars, Cash Cows, Question Marks, Dogs). Use for product portfolio reviews, investment allocation, strategic divestment analyses.",
      inputs: {
        type: "object", required: ["title","products"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          products: { type: "array", items: { type: "object" }, description: "1-20 products: { name, marketShare (0-2), marketGrowth (% per year), revenue? }." },
          growthThreshold: { type: "number", description: "Y-axis split between high/low growth. Default: 10." },
          shareThreshold: { type: "number", description: "X-axis split between high/low share. Default: 1.0." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, products: { type: "integer" }, tally: { type: "object" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_products", description: "products array is empty.", repair_hint: "Provide at least one product with name/marketShare/marketGrowth." },
      ],
      acceptance_tests: ["returns ok:true for a 4-product BCG with at least one in each quadrant"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a product portfolio review", call: { title: "Portfolio 2026", products: [{ name: "Pro tier", marketShare: 1.8, marketGrowth: 18, revenue: 5000000 }, { name: "Free tier", marketShare: 0.4, marketGrowth: 25, revenue: 200000 }] } }],
      examples_negative: [{ when: "user wants Ansoff growth-strategy categorisation", why: "use create_ansoff_matrix — BCG is portfolio classification by growth/share, Ansoff is strategic options by market/product novelty." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_ansoff_matrix: {
      name: "create_ansoff_matrix",
      purpose: "Generate an Ansoff growth-strategy matrix SVG (2x2 Market × Product) with 4 canonical strategies: Market Penetration (low risk), Market Development (medium risk), Product Development (medium risk), Diversification (high risk). Use for growth-strategy reviews, expansion planning, risk-balanced portfolio sweeps.",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          marketPenetration:  { type: "array", items: { type: "string" }, description: "1-8 existing-product × existing-market initiatives." },
          marketDevelopment:  { type: "array", items: { type: "string" }, description: "1-8 existing-product × new-market initiatives." },
          productDevelopment: { type: "array", items: { type: "string" }, description: "1-8 new-product × existing-market initiatives." },
          diversification:    { type: "array", items: { type: "string" }, description: "1-8 new-product × new-market initiatives." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_ansoff", description: "all 4 strategies are empty.", repair_hint: "Provide at least one initiative in any of MP/MD/PD/DV." },
        { code: "invalid_input_types", description: "one strategy input is not an array.", repair_hint: "Pass arrays of strings for each strategy." },
      ],
      acceptance_tests: ["returns ok:true for an Ansoff with at least one initiative across any quadrant"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a growth strategy review", call: { title: "Growth 2027", marketPenetration: ["Upsell Pro tier"], marketDevelopment: ["Expand to Brasil"], productDevelopment: ["AI generative video"], diversification: ["Launch enterprise GovCloud"] } }],
      examples_negative: [{ when: "user wants a SWOT-style strengths/weaknesses snapshot", why: "use create_swot_analysis — Ansoff is for growth strategies, not strengths analysis." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_balanced_scorecard: {
      name: "create_balanced_scorecard",
      purpose: "Generate Kaplan-Norton's Balanced Scorecard SVG with 4 horizontal perspective bands (Financial / Customer / Internal Process / Learning & Growth) showing strategic objectives with optional measure/target/current/status. Includes a left-side cause-effect arrow indicating value cascade. Use for strategy-execution dashboards and performance management.",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          financial:       { type: "array", items: { type: "object" }, description: "1-6 objectives: { objective, measure?, target?, current?, status? }." },
          customer:        { type: "array", items: { type: "object" } },
          internalProcess: { type: "array", items: { type: "object" } },
          learningGrowth:  { type: "array", items: { type: "object" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_scorecard", description: "all 4 perspectives are empty.", repair_hint: "Provide at least one objective in any perspective." },
        { code: "invalid_input_types", description: "one perspective input is not an array.", repair_hint: "Pass arrays of objective objects for each perspective." },
      ],
      acceptance_tests: ["returns ok:true for a BSC with objectives across any perspective"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a BSC for a SaaS company", call: { title: "Q2 BSC", financial: [{ objective: "Grow MRR", measure: "MRR USD", target: 100, current: 70, status: "on_track" }], customer: [{ objective: "Improve NPS", target: 50, current: 38, status: "at_risk" }] } }],
      examples_negative: [{ when: "user wants only quarterly progress on Objectives & Key Results", why: "use create_okr_dashboard — BSC categorises objectives by 4 strategic perspectives, OKR is execution-only." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_lean_canvas: {
      name: "create_lean_canvas",
      purpose: "Generate Ash Maurya's Lean Canvas as an SVG: 9 startup-focused blocks (Problem, Customer Segments, UVP, Solution, Unfair Advantage, Channels, Revenue Streams, Cost Structure, Key Metrics). Use for startup pitches, MVP planning, customer-discovery loops, or seed-stage business modeling. Complements create_business_model_canvas.",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          problem:                { type: "array", items: { type: "string" } },
          customerSegments:       { type: "array", items: { type: "string" } },
          uniqueValueProposition: { type: "array", items: { type: "string" } },
          solution:               { type: "array", items: { type: "string" } },
          unfairAdvantage:        { type: "array", items: { type: "string" } },
          channels:               { type: "array", items: { type: "string" } },
          revenueStreams:         { type: "array", items: { type: "string" } },
          costStructure:          { type: "array", items: { type: "string" } },
          keyMetrics:             { type: "array", items: { type: "string" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_canvas", description: "all 9 blocks are empty.", repair_hint: "Provide at least one item in any of the 9 blocks." },
        { code: "invalid_input_types", description: "one of the 9 block inputs is not an array.", repair_hint: "Pass arrays of strings for each block." },
      ],
      acceptance_tests: ["returns ok:true for a Lean Canvas with items across any of the 9 blocks"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a Lean Canvas for an early-stage startup", call: { title: "SiraGPT Lean Canvas", problem: ["LLM en español caro"], customerSegments: ["PYMES LATAM"], uniqueValueProposition: ["AI español-first"], solution: ["Pipeline determinístico"] } }],
      examples_negative: [{ when: "user wants the canonical BMC", why: "use create_business_model_canvas — Lean Canvas is startup-flavored (Problem/UVP/UnfairAdvantage); BMC is generic." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_empathy_map: {
      name: "create_empathy_map",
      purpose: "Generate an Empathy Map SVG with a persona at the centre, 4 canonical quadrants (Says/Thinks/Does/Feels), and optional Pains/Gains strips. Use for design thinking workshops, persona research, UX kickoffs, product discovery. Distinct from create_user_journey_map (sequential) and create_value_proposition_canvas (product-focused).",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          persona: { type: "string" },
          says: { type: "array", items: { type: "string" } },
          thinks: { type: "array", items: { type: "string" } },
          does: { type: "array", items: { type: "string" } },
          feels: { type: "array", items: { type: "string" } },
          pains: { type: "array", items: { type: "string" } },
          gains: { type: "array", items: { type: "string" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, persona: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_empathy_map", description: "all quadrants are empty.", repair_hint: "Provide at least one item in any of says/thinks/does/feels/pains/gains." },
        { code: "invalid_input_types", description: "one of the quadrant inputs is not an array.", repair_hint: "Pass arrays of strings for each quadrant." },
      ],
      acceptance_tests: ["returns ok:true for a 4-quadrant empathy map with persona"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants an empathy map for an SMB power user", call: { title: "SMB power user", persona: "Carla, COO", says: ["¿Funciona en español?"], thinks: ["¿Vale el costo?"], does: ["Compara 3 vendors"], feels: ["Cauta"] } }],
      examples_negative: [{ when: "user wants a sequential customer flow with stages", why: "use create_user_journey_map — empathy maps are persona snapshots, not journeys." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_okr_dashboard: {
      name: "create_okr_dashboard",
      purpose: "Generate an OKR (Objectives & Key Results) dashboard SVG with N objective cards each containing 1-5 key results with progress bars and red/amber/green status. Use for quarterly OKR reviews, team status reports, strategy-execution dashboards.",
      inputs: {
        type: "object", required: ["title","objectives"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          objectives: { type: "array", items: { type: "object" }, description: "1-6 objectives: { title, owner?, keyResults: [{ label, current, target, unit? }] }." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, objectives: { type: "integer" }, overallPct: { type: "number" }, tally: { type: "object" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_objectives", description: "objectives array is empty.", repair_hint: "Provide at least one objective with its key results." },
      ],
      acceptance_tests: ["returns ok:true for a 3-objective Q2 OKR dashboard with 3-5 KRs each"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a Q2 OKR review", call: { title: "Q2 OKRs", objectives: [{ title: "Grow LATAM MRR", keyResults: [{ label: "MRR LATAM", current: 22, target: 50, unit: "K$" }] }] } }],
      examples_negative: [{ when: "user wants a KPI dashboard without targets", why: "use create_dashboard_html — OKR requires explicit current/target pairs for progress." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_user_journey_map: {
      name: "create_user_journey_map",
      purpose: "Generate a customer / user journey map SVG with N stage columns × 5 standard lanes (Touchpoints, Actions, Thoughts, Pain Points, Opportunities) plus an emotion curve plotted on top. Use for UX research, customer-experience reviews, onboarding redesigns, service blueprints.",
      inputs: {
        type: "object", required: ["title","stages"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          stages: { type: "array", items: { type: "object" }, description: "2-8 ordered stages: { name, touchpoints?, actions?, thoughts?, painPoints?, opportunities?, emotion?: 1..5 }." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, stages: { type: "integer" }, lanes: { type: "integer" }, avgEmotion: { type: "number" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_stages", description: "stages array is empty.", repair_hint: "Provide at least 2 stages with a name." },
        { code: "too_few_stages", description: "journey map requires at least 2 stages.", repair_hint: "Add at least one more stage." },
      ],
      acceptance_tests: ["returns ok:true for a 4-stage onboarding journey"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants an onboarding journey map", call: { title: "Onboarding journey", stages: [{ name: "Awareness", emotion: 3, touchpoints: ["ads"], actions: ["search"] }, { name: "Activation", emotion: 4, actions: ["sign up"] }] } }],
      examples_negative: [{ when: "user wants a process flow / step-by-step diagram", why: "use create_process_flow — journey maps bring emotional context per stage, not just steps." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_radar_chart: {
      name: "create_radar_chart",
      purpose: "Generate a radar (spider) chart SVG with 3-8 axes radiating from a centre, 1-4 semi-transparent polygon series, axis labels, and grid rings. Use for vendor benchmarking, skill matrices, performance reviews, feature scorecards. Different from chartType:radar — this is a dedicated radar with multi-series support and custom grid rings.",
      inputs: {
        type: "object", required: ["title","axes","series"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          axes: { type: "array", items: { type: "string" }, description: "3-8 axis labels." },
          series: { type: "array", items: { type: "object" }, description: "1-4 series: { name, values: [one per axis], color? }." },
          max: { type: "number", description: "Scale max. Auto-detected from data when omitted." },
          rings: { type: "integer", minimum: 2, maximum: 8, description: "Number of concentric grid rings. Default: 5." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, axes: { type: "integer" }, series: { type: "integer" }, max: { type: "number" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "too_few_axes", description: "radar requires at least 3 axes.", repair_hint: "Add more axis labels — under 3, a polygon collapses." },
        { code: "too_many_axes", description: "radar supports at most 8 axes.", repair_hint: "Reduce to 8 — beyond that, labels overlap and readability drops." },
        { code: "empty_series", description: "series array is empty.", repair_hint: "Provide at least one series." },
      ],
      acceptance_tests: ["returns ok:true for a 5-axis radar with 2 series"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a vendor benchmark on 5 dimensions", call: { title: "Vendors", axes: ["Price","Docs","API","Support","Uptime"], series: [{ name: "Vendor A", values: [4,5,4,3,5] }, { name: "Vendor B", values: [5,3,4,4,4] }] } }],
      examples_negative: [{ when: "user wants a time-series view", why: "use create_chart with chartType:line — radar is for fixed-dimension comparisons, not time-evolving data." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_pestel_analysis: {
      name: "create_pestel_analysis",
      purpose: "Generate a PESTEL macro-environmental analysis SVG (Political/Economic/Social/Technological/Environmental/Legal) in a 3×2 grid. Use for strategic external scans, market-entry studies, regulatory landscape reviews. Complements create_swot_analysis (internal) and create_porters_five_forces (industry).",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          political:      { type: "array", items: { type: "string" } },
          economic:       { type: "array", items: { type: "string" } },
          social:         { type: "array", items: { type: "string" } },
          technological:  { type: "array", items: { type: "string" } },
          environmental:  { type: "array", items: { type: "string" } },
          legal:          { type: "array", items: { type: "string" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_pestel", description: "all 6 sections are empty.", repair_hint: "Provide at least one factor in any of the 6 sections." },
        { code: "invalid_input_types", description: "one of the 6 section inputs is not an array.", repair_hint: "Pass arrays of strings for each section." },
      ],
      acceptance_tests: ["returns ok:true for a PESTEL with at least one factor in any section"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a PESTEL for LATAM AI market", call: { title: "LATAM AI PESTEL", political: ["Data protection laws"], economic: ["USD volatility"], technological: ["LLM adoption growth"] } }],
      examples_negative: [{ when: "user wants an industry-rivalry view", why: "use create_porters_five_forces for industry structure; PESTEL is macro-environmental, not industry-structural." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_value_proposition_canvas: {
      name: "create_value_proposition_canvas",
      purpose: "Generate Strategyzer's Value Proposition Canvas as an SVG: Customer Profile (Customer Jobs / Pains / Gains) on the left + Value Map (Products & Services / Pain Relievers / Gain Creators) on the right. Use for product-market-fit work, persona-to-product mapping, value design. Complements create_business_model_canvas.",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          customerJobs:     { type: "array", items: { type: "string" } },
          pains:            { type: "array", items: { type: "string" } },
          gains:            { type: "array", items: { type: "string" } },
          productsServices: { type: "array", items: { type: "string" } },
          painRelievers:    { type: "array", items: { type: "string" } },
          gainCreators:     { type: "array", items: { type: "string" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_canvas", description: "all 6 sections are empty.", repair_hint: "Provide at least one item in any section." },
        { code: "invalid_input_types", description: "one section input is not an array.", repair_hint: "Pass arrays of strings for each section." },
      ],
      acceptance_tests: ["returns ok:true for a VPC with at least one item across any of the 6 sections"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a VPC for a SaaS product", call: { title: "SiraGPT VPC", customerJobs: ["Analizar documentos rápido"], pains: ["Costo OpenAI"], gains: ["Insights en español"], productsServices: ["Chat AI"], painRelievers: ["Cache local"], gainCreators: ["Análisis de documentos pro"] } }],
      examples_negative: [{ when: "user wants the full Business Model Canvas", why: "use create_business_model_canvas — VPC zooms into product-customer fit, BMC is the whole model." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_funnel_diagram: {
      name: "create_funnel_diagram",
      purpose: "Generate a conversion funnel SVG with vertical trapezoidal stages, per-stage counts, automatic conversion-from-previous %, and side drop-off indicators. Use for sales pipelines, marketing conversions, signup funnels, onboarding flows. Different from chartType:funnel (a generic chart) — this is a dedicated funnel with stage annotations.",
      inputs: {
        type: "object", required: ["title","stages"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          stages: { type: "array", items: { type: "object" }, description: "2-8 ordered stages: { label, value, description?, color? }." },
          showConversion: { type: "boolean", description: "Show per-stage conversion-from-previous %. Default: true." },
          showDropoff: { type: "boolean", description: "Show absolute drop-off arrows on the right. Default: true." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, stages: { type: "integer" }, topValue: { type: "number" }, endValue: { type: "number" }, totalConversionPct: { type: "number" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_stages", description: "stages array is empty.", repair_hint: "Provide at least 2 stages with a label and value each." },
        { code: "too_few_stages", description: "funnel requires at least 2 stages.", repair_hint: "Add at least one more stage." },
      ],
      acceptance_tests: ["returns ok:true for a 4-stage signup funnel with monotone descending values"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a Q2 signup funnel", call: { title: "Q2 Signup Funnel", stages: [{label:"Visitors",value:10000},{label:"Signed up",value:1200},{label:"Activated",value:520},{label:"Paying",value:96}] } }],
      examples_negative: [{ when: "user wants a generic horizontal/vertical bar chart", why: "use create_chart with chartType:bar — funnel implies monotone-descending conversion stages." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_risk_matrix: {
      name: "create_risk_matrix",
      purpose: "Generate a probability × impact risk matrix SVG (3×3, 4×4 or 5×5 heatmap) with risks plotted as labelled markers in the appropriate cell and a side legend with LOW/MEDIUM/HIGH/CRITICAL badges. Use for risk registers, project risk reviews, safety/compliance docs, or operational risk dashboards.",
      inputs: {
        type: "object", required: ["title","risks"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          size: { type: "integer", enum: [3, 4, 5], description: "Grid size N×N. Default: 5." },
          risks: { type: "array", items: { type: "object" }, description: "1-20 risks: { label, probability: 1..N, impact: 1..N, category? }." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, size: { type: "integer" }, risks: { type: "integer" }, tally: { type: "object" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_risks", description: "risks array is empty.", repair_hint: "Provide at least one risk with label/probability/impact." },
      ],
      acceptance_tests: ["returns ok:true for a 5x5 risk matrix with at least one plotted risk"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a project risk register", call: { title: "Q2 Risks", risks: [{ label: "Vendor delay", probability: 4, impact: 5, category: "operational" }, { label: "Regulatory change", probability: 2, impact: 5, category: "legal" }] } }],
      examples_negative: [{ when: "user wants an urgency × importance task triage", why: "use create_eisenhower_matrix — risk matrix is probability × impact, not urgency × importance." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_porters_five_forces: {
      name: "create_porters_five_forces",
      purpose: "Generate Porter's Five Forces industry-structure SVG: Industry Rivalry centre + Threat of New Entrants (top) + Threat of Substitutes (bottom) + Bargaining Power of Suppliers (left) + Bargaining Power of Buyers (right). Use for industry analysis, market positioning, competitive deep-dives, or strategic playbooks. Each force accepts 1-6 items and an optional intensity (low/medium/high).",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          rivalry:     { type: "object", description: "Industry Rivalry (centre). { items: [], intensity?: 'low'|'medium'|'high' }" },
          newEntrants: { type: "object", description: "Threat of New Entrants (top)." },
          substitutes: { type: "object", description: "Threat of Substitutes (bottom)." },
          suppliers:   { type: "object", description: "Bargaining Power of Suppliers (left)." },
          buyers:      { type: "object", description: "Bargaining Power of Buyers (right)." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_forces", description: "all five forces are empty.", repair_hint: "Provide at least one item under any of rivalry/newEntrants/substitutes/suppliers/buyers." },
      ],
      acceptance_tests: ["returns ok:true for a Five Forces analysis with at least one item across any force"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a Porter analysis of an industry", call: { title: "AI Chat industry", rivalry: { items: ["OpenAI","Anthropic"], intensity: "high" }, newEntrants: { items: ["Open-source LLM forks"], intensity: "medium" } } }],
      examples_negative: [{ when: "user wants a PESTEL macro-environmental scan", why: "use a PESTEL-specific tool or create_infographic_svg — Five Forces is industry-structural, not macro-environmental." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_pyramid_diagram: {
      name: "create_pyramid_diagram",
      purpose: "Generate a hierarchical pyramid SVG (2-8 stacked trapezoidal layers from apex to base, each labelled and optionally described). Use for Maslow needs, KPI cascades, Bloom learning levels, organizational tiers, or any hierarchical / foundational concept. Supports inverted orientation.",
      inputs: {
        type: "object", required: ["title","levels"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          levels: { type: "array", items: { type: "object" }, description: "2-8 levels (top→bottom): { label, description?, color? }." },
          inverted: { type: "boolean", description: "If true, widest layer at top (base up). Default: false." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, levels: { type: "integer" }, inverted: { type: "boolean" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_levels", description: "levels array is empty.", repair_hint: "Provide at least 2 levels with a label each." },
        { code: "too_few_levels", description: "pyramid requires at least 2 levels.", repair_hint: "Add at least one more level — single-layer pyramids don't communicate hierarchy." },
      ],
      acceptance_tests: ["returns ok:true for a 5-level Maslow-style pyramid"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a Maslow hierarchy of needs", call: { title: "Maslow", levels: [{label:"Self-actualization"},{label:"Esteem"},{label:"Belonging"},{label:"Safety"},{label:"Physiological"}] } }],
      examples_negative: [{ when: "user wants an organization chart (parent-child tree)", why: "use create_organigram — pyramid is for ordered hierarchies, not tree structures." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_business_model_canvas: {
      name: "create_business_model_canvas",
      purpose: "Generate Osterwalder's 9-block Business Model Canvas as an SVG (Key Partners, Key Activities, Key Resources, Value Propositions, Customer Relationships, Channels, Customer Segments, Cost Structure, Revenue Streams). Use for startup pitches, business model design, strategic reviews.",
      inputs: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          keyPartners:           { type: "array", items: { type: "string" } },
          keyActivities:         { type: "array", items: { type: "string" } },
          keyResources:          { type: "array", items: { type: "string" } },
          valuePropositions:     { type: "array", items: { type: "string" } },
          customerRelationships: { type: "array", items: { type: "string" } },
          channels:              { type: "array", items: { type: "string" } },
          customerSegments:      { type: "array", items: { type: "string" } },
          costStructure:         { type: "array", items: { type: "string" } },
          revenueStreams:        { type: "array", items: { type: "string" } },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_canvas", description: "all 9 blocks are empty.", repair_hint: "Provide at least one item in any of the 9 blocks." },
        { code: "invalid_input_types", description: "one of the 9 block inputs is not an array.", repair_hint: "Pass arrays of strings for each block." },
      ],
      acceptance_tests: ["returns ok:true for a BMC with at least one item across any of the 9 blocks"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a one-page BMC for a SaaS product", call: { title: "SaaS BMC", valuePropositions: ["AI-native chat","Doc analyzer"], customerSegments: ["LATAM SMBs"], revenueStreams: ["Pro subscription"] } }],
      examples_negative: [{ when: "user wants a SWOT-style strategic review", why: "use create_swot_analysis — BMC is about model structure, not strengths/threats." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_raci_matrix: {
      name: "create_raci_matrix",
      purpose: "Generate a RACI (Responsible/Accountable/Consulted/Informed) responsibility assignment matrix as an SVG with tasks as rows and roles/people as columns. Use for project governance, hand-off planning, role clarification, or any task-vs-stakeholder mapping.",
      inputs: {
        type: "object", required: ["title","roles","rows"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          roles: { type: "array", items: { type: "string" }, description: "2-8 role/person column headers." },
          rows: { type: "array", items: { type: "object" }, description: "1-20 rows: { task, assignments: ['R'|'A'|'C'|'I'|'', ...] (one per role, in order)." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, roles: { type: "integer" }, rows: { type: "integer" }, tally: { type: "object" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_roles", description: "roles array is empty.", repair_hint: "Provide at least one role column." },
        { code: "empty_rows", description: "rows array is empty.", repair_hint: "Provide at least one task row." },
      ],
      acceptance_tests: ["returns ok:true for a 3-role x 4-row RACI grid with at least one R+A pair"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants a deploy pipeline RACI", call: { title: "Deploy Pipeline", roles: ["DevOps","Eng","PM","Security"], rows: [{ task: "Approve release", assignments: ["I","C","A","C"] }, { task: "Run smoke tests", assignments: ["R","R","I",""] }] } }],
      examples_negative: [{ when: "user wants a priority/triage view of tasks", why: "use create_eisenhower_matrix for urgency x importance instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
    create_eisenhower_matrix: {
      name: "create_eisenhower_matrix",
      purpose: "Generate an Eisenhower urgency/importance matrix as a 2x2 SVG (Do / Schedule / Delegate / Eliminate). Use for task prioritization, sprint triage, executive decision queues, or any urgent-vs-important categorisation.",
      inputs: {
        type: "object", required: ["title","do","schedule","delegate","eliminate"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          do: { type: "array", items: { type: "string" }, description: "1-8 urgent AND important items." },
          schedule: { type: "array", items: { type: "string" }, description: "1-8 important but NOT urgent items." },
          delegate: { type: "array", items: { type: "string" }, description: "1-8 urgent but NOT important items." },
          eliminate: { type: "array", items: { type: "string" }, description: "1-8 neither urgent NOR important items." },
          theme: { type: "string", enum: ["professional","modern","minimal","corporate"] },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, downloadUrl: { type: "string" }, id: { type: "string" }, filename: { type: "string" }, counts: { type: "object" }, total: { type: "integer" } } },
      allowed_formats: ["svg"],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_quadrants", description: "all four quadrants are empty.", repair_hint: "Provide at least one item in any of do/schedule/delegate/eliminate." },
        { code: "invalid_input_types", description: "one of do/schedule/delegate/eliminate is not an array.", repair_hint: "Pass arrays of strings for each quadrant." },
      ],
      acceptance_tests: ["returns ok:true for an Eisenhower with at least one item in any quadrant"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 5, requires_auth: false, requires_network: false },
      examples_positive: [{ when: "user wants to triage a backlog by urgency × importance", call: { title: "Sprint 14 Triage", do: ["Fix prod incident"], schedule: ["Migrate auth"], delegate: ["Renew SSL cert"], eliminate: ["Refactor legacy reports"] } }],
      examples_negative: [{ when: "user wants a probability × impact risk matrix", why: "Eisenhower is urgency × importance; a heatmap chartType is better for probability × impact." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      scopes: ["files.write"],
      data_classes: ["public","internal"],
    },
  };
}

// ─── Manifests for the 4 Document Intelligence tools ────────────────────
// These tools (docintel_*) are wired in task-tools.js and need manifests
// for the enterprise registry / skill discovery surface.

function getDocIntelManifests() {
  return {
    docintel_analyze: {
      name: "docintel_analyze",
      purpose: "Analyze uploaded documents (PDF/DOCX/XLSX/PPTX/CSV/IMG): MIME-aware text extraction, OCR evidence, structural chunks, table detection, coverage scoring.",
      inputs: {
        type: "object",
        properties: {
          fileIds: { type: "array", items: { type: "string" }, description: "File ids. Defaults to current task attachments." },
          force: { type: "boolean", description: "Force fresh analysis even if cached." },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, analyses: { type: "array" } } },
      allowed_formats: [],
      forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
      expected_errors: [
        { code: "missing_auth", description: "Tool requires prisma + authenticated userId.", repair_hint: "Run inside an authenticated agent task." },
        { code: "file_not_found", description: "fileId does not belong to user." },
      ],
      acceptance_tests: ["returns ok:true with analyses[] when given a valid fileId for the user"],
      usage_limits: { timeout_ms_default: 60000, timeout_ms_max: 300000, max_calls_per_task: 10, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user uploads a PDF and asks 'analiza esto'", call: { fileIds: ["file-abc"] } }],
      examples_negative: [{ when: "user wants to compare two files", why: "use docintel_compare instead — analyze runs per-file." }],
      recovery_policy: { on_timeout: "Return ok:false; agent should retry with fewer files.", on_error: "Surface the error verbatim.", max_retries: 1 },
      side_effect_level: "local-fs",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read", "rag.write"],
      data_classes: ["internal", "confidential"],
    },
    docintel_retrieve: {
      name: "docintel_retrieve",
      purpose: "Retrieve grounded evidence chunks from analyzed documents with page/sheet/slide/section references. Use before answering factual questions about uploaded files.",
      inputs: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          fileIds: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, evidence: { type: "array" } } },
      allowed_formats: [],
      forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
      expected_errors: [
        { code: "missing_auth", description: "Requires prisma + authenticated userId." },
        { code: "no_analysis", description: "Document has not been analyzed yet.", repair_hint: "Call docintel_analyze first." },
      ],
      acceptance_tests: ["returns ok:true with evidence[] (possibly empty) for a valid user+query"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 20, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user asks a factual question about uploaded docs", call: { query: "tasa de éxito reportada", limit: 8 } }],
      examples_negative: [{ when: "user wants the full document", why: "this returns chunks; use docintel_analyze for full coverage." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read", "rag.read"],
      data_classes: ["internal", "confidential"],
    },
    docintel_extract_tables: {
      name: "docintel_extract_tables",
      purpose: "Return normalized tables detected in spreadsheets, CSV, Word/PDF markdown tables, and document extracts. Use for KPI / tabla / cálculo / dato queries.",
      inputs: {
        type: "object",
        properties: {
          fileIds: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, tables: { type: "array" } } },
      allowed_formats: [],
      forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
      expected_errors: [
        { code: "missing_auth", description: "Requires prisma + authenticated userId." },
        { code: "no_tables", description: "Document has no detectable tables." },
      ],
      acceptance_tests: ["returns ok:true with tables[] when documents contain spreadsheet/markdown tables"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 10, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user uploads xlsx and asks for KPIs", call: { fileIds: ["file-xlsx"], limit: 5 } }],
      examples_negative: [{ when: "user wants to render a chart", why: "use create_chart with the extracted data." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read"],
      data_classes: ["internal", "confidential"],
    },
    docintel_compare: {
      name: "docintel_compare",
      purpose: "Compare two or more uploaded documents using evidence, terms, counts, tables and warnings. Use when user asks comparar / diferencias / cambios / versiones / similitudes.",
      inputs: {
        type: "object",
        properties: {
          fileIds: { type: "array", items: { type: "string" }, description: "At least two file ids required." },
          query: { type: "string", description: "Optional comparison focus." },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, documents: { type: "array" }, comparisons: { type: "array" } } },
      allowed_formats: [],
      forbidden_formats: ["docx", "xlsx", "pptx", "pdf"],
      expected_errors: [
        { code: "missing_auth", description: "Requires prisma + authenticated userId." },
        { code: "insufficient_files", description: "Compare requires at least two file ids.", repair_hint: "Pass fileIds with length >= 2." },
      ],
      acceptance_tests: ["returns ok:true with documents[] and comparisons[] for two valid fileIds"],
      usage_limits: { timeout_ms_default: 60000, timeout_ms_max: 300000, max_calls_per_task: 5, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user uploads v1 and v2 of a contract", call: { fileIds: ["file-v1", "file-v2"], query: "cláusulas modificadas" } }],
      examples_negative: [{ when: "user asks about a single file", why: "use docintel_analyze or docintel_retrieve instead." }],
      recovery_policy: { on_timeout: "Return ok:false; agent should reduce limit.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "local-fs",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read", "rag.read"],
      data_classes: ["internal", "confidential"],
    },
  };
}

// Add visual media manifests to the built-in collection at startup
Object.assign(BUILTIN_MANIFESTS, getVisualMediaManifests());
Object.assign(BUILTIN_MANIFESTS, getDocIntelManifests());
Object.assign(BUILTIN_MANIFESTS, getCoworkManifests());

function getCoworkManifests() {
  return {
    deep_analyze: {
      name: "deep_analyze",
      purpose: "Deep professional document analysis: domain detection, entity extraction, risk assessment, quality scoring, structure mapping, auto-tagging.",
      inputs: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Document text to analyze." },
          fileName: { type: "string", description: "Filename hint." },
          mimeType: { type: "string", description: "MIME type hint." },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, domain: { type: "object" }, quality: { type: "object" }, risks: { type: "object" } } },
      allowed_formats: [],
      forbidden_formats: [],
      expected_errors: [
        { code: "empty_text", description: "text parameter is empty.", repair_hint: "Provide non-empty text." },
      ],
      acceptance_tests: ["returns ok:true with domain, quality, risks for any non-empty text"],
      usage_limits: { timeout_ms_default: 15000, timeout_ms_max: 60000, max_calls_per_task: 10, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user uploads a legal contract", call: { text: "Contrato de...", fileName: "contrato.pdf" } }],
      examples_negative: [{ when: "user wants basic text extraction", why: "use docintel_analyze for structural extraction." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "none",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read"],
      data_classes: ["internal", "confidential"],
    },
    auto_file: {
      name: "auto_file",
      purpose: "Auto-ingest pasted/dropped content as a virtual document with format detection, RAG indexing, and deep analysis.",
      inputs: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string", description: "Content to auto-file." },
          fileName: { type: "string", description: "Filename override." },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, autoFiled: { type: "boolean" }, fileId: { type: "string" } } },
      allowed_formats: [],
      forbidden_formats: [],
      expected_errors: [
        { code: "too_short", description: "Content below 200 chars.", repair_hint: "Provide longer content." },
      ],
      acceptance_tests: ["returns autoFiled:true for structured content >= 200 chars"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 15, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user pastes a JSON dataset", call: { content: '{"items":[1,2,3]}...' } }],
      examples_negative: [{ when: "user sends a short chat message", why: "short messages don't need auto-filing." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 0 },
      side_effect_level: "local-fs",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.write", "rag.write"],
      data_classes: ["internal"],
    },
    memory_recall: {
      name: "memory_recall",
      purpose: "Recall facts from active memory (long-term + short-term) by relevance query.",
      inputs: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, facts: { type: "array" } } },
      allowed_formats: [],
      forbidden_formats: [],
      expected_errors: [
        { code: "no_query", description: "query parameter is empty.", repair_hint: "Provide a search query." },
      ],
      acceptance_tests: ["returns ok:true with facts[] (possibly empty) for authenticated user"],
      usage_limits: { timeout_ms_default: 2000, timeout_ms_max: 10000, max_calls_per_task: 20, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "agent needs user preferences", call: { query: "programming language preference" } }],
      examples_negative: [{ when: "user asks about document content", why: "use rag_retrieve or docintel_retrieve instead." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 0 },
      side_effect_level: "none",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["memory.read"],
      data_classes: ["internal"],
    },
    compare_documents: {
      name: "compare_documents",
      purpose: "Compare 2+ documents for shared entities, contradictions, complementary insights, cross-references, alignment scoring.",
      inputs: {
        type: "object",
        required: ["documents"],
        properties: {
          documents: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, text: { type: "string" } } } },
          query: { type: "string", description: "Focus area for comparison." },
        },
      },
      outputs: { type: "object", properties: { ok: { type: "boolean" }, contradictions: { type: "array" }, alignmentScore: { type: "number" } } },
      allowed_formats: [],
      forbidden_formats: [],
      expected_errors: [
        { code: "too_few_docs", description: "Less than 2 documents provided.", repair_hint: "Provide at least 2 documents." },
      ],
      acceptance_tests: ["returns ok:true with comparison results for 2+ documents"],
      usage_limits: { timeout_ms_default: 30000, timeout_ms_max: 120000, max_calls_per_task: 5, requires_auth: true, requires_network: false },
      examples_positive: [{ when: "user asks to compare two contracts", call: { documents: [{ id: "a", text: "..." }, { id: "b", text: "..." }] } }],
      examples_negative: [{ when: "user asks about a single document", why: "use deep_analyze or docintel_analyze." }],
      recovery_policy: { on_timeout: "Return ok:false.", on_error: "Surface the error.", max_retries: 1 },
      side_effect_level: "none",
      sandbox_required: false,
      audit_policy: "every-call",
      scopes: ["files.read"],
      data_classes: ["internal", "confidential"],
    },
  };
}

/**
 * Validate every built-in manifest against the schema. Runs once
 * at module load and again on demand. The schema is strict, so a
 * typo in a built-in (e.g. an extra property) will surface here
 * instead of silently passing acceptance tests with an invalid
 * declaration. Returns { ok, invalid: [{ name, errors }...] }.
 */
function validateAllBuiltinManifests() {
  const invalid = [];
  for (const [name, manifest] of Object.entries(BUILTIN_MANIFESTS)) {
    const result = validateManifest(manifest);
    if (!result.ok) invalid.push({ name, errors: result.errors });
  }
  return { ok: invalid.length === 0, invalid };
}

if (process.env.SIRAGPT_VALIDATE_MANIFESTS_AT_LOAD === '1') {
  const result = validateAllBuiltinManifests();
  if (!result.ok) {
    const summary = result.invalid.map((e) => `${e.name}: ${e.errors.length} error(s)`).join(', ');
    // eslint-disable-next-line no-console
    console.warn(`[tool-manifest] built-in validation failed → ${summary}`);
  }
}

module.exports = {
  toolManifestSchema,
  BUILTIN_MANIFESTS,
  authorizeToolCall,
  checkOutputFormat,
  checkTimeoutBudget,
  checkToolUsageBudget,
  findToolsByDataClass,
  findToolsByOutputFormat,
  findToolsByScope,
  findToolsBySideEffect,
  getRegistryStats,
  getRemainingBudget,
  getToolsExceedingBudget,
  incrementToolUsage,
  summarizeUsage,
  validateAllBuiltinManifests,
  validateManifest,
  getManifest,
  listManifests,
  registerToolManifest,
  unregisterToolManifest,
};
