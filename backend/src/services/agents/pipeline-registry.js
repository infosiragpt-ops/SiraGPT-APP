/**
 * pipeline-registry — maps a UniversalTaskContract.task_category
 * onto the closed-route pipeline that owns it, with declared
 * required/forbidden tools and the minimum set of deterministic
 * checks every deliverable in that category must pass.
 *
 * The pipeline is a **description**, not a handler. The current
 * orchestrator (agent-task.js → react-agent.js) executes tools
 * directly; this registry is consulted to:
 *
 *   1. Populate the contract's `required_tools` / `forbidden_tools`
 *      defaults when the LLM router omits them.
 *   2. Drive the FormatSovereigntyEngine — the pipeline declares
 *      the only MIME types / extensions allowed for that category.
 *   3. Seed `success_tests` with the category's minimum acceptance
 *      tests when the router leaves the list too thin.
 *
 * A later commit will split the actual execution into per-pipeline
 * modules that implement the full Planner → Builder → SemanticReviewer
 * → FormatValidator → QualityEvaluator → RepairAgent → ReleaseController
 * chain from the spec. For now the registry gives every turn a
 * typed identity ("this run is handled by DocumentPipeline") that
 * downstream code uses to gate behaviour.
 */

const PIPELINES = {
  "visual-artifact": {
    id: "visual-artifact",
    name: "VisualArtifactPipeline",
    allowedExtensions: ["svg", "png", "jpg", "jpeg", "webp", "gif"],
    allowedMimeTypes: ["image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"],
    requiredTools: ["create_document"],
    recommendedTools: ["verify_artifact"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "extension_match", check: "extension_match", type: "deterministic", description: "Extension matches required_extension." },
      { id: "mime_match", check: "mime_magic_match", type: "deterministic", description: "MIME type from magic bytes matches mime_type." },
    ],
  },
  document: {
    id: "document",
    name: "DocumentPipeline",
    allowedExtensions: ["docx", "pdf", "md", "txt", "html"],
    allowedMimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf",
      "text/markdown", "text/plain", "text/html",
    ],
    requiredTools: ["create_document", "verify_artifact"],
    recommendedTools: ["web_search", "rag_retrieve"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "extension_match", check: "extension_match", type: "deterministic", description: "Extension matches required_extension." },
      { id: "opens_as_docx_or_pdf", check: "opens_as_docx", type: "deterministic", description: "ZIP with word/document.xml (for docx). Skipped for other extensions." },
    ],
  },
  spreadsheet: {
    id: "spreadsheet",
    name: "SpreadsheetPipeline",
    allowedExtensions: ["xlsx", "csv", "tsv"],
    allowedMimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ],
    requiredTools: ["create_document", "verify_artifact"],
    recommendedTools: ["web_search", "python_exec"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "extension_match", check: "extension_match", type: "deterministic", description: "Extension matches required_extension." },
      { id: "opens_as_xlsx", check: "opens_as_xlsx", type: "deterministic", description: "ZIP with xl/workbook.xml (for xlsx). Skipped for csv." },
    ],
  },
  presentation: {
    id: "presentation",
    name: "SlidePipeline",
    allowedExtensions: ["pptx", "pdf"],
    allowedMimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/pdf",
    ],
    requiredTools: ["create_document", "verify_artifact"],
    recommendedTools: ["python_exec"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "extension_match", check: "extension_match", type: "deterministic", description: "Extension matches required_extension." },
      { id: "opens_as_pptx", check: "opens_as_pptx", type: "deterministic", description: "ZIP with ppt/presentation.xml." },
    ],
  },
  pdf: {
    id: "pdf",
    name: "PDFPipeline",
    allowedExtensions: ["pdf"],
    allowedMimeTypes: ["application/pdf"],
    requiredTools: ["create_document", "verify_artifact"],
    recommendedTools: ["python_exec"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "extension_match", check: "extension_match", type: "deterministic", description: "Extension is .pdf." },
      { id: "opens_as_pdf", check: "opens_as_pdf", type: "deterministic", description: "%PDF- header + %%EOF footer." },
    ],
  },
  code: {
    id: "code",
    name: "CodePipeline",
    allowedExtensions: ["py", "js", "ts", "tsx", "jsx", "json", "md", "txt", "html", "xml"],
    allowedMimeTypes: [
      "text/x-python", "application/javascript", "application/typescript",
      "application/json", "text/markdown", "text/plain", "text/html", "application/xml",
    ],
    requiredTools: ["python_exec", "run_tests"],
    recommendedTools: ["create_document"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "has_content", check: "contains_regex", type: "deterministic", description: "Non-empty source.", parameters: { pattern: "\\S" } },
    ],
  },
  "research-grounding": {
    id: "research-grounding",
    name: "ResearchGroundingPipeline",
    allowedExtensions: ["xlsx", "csv", "md", "docx", "pdf", "json", null],
    allowedMimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv", "text/markdown",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf", "application/json",
    ],
    requiredTools: ["web_search"],
    recommendedTools: ["create_document", "verify_artifact"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "has_sources", check: "contains_regex", type: "deterministic", description: "Deliverable mentions at least one DOI / URL.", parameters: { pattern: "(10\\.\\d{4,}|https?://)" } },
    ],
  },
  "rag-document-understanding": {
    id: "rag-document-understanding",
    name: "RAGDocumentUnderstandingPipeline",
    allowedExtensions: [null, "md", "txt", "docx"],
    allowedMimeTypes: [null, "text/markdown", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    requiredTools: ["self_rag_answer"],
    recommendedTools: ["rag_retrieve"],
    forbiddenTools: [],
    defaultChecks: [
      { id: "cites_source", check: "contains_regex", type: "deterministic", description: "Response contains bracketed citation [N].", parameters: { pattern: "\\[\\d+\\]" } },
    ],
  },
  "action-execution": {
    id: "action-execution",
    name: "ActionExecutionPipeline",
    allowedExtensions: [null],
    allowedMimeTypes: [null],
    requiredTools: [],
    recommendedTools: [],
    forbiddenTools: [],
    defaultChecks: [
      { id: "inline_only", check: "forbidden_format_absent", type: "deterministic", description: "No unexpected file is attached.", parameters: { extensions: ["docx", "xlsx", "pptx", "pdf"] } },
    ],
  },
  "direct-answer": {
    id: "direct-answer",
    name: "DirectAnswerPipeline",
    allowedExtensions: [null],
    allowedMimeTypes: [null],
    requiredTools: [],
    recommendedTools: [],
    forbiddenTools: ["create_document"],
    defaultChecks: [
      { id: "non_empty", check: "contains_regex", type: "deterministic", description: "Inline reply is non-empty.", parameters: { pattern: "\\S" } },
    ],
  },
  "multi-intent": {
    id: "multi-intent",
    name: "MultiIntentDAGPipeline",
    allowedExtensions: EXTS(),
    allowedMimeTypes: null, // inherited from sub-contracts
    requiredTools: [],
    recommendedTools: [],
    forbiddenTools: [],
    defaultChecks: [],
  },
  unknown: {
    id: "unknown",
    name: "UnknownPipeline",
    allowedExtensions: null,
    allowedMimeTypes: null,
    requiredTools: [],
    recommendedTools: [],
    forbiddenTools: [],
    defaultChecks: [],
  },
};

function EXTS() {
  // Multi-intent accepts anything because sub-contracts enforce their own routes.
  return ["svg", "png", "jpg", "jpeg", "webp", "gif", "docx", "xlsx", "pptx", "pdf", "csv", "tsv", "json", "md", "txt", "html", "xml", "py", "js", "ts"];
}

/**
 * Pick the pipeline descriptor for a contract. Falls back to
 * inferring from artifact_type when task_category is missing, then
 * to `unknown`.
 *
 * @param {object} contract — UniversalTaskContract
 * @returns {object} pipeline descriptor
 */
function pickPipeline(contract) {
  if (!contract || typeof contract !== "object") return PIPELINES.unknown;
  const cat = contract.task_category;
  if (cat && PIPELINES[cat]) return PIPELINES[cat];

  // Infer from artifact_type when the router didn't set a category.
  switch (contract.artifact_type) {
    case "svg":
    case "image":
    case "chart":
      return PIPELINES["visual-artifact"];
    case "document":
      return PIPELINES.document;
    case "spreadsheet":
      return PIPELINES.spreadsheet;
    case "presentation":
      return PIPELINES.presentation;
    case "pdf":
      return PIPELINES.pdf;
    case "code":
      return PIPELINES.code;
    case "data-search":
      return PIPELINES["research-grounding"];
    case "text-answer":
    case "none":
      return PIPELINES["direct-answer"];
    default:
      return PIPELINES.unknown;
  }
}

function listPipelines() {
  return Object.values(PIPELINES).map(p => ({
    id: p.id,
    name: p.name,
    allowedExtensions: p.allowedExtensions,
    allowedMimeTypes: p.allowedMimeTypes,
    requiredTools: p.requiredTools,
    recommendedTools: p.recommendedTools,
    forbiddenTools: p.forbiddenTools,
  }));
}

module.exports = {
  PIPELINES,
  pickPipeline,
  listPipelines,
};
