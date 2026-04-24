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
        { id: "extension_match", type: "deterministic", description: "El archivo entregado termina en .svg.", check: "extension_match", parameters: { value: "svg" } },
        { id: "mime_match", type: "deterministic", description: "MIME type real del archivo es image/svg+xml.", check: "mime_magic_match", parameters: { value: "image/svg+xml" } },
        { id: "svg_parseable", type: "deterministic", description: "Contiene <svg> y parsea como XML válido.", check: "parses_as_svg" },
        { id: "forbidden_docx", type: "deterministic", description: "No se entrega un Word en lugar del SVG.", check: "forbidden_format_absent", parameters: { extensions: ["docx", "pdf", "png"] } },
        { id: "renders_house", type: "semantic", description: "Al renderizarlo, se ve una casa con techo rojo y dos ventanas." },
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
        { id: "extension_match", type: "deterministic", description: "Archivo .xlsx.", check: "extension_match", parameters: { value: "xlsx" } },
        { id: "mime_match", type: "deterministic", description: "MIME real openxmlformats spreadsheet.", check: "mime_magic_match", parameters: { value: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } },
        { id: "opens_as_xlsx", type: "deterministic", description: "Se abre correctamente como xlsx (ZIP con workbook.xml).", check: "opens_as_xlsx" },
        { id: "min_rows_31", type: "deterministic", description: "Al menos 31 filas (30 datos + header).", check: "min_rows", parameters: { value: 31 } },
        { id: "min_columns_6", type: "deterministic", description: "Al menos 6 columnas.", check: "min_columns", parameters: { value: 6 } },
        { id: "forbidden_word_pdf", type: "deterministic", description: "No se entrega Word o PDF en lugar.", check: "forbidden_format_absent", parameters: { extensions: ["docx", "pdf", "csv"] } },
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
        { id: "inline_only", type: "deterministic", description: "No se adjunta ningún archivo.", check: "forbidden_format_absent", parameters: { extensions: ["docx", "xlsx", "pptx", "pdf"] } },
        { id: "mentions_bayes", type: "deterministic", description: "El texto menciona 'Bayes'.", check: "contains_text", parameters: { value: "Bayes" } },
        { id: "has_formula", type: "deterministic", description: "Incluye la fórmula P(A|B).", check: "contains_regex", parameters: { pattern: "P\\s*\\(\\s*A\\s*\\|\\s*B\\s*\\)" } },
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
async function resolveTaskContract({ goal, openai, model = "gpt-4o-mini", fileIds, fallback }) {
  const t0 = Date.now();
  const hint = Array.isArray(fileIds) && fileIds.length > 0
    ? `\n\n(The user has ${fileIds.length} uploaded file${fileIds.length === 1 ? "" : "s"} attached to this conversation.)`
    : "";

  // Try LLM with Structured Outputs first.
  if (openai && typeof openai.chat?.completions?.create === "function" && typeof goal === "string" && goal.trim().length > 0) {
    try {
      const resp = await openai.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 1400,
        messages: [
          { role: "system", content: RESOLVER_SYSTEM_PROMPT },
          ...fewShotMessages(),
          { role: "user", content: goal + hint },
        ],
        // OpenAI Structured Outputs. When the model supports strict
        // json_schema this returns a parse-guaranteed object; we still
        // run ajv because defense-in-depth is cheap and catches drift
        // on providers/models that ignore `strict`.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "TaskContract",
            strict: true,
            schema: toStrictOpenAISchema(taskContractSchema),
          },
        },
      });
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
      // Log once per failure so we can tell structured-output drift
      // apart from network flakes, but don't throw — fall back.
      console.warn("[task-contract-resolver] LLM resolve failed:", err?.message || err);
    }
  }

  const contract = fallback ? fallback({ goal, fileIds }) : makeEmptyContract(goal);
  return { contract, source: "fallback", durationMs: Date.now() - t0 };
}

/**
 * OpenAI's json_schema mode is stricter than general ajv — every
 * property must be listed in `required`, and `additionalProperties`
 * must be false. We enforce that here so the prompt doesn't diverge
 * from what the API will accept.
 *
 * For `oneOf` at leaf level the API also requires the same structure
 * (one branch for string enum, one for null). Our schema already
 * conforms, so this is mostly a pass-through with `required` tightening
 * for nested objects.
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
    if (copy.type === "object" && copy.properties && !Array.isArray(copy.required)) {
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
        parameters: { pattern: "\\S" },
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
  validateContract,
  makeEmptyContract,
  toStrictOpenAISchema,
  FEW_SHOT_EXAMPLES,
  RESOLVER_SYSTEM_PROMPT,
};
