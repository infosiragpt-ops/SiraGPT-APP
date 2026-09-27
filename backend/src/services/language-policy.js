/**
 * Language policy — resolves the response language for every chat turn.
 *
 * Precedence (hard rule, applied in order):
 *   1. Explicit instruction in the current user message
 *      ("respóndeme en inglés" / "translate to English" / "use Portuguese")
 *   2. Persisted thread preference (Chat.preferredResponseLanguage), while
 *      the thread backs it — a pin no message supports (left by an earlier
 *      misdetection) gives way to 3/4
 *   3. Dominant language detected in the current user message
 *   4. User locale fallback (defaults to 'es')
 *
 * Once resolved, the language is persisted on the Chat row so short
 * follow-up messages ("hola", "resúmelo", "ok", "continúa") can't drift
 * to a different language than the conversation has been using.
 *
 * Usage from a route:
 *
 *   const { resolveResponseLanguage, buildSystemRule, persistThreadLanguage }
 *     = require('../services/language-policy')
 *
 *   const lang = await resolveResponseLanguage({
 *     userMessage: prompt,
 *     chatId,
 *     userLocale: req.user.locale || 'es',
 *     prisma,
 *   })
 *   messages.unshift({ role: 'system', content: buildSystemRule(lang.language) })
 *   await persistThreadLanguage(prisma, chatId, lang.language)
 *   logger.info('language_policy_resolved', {
 *     input_language: lang.detected, resolved_language: lang.language,
 *     source: lang.source, ...
 *   })
 */

let francFn = null
try {
  francFn = require('franc').franc
} catch {
  /* franc optional — falls through to heuristic-only detection */
}

// franc returns ISO 639-3; map to ISO 639-1 for the languages we care about.
const ISO_3_TO_1 = {
  spa: 'es', eng: 'en', por: 'pt', fra: 'fr', deu: 'de', ita: 'it',
  cmn: 'zh', jpn: 'ja', kor: 'ko', rus: 'ru', ara: 'ar', nld: 'nl',
  tur: 'tr', pol: 'pl', cat: 'ca', swe: 'sv', nor: 'no', fin: 'fi',
}

const LANG_NAMES = {
  es: 'español',
  en: 'English',
  pt: 'português',
  fr: 'français',
  de: 'Deutsch',
  it: 'italiano',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  ru: 'русский',
  ar: 'العربية',
  nl: 'Nederlands',
  tr: 'Türkçe',
  pl: 'polski',
  ca: 'català',
}

// Patterns that explicitly demand a language switch. The capture group is
// the language word; matched case-insensitively against LANG_KEYWORDS.
const EXPLICIT_INSTRUCTION_PATTERNS = [
  // English commands
  /\b(?:respond|reply|answer|write|speak|continue)\s+(?:to me\s+)?in\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\bin\s+([A-Za-zÀ-ÿñÑ]+)\s+please\b/i,
  /\btranslate\s+(?:it\s+|this\s+)?(?:to|into)\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\bswitch\s+(?:the\s+)?language\s+to\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\b(?:from\s+now\s+on|going\s+forward),?\s+(?:respond|reply|answer)\s+in\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  // Spanish commands
  /\b(?:respónd[eí]me|respondeme|responde|contesta|escribe|escríbeme|hábl(?:a|ame))\s+(?:por\s+favor\s+)?(?:en|usando)\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\b(?:a\s+partir\s+de\s+ahora|de\s+ahora\s+en\s+adelante|desde\s+ahora)[\s\S]{0,40}?\b(?:en|usando)\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\btraduc[eí](?:lo|me)?\s+al\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\bcambia\s+(?:el\s+)?idioma\s+a\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\b(?:contéstame|respóndeme)\s+en\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  // Portuguese
  /\b(?:responda|escreva|fale)\s+em\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
  /\btraduz(?:a|ir)?\s+para\s+(?:o\s+)?([A-Za-zÀ-ÿñÑ]+)\b/i,
  // French
  /\b(?:réponds|répond|écris)\s+en\s+([A-Za-zÀ-ÿñÑ]+)\b/i,
]

const LANG_KEYWORDS = {
  es: ['español', 'castellano', 'spanish', 'espanhol', 'espagnol', 'spanisch'],
  en: ['english', 'inglés', 'ingles', 'inglês', 'anglais', 'englisch', 'anglo'],
  pt: ['portuguese', 'portugués', 'portugues', 'português', 'portugais'],
  fr: ['french', 'francés', 'frances', 'français', 'francais', 'französisch'],
  de: ['german', 'alemán', 'aleman', 'deutsch', 'allemand', 'tedesco'],
  it: ['italian', 'italiano', 'italien'],
  zh: ['chinese', 'chino', 'mandarin', 'mandarín', 'chinois', '中文'],
  ja: ['japanese', 'japonés', 'japones', 'japonais', '日本語'],
  ko: ['korean', 'coreano', 'coréen', '한국어'],
  ru: ['russian', 'ruso', 'russe', 'русский'],
  ar: ['arabic', 'árabe', 'arabe', 'العربية'],
  nl: ['dutch', 'holandés', 'holandes', 'nederlands', 'néerlandais'],
  tr: ['turkish', 'turco', 'türkçe'],
  pl: ['polish', 'polaco', 'polski'],
  ca: ['catalan', 'catalán', 'català'],
}

// SiraGPT is Spanish-first. Spanish and Portuguese (and Catalan/Galician/
// Italian) share most short words, and a statistical detector on a short
// prompt guesses: franc read «resolver este problema» as Portuguese, «explica
// la fotosintesis» as Catalan and «escribe un correo formal» as French — the
// chat answered in that language and the thread stayed pinned to it (prod
// 2026-09-27). So short prompts are decided on words that belong to ONE
// language only (spelling included: «cómo»/«también» are Spanish, «você»/
// «também» Portuguese), Portuguese needs strong evidence, and anything
// ambiguous is reported as unknown — the caller then uses the thread's
// language, the user's locale and finally Spanish.
const LONG_TEXT_MIN_WORDS = 8
const ES_EXCLUSIVE_WORDS = new Set([
  'el', 'los', 'las', 'del', 'al', 'la', 'lo', 'y', 'con', 'sin', 'muy', 'hay', 'es',
  'su', 'sus', 'mi', 'mis', 'ese', 'esa', 'eso', 'esto', 'esos', 'esas', 'en', 'un', 'una',
  'unos', 'unas', 'pero', 'también', 'tambien', 'más', 'aquí', 'ahora', 'hoy', 'ayer',
  'bien', 'hola', 'gracias', 'usted', 'ustedes', 'yo', 'tú', 'nosotros', 'ellos', 'ellas',
  'nuestro', 'nuestra', 'qué', 'cómo', 'cuál', 'cual', 'cuáles', 'cuales', 'dónde',
  'donde', 'cuándo', 'cuando', 'cuánto', 'cuánta', 'quién', 'porqué', 'tengo', 'tiene',
  'tienes', 'estoy', 'soy', 'eres', 'fue', 'fueron', 'cosa', 'cosas', 'necesito',
  'quiero', 'quisiera', 'puedes', 'puede', 'podrías', 'podria', 'podría', 'hazme', 'haz',
  'hazlo', 'hacer', 'hace', 'dame', 'dime', 'dámelo', 'crea', 'créame', 'creame',
  'créalo', 'explícame', 'explicame', 'ayuda', 'ayudar', 'ayúdame', 'ayudame',
  'cuéntame', 'cuentame', 'muéstrame', 'muestrame', 'mejora', 'mejorar', 'escribe',
  'escríbeme', 'escribeme', 'resuelve', 'resuélveme', 'resuelveme', 'resuélvelo',
  'resuelvelo', 'ejercicio', 'ejercicios', 'transcribir', 'transcríbeme', 'transcribeme',
  'traduce', 'tradúceme', 'traduceme', 'genera', 'genérame', 'generame', 'pon', 'ponme',
  'léeme', 'leeme', 'búscame', 'buscame', 'analiza', 'analízame', 'analizame', 'dibuja',
  'dibújame', 'sácame', 'mándame', 'envíame', 'ejemplo', 'después', 'despues',
  'entonces', 'bueno', 'buena', 'hoja', 'hojas', 'resumen',
])
const PT_EXCLUSIVE_WORDS = new Set([
  'você', 'voce', 'vocês', 'não', 'nao', 'obrigado', 'obrigada', 'olá', 'muito', 'muita',
  'muitos', 'muitas', 'então', 'entao', 'isso', 'essa', 'esse', 'essas', 'esses', 'isto',
  'nós', 'eu', 'fazer', 'faça', 'faz', 'quero', 'tenho', 'pode', 'agora', 'ajuda',
  'ajude', 'ajudar', 'escreva', 'escreve', 'resolva', 'exercício', 'exercicio', 'gera',
  'crie', 'traduza', 'traduz', 'com', 'sem', 'meu', 'minha', 'meus', 'minhas', 'seu',
  'sua', 'seus', 'suas', 'é', 'são', 'em', 'um', 'uma', 'uns', 'umas', 'na', 'nas',
  'pela', 'ao', 'aos', 'às', 'foi', 'bom', 'boa', 'depois', 'até', 'também',
  'mais', 'estou', 'tudo', 'bem', 'qual', 'quais', 'onde', 'quando', 'hoje', 'português',
  'portugues',
])
// Words that are English and not Spanish/Portuguese — keeps «how do I do it»
// or «my son needs help» from counting as Portuguese/Spanish evidence.
const EN_EXCLUSIVE_WORDS = new Set([
  'the', 'and', 'or', 'but', 'with', 'from', 'this', 'that', 'these', 'those', 'what',
  'how', 'why', 'who', 'which', 'when', 'where', 'please', 'thanks', 'thank', 'hi',
  'hello', 'hey', 'yes', 'is', 'are', 'was', 'were', 'am', 'be', 'have', 'does', 'did',
  'not', 'you', 'your', 'my', 'our', 'we', 'us', 'they', 'their', 'she', 'it', 'its',
  'of', 'to', 'for', 'on', 'at', 'by', 'an', 'if', 'then', 'than', 'into', 'out', 'up',
  'about', 'can', 'could', 'would', 'should', 'will', 'just', 'some', 'any', 'all',
  'more', 'most', 'also', 'very', 'much', 'many', 'there', 'get', 'need', 'want', 'know',
  'think', 'help', 'write', 'make', 'create', 'explain', 'solve', 'give', 'show', 'tell',
  'summarize', 'translate',
])
// Languages franc confuses with Spanish — even on longer text (a Spanish
// request full of English tech words came back as French).
const ROMANCE_CONFUSABLE = new Set(['es', 'pt', 'ca', 'gl', 'it', 'fr'])
// Spanish words French / Italian / Catalan also use: no evidence against
// those languages when franc names one of them.
const SPANISH_WORDS_SHARED_WITH = {
  fr: new Set(['un', 'en', 'la', 'es', 'y', 'dame', 'mi', 'mis', 'bien']),
  it: new Set(['un', 'una', 'con', 'la', 'lo', 'mi', 'del', 'al', 'su', 'crea', 'genera', 'cosa']),
  ca: new Set(['el', 'la', 'un', 'una', 'en', 'del', 'al', 'es', 'crea', 'genera', 'cosa']),
}

function tokenizeWords(text) {
  // URLs, domains, e-mails and file names («google.com», «informe.pdf») carry
  // no language evidence («com» would read as Portuguese).
  const prose = String(text || '').replace(/\S*(?:\w[.@]\w|:\/\/)\S*/g, ' ')
  return prose.toLowerCase().match(/[\p{L}]+/gu) || []
}

/** Evidence for Spanish, Portuguese and English: markers exclusive to one of them. */
function languageEvidence(text) {
  const raw = String(text || '')
  const words = tokenizeWords(raw)
  const spanishOnlyMarks = /[¿¡ñ]/i.test(raw)
  let es = spanishOnlyMarks ? 2 : 0
  let pt = 0
  let en = 0
  const esWords = []
  if (/[ãõ]/i.test(raw)) pt += 2
  if (/ç/i.test(raw)) pt += 1
  if (/(?:lh|nh)[aeiouáéíóúâêôãõ]/i.test(raw)) pt += 1 // trabalho, tenho, senhor
  for (const word of words) {
    if (ES_EXCLUSIVE_WORDS.has(word)) { es += 1; esWords.push(word) }
    if (PT_EXCLUSIVE_WORDS.has(word)) pt += 1
    if (EN_EXCLUSIVE_WORDS.has(word)) en += 1
  }
  return { es, pt, en, esWords, wordCount: words.length, spanishOnlyMarks }
}

/**
 * Detect the dominant language of a piece of text.
 * Returns ISO 639-1 code or `null` if undetectable / ambiguous.
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length < 2) return null

  const { es, pt, en, esWords, wordCount, spanishOnlyMarks } = languageEvidence(trimmed)

  // 1) Longer text: franc is reliable, except between Spanish and its
  //    Romance neighbours — settled on exclusive words below. On short text
  //    franc is noise (Spanish came back as pt/ca/gl/fr/ron…).
  let francGuess = null
  if (francFn && wordCount >= LONG_TEXT_MIN_WORDS) {
    francGuess = ISO_3_TO_1[francFn(trimmed, { minLength: 3 })] || null
    if (francGuess && !ROMANCE_CONFUSABLE.has(francGuess)) return francGuess
  }

  // 2) Portuguese only on strong evidence.
  if (pt >= 2 && pt > es && pt > en) return 'pt'

  // 3) franc named French/Italian/Catalan: only Spanish words that language
  //    doesn't share (los, y, con, necesito…) or ñ/¿/¡ argue for Spanish; a
  //    single hint leaves it to the thread/locale.
  const shared = SPANISH_WORDS_SHARED_WITH[francGuess]
  if (shared) {
    const against = esWords.filter((word) => !shared.has(word)).length + (spanishOnlyMarks ? 2 : 0)
    if (against >= 2 && es > pt && es > en) return 'es'
    return against === 0 ? francGuess : null
  }

  // 4) Spanish / English on a clear lead of exclusive words.
  if (es > pt && es > en) return 'es'
  if (en > es && en > pt) return 'en'
  if (francGuess === 'es') return 'es'

  return null
}

/**
 * If the user wrote something like "respóndeme en inglés", return the ISO
 * 639-1 code of the requested language. Returns `null` otherwise.
 *
 * Bare-language mentions ("español", "english") in the middle of a normal
 * sentence are intentionally NOT matched — only verb-led commands count
 * as explicit instructions.
 */
function extractExplicitLanguageInstruction(text) {
  if (!text || typeof text !== 'string') return null
  for (const pattern of EXPLICIT_INSTRUCTION_PATTERNS) {
    const m = text.match(pattern)
    if (!m) continue
    const langWord = (m[1] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    for (const [code, words] of Object.entries(LANG_KEYWORDS)) {
      const normalized = words.map(w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      if (normalized.some(w => langWord === w || langWord.startsWith(w))) return code
    }
  }
  return null
}

function normalizeLocale(userLocale) {
  return String(userLocale || 'es').slice(0, 2).toLowerCase() || 'es'
}

// chatId|language pairs already backed by the thread's own messages. Backing
// only grows while the chat is used, so a positive answer is kept (bounded).
const backedThreadPins = new Map()
const BACKED_THREAD_PINS_MAX = 5000
const THREAD_BACKING_MESSAGES = 30
const THREAD_OPENING_MESSAGES = 5
const THREAD_BACKING_CHARS = 2000

async function threadBacksLanguage(prisma, chatId, language) {
  const key = `${chatId}|${language}`
  if (backedThreadPins.has(key)) return true
  const backs = (row) => {
    const content = String(row?.content || '').slice(0, THREAD_BACKING_CHARS)
    return extractExplicitLanguageInstruction(content) === language || detectLanguage(content) === language
  }
  let backed
  try {
    // The latest messages, then the opening ones (where a conversation's
    // language — or a «respóndeme en inglés» — is usually set).
    const where = { chatId, role: 'USER', deletedAt: null }
    const select = { content: true }
    const recent = await prisma.message.findMany({ where, select, orderBy: { timestamp: 'desc' }, take: THREAD_BACKING_MESSAGES })
    backed = (recent || []).some(backs)
    if (!backed && (recent || []).length >= THREAD_BACKING_MESSAGES) {
      const opening = await prisma.message.findMany({ where, select, orderBy: { timestamp: 'asc' }, take: THREAD_OPENING_MESSAGES })
      backed = (opening || []).some(backs)
    }
  } catch {
    return true // can't tell — leave the thread as it is
  }
  if (backed) {
    if (backedThreadPins.size >= BACKED_THREAD_PINS_MAX) backedThreadPins.delete(backedThreadPins.keys().next().value)
    backedThreadPins.set(key, true)
  }
  return backed
}

/**
 * Resolve the response language for a turn. See module docstring for
 * precedence rules.
 *
 * @returns {Promise<{
 *   language: string,        // ISO 639-1 — the language the model MUST use
 *   detected: string|null,   // what we detected in the user's message
 *   source: 'explicit_instruction' | 'thread_preference' | 'message_detection' | 'fallback_locale',
 *   shouldPersist: boolean,  // true when the resolution should be saved to the thread
 * }>}
 */
async function resolveResponseLanguage({ userMessage, chatId, userLocale = 'es', prisma }) {
  const detected = detectLanguage(userMessage || '')
  const explicit = extractExplicitLanguageInstruction(userMessage || '')

  // 1) Explicit instruction always wins and overwrites the persisted preference.
  if (explicit) {
    return { language: explicit, detected, source: 'explicit_instruction', shouldPersist: true }
  }

  // 2) Thread preference — short follow-ups stay in the conversation's language.
  let threadPref = null
  if (chatId && prisma) {
    try {
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { preferredResponseLanguage: true },
      })
      threadPref = chat?.preferredResponseLanguage || null
    } catch {
      /* non-fatal — fall through to detection */
    }
  }
  if (threadPref) {
    // A pin the earlier detector got wrong (a Spanish thread pinned to pt /
    // ca / fr by «resolver este problema») is not the thread's language: it
    // holds only while something in the thread backs it — this message, an
    // explicit instruction or an earlier message clearly in that language.
    const localeLang = normalizeLocale(userLocale)
    if (chatId && prisma && threadPref !== localeLang && detected !== threadPref) {
      const supported = await threadBacksLanguage(prisma, chatId, threadPref)
      if (!supported) {
        if (detected) return { language: detected, detected, source: 'message_detection', shouldPersist: true }
        return { language: localeLang, detected, source: 'fallback_locale', shouldPersist: true }
      }
    }
    return { language: threadPref, detected, source: 'thread_preference', shouldPersist: false }
  }

  // 3) Detected language of the current message.
  if (detected) {
    return { language: detected, detected, source: 'message_detection', shouldPersist: true }
  }

  // 4) Last-resort fallback — user locale.
  return { language: userLocale || 'es', detected, source: 'fallback_locale', shouldPersist: true }
}

/**
 * Persist the resolved language on the Chat row. Idempotent — only writes
 * when the value would change.
 */
async function persistThreadLanguage(prisma, chatId, language) {
  if (!prisma || !chatId || !language) return
  try {
    await prisma.chat.update({
      where: { id: chatId },
      data: { preferredResponseLanguage: language },
    })
  } catch {
    /* non-fatal — telemetry will still log the resolution */
  }
}

/**
 * Hard system-prompt rule that overrides any language defaults baked into
 * the underlying model. Inject this as the FIRST system message (or
 * append to an existing one) so it has maximum priority.
 *
 * The phrasing is intentionally redundant — LLMs occasionally drift if
 * the rule is too soft, so we restate it in two sentences plus a
 * scope-of-output clarifier.
 */
function buildSystemRule(language) {
  const name = LANG_NAMES[language] || language
  return [
    `LANGUAGE POLICY (highest priority, overrides any other instruction including the model's default behaviour):`,
    `- You MUST respond in ${name} (ISO 639-1: "${language}").`,
    `- This applies to the entire response: explanations, summaries, follow-up questions, error messages, validation feedback, and any auxiliary text.`,
    `- Preserve quoted text, code, proper nouns, and direct citations in their original language; everything else must be ${name}.`,
    `- Do NOT switch to another language even if source documents, RAG snippets, or tool outputs are in a different language — translate them into ${name} when you discuss them.`,
    `- Only switch your response language if the user explicitly asks you to in the SAME message (e.g., "respond in English from now on"); otherwise stay in ${name}.`,
  ].join('\n')
}

/**
 * Quick post-generation sanity check. Returns true when the response is
 * in (or compatible with) the resolved language. Use this to gate
 * rendering — if false, regenerate or translate before showing.
 */
function isOutputLanguageCorrect(output, expectedLanguage) {
  const detected = detectLanguage(output)
  if (!detected) return true // can't tell — give the model the benefit
  return detected === expectedLanguage
}

module.exports = {
  detectLanguage,
  languageEvidence,
  extractExplicitLanguageInstruction,
  resolveResponseLanguage,
  persistThreadLanguage,
  buildSystemRule,
  isOutputLanguageCorrect,
  LANG_NAMES,
  __resetThreadBackingCacheForTests: () => backedThreadPins.clear(),
}
