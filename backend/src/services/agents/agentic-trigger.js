'use strict';

/**
 * Agentic action-request detector.
 *
 * Decides whether a user chat message is asking the assistant to DO or
 * CREATE something that should be handled by the agentic tool-calling
 * runtime (documents, spreadsheets, slides, images, video, charts,
 * diagrams, organigrams, infographics, research, code, analysis) instead
 * of a plain conversational answer.
 *
 * Bilingual (Spanish + English). Pure, dependency-free function so it can
 * run on the hot path of every chat turn and be unit-tested in isolation.
 *
 * Design notes:
 * - Leading word-boundary (\b) on each alternative avoids most mid-word
 *   false positives (e.g. "remake" must not match "make"). No trailing
 *   boundary, so verb conjugations and noun plurals still match
 *   ("generando", "diagramas", "creating").
 * - Recall is favoured over precision on purpose: a missed create request
 *   (false negative) means the user gets a text description instead of the
 *   artifact they asked for, which defeats the product goal. A false
 *   positive merely routes a benign message through the agent, which still
 *   answers normally via its final-answer step.
 * - The most ambiguous bare nouns (tabla / código / informe / app …) are
 *   deliberately NOT standalone triggers; they fire only when paired with
 *   an action verb ("hazme una tabla", "escribe un informe").
 */

// Spanish + English creation / transformation / analysis verbs (stems).
const ACTION_VERBS = new RegExp(
  '\\b(' +
    [
      // Spanish (stems catch conjugations: crea/crear/creando/creación …)
      // NOTE: pure text-composition verbs (redact/escrib/resum/traduc and the
      // English writ/draft/compose/summari[sz]e/translat) are deliberately NOT
      // listed. They produce plain text, not a tool-backed artifact, and routing
      // "redacta esto en 9 líneas" / "resume este párrafo" / "traduce esta frase"
      // through the agentic loop was slow and could intermittently return an
      // empty answer ("El asistente dejó de responder"). When such a request
      // genuinely targets a deliverable ("redacta un documento Word", "resume
      // esto a un PDF") the ARTIFACT_NOUNS branch below still catches it.
      'cr[eé]a', 'gener', 'dise[ñn]', 'construy', 'hazme', 'haz', 'h[aá]game',
      'elabor', 'prepar', 'dibuj', 'grafic', 'export',
      'convier', 'convert', 'transform', 'analiz', 'investig',
      'program', 'codific', 'desarroll', 'implement', 'calcul', 'busca', 'buscar',
      'plote', 'maqueta', 'esquematiza', 'visualiza', 'compila', 'rellena',
      // English
      'creat', 'generat', 'build', 'mak(e|ing)', 'design', 'draw', 'plot', 'render',
      'analy[sz]e', 'research',
      'develop', 'visuali[sz]e', 'compile', 'diagram',
    ].join('|') +
    ')',
  'i',
);

// Unambiguous artifact / deliverable nouns that imply a tool-backed output.
const ARTIFACT_NOUNS = new RegExp(
  '\\b(' +
    [
      'documento', 'docx', 'word', 'pdf', 'excel', 'xlsx', 'csv', 'spreadsheet',
      'hoja de c[aá]lculo', 'presentaci[oó]n', 'powerpoint', 'pptx', 'diapositiv',
      'slide', 'organigram', 'infograf', 'diagram', 'flowchart', 'mapa mental',
      'mindmap', 'l[ií]nea de tiempo', 'cronograma', 'timeline', 'gantt',
      'dashboard', 'tablero', 'kanban', 'swot', 'dafo', 'foda', 'pestel',
      'gr[aá]fic', 'chart', 'p[oó]ster', 'afiche', 'plantilla', 'template',
      'mermaid', 'boceto', 'wireframe', 'mockup', 'storyboard', 'presupuesto',
      'imagen', 'im[aá]gen', 'foto', 'video', 'v[ií]deo',
    ].join('|') +
    ')',
  'i',
);

// Verbs that mean "produce / transform into" an artifact — the creation/
// transformation subset of ACTION_VERBS, excluding the analysis/search/
// research stems (analiz / investig / busca). Those last three describe
// reading-about an input, not building a new deliverable, so on an
// attachment turn "analiza este documento" stays on the plain stream.
const CREATION_VERBS = new RegExp(
  '\\b(' +
    [
      // Spanish
      'cr[eé]a', 'gener', 'dise[ñn]', 'construy', 'hazme', 'haz', 'h[aá]game',
      'elabor', 'prepar', 'dibuj', 'grafic', 'export', 'convi[eé]rt', 'convert',
      'transform', 'program', 'codific', 'desarroll', 'implement', 'plote',
      'maqueta', 'esquematiza', 'visualiza', 'compila', 'rellena',
      // English
      'creat', 'generat', 'build', 'mak(e|ing)', 'design', 'draw', 'plot',
      'render', 'develop', 'visuali[sz]e', 'compile', 'diagram', 'turn into',
    ].join('|') +
    ')',
  'i',
);

/**
 * @param {string} text user message (any case)
 * @returns {boolean} true when the message should enter the agentic runtime
 */
function isAgenticActionRequest(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  if (ARTIFACT_NOUNS.test(t)) return true;
  if (ACTION_VERBS.test(t)) return true;
  return false;
}

/**
 * Attachment-turn gate: true only when the message asks to BUILD a tool-backed
 * deliverable FROM the attached doc (a creation/transformation verb applied to
 * an artifact noun — "genera una tabla en Excel", "conviértelo a PDF"), vs.
 * merely asking ABOUT it ("qué dice el documento", "resume esto"). Requiring
 * BOTH a verb and a noun stops ambiguous reference words ("el documento", "el
 * presupuesto") from mis-routing plain Q&A into the slow react-agent loop.
 *
 * @param {string} text user message (any case)
 * @returns {boolean}
 */
function isArtifactDeliverableRequest(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  return CREATION_VERBS.test(t) && ARTIFACT_NOUNS.test(t);
}

// STRONG mutation verbs: an imperative command to change the document's
// CONTENT. On an attachment turn these are unmistakable edits even with no
// document noun ("borra el jurado evaluador", "agrega una conclusión",
// "elimina los anexos") — the only plausible target is the attached file.
// They do NOT appear in plain doc-Q&A ("¿qué dice?", "resume", "explica").
const STRONG_EDIT_VERBS = new RegExp(
  '\\b(' +
    [
      // Spanish — delete / remove
      'borra', 'borre', 'borrar', 'elimin', 'quita', 'quite', 'quitar',
      'suprim', 'remov', 'remueve', 'tacha', 'descarta', 's[aá]cale', 's[aá]calo',
      // Spanish — insert / add
      'agrega', 'agr[eé]ga', 'a[ñn]ad', 'inserta', 'incorpora', 'incluye',
      // Spanish — edit / replace / restructure
      'edita', 'edit[aá]', 'modific', 'corrig', 'correg', 'reemplaz', 'sustitu',
      'renombr', 'reescrib', 'reorganiz', 'reformate', 'reordena', 'reenumera',
      // English
      'delete', 'remove', 'erase', 'strip out', 'strike',
      'add ', 'insert', 'append',
      'edit', 'modify', 'replac', 'rewrite', 'reformat', 'rename', 'reorder',
    ].join('|') +
    ')',
  'i',
);

// WEAK edit verbs: also used in chit-chat / Q&A follow-ups ("cambia de tema",
// "actualízame", "arréglate"), so they only count as a document edit when a
// document/file noun is also present.
const WEAK_EDIT_VERBS = /\b(cambia\w*|c[aá]mbia\w*|c[aá]mbi[aá]le|actualiz\w*|arregl\w*|p[oó]nle|ponle|mejora\w*|ajusta\w*|update\w*|change\w*|fix the|improve\w*|adjust\w*)\b/i;

// Nouns that, on an ATTACHMENT turn, unambiguously refer to the attached file
// itself or a concrete document instance (complementing ARTIFACT_NOUNS, which
// targets deliverable formats). Used to disambiguate WEAK edit verbs; STRONG
// verbs need no noun.
const ATTACHED_FILE_NOUNS = /\b(archivo|adjunto|attached file|attachment|file|documento|doc|informe|reporte|report|contrato|contract|ensayo|tesis|curr[ií]culum|\bcv\b|carta|acta|memorando|propuesta|proposal|secci[oó]n|p[aá]rrafo|t[ií]tulo|tabla|p[aá]gina|encabezado|pie de p[aá]gina|columna|fila)\b/i;

// Back-compat export: the combined verb regex (strong ∪ weak).
const EDIT_VERBS = new RegExp(`${STRONG_EDIT_VERBS.source}|${WEAK_EDIT_VERBS.source}`, 'i');

/**
 * Attachment-turn gate for EDIT requests. Called ONLY when a file is attached
 * (shouldUseAgenticChat already requires files.length > 0), so an imperative
 * mutation verb alone is enough — the attached file is the only plausible
 * target. WEAK verbs additionally need a document/file noun. This is where the
 * `document_edit` (Cowork-style sandbox editing) tool lives.
 *
 * Examples that MUST route: "borra el jurado evaluador", "elimina los anexos",
 * "agrega una conclusión", "edita mi documento", "cambia el título del informe".
 * Examples that MUST NOT: "¿qué dice?", "resume esto", "explica el documento".
 *
 * @param {string} text user message (any case)
 * @returns {boolean}
 */
function isDocumentEditRequest(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  if (STRONG_EDIT_VERBS.test(t)) return true;
  return WEAK_EDIT_VERBS.test(t) && (ARTIFACT_NOUNS.test(t) || ATTACHED_FILE_NOUNS.test(t));
}

module.exports = {
  isAgenticActionRequest,
  isArtifactDeliverableRequest,
  isDocumentEditRequest,
  ACTION_VERBS,
  CREATION_VERBS,
  ARTIFACT_NOUNS,
  EDIT_VERBS,
};
