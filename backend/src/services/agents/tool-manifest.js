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
      description: "Extensions or MIME types this tool may produce. Empty when the tool doesn't write files.",
    },
    forbidden_formats: {
      type: "array",
      items: { type: "string", maxLength: 40 },
      maxItems: 20,
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
    allowed_formats: ["svg", "docx", "xlsx", "pptx", "pdf", "csv", "md", "txt", "json", "svg"],
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

module.exports = {
  toolManifestSchema,
  BUILTIN_MANIFESTS,
  authorizeToolCall,
  checkOutputFormat,
  checkToolUsageBudget,
  getRegistryStats,
  validateManifest,
  getManifest,
  listManifests,
  registerToolManifest,
  unregisterToolManifest,
};
