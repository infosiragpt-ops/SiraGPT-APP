import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

import {
  COUNT_ADJ_RE_FRAGMENT,
  COUNT_NOUN_RE_FRAGMENT,
  COUNT_NUMBER_RE_FRAGMENT,
  IMAGE_COUNT_MAX,
  IMAGE_FRAME_LEXICON,
  IMAGE_TYPO_REPLACEMENTS,
  detectExplicitImageCount,
  detectImageFrame,
} from "../lib/chat/image-request-lexicon"
import { detectComposerAutoMode } from "../lib/chat/composer-auto-mode"

/**
 * "Miles de escenarios": a deterministic generator combines verbs, quantity
 * phrases, nouns, subjects (with numeric distractors), frame/platform phrases,
 * fillers and chat typos into thousands of Spanish/English image requests.
 * Every phrasing is run through
 *   • the composer lexicon (what the chip shows), and
 *   • the backend image-directive (what the generator renders),
 * and both must return the expected count/frame AND agree with each other.
 * The tables themselves are also compared entry for entry so the two modules
 * cannot drift apart silently.
 */
const nodeRequire: NodeRequire = require
// The backend module is plain CommonJS with no dependencies; root tests may
// load backend/src modules directly (CI installs backend deps for that).
// Resolved from the repo root: the compiled test runs from .test-dist/tests.
const BACKEND_DIRECTIVE_PATH = path.join(process.cwd(), "backend/src/services/agents/image-directive.js")
const backendDirective = nodeRequire(BACKEND_DIRECTIVE_PATH) as {
  IMAGE_FRAME_LEXICON: Array<{ tier: number; frame: string; id: string; pattern: string }>
  IMAGE_COUNT_MAX: number
  detectExplicitImageCount: (text: string) => number | null
  detectImageCount: (text: string) => number | null
  detectImageFrame: (text: string) => { frame: string; orientation: string; source: string } | null
  COUNT_LEXICON: { noun: string; adjective: string; number: string }
  TYPO_REPLACEMENTS: Array<[RegExp, string]>
}

type CountPhrase = { text: string; count: number | null; plural: boolean; lang: "es" | "en" }
type FramePhrase = { text: string; frame: string | null; lang: "es" | "en" | "any" }

const VERBS_ES = ["crea", "créame", "genera", "genérame", "hazme", "haz", "dame", "quiero", "necesito", "dibuja", "diseña", "ilustra", "por favor crea", "oye sira, genera"]
const VERBS_EN = ["make", "create", "generate", "draw", "design", "please create", "i want", "i need"]

const COUNTS_ES: CountPhrase[] = [
  { text: "una", count: 1, plural: false, lang: "es" },
  { text: "una sola", count: 1, plural: false, lang: "es" },
  { text: "solo una", count: 1, plural: false, lang: "es" },
  { text: "un par de", count: 2, plural: true, lang: "es" },
  { text: "2", count: 2, plural: true, lang: "es" },
  { text: "dos", count: 2, plural: true, lang: "es" },
  { text: "3", count: 3, plural: true, lang: "es" },
  { text: "tres", count: 3, plural: true, lang: "es" },
  { text: "3 nuevas", count: 3, plural: true, lang: "es" },
  { text: "4", count: 4, plural: true, lang: "es" },
  { text: "cuatro", count: 4, plural: true, lang: "es" },
  { text: "5", count: 5, plural: true, lang: "es" },
  { text: "cinco", count: 5, plural: true, lang: "es" },
  { text: "varias", count: 3, plural: true, lang: "es" },
  { text: "algunas", count: 3, plural: true, lang: "es" },
  { text: "distintas", count: 3, plural: true, lang: "es" },
  { text: "12", count: 5, plural: true, lang: "es" },
  { text: "media docena de", count: 5, plural: true, lang: "es" },
  { text: "", count: null, plural: true, lang: "es" },
]
const COUNTS_EN: CountPhrase[] = [
  { text: "a", count: 1, plural: false, lang: "en" },
  { text: "one", count: 1, plural: false, lang: "en" },
  { text: "just one", count: 1, plural: false, lang: "en" },
  { text: "a couple of", count: 2, plural: true, lang: "en" },
  { text: "two", count: 2, plural: true, lang: "en" },
  { text: "3", count: 3, plural: true, lang: "en" },
  { text: "three different", count: 3, plural: true, lang: "en" },
  { text: "four", count: 4, plural: true, lang: "en" },
  { text: "five", count: 5, plural: true, lang: "en" },
  { text: "several", count: 3, plural: true, lang: "en" },
  { text: "10", count: 5, plural: true, lang: "en" },
  { text: "", count: null, plural: true, lang: "en" },
]

// [singular, plural, composer-noun?] — the third flag marks nouns the composer
// classifier recognises as a picture request (mode assertion).
const NOUNS_ES: Array<[string, string, boolean]> = [
  ["imagen", "imágenes", true],
  ["imagen", "imagenes", true],
  ["foto", "fotos", true],
  ["fotografía", "fotografías", true],
  ["ilustración", "ilustraciones", true],
  ["versión", "versiones", false],
  ["opción", "opciones", false],
  ["logo", "logos", true],
]
const NOUNS_EN: Array<[string, string, boolean]> = [
  ["image", "images", true],
  ["picture", "pictures", true],
  ["photo", "photos", true],
  ["illustration", "illustrations", true],
  ["version", "versions", false],
]

const SUBJECTS_ES = [
  "de un perro corriendo",
  "de un gato astronauta",
  "de una ciudad futurista de noche",
  "de mi cafetería",
  "de 3 gatos jugando",
  "de 2 personas en la playa",
  "de un colibrí cantando",
  "de un paisaje con montañas y un lago",
  "para mi negocio de comida",
  "de una mujer leyendo en 1999",
]
const SUBJECTS_EN = [
  "of a dragon over a castle",
  "of 3 cats playing",
  "of my coffee shop",
  "of a hummingbird singing",
  "of two friends at the beach",
]

const FRAMES_ES: FramePhrase[] = [
  { text: "", frame: null, lang: "any" },
  { text: "vertical", frame: "3:4", lang: "es" },
  { text: "horizontal", frame: "16:9", lang: "es" },
  { text: "cuadrada", frame: "1:1", lang: "es" },
  { text: "apaisada", frame: "16:9", lang: "es" },
  { text: "en formato retrato", frame: "3:4", lang: "es" },
  { text: "para historia de instagram", frame: "9:16", lang: "es" },
  { text: "para mi portada de facebook", frame: "16:9", lang: "es" },
  { text: "para tiktok", frame: "9:16", lang: "es" },
  { text: "para miniatura de youtube", frame: "16:9", lang: "es" },
  { text: "para post de instagram", frame: "1:1", lang: "es" },
  { text: "para pinterest", frame: "2:3", lang: "es" },
  { text: "para fondo de pantalla de celular", frame: "9:16", lang: "es" },
  { text: "para fondo de pantalla de pc", frame: "16:9", lang: "es" },
  { text: "para mi foto de perfil", frame: "1:1", lang: "es" },
  { text: "en 16:9", frame: "16:9", lang: "any" },
  { text: "en 9x16", frame: "9:16", lang: "any" },
  { text: "en 4 por 3", frame: "4:3", lang: "es" },
  { text: "más ancha que alta", frame: "16:9", lang: "es" },
  { text: "más alta que ancha", frame: "3:4", lang: "es" },
]
const FRAMES_EN: FramePhrase[] = [
  { text: "", frame: null, lang: "any" },
  { text: "portrait", frame: "3:4", lang: "en" },
  { text: "landscape", frame: "16:9", lang: "en" },
  { text: "square", frame: "1:1", lang: "en" },
  { text: "for my facebook cover", frame: "16:9", lang: "en" },
  { text: "for instagram stories", frame: "9:16", lang: "en" },
  { text: "for a youtube thumbnail", frame: "16:9", lang: "en" },
  { text: "in 16:9", frame: "16:9", lang: "any" },
  { text: "9x16", frame: "9:16", lang: "any" },
  { text: "widescreen", frame: "16:9", lang: "en" },
]

const FILLERS_ES = ["", "en 4k", "hiperrealista", "estilo anime", "por favor", "porfa", "rápido", "con colores cálidos"]
const FILLERS_EN = ["", "in 4k", "photorealistic", "anime style", "please", "quickly"]

// Chat typos the lexicon must absorb (token → typo).
const TYPOS: Record<string, string> = {
  "imágenes": "imajenes",
  "imagenes": "imagens",
  "horizontal": "orisontal",
  "vertical": "vertial",
  "portada": "postada",
  "instagram": "istagram",
  "facebook": "facebok",
  "youtube": "yutube",
  "cuadrada": "cuadarada",
  "dame": "dma",
  "una": "euna",
  "imagen": "iamgen",
}

type Scenario = { prompt: string; count: number | null; frame: string | null; composerImage: boolean; lang: "es" | "en" }

function expectedFrame(framePhrase: FramePhrase, noun: string): string | null {
  if (framePhrase.frame) return framePhrase.frame
  // Weak type default: a logo with no shape stated is square.
  if (/^logos?$/.test(noun)) return "1:1"
  return null
}

function buildScenarios(): Scenario[] {
  const out: Scenario[] = []
  let seed = 7
  const pick = <T,>(arr: T[]): T => { seed = (seed * 9301 + 49297) % 233280; return arr[seed % arr.length] }

  const build = (
    lang: "es" | "en",
    verbs: string[],
    counts: CountPhrase[],
    nouns: Array<[string, string, boolean]>,
    subjects: string[],
    frames: FramePhrase[],
    fillers: string[],
  ) => {
    for (const verb of verbs) {
      for (const count of counts) {
        for (const frame of frames) {
          const [singular, plural, composerNoun] = pick(nouns)
          const noun = count.plural ? plural : singular
          const subject = pick(subjects)
          const filler = pick(fillers)
          const framePhrase = frame.text
          // Frame phrase either right after the noun or at the end of the sentence.
          const layout = pick([0, 1])
          let prompt = layout === 0
            ? `${verb} ${count.text} ${noun} ${framePhrase} ${subject} ${filler}`
            : `${verb} ${count.text} ${noun} ${subject} ${framePhrase} ${filler}`
          prompt = prompt.replace(/\s+/g, " ").trim()
          // Every third scenario gets a typo on one of its tokens.
          if (out.length % 3 === 0) {
            const tokens = prompt.split(" ")
            const idx = tokens.findIndex((t) => TYPOS[t])
            if (idx >= 0) { tokens[idx] = TYPOS[tokens[idx]]; prompt = tokens.join(" ") }
          }
          out.push({ prompt, count: count.count, frame: expectedFrame(frame, noun), composerImage: composerNoun && !!verb, lang })
        }
      }
    }
  }
  build("es", VERBS_ES, COUNTS_ES, NOUNS_ES, SUBJECTS_ES, FRAMES_ES, FILLERS_ES)
  build("en", VERBS_EN, COUNTS_EN, NOUNS_EN, SUBJECTS_EN, FRAMES_EN, FILLERS_EN)
  return out
}

describe("image request parser — composer and backend share one lexicon", () => {
  it("the frame table, count fragments and typo table are identical on both sides", () => {
    assert.deepEqual(
      IMAGE_FRAME_LEXICON.map((e) => ({ tier: e.tier, frame: e.frame, id: e.id, pattern: e.pattern })),
      backendDirective.IMAGE_FRAME_LEXICON.map((e) => ({ tier: e.tier, frame: e.frame, id: e.id, pattern: e.pattern })),
    )
    assert.equal(IMAGE_COUNT_MAX, backendDirective.IMAGE_COUNT_MAX)
    assert.equal(IMAGE_COUNT_MAX, 5, "the picker offers 1..5 images")
    assert.deepEqual(
      { noun: COUNT_NOUN_RE_FRAGMENT, adjective: COUNT_ADJ_RE_FRAGMENT, number: COUNT_NUMBER_RE_FRAGMENT },
      backendDirective.COUNT_LEXICON,
      "count fragments must be byte-identical on both sides",
    )
    assert.deepEqual(
      IMAGE_TYPO_REPLACEMENTS.map(([pattern, replacement]) => [pattern, replacement]),
      backendDirective.TYPO_REPLACEMENTS.map(([re, replacement]) => [re.source, replacement]),
      "typo table must be identical on both sides",
    )
  })

  it("runs thousands of generated phrasings through both parsers with identical, expected results", () => {
    const scenarios = buildScenarios()
    assert.ok(scenarios.length >= 3000, `expected thousands of scenarios, got ${scenarios.length}`)
    const failures: string[] = []
    let composerChecked = 0
    for (const s of scenarios) {
      const feCount = detectExplicitImageCount(s.prompt)
      const beCount = backendDirective.detectExplicitImageCount(s.prompt)
      const feFrame = detectImageFrame(s.prompt)?.frame ?? null
      const beFrame = backendDirective.detectImageFrame(s.prompt)?.frame ?? null
      if (feCount !== s.count) failures.push(`count fe ${JSON.stringify(s.prompt)} → ${feCount}, expected ${s.count}`)
      if (beCount !== s.count) failures.push(`count be ${JSON.stringify(s.prompt)} → ${beCount}, expected ${s.count}`)
      if (feFrame !== s.frame) failures.push(`frame fe ${JSON.stringify(s.prompt)} → ${feFrame}, expected ${s.frame}`)
      if (beFrame !== s.frame) failures.push(`frame be ${JSON.stringify(s.prompt)} → ${beFrame}, expected ${s.frame}`)
      // Legacy contract for the agent tools: only counts above 1.
      const legacy = backendDirective.detectImageCount(s.prompt)
      if (legacy !== (s.count != null && s.count > 1 ? s.count : null)) failures.push(`legacy ${JSON.stringify(s.prompt)} → ${legacy}`)
      if (s.composerImage) {
        composerChecked += 1
        const decision = detectComposerAutoMode(s.prompt)
        if (decision?.mode !== "image") {
          failures.push(`composer mode ${JSON.stringify(s.prompt)} → ${decision?.mode ?? null}`)
        } else {
          if ((decision.settings.imageCount ?? null) !== s.count) failures.push(`composer count ${JSON.stringify(s.prompt)} → ${decision.settings.imageCount ?? null}, expected ${s.count}`)
          if ((decision.settings.imageAspectRatio ?? null) !== s.frame) failures.push(`composer frame ${JSON.stringify(s.prompt)} → ${decision.settings.imageAspectRatio ?? null}, expected ${s.frame}`)
        }
      }
      if (failures.length > 40) break
    }
    assert.deepEqual(failures, [], `${failures.length} failures out of ${scenarios.length} scenarios:\n${failures.slice(0, 40).join("\n")}`)
    assert.ok(composerChecked > 1000, `composer decisions checked: ${composerChecked}`)
  })

  it("resolves the precedence rules that decide the frame when several cues collide", () => {
    const cases: Array<[string, string | null]> = [
      ["una imagen vertical para historia de instagram", "9:16"], // surface preset beats generic shape
      ["dibuja un poster horizontal en 4k de una ciudad", "16:9"], // generic shape beats type default
      ["un poster de una banda de rock", "2:3"], // type default alone
      ["un logo cuadrado", "1:1"],
      ["un logo horizontal para la web", "16:9"],
      ["una imagen vertical pero en 16:9", "16:9"], // explicit ratio beats everything
      ["quiero que la imagen del colibrí sea horizontal para mi portada de Facebook", "16:9"],
      ["quiero que la imagen del colibrí sea vertical porfavor", "3:4"],
      ["banner vertical para la tienda", "3:4"],
      ["hazme una imagen orisailntal para la portada", "16:9"],
      ["creame una imagen de un perro", null],
      ["", null],
    ]
    for (const [prompt, frame] of cases) {
      assert.equal(detectImageFrame(prompt)?.frame ?? null, frame, `fe: ${prompt}`)
      assert.equal(backendDirective.detectImageFrame(prompt)?.frame ?? null, frame, `be: ${prompt}`)
    }
  })

  it("never reads a number that belongs to the subject as a quantity", () => {
    for (const prompt of ["una imagen de 3 gatos", "una foto de 2 personas en la playa", "2 horas de trabajo y una imagen", "una imagen de un edificio de 40 pisos"]) {
      assert.equal(detectExplicitImageCount(prompt), 1, prompt)
      assert.equal(backendDirective.detectExplicitImageCount(prompt), 1, prompt)
    }
    for (const prompt of ["quiero que la imagen del colibrí sea horizontal", "mejora la foto", "3 gatos jugando", "imagen de un edificio de 40 pisos"]) {
      assert.equal(detectExplicitImageCount(prompt), null, prompt)
      assert.equal(backendDirective.detectExplicitImageCount(prompt), null, prompt)
    }
  })
})
