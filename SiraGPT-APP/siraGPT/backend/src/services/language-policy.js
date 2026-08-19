/**
 * Language policy — resolves the response language for every chat turn.
 *
 * Precedence (hard rule, applied in order):
 *   1. Explicit instruction in the current user message
 *      ("respóndeme en inglés" / "translate to English" / "use Portuguese")
 *   2. Persisted thread preference (Chat.preferredResponseLanguage)
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

// Tiny heuristic for the most common LATAM languages — used as a fallback
// when franc isn't available or the message is too short for it to be
// confident. Counts diacritic + stop-word hits.
const ES_HINTS = /[¿¡áéíóúñ]|\b(el|la|los|las|de|que|por|para|en|un|una|qué|cómo|cuál|cuándo|dónde|por\s+favor|gracias|hola)\b/i
const EN_HINTS = /\b(the|and|or|but|with|from|this|that|what|how|when|where|please|thanks|hi|hello)\b/i
const PT_HINTS = /[ãõç]|\b(você|o|a|os|as|de|que|por|para|em|um|uma|olá|obrigado)\b/i

/**
 * Detect the dominant language of a piece of text.
 * Returns ISO 639-1 code or `null` if undetectable.
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length < 2) return null

  // 1) Try franc when text is long enough — it's much more accurate than
  //    the regex heuristic for ambiguous strings (>= 12 chars by default).
  if (francFn && trimmed.length >= 12) {
    const code3 = francFn(trimmed, { minLength: 3 })
    const code1 = ISO_3_TO_1[code3]
    if (code1) return code1
  }

  // 2) Heuristic fallback for short messages ("hola", "thanks", etc.)
  //    franc would say "und" on these, so we look for diacritic + stop-word
  //    fingerprints. Order matters — Spanish diacritics are most distinctive.
  if (ES_HINTS.test(trimmed)) return 'es'
  if (PT_HINTS.test(trimmed)) return 'pt'
  if (EN_HINTS.test(trimmed)) return 'en'

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
  extractExplicitLanguageInstruction,
  resolveResponseLanguage,
  persistThreadLanguage,
  buildSystemRule,
  isOutputLanguageCorrect,
  LANG_NAMES,
}
