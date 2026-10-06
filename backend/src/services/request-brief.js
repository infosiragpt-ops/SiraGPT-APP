'use strict';

/**
 * request-brief — ONE structured reading of what the user asked in this turn.
 *
 * Before this module the chat route decided «¿editar un archivo o responder
 * en texto?», «¿crear o modificar?», «¿sobre qué?» with 30+ independent regex
 * classifiers that only looked at the raw prompt. The brief computes a single
 * answer once per turn — action, deliverable, target (attachment / generated
 * artifact / previous answer), constraints and ambiguity — from the prompt
 * PLUS the conversation (recent turns, this turn's attachments, the chat's
 * latest generated artifact, resolved coreferences, repair detection). The
 * route then (1) shows it to the user as the closing label of the
 * «Analizando tu mensaje» row («Entendí: editar la presentación generada ·
 * color azul»), (2) sends it as a typed SSE frame so the UI can offer a
 * one-click correction, (3) injects it as a tier-0 system block so the model
 * executes exactly that, (4) lets it steer the routing gates that the regex
 * classifiers used to miss («ahora en azul» → edit the generated deck;
 * «agrega 2 ejemplos a tu explicación» → extend the answer, never a file),
 * and (5) asks ONE clarifying question with options when the request has no
 * source at all («tradúcelo» with nothing attached and no history).
 *
 * Pure and synchronous (`buildRequestBrief`); the optional fast-LLM
 * refinement (`refineRequestBriefWithLlm`) is fail-open: any failure keeps
 * the deterministic brief. Every regex works on folded text (lower-case, no
 * accents) so «Tradúcelo» / «traducelo» / «TRADUCELO» read the same.
 *
 * Env: SIRAGPT_REQUEST_BRIEF=0 disables the whole feature;
 * SIRAGPT_REQUEST_BRIEF_LLM=0 disables the refinement (on by default when the
 * free tier is configured); SIRAGPT_REQUEST_BRIEF_LLM_TIMEOUT_MS (900).
 */

const ACTIONS = Object.freeze([
  'create', 'edit', 'answer', 'analyze', 'transform', 'search', 'visualize', 'code', 'continue', 'converse',
]);
const DELIVERABLE_KINDS = Object.freeze([
  'presentation', 'document', 'spreadsheet', 'pdf', 'image', 'chart', 'diagram', 'table', 'code', 'media',
  'translation', 'summary', 'text', 'transcription',
]);
const TARGET_KINDS = Object.freeze(['attachment', 'generated_artifact', 'previous_answer', 'url', 'none']);
const URL_RE = /\bhttps?:\/\/[^\s<>()\]«»"']+/i;
const TIME_RANGE_RE = /\b(?:del?\s+)?(?:minuto|min|segundo|hora)?\s*(\d{1,2}(?:[:.,]\d{1,2}){0,2})\s*(?:al?|hasta|a el|-|–|—|to)\s+(?:el\s+)?(?:minuto|min|segundo|hora)?\s*(\d{1,2}(?:[:.,]\d{1,2}){0,2})\b/;
const OFFICE_FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'csv']);
const ASK_THRESHOLD = 0.75;
const MAX_SUMMARY_CHARS = 80;
const MAX_OPTIONS = 4;

function fold(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function wordCount(text) {
  return fold(text).split(' ').filter(Boolean).length;
}

// ─── Lexicons (folded Spanish + English) ─────────────────────────────────

const DELIVERABLE_RES = [
  ['presentation', /\b(?:pptx?|powerpoint|presentacion(?:es)?|diapositivas?|slides?|laminas?|deck|keynote)\b/],
  ['spreadsheet', /\b(?:excel|xlsx|hoja de calculo|hojas de calculo|planilla|spreadsheet|libro de excel)\b/],
  ['pdf', /\bpdf\b/],
  ['document', /\b(?:word|docx|documento|informe|reporte|ensayo|carta|oficio|memorando|memo|tesis|monografia|articulo|acta|contrato|curriculum|cv|manual|guia|propuesta|minuta|redaccion|escrito|texto formal)\b/],
  ['chart', /\b(?:grafic[ao]s?|chart|plot|histograma|barras|torta|pastel|dashboard|kpi)\b/],
  ['diagram', /\b(?:diagramas?|organigrama|mapa (?:mental|conceptual)|flujo(?:grama)?|mermaid|infografia|linea de tiempo|timeline|kanban|foda|swot|dafo|canvas|matriz (?:raci|eisenhower|bcg|ansoff|de riesgos?)|embudo|funnel|pestel|porter)\b/],
  ['table', /\b(?:tabla|cuadro comparativo|comparativa|listado)\b/],
  ['image', /\b(?:imagen(?:es)?|fotos?|fotografias?|ilustracion(?:es)?|logo(?:tipos?)?|poster|cartel|banner|dibujo|avatar|icono|picture|image|render)\b/],
  ['media', /\b(?:videos?|audios?|cancion(?:es)?|musica|voz|locucion|podcast|animacion)\b/],
  ['code', /\b(?:codigo|script|funcion|programa|api|endpoint|componente|aplicacion|app|pagina web|landing|sitio web|web app|html|css|javascript|typescript|python|sql|regex|consulta sql|algoritmo|clase|modulo|test unitario|tests?)\b/],
  ['translation', /\b(?:traduc\w*|translat\w*)\b/],
  // Typo-tolerant: «transcirbir», «trascribir», «trasncribir», «transcipcion».
  ['transcription', /\b(?:transcri\w*|transcirb\w*|trascri\w*|trasncri\w*|transcip\w*|transcrip\w*|subtitul\w*|subtitle\w*|pasa(?:lo|la)? a texto|audio a texto|voz a texto)\b/],
  ['summary', /\b(?:resum\w*|sintesis|sintetiza\w*|summar\w*|tl;?dr|abstract|resumen ejecutivo)\b/],
];

const FORMAT_WORDS = [
  ['pptx', /\b(?:pptx?|powerpoint|presentacion(?:es)?|diapositivas?|slides?)\b/],
  ['docx', /\b(?:word|docx)\b/],
  ['xlsx', /\b(?:excel|xlsx|hoja de calculo|planilla)\b/],
  ['pdf', /\bpdf\b/],
  ['csv', /\bcsv\b/],
  ['png', /\bpng\b/],
  ['svg', /\bsvg\b/],
  ['md', /\bmarkdown\b|\bmd\b/],
];

const FORMAT_LABEL = Object.freeze({
  pptx: 'PowerPoint (.pptx)', docx: 'Word (.docx)', xlsx: 'Excel (.xlsx)', pdf: 'PDF', csv: 'CSV',
  png: 'imagen PNG', svg: 'SVG', md: 'Markdown', html: 'página HTML', txt: 'texto',
});

const DELIVERABLE_LABEL = Object.freeze({
  presentation: 'una presentación', document: 'un documento Word', spreadsheet: 'una hoja de Excel', pdf: 'un PDF',
  image: 'una imagen', chart: 'una gráfica', diagram: 'un diagrama', table: 'una tabla', code: 'código',
  media: 'un archivo multimedia', translation: 'una traducción', summary: 'un resumen', text: 'una respuesta en texto',
  transcription: 'una transcripción',
});

const DEFAULT_FORMAT = Object.freeze({
  presentation: 'pptx', document: 'docx', spreadsheet: 'xlsx', pdf: 'pdf', diagram: 'svg', image: 'png',
});

const CREATE_RE = /\b(?:crea\w*|genera\w*|haz(?:me|nos)?|hacer|hagas|elabora\w*|redacta\w*|escribe\w*|escribi\w*|disena\w*|arma\w*|prepara\w*|produce\w*|construye\w*|desarrolla\w*|monta\w*|dame|damelo|damela|quiero (?:un|una|el|la)|necesito (?:un|una|el|la)|me (?:haces|armas|preparas|generas|creas) (?:un|una)|make|create|build|write|draft|generate|design)\b/;
const EDIT_RE = /\b(?:edita\w*|modifica\w*|cambia\w*|reemplaza\w*|sustitu\w*|corrige\w*|corregi\w*|arregla\w*|ajusta\w*|actualiza\w*|agrega\w*|anade\w*|anadi\w*|inserta\w*|incorpora\w*|incluye\w*|quita\w*|elimina\w*|borra\w*|mueve\w*|reordena\w*|renombra\w*|acorta\w*|alarga\w*|amplia\w*|extiende\w*|expande\w*|mejora\w*|pule\w*|reescribe\w*|reformula\w*|parafrasea\w*|pon(?:le|lo|la|los|las|me|ga|gas|gale|galo|gala)?|coloca\w*|destaca\w*|resalta\w*|subraya\w*|numera\w*|formatea\w*|completa\w*|rellena\w*|dejalo|dejala|edit|change|replace|fix|update|add|remove|delete|rewrite|improve|shorten|expand|tweak)\b/;
const ANALYZE_RE = /\b(?:analiza\w*|revisa\w*|evalua\w*|resum\w*|sintetiza\w*|extrae\w*|identifica\w*|compara\w*|interpreta\w*|clasifica\w*|verifica\w*|comprueba\w*|audita\w*|critica\w*|valora\w*|detecta\w*|analy[sz]e|review|summar\w*|compare|evaluate|extract)\b/;
const TRANSFORM_RE = /\b(?:traduc\w*|convierte\w*|convertir|transforma\w*|exporta\w*|pasa(?:lo|la|los|las)? a|pasar a|pasame\w* a|translate|convert|export)\b/;
const SEARCH_RE = /\b(?:busca\w*|investiga\w*|averigua\w*|encuentra\w*|consulta\w*|que hay de nuevo|ultimas noticias|noticias de|precio actual|cotizacion|hoy en|esta semana|search|look up|find out|latest)\b/;
const VISUALIZE_RE = /\b(?:grafica\w*|visualiza\w*|plotea\w*|dibuja\w*|diagrama\w*|esquematiza\w*|plot|graph|visuali[sz]e|draw)\b/;
const CODE_RE = /\b(?:programa\w*|codifica\w*|implementa\w*|refactoriza\w*|depura\w*|debug\w*|compila\w*|despliega\w*|testea\w*|optimiza el codigo|arregla el bug|code|implement|refactor)\b/;
const WRITE_RE = /\b(?:escribe\w*|redacta\w*|escribi\w*|compon\w*|write|draft|compose)\b|\b(?:correos?|emails?|cartas?|posts?|publicacion(?:es)?|mensajes?|discursos?|poemas?|cuentos?|historias?|guion(?:es)?|articulos?|ensayos?|descripcion(?:es)?|biografias?|slogan(?:es)?|eslogan(?:es)?|copy|anuncios?|textos?|parrafos?|introduccion|conclusion(?:es)?|resenas?|cronicas?|relatos?|cancion(?:es)?|letras?)\b/;
const QUESTION_RE = /^(?:[¿]\s*)?(?:que|como|cuando|donde|por que|porque|para que|cual(?:es)?|cuant[oa]s?|quien(?:es)?|es|son|hay|existe\w*|puedes explicar|explica\w*|dime|cuentame|define\w*|significa|describe\w*|sabes|conoces|me puedes decir|what|how|why|when|where|which|who|is|are|does|do|can you explain|explain|tell me)\b/;
const CONTINUE_RE = /^(?:[¿¡]\s*)?(?:y\s+)?(?:sigue|continua|continue|adelante|dale|ok|okay|vale|listo|otra vez|de nuevo|repite|repitelo|mas|more|go on|next|siguiente)\b/;
const CHITCHAT_RE = /^(?:[¿¡]\s*)?(?:hola|hi|hello|hey|buenas|buenos dias|buenas tardes|buenas noches|que tal|como estas|como vas|gracias|muchas gracias|mil gracias|perfecto|genial|excelente|entendido|de acuerdo|adios|chao|hasta luego|bye|jaja+|xd)[\s!.?¿¡,]*$/;

// References to what the ASSISTANT wrote (never a file).
const PREVIOUS_CONTENT_RE = /\b(?:esta informacion|esa informacion|esta info|este texto|ese texto|estos datos|esos datos|lo anterior|la (?:grafica|tabla|lista|informacion|respuesta|explicacion) (?:anterior|previa|de arriba)|el (?:grafico|texto|codigo|resumen|analisis) (?:anterior|previo|de arriba)|los datos anteriores|lo que (?:me )?(?:diste|dijiste|escribiste|respondiste|explicaste|generaste)|con (?:esto|eso)|de (?:esto|eso)|a partir de (?:esto|eso|lo anterior)|basado en (?:esto|eso|lo anterior)|con esta|con esa)\b/;
const PREVIOUS_ANSWER_RE = /\b(?:tu (?:respuesta|explicacion|texto|resumen|propuesta|redaccion|codigo|lista|analisis|mensaje|version|ejemplo|parrafo|traduccion|idea|plan|borrador)|la (?:respuesta|explicacion|lista|version|traduccion) (?:anterior|previa|de arriba)|lo que (?:me )?(?:dijiste|escribiste|respondiste|explicaste|propusiste|redactaste|pusiste|contaste)|eso que (?:dijiste|escribiste|pusiste)|lo anterior|en lo anterior|a lo anterior|el (?:texto|parrafo|punto|codigo) (?:anterior|de arriba)|your (?:answer|explanation|response|text|code)|what you (?:said|wrote))\b/;
// References to a file the assistant produced earlier in the chat.
const GENERATED_ARTIFACT_RE = /\b(?:(?:el|la|ese|esa|este|esta|al|del|dicho|dicha|mi|tu|su)\s+(?:word|docx|documento|archivo|ppt|pptx|presentacion|deck|excel|xlsx|hoja|planilla|pdf|informe|reporte|tabla de excel|libro)|(?:documento|archivo|presentacion|ppt|excel|word|pdf|informe|reporte)\s+(?:que|anterior|previo|previa|generad\w*|cread\w*|entregad\w*)|que (?:me )?(?:generaste|creaste|hiciste|entregaste|diste|armaste|preparaste|exportaste)|(?:generad|cread|entregad)[oa]s?\b|la misma (?:ppt|presentacion|hoja|tabla)|el mismo (?:documento|archivo|word|excel|informe))\b/;
// Edits of appearance: belong to the file, never to a text answer.
const STYLE_RE = /\b(?:color(?:es)?|azul(?:es)?|roj[oa]s?|verdes?|amarill[oa]s?|naranjas?|morad[oa]s?|violetas?|rosa(?:d[oa]s?)?|negr[oa]s?|blanc[oa]s?|gris(?:es)?|celestes?|turquesas?|dorad[oa]s?|platead[oa]s?|fondo|tipografia|fuente|letra|tamano|mas grande|mas pequeno|negrita|cursiva|diseno|estilo|plantilla|tema|portada|logo|margenes?|interlineado|alineacion|centrado|encabezado|pie de pagina|slide|diapositiva|lamina|celda|columna|fila|hoja|pestana|grafico|imagen de fondo|iconos?|bonit[oa]|elegante|profesional|moderno|minimalista|corporativo)\b/;
// Pronominal / anchored follow-ups («ponlo», «ahora», «también», «lo mismo»).
const CLITIC_RE = /\b(?:ponlo|ponla|ponlos|ponlas|ponle|ponles|hazlo|hazla|hazlos|hazlas|cambialo|cambiala|cambialos|cambialas|cambiale|agregalo|agregala|agregale|anadelo|anadela|anadele|quitalo|quitala|quitale|traducelo|traducela|traducemelo|resumelo|resumela|resumemelo|explicalo|explicala|explicamelo|mejoralo|mejorala|corrigelo|corrigela|amplialo|ampliala|acortalo|acortala|reescribelo|reescribela|conviertelo|conviertela|exportalo|exportala|pasalo|pasala|pasamelo|dejalo|dejala|insertalo|insertala|incluyelo|incluyela|muevelo|muevela|arreglalo|arreglala|ajustalo|ajustala|actualizalo|actualizala|guardalo|guardala|enviamelo|mandamelo|descargalo|repitelo|detallalo|desarrollalo|simplificalo|formatealo|numeralo|ordenalo|revisalo|revisala|completalo|completala|redactalo|redactala)\b/;
const FOLLOWUP_ANSWER_RE = /\b(?:el punto \d+|la parte \d+|la seccion \d+|el paso \d+|la opcion \d+|el (?:primero|segundo|tercero|ultimo) punto|con mas detalle|mas detalle|mas a fondo|profundiza\w*|amplia\w*|desarrolla (?:mas|eso|esto)|(?:de|sobre|en) (?:eso|esto|lo anterior|lo que dijiste)|que opinas|y (?:eso|esto)\b)/;
const ANCHOR_RE = /^(?:[¿¡]\s*)?(?:y\s+)?(?:ahora|tambien|ademas|luego|despues|pero|mejor|solo|igual|lo mismo|eso|esto|eso mismo|otra version|otra vez|de nuevo|en vez de|en lugar de)\b/;

// Constraints.
const LANGUAGE_RE = /\b(?:en|al|to|in)\s+(ingles|espanol|castellano|portugues|frances|aleman|italiano|chino|japones|coreano|ruso|arabe|catalan|euskera|gallego|quechua|english|spanish|portuguese|french|german|italian)\b/;
const LANGUAGE_LABEL = Object.freeze({
  ingles: 'inglés', english: 'inglés', espanol: 'español', castellano: 'español', spanish: 'español',
  portugues: 'portugués', portuguese: 'portugués', frances: 'francés', french: 'francés', aleman: 'alemán',
  german: 'alemán', italiano: 'italiano', italian: 'italiano', chino: 'chino', japones: 'japonés', coreano: 'coreano',
  ruso: 'ruso', arabe: 'árabe', catalan: 'catalán', euskera: 'euskera', gallego: 'gallego', quechua: 'quechua',
});
const COUNT_RE = /\b(\d{1,3}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte|treinta)\s+(diapositivas?|slides?|laminas?|paginas?|parrafos?|ejemplos?|puntos?|items?|filas?|columnas?|preguntas?|palabras?|lineas?|secciones?|capitulos?|pasos?|opciones?|ideas?|titulos?|hojas?|tablas?|graficos?|graficas?|imagenes?|versiones?|frases?|oraciones?|bullets?|vinetas?)\b/;
const LENGTH_RE = /\b(mas corto|mas breve|mas largo|mas extenso|mas detallado|mas resumido|brevemente|en detalle|detallado|extenso|corto|breve|una pagina|media pagina|maximo \d+ (?:palabras|lineas|parrafos|paginas)|no mas de \d+ (?:palabras|lineas|parrafos|paginas))\b/;
const TONE_RE = /\b(?:tono\s+)?(formal|informal|profesional|academico|cercano|amable|serio|tecnico|sencillo|simple|coloquial|persuasivo|neutral|humoristico|empatico|directo|ejecutivo)\b/;
const AUDIENCE_RE = /\bpara\s+(ninos|adolescentes|estudiantes|universitarios|principiantes|expertos|directivos|gerentes|clientes|inversores|inversionistas|docentes|profesores|pacientes|padres|un nino de \d+ anos|publico general|redes sociales|linkedin|instagram|twitter|tiktok)\b/;
const COLOR_WORD = 'azul(?:es)?|roj[oa]s?|verdes?|amarill[oa]s?|naranjas?|morad[oa]s?|violetas?|rosa(?:d[oa]s?)?|negr[oa]s?|blanc[oa]s?|gris(?:es)?|celestes?|turquesas?|dorad[oa]s?|platead[oa]s?|beige|marron(?:es)?|cafe|lilas?|fucsias?|magentas?|cian';
const COLOR_RE = new RegExp(`\\b(?:en|de|a|color|colores|tono)\\s+(${COLOR_WORD})\\b|\\b(azul(?:es)?|roj[oa]s?|amarill[oa]s?|naranjas?|morad[oa]s?|violetas?|rosad[oa]s?|celestes?|turquesas?|dorad[oa]s?|platead[oa]s?|fucsias?|magentas?)\\b`);
const FORMAT_CONFLICT_RE = /\b(?:(?:en|como|a)\s+)?(word|docx|excel|xlsx|ppt|pptx|powerpoint|pdf|csv|markdown|html|png|svg)\s+(?:o|u|o bien|o quizas|o tal vez)\s+(?:en\s+|como\s+|a\s+)?(word|docx|excel|xlsx|ppt|pptx|powerpoint|pdf|csv|markdown|html|png|svg)\b/;
const NUMBER_WORDS = Object.freeze({
  un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20, treinta: 30,
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function attachmentName(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.originalName || file.name || file.filename || file.fileId || '').split(/[\\/]/).pop();
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
}

function formatFromMime(mime) {
  const m = fold(mime);
  if (!m) return null;
  if (m.includes('presentationml') || m.includes('powerpoint')) return 'pptx';
  if (m.includes('wordprocessingml') || m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml') || m.includes('ms-excel')) return 'xlsx';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('csv')) return 'csv';
  if (m.startsWith('image/')) return m.split('/')[1].replace('jpeg', 'jpg');
  if (m.includes('html')) return 'html';
  return null;
}

function isImageAttachment(file) {
  const mime = fold(file && (file.mimeType || file.type || file.contentType));
  if (mime.startsWith('image/')) return true;
  return /^(?:png|jpe?g|gif|webp|bmp|heic|svg)$/.test(extOf(attachmentName(file)) || '');
}

/** The attachment whose file name (or stem ≥ 3 chars) the prompt names. */
function namedAttachments(text, attachments) {
  const out = [];
  for (const file of attachments) {
    const name = attachmentName(file);
    if (!name) continue;
    const stem = fold(name.replace(/\.[a-z0-9]{1,5}$/i, ''));
    const full = fold(name);
    if ((full.length >= 3 && text.includes(full)) || (stem.length >= 3 && new RegExp(`(?<![a-z0-9_])${escapeRe(stem)}(?![a-z0-9_])`).test(text))) {
      out.push(file);
    }
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectDeliverables(text) {
  const kinds = [];
  for (const [kind, re] of DELIVERABLE_RES) if (re.test(text)) kinds.push(kind);
  return kinds;
}

function detectFormats(text) {
  const out = [];
  // «en pdf», «a word», «como excel», «formato pptx»: a bare mention (an
  // attachment name such as «tesis.pdf») is not a requested output format.
  const requested = text.replace(/[a-z0-9_-]+\.(?:pdf|docx|pptx|xlsx|csv|png|svg|md)\b/g, ' ');
  for (const [fmt, re] of FORMAT_WORDS) {
    const prefixed = new RegExp(`\\b(?:en|a|como|formato|version|archivo|documento|export\\w*)\\s+(?:un\\s+|una\\s+|el\\s+|la\\s+)?(?:${re.source.slice(2, -2)})`);
    if (prefixed.test(requested)) out.push(fmt);
  }
  return out;
}

function pickAction(text, { deliverables, hasAttachments, hasPrevAssistant, isQuestion, words, constraints = [], priorArtifact = null }) {
  if (CHITCHAT_RE.test(text) && words <= 6) return 'converse';
  if (CONTINUE_RE.test(text) && words <= 4 && hasPrevAssistant) return 'continue';
  const clitic = CLITIC_RE.test(text);
  const hasEdit = EDIT_RE.test(text) || clitic;
  const hasCreate = CREATE_RE.test(text) && !clitic;
  // «ahora en azul», «más formal», «no, en español»: no verb, but a change
  // of an attribute of what exists (the previous answer or the generated
  // file) — an edit, never a fresh deliverable.
  const verbless = !hasEdit && !hasCreate && !TRANSFORM_RE.test(text) && !ANALYZE_RE.test(text)
    && !VISUALIZE_RE.test(text) && !SEARCH_RE.test(text) && !CODE_RE.test(text) && !isQuestion;
  if (verbless && (hasPrevAssistant || priorArtifact) && words <= 12
    && (constraints.length > 0 || STYLE_RE.test(text) || ANCHOR_RE.test(text))) {
    return 'edit';
  }
  const hasTransform = TRANSFORM_RE.test(text);
  const hasAnalyze = ANALYZE_RE.test(text);
  const hasVisualize = VISUALIZE_RE.test(text) || deliverables.includes('chart');
  const hasSearch = SEARCH_RE.test(text);
  const hasCode = CODE_RE.test(text) || (deliverables.includes('code') && (hasCreate || hasEdit));
  const artifactNoun = deliverables.some((k) => !['translation', 'summary', 'text'].includes(k));

  if (deliverables.includes('transcription')) return 'transform';
  if (hasTransform && !hasCreate) return 'transform';
  if (hasVisualize && !hasEdit && !/\b(?:grafic[ao]s?|chart) (?:anterior|generad\w*)\b/.test(text)) return 'visualize';
  if (hasCode && !artifactNounExcludingCode(deliverables)) return 'code';
  if (clitic && !artifactNoun) return 'edit';
  if (hasEdit && !hasCreate) return 'edit';
  if (hasCreate && artifactNoun) return 'create';
  // «hazme un resumen», «dame un análisis»: an analysis, not a deliverable.
  if (hasCreate && !artifactNoun && !hasEdit && (hasAnalyze || deliverables.includes('summary'))) return 'analyze';
  if (hasCreate && !artifactNoun && !hasEdit) return WRITE_RE.test(text) ? 'create' : 'answer';
  if (hasEdit && hasCreate) {
    // «crea una tabla y agrégala al word»: the dominant verb is the first one.
    const e = text.search(EDIT_RE); const c = text.search(CREATE_RE);
    return c >= 0 && (e < 0 || c < e) ? 'create' : 'edit';
  }
  if (hasAnalyze || deliverables.includes('summary')) return 'analyze';
  if (hasSearch) return 'search';
  if (hasCreate) return 'create';
  if (isQuestion) return 'answer';
  if (hasAttachments) return 'analyze';
  return 'answer';
}

function artifactNounExcludingCode(deliverables) {
  return deliverables.some((k) => !['code', 'translation', 'summary', 'text'].includes(k));
}

function pickDeliverable(text, action, deliverables, formats, target) {
  const explicitFormat = formats.find((f) => OFFICE_FORMATS.has(f) || f === 'png' || f === 'svg' || f === 'md') || null;
  const priority = ['presentation', 'spreadsheet', 'pdf', 'document', 'chart', 'diagram', 'table', 'image', 'media', 'code', 'translation', 'summary'];
  let kind = priority.find((k) => deliverables.includes(k)) || null;
  // A deliverable noun that only names the TARGET («agrega una conclusión al
  // word») is the target's format, not a new deliverable.
  if (action === 'edit' && target && target.kind !== 'none' && kind && ['presentation', 'document', 'spreadsheet', 'pdf'].includes(kind)) {
    return { kind, format: target.format || explicitFormat || DEFAULT_FORMAT[kind] || null, ofTarget: true };
  }
  if (action === 'transform') {
    if (deliverables.includes('transcription')) kind = 'transcription';
    else if (/\btraduc|translat/.test(text)) kind = 'translation';
    else if (explicitFormat) kind = formatToKind(explicitFormat);
  }
  // A question or an analysis answers in the chat: a document noun there
  // names the SOURCE («qué dice el documento»), not something to produce.
  if (action === 'answer' || action === 'search') kind = 'text';
  if (action === 'analyze') kind = /\bresum|sintesis|summar/.test(text) ? 'summary' : (kind === 'table' || kind === 'chart' ? kind : 'text');
  if (action === 'visualize' && !kind) kind = 'chart';
  if (action === 'code' && !kind) kind = 'code';
  if (action === 'create' && !kind) kind = 'text';
  if (action === 'converse' || action === 'continue') kind = kind || null;
  const format = kind && DEFAULT_FORMAT[kind] && ['presentation', 'document', 'spreadsheet', 'pdf'].includes(kind)
    ? (kind === 'document' && explicitFormat === 'pdf' ? 'pdf' : (kind === 'spreadsheet' && explicitFormat === 'csv' ? 'csv' : DEFAULT_FORMAT[kind]))
    : (explicitFormat || (kind ? DEFAULT_FORMAT[kind] || null : null));
  return { kind, format, ofTarget: false };
}

function formatToKind(fmt) {
  switch (fmt) {
    case 'pptx': return 'presentation';
    case 'docx': return 'document';
    case 'xlsx': case 'csv': return 'spreadsheet';
    case 'pdf': return 'pdf';
    case 'png': case 'svg': return 'image';
    case 'md': return 'text';
    default: return null;
  }
}

function resolveTarget(text, ctx) {
  const { attachments, priorArtifact, hasPrevAssistant, action, coreference, deliverables } = ctx;
  // A pasted link is the object of the request («transcribe este enlace del
  // minuto 1 al 10», «resume este video», «qué dice esta página»).
  const urlMatch = URL_RE.exec(ctx.raw || '');
  if (urlMatch && !attachments.length && ['transform', 'analyze', 'answer', 'search', 'create', 'visualize'].includes(action)) {
    let host = null;
    try { host = new URL(urlMatch[0]).hostname.replace(/^www\./, ''); } catch (_) { host = null; }
    if (host) return { kind: 'url', name: host, format: null, url: urlMatch[0], source: 'explicit' };
  }
  const named = namedAttachments(text, attachments);
  if (named.length) {
    return {
      kind: 'attachment',
      name: attachmentName(named[0]),
      format: extOf(attachmentName(named[0])) || formatFromMime(named[0].mimeType || named[0].type),
      count: named.length,
      source: 'named',
    };
  }
  const docAttachments = attachments.filter((f) => !isImageAttachment(f));
  const previousAnswerRef = PREVIOUS_ANSWER_RE.test(text);
  if (previousAnswerRef && hasPrevAssistant) {
    return { kind: 'previous_answer', name: null, format: null, source: 'explicit' };
  }
  // «crea un word con esta información», «grafica estos datos» after an
  // answer: the previous answer is the SOURCE of the new deliverable.
  if (!attachments.length && hasPrevAssistant && ['create', 'visualize', 'transform', 'code'].includes(action) && PREVIOUS_CONTENT_RE.test(text)) {
    return { kind: 'previous_answer', name: null, format: null, source: 'content' };
  }
  if (attachments.length && ['edit', 'analyze', 'transform', 'visualize', 'answer', 'create', 'code'].includes(action)) {
    const first = docAttachments[0] || attachments[0];
    return {
      kind: 'attachment',
      name: attachments.length === 1 ? attachmentName(first) : null,
      format: attachments.length === 1 ? (extOf(attachmentName(first)) || formatFromMime(first.mimeType || first.type)) : null,
      count: attachments.length,
      source: 'attached',
    };
  }
  const artifactFormat = priorArtifact ? (priorArtifact.format || extOf(priorArtifact.filename) || formatFromMime(priorArtifact.mime)) : null;
  const artifactRef = GENERATED_ARTIFACT_RE.test(text);
  const officeNoun = deliverables.some((k) => ['presentation', 'document', 'spreadsheet', 'pdf'].includes(k));
  const styleEdit = STYLE_RE.test(text);
  const deictic = CLITIC_RE.test(text) || ANCHOR_RE.test(text) || FOLLOWUP_ANSWER_RE.test(text)
    || /^(?:[¿¡]\s*)?(?:y |pero |no,? )?(?:eso|esto|lo|la|le)\b/.test(text);
  const corefToArtifact = Array.isArray(coreference && coreference.references)
    && coreference.references.some((r) => /\.(?:docx|pptx|xlsx|pdf|csv)\b/i.test(String(r && r.resolvesTo || '')));
  if (priorArtifact && (artifactRef || corefToArtifact || (action === 'edit' && (officeNoun || styleEdit)) || (action === 'transform' && officeNoun))) {
    return {
      kind: 'generated_artifact',
      name: priorArtifact.filename || null,
      format: artifactFormat,
      id: priorArtifact.id || null,
      source: artifactRef ? 'explicit' : (styleEdit ? 'style' : 'office_noun'),
    };
  }
  if (hasPrevAssistant && (action === 'continue' || ((deictic || action === 'edit' || action === 'transform' || action === 'code' || (action === 'answer' && FOLLOWUP_ANSWER_RE.test(text))) && !officeNoun))) {
    const objectless = action === 'edit' && !deliverables.length && !previousAnswerRef;
    return {
      kind: 'previous_answer',
      name: null,
      format: null,
      source: deictic ? 'deictic' : 'implicit',
      // The chat ALSO holds a generated file: say which one we picked.
      assumed: Boolean(priorArtifact && objectless),
    };
  }
  return { kind: 'none', name: null, format: null, source: 'none' };
}

// Folded text lost its accents; constraint values are shown to the user.
const ACCENTS = Object.freeze({
  parrafo: 'párrafo', parrafos: 'párrafos', pagina: 'página', paginas: 'páginas', lamina: 'lámina', laminas: 'láminas',
  linea: 'línea', lineas: 'líneas', capitulo: 'capítulo', capitulos: 'capítulos', titulo: 'título', titulos: 'títulos',
  grafico: 'gráfico', graficos: 'gráficos', grafica: 'gráfica', graficas: 'gráficas', imagenes: 'imágenes', vineta: 'viñeta',
  vinetas: 'viñetas', mas: 'más', academico: 'académico', tecnico: 'técnico', humoristico: 'humorístico', empatico: 'empático',
  ninos: 'niños', nino: 'niño', maximo: 'máximo', publico: 'público', sintesis: 'síntesis', version: 'versión',
  marron: 'marrón', cafe: 'café', pestana: 'pestaña', tamano: 'tamaño', diseno: 'diseño', ingles: 'inglés',
});
/** «1.5» after «minuto» → 01:30; «10» → 10:00; «1:30» stays; «01:02:03» stays. */
function normalizeTimecode(raw, text) {
  const v = String(raw || '').replace(',', '.');
  if (/^\d{1,2}:\d{1,2}(?::\d{1,2})?$/.test(v)) return v.split(':').map((p) => p.padStart(2, '0')).join(':');
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const inSeconds = /\bsegundos?\b/.test(text) && !/\bminutos?\b/.test(text);
  const total = Math.round(inSeconds ? n : n * 60);
  const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60;
  const two = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function clockSeconds(label) {
  const parts = String(label || '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * «del minuto 60 al minuto 1:20»: past the hour, an «a:bb» end that would fall
 * before the start reads as hours:minutes («1:20» → «1:20:00»).
 */
function resolveRangeEndLabel(fromLabel, toLabel) {
  const from = clockSeconds(fromLabel);
  const to = clockSeconds(toLabel);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(toLabel || ''));
  if (from == null || to == null || to > from || from < 3600 || !m) return toLabel;
  const hours = Number(m[1]); const minutes = Number(m[2]);
  return hours * 3600 + minutes * 60 > from ? `${hours}:${String(minutes).padStart(2, '0')}:00` : toLabel;
}

function prettify(value) {
  return String(value || '').split(' ').map((w) => ACCENTS[w] || w).join(' ');
}

function detectConstraints(text) {
  const out = [];
  const lang = LANGUAGE_RE.exec(text);
  if (lang) out.push({ kind: 'language', value: LANGUAGE_LABEL[lang[1]] || lang[1] });
  const count = COUNT_RE.exec(text);
  if (count) {
    const n = NUMBER_WORDS[count[1]] || Number(count[1]);
    // «una tabla» names the deliverable, not a quantity.
    if (Number.isFinite(n) && n > 1) out.push({ kind: 'count', value: prettify(`${n} ${count[2]}`) });
  }
  const length = LENGTH_RE.exec(text);
  if (length) out.push({ kind: 'length', value: prettify(length[1]) });
  const tone = TONE_RE.exec(text);
  if (tone && /\b(?:tono|estilo|manera|forma|lenguaje|registro|redaccion|version)\b/.test(text)) out.push({ kind: 'tone', value: prettify(tone[1]) });
  else if (tone && /\b(?:mas|menos)\s+(formal|informal|profesional|academico|tecnico|sencillo|simple|serio|directo|cercano|breve)\b/.test(text)) out.push({ kind: 'tone', value: prettify(`${/\bmenos\s+/.test(text) ? 'menos' : 'mas'} ${tone[1]}`) });
  const audience = AUDIENCE_RE.exec(text);
  if (audience) out.push({ kind: 'audience', value: prettify(`para ${audience[1]}`) });
  const color = COLOR_RE.exec(text);
  if (color) out.push({ kind: 'color', value: prettify(color[1] || color[2]) });
  const range = TIME_RANGE_RE.exec(text);
  if (range && /\b(?:minuto|min|segundo|hora|transcri|audio|video|grabaci)/.test(text)) {
    const from = normalizeTimecode(range[1], text);
    out.push({ kind: 'time_range', value: `${from} → ${resolveRangeEndLabel(from, normalizeTimecode(range[2], text))}` });
  }
  return out.slice(0, 6);
}

/**
 * «con este formato / usa esta plantilla» + an attached .pptx/.potx/.docx/
 * .dotx: the attachment is the FORMAT of a new deliverable, not its content.
 * The brief carries it as a `template` constraint (first, it changes what the
 * runner must do) and routingHints exposes it as `templateFile`.
 */
function detectTemplateIntentSafe(raw, attachments, priorArtifact) {
  try {
    const { detectTemplateIntent } = require('./document-template-intent');
    const names = (Array.isArray(attachments) ? attachments : []).map(attachmentName).filter(Boolean);
    const prior = priorArtifact && priorArtifact.filename ? [priorArtifact.filename] : [];
    const intent = detectTemplateIntent({ prompt: raw, fileNames: names, priorArtifactNames: prior });
    return intent && intent.isTemplateFill ? intent : null;
  } catch (_) {
    return null;
  }
}

/** Inline material the user pasted (quotes, colons + long text, code fences). */
function hasInlineSource(raw, words) {
  const s = String(raw || '');
  if (/```[\s\S]{20,}```/.test(s)) return true;
  if (/[«"“'][^»"”']{25,}[»"”']/.test(s)) return true;
  if (/:\s*\n/.test(s) && words >= 20) return true;
  return words >= 45;
}

function detectAmbiguity(text, raw, ctx) {
  const { action, target, attachments, hasPrevAssistant, deliverables, words, priorArtifact } = ctx;
  const reasons = [];
  let score = 0;
  let question = null;
  let options = [];
  let note = '';

  const conflict = FORMAT_CONFLICT_RE.exec(text);
  if (conflict && conflict[1] !== conflict[2]) {
    const fmts = Array.from(new Set([normalizeFormatWord(conflict[1]), normalizeFormatWord(conflict[2])].filter(Boolean)));
    if (fmts.length >= 2) {
      reasons.push('format_conflict');
      score = Math.max(score, 0.8);
      question = '¿En qué formato lo quieres?';
      options = fmts.map((f) => ({ label: FORMAT_LABEL[f] || f, value: f }));
    }
  }
  const needsSource = ['transform', 'analyze', 'edit'].includes(action) || (action === 'visualize' && !/\b(?:datos?|cifras?|valores?|\d)/.test(text));
  if (needsSource && target.kind === 'none' && !attachments.length && !hasPrevAssistant && !hasInlineSource(raw, words) && !URL_RE.test(raw)) {
    reasons.push('missing_source');
    score = Math.max(score, 0.85);
    const what = action === 'transform' ? (deliverables.includes('translation') ? 'traducir' : 'convertir')
      : action === 'analyze' ? (deliverables.includes('summary') ? 'resumir' : 'analizar')
        : action === 'visualize' ? 'graficar' : 'editar';
    question = `¿Qué quieres que ${what === 'editar' ? 'edite' : what === 'resumir' ? 'resuma' : what === 'analizar' ? 'analice' : what === 'traducir' ? 'traduzca' : what === 'graficar' ? 'grafique' : 'convierta'}? No veo un archivo adjunto ni un texto en este chat.`;
    options = [
      { label: 'Voy a adjuntar el archivo', value: 'attach' },
      { label: 'Te pego el texto aquí', value: 'paste' },
    ];
  }
  if (target.kind === 'previous_answer' && target.assumed && priorArtifact) {
    reasons.push('target_assumed_answer');
    score = Math.max(score, 0.45);
    note = `Asumo que te refieres a mi respuesta anterior, no al archivo «${priorArtifact.filename || 'generado'}»; dime «en el archivo» si era ese.`;
  }
  if (target.kind === 'generated_artifact' && target.source === 'style' && hasPrevAssistant) {
    reasons.push('target_assumed_artifact');
    score = Math.max(score, 0.3);
    note = `Aplico el cambio al archivo generado «${target.name || ''}».`;
  }
  if (attachments.length >= 2 && target.kind === 'attachment' && target.source === 'attached' && ['edit', 'transform'].includes(action)) {
    reasons.push('multiple_attachments');
    score = Math.max(score, 0.4);
    note = `Trabajo sobre los ${attachments.length} archivos adjuntos; nombra uno si solo era ese.`;
  }
  if (!reasons.length && action === 'answer' && words <= 2 && !hasPrevAssistant && !attachments.length) {
    reasons.push('too_short');
    score = Math.max(score, 0.5);
  }
  return {
    score: Math.round(score * 100) / 100,
    ask: score >= ASK_THRESHOLD && Boolean(question),
    reasons,
    question,
    options: options.slice(0, MAX_OPTIONS),
    note,
  };
}

function normalizeFormatWord(word) {
  switch (fold(word)) {
    case 'word': case 'docx': return 'docx';
    case 'excel': case 'xlsx': return 'xlsx';
    case 'ppt': case 'pptx': case 'powerpoint': return 'pptx';
    case 'pdf': return 'pdf';
    case 'csv': return 'csv';
    case 'markdown': return 'md';
    case 'html': return 'html';
    case 'png': return 'png';
    case 'svg': return 'svg';
    default: return null;
  }
}

const ACTION_LABEL = Object.freeze({
  create: 'Crear', edit: 'Editar', answer: 'Responder', analyze: 'Analizar', transform: 'Convertir', search: 'Buscar',
  visualize: 'Graficar', code: 'Programar', continue: 'Continuar', converse: 'Conversar',
});

function targetLabel(target) {
  if (!target || target.kind === 'none') return '';
  if (target.kind === 'attachment') {
    if (target.name) return `«${clip(target.name, 36)}»`;
    return `los ${target.count || ''} adjuntos`.replace(/\s+/g, ' ');
  }
  if (target.kind === 'generated_artifact') return target.name ? `el archivo generado «${clip(target.name, 32)}»` : 'el archivo generado';
  if (target.kind === 'previous_answer') return 'mi respuesta anterior';
  if (target.kind === 'url') return `el enlace de ${clip(target.name || 'la web', 32)}`;
  return '';
}

function buildSummary(brief) {
  const { action, deliverable, target, constraints } = brief;
  const template = constraints.find((c) => c.kind === 'template' && c.file);
  if (template) {
    const extras = constraints.filter((c) => c !== template).map((c) => c.value).filter(Boolean);
    const what = DELIVERABLE_LABEL[deliverable.kind] || 'el entregable';
    return clip([`Crear ${what} con el formato de «${clip(template.file, 32)}»`, ...extras].join(' · '), MAX_SUMMARY_CHARS);
  }
  let head;
  const tl = targetLabel(target);
  switch (action) {
    case 'edit':
      head = tl ? `Editar ${tl}` : 'Editar';
      break;
    case 'transform':
      head = deliverable.kind === 'transcription'
        ? `Transcribir ${tl || 'el audio'}`
        : deliverable.kind === 'translation'
        ? `Traducir ${tl || 'el texto'}`
        : `Convertir ${tl || 'el contenido'}${deliverable.format ? ` a ${FORMAT_LABEL[deliverable.format] || deliverable.format}` : ''}`;
      break;
    case 'analyze':
      head = deliverable.kind === 'summary' ? `Resumir ${tl || 'el contenido'}` : `Analizar ${tl || 'el contenido'}`;
      break;
    case 'create':
      head = deliverable.kind === 'text'
        ? `Redactar el texto pedido${tl ? ` a partir de ${tl}` : ''}`
        : `Crear ${DELIVERABLE_LABEL[deliverable.kind] || 'un entregable'}${tl ? ` a partir de ${tl}` : ''}`;
      break;
    case 'visualize':
      head = `Graficar ${tl ? `los datos de ${tl}` : 'los datos'}`;
      break;
    case 'code':
      head = `Programar${tl ? ` sobre ${tl}` : ''}`;
      break;
    case 'search':
      head = 'Buscar información actual';
      break;
    case 'continue':
      head = 'Continuar con lo anterior';
      break;
    case 'converse':
      head = 'Conversar';
      break;
    default:
      head = tl ? `Responder sobre ${tl}` : 'Responder la pregunta';
  }
  if (action === 'edit' && deliverable.kind && !deliverable.ofTarget && target.kind === 'previous_answer') {
    head += ` (${DELIVERABLE_LABEL[deliverable.kind] || deliverable.kind})`;
  }
  const extras = constraints.map((c) => c.value).filter(Boolean);
  const summary = [head, ...extras].join(' · ');
  return clip(summary, MAX_SUMMARY_CHARS);
}

function confidenceFor(brief, signals) {
  let c = 1 - brief.ambiguity.score;
  if (brief.action === 'answer' && !signals.question && !signals.hasAttachments && brief.target.kind === 'none') c -= 0.2;
  if (brief.target.kind === 'previous_answer' && brief.target.source === 'implicit') c -= 0.1;
  if (brief.action === 'converse' || brief.action === 'continue') c = Math.max(c, 0.9);
  return Math.max(0, Math.min(1, Math.round(c * 100) / 100));
}

// ─── Public API ───────────────────────────────────────────────────────────

function isEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_REQUEST_BRIEF) ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/** Cheap gate: does this prompt deserve the (indexed) latest-artifact query? */
function needsPriorArtifactLookup(prompt) {
  const text = fold(prompt);
  if (!text) return false;
  return GENERATED_ARTIFACT_RE.test(text) || CLITIC_RE.test(text) || ANCHOR_RE.test(text)
    || STYLE_RE.test(text) || EDIT_RE.test(text) || TRANSFORM_RE.test(text) || CONTINUE_RE.test(text)
    || DELIVERABLE_RES.some(([kind, re]) => ['presentation', 'document', 'spreadsheet', 'pdf'].includes(kind) && re.test(text));
}

/**
 * @param {object} input
 * @param {string} input.prompt
 * @param {Array<{role:string,text?:string,content?:string}>} [input.recentTurns]
 * @param {Array<object>} [input.attachments]  this request's files
 * @param {{id?:string,filename?:string,mime?:string,format?:string}|null} [input.priorArtifact]  latest generated file of the chat
 * @param {{references?:Array}} [input.coreference]
 * @param {{isRepair?:boolean,repairType?:string}} [input.repairDetection]
 */
function buildRequestBrief(input = {}) {
  const raw = String(input.prompt == null ? '' : input.prompt);
  // The verbs, objects and constraints live in the first lines; a pasted
  // 20k-char text is material, not instructions — cap the classified span.
  const text = fold(raw.slice(0, 4000));
  const attachments = Array.isArray(input.attachments) ? input.attachments.filter(Boolean) : [];
  const recentTurns = Array.isArray(input.recentTurns) ? input.recentTurns : [];
  const hasPrevAssistant = recentTurns.some((t) => t && /^(?:assistant|ai)$/i.test(String(t.role || '')) && String(t.text || t.content || '').trim());
  const priorArtifact = input.priorArtifact && typeof input.priorArtifact === 'object' ? input.priorArtifact : null;
  const words = wordCount(raw);
  const isQuestion = QUESTION_RE.test(text) || /\?\s*$/.test(raw.trim());
  const deliverables = detectDeliverables(text);
  const formats = detectFormats(text);
  const signals = { hasAttachments: attachments.length > 0, hasPrevAssistant, question: isQuestion, words };

  const constraints = detectConstraints(text);
  const templateIntent = detectTemplateIntentSafe(raw, attachments, priorArtifact);
  if (templateIntent) constraints.unshift({ kind: 'template', value: `siguiendo el formato de «${clip(templateIntent.templateFile, 40)}»`, file: templateIntent.templateFile, format: templateIntent.outputFormat });
  let action = text ? pickAction(text, { deliverables, hasAttachments: attachments.length > 0, hasPrevAssistant, isQuestion, words, constraints, priorArtifact }) : 'converse';
  if (templateIntent && ['edit', 'transform', 'answer', 'analyze'].includes(action)) action = 'create';
  const target = resolveTarget(text, { attachments, priorArtifact, hasPrevAssistant, action, coreference: input.coreference || null, deliverables, raw });
  const deliverable = pickDeliverable(text, action, deliverables, formats, target);
  if (templateIntent) {
    const kindByFormat = { pptx: 'presentation', docx: 'document', xlsx: 'spreadsheet' };
    if (!deliverable.kind || deliverable.kind === 'text' || !deliverable.format) {
      deliverable.kind = kindByFormat[templateIntent.outputFormat] || deliverable.kind;
      deliverable.format = templateIntent.outputFormat || deliverable.format;
      deliverable.ofTarget = false;
    }
  }
  const ambiguity = detectAmbiguity(text, raw, { action, target, attachments, hasPrevAssistant, deliverables, words, priorArtifact });
  const references = Array.isArray(input.coreference && input.coreference.references)
    ? input.coreference.references
      .filter((r) => r && r.span && r.resolvesTo)
      .slice(0, 4)
      .map((r) => ({ span: clip(r.span, 40), resolvesTo: clip(r.resolvesTo, 80) }))
    : [];
  const repair = input.repairDetection && input.repairDetection.isRepair
    ? { type: String(input.repairDetection.repairType || 'correction') }
    : null;

  const brief = {
    version: 1,
    source: 'heuristic',
    action,
    deliverable: { kind: deliverable.kind, format: deliverable.format, ofTarget: Boolean(deliverable.ofTarget) },
    target: {
      kind: target.kind,
      name: target.name || null,
      format: target.format || null,
      ...(target.id ? { id: String(target.id) } : {}),
      ...(target.count ? { count: target.count } : {}),
      source: target.source || 'none',
      ...(target.assumed ? { assumed: true } : {}),
    },
    constraints,
    references,
    repair,
    ambiguity,
    trivial: action === 'converse' || (action === 'continue' && !constraints.length),
  };
  brief.confidence = confidenceFor(brief, signals);
  brief.summary = buildSummary(brief);
  return brief;
}

/** Label + detail for the «Analizando tu mensaje» row once the brief is known. */
function describeRequestBrief(brief) {
  if (!brief || brief.trivial) return { label: 'Mensaje entendido', detail: '' };
  const label = clip(`Entendí: ${brief.summary}`, 90);
  let detail = '';
  if (brief.ambiguity && brief.ambiguity.ask) detail = 'Te pregunto antes de seguir';
  else if (brief.ambiguity && brief.ambiguity.note) detail = brief.ambiguity.note;
  else if (brief.confidence < 0.7) detail = 'Si no es eso, corrígeme en el chat';
  return { label, detail: clip(detail, 200) };
}

/** Compact payload for the `request_brief` SSE frame and the message metadata. */
function publicRequestBrief(brief) {
  if (!brief) return null;
  return {
    version: 1,
    source: brief.source,
    action: brief.action,
    summary: brief.summary,
    confidence: brief.confidence,
    trivial: Boolean(brief.trivial),
    deliverable: { kind: brief.deliverable.kind || null, format: brief.deliverable.format || null },
    target: { kind: brief.target.kind, name: brief.target.name || null, format: brief.target.format || null },
    constraints: brief.constraints.map((c) => ({ kind: c.kind, value: c.value })),
    ambiguity: {
      score: brief.ambiguity.score,
      ask: Boolean(brief.ambiguity.ask),
      ...(brief.ambiguity.question ? { question: brief.ambiguity.question } : {}),
      ...(brief.ambiguity.note ? { note: brief.ambiguity.note } : {}),
      options: (brief.ambiguity.options || []).map((o) => ({ label: o.label })),
    },
  };
}

/** The tier-0 system block the model executes. Empty for small talk. */
function buildRequestBriefPromptBlock(brief) {
  if (!brief || brief.trivial) return '';
  const lines = ['## Lo que pide el usuario en este turno (brief verificado)'];
  const actionLabel = brief.action === 'transform' && brief.deliverable.kind === 'transcription'
    ? 'Transcribir'
    : brief.action === 'transform' && brief.deliverable.kind === 'translation' ? 'Traducir' : (ACTION_LABEL[brief.action] || brief.action);
  lines.push(`- Acción: ${actionLabel}`);
  if (brief.deliverable.kind && brief.deliverable.kind !== 'text') {
    const fmt = brief.deliverable.format ? ` (${FORMAT_LABEL[brief.deliverable.format] || brief.deliverable.format})` : '';
    lines.push(`- Entregable: ${DELIVERABLE_LABEL[brief.deliverable.kind] || brief.deliverable.kind}${fmt}${brief.deliverable.ofTarget ? ' — es el archivo a editar, no uno nuevo' : ''}`);
  } else if (brief.action === 'answer' || brief.action === 'analyze') {
    lines.push('- Entregable: respuesta en texto en el chat (no generes archivos salvo que lo pida)');
  }
  const templateConstraint = brief.constraints.find((c) => c.kind === 'template' && c.file);
  switch (brief.target.kind) {
    case 'attachment':
      if (templateConstraint && (!brief.target.name || brief.target.name === templateConstraint.file)) break; // the PLANTILLA line below says it
      lines.push(`- Objeto: ${brief.target.name ? `el archivo adjunto «${brief.target.name}»` : `los ${brief.target.count || ''} archivos adjuntos`.replace(/\s+/g, ' ')}. Trabaja sobre SU contenido real.`);
      break;
    case 'generated_artifact':
      lines.push(`- Objeto: el archivo que YA generaste en este chat${brief.target.name ? ` («${brief.target.name}»)` : ''}. Modifícalo; no crees uno nuevo ni respondas solo con texto.`);
      break;
    case 'url':
      lines.push(`- Objeto: el enlace que pegó el usuario (${brief.target.name || 'web'}). ${brief.deliverable.kind === 'transcription' ? 'Transcríbelo con la herramienta `transcribe_url` (start/end según el rango pedido); no digas que no puedes sin haberla llamado.' : 'Léelo con la herramienta adecuada antes de responder.'}`);
      break;
    case 'previous_answer':
      if (['create', 'visualize', 'code'].includes(brief.action) || (brief.action === 'transform' && brief.deliverable.kind !== 'translation')) {
        lines.push('- Fuente: el contenido de TU RESPUESTA ANTERIOR en este chat (incluye esa información, tabla o gráfica en el entregable; no la reinventes).');
      } else {
        lines.push('- Objeto: TU RESPUESTA ANTERIOR en este chat. Amplíala, tradúcela o corrígela en el chat; NO edites ni generes archivos.');
      }
      break;
    default:
      break;
  }
  const template = brief.constraints.find((c) => c.kind === 'template' && c.file);
  if (template) {
    lines.push(`- PLANTILLA OBLIGATORIA: el adjunto «${template.file}» es el FORMATO del entregable, no su contenido. Construye el archivo SOBRE esa plantilla (sus layouts, tema, fuentes, logos, encabezados); nunca un diseño propio ni una plantilla de SiraGPT. Las láminas/párrafos de muestra se reemplazan por contenido real.`);
  }
  if (brief.constraints.length) {
    lines.push(`- Restricciones explícitas: ${brief.constraints.map((c) => c.value).join(' · ')}`);
  }
  if (brief.references.length) {
    lines.push(`- Referencias resueltas: ${brief.references.map((r) => `«${r.span}» → ${r.resolvesTo}`).join('; ')}`);
  }
  if (brief.repair) {
    lines.push('- El usuario está CORRIGIENDO la interpretación anterior: no repitas el enfoque previo.');
  }
  if (brief.ambiguity.note) lines.push(`- Supuesto: ${brief.ambiguity.note}`);
  lines.push('Cumple exactamente esto. Si el usuario te corrige, su corrección manda sobre este brief.');
  return lines.join('\n');
}

// ─── Optional fast-LLM refinement (fail-open) ────────────────────────────

const LLM_SYSTEM = [
  'Eres un analizador de intención. Lees el último mensaje de un usuario de un asistente de IA, con los últimos turnos y los archivos adjuntos, y devuelves SOLO un JSON con esta forma exacta:',
  '{"action":"create|edit|answer|analyze|transform|search|visualize|code|continue|converse","deliverable":{"kind":"presentation|document|spreadsheet|pdf|image|chart|diagram|table|code|media|translation|summary|text|null","format":"pptx|docx|xlsx|pdf|csv|png|svg|md|null"},"target":{"kind":"attachment|generated_artifact|previous_answer|none"},"constraints":[{"kind":"language|count|length|tone|audience|color|other","value":"..."}],"summary":"frase corta en español, infinitivo, <= 70 caracteres"}',
  'Reglas: «previous_answer» = el usuario quiere cambiar/ampliar lo que el asistente ESCRIBIÓ; «generated_artifact» = un archivo que el asistente ya entregó; «attachment» = un archivo que el usuario adjuntó ahora. No inventes restricciones. Sin texto fuera del JSON.',
].join('\n');

function llmEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_REQUEST_BRIEF_LLM) ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

function shouldRefineWithLlm(brief, { hasHistory = false, env = process.env } = {}) {
  if (!brief || brief.trivial || !llmEnabled(env)) return false;
  if (brief.ambiguity && brief.ambiguity.ask) return false;
  return brief.confidence < 0.65 && hasHistory;
}

function mergeLlmBrief(brief, parsed) {
  if (!parsed || typeof parsed !== 'object') return brief;
  const next = { ...brief, deliverable: { ...brief.deliverable }, target: { ...brief.target }, constraints: brief.constraints.slice() };
  let changed = false;
  if (ACTIONS.includes(parsed.action) && parsed.action !== brief.action) { next.action = parsed.action; changed = true; }
  const d = parsed.deliverable && typeof parsed.deliverable === 'object' ? parsed.deliverable : null;
  if (d) {
    if (DELIVERABLE_KINDS.includes(d.kind) && d.kind !== brief.deliverable.kind) { next.deliverable.kind = d.kind; next.deliverable.ofTarget = false; changed = true; }
    if (typeof d.format === 'string' && /^(?:pptx|docx|xlsx|pdf|csv|png|svg|md)$/.test(d.format) && d.format !== brief.deliverable.format) { next.deliverable.format = d.format; changed = true; }
  }
  const t = parsed.target && typeof parsed.target === 'object' ? parsed.target : null;
  // The LLM may re-aim between answer/artifact/attachment only when such a
  // target exists; it never invents a file.
  if (t && TARGET_KINDS.includes(t.kind) && t.kind !== brief.target.kind) {
    const allowed = t.kind === 'none'
      || (t.kind === 'previous_answer' && brief.__hasPrevAssistant)
      || (t.kind === 'generated_artifact' && brief.__priorArtifact)
      || (t.kind === 'attachment' && brief.__attachmentCount > 0);
    if (allowed) {
      if (t.kind === 'generated_artifact') {
        next.target = { kind: 'generated_artifact', name: brief.__priorArtifact.filename || null, format: brief.__priorArtifact.format || extOf(brief.__priorArtifact.filename) || null, source: 'llm' };
      } else {
        next.target = { kind: t.kind, name: null, format: null, source: 'llm' };
      }
      changed = true;
    }
  }
  if (Array.isArray(parsed.constraints)) {
    for (const c of parsed.constraints.slice(0, 6)) {
      if (!c || typeof c.value !== 'string' || !c.value.trim()) continue;
      if (String(c.kind) === 'template') continue; // only the deterministic detector may claim a template
      const kind = /^(?:language|count|length|tone|audience|color|other)$/.test(String(c.kind)) ? c.kind : 'other';
      if (!next.constraints.some((x) => fold(x.value) === fold(c.value))) { next.constraints.push({ kind, value: clip(c.value, 40) }); changed = true; }
    }
    next.constraints = next.constraints.slice(0, 6);
  }
  if (!changed) return brief;
  next.source = 'llm';
  next.ambiguity = { ...brief.ambiguity, note: brief.ambiguity.note };
  next.confidence = Math.max(brief.confidence, 0.7);
  next.summary = typeof parsed.summary === 'string' && parsed.summary.trim().length >= 6
    ? clip(parsed.summary.trim().replace(/[.]+$/, ''), MAX_SUMMARY_CHARS)
    : buildSummary(next);
  return next;
}

/**
 * Refine a low-confidence brief with the free fast tier. Fail-open: returns
 * the input brief on any failure, timeout or invalid output.
 */
async function refineRequestBriefWithLlm(brief, ctx = {}, deps = {}) {
  try {
    const complete = deps.complete || require('./builder/llm').complete;
    const env = deps.env || process.env;
    const timeoutMs = Number(deps.timeoutMs || env.SIRAGPT_REQUEST_BRIEF_LLM_TIMEOUT_MS) || 900;
    const turns = (Array.isArray(ctx.recentTurns) ? ctx.recentTurns : []).slice(-4)
      .map((t) => `${/^assistant$/i.test(String(t.role)) ? 'ASISTENTE' : 'USUARIO'}: ${clip(t.text || t.content || '', 400)}`);
    const files = (Array.isArray(ctx.attachments) ? ctx.attachments : []).map(attachmentName).filter(Boolean);
    const user = [
      turns.length ? `Turnos previos:\n${turns.join('\n')}` : 'Sin turnos previos.',
      files.length ? `Adjuntos de este turno: ${files.join(', ')}` : 'Sin adjuntos en este turno.',
      ctx.priorArtifact && ctx.priorArtifact.filename ? `Archivo que el asistente ya generó en el chat: ${ctx.priorArtifact.filename}` : 'El asistente no ha generado archivos en este chat.',
      `Lectura heurística: ${JSON.stringify({ action: brief.action, target: brief.target.kind, deliverable: brief.deliverable.kind })}`,
      `MENSAJE ACTUAL: ${clip(ctx.prompt || '', 1200)}`,
    ].join('\n\n');
    const text = await complete({ system: LLM_SYSTEM, user, env, temperature: 0, maxTokens: 220, timeoutMs });
    if (!text) return brief;
    const parsed = require('./builder/llm').extractJson(text);
    const enriched = {
      ...brief,
      __hasPrevAssistant: Boolean(ctx.recentTurns && ctx.recentTurns.some((t) => /^assistant$/i.test(String(t && t.role)))),
      __priorArtifact: ctx.priorArtifact || null,
      __attachmentCount: Array.isArray(ctx.attachments) ? ctx.attachments.length : 0,
    };
    const merged = mergeLlmBrief(enriched, parsed);
    if (merged === enriched) return brief;
    delete merged.__hasPrevAssistant; delete merged.__priorArtifact; delete merged.__attachmentCount;
    return merged;
  } catch (_) {
    return brief;
  }
}

/** Routing hints the gates consume (one place, so the regexes stop disagreeing). */
function routingHints(brief) {
  if (!brief) return { editsPreviousAnswer: false, editsGeneratedOfficeFile: false, officeTargetFormat: null, templateFile: null, templateFormat: null };
  const officeFormat = brief.target.kind === 'generated_artifact' && OFFICE_FORMATS.has(String(brief.target.format || '')) && brief.target.format !== 'csv'
    ? brief.target.format : null;
  const template = (brief.constraints || []).find((c) => c && c.kind === 'template' && c.file) || null;
  return {
    editsPreviousAnswer: brief.target.kind === 'previous_answer' && ['edit', 'transform', 'continue', 'analyze'].includes(brief.action),
    editsGeneratedOfficeFile: Boolean(officeFormat) && ['edit', 'transform'].includes(brief.action),
    officeTargetFormat: officeFormat,
    // «con este formato» + attached template: the AgentRunner builds ON it.
    templateFile: template ? template.file : null,
    templateFormat: template ? (template.format || null) : null,
  };
}

module.exports = {
  ACTIONS,
  DELIVERABLE_KINDS,
  TARGET_KINDS,
  ASK_THRESHOLD,
  isEnabled,
  needsPriorArtifactLookup,
  buildRequestBrief,
  describeRequestBrief,
  publicRequestBrief,
  buildRequestBriefPromptBlock,
  shouldRefineWithLlm,
  refineRequestBriefWithLlm,
  mergeLlmBrief,
  routingHints,
  // exported for tests
  _internal: { fold, detectConstraints, resolveTarget, detectAmbiguity, pickAction },
};
