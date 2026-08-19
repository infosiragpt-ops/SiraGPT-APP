/**
 * user-intent-alignment
 *
 * Deterministic per-turn intent contract inspired by Ouyang et al. 2022
 * (InstructGPT): optimize for following the user's explicit and implicit
 * intent while staying helpful, honest, and harmless.
 *
 * This is not a model fine-tune. It is an inference-time control layer that
 * converts a free-form request into a compact operating profile the chat and
 * task agent can obey consistently.
 */

const INTENT_ALIGNMENT_VERSION = 'instructgpt-intent-alignment-2026-04';

const TAXONOMY = [
  'generation',
  'open_qa',
  'closed_qa',
  'brainstorming',
  'chat',
  'rewrite',
  'summarization',
  'classification',
  'extraction',
  'other',
];

const FORMAT_RULES = [
  { format: 'docx', label: 'Word document', patterns: [/\b(word|docx|documento word)\b/i] },
  { format: 'xlsx', label: 'Excel spreadsheet', patterns: [/\b(excel|xlsx|hoja de calculo|hoja de c[aá]lculo|spreadsheet)\b/i] },
  { format: 'pptx', label: 'PowerPoint presentation', patterns: [/\b(powerpoint|power point|pptx|presentaci[oó]n|diapositivas|slides)\b/i] },
  { format: 'pdf', label: 'PDF document', patterns: [/\b(pdf)\b/i] },
  { format: 'csv', label: 'CSV table', patterns: [/\b(csv)\b/i] },
  { format: 'html', label: 'HTML artifact', patterns: [/\b(html|web|landing page|sitio web|p[aá]gina web)\b/i] },
  { format: 'markdown', label: 'Markdown document', patterns: [/\b(markdown|md)\b/i] },
];

const PATTERNS = {
  generation: /\b(crea|crear|genera|generar|haz|hacer|dame|entrega|prepara|escribe|redacta|dise[nñ]a|build|create|generate|write|make)\b/i,
  summarize: /\b(resume|resumen|resumir|summari[sz]e|tl;dr|sintetiza|s[ií]ntesis|extracto)\b/i,
  rewrite: /\b(reescribe|parafrasea|mejora el texto|corrige estilo|translate|traduce|traducci[oó]n|rewrite|paraphrase)\b/i,
  classify: /\b(clasifica|categoriza|sentimiento|etiqueta|label|classify|category)\b/i,
  extraction: /\b(extrae|extraer|lista|identifica|saca|pull|extract|find all|todos los)\b/i,
  brainstorm: /\b(ideas|brainstorm|lluvia de ideas|opciones|alternativas|propuestas)\b/i,
  chat: /\b(hola|gracias|qu[eé] tal|c[oó]mo est[aá]s|hello|thanks)\b/i,
  question: /(^|\b)(qu[eé]|cu[aá]l|cu[aá]ndo|d[oó]nde|por qu[eé]|c[oó]mo|who|what|when|where|why|how)\b|\?$/i,
  privateContext: /\b(este archivo|este documento|adjunto|cargado|seg[uú]n mis archivos|seg[uú]n el documento|seg[uú]n mi proyecto|seg[uú]n mi tesis)\b/i,
  research: /\b(investiga|investigaci[oó]n|research|fuentes|referencias|citas|art[ií]culos?|papers?|doi|scopus|web of science|wos|openalex|crossref|pubmed|doaj|scielo|redalyc|dialnet|mercado|cient[ií]fic)\b/i,
  strictEvidence: /\b(100%|reales|verifica|validar|preciso|precisi[oó]n|doi|open access|acceso abierto|202[0-9]|art[ií]culos cient[ií]ficos)\b/i,
  inlineOnly: /\b(sin (?:(?:ningun|ning[uú]n)\s+)?formato|directo en el chat|en el chat|no (word|excel|pdf|ppt|archivo)|sin (word|excel|pdf|ppt|archivo))\b/i,
  citation: /\b(apa\s*7|apa|cita|citas|referencias|bibliograf[ií]a|doi)\b/i,
};

const SPANISH_NUMBER_WORDS = new Map([
  ['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5],
  ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10],
  ['once', 11], ['doce', 12], ['trece', 13], ['catorce', 14], ['quince', 15],
  ['dieciseis', 16], ['diecisiete', 17], ['dieciocho', 18], ['diecinueve', 19],
  ['veinte', 20], ['treinta', 30], ['cuarenta', 40], ['cincuenta', 50],
  ['sesenta', 60], ['setenta', 70], ['ochenta', 80], ['noventa', 90],
  ['cien', 100], ['doscientos', 200], ['trescientos', 300], ['cuatrocientos', 400],
  ['quinientos', 500], ['mil', 1000], ['docena', 12], ['par', 2],
]);

// Register/tone the user explicitly asks for. Matched against accent-stripped,
// lowercased text so patterns stay accent-free. Multiple tones can co-exist.
const TONE_RULES = [
  { tone: 'formal', patterns: [/\b(formal|formalmente|lenguaje formal|tono formal|muy formal|de manera formal|de forma formal)\b/] },
  { tone: 'informal', patterns: [/\b(informal|informalmente|casual|coloquial|relajad[ao]|cercan[ao]|amigable|amistoso|de manera casual|de forma relajada)\b/] },
  { tone: 'technical', patterns: [/\b(tecnico|tecnicos|lenguaje tecnico|tono tecnico|muy tecnico|especializado|technical)\b/] },
  { tone: 'simple', patterns: [/\b(sencillo|simple|simples|facil de entender|en palabras simples|en terminos simples|para principiantes|sin tecnicismos|plain language|eli5)\b/] },
  { tone: 'executive', patterns: [/\b(ejecutivo|resumen ejecutivo|para directivos|para la gerencia|para ejecutivos|c-level|executive summary)\b/] },
  { tone: 'academic', patterns: [/\b(tono academico|estilo academico|lenguaje academico|registro academico|academic tone)\b/] },
  { tone: 'persuasive', patterns: [/\b(persuasivo|persuasiva|convincente|tono persuasivo|estilo persuasivo|copy de ventas|persuasive)\b/] },
  { tone: 'child_friendly', patterns: [/\b(para ninos|para un nino|para ninas|para una nina|como a un nino|como si fuera un nino|for kids|for children)\b/] },
];

// Canonical output-language labels. Keys are accent-stripped tokens.
const LANGUAGE_CANON = new Map([
  ['espanol', 'spanish'], ['castellano', 'spanish'], ['spanish', 'spanish'],
  ['ingles', 'english'], ['english', 'english'],
  ['frances', 'french'], ['french', 'french'],
  ['aleman', 'german'], ['german', 'german'],
  ['portugues', 'portuguese'], ['portuguese', 'portuguese'],
  ['italiano', 'italian'], ['italian', 'italian'],
  ['chino', 'chinese'], ['chinese', 'chinese'],
  ['japones', 'japanese'], ['japanese', 'japanese'],
]);

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function matchesAny(text, regex) {
  return regex.test(text) || regex.test(normalize(text));
}

function inferFormat(request) {
  const raw = String(request || '');
  const normalized = normalize(raw);
  for (const rule of FORMAT_RULES) {
    if (rule.patterns.some(pattern => pattern.test(raw) || pattern.test(normalized))) {
      return { format: rule.format, label: rule.label };
    }
  }
  return { format: null, label: 'inline response' };
}

function extractRequestedCounts(request) {
  const normalized = normalize(request);
  const out = [];
  const noun = '(articulos|fuentes|referencias|citas|filas|registros|diapositivas|slides|imagenes|paginas|preguntas|tests|pruebas|documentos)';
  const digitBefore = new RegExp(`\\b(\\d{1,4})\\s+${noun}\\b`, 'gi');
  const digitAfter = new RegExp(`\\b${noun}\\s+(?:de\\s+)?(\\d{1,4})\\b`, 'gi');
  let m;
  while ((m = digitBefore.exec(normalized))) out.push({ count: Number(m[1]), target: m[2] });
  while ((m = digitAfter.exec(normalized))) out.push({ count: Number(m[2]), target: m[1] });

  // Plain word numbers (uno..mil). Collective nouns (par/docena) are handled
  // separately below because they require an explicit quantifier phrase to
  // avoid idioms like "a la par de documentos" inflating the count.
  const collectiveWords = new Set(['par', 'docena']);
  for (const [word, value] of SPANISH_NUMBER_WORDS.entries()) {
    if (collectiveWords.has(word)) continue;
    const re = new RegExp(`\\b${word}\\s+(?:de\\s+)?${noun}\\b`, 'i');
    const hit = normalized.match(re);
    if (hit) out.push({ count: value, target: hit[1] });
  }

  const collectivePhrases = [
    { re: new RegExp(`\\bun par de\\s+${noun}\\b`, 'gi'), count: 2 },
    { re: new RegExp(`\\bmedia docena de\\s+${noun}\\b`, 'gi'), count: 6 },
    { re: new RegExp(`\\b(?:una )?docena de\\s+${noun}\\b`, 'gi'), count: 12 },
  ];
  for (const phrase of collectivePhrases) {
    let pm;
    while ((pm = phrase.re.exec(normalized))) out.push({ count: phrase.count, target: pm[1] });
  }

  return unique(out.map(item => `${item.count} ${item.target}`));
}

// ── Tone / register the user explicitly requested ──────────────────────
function extractTones(request) {
  const normalized = normalize(request);
  const out = [];
  for (const rule of TONE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(normalized))) {
      out.push(`tone:${rule.tone}`);
    }
  }
  return unique(out);
}

// ── Length / depth constraints (brief vs detailed, word/paragraph counts) ─
function extractLengthConstraints(request) {
  const normalized = normalize(request);
  const out = [];
  if (/\b(breve|brevemente|conciso|concis[ao]s?|corto|cortit[ao]|resumid[ao]|en pocas palabras|en una linea|en una frase|en una oracion|de forma breve|de manera breve|briefly|concise|short|in one line|one sentence)\b/.test(normalized)) {
    out.push('length:brief');
  }
  if (/\b(detallad[ao]s?|extens[ao]s?|en profundidad|en detalle|a fondo|exhaustiv[ao]s?|minucios[ao]s?|profund[ao]s?|completo y detallado|paso a paso|detailed|in depth|in-depth|comprehensive|thorough|step by step)\b/.test(normalized)) {
    out.push('length:detailed');
  }

  let m;
  const wordCount = /\b(\d{1,5})\s+palabras\b/g;
  while ((m = wordCount.exec(normalized))) out.push(`length:${m[1]} palabras`);
  const paragraphCount = /\b(\d{1,3})\s+parrafos\b/g;
  while ((m = paragraphCount.exec(normalized))) out.push(`length:${m[1]} parrafos`);
  if (/\b(un parrafo|en un parrafo|one paragraph)\b/.test(normalized)) out.push('length:1 parrafo');

  for (const [word, value] of SPANISH_NUMBER_WORDS.entries()) {
    if (new RegExp(`\\b${word}\\s+parrafos\\b`).test(normalized)) out.push(`length:${value} parrafos`);
    if (new RegExp(`\\b${word}\\s+palabras\\b`).test(normalized)) out.push(`length:${value} palabras`);
  }

  return unique(out);
}

// ── Output language the user asked the assistant to respond in ──────────
// Anchored to a response-directing verb so "articulos en ingles" (sources in
// English) does not get mistaken for "respond in English".
function extractOutputLanguage(request) {
  const normalized = normalize(request);
  // The gap between the verb and the language token must not cross a source
  // noun (articulos/fuentes/...) so "responde con articulos en ingles" is read
  // as "sources in English", not "respond in English".
  const re = /\b(responde|respondeme|contesta|contestame|escribe|escribelo|escribeme|redacta|redactalo|traduce|traducelo|traduceme|hablame|explicalo|explicame|dimelo|dime|answer|reply|respond|write|translate)\b(?:(?!\b(?:articulos?|fuentes|referencias|papers?|documentos?|citas|estudios?)\b)[^.?!])*?\b(?:en|in|al|a)\s+(espanol|castellano|spanish|ingles|english|frances|french|aleman|german|portugues|portuguese|italiano|italian|chino|chinese|japones|japanese)\b/;
  const hit = normalized.match(re);
  if (hit && LANGUAGE_CANON.has(hit[2])) return LANGUAGE_CANON.get(hit[2]);
  return null;
}

function inferTaskType(request, hasFiles) {
  const raw = String(request || '');
  if (hasFiles || matchesAny(raw, PATTERNS.privateContext)) {
    if (matchesAny(raw, PATTERNS.summarize)) return 'summarization';
    if (matchesAny(raw, PATTERNS.extraction)) return 'extraction';
    return 'closed_qa';
  }
  if (matchesAny(raw, PATTERNS.classify)) return 'classification';
  if (matchesAny(raw, PATTERNS.summarize)) return 'summarization';
  if (matchesAny(raw, PATTERNS.rewrite)) return 'rewrite';
  if (matchesAny(raw, PATTERNS.brainstorm)) return 'brainstorming';
  if (matchesAny(raw, PATTERNS.generation)) return 'generation';
  if (matchesAny(raw, PATTERNS.question)) return 'open_qa';
  if (matchesAny(raw, PATTERNS.chat)) return 'chat';
  return 'other';
}

function buildUserIntentAlignmentProfile({ request, fileIds = [] } = {}) {
  const raw = String(request || '');
  const hasFiles = Array.isArray(fileIds) && fileIds.length > 0;
  const requestedFormat = inferFormat(raw);
  const wantsInlineOnly = matchesAny(raw, PATTERNS.inlineOnly);
  const needsResearch = matchesAny(raw, PATTERNS.research);
  const needsStrictEvidence = needsResearch && matchesAny(raw, PATTERNS.strictEvidence);
  const taskType = inferTaskType(raw, hasFiles);
  const requestedCounts = extractRequestedCounts(raw);
  const tones = extractTones(raw);
  const lengthConstraints = extractLengthConstraints(raw);
  const outputLanguage = extractOutputLanguage(raw);

  const outputMode = wantsInlineOnly
    ? 'inline'
    : requestedFormat.format
      ? 'downloadable_artifact'
      : 'inline';

  const hardConstraints = [];
  if (requestedFormat.format) hardConstraints.push(`deliver_as:${requestedFormat.format}`);
  if (wantsInlineOnly) hardConstraints.push('answer_inline_only');
  for (const count of requestedCounts) hardConstraints.push(`requested_count:${count}`);
  for (const tone of tones) hardConstraints.push(tone);
  for (const lengthConstraint of lengthConstraints) hardConstraints.push(lengthConstraint);
  if (outputLanguage) hardConstraints.push(`output_language:${outputLanguage}`);
  if (needsStrictEvidence) hardConstraints.push('verified_sources_only');
  if (matchesAny(raw, PATTERNS.citation)) hardConstraints.push('citations_required');
  if (hasFiles || matchesAny(raw, PATTERNS.privateContext)) hardConstraints.push('use_private_context');

  const groundingMode = hasFiles || matchesAny(raw, PATTERNS.privateContext)
    ? 'private_context_required'
    : needsStrictEvidence
      ? 'source_verification_required'
      : needsResearch
        ? 'source_verification_recommended'
        : 'general_knowledge_ok';

  const responsePolicy = [
    'answer_the_actual_request_first',
    'preserve_explicit_constraints',
    'avoid_internal_prompt_or_contract_leakage',
  ];
  if (groundingMode !== 'general_knowledge_ok') {
    responsePolicy.push('do_not_fabricate_sources_or_claims');
  }
  if (outputMode === 'inline') {
    responsePolicy.push('do_not_create_file_unless_user_asked');
  }
  if (taskType === 'chat' || taskType === 'open_qa') {
    responsePolicy.push('keep_answer_proportional_to_question');
  }
  if (outputLanguage) {
    responsePolicy.push('respond_in_requested_language');
  }
  if (lengthConstraints.includes('length:brief')) {
    responsePolicy.push('keep_answer_brief');
  }
  if (lengthConstraints.includes('length:detailed')) {
    responsePolicy.push('provide_thorough_detail');
  }
  if (tones.length) {
    responsePolicy.push('match_requested_tone');
  }

  return {
    version: INTENT_ALIGNMENT_VERSION,
    taxonomy: TAXONOMY.includes(taskType) ? taskType : 'other',
    outputMode,
    requestedFormat: requestedFormat.format,
    groundingMode,
    hardConstraints: unique(hardConstraints),
    responsePolicy: unique(responsePolicy),
  };
}

function buildUserIntentAlignmentPrompt(profile) {
  if (!profile) return '';
  const lines = [
    `Intent alignment profile: ${profile.version}`,
    `Task taxonomy: ${profile.taxonomy}`,
    `Output mode: ${profile.outputMode}`,
    `Requested format: ${profile.requestedFormat || 'none'}`,
    `Grounding mode: ${profile.groundingMode}`,
    `Hard constraints: ${profile.hardConstraints.length ? profile.hardConstraints.join(', ') : 'none detected'}`,
    `Response policy: ${profile.responsePolicy.join(', ')}`,
    '',
    'Apply this as an internal contract only:',
    '- Be helpful: solve the requested outcome directly before adding context.',
    '- Be honest: never invent sources, files, URLs, DOIs, data, or execution results.',
    '- Be harmless: do not leak private data or unsafe instructions.',
    '- If constraints conflict or evidence is insufficient, state the verified gap clearly and continue with the closest valid deliverable.',
  ];
  return lines.join('\n');
}

module.exports = {
  INTENT_ALIGNMENT_VERSION,
  TAXONOMY,
  buildUserIntentAlignmentProfile,
  buildUserIntentAlignmentPrompt,
  extractRequestedCounts,
  extractTones,
  extractLengthConstraints,
  extractOutputLanguage,
  inferFormat,
  inferTaskType,
};
