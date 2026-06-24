/**
 * Tests for the deterministic Vite 7 + React 18 + TS landing scaffold
 * (lib/code-agent/vite-scaffold.ts + vite-app-template.ts + escape.ts).
 * No React, no network — fully deterministic. Runs under `node --test`
 * (tests root tier; tests/lib is vitest-only).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import ts from "typescript"

import type { AgentBuildContext } from "../lib/code-agent/types"
import { escapeHtml, jsStr, jsxText, kebabCase, pickAccentHex } from "../lib/code-agent/escape"
import {
  VITE_DEPS,
  VITE_DEV_DEPS,
  VITE_LANDING_CONTRACT_PATHS,
  buildViteLandingFiles,
  inviteCodeFor,
  paletteFor,
  parseSections,
} from "../lib/code-agent/vite-scaffold"

function ctx(partial: Partial<AgentBuildContext> = {}): AgentBuildContext {
  return {
    goal: "landing",
    productType: "cafetería de especialidad",
    brand: "Café Aurora",
    styleAudience: "premium oscuro",
    ...partial,
  }
}

function byPath(files: Array<{ path: string; content: string }>): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]))
}

// ---- contract completeness ------------------------------------------------

test("scaffold emits exactly the contract file set", () => {
  const files = buildViteLandingFiles(ctx())
  assert.deepEqual(
    files.map((f) => f.path),
    [...VITE_LANDING_CONTRACT_PATHS],
  )
  for (const f of files) {
    assert.ok(f.content.trim().length > 0, `${f.path} must not be empty`)
  }
  const paths = files.map((f) => f.path)
  assert.ok(!paths.includes("tailwind.config.js"), "Tailwind v4: no tailwind.config.js")
  assert.ok(!paths.includes("postcss.config.js"), "Tailwind v4: no postcss.config.js")
  assert.ok(!paths.some((p) => p.endsWith(".jsx") || p.endsWith(".js")), "TS-only contract")
})

// ---- package.json ----------------------------------------------------------

test("package.json has the mandated stack, scripts and kebab-case name", () => {
  const files = byPath(buildViteLandingFiles(ctx()))
  const pkg = JSON.parse(files.get("package.json")!)
  assert.equal(pkg.name, "cafe-aurora")
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, "module")
  assert.deepEqual(pkg.scripts, { dev: "vite", build: "vite build", preview: "vite preview" })
  assert.deepEqual(pkg.dependencies, VITE_DEPS)
  assert.deepEqual(pkg.devDependencies, VITE_DEV_DEPS)
  assert.match(pkg.dependencies.react, /^\^18\./)
  assert.match(pkg.dependencies["framer-motion"], /^\^11\./)
  assert.ok(pkg.dependencies["lucide-react"])
  assert.match(pkg.devDependencies.vite, /^\^7\./)
  assert.ok(pkg.devDependencies["@vitejs/plugin-react"])
  assert.match(pkg.devDependencies.typescript, /^\^5\./)
  assert.match(pkg.devDependencies.tailwindcss, /^\^4\./)
  assert.match(pkg.devDependencies["@tailwindcss/vite"], /^\^4\./)
  assert.equal(pkg.devDependencies.postcss, undefined)
  assert.equal(pkg.devDependencies.autoprefixer, undefined)
})

// ---- determinism -----------------------------------------------------------

test("same context produces byte-identical output", () => {
  const a = buildViteLandingFiles(ctx())
  const b = buildViteLandingFiles(ctx())
  assert.deepEqual(a, b)
})

test("invite code is deterministic per brand and well-formed", () => {
  assert.equal(inviteCodeFor("Café Aurora"), inviteCodeFor("Café Aurora"))
  assert.notEqual(inviteCodeFor("Café Aurora"), inviteCodeFor("Otra Marca"))
  assert.match(inviteCodeFor("Café Aurora"), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.match(inviteCodeFor(""), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
})

// ---- mandatory Invitar component -------------------------------------------

test("App.tsx contains the mandatory «Invitar al proyecto» strings", () => {
  const app = byPath(buildViteLandingFiles(ctx())).get("src/App.tsx")!
  assert.ok(app.includes("Cualquier persona con el enlace tendrá acceso de edición"))
  assert.ok(app.includes("Enlace privado para unirse"))
  assert.ok(app.includes("¡Copiado!"))
  assert.ok(app.includes("Invitar por correo electrónico"))
  assert.ok(app.includes("navigator.clipboard.writeText"))
  assert.ok(app.includes("AnimatePresence"))
  assert.ok(app.includes("UserPlus"))
  assert.ok(app.includes("readOnly"))
  assert.ok(app.includes("https://miapp.dev/join/"))
  assert.ok(app.includes("Introduce un correo válido"))
})

// ---- scroll animations ------------------------------------------------------

test("App.tsx uses Framer Motion useInView with once: true", () => {
  const app = byPath(buildViteLandingFiles(ctx())).get("src/App.tsx")!
  assert.ok(app.includes("useInView"))
  assert.ok(app.includes("once: true"))
  assert.ok(app.includes('from "framer-motion"'))
  assert.ok(app.includes('from "lucide-react"'))
})

// ---- CSS contract ------------------------------------------------------------

test("index.css follows the Tailwind v4 + tokens + fonts contract", () => {
  const css = byPath(buildViteLandingFiles(ctx())).get("src/index.css")!
  assert.ok(css.includes('@import "tailwindcss";'))
  assert.ok(css.includes("fonts.googleapis.com"))
  assert.ok(css.includes("Syne"))
  assert.ok(css.includes("Space+Grotesk"))
  // Fonts @import must precede the tailwind import (CSS @import ordering).
  assert.ok(css.indexOf("fonts.googleapis.com") < css.indexOf('@import "tailwindcss"'))
  assert.ok(css.includes(":root"))
  for (const token of ["--bg:", "--surface:", "--fg:", "--muted:", "--accent:", "--line:"]) {
    assert.ok(css.includes(token), `missing token ${token}`)
  }
  assert.ok(css.includes("--font-display: 'Syne'"))
  assert.ok(css.includes("--font-body: 'Space Grotesk'"))
  assert.ok(css.includes("@theme inline"))
  assert.ok(!css.includes("@tailwind base"), "v3 directives are forbidden")
})

// ---- project shell -----------------------------------------------------------

test("vite.config, tsconfig, index.html and main.tsx have the contract shape", () => {
  const files = byPath(buildViteLandingFiles(ctx()))
  const viteConfig = files.get("vite.config.ts")!
  assert.ok(viteConfig.includes('from "@vitejs/plugin-react"'))
  assert.ok(viteConfig.includes('from "@tailwindcss/vite"'))
  assert.ok(viteConfig.includes("react(), tailwindcss()"))

  const tsconfig = JSON.parse(files.get("tsconfig.json")!)
  assert.equal(tsconfig.compilerOptions.jsx, "react-jsx")
  assert.equal(tsconfig.compilerOptions.moduleResolution, "bundler")
  assert.equal(tsconfig.compilerOptions.strict, true)
  assert.deepEqual(tsconfig.include, ["src"])

  const html = files.get("index.html")!
  assert.ok(html.includes('<html lang="es">'))
  assert.ok(html.includes('id="root"'))
  assert.ok(html.includes('src="/src/main.tsx"'))
  assert.ok(html.includes("Café Aurora"))

  const main = files.get("src/main.tsx")!
  assert.ok(main.includes("createRoot"))
  assert.ok(main.includes('import "./index.css"'))
  assert.ok(main.includes("<App />"))
})

// ---- injection resistance -----------------------------------------------------

const HOSTILE: AgentBuildContext = {
  goal: "landing",
  productType: '"; window.hacked = true; //',
  brand: "</title><script>alert(1)</script>",
  styleAudience: "premium oscuro",
  sections: "<img src=x onerror=alert(2)>",
  colorRef: "red; } body { background: url(https://evil.example) }",
  features: "{process.env.SECRET}, `${global.leak}`",
}

test("hostile context cannot escape the HTML title/meta", () => {
  const html = byPath(buildViteLandingFiles(HOSTILE)).get("index.html")!
  assert.ok(!html.includes("<script>alert(1)</script>"))
  assert.ok(html.includes("&lt;script&gt;"))
})

test("hostile context cannot break out of App.tsx string literals", () => {
  // jsStr keeps payload TEXT verbatim inside JSON literals (that's fine) — the
  // real guarantee is that payloads never become live code. Parse the file and
  // assert the hostile names only ever appear inside string literals, never as
  // identifiers, and that no template expression was smuggled in.
  const app = byPath(buildViteLandingFiles(HOSTILE)).get("src/App.tsx")!
  const sf = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const identifiers = new Set<string>()
  let templates = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    if (ts.isTemplateExpression(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) templates += 1
    ts.forEachChild(node, visit)
  }
  visit(sf)
  for (const name of ["hacked", "alert", "leak", "SECRET", "onerror"]) {
    assert.ok(!identifiers.has(name), `payload identifier "${name}" must not appear as live code`)
  }
  assert.equal(templates, 0, "generated code must not contain template literals")
})

test("hostile colorRef never reaches the generated CSS", () => {
  const benign = byPath(buildViteLandingFiles(ctx({ colorRef: undefined, styleAudience: "premium oscuro" })))
  const hostile = byPath(
    buildViteLandingFiles(
      ctx({ colorRef: "red; } body { background: url(https://evil.example) }", styleAudience: "premium oscuro" }),
    ),
  )
  const hostileCss = hostile.get("src/index.css")!
  assert.ok(!hostileCss.includes("evil.example"))
  assert.ok(!hostileCss.includes("url("))
  // "red" matches the colour-name whitelist → only the safe hex may differ.
  const benignCss = benign.get("src/index.css")!
  assert.equal(hostileCss.replace("#e11d48", "#7c5cff"), benignCss.replace("#e11d48", "#7c5cff"))
  assert.ok(hostileCss.includes("#e11d48"), "named colour maps to its whitelisted hex")
})

// ---- generated TSX parses -------------------------------------------------------

function assertParses(name: string, content: string) {
  const sf = ts.createSourceFile(name, content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  const messages = (diags || []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  )
  assert.deepEqual(messages, [], `${name} must parse cleanly`)
}

test("generated TSX parses cleanly for benign context", () => {
  const files = byPath(buildViteLandingFiles(ctx()))
  assertParses("App.tsx", files.get("src/App.tsx")!)
  assertParses("main.tsx", files.get("src/main.tsx")!)
  assertParses("vite.config.ts", files.get("vite.config.ts")!)
})

test("generated TSX parses cleanly for hostile context", () => {
  const files = byPath(buildViteLandingFiles(HOSTILE))
  assertParses("App.tsx", files.get("src/App.tsx")!)
})

test("generated TSX parses cleanly with every section combination", () => {
  const combos = ["", "hero, contacto", "testimonios y precios", "características, sobre nosotros", "precios"]
  for (const sections of combos) {
    const files = byPath(buildViteLandingFiles(ctx({ sections })))
    assertParses(`App.tsx [${sections}]`, files.get("src/App.tsx")!)
  }
})

// ---- sections mapping ------------------------------------------------------------

test("sections answer toggles the optional sections", () => {
  const t = parseSections("hero, testimonios, precios")
  assert.deepEqual(t, { features: false, about: false, testimonials: true, pricing: true })

  const app = byPath(buildViteLandingFiles(ctx({ sections: "hero, testimonios, precios" }))).get("src/App.tsx")!
  assert.ok(app.includes("function Testimonials"))
  assert.ok(app.includes("function Pricing"))
  assert.ok(!app.includes("function About"))
  assert.ok(!app.includes("function Features"))
})

test("empty or unrecognised sections fall back to the standard landing", () => {
  assert.deepEqual(parseSections(""), { features: true, about: true, testimonials: true, pricing: false })
  assert.deepEqual(parseSections("las típicas"), { features: true, about: true, testimonials: true, pricing: false })

  const app = byPath(buildViteLandingFiles(ctx({ sections: undefined }))).get("src/App.tsx")!
  for (const fn of ["function Features", "function About", "function Testimonials", "function Hero", "function InviteModal", "function CTASection", "function Footer"]) {
    assert.ok(app.includes(fn), `missing ${fn}`)
  }
  assert.ok(!app.includes("function Pricing"), "pricing defaults off")
})

// ---- theming ----------------------------------------------------------------------

test("styleAudience keywords select the palette", () => {
  assert.equal(paletteFor("premium oscuro").bg, "#0b0f17")
  assert.equal(paletteFor("minimalista claro").bg, "#ffffff")
  assert.equal(paletteFor("corporativo para empresas").accent, "#1d4ed8")
  assert.equal(paletteFor(undefined).bg, "#0e1116")
})

test("colorRef hex and colour names override the accent", () => {
  assert.equal(paletteFor("premium oscuro", "quiero #FF5500 como acento").accent, "#ff5500")
  assert.equal(paletteFor("premium oscuro", "azul").accent, "#2563eb")
  assert.equal(paletteFor("premium oscuro", "turquesa").accent, "#06b6d4")
  assert.equal(paletteFor("premium oscuro", "nada en particular").accent, "#7c5cff")
})

// ---- escape.ts units ----------------------------------------------------------------

test("jsStr produces safe double-quoted literals", () => {
  assert.equal(jsStr('he said "hi"'), '"he said \\"hi\\""')
  assert.equal(jsStr(undefined), '""')
  assert.equal(jsStr("línea\nnueva"), '"línea\\nnueva"')
})

test("jsxText neutralises tag and expression characters", () => {
  const out = jsxText("</script>{evil}<b>")
  assert.ok(!out.includes("</script>"))
  assert.ok(!out.includes("{evil}"))
  assert.ok(out.includes("&lt;"))
  assert.ok(out.includes("&#123;"))
})

test("escapeHtml covers quotes and angle brackets", () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;")
})

test("pickAccentHex only accepts strict 6-digit hex", () => {
  assert.equal(pickAccentHex("usa #AaBbCc por favor"), "#aabbcc")
  assert.equal(pickAccentHex("#fff"), null)
  assert.equal(pickAccentHex("url(#ff5500zz)"), null)
  assert.equal(pickAccentHex(undefined), null)
  assert.equal(pickAccentHex("sin color"), null)
})

test("kebabCase strips accents and symbols", () => {
  assert.equal(kebabCase("Café Aurora"), "cafe-aurora")
  assert.equal(kebabCase("¡Hola, Mundo! 2.0"), "hola-mundo-2-0")
  assert.equal(kebabCase("***"), "item")
})
