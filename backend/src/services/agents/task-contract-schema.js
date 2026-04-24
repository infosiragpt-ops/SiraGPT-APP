/**
 * task-contract-schema — the single source of truth for what a user
 * wants before the task agent is allowed to act.
 *
 * Every user turn passes through an NLU/intent-router stage that
 * produces a TaskContract conforming to this JSON Schema. The agent
 * MUST honour the contract or self-repair; the ArtifactReviewer
 * (artifact-reviewer.js) runs deterministic pass/fail tests against
 * it — no heuristic "100/100" scores.
 *
 * Why: "créame un SVG de una casa" plus a model that likes writing
 * .docx has produced hallucinated deliverables. The contract forces
 * the pipeline to choose a CLOSED route (one extension + one MIME
 * type) before any file is written; anything else is rejected at the
 * validation layer, not renegotiated in prose.
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
];

const AMBIGUITY_LEVELS = ["low", "medium", "high"];

const TEST_TYPES = ["deterministic", "semantic"];

const taskContractSchema = {
  $id: "https://siragpt.io/schemas/task-contract.v1.json",
  type: "object",
  title: "TaskContract",
  description: "Closed contract describing exactly what the agent must deliver for this user turn.",
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
    version: {
      type: "string",
      enum: ["1.0"],
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
      oneOf: [
        { type: "string", enum: EXTENSIONS },
        { type: "null" },
      ],
      description: "File extension the deliverable MUST use (without leading dot). Null when no file is expected.",
    },
    mime_type: {
      oneOf: [
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
  },
};

const TASK_CONTRACT_VERSION = "1.0";

module.exports = {
  taskContractSchema,
  TASK_CONTRACT_VERSION,
  ARTIFACT_TYPES,
  EXTENSIONS,
  MIME_TYPES,
  DELIVERY_MODES,
  AMBIGUITY_LEVELS,
  TEST_TYPES,
};
