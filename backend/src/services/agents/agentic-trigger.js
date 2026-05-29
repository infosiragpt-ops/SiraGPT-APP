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
      'cr[eé]a', 'gener', 'dise[ñn]', 'construy', 'hazme', 'haz', 'h[aá]game',
      'elabor', 'prepar', 'redact', 'escrib', 'dibuj', 'grafic', 'export',
      'convier', 'convert', 'transform', 'analiz', 'investig', 'resum', 'traduc',
      'program', 'codific', 'desarroll', 'implement', 'calcul', 'busca', 'buscar',
      'plote', 'maqueta', 'esquematiza', 'visualiza', 'compila', 'rellena',
      // English
      'creat', 'generat', 'build', 'mak(e|ing)', 'design', 'draw', 'plot', 'render',
      'writ', 'draft', 'compose', 'analy[sz]e', 'research', 'summari[sz]e',
      'translat', 'develop', 'visuali[sz]e', 'compile', 'diagram',
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

module.exports = { isAgenticActionRequest, ACTION_VERBS, ARTIFACT_NOUNS };
