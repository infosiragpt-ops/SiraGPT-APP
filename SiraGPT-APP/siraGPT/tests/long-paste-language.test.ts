import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { detectNaturalLanguage } from "../lib/long-paste"

/**
 * Extras for detectNaturalLanguage. The base suite covers 8 languages
 * (es/en/de/ru/ja/ko/zh + below-threshold). These pin the 3 remaining
 * languages with stopword-based detection (fr/it/pt) and the 3
 * script-based ones (ar/he/hi) plus a couple of threshold paths.
 */

describe("detectNaturalLanguage · stopword-based detection", () => {
  it("identifies French via stopwords", () => {
    const text = `
      Le chat est sur la table dans la cuisine. Les enfants sont à
      l'école pour la journée. Nous allons au marché avec le voisin
      et les amis pour acheter du pain et des fruits frais.
    `
    assert.equal(detectNaturalLanguage(text), "fr")
  })

  it("identifies Italian via stopwords", () => {
    const text = `
      Il gatto è sul tavolo della cucina. I bambini sono a scuola per
      la giornata. Noi andiamo al mercato con il vicino e gli amici per
      comprare del pane e della frutta fresca della stagione.
    `
    assert.equal(detectNaturalLanguage(text), "it")
  })

  it("identifies Portuguese via stopwords", () => {
    const text = `
      O gato está em cima da mesa da cozinha. Os meninos estão na escola
      durante o dia. Nós vamos ao mercado com o vizinho e os amigos para
      comprar pão e frutas frescas da época. Esta é a vida de todos.
    `
    assert.equal(detectNaturalLanguage(text), "pt")
  })
})

describe("detectNaturalLanguage · script-based detection", () => {
  it("identifies Arabic via the ؀-ۿ script range", () => {
    const text = "مرحبا بالعالم. هذا اختبار للكشف عن اللغة العربية في النص"
    assert.equal(detectNaturalLanguage(text), "ar")
  })

  it("identifies Hebrew via the ֐-׿ script range", () => {
    const text = "שלום עולם. זוהי בדיקה לזיהוי השפה העברית בטקסט הזה"
    assert.equal(detectNaturalLanguage(text), "he")
  })

  it("identifies Hindi (Devanagari ऀ-ॿ)", () => {
    const text = "नमस्ते दुनिया। यह हिंदी भाषा के पता लगाने के लिए परीक्षण है"
    assert.equal(detectNaturalLanguage(text), "hi")
  })
})

describe("detectNaturalLanguage · threshold edges", () => {
  it("returns undefined when the printable-chars count is below 16", () => {
    // Script detector requires >= 16 non-whitespace chars before it
    // can fire; below that we fall through to stopword detection which
    // also requires >= 12 words.
    assert.equal(detectNaturalLanguage("Hi"), undefined)
    assert.equal(detectNaturalLanguage("Привет"), undefined) // 6 cyrillic chars
  })

  it("returns undefined when word count is below 12 (Latin-script)", () => {
    // 11 short English words — under the 12-word floor.
    const text = "this is a test of detection but it should not match"
    assert.equal(detectNaturalLanguage(text), undefined)
  })

  it("returns undefined when stopword hits are below the score=4 floor", () => {
    // A long string of nouns / proper nouns with only minimal stopwords.
    const text = `
      siragpt cohere openai anthropic mistral groq prisma postgres redis
      docker stripe vercel railway fly heroku netlify cloudflare github
      eslint prettier biome xterm vitest playwright cypress mocha jest
    `
    assert.equal(detectNaturalLanguage(text), undefined)
  })
})
