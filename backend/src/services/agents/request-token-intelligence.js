/**
 * request-token-intelligence
 *
 * Deterministic Request Intelligence Layer that reads a user request as
 * ordered tokens, token windows and n-grams before any regex fallback.
 * It does not decide from one keyword. It scores intent from evidence:
 * action + object + output format + source needs + private-file context
 * + negation + delivery constraints.
 */

const VERSION = "token-intelligence-2026-04";

const PIPELINE_BY_INTENT = Object.freeze({
  visual_artifact: "VisualArtifactPipeline",
  document_generation: "DocumentPipeline",
  spreadsheet_generation: "SpreadsheetPipeline",
  slide_generation: "SlidePipeline",
  code_generation: "CodePipeline",
  research_grounding: "ResearchGroundingPipeline",
  document_understanding: "RAGDocumentUnderstandingPipeline",
  external_action: "ActionExecutionPipeline",
  direct_answer: "DirectAnswerPipeline",
  image_generation: "ImagePipeline",
  image_editing: "ImagePipeline",
  automation: "ActionExecutionPipeline",
  translation: "DirectAnswerPipeline",
  summarization: "DirectAnswerPipeline",
  unknown: "DirectAnswerPipeline",
});

const FORMAT_DEFINITIONS = Object.freeze([
  { extension: ".svg", output_format: "SVG", artifact_type: "svg", pipeline: "VisualArtifactPipeline", intent: "visual_artifact", terms: ["svg", ".svg", "image svg", "vectorial", "vector"] },
  { extension: ".docx", output_format: "DOCX", artifact_type: "document", pipeline: "DocumentPipeline", intent: "document_generation", terms: ["word", "docx", ".docx", "documento word", "ms word"] },
  { extension: ".xlsx", output_format: "XLSX", artifact_type: "spreadsheet", pipeline: "SpreadsheetPipeline", intent: "spreadsheet_generation", terms: ["excel", "xlsx", ".xlsx", "hoja de calculo", "spreadsheet", "workbook"] },
  { extension: ".csv", output_format: "CSV", artifact_type: "csv", pipeline: "SpreadsheetPipeline", intent: "spreadsheet_generation", terms: ["csv", ".csv", "tsv", ".tsv"] },
  { extension: ".pptx", output_format: "PPTX", artifact_type: "presentation", pipeline: "SlidePipeline", intent: "slide_generation", terms: ["ppt", "pptx", ".pptx", "powerpoint", "power point", "presentacion", "diapositivas", "slides", "slide deck", "pitch deck"] },
  { extension: ".pdf", output_format: "PDF", artifact_type: "pdf", pipeline: "DocumentPipeline", intent: "document_generation", terms: ["pdf", ".pdf"] },
  { extension: ".html", output_format: "HTML", artifact_type: "html", pipeline: "CodePipeline", intent: "code_generation", terms: ["html", ".html", "pagina html"] },
  { extension: ".md", output_format: "Markdown", artifact_type: "markdown", pipeline: "DocumentPipeline", intent: "document_generation", terms: ["markdown", ".md", "md"] },
  { extension: ".json", output_format: "JSON", artifact_type: "code", pipeline: "CodePipeline", intent: "code_generation", terms: ["json", ".json"] },
]);

const LEXICON = Object.freeze({
  create: [
    "crea", "crear", "creame", "haz", "hazme", "genera", "generar", "generame",
    "prepara", "preparar", "elabora", "elaborar", "redacta", "redactar",
    "arma", "construye", "construir", "build", "make", "create", "generate",
    "prepare", "deliver", "desarrolla", "desarrollar", "programa", "programar",
  ],
  export: ["exporta", "exportar", "descarga", "descargar", "download", "entrega", "entregar", "formato", "descargable"],
  understand: [
    "lee", "leer", "analiza", "analizar", "resume", "resumen", "resumir",
    "extrae", "extraer", "identifica", "dime", "cual", "que", "quien",
    "cuando", "donde", "primera", "primer", "palabra", "parrafo", "contenido",
    "segun", "explica", "explicar", "menciona", "dice",
  ],
  research: [
    "busca", "buscar", "investiga", "investigar", "fuentes", "referencias",
    "citas", "citar", "bibliografia", "articulos", "papers", "paper", "doi",
    "scopus", "openalex", "crossref", "pubmed", "doaj", "scielo", "wos",
    "web of science", "semantic scholar", "cientifico", "cientificos",
    "academico", "academicos", "actual", "reciente", "reales", "verifica",
  ],
  data: [
    "datos", "dataset", "tabla", "tablas", "filas", "columnas", "formula",
    "formulas", "dashboard", "kpi", "metricas", "ventas", "gastos", "registros",
    "limpia", "limpiar", "procesa", "procesar",
  ],
  code: [
    "codigo", "script", "funcion", "api", "backend", "frontend", "debug",
    "bug", "test", "tests", "lint", "build", "repositorio", "github",
    "deploy", "despliegue", "python", "javascript", "typescript", "react",
    "nextjs", "next js", "node", "fastapi", "html", "css", "xml", "source",
  ],
  web: [
    "web", "website", "pagina web", "sitio web", "landing", "web app",
    "frontend", "react", "nextjs", "next js", "saas", "ecommerce",
    "e-commerce", "tienda online",
  ],
  visual: [
    "grafico", "grafica", "chart", "plot", "diagrama", "mermaid", "uml",
    "dashboard", "visualizacion", "logo", "icono", "infografia", "vectorial",
  ],
  image: ["imagen", "foto", "photo", "picture", "png", "jpg", "jpeg", "webp", "ilustracion", "render"],
  video: ["video", "clip", "animacion", "veo3", "veo 3", "sora", "mp4"],
  math: ["integral", "derivada", "ecuacion", "cronbach", "anova", "regresion", "probabilidad", "matriz", "varianza", "fisica", "quimica"],
  action: ["gmail", "correo", "email", "calendario", "calendar", "reserva", "reservar", "whatsapp", "telegram", "agenda"],
  fileContext: ["adjunto", "adjuntos", "subido", "cargado", "uploaded", "attached", "archivo", "documento", "este", "esta", "del", "de la", "segun"],
  negation: ["no", "sin", "nunca", "jamas", "excepto"],
  strict: ["100%", "reales", "verifica", "validar", "validado", "no inventes", "sin inventar", "doi", "preciso", "precisa"],
  longRunning: ["30 minutos", "60 minutos", "2 horas", "dos horas", "una hora", "sin parar", "sin detenerse", "autonomo", "autonoma", "autocorrige", "ejecuta pruebas"],
});

function analyzeRequestTokens({ rawUserRequest = "", fileIds = [], conversationHistory = [] } = {}) {
  const raw = String(rawUserRequest || "");
  const normalized = normalize(raw);
  const tokens = tokenize(normalized);
  const ngrams = buildNgrams(tokens, 4);
  const terms = new Set([...tokens.map(t => t.value), ...ngrams.map(n => n.value)]);
  const evidence = buildEvidence(terms);
  const formatEvidence = detectRequestedFormats({ tokens, terms, evidence });
  const context = buildContext({ tokens, terms, evidence, fileIds, conversationHistory, requestedFormats: formatEvidence.requested_formats });
  const intentScores = scoreIntents({ evidence, context, requestedFormats: formatEvidence.requested_formats, excludedFormats: formatEvidence.excluded_formats });
  const best = intentScores[0] || { intent: "direct_answer", score: 0.25, reasons: ["fallback"] };
  const pipeline = inferPipeline(best.intent, formatEvidence.requested_formats, context);

  return Object.freeze({
    version: VERSION,
    normalized_request: normalized,
    token_count: tokens.length,
    tokens,
    ngrams,
    evidence,
    requested_formats: formatEvidence.requested_formats,
    excluded_formats: formatEvidence.excluded_formats,
    context,
    intent_scores: intentScores,
    primary_intent: best.intent,
    pipeline,
    confidence: Number(Math.max(0.01, Math.min(0.99, best.score)).toFixed(2)),
    ambiguity_score: inferAmbiguity({ tokens, context, requestedFormats: formatEvidence.requested_formats, best }),
  });
}

function buildEvidence(terms) {
  const out = {};
  for (const [dimension, lexemes] of Object.entries(LEXICON)) {
    const matches = lexemes.filter(item => terms.has(normalize(item)));
    out[dimension] = Object.freeze({
      count: matches.length,
      present: matches.length > 0,
      matches,
    });
  }
  return Object.freeze(out);
}

function detectRequestedFormats({ tokens, terms, evidence }) {
  const requested = [];
  const excluded = [];
  for (const definition of FORMAT_DEFINITIONS) {
    const occurrences = [];
    for (const term of definition.terms) {
      const normalizedTerm = normalize(term);
      if (!terms.has(normalizedTerm)) continue;
      occurrences.push(...findTermOccurrences(tokens, normalizedTerm));
    }
    if (occurrences.length === 0) continue;

    const occurrenceEvidence = occurrences.map(occ => classifyFormatOccurrence({ tokens, occurrence: occ, evidence }));
    const excludedOnly = occurrenceEvidence.every(item => item.negated);
    const outputEvidence = occurrenceEvidence.find(item => item.output);
    const inputOnly = occurrenceEvidence.length > 0 && occurrenceEvidence.every(item => item.input && !item.output);

    if (excludedOnly) {
      excluded.push({ ...definition, reason: "negated_by_user", evidence: occurrenceEvidence.flatMap(e => e.evidence).slice(0, 8) });
      continue;
    }
    if (inputOnly) continue;
    if (outputEvidence || evidence.create.present || evidence.export.present) {
      requested.push({
        extension: definition.extension,
        output_format: definition.output_format,
        artifact_type: definition.artifact_type,
        pipeline: definition.pipeline,
        intent: definition.intent,
        evidence: occurrenceEvidence.flatMap(e => e.evidence).slice(0, 8),
      });
    }
  }
  return {
    requested_formats: dedupeFormats(requested),
    excluded_formats: dedupeFormats(excluded),
  };
}

function classifyFormatOccurrence({ tokens, occurrence, evidence }) {
  const start = occurrence.start;
  const end = occurrence.end;
  const before = tokens.slice(Math.max(0, start - 8), start).map(t => t.value);
  const after = tokens.slice(end + 1, Math.min(tokens.length, end + 8)).map(t => t.value);
  const window = [...before, ...tokens.slice(start, end + 1).map(t => t.value), ...after];
  const beforeText = before.join(" ");
  const afterText = after.join(" ");
  const negated = before.slice(-4).some(t => LEXICON.negation.map(normalize).includes(t));
  const generationTerms = new Set([...LEXICON.create, ...LEXICON.export].map(normalize));
  const understandTerms = new Set(LEXICON.understand.map(normalize));
  const localGeneration = before.slice(-4).some(t => generationTerms.has(t));
  const localUnderstanding = before.slice(-6).some(t => understandTerms.has(t));
  const nearBeforeText = before.slice(-5).join(" ");
  const inputLeadIn = /\b(basado en|basada en|a partir de|desde|datos de|archivo de|del archivo|de la hoja|de los datos|con datos de|usando datos de|segun)\s*(?:un|una|el|la|este|esta|ese|esa|mi|mis)?\s*$/.test(beforeText);
  const input = inputLeadIn
    || /\b(del|de la|de el|este|esta|ese|esa|mi|mis|adjunto|subido|cargado|uploaded|attached|segun)\b/.test(nearBeforeText)
    || /\b(adjunto|subido|cargado|uploaded|attached|anterior)\b/.test(afterText)
    || (localUnderstanding && !localGeneration);
  const explicitOutput = (!inputLeadIn && /\b(en|como|a|formato)\s+(?:un|una|el|la)?\s*$/.test(nearBeforeText))
    || /\b(exporta|exportar|descarga|descargar|download|entrega|entregar)\b/.test(nearBeforeText)
    || /\b(final|descargable|editable|para descargar|de salida)\b/.test(afterText);
  const output = explicitOutput || localGeneration || ((!input && !negated) && (evidence.create.present || evidence.export.present));
  return {
    negated,
    input,
    output,
    evidence: window.slice(0, 16),
  };
}

function buildContext({ tokens, terms, evidence, fileIds, conversationHistory, requestedFormats }) {
  const hasFiles = Array.isArray(fileIds) && fileIds.length > 0;
  const hasHistoryFiles = Array.isArray(conversationHistory)
    && conversationHistory.slice(-6).some(m => Array.isArray(m?.files) && m.files.length > 0);
  const asksExistingDocumentQuestion = evidence.understand.present
    && (hasFiles || hasHistoryFiles || evidence.fileContext.present)
    && requestedFormats.length === 0;
  return Object.freeze({
    has_files: hasFiles || hasHistoryFiles,
    has_generation_action: evidence.create.present || evidence.export.present,
    has_research_requirement: evidence.research.present,
    has_data_work: evidence.data.present,
    has_code_work: evidence.code.present,
    has_web_build: evidence.web.present && (evidence.create.present || evidence.code.present),
    has_visual_work: evidence.visual.present,
    has_math_work: evidence.math.present,
    has_external_action: evidence.action.present,
    has_long_running_signal: evidence.longRunning.present,
    asks_existing_document_question: asksExistingDocumentQuestion,
    token_density: tokens.length > 0 ? Number(((Object.values(evidence).filter(e => e.present).length) / tokens.length).toFixed(3)) : 0,
    primary_format: requestedFormats[0]?.extension || null,
  });
}

function scoreIntents({ evidence, context, requestedFormats, excludedFormats }) {
  const formatIntentBoost = requestedFormats.reduce((acc, item) => {
    acc[item.intent] = (acc[item.intent] || 0) + 0.35;
    return acc;
  }, {});
  const scores = {
    visual_artifact: 0.08 + (formatIntentBoost.visual_artifact || 0) + weight(evidence.visual, 0.18) + (context.has_generation_action ? 0.14 : 0),
    document_generation: 0.08 + (formatIntentBoost.document_generation || 0) + (context.has_generation_action ? 0.12 : 0) + (evidence.research.present ? 0.06 : 0),
    spreadsheet_generation: 0.06 + (formatIntentBoost.spreadsheet_generation || 0) + weight(evidence.data, 0.16) + (context.has_generation_action ? 0.1 : 0),
    slide_generation: 0.06 + (formatIntentBoost.slide_generation || 0) + (context.has_generation_action ? 0.11 : 0),
    code_generation: 0.07 + weight(evidence.code, 0.2) + (context.has_web_build ? 0.22 : 0) + (context.has_generation_action ? 0.08 : 0),
    research_grounding: 0.08 + weight(evidence.research, 0.26) + (context.has_research_requirement ? 0.12 : 0),
    document_understanding: 0.06 + (context.asks_existing_document_question ? 0.54 : 0) + weight(evidence.understand, 0.1),
    image_generation: 0.06 + weight(evidence.image, 0.23) + (context.has_generation_action ? 0.12 : 0),
    image_editing: 0.04 + (evidence.image.present && termsHaveAny(evidence, ["edita", "modifica", "retoca"]) ? 0.4 : 0),
    external_action: 0.05 + weight(evidence.action, 0.24),
    direct_answer: 0.25,
  };

  if (context.asks_existing_document_question) {
    scores.document_generation -= 0.3;
    scores.spreadsheet_generation -= 0.24;
    scores.slide_generation -= 0.24;
    scores.visual_artifact -= 0.2;
  }
  if (excludedFormats.some(f => f.extension === ".docx")) scores.document_generation -= 0.18;
  if (context.has_math_work && !context.has_generation_action) scores.direct_answer += 0.18;
  if (context.has_long_running_signal && (context.has_research_requirement || requestedFormats.length > 0 || context.has_code_work)) {
    scores.code_generation += 0.08;
    scores.research_grounding += 0.08;
  }

  return Object.entries(scores)
    .map(([intent, score]) => ({
      intent,
      score: Number(Math.max(0.01, Math.min(0.99, score)).toFixed(2)),
      reasons: reasonsForIntent(intent, { evidence, context, requestedFormats }),
    }))
    .sort((a, b) => b.score - a.score);
}

function inferPipeline(intent, requestedFormats, context) {
  if (requestedFormats.length > 1) return "MultiIntentPipeline";
  const primaryFormat = requestedFormats[0];
  if (primaryFormat) {
    if (primaryFormat.extension === ".svg" && context.has_code_work && !context.has_visual_work) return "CodePipeline";
    return primaryFormat.pipeline;
  }
  return PIPELINE_BY_INTENT[intent] || "DirectAnswerPipeline";
}

function inferAmbiguity({ tokens, context, requestedFormats, best }) {
  if (tokens.length === 0) return 1;
  if (tokens.length < 3 && !context.has_files) return 0.85;
  if (best.score < 0.55) return 0.62;
  if (requestedFormats.length === 0 && context.has_generation_action && !context.has_web_build && !context.has_code_work && !context.has_research_requirement) return 0.45;
  return 0.15;
}

function reasonsForIntent(intent, { evidence, context, requestedFormats }) {
  const reasons = [];
  if (requestedFormats.length > 0) reasons.push(`formats:${requestedFormats.map(f => f.extension).join(",")}`);
  for (const [name, value] of Object.entries(evidence)) {
    if (value.present && reasons.length < 6) reasons.push(`${name}:${value.matches.slice(0, 3).join("|")}`);
  }
  if (context.asks_existing_document_question) reasons.push("private_file_question");
  if (intent === "direct_answer" && reasons.length === 0) reasons.push("no_artifact_or_tool_evidence");
  return reasons.slice(0, 8);
}

function findTermOccurrences(tokens, term) {
  const parts = term.split(" ").filter(Boolean);
  const out = [];
  for (let i = 0; i <= tokens.length - parts.length; i += 1) {
    let ok = true;
    for (let j = 0; j < parts.length; j += 1) {
      if (tokens[i + j].value !== parts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ start: i, end: i + parts.length - 1, value: term });
  }
  return out;
}

function tokenize(normalized) {
  const matches = String(normalized || "").match(/[a-z0-9.]+|[%]/g) || [];
  return matches.map((value, index) => Object.freeze({ index, value }));
}

function buildNgrams(tokens, max = 4) {
  const out = [];
  for (let size = 2; size <= max; size += 1) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      out.push(Object.freeze({
        start: i,
        end: i + size - 1,
        value: tokens.slice(i, i + size).map(t => t.value).join(" "),
      }));
    }
  }
  return out;
}

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function weight(evidenceItem, perMatch) {
  if (!evidenceItem?.present) return 0;
  return Math.min(0.34, evidenceItem.count * perMatch);
}

function termsHaveAny(evidence, items) {
  const normalizedItems = new Set(items.map(normalize));
  return Object.values(evidence).some(value => value.matches?.some(m => normalizedItems.has(m)));
}

function dedupeFormats(items) {
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.extension)) return false;
    seen.add(item.extension);
    return true;
  });
}

module.exports = {
  VERSION,
  FORMAT_DEFINITIONS,
  analyzeRequestTokens,
  INTERNAL: {
    normalize,
    tokenize,
    buildNgrams,
    detectRequestedFormats,
    scoreIntents,
  },
};
