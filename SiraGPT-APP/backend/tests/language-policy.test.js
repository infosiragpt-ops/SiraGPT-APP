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
// assert. `throwOnFind` / `throwOnUpdate` simulate DB errors.
function makeFakePrisma({ chatRow = null, throwOnFind = false, throwOnUpdate = false } = {}) {
  const calls = { findUnique: [], update: [] }
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

  test('Spanish diacritics win over Portuguese when both could match', () => {
    // "olá" has an á (ES_HINTS) → ES is checked first → 'es'.
    assert.equal(detectLanguage('olá obrigado'), 'es')
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
    const prisma = makeFakePrisma({ chatRow: { preferredResponseLanguage: 'pt' } })
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
