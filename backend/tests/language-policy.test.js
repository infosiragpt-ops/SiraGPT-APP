'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const {
  detectLanguage,
  extractExplicitLanguageInstruction,
  resolveResponseLanguage,
  persistThreadLanguage,
  buildSystemRule,
  isOutputLanguageCorrect,
  LANG_NAMES,
} = require('../src/services/language-policy')

// A hand-written prisma fake. `chatRow` is the row returned by findUnique
// (or null). `updates` records every chat.update call so persist tests can
// assert. `throwOnFind` / `throwOnUpdate` simulate DB errors. `userMessages`
// (oldest first) backs message.findMany; without it the lookup throws, which
// the policy treats as "can't tell" and keeps the thread preference.
function makeFakePrisma({ chatRow = null, throwOnFind = false, throwOnUpdate = false, userMessages = null } = {}) {
  const calls = { findUnique: [], update: [], findMany: [] }
  return {
    calls,
    chat: {
      async findUnique(args) {
        calls.findUnique.push(args)
        if (throwOnFind) throw new Error('boom-find')
        return chatRow
      },
      async update(args) {
        calls.update.push(args)
        if (throwOnUpdate) throw new Error('boom-update')
        return { id: args?.where?.id, ...args?.data }
      },
    },
    message: {
      async findMany(args) {
        calls.findMany.push(args)
        if (!userMessages) throw new Error('no message table in this fake')
        const ordered = args?.orderBy?.timestamp === 'desc' ? [...userMessages].reverse() : [...userMessages]
        return ordered.slice(0, args?.take ?? ordered.length).map((content) => ({ content }))
      },
    },
  }
}

describe('detectLanguage', () => {
  test('returns null for non-string / empty / too-short input', () => {
    assert.equal(detectLanguage(null), null)
    assert.equal(detectLanguage(undefined), null)
    assert.equal(detectLanguage(123), null)
    assert.equal(detectLanguage(''), null)
    assert.equal(detectLanguage('  '), null) // trims to length 0
    assert.equal(detectLanguage('a'), null) // length 1 < 2
  })

  test('detects Spanish via diacritic/stop-word heuristic', () => {
    assert.equal(detectLanguage('hola'), 'es')
    assert.equal(detectLanguage('¿qué tal?'), 'es')
  })

  test('detects English via stop-word heuristic', () => {
    assert.equal(detectLanguage('hello'), 'en')
    assert.equal(detectLanguage('please help me'), 'en')
  })

  test('detects Portuguese via diacritic/stop-word heuristic', () => {
    // NB: ES_HINTS is checked before PT_HINTS, and "olá" carries an accent
    // (á) that matches ES_HINTS first — so a PT message must rely on a
    // PT-only fingerprint like "você"/"obrigado" to actually resolve to pt.
    assert.equal(detectLanguage('obrigado pela ajuda'), 'pt')
    assert.equal(detectLanguage('voce obrigado'), 'pt')
  })

  test('an accent shared by both languages is not Spanish evidence', () => {
    // «olá obrigado» is Portuguese; the old heuristic read any á as Spanish.
    assert.equal(detectLanguage('olá obrigado'), 'pt')
  })

  test('returns null when no heuristic fingerprint matches', () => {
    // No ES/PT/EN stop-words or diacritics, and short enough to skip franc.
    assert.equal(detectLanguage('zzz qqq'), null)
  })
})

describe('extractExplicitLanguageInstruction', () => {
  test('returns null for non-string / empty input', () => {
    assert.equal(extractExplicitLanguageInstruction(null), null)
    assert.equal(extractExplicitLanguageInstruction(undefined), null)
    assert.equal(extractExplicitLanguageInstruction(42), null)
    assert.equal(extractExplicitLanguageInstruction(''), null)
  })

  test('Spanish command: "respóndeme en inglés" -> en', () => {
    assert.equal(extractExplicitLanguageInstruction('respóndeme en inglés'), 'en')
  })

  test('English command: "translate this to French" -> fr', () => {
    assert.equal(extractExplicitLanguageInstruction('translate this to French'), 'fr')
  })

  test('Portuguese command: "responda em português" -> pt', () => {
    assert.equal(extractExplicitLanguageInstruction('responda em português'), 'pt')
  })

  test('English "respond in Spanish" -> es', () => {
    assert.equal(extractExplicitLanguageInstruction('respond in Spanish'), 'es')
  })

  test('"in German please" pattern -> de', () => {
    assert.equal(extractExplicitLanguageInstruction('Answer me in German please'), 'de')
  })

  test('French command: "réponds en italien" -> it', () => {
    assert.equal(extractExplicitLanguageInstruction('réponds en italien'), 'it')
  })

  test('accent-led "écris" verb is NOT matched (regex \\b vs non-ASCII quirk)', () => {
    // "é" is not an ASCII word char, so the leading \b in the French pattern
    // never anchors "écris" — neither at string start nor after a space.
    assert.equal(extractExplicitLanguageInstruction('écris en italien'), null)
    assert.equal(extractExplicitLanguageInstruction('por favor écris en italien'), null)
  })

  test('bare non-command language mention returns null', () => {
    // A normal sentence merely mentioning a language is NOT a command.
    assert.equal(extractExplicitLanguageInstruction('I love the english language'), null)
    assert.equal(extractExplicitLanguageInstruction('español es un idioma bonito'), null)
  })

  test('returns null when the captured word is not a known language keyword', () => {
    assert.equal(extractExplicitLanguageInstruction('respond in gibberish'), null)
  })
})

describe('resolveResponseLanguage — precedence', () => {
  test('1) explicit instruction wins and persists (shouldPersist:true)', async () => {
    const prisma = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'pt' } })
    const res = await resolveResponseLanguage({
      userMessage: 'respóndeme en inglés',
      chatId: 'c1',
      userLocale: 'es',
      prisma,
    })
    assert.equal(res.language, 'en')
    assert.equal(res.source, 'explicit_instruction')
    assert.equal(res.shouldPersist, true)
    // Explicit short-circuits before any DB lookup.
    assert.equal(prisma.calls.findUnique.length, 0)
  })

  test('explicit instruction reports detected separately from language', async () => {
    // The message is Spanish but the explicit instruction asks for English.
    const res = await resolveResponseLanguage({
      userMessage: 'por favor respóndeme en inglés',
      chatId: null,
      prisma: null,
    })
    assert.equal(res.language, 'en')
    assert.equal(res.detected, 'es')
    assert.equal(res.source, 'explicit_instruction')
  })

  test('2) thread preference next when no explicit instruction (shouldPersist:false)', async () => {
    const prisma = makeFakePrisma({
      chatRow: { preferredResponseLanguage: 'pt' },
      userMessages: ['Você pode me ajudar a revisar o meu trabalho de conclusão de curso?'],
    })
    const res = await resolveResponseLanguage({
      userMessage: 'hola', // detection would say 'es', but thread pref wins
      chatId: 'c1',
      userLocale: 'es',
      prisma,
    })
    assert.equal(res.language, 'pt')
    assert.equal(res.source, 'thread_preference')
    assert.equal(res.shouldPersist, false)
    assert.equal(res.detected, 'es')
    assert.equal(prisma.calls.findUnique.length, 1)
    assert.deepEqual(prisma.calls.findUnique[0], {
      where: { id: 'c1' },
      select: { preferredResponseLanguage: true },
    })
  })

  test('3) message detection when no explicit + no thread pref (shouldPersist:true)', async () => {
    const prisma = makeFakePrisma({ chatRow: { preferredResponseLanguage: null } })
    const res = await resolveResponseLanguage({
      userMessage: 'hello there please',
      chatId: 'c1',
      userLocale: 'es',
      prisma,
    })
    assert.equal(res.language, 'en')
    assert.equal(res.source, 'message_detection')
    assert.equal(res.shouldPersist, true)
    assert.equal(res.detected, 'en')
  })

  test('detection path works with no chatId/prisma supplied', async () => {
    const res = await resolveResponseLanguage({ userMessage: 'obrigado pela ajuda' })
    assert.equal(res.language, 'pt')
    assert.equal(res.source, 'message_detection')
    assert.equal(res.shouldPersist, true)
  })

  test('4) fallback to userLocale when nothing detected (shouldPersist:true)', async () => {
    const res = await resolveResponseLanguage({
      userMessage: 'zzz qqq', // undetectable
      chatId: null,
      userLocale: 'fr',
      prisma: null,
    })
    assert.equal(res.language, 'fr')
    assert.equal(res.source, 'fallback_locale')
    assert.equal(res.shouldPersist, true)
    assert.equal(res.detected, null)
  })

  test('4) fallback defaults to es when userLocale absent', async () => {
    const res = await resolveResponseLanguage({ userMessage: 'zzz qqq' })
    assert.equal(res.language, 'es')
    assert.equal(res.source, 'fallback_locale')
  })

  test('fallback also applies when userLocale is empty string', async () => {
    const res = await resolveResponseLanguage({ userMessage: 'zzz qqq', userLocale: '' })
    assert.equal(res.language, 'es')
    assert.equal(res.source, 'fallback_locale')
  })

  test('DB error during findUnique is non-fatal -> falls through to detection', async () => {
    const prisma = makeFakePrisma({ throwOnFind: true })
    const res = await resolveResponseLanguage({
      userMessage: 'hello please',
      chatId: 'c1',
      userLocale: 'es',
      prisma,
    })
    assert.equal(res.language, 'en')
    assert.equal(res.source, 'message_detection')
  })

  test('no DB lookup when chatId present but prisma missing', async () => {
    const res = await resolveResponseLanguage({
      userMessage: 'hola',
      chatId: 'c1',
      prisma: null,
    })
    // No thread pref obtainable; detection wins.
    assert.equal(res.language, 'es')
    assert.equal(res.source, 'message_detection')
  })

  test('undefined userMessage is tolerated (treated as empty)', async () => {
    const res = await resolveResponseLanguage({ userLocale: 'es' })
    assert.equal(res.detected, null)
    assert.equal(res.language, 'es')
    assert.equal(res.source, 'fallback_locale')
  })
})

describe('persistThreadLanguage', () => {
  test('no-op when prisma / chatId / language missing', async () => {
    const prisma = makeFakePrisma()
    await persistThreadLanguage(null, 'c1', 'en')
    await persistThreadLanguage(prisma, null, 'en')
    await persistThreadLanguage(prisma, 'c1', null)
    assert.equal(prisma.calls.update.length, 0)
  })

  test('calls chat.update with the resolved language', async () => {
    const prisma = makeFakePrisma()
    await persistThreadLanguage(prisma, 'c1', 'en')
    assert.equal(prisma.calls.update.length, 1)
    assert.deepEqual(prisma.calls.update[0], {
      where: { id: 'c1' },
      data: { preferredResponseLanguage: 'en' },
    })
  })

  test('swallows update errors (non-fatal)', async () => {
    const prisma = makeFakePrisma({ throwOnUpdate: true })
    await assert.doesNotReject(persistThreadLanguage(prisma, 'c1', 'en'))
  })
})

describe('buildSystemRule', () => {
  test('includes the ISO code and human language name for a known language', () => {
    const rule = buildSystemRule('en')
    assert.ok(rule.includes('"en"'), 'should include ISO code in quotes')
    assert.ok(rule.includes('English'), 'should include the human name')
    assert.ok(rule.includes('LANGUAGE POLICY'))
  })

  test('uses LANG_NAMES mapping for Spanish', () => {
    const rule = buildSystemRule('es')
    assert.ok(rule.includes(LANG_NAMES.es)) // 'español'
    assert.ok(rule.includes('"es"'))
  })

  test('falls back to the raw code as the name for unknown languages', () => {
    const rule = buildSystemRule('xx')
    // name defaults to the language code itself
    assert.ok(rule.includes('(ISO 639-1: "xx")'))
    assert.ok(rule.includes('respond in xx'))
  })
})

describe('isOutputLanguageCorrect', () => {
  test('returns true when output language is undetectable (benefit of the doubt)', () => {
    assert.equal(isOutputLanguageCorrect('zzz qqq', 'en'), true)
    assert.equal(isOutputLanguageCorrect('', 'en'), true)
  })

  test('returns true when detected language matches expected', () => {
    assert.equal(isOutputLanguageCorrect('hello please', 'en'), true)
    assert.equal(isOutputLanguageCorrect('hola ¿qué tal?', 'es'), true)
  })

  test('returns false on a clear language mismatch', () => {
    // Detected 'en' but expected 'es'.
    assert.equal(isOutputLanguageCorrect('hello please thanks', 'es'), false)
    // Detected 'es' but expected 'en'.
    assert.equal(isOutputLanguageCorrect('hola ¿cómo estás?', 'en'), false)
  })
})

describe('exports', () => {
  test('module exposes the documented surface', () => {
    assert.equal(typeof extractExplicitLanguageInstruction, 'function')
    assert.equal(typeof resolveResponseLanguage, 'function')
    assert.equal(typeof persistThreadLanguage, 'function')
    assert.equal(typeof buildSystemRule, 'function')
    assert.equal(typeof isOutputLanguageCorrect, 'function')
    assert.equal(typeof detectLanguage, 'function')
    assert.equal(typeof LANG_NAMES, 'object')
  })
})

// Prod 2026-09-27: «resolver este problema» (image of (a+b)² =) was read as
// Portuguese by franc, the answer came back in Portuguese and the thread was
// pinned to 'pt'. Spanish-first: short Spanish prompts never resolve to
// another Romance language, Portuguese needs Portuguese-only markers and
// ambiguity falls back to the thread/locale/Spanish.
describe('Spanish-first detection for short prompts', () => {
  const SHORT_SPANISH = [
    'resolver este problema',
    'resolver est eejerccio',
    'resolver este ejercicio',
    'resuelve (a+b)^2',
    'resuélvelo paso a paso',
    'haz un resumen',
    'hazme una tabla con los datos',
    'crea una ppt de gestión administrativa',
    'créame un word',
    'dame un ejemplo',
    'dame ideas para mi negocio',
    'dime la respuesta',
    'explica la fotosintesis',
    'explícame esto',
    'escribe un correo formal',
    'transcribe el audio',
    'transcribe este audio',
    'transcribir el video',
    'traduce el texto',
    'traduce esto al inglés',
    'genera una imagen de un gato',
    'analiza este archivo',
    'ponme las fuentes',
    'lee el archivo',
    'ayúdame con mi tarea',
    'necesito un informe',
    'quiero un resumen corto',
    'completa el word con mis datos',
    'corrige mi texto',
    'resume este pdf',
    'busca vuelos baratos',
    'dibuja un perro',
    'continúa',
    'ok perfecto',
    'busca en google.com el precio',
  ]

  for (const prompt of SHORT_SPANISH) {
    test(`«${prompt}» resolves to Spanish`, async () => {
      const detected = detectLanguage(prompt)
      assert.ok(detected === 'es' || detected === null, `detected ${detected}`)
      const res = await resolveResponseLanguage({ userMessage: prompt, chatId: null, userLocale: 'es', prisma: null })
      assert.equal(res.language, 'es')
      const noLocale = await resolveResponseLanguage({ userMessage: prompt })
      assert.equal(noLocale.language, 'es')
    })
  }

  test('prompts with Spanish-only words are detected as Spanish outright', () => {
    for (const prompt of ['resuelve (a+b)^2', 'crea una ppt de gestión administrativa', 'escribe un correo formal', 'explica la fotosintesis', '¿qué es esto?']) {
      assert.equal(detectLanguage(prompt), 'es', prompt)
    }
  })

  test('ambiguous Romance text follows the account locale', async () => {
    const en = await resolveResponseLanguage({ userMessage: 'resolver este problema', userLocale: 'en' })
    assert.equal(en.language, 'en')
    assert.equal(en.source, 'fallback_locale')
    const pt = await resolveResponseLanguage({ userMessage: 'resolver este problema', userLocale: 'pt' })
    assert.equal(pt.language, 'pt')
  })

  const TRUE_PORTUGUESE = [
    'obrigado pela ajuda',
    'olá obrigado',
    'você pode me ajudar com isso?',
    'não entendi a pergunta',
    'olá, tudo bem?',
    'Eu preciso de ajuda com o meu trabalho de conclusão de curso',
    'faça um resumo em português',
    'qual é a capital do Brasil?',
    'escreva um email formal para o meu chefe',
    'boa noite, tudo bem com você?',
  ]
  for (const prompt of TRUE_PORTUGUESE) {
    test(`Portuguese control «${prompt}» → pt`, () => {
      assert.equal(detectLanguage(prompt), 'pt')
    })
  }

  test('a single Portuguese word is not enough to answer in Portuguese', async () => {
    assert.equal(detectLanguage('obrigado'), null)
    assert.equal((await resolveResponseLanguage({ userMessage: 'obrigado', userLocale: 'es' })).language, 'es')
    assert.equal((await resolveResponseLanguage({ userMessage: 'obrigado', userLocale: 'pt' })).language, 'pt')
  })

  test('short English stays English (no «do»/«son»/«com» false friends)', () => {
    for (const prompt of ['how do I do it', 'what do you think?', 'my son needs help', 'transcribe this audio please', 'check example.com please', 'solve this equation', 'can you help me with this?']) {
      assert.equal(detectLanguage(prompt), 'en', prompt)
    }
  })

  test('long text still uses the statistical detector for other languages', () => {
    assert.equal(detectLanguage('Can you explain how photosynthesis works in plants please'), 'en')
    assert.equal(detectLanguage('Necesito que me expliques cómo funciona la fotosíntesis en las plantas'), 'es')
    assert.equal(detectLanguage("Bonjour, pouvez-vous m'aider à écrire une lettre de motivation pour un stage"), 'fr')
    assert.equal(detectLanguage('Kannst du mir bitte helfen, eine Bewerbung für ein Praktikum zu schreiben'), 'de')
  })

  test('long Italian/French keep their language despite words shared with Spanish', () => {
    assert.equal(detectLanguage('Ciao, puoi aiutarmi con la mia tesi? Ho bisogno di una mano con la bibliografia'), 'it')
    assert.equal(detectLanguage("Je voudrais un café avec du lait s'il vous plaît et un croissant"), 'fr')
  })

  test('Spanish full of English tech words (franc says French) stays Spanish', () => {
    assert.equal(detectLanguage('necesito que me ayudes a configurar el deployment de kubernetes con helm charts y ingress controller'), 'es')
    assert.equal(detectLanguage('necesito un dashboard de marketing con los KPIs de engagement, reach y conversion rate'), 'es')
  })
})

describe('thread preference left by a misdetection heals', () => {
  const { __resetThreadBackingCacheForTests } = require('../src/services/language-policy')

  test('a pt pin that nothing in the thread backs gives way to the locale (and is re-persisted)', async () => {
    __resetThreadBackingCacheForTests()
    const prisma = makeFakePrisma({
      chatRow: { preferredResponseLanguage: 'pt' },
      userMessages: ['resolver este problema', 'resuelve (a+b)^2'],
    })
    const res = await resolveResponseLanguage({ userMessage: 'resolver este problema', chatId: 'c1', userLocale: 'es', prisma })
    assert.equal(res.language, 'es')
    assert.equal(res.source, 'fallback_locale')
    assert.equal(res.shouldPersist, true)
    assert.deepEqual(prisma.calls.findMany[0].where, { chatId: 'c1', role: 'USER', deletedAt: null })
  })

  test('a ca/fr pin from a short Spanish prompt heals the same way', async () => {
    __resetThreadBackingCacheForTests()
    for (const pin of ['ca', 'fr']) {
      const prisma = makeFakePrisma({
        chatRow: { preferredResponseLanguage: pin },
        userMessages: ['explica la fotosintesis', 'escribe un correo formal'],
      })
      const res = await resolveResponseLanguage({ userMessage: 'dame un ejemplo', chatId: 'c1', userLocale: 'es', prisma })
      assert.equal(res.language, 'es', pin)
      assert.equal(res.source, 'message_detection')
      assert.equal(res.shouldPersist, true)
    }
  })

  test('an explicit instruction earlier in the thread keeps the pin', async () => {
    __resetThreadBackingCacheForTests()
    const prisma = makeFakePrisma({
      chatRow: { preferredResponseLanguage: 'pt' },
      userMessages: ['a partir de ahora respóndeme en portugués', 'resolver este problema'],
    })
    const res = await resolveResponseLanguage({ userMessage: 'resuelve el siguiente ejercicio', chatId: 'c1', userLocale: 'es', prisma })
    assert.equal(res.language, 'pt')
    assert.equal(res.source, 'thread_preference')
  })

  test('the opening messages of a long thread still back the pin', async () => {
    __resetThreadBackingCacheForTests()
    const history = ['answer me in English from now on']
    for (let i = 0; i < 40; i += 1) history.push('ok')
    const prisma = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'en' }, userMessages: history })
    const res = await resolveResponseLanguage({ userMessage: 'continúa', chatId: 'c1', userLocale: 'es', prisma })
    assert.equal(res.language, 'en')
    assert.equal(prisma.calls.findMany.length, 2)
  })

  test('a pin the current message backs needs no lookup; same-locale pins are never questioned', async () => {
    __resetThreadBackingCacheForTests()
    const pt = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'pt' }, userMessages: [] })
    assert.equal((await resolveResponseLanguage({ userMessage: 'você pode me ajudar?', chatId: 'c1', userLocale: 'es', prisma: pt })).language, 'pt')
    const es = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'es' }, userMessages: [] })
    assert.equal((await resolveResponseLanguage({ userMessage: 'hello there please', chatId: 'c1', userLocale: 'es', prisma: es })).language, 'es')
    assert.equal(pt.calls.findMany.length + es.calls.findMany.length, 0)
  })

  test('a backed pin is remembered, and a failed lookup keeps the pin', async () => {
    __resetThreadBackingCacheForTests()
    const prisma = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'pt' }, userMessages: ['Você pode me ajudar com o meu trabalho?'] })
    assert.equal((await resolveResponseLanguage({ userMessage: 'hola', chatId: 'c1', userLocale: 'es', prisma })).language, 'pt')
    assert.equal((await resolveResponseLanguage({ userMessage: 'hola', chatId: 'c1', userLocale: 'es', prisma })).language, 'pt')
    assert.equal(prisma.calls.findMany.length, 1)
    const broken = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'pt' } })
    assert.equal((await resolveResponseLanguage({ userMessage: 'hola', chatId: 'c2', userLocale: 'es', prisma: broken })).language, 'pt')
  })
})
