/**
 * code-agent · deterministic Vite 7 + React 18 + TypeScript landing scaffold.
 *
 * The no-LLM fallback for the /code generator (docs/code/plan.md T4-T8): given
 * the intake `AgentBuildContext` it emits a complete, runnable landing-page
 * project — Tailwind v4 via @tailwindcss/vite (zero config files), Framer
 * Motion scroll reveals, Lucide icons, Syne + Space Grotesk — including the
 * mandatory «Invitar al proyecto» component.
 *
 * Pure and deterministic: no network, no Date.now/Math.random — the same ctx
 * always produces byte-identical files. All user text is escaped (escape.ts)
 * before it can reach generated HTML/JS/CSS.
 */

import type { AgentBuildContext } from "./types"
import { escapeHtml, jsStr, kebabCase, pickAccentHex } from "./escape"
import { buildAppTsx } from "./vite-app-template"
import type { FeatureIconName, LandingModel, NicheIconName } from "./vite-app-template"

export interface ScaffoldedFile {
  path: string
  language: string
  content: string
}

/** Output contract — single source of truth, also consumed by prompts.ts. */
export const VITE_LANDING_CONTRACT_PATHS = [
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "src/main.tsx",
  "src/index.css",
  "src/App.tsx",
] as const

/**
 * Version pins for the generated project. Vite 7 per spec (NOT 8);
 * @vitejs/plugin-react 4.6+ is the first line with Vite 7 peer support;
 * framer-motion 11.18.2 is the last 11.x (v12 renamed to "motion").
 */
export const VITE_DEPS = {
  react: "^18.3.1",
  "react-dom": "^18.3.1",
  "framer-motion": "^11.18.2",
  "lucide-react": "^0.454.0",
} as const

export const VITE_DEV_DEPS = {
  "@tailwindcss/vite": "^4.1.0",
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  "@vitejs/plugin-react": "^4.7.0",
  tailwindcss: "^4.1.0",
  typescript: "^5.9.3",
  vite: "^7.1.0",
} as const

// ── theming ─────────────────────────────────────────────────────────

export interface Palette {
  bg: string
  surface: string
  fg: string
  muted: string
  accent: string
  line: string
}

interface Theme extends Palette {
  test: RegExp
}

/** Keyword → palette table (ported from backend/src/services/builder/preview.js THEMES). */
const THEMES: Theme[] = [
  {
    test: /oscur|dark|premium|lujo|elegan|night/,
    bg: "#0b0f17",
    surface: "#141b27",
    fg: "#eef2f7",
    muted: "#9aa7b8",
    accent: "#7c5cff",
    line: "#222c3a",
  },
  {
    test: /minimal|claro|blanco|light|limpio/,
    bg: "#ffffff",
    surface: "#f7f7f8",
    fg: "#111418",
    muted: "#6b7280",
    accent: "#111418",
    line: "#e7e8ea",
  },
  {
    test: /corporativ|corporate|profesional|empresa|business/,
    bg: "#f4f7fb",
    surface: "#ffffff",
    fg: "#0f1b2d",
    muted: "#5b6b80",
    accent: "#1d4ed8",
    line: "#dde5ef",
  },
  {
    test: /colorid|vibrante|colorful|alegre|divertid/,
    bg: "#fff7fb",
    surface: "#ffffff",
    fg: "#1f1235",
    muted: "#6b5b80",
    accent: "#e0218a",
    line: "#f3d9e8",
  },
  {
    test: /modern|futurist|tech/,
    bg: "#0e1116",
    surface: "#171b22",
    fg: "#f3f5f7",
    muted: "#9aa3ad",
    accent: "#22d3ee",
    line: "#252b34",
  },
]

/** Default palette when no theme keyword matches (dark editorial, violet accent). */
const DEFAULT_PALETTE: Palette = {
  bg: "#0e1116",
  surface: "#171b22",
  fg: "#f3f5f7",
  muted: "#9aa3ad",
  accent: "#7c5cff",
  line: "#252b34",
}

/** ES/EN colour-name → accent hex (whitelist; only these values ever reach CSS). */
const COLOR_NAMES: Array<[RegExp, string]> = [
  [/rojo|red/, "#e11d48"],
  [/azul|blue/, "#2563eb"],
  [/verde|green/, "#059669"],
  [/morad|violet|purpura|púrpura|lila/, "#7c3aed"],
  [/naranja|orange/, "#ea580c"],
  [/rosa|pink/, "#ec4899"],
  [/amarill|yellow/, "#f59e0b"],
  [/dorad|gold/, "#d4a017"],
  [/turquesa|cian|cyan|teal/, "#06b6d4"],
]

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
}

/** Map styleAudience/colorRef → a safe palette. User text never lands raw in CSS. */
export function paletteFor(styleAudience?: string, colorRef?: string): Palette {
  const styleText = normalize([styleAudience || "", colorRef || ""].join(" "))
  const theme = THEMES.find((t) => t.test.test(styleText))
  const palette: Palette = theme
    ? { bg: theme.bg, surface: theme.surface, fg: theme.fg, muted: theme.muted, accent: theme.accent, line: theme.line }
    : { ...DEFAULT_PALETTE }

  const hex = pickAccentHex(colorRef)
  if (hex) {
    palette.accent = hex
    return palette
  }
  const colorText = normalize(colorRef || "")
  const named = COLOR_NAMES.find(([re]) => re.test(colorText))
  if (named) palette.accent = named[1]
  return palette
}

// ── sections ────────────────────────────────────────────────────────

export type SectionId = "features" | "about" | "testimonials" | "pricing"

export interface SectionToggles {
  features: boolean
  about: boolean
  testimonials: boolean
  pricing: boolean
}

const SECTION_KEYWORDS: Array<[RegExp, SectionId]> = [
  [/caracter|feature|servicio|producto|coleccion|catalogo|menu|oferta/, "features"],
  [/about|sobre|nosotros|historia|equipo|beneficio|mision|vision/, "about"],
  [/testimoni|opinion|resena|review|clientes|social/, "testimonials"],
  [/precio|plan|tarifa|pricing/, "pricing"],
]

/**
 * Parse the free-text `sections` intake answer into toggles. Hero, Invitar,
 * CTA and Footer are always rendered; with no input the standard landing
 * sections default ON (pricing OFF); unknown tokens are ignored.
 */
export function parseSections(sections?: string): SectionToggles {
  const text = normalize(sections || "").trim()
  if (!text) return { features: true, about: true, testimonials: true, pricing: false }

  const toggles: SectionToggles = { features: false, about: false, testimonials: false, pricing: false }
  const tokens = text.split(/[,;\n/]| y | e /).map((t) => t.trim()).filter(Boolean)
  let matchedAny = false
  for (const token of tokens) {
    for (const [re, id] of SECTION_KEYWORDS) {
      if (re.test(token)) {
        toggles[id] = true
        matchedAny = true
      }
    }
  }
  // The answer didn't name any known section (e.g. "las típicas") → defaults.
  if (!matchedAny) return { features: true, about: true, testimonials: true, pricing: false }
  return toggles
}

// ── invite code ─────────────────────────────────────────────────────

/** Deterministic FNV-1a-based invite code: same brand → same "AB12-CD34". */
export function inviteCodeFor(brand: string): string {
  const seed = brand || "proyecto"
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  let x = h >>> 0
  for (let i = 0; i < 8; i++) {
    code += alphabet[x % alphabet.length]
    x = (Math.imul(x, 0x9e3779b1) ^ (x >>> 13)) >>> 0
  }
  return code.slice(0, 4) + "-" + code.slice(4)
}

// ── niche detection + copy ──────────────────────────────────────────

interface Niche {
  test: RegExp
  icon: NicheIconName
  badge: string
}

const NICHES: Niche[] = [
  { test: /cafe|coffee|cafeter|barista|tostador/, icon: "Coffee", badge: "Café de especialidad" },
  { test: /restauran|comida|cocina|gastro|food|chef/, icon: "UtensilsCrossed", badge: "Cocina con alma" },
  { test: /ropa|moda|boutique|fashion|textil|prenda/, icon: "Shirt", badge: "Moda con carácter" },
  { test: /gym|gimnasio|fitness|entren|deporte|yoga/, icon: "Dumbbell", badge: "Entrena mejor" },
  { test: /salud|clinic|medic|dental|wellness|terapia/, icon: "HeartPulse", badge: "Cuidamos de ti" },
  { test: /curso|academ|educa|escuela|colegio|formaci|taller/, icon: "GraduationCap", badge: "Aprende haciendo" },
  { test: /software|saas|tech|digital|desarrollo|codigo|plataforma|app/, icon: "CodeXml", badge: "Tecnología útil" },
  { test: /startup|lanzamiento|innovaci/, icon: "Rocket", badge: "Listos para despegar" },
  { test: /tienda|shop|ecommerce|e-commerce|venta|mercado/, icon: "ShoppingBag", badge: "Compra local" },
]

const BRAND_FALLBACKS: Record<NicheIconName, string> = {
  Coffee: "Café Aurora",
  UtensilsCrossed: "Casa Sabor",
  Shirt: "Atelier Norte",
  Dumbbell: "Forma Studio",
  HeartPulse: "Vida Plena",
  GraduationCap: "Aula Abierta",
  CodeXml: "Nimbo Labs",
  Rocket: "Despega",
  ShoppingBag: "Mercado Once",
  Sparkles: "Estudio Norte",
}

const FEATURE_ICON_CYCLE: FeatureIconName[] = ["Sparkles", "Shield", "Zap", "Star"]

const DEFAULT_FEATURE_TITLES = [
  "Calidad sin concesiones",
  "Atención cercana",
  "Procesos claros",
  "Resultados medibles",
  "Diseño con intención",
  "Mejora continua",
]

function capFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…"
}

function splitList(text: string): string[] {
  return text
    .split(/[,;\n/]| y | e /)
    .map((t) => t.trim().replace(/^[-•*]\s*/, ""))
    .filter(Boolean)
}

function detectNiche(productType: string): Niche | null {
  const text = normalize(productType)
  return NICHES.find((n) => n.test.test(text)) || null
}

/** Build the fully-escaped LandingModel from the raw intake context. */
function resolveModel(ctx: AgentBuildContext): LandingModel {
  const rawProduct = (ctx.productType || "").trim()
  const niche = rawProduct ? detectNiche(rawProduct) : null
  const icon: NicheIconName = niche ? niche.icon : "Sparkles"

  const brand = (ctx.brand || "").trim() || BRAND_FALLBACKS[icon]
  const productLabel = rawProduct || "tu proyecto"
  const audience = (ctx.styleAudience || "").trim()

  // Gender-neutral phrasing: no participle that must agree with the noun
  // («cafetería … hecho» would be wrong Spanish).
  const tagline = rawProduct
    ? clip(capFirst(productLabel) + ", con intención y oficio", 90)
    : "Tu próxima gran idea, hecha realidad"
  const description =
    "En " +
    brand +
    " creemos que " +
    productLabel +
    " merece un estándar más alto: atención al detalle, materiales honestos y una experiencia pensada para durar." +
    (audience ? " Diseñado para " + clip(audience, 80) + "." : "")
  const heroBadge = niche ? niche.badge : rawProduct ? clip(capFirst(rawProduct), 38) : "Hecho a medida"

  // Feature cards: intake answer (features for app goal, otherwise defaults).
  const requested = splitList(ctx.features || "").slice(0, 6)
  const featureTitles = requested.length >= 2 ? requested.map((t) => clip(capFirst(t), 60)) : DEFAULT_FEATURE_TITLES
  const featureBodies = [
    "Cuidamos cada detalle de " + productLabel + " para que el resultado se sienta impecable desde el primer día.",
    "Un proceso transparente, con comunicación clara y tiempos que se cumplen.",
    "Trabajamos contigo, no solo para ti: tu feedback guía cada iteración.",
    "Medimos lo que importa y lo convertimos en mejoras visibles.",
    "Cada decisión de diseño tiene un porqué — nada está puesto al azar.",
    "Nunca damos algo por terminado: siempre hay una versión mejor.",
  ]
  const features = featureTitles.map((title, i) => ({
    icon: FEATURE_ICON_CYCLE[i % FEATURE_ICON_CYCLE.length],
    titleLit: jsStr(title),
    bodyLit: jsStr(featureBodies[i % featureBodies.length]),
  }))

  const testimonials = [
    {
      nameLit: jsStr("Lucía M."),
      roleLit: jsStr("Clienta desde el primer día"),
      quoteLit: jsStr(
        capFirst(productLabel) + " con un nivel de cuidado que no había visto antes. Se nota el oficio en cada detalle.",
      ),
    },
    {
      nameLit: jsStr("Andrés P."),
      roleLit: jsStr("Cliente habitual"),
      quoteLit: jsStr("El equipo de " + brand + " entiende lo que necesitas antes de que lo pidas. Repetiré sin dudarlo."),
    },
    {
      nameLit: jsStr("Camila R."),
      roleLit: jsStr("Llegó por recomendación"),
      quoteLit: jsStr("Atención impecable y una experiencia muy por encima de lo esperado. Totalmente recomendable."),
    },
  ]

  const plans = [
    {
      nameLit: jsStr("Esencial"),
      priceLit: jsStr("9 €"),
      periodLit: jsStr("/mes"),
      perkLits: ["Todo lo básico para empezar", "Soporte por correo", "Actualizaciones incluidas"].map(jsStr),
      featured: false,
    },
    {
      nameLit: jsStr("Pro"),
      priceLit: jsStr("19 €"),
      periodLit: jsStr("/mes"),
      perkLits: [
        "Todo lo de Esencial",
        "Atención prioritaria",
        "Personalización avanzada",
        "Informes mensuales",
      ].map(jsStr),
      featured: true,
    },
    {
      nameLit: jsStr("Premium"),
      priceLit: jsStr("39 €"),
      periodLit: jsStr("/mes"),
      perkLits: ["Todo lo de Pro", "Acompañamiento dedicado", "Disponibilidad extendida"].map(jsStr),
      featured: false,
    },
  ]

  return {
    brandLit: jsStr(brand),
    taglineLit: jsStr(tagline),
    descriptionLit: jsStr(description),
    heroBadgeLit: jsStr(heroBadge),
    inviteUrlLit: jsStr("https://miapp.dev/join/" + inviteCodeFor(brand)),
    aboutTitleLit: jsStr("Hecho con propósito"),
    aboutLeadLit: jsStr(
      brand + " nació para elevar " + productLabel + " con cuidado artesanal y una visión clara de futuro.",
    ),
    aboutBodyLit: jsStr(
      "Empezamos con una convicción sencilla: las cosas bien hechas se notan. Por eso combinamos oficio, " +
        "tecnología y una obsesión sana por los detalles para que cada persona que nos visita se lleve algo mejor " +
        "de lo que esperaba.",
    ),
    ctaTitleLit: jsStr("¿Listo para empezar?"),
    ctaBodyLit: jsStr(
      "Da el primer paso hoy: cuéntanos qué necesitas y te respondemos en menos de 24 horas. Sin compromiso.",
    ),
    footerNoteLit: jsStr(clip(description, 140)),
    nicheIcon: icon,
    features,
    testimonials,
    plans,
    show: parseSections(ctx.sections),
  }
}

// ── file emitters ───────────────────────────────────────────────────

function buildPackageJson(ctx: AgentBuildContext): string {
  const name = kebabCase(ctx.brand || ctx.productType || "landing").slice(0, 60).replace(/-+$/, "") || "landing"
  const pkg = {
    name,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: VITE_DEPS,
    devDependencies: VITE_DEV_DEPS,
  }
  return JSON.stringify(pkg, null, 2) + "\n"
}

function buildViteConfig(): string {
  return `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`
}

function buildTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      isolatedModules: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["vite/client"],
    },
    include: ["src"],
  }
  return JSON.stringify(tsconfig, null, 2) + "\n"
}

function buildIndexHtml(model: LandingModel): string {
  // model fields are jsStr literals — JSON.parse them back to raw for HTML escaping.
  const brand = escapeHtml(JSON.parse(model.brandLit))
  const tagline = escapeHtml(JSON.parse(model.taglineLit))
  const description = escapeHtml(clip(JSON.parse(model.descriptionLit), 160))
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${brand} — ${tagline}</title>
    <meta name="description" content="${description}" />
  </head>
  <body>
    <div id="root">
      <p style="font-family: system-ui, sans-serif; padding: 2rem; color: #888">
        Proyecto Vite + React + TypeScript — el agente abre y arranca el preview en vivo automaticamente.
      </p>
    </div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function buildMainTsx(): string {
  return `import React from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

const container = document.getElementById("root")
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
`
}

function buildIndexCss(palette: Palette): string {
  return `@import 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Syne:wght@400..800&display=swap';
@import "tailwindcss";

:root {
  --bg: ${palette.bg};
  --surface: ${palette.surface};
  --fg: ${palette.fg};
  --muted: ${palette.muted};
  --accent: ${palette.accent};
  --line: ${palette.line};
  --font-display: 'Syne', sans-serif;
  --font-body: 'Space Grotesk', sans-serif;
}

@theme {
  --font-display: 'Syne', sans-serif;
  --font-body: 'Space Grotesk', sans-serif;
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-fg: var(--fg);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-line: var(--line);
}

html {
  scroll-behavior: smooth;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: color-mix(in oklab, var(--accent) 30%, transparent);
}
`
}

// ── entry point ─────────────────────────────────────────────────────

/**
 * Main entry: build the full deterministic landing project for the /code
 * workspace. Order follows VITE_LANDING_CONTRACT_PATHS.
 */
export function buildViteLandingFiles(ctx: AgentBuildContext): ScaffoldedFile[] {
  const model = resolveModel(ctx)
  const palette = paletteFor(ctx.styleAudience, ctx.colorRef)
  return [
    { path: "package.json", language: "json", content: buildPackageJson(ctx) },
    { path: "vite.config.ts", language: "typescript", content: buildViteConfig() },
    { path: "tsconfig.json", language: "json", content: buildTsconfig() },
    { path: "index.html", language: "html", content: buildIndexHtml(model) },
    { path: "src/main.tsx", language: "typescript", content: buildMainTsx() },
    { path: "src/index.css", language: "css", content: buildIndexCss(palette) },
    { path: "src/App.tsx", language: "typescript", content: buildAppTsx(model) },
  ]
}
