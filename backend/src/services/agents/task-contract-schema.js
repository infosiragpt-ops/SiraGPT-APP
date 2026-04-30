/**
 * task-contract-schema — the single source of truth for what a user
 * wants before the task agent is allowed to act. This is the
 * **UniversalTaskContract** schema: a closed-route, JSON-Schema-
 * validated descriptor that every request passes through before any
 * tool runs or any artifact is produced.
 *
 * The schema evolves additively:
 *   v1.0 — initial minimum viable contract (required_extension,
 *          mime_type, delivery_mode, content_requirements,
 *          forbidden_outputs, success_tests).
 *   v1.1 — cognitive-agentic expansion: raw_user_request,
 *          normalized_request, detected_language, primary_intent,
 *          secondary_intents, task_category, artifact_required,
 *          required_tools, forbidden_tools, source_requirements,
 *          grounding_required, citations_required, quality_bar,
 *          ambiguity_score, risk_level, execution_plan,
 *          validation_plan, self_repair_plan, final_delivery_rules,
 *          evidence_log. All new fields are OPTIONAL so legacy
 *          callers (ArtifactReviewer, createDocument) keep working.
 *
 * Why additive: the reviewer, tool bus, and UI read `success_tests`
 * and `required_extension`. Those stay untouched; the new fields
 * give the FormatSovereigntyEngine and PipelineRegistry the
 * metadata they need without forcing a downstream rewrite.
 *
 * Design notes:
 * - `additionalProperties: false` everywhere so the Structured-Output
 *   endpoint (OpenAI response_format=json_schema, strict: true) can
 *   enforce the shape and we get a real parse error on drift.
 * - All enums are closed — the router can return `"unknown"` when
 *   genuinely ambiguous, which pushes the agent to ask the user a
 *   clarifying question instead of guessing a format.
 * - `success_tests[].type` includes `deterministic` (checked by code
 *   without an LLM) and `semantic` (LLM grader, run last). The
 *   reviewer executes deterministic first and refuses to run the
 *   semantic pass if the deterministic ones fail.
 */

const ARTIFACT_TYPES = [
  "svg", "image", "document", "spreadsheet", "presentation",
  "pdf", "code", "text-answer", "data-search", "chart", "plan",
  "audio", "video", "none",
];

const EXTENSIONS = [
  "svg", "png", "jpg", "jpeg", "webp", "gif",
  "docx", "xlsx", "pptx", "pdf", "csv", "tsv",
  "json", "md", "txt", "html", "xml",
  "py", "js", "ts", "tsx", "jsx",
  "mp3", "wav", "mp4",
];

const MIME_TYPES = [
  "image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
  "text/csv", "text/plain", "text/markdown", "text/html",
  "application/json", "application/xml",
  "text/x-python", "application/javascript", "application/typescript",
  "audio/mpeg", "audio/wav", "video/mp4",
];

const DELIVERY_MODES = [
  "inline-chat",          // answer is rendered directly in the chat bubble
  "downloadable-file",    // one or more files attached as artifacts
  "both",                 // inline summary + downloadable file
  "streaming",            // long-form streaming response
  "external-action",      // side effect (email sent, calendar invite, WhatsApp)
];

const AMBIGUITY_LEVELS = ["low", "medium", "high"];

const TEST_TYPES = ["deterministic", "semantic"];

// v1.1 additions ─────────────────────────────────────────────────────────

const TASK_CATEGORIES = [
  "visual-artifact",             // svg, png, logo, infographic, diagram
  "document",                    // docx, Word, thesis, letter, chapter, APA
  "spreadsheet",                 // xlsx, CSV, database, article tables
  "presentation",                // pptx, slides, pitch deck
  "pdf",                         // pdf export as deliverable
  "code",                        // app, API, frontend, backend, script
  "research-grounding",          // real-source academic search (Scopus/OpenAlex/…)
  "rag-document-understanding",  // read my PDF/Word/Excel/PPT and answer
  "action-execution",            // email, calendar, browser, WhatsApp, Telegram
  "direct-answer",               // plain conversational reply
  "multi-intent",                // compound request with multiple deliverables
  "unknown",
];

const PRIMARY_INTENTS = [
  "create-artifact",
  "edit-artifact",
  "analyze-artifact",
  "research-sources",
  "answer-question",
  "execute-action",
  "automate-workflow",
  "translate",
  "summarize",
  "correct",
  "unknown",
];

const QUALITY_BAR = ["draft", "standard", "professional", "publication-ready"];

const RISK_LEVELS = ["low", "medium", "high", "critical"];

const GROUNDING_MODES = [
  "none",                    // freely generated
  "uploaded-files",          // must ground on user's RAG
  "web-academic",            // must ground on Scopus/OpenAlex/...
  "internal-knowledge",      // internal docs / previous chats
  "hybrid",                  // combine two of the above
];

const FORMAT_VIOLATION_POLICY = ["hard-block", "warn", "ignore"];

// ─── Schema ─────────────────────────────────────────────────────────────

const taskContractSchema = {
  $id: "https://siragpt.io/schemas/task-contract.v1_1.json",
  type: "object",
  title: "UniversalTaskContract",
  description: "Closed contract describing exactly what the agent must deliver for this user turn. v1.1 adds the cognitive-agentic routing fields on top of v1.0.",
  additionalProperties: false,
  required: [
    "version",
    "user_intent",
    "artifact_type",
    "required_extension",
    "mime_type",
    "delivery_mode",
    "content_requirements",
    "forbidden_outputs",
    "ambiguity_level",
    "success_tests",
  ],
  properties: {
    // ─── v1.0 fields (unchanged — never rename or retype) ──────────────
    version: {
      type: "string",
      enum: ["1.0", "1.1"],
      description: "Schema version. Bump on breaking change.",
    },
    user_intent: {
      type: "string",
      minLength: 3,
      maxLength: 400,
      description: "Concise one-line natural-language summary of what the user asked for, in the user's own language.",
    },
    artifact_type: {
      type: "string",
      enum: ARTIFACT_TYPES,
      description: "High-level kind of deliverable. Use `none` for pure chat answers with no file; use `text-answer` when the answer IS the deliverable.",
    },
    required_extension: {
      // anyOf (NOT oneOf) — OpenAI structured outputs reject oneOf at
      // any level. A null value cannot also be a string, so the two
      // schemas are mutually exclusive in practice and anyOf is the
      // semantically equivalent (and API-supported) choice.
      anyOf: [
        { type: "string", enum: EXTENSIONS },
        { type: "null" },
      ],
      description: "File extension the deliverable MUST use (without leading dot). Null when no file is expected.",
    },
    mime_type: {
      anyOf: [
        { type: "string", enum: MIME_TYPES },
        { type: "null" },
      ],
      description: "MIME type the deliverable MUST match. Null when no file is expected.",
    },
    delivery_mode: {
      type: "string",
      enum: DELIVERY_MODES,
      description: "How the answer should reach the user.",
    },
    content_requirements: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 240 },
      maxItems: 20,
      description: "Invariants the deliverable MUST satisfy (e.g. 'contains ≥ 30 rows', 'includes APA-7 references', 'draws a visible house with roof').",
    },
    forbidden_outputs: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 240 },
      maxItems: 20,
      description: "What the deliverable MUST NOT be or contain (e.g. '.docx when user asked for SVG', 'fabricated DOIs', 'lorem ipsum').",
    },
    ambiguity_level: {
      type: "string",
      enum: AMBIGUITY_LEVELS,
      description: "How unclear the user's ask is. `high` means the agent should ask a clarifying question before acting.",
    },
    clarifying_questions: {
      type: "array",
      items: { type: "string", minLength: 5, maxLength: 240 },
      maxItems: 5,
      default: [],
      description: "Questions the agent should ask when ambiguity_level == 'high'. Empty otherwise.",
    },
    success_tests: {
      type: "array",
      minItems: 1,
      maxItems: 15,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "description"],
        properties: {
          id: {
            type: "string",
            minLength: 3,
            maxLength: 60,
            pattern: "^[a-z][a-z0-9_]*$",
            description: "Stable snake_case id, e.g. `extension_match`.",
          },
          type: {
            type: "string",
            enum: TEST_TYPES,
            description: "`deterministic` = code-only check; `semantic` = LLM grader (run last).",
          },
          description: {
            type: "string",
            minLength: 5,
            maxLength: 240,
            description: "Human-readable criterion the reviewer enforces.",
          },
          check: {
            type: "string",
            enum: [
              "extension_match",
              "mime_magic_match",
              "parses_as_xml",
              "parses_as_json",
              "parses_as_svg",
              "parses_as_zip",
              "opens_as_docx",
              "opens_as_xlsx",
              "opens_as_pptx",
              "opens_as_pdf",
              "min_rows",
              "min_columns",
              "min_pages",
              "min_slides",
              "min_paragraphs",
              "contains_text",
              "contains_regex",
              "forbidden_format_absent",
              "semantic_match",
            ],
            description: "Built-in check the reviewer runs. Optional; semantic tests usually omit it.",
          },
          parameters: {
            type: "object",
            description: "Free-form parameters for the check (e.g. { \"value\": 30 } for min_rows).",
            additionalProperties: true,
          },
        },
      },
      description: "Pass/fail tests the ArtifactReviewer executes. ALL deterministic tests must pass before finalize.",
    },

    // ─── v1.1 additions (all OPTIONAL — additive) ──────────────────────
    raw_user_request: {
      type: "string",
      maxLength: 4000,
      description: "The user's message verbatim (for audit trail).",
    },
    normalized_request: {
      type: "string",
      maxLength: 2000,
      description: "Cleaned / spelling-fixed version used for downstream prompts.",
    },
    detected_language: {
      type: "string",
      pattern: "^[a-z]{2,3}(-[A-Z]{2})?$",
      description: "BCP-47 lang tag (e.g. 'es', 'en', 'pt-BR').",
    },
    primary_intent: {
      type: "string",
      enum: PRIMARY_INTENTS,
      description: "High-level verb the user is asking for.",
    },
    secondary_intents: {
      type: "array",
      items: { type: "string", enum: PRIMARY_INTENTS },
      maxItems: 5,
      description: "Additional intents for multi-intent requests (compound pedidos).",
    },
    task_category: {
      type: "string",
      enum: TASK_CATEGORIES,
      description: "Which closed-route pipeline handles this request.",
    },
    artifact_required: {
      type: "boolean",
      description: "Explicit flag for whether a downloadable file is expected. Redundant with required_extension but keeps the JSON self-describing.",
    },
    output_format: {
      type: "string",
      maxLength: 80,
      description: "Human-facing format label ('Excel xlsx', 'SVG vector', 'PowerPoint pptx', 'informe Word APA', 'respuesta inline').",
    },
    required_tools: {
      type: "array",
      items: { type: "string", minLength: 2, maxLength: 60 },
      maxItems: 12,
      description: "Tool names the orchestrator MUST invoke (e.g. ['web_search','create_document','verify_artifact']).",
    },
    forbidden_tools: {
      type: "array",
      items: { type: "string", minLength: 2, maxLength: 60 },
      maxItems: 12,
      description: "Tool names the orchestrator MUST NOT invoke for this turn.",
    },
    source_requirements: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 240 },
      maxItems: 10,
      description: "What counts as an acceptable source ('Scopus or OpenAlex only', 'only 2022-2026', 'only open access', 'only Latin America').",
    },
    grounding_required: {
      type: "string",
      enum: GROUNDING_MODES,
      description: "What the answer must be grounded on.",
    },
    citations_required: {
      type: "boolean",
      description: "True when the user explicitly asked for citations / APA 7 / DOI, etc.",
    },
    user_constraints: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 240 },
      maxItems: 20,
      description: "Explicit constraints the user stated ('no books', 'only SVG', 'exactly 30 rows').",
    },
    implicit_constraints: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 240 },
      maxItems: 20,
      description: "Constraints the router inferred but were not stated ('respond in Spanish because user wrote in Spanish', 'academic tone').",
    },
    quality_bar: {
      type: "string",
      enum: QUALITY_BAR,
      description: "How polished the deliverable needs to be.",
    },
    ambiguity_score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Numeric 0..1 ambiguity; redundant with ambiguity_level but useful for telemetry.",
    },
    risk_level: {
      type: "string",
      enum: RISK_LEVELS,
      description: "Risk of doing the action (posting to Slack = high; rendering SVG = low).",
    },
    execution_plan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "description"],
        properties: {
          step: { type: "integer", minimum: 1 },
          description: { type: "string", minLength: 5, maxLength: 240 },
          tool: { type: "string", maxLength: 60 },
          depends_on: { type: "array", items: { type: "integer" }, maxItems: 12 },
        },
      },
      maxItems: 20,
      description: "Planned steps the agent intends to execute.",
    },
    validation_plan: {
      type: "array",
      items: { type: "string", minLength: 5, maxLength: 240 },
      maxItems: 20,
      description: "How the ArtifactReviewer + semantic judge will validate the delivery (mirrors success_tests but in prose).",
    },
    self_repair_plan: {
      type: "array",
      items: { type: "string", minLength: 5, maxLength: 240 },
      maxItems: 10,
      description: "What the agent should do when a validation test fails (max retries, fallback strategies).",
    },
    final_delivery_rules: {
      type: "array",
      items: { type: "string", minLength: 5, maxLength: 240 },
      maxItems: 10,
      description: "Rules the ReleaseController enforces right before user sees the result (e.g. 'never include a score N/100 unless real tests ran', 'never claim file was verified if reviewer rejected it').",
    },
    evidence_log: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stage", "detail"],
        properties: {
          stage: { type: "string", maxLength: 60 },
          detail: { type: "string", maxLength: 400 },
          at: { type: "string", maxLength: 40 },
        },
      },
      maxItems: 30,
      description: "Append-only trail the Telemetry agent fills; router leaves it empty.",
    },
    format_violation_policy: {
      type: "string",
      enum: FORMAT_VIOLATION_POLICY,
      description: "What the FormatSovereigntyEngine does when the artifact doesn't match required_extension: 'hard-block' = reject + repair; 'warn' = log only; 'ignore' = pass through.",
    },
  },
};

const TASK_CONTRACT_VERSION = "1.1";

module.exports = {
  taskContractSchema,
  TASK_CONTRACT_VERSION,
  ARTIFACT_TYPES,
  EXTENSIONS,
  MIME_TYPES,
  DELIVERY_MODES,
  AMBIGUITY_LEVELS,
  TEST_TYPES,
  TASK_CATEGORIES,
  PRIMARY_INTENTS,
  QUALITY_BAR,
  RISK_LEVELS,
  GROUNDING_MODES,
  FORMAT_VIOLATION_POLICY,
};
