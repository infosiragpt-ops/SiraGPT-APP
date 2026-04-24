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

module.exports = {
  toolManifestSchema,
  BUILTIN_MANIFESTS,
  validateManifest,
  getManifest,
  listManifests,
};
