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

module.exports = {
  isAgenticActionRequest,
  isArtifactDeliverableRequest,
  ACTION_VERBS,
  CREATION_VERBS,
  ARTIFACT_NOUNS,
};
