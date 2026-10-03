'use strict';

/**
 * document-template-intent — did the user hand us a FORMAT to follow?
 *
 * «Crea una presentación de 8 láminas sobre marketing usando este formato»
 * + Plantilla-UPN.pptx, «con esta plantilla haz una ppt…» + formato.potx,
 * «pasa mi informe al formato de la plantilla» + informe.docx + plantilla.docx.
 * Before this module every one of those turns was a from-scratch creation:
 * the runner built a SiraGPT-themed deck (pptxgenjs / aurora) and the
 * attached template was reduced to an excerpt of «material de referencia».
 *
 * Pure and synchronous. Works on folded text (lower-case, no accents) and
 * on the staged upload names of the turn. Never throws.
 *
 *   detectTemplateIntent({ prompt, fileNames, priorArtifactNames })
 *     → { isTemplateFill, templateFile, contentFiles, outputFormat, reason }
 *
 * Decision: a template fill needs (a) a candidate template file — a Office
 * template extension (.potx/.dotx/.xltx) always qualifies, a .pptx/.docx/
 * .xlsx qualifies only together with a cue — and (b) a creation / conversion
 * intent (or two Office files, content + format). A scoped edit of the
 * attached file («cambia el título de la lámina 3 manteniendo el formato»)
 * is NOT a template fill: the cue keeps the format of the file being edited.
 */

const TEMPLATE_EXT_RE = /\.(potx|dotx|xltx)$/i;
const OFFICE_EXT_RE = /\.(pptx|pptm|potx|docx|docm|dotx|xlsx|xlsm|xltx)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i;

// A name that announces itself as the format: «Plantilla-UPN.pptx»,
// «formato_institucional.potx», «template.pptx», «modelo-informe.docx».
const TEMPLATE_NAME_RE = /(plantilla|template|formato|modelo|machote|master|maqueta|layout|institucional|corporativ|marca|brand|theme|tema)/i;

function fold(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const FORMAT_NOUN = '(?:formato|plantilla|template|diseno|estilo|layout|maquet\\w*|modelo|machote|master|tema|look)';
const DET = '(?:(?:el|la|este|esta|ese|esa|mi|mis|tu|su|nuestr[oa]|dich[oa]|el mismo|la misma|mismo|misma|siguiente|adjunt[oa])\\s+){0,3}';
// «con este formato», «usando esta plantilla», «siguiendo el diseño», «respetando el formato adjunto»,
// «en esta plantilla», «sobre la plantilla», «a partir de este formato», «según el modelo».
const TEMPLATE_CUE_RE = new RegExp(
  `\\b(?:con|usa(?:ndo|r|la|lo)?|utiliza(?:ndo|r)?|sigue|siguiendo|respeta(?:ndo|r)?|manten(?:iendo|er|ga)?|conserva(?:ndo|r)?|basad[oa]s? en|segun|en|sobre|dentro de|a partir de|aplica(?:ndo|r|le)?|toma(?:ndo|r)?|copia(?:ndo|r)?|replica(?:ndo|r)?|imita(?:ndo|r)?|adapta(?:ndo|r|lo|la)? (?:a|al))\\s+${DET}${FORMAT_NOUN}\\b`,
);
// «como este», «como esta», «igual a esta», «como el adjunto», «como la plantilla».
const LIKE_THIS_RE = /\b(?:como|igual (?:a|que)|parecid[oa] a|similar a|identic[oa] a|al estilo de)\s+(?:este|esta|el adjunto|la adjunta|el archivo|la plantilla|el formato|el modelo|el ejemplo|la muestra|el de referencia|la de referencia)\b/;
// «el formato adjunto», «la plantilla de la UPN», «formato institucional», «mismo formato».
const FORMAT_REF_RE = /\b(?:mismo|misma|mismos|mismas)\s+(?:formato|diseno|estilo|plantilla|look|estetica)\b|\b(?:formato|plantilla|template|modelo|machote)\s+(?:adjunt[oa]|de referencia|institucional|corporativ[oa]|oficial|de la (?:empresa|universidad|upn|institucion|compania)|que (?:te )?(?:adjunto|adjunte|mando|mande|envio|envie|paso|pase|subi|sub[ií]|comparto|comparti))\b/;
// Content → template transplant: «pasa mi informe al formato de la plantilla», «vuelca este contenido en la plantilla».
const TRANSPLANT_RE = /\b(?:pasa(?:r|lo|la|me)?|convierte(?:lo|la)?|convertir|transforma(?:r|lo|la)?|traslada(?:r|lo|la)?|vuelca(?:r|lo|la)?|vacia(?:r|lo|la)?|lleva(?:r|lo|la)?|mete(?:r|lo|la)?|pon(?:er|lo|la|ga)?|adapta(?:r|lo|la)?|aplica(?:r|le)?|monta(?:r|lo|la)?|arma(?:r|lo|la)?|rellena(?:r|lo|la)?|completa(?:r|lo|la)?|llena(?:r|lo|la)?)\b[^.?!]{0,80}\b(?:a|al|en|con|sobre|dentro de)\s+(?:el|la|este|esta|ese|esa|mi|su|dich[oa]|nuestr[oa])?\s*(?:mismo|misma|nuevo|nueva)?\s*(?:formato|plantilla|template|diseno|modelo|machote|maqueta|layout)\b/;
// Creation verbs (ES/EN): the deliverable is new; the template is its skin.
const CREATE_RE = /\b(?:crea\w*|genera\w*|haz(?:me|nos|lo|la)?|hacer|hagas|hazme|elabora\w*|redacta\w*|arma\w*|prepara\w*|produce\w*|construye\w*|desarrolla\w*|monta\w*|disena\w*|dame|damelo|damela|quiero (?:un|una)|necesito (?:un|una)|me (?:haces|armas|preparas|generas|creas) (?:un|una)|make|create|build|draft|generate|design|prepare|write)\b/;
const USE_RE = /\b(?:usa(?:r|ndo)?|utiliza(?:r|ndo)?|emplea(?:r|ndo)?|aprovecha(?:r|ndo)?)\b/;
// Deliverable nouns.
const DECK_RE = /\b(?:pptx?|powerpoint|power point|presentacion(?:es)?|diapositivas?|laminas?|slides?|deck|exposicion)\b/;
const DOC_RE = /\b(?:word|docx|documento|informe|reporte|tesis|monografia|ensayo|carta|oficio|memorando|memo|articulo|acta|propuesta|manual|guia|resumen ejecutivo|plan)\b/;
const SHEET_RE = /\b(?:excel|xlsx|hoja de calculo|planilla|spreadsheet|libro)\b/;
// Scoped edits that merely KEEP the format of the edited file.
const SCOPED_EDIT_RE = /\b(?:cambia\w*|modifica\w*|corrige\w*|reemplaza\w*|sustitu\w*|borra\w*|elimina\w*|quita\w*|mueve\w*|renombra\w*|actualiza\w*|arregla\w*|ajusta\w*|traduce\w*|parafrasea\w*|reescribe\w*|acorta\w*|alarga\w*)\b[^.?!]{0,60}\b(?:lamina|diapositiva|slide|parrafo|pagina|celda|titulo|subtitulo|texto|tabla|imagen|logo|fila|columna|hoja|seccion|capitulo|cifra|dato|fecha|nombre|palabra|frase)s?\b/;
const ADD_SLIDE_RE = /\b(?:agrega\w*|anade\w*|inserta\w*|incorpora\w*|suma\w*|pon(?:le|me|ga)?)\b[^.?!]{0,40}\b(?:lamina|diapositiva|slide|pagina|parrafo|seccion|capitulo|tabla|grafic[ao]|imagen|hoja)s?\b/;

function baseName(name) {
  return String(name || '').split(/[\\/]/).pop();
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(baseName(name));
  return m ? m[1].toLowerCase() : '';
}

/** Output format a template file produces when filled. */
function formatForTemplate(name) {
  switch (extOf(name)) {
    case 'pptx': case 'pptm': case 'potx': return 'pptx';
    case 'docx': case 'docm': case 'dotx': return 'docx';
    case 'xlsx': case 'xlsm': case 'xltx': return 'xlsx';
    default: return null;
  }
}

function requestedFormat(text) {
  if (DECK_RE.test(text)) return 'pptx';
  if (SHEET_RE.test(text)) return 'xlsx';
  if (DOC_RE.test(text)) return 'docx';
  return null;
}

/** Any wording that says «follow this file's format». */
function hasTemplateCue(prompt) {
  const text = fold(prompt);
  if (!text) return false;
  return TEMPLATE_CUE_RE.test(text) || LIKE_THIS_RE.test(text) || FORMAT_REF_RE.test(text) || TRANSPLANT_RE.test(text);
}

function pickTemplateFile(text, officeFiles, wantedFormat) {
  if (!officeFiles.length) return null;
  const byExt = officeFiles.filter((n) => TEMPLATE_EXT_RE.test(n));
  if (byExt.length) return byExt[0];
  const named = officeFiles.filter((n) => TEMPLATE_NAME_RE.test(baseName(n)));
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    const sameFormat = named.find((n) => formatForTemplate(n) === wantedFormat);
    return sameFormat || named[0];
  }
  if (officeFiles.length === 1) return officeFiles[0];
  // Content + format pair without a telling name: the format is the file
  // the user does NOT call «mi informe / este contenido»; prefer the one
  // whose format matches the requested deliverable, else the last upload
  // (people attach the content first and the template afterwards).
  const matching = officeFiles.filter((n) => formatForTemplate(n) === wantedFormat);
  if (matching.length === 1) return matching[0];
  return officeFiles[officeFiles.length - 1];
}

/**
 * @param {object} input
 * @param {string} input.prompt
 * @param {string[]} [input.fileNames]  uploads staged for this turn
 * @param {string[]} [input.priorArtifactNames]  files SiraGPT generated earlier (never a template candidate)
 */
function detectTemplateIntent({ prompt = '', fileNames = [], priorArtifactNames = [] } = {}) {
  const none = { isTemplateFill: false, templateFile: null, contentFiles: [], outputFormat: null, reason: 'no_template' };
  try {
    const text = fold(prompt);
    const prior = new Set((Array.isArray(priorArtifactNames) ? priorArtifactNames : []).map((n) => baseName(n).toLowerCase()));
    const names = (Array.isArray(fileNames) ? fileNames : [])
      .map((n) => (typeof n === 'string' ? n : (n && (n.name || n.originalName || n.filename)) || ''))
      .map(baseName)
      .filter((n) => n && !prior.has(n.toLowerCase()));
    const officeFiles = names.filter((n) => OFFICE_EXT_RE.test(n));
    if (!officeFiles.length) return none;

    const hasExtTemplate = officeFiles.some((n) => TEMPLATE_EXT_RE.test(n));
    const cue = hasTemplateCue(text);
    const create = CREATE_RE.test(text);
    const transplant = TRANSPLANT_RE.test(text);
    const twoOffice = officeFiles.length >= 2;
    // «usa esta plantilla para una ppt de 6 láminas»: the deliverable noun
    // makes the use-verb a creation.
    const useFor = USE_RE.test(text) && (DECK_RE.test(text) || DOC_RE.test(text) || SHEET_RE.test(text));
    const scopedEdit = (SCOPED_EDIT_RE.test(text) || ADD_SLIDE_RE.test(text)) && !create && !transplant && !useFor;

    if (scopedEdit) return { ...none, reason: 'scoped_edit' };
    if (!hasExtTemplate && !cue) return none;
    // A .potx/.dotx alone with no wording is still a template: nothing else
    // can be done with it («aquí está el formato, hazme la ppt de X»).
    if (!create && !transplant && !useFor && !twoOffice && !hasExtTemplate && !LIKE_THIS_RE.test(text)) {
      return { ...none, reason: 'no_creation_intent' };
    }

    const wanted = requestedFormat(text) || formatForTemplate(officeFiles.find((n) => TEMPLATE_EXT_RE.test(n)) || officeFiles[0]);
    const templateFile = pickTemplateFile(text, officeFiles, wanted);
    if (!templateFile) return none;
    const outputFormat = formatForTemplate(templateFile) || wanted;
    const contentFiles = names.filter((n) => n !== templateFile && !IMAGE_EXT_RE.test(n));
    return {
      isTemplateFill: true,
      templateFile,
      contentFiles,
      outputFormat,
      reason: hasExtTemplate ? 'template_extension' : (transplant ? 'transplant_cue' : (twoOffice ? 'content_plus_template' : 'format_cue')),
    };
  } catch (_) {
    return none;
  }
}

/**
 * Spanish line for the «Analizando tu mensaje» row / brief constraint.
 */
function describeTemplateIntent(intent) {
  if (!intent || !intent.isTemplateFill) return '';
  return `siguiendo el formato de «${intent.templateFile}»`;
}

module.exports = {
  detectTemplateIntent,
  describeTemplateIntent,
  hasTemplateCue,
  formatForTemplate,
  TEMPLATE_EXT_RE,
  _internal: { fold, pickTemplateFile, TEMPLATE_CUE_RE, LIKE_THIS_RE, FORMAT_REF_RE, TRANSPLANT_RE, SCOPED_EDIT_RE },
};
