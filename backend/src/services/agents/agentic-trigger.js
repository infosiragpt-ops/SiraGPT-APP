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
      'realiz', 'elabor', 'prepar', 'dibuj', 'grafic', 'export',
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
      'hoja de c[aá]lculo', 'presentaci[oó]n', 'powerpoint', 'pptx?', 'ppts?', 'diapositiv',
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
      'realiz', 'elabor', 'prepar', 'dibuj', 'grafic', 'export', 'convi[eé]rt', 'convert',
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
      // Stems, so subjunctive/polite forms route too ("quiero que agregues",
      // "que insertes", "incorpores"), not only the bare imperative.
      'agreg', 'agr[eé]g', 'a[ñn]ad', 'insert', 'incorpor', 'incluye', 'incluyas',
      // Spanish — edit / replace / restructure
      'edita', 'edit[aá]', 'edites', 'modific', 'corrig', 'correg', 'reemplaz', 'sustitu',
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
const WEAK_EDIT_VERBS = /\b(complet\w*|llen[aeo]\w*|rellen\w*|diligenci\w*|cambia\w*|c[aá]mbia\w*|c[aá]mbi[aá]le|actualiz\w*|arregl\w*|p[oó]nle|ponle|mejora\w*|ajusta\w*|update\w*|change\w*|fix the|improve\w*|adjust\w*|uniformi[zs]\w*|unific\w*|pinta\w*|colorea\w*|deja\w*|aplica\w*)\b/i;

const STYLE_EDIT_VERBS = /\b(uniformi[zs]\w*|unific\w*|pinta\w*|colorea\w*|deja\w*|aplica\w*|pasa\w*|pon(?:er|ga|le|me|lo|la)?|cambia\w*|haz\w*)\b/i;
const STYLE_EDIT_NOUNS = /\b(color(?:es)?|fondo|fondos|background|paleta|tipograf\w*)\b/i;

function isDocumentStyleEditRequest(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  return STYLE_EDIT_VERBS.test(t) && (STYLE_EDIT_NOUNS.test(t) || ARTIFACT_NOUNS.test(t));
}

const DOCUMENT_CORRECTION_NOUNS = /\b(correcci[oó]n(?:es)?|ortograf[ií]a|gram[aá]tica|redacci[oó]n|erratas?|errores?)\b/i;
const DOCUMENT_CORRECTION_ACTIONS = /\b(aplic\w*|haz|hacer|realiz\w*|corrig\w*|correg\w*|revis\w*|arregl\w*|ajust\w*|mejora\w*)\b/i;

function isDocumentCorrectionEditRequest(text) {
  const t = String(text == null ? '' : text);
  return DOCUMENT_CORRECTION_NOUNS.test(t) && DOCUMENT_CORRECTION_ACTIONS.test(t);
}

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
  if (isDocumentCorrectionEditRequest(t)) return true;
  if (isDocumentStyleEditRequest(t)) return true;
  if (STRONG_EDIT_VERBS.test(t)) return true;
  if (WEAK_EDIT_VERBS.test(t) && (ARTIFACT_NOUNS.test(t) || ATTACHED_FILE_NOUNS.test(t))) return true;
  return isFuzzyDocumentEditRequest(t);
}

// Typo / caps / accent tolerant fallback («QIERO QUE AGREGES COMENTARIOS EN
// OBSERVACIONES», «modifiqes el titulo»): a word within one edit of an edit
// verb stem plus something that lives in a document. Read-only openers
// (explica, resume, qué dice…) never count.
const FUZZY_EDIT_STEMS = ['agreg', 'anad', 'anhad', 'insert', 'incorpor', 'inclu', 'met', 'pon', 'ponl', 'coloc', 'escrib', 'redact',
  'complet', 'llen', 'rellen', 'marc', 'coment', 'edit', 'modif', 'modific', 'corrig', 'correg', 'cambi', 'reempl',
  'sustitu', 'actualiz', 'quit', 'borr', 'elimin', 'mejor', 'arregl', 'ajust', 'renombr', 'reescrib', 'traduc', 'numer'];
const FUZZY_DOC_TARGET_RE = /\b(?:documento|archivo|word|docx|excel|xlsx|hoja|celda|fila|columna|tabla|powerpoint|pptx|presentacion|diapositiva|slide|pdf|titulo|subtitulo|parrafo|seccion|capitulo|pagina|portada|anexo|informe|tesis|introduccion|conclusion(?:es)?|bibliografia|referencias|indice|encabezado|pie de pagina|vinetas?|grafico|observacion(?:es)?|comentarios?|campos?|casillas?|firma|formulario|matriz|ficha|items?|preguntas?|respuestas?|notas?|texto)\b/;
const FUZZY_READ_ONLY_RE = /^\s*(?:explica|explicame|describe|resume|resumeme|analiza|revisa|que|como|por que|dime|cual|cuales|cuanto|no (?:edites|modifiques|reescribas|cambies))\b/;

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// One-edit tolerance only against stems of 5+ letters: shorter stems make
// ordinary words look like verbs ("comercial" ~ "comen").
function fuzzyEditVerb(word) {
  if (word.length < 3) return false;
  return FUZZY_EDIT_STEMS.some((stem) => word.startsWith(stem)
    || (word.length >= 6 && stem.length >= 5 && editDistanceAtMostOne(word.slice(0, stem.length), stem)));
}

// "genera un documento nuevo de propuesta" creates, it does not edit.
const FUZZY_NEW_DOC_RE = /\b(?:gener\w*|cre\w*|elabor\w*|produc\w*|haz(?:me)?|hacer|arma\w*|dise[nñ]\w*)\b[^.;\n]{0,60}\b(?:nuev[oa]s?|desde cero|otro|otra)\b|\b(?:nuev[oa]s?)\s+(?:documento|archivo|informe|word|excel|ppt|pptx|presentacion|reporte)\b/;

function isFuzzyDocumentEditRequest(text) {
  const t = String(text == null ? '' : text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\\_/g, '_').replace(/#+\s*/g, ' ')
    .replace(/\S+\.(?:docx?|xlsx?|xlsm|pptx?|pdf|odt|ods|odp|csv|rtf)\b/g, ' ')
    .replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || FUZZY_READ_ONLY_RE.test(t) || !FUZZY_DOC_TARGET_RE.test(t)) return false;
  if (FUZZY_NEW_DOC_RE.test(t) && !STRONG_EDIT_VERBS.test(t)) return false;
  return t.split(' ').some(fuzzyEditVerb);
}

module.exports = {
  isAgenticActionRequest,
  isFuzzyDocumentEditRequest,
  isArtifactDeliverableRequest,
  isDocumentEditRequest,
  isDocumentStyleEditRequest,
  ACTION_VERBS,
  CREATION_VERBS,
  ARTIFACT_NOUNS,
  EDIT_VERBS,
};
