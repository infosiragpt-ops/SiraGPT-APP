/**
 * image-request-lexicon — the composer-side MIRROR of
 * backend/src/services/agents/image-directive.js (frame + count parsing).
 *
 * The backend is the source of truth: it re-derives the frame and the count
 * from the prompt at generation time. The chip the user sees must therefore
 * be computed with the SAME tables, or the composer shows 9:16 while the
 * server renders 3:4 (a real report: "quiero que la imagen sea vertical").
 * tests/image-request-parser-scenarios.test.ts compares both modules table
 * for table and runs thousands of generated phrasings through each; edit the
 * backend module first, then copy the tables here.
 */

export type ImageFrame = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"
export type ImageFrameOrientation = "square" | "portrait" | "landscape"

export const IMAGE_FRAME_ORIENTATION: Record<ImageFrame, ImageFrameOrientation> = {
  "1:1": "square",
  "2:3": "portrait",
  "3:2": "landscape",
  "3:4": "portrait",
  "4:3": "landscape",
  "9:16": "portrait",
  "16:9": "landscape",
}

export const IMAGE_COUNT_MAX = 5

// ── Normalisation (accent + case insensitive, typo-tolerant) — same table as the backend ──

export const IMAGE_TYPO_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["\\bdma\\b", "dame"],
  ["\\beuna\\b", "una"],
  ["\\biamgen\\b", "imagen"],
  ["\\bimajen\\b", "imagen"],
  ["\\bimasgen\\b", "imagen"],
  ["\\bimgen\\b", "imagen"],
  ["\\boris[a-z]*ntal\\b", "horizontal"],
  ["\\boriz[a-z]*ntal\\b", "horizontal"],
  ["\\borizontal\\w*", "horizontal"],
  ["\\bvertial\\b", "vertical"],
  ["\\bvertica\\b", "vertical"],
  ["\\bcmabia\\b", "cambia"],
  ["\\bcanbia\\b", "cambia"],
  ["\\bgenra\\b", "genera"],
  ["\\bmimso\\b", "mismo"],
  ["\\bseleciona\\b", "selecciona"],
  ["\\bgeenracion\\b", "generacion"],
  ["\\bimajenes\\b", "imagenes"],
  ["\\bimagens\\b", "imagenes"],
  ["\\bimgs?\\b", "imagenes"],
  ["\\bfotoz\\b", "fotos"],
  ["\\bfotografis\\b", "fotografias"],
  ["\\bcuadarad[oa]\\b", "cuadrada"],
  ["\\bcuadrad\\b", "cuadrada"],
  ["\\bpostada\\b", "portada"],
  ["\\bmuniatura\\b", "miniatura"],
  ["\\bistagram\\b", "instagram"],
  ["\\bfacebok\\b", "facebook"],
  ["\\byutube\\b", "youtube"],
]

const TYPO_COMPILED = IMAGE_TYPO_REPLACEMENTS.map(([pattern, replacement]) => [new RegExp(pattern, "g"), replacement] as const)

export function normalizeImageText(text: unknown): string {
  return String(text == null ? "" : text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function canonicalizeImageTypos(normalizedText: string): string {
  let out = ` ${String(normalizedText || "")} `
  for (const [re, replacement] of TYPO_COMPILED) {
    out = out.replace(re, ` ${replacement} `)
  }
  return out.replace(/\s+/g, " ").trim()
}

export function canonicalImageText(text: unknown): string {
  return canonicalizeImageTypos(normalizeImageText(text))
}

// ── Frames — ordered tiers, first match wins (see backend for the rationale) ──

export type ImageFrameLexiconEntry = { tier: 2 | 3 | 4; frame: ImageFrame; id: string; pattern: string }

export const IMAGE_FRAME_LEXICON: ReadonlyArray<ImageFrameLexiconEntry> = [
  { tier: 2, frame: "9:16", id: "story", pattern: "\\b(?:histori(?:a|as)|story|stories|reels?|tiktok|shorts?|estados? de whatsapp|whatsapp status|status de whatsapp|pantalla (?:completa )?(?:de )?(?:celular|movil|telefono)|fondo de pantalla (?:de |del |para )?(?:celular|movil|telefono|iphone|android)|wallpaper (?:de |del |para )?(?:celular|movil|telefono|iphone|android)|para (?:el )?(?:movil|celular)|formato movil|lock ?screen)\\b" },
  { tier: 2, frame: "16:9", id: "cover-wide", pattern: "\\b(?:portadas? (?:de |para |del |de la )?(?:mi )?(?:pagina de |perfil de |canal de |grupo de )?(?:facebook|fb|linkedin|youtube|twitter|x)|(?:facebook|fb|linkedin|twitter|x) (?:cover|banner|header|portada|cabecera)|cover (?:de |para |photo (?:de |para )?)?(?:facebook|fb|linkedin|youtube|twitter)|banner (?:de |para )?(?:youtube|linkedin|twitter|x|facebook|fb|web|sitio|pagina)|cabecera (?:de |para )?(?:twitter|x|linkedin|facebook|youtube|web|pagina|blog)|miniaturas? (?:de |para )?(?:youtube|video|videos)|thumbnails? (?:de |para |for )?(?:youtube|video|videos)|youtube thumbnail|para youtube|portada (?:de |para )?(?:video|videos|blog|articulo|presentacion|diapositiva|slide)|fondo de pantalla (?:de |del |para )?(?:pc|escritorio|computadora|ordenador|laptop|monitor)|wallpaper (?:de |del |para )?(?:pc|escritorio|computadora|ordenador|laptop|monitor)|desktop wallpaper|presentacion|diapositiva|slide|pantalla (?:de )?(?:tv|television|monitor|pc)|formato (?:tv|television|cine|cinematografico|cine))\\b" },
  { tier: 2, frame: "1:1", id: "square-surface", pattern: "\\b(?:posts? (?:de |para |cuadrad[oa]s? (?:de |para )?)?(?:instagram|ig|feed|facebook|fb|linkedin)|publicacion(?:es)? (?:de |para )?(?:instagram|ig|feed|facebook|fb|linkedin)|feed (?:de )?(?:instagram|ig)|fotos? de perfil|profile (?:picture|photo|pic)|avatar(?:es)?|pfp|icono(?:s)? de (?:app|aplicacion|apps)|app icon|favicon|portadas? (?:de |para )?(?:album|disco|cancion|playlist|spotify|podcast)|album cover)\\b" },
  { tier: 2, frame: "2:3", id: "pin", pattern: "\\b(?:pin(?:es)? (?:de |para )?pinterest|pinterest|tarjetas? (?:de )?(?:visita|presentacion)|business cards?)\\b" },
  { tier: 2, frame: "3:4", id: "paper-portrait", pattern: "\\b(?:(?:hoja|pagina|formato|tamano) ?(?:a4|carta|oficio|letter)(?: vertical)?|a4 vertical|carta vertical|folleto vertical|documento vertical|portrait a4)\\b" },
  { tier: 2, frame: "4:3", id: "paper-landscape", pattern: "\\b(?:a4 horizontal|carta horizontal|hoja horizontal|pagina horizontal|formato (?:4:3|clasico)|pantalla (?:de )?(?:tablet|ipad)|ipad|tablet)\\b" },
  { tier: 3, frame: "1:1", id: "square", pattern: "\\b(?:cuadrad[oa]s?|square|1 a 1|uno a uno|formato cuadrado)\\b" },
  { tier: 3, frame: "3:4", id: "portrait", pattern: "\\b(?:vertical(?:es)?|verticalmente|retrato|portrait|mas alt[oa] que anch[oa]|de pie|en vertical|orientacion vertical|formato vertical)\\b" },
  { tier: 3, frame: "16:9", id: "landscape", pattern: "\\b(?:horizontal(?:es)?|horizontalmente|apaisad[oa]s?|panoramic[oa]s?|landscape|widescreen|rectangular(?:es)?|mas anch[oa] que alt[oa]|en horizontal|orientacion horizontal|formato horizontal|cinematic[oa]|cinematografic[oa]|ultrawide|ancha)\\b" },
  { tier: 4, frame: "1:1", id: "square-type", pattern: "\\b(?:logos?|logotipos?|isotipos?|iconos?|icons?|stickers?|pegatinas?|emojis?|sellos?|insignias?|badges?)\\b" },
  { tier: 4, frame: "2:3", id: "poster-type", pattern: "\\b(?:posters?|carteles?|cartel|afiches?|flyers?|volantes?|portadas? de (?:libro|novela|revista|ebook|cuento)|book covers?|tarjetas? (?:de )?(?:invitacion|cumpleanos|navidad|boda)|invitacion(?:es)?|menus? de restaurante)\\b" },
  { tier: 4, frame: "16:9", id: "wide-type", pattern: "\\b(?:banners?|portadas?|covers?|cabeceras?|encabezados?|headers?|miniaturas?|thumbnails?|wallpapers?|fondos? de pantalla|paisajes?|panoramas?|escenas? (?:amplia|panoramica)s?)\\b" },
]

const FRAME_COMPILED = IMAGE_FRAME_LEXICON.map((entry) => ({ ...entry, re: new RegExp(entry.pattern) }))

const EXPLICIT_RATIO_COLON_RE = /\b(1:1|2:3|3:2|3:4|9:16|4:3|16:9)\b/
const EXPLICIT_RATIO_CROSS_RE = /\b(1x1|2x3|3x2|3x4|9x16|4x3|16x9)\b/
const EXPLICIT_RATIO_WORDS_RE = /\b(1|2|3|4|9|16)\s*(?:a|por|by|to)\s*(1|3|2|4|16|9)\b/

export type DetectedImageFrame = { frame: ImageFrame; orientation: ImageFrameOrientation; source: string }

export function detectImageFrame(text: unknown): DetectedImageFrame | null {
  const norm = canonicalImageText(text)
  if (!norm) return null
  const colon = norm.match(EXPLICIT_RATIO_COLON_RE)
  if (colon) {
    const frame = colon[1] as ImageFrame
    return { frame, orientation: IMAGE_FRAME_ORIENTATION[frame], source: "ratio" }
  }
  const cross = norm.match(EXPLICIT_RATIO_CROSS_RE)
  if (cross) {
    const frame = cross[1].replace("x", ":") as ImageFrame
    return { frame, orientation: IMAGE_FRAME_ORIENTATION[frame], source: "ratio" }
  }
  const words = norm.match(EXPLICIT_RATIO_WORDS_RE)
  if (words) {
    const frame = `${words[1]}:${words[2]}` as ImageFrame
    if (IMAGE_FRAME_ORIENTATION[frame]) return { frame, orientation: IMAGE_FRAME_ORIENTATION[frame], source: "ratio" }
  }
  for (const entry of FRAME_COMPILED) {
    if (entry.re.test(norm)) return { frame: entry.frame, orientation: IMAGE_FRAME_ORIENTATION[entry.frame], source: entry.id }
  }
  return null
}

// ── Count — same fragments as the backend ──

export const COUNT_NOUN_RE_FRAGMENT = "(?:imagen(?:es)?|fotos?|fotografias?|ilustracion(?:es)?|dibujos?|renders?|disenos?|propuestas?|alternativas?|version(?:es)?|variantes?|variacion(?:es)?|opcion(?:es)?|ejemplos?|muestras?|bocetos?|logos?|logotipos?|posters?|carteles?|afiches?|flyers?|banners?|miniaturas?|wallpapers?|retratos?|iconos?|stickers?|avatares?|portadas?|images?|pictures?|pics?|photos?|illustrations?|drawings?|designs?|versions?|variants?|variations?|options?|takes?|renders?|mockups?)"
export const COUNT_ADJ_RE_FRAGMENT = "(?:nuev[oa]s?|distint[oa]s?|diferentes|hermos[oa]s?|bonit[oa]s?|buen[oa]s?|posibles|pequen[oa]s?|grandes|otr[oa]s?|primer[oa]s?|mas|different|new|more|nice|good|possible|other|quick)"
export const COUNT_NUMBER_RE_FRAGMENT = "(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten|a|an)"

const COUNT_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1,
}

const COUNT_EXPLICIT_RE = new RegExp(`\\b${COUNT_NUMBER_RE_FRAGMENT}\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`)
const COUNT_MULTIPLIER_RE = new RegExp(`\\b${COUNT_NOUN_RE_FRAGMENT}\\s*(?:x\\s*(\\d)|(\\d)\\s*x)\\b|\\b(?:x\\s*(\\d)|(\\d)\\s*x)\\s*${COUNT_NOUN_RE_FRAGMENT}\\b`)
const COUNT_SINGLE_MARKER_RE = new RegExp(
  `\\b(?:una sola|un solo|solo una|solo un|solamente una|solamente un|unicamente una|nada mas una|only one|just one|a single|one single|single)\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b|\\b${COUNT_NOUN_RE_FRAGMENT}\\s+(?:nada mas|solamente|unicamente|only)\\b`,
)
const COUNT_PAIR_RE = new RegExp(`\\b(?:un par|una pareja|a pair|a couple)(?: de| of)?\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`)
const COUNT_HALF_DOZEN_RE = new RegExp(`\\b(?:media docena|half a dozen)(?: de| of)?\\s+${COUNT_NOUN_RE_FRAGMENT}\\b`)
const COUNT_SEVERAL_RE = new RegExp(`\\b(?:varias|varios|algunas|algunos|diferentes|distintas|distintos|multiples|several|multiple|a few|some|various)\\s+(?:${COUNT_ADJ_RE_FRAGMENT}\\s+)?${COUNT_NOUN_RE_FRAGMENT}\\b`)
const COUNT_NOUN_PRESENT_RE = new RegExp(`\\b${COUNT_NOUN_RE_FRAGMENT}\\b`)

function wordToCount(token: string | undefined): number | null {
  if (token == null) return null
  const t = String(token).trim()
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  return Object.prototype.hasOwnProperty.call(COUNT_WORDS, t) ? COUNT_WORDS[t] : null
}

function clampImageCount(n: number | null): number | null {
  if (n == null || !Number.isFinite(n) || n < 1) return null
  return Math.min(IMAGE_COUNT_MAX, Math.max(1, Math.round(n)))
}

/** 1..5 when the text states a quantity ("una imagen" counts as 1), else null. */
export function detectExplicitImageCount(text: unknown): number | null {
  const norm = canonicalImageText(text)
  if (!norm || !COUNT_NOUN_PRESENT_RE.test(norm)) return null
  if (COUNT_SINGLE_MARKER_RE.test(norm)) return 1
  if (COUNT_HALF_DOZEN_RE.test(norm)) return IMAGE_COUNT_MAX
  if (COUNT_PAIR_RE.test(norm)) return 2
  const multiplier = norm.match(COUNT_MULTIPLIER_RE)
  if (multiplier) {
    const raw = multiplier.slice(1).find((g) => g != null)
    const n = clampImageCount(Number(raw))
    if (n) return n
  }
  const explicit = norm.match(COUNT_EXPLICIT_RE)
  if (explicit) {
    const n = clampImageCount(wordToCount(explicit[1]))
    if (n) return n
  }
  if (COUNT_SEVERAL_RE.test(norm)) return 3
  return null
}
