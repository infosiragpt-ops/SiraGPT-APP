import assert from "node:assert/strict"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  KIT_SVG_FILES,
  LOADER_LABELS,
  LOADER_STATES,
  isLoaderState,
  isTerminalLoaderState,
  loaderChipSrc,
  loaderIconSrc,
  loaderLabel,
  loaderSrc,
  mapEventToLoaderState,
  mapToolToLoaderState,
  stepIdentity,
} from "../lib/thinking-loaders"

const repoRoot = join(__dirname, "..", "..")
const loadersDir = join(repoRoot, "public", "loaders")

const EXACT_BOUNCE = [
  /<rect x="20" y="32" width="4" height="10" fill="#38BDF8">/,
  /<rect x="30" y="32" width="4" height="10" fill="#38BDF8">/,
  /<rect x="40" y="32" width="4" height="10" fill="#38BDF8">/,
  /values="0 0; 0 20; 0 0"/,
  /begin="0"/,
  /begin="0.2s"/,
  /begin="0.4s"/,
  /dur="0.6s"/,
] as const

describe("thinking-loaders · kit catalog", () => {
  it("ships exactly 19 kit SVGs under public/loaders/", () => {
    assert.equal(KIT_SVG_FILES.length, 19)
    assert.equal(LOADER_STATES.length, 18)
    const files = readdirSync(loadersDir).filter((name) => name.endsWith(".svg")).sort()
    assert.deepEqual(
      files,
      [...KIT_SVG_FILES].map((name) => `${name}.svg`).sort(),
    )
    assert.ok(isLoaderState("pensando"))
    assert.equal(isLoaderState("pensando-original"), false)
    assert.equal(isLoaderState("puntitos"), false)
    assert.equal(isLoaderState("unknown"), false)
    assert.equal(isTerminalLoaderState("completado"), true)
    assert.equal(isTerminalLoaderState("error"), true)
    assert.equal(isTerminalLoaderState("pensando"), false)
  })

  it("keeps Spanish kit labels and public SVG paths", () => {
    assert.equal(LOADER_LABELS.pensando, "Pensando…")
    assert.equal(LOADER_LABELS["buscando-internet"], "Buscando en internet…")
    assert.equal(LOADER_LABELS["generando-word"], "Generando documento Word…")
    assert.equal(LOADER_LABELS.completado, "¡Listo!")
    assert.equal(LOADER_LABELS.error, "Ocurrió un error")
    assert.equal(loaderSrc("generando-pdf"), "/loaders/generando-pdf.svg")
    assert.equal(loaderIconSrc("generando-pdf"), "/loaders/icons/generando-pdf.svg")
    assert.equal(loaderChipSrc("pensando"), "/loaders/pensando-original.svg")
    assert.equal(loaderChipSrc("buscando-internet"), "/loaders/buscando-internet.svg")
    assert.equal(loaderLabel("pensando", "Buscando “clima”…"), "Buscando “clima”…")
    assert.equal(loaderLabel("pensando", "   "), "Pensando…")
  })

  it("matches the shared bounce snippet (y=32, down 20px) except terminal + original crop", () => {
    for (const name of KIT_SVG_FILES) {
      const full = join(loadersDir, `${name}.svg`)
      assert.equal(existsSync(full), true, full)
      const svg = readFileSync(full, "utf8")
      if (name === "completado" || name === "error") {
        assert.doesNotMatch(svg, /animateTransform/)
        assert.match(svg, /<animate /)
        continue
      }
      if (name === "pensando-original") {
        assert.match(svg, /viewBox="10 40 45 50"/)
        assert.match(svg, /<rect x="20" y="50" width="4" height="10" fill="#38BDF8">/)
        assert.match(svg, /<rect x="30" y="50" width="4" height="10" fill="#38BDF8">/)
        assert.match(svg, /<rect x="40" y="50" width="4" height="10" fill="#38BDF8">/)
        assert.match(svg, /values="0 0; 0 20; 0 0"/)
        continue
      }
      assert.match(svg, /viewBox="0 0 64 64"/)
      for (const pattern of EXACT_BOUNCE) {
        assert.match(svg, pattern, `${name} missing ${pattern}`)
      }
    }
  })

  it("keeps pensando as bars-only and document states as seals + bars", () => {
    const pensando = readFileSync(join(loadersDir, "pensando.svg"), "utf8")
    assert.doesNotMatch(pensando, /<path /)
    assert.doesNotMatch(pensando, /<circle /)
    assert.doesNotMatch(pensando, /<text /)
    assert.equal((pensando.match(/<rect /g) || []).length, 3)

    const word = readFileSync(join(loadersDir, "generando-word.svg"), "utf8")
    assert.match(word, /rx="4.5"/)
    assert.match(word, />W</)

    const search = readFileSync(join(loadersDir, "buscando-internet.svg"), "utf8")
    assert.match(search, /stroke="#38BDF8"/)
    assert.match(search, /<circle /)

    const code = readFileSync(join(loadersDir, "generando-codigo.svg"), "utf8")
    assert.match(code, /<path d="M26 6 20 13 26 20"/)
  })
})

describe("thinking-loaders · tool → state", () => {
  it("maps web search and browse tools to buscando-internet", () => {
    assert.equal(mapToolToLoaderState("web_search"), "buscando-internet")
    assert.equal(mapToolToLoaderState("deep_search"), "buscando-internet")
    assert.equal(mapToolToLoaderState("scientific_search"), "buscando-internet")
    assert.equal(mapToolToLoaderState("github_search"), "buscando-internet")
    assert.equal(mapToolToLoaderState("read_url"), "buscando-internet")
    assert.equal(mapEventToLoaderState({ label: "Buscando fuentes" }), "buscando-internet")
  })

  it("maps document generators by tool and filename hint", () => {
    assert.equal(mapToolToLoaderState("create_docx"), "generando-word")
    assert.equal(mapEventToLoaderState({ tool: "create_document", filename: "informe.docx" }), "generando-word")
    assert.equal(mapEventToLoaderState({ tool: "python_exec", args: { path: "out.docx" } }), "generando-word")
    assert.equal(mapToolToLoaderState("pdf"), "generando-pdf")
    assert.equal(mapEventToLoaderState({ label: "Generando PDF…" }), "generando-pdf")
    assert.equal(mapToolToLoaderState("create_presentation"), "generando-ppt")
    assert.equal(mapEventToLoaderState({ format: "pptx" }), "generando-ppt")
    assert.equal(mapToolToLoaderState("spreadsheet"), "generando-excel")
    assert.equal(mapEventToLoaderState({ filename: "datos.xlsx" }), "generando-excel")
  })

  it("maps code, media, analyze, upload, mail and data tools", () => {
    assert.equal(mapToolToLoaderState("write_file"), "generando-codigo")
    assert.equal(mapToolToLoaderState("edit_file"), "generando-codigo")
    assert.equal(mapToolToLoaderState("execute_python"), "generando-codigo")
    assert.equal(mapToolToLoaderState("generate_image"), "generando-imagen")
    assert.equal(mapToolToLoaderState("create_chart"), "generando-imagen")
    assert.equal(mapToolToLoaderState("generate_speech"), "generando-audio")
    assert.equal(mapToolToLoaderState("generate_video"), "generando-video")
    assert.equal(mapToolToLoaderState("docintel_analyze"), "analizando-archivo")
    assert.equal(mapToolToLoaderState("rag_retrieve"), "analizando-archivo")
    assert.equal(mapEventToLoaderState({ label: "Analizando archivo…" }), "analizando-archivo")
    assert.equal(mapToolToLoaderState("upload_file"), "subiendo-archivo")
    assert.equal(mapToolToLoaderState("download_file"), "descargando-archivo")
    assert.equal(mapToolToLoaderState("send_email"), "enviando-correo")
    assert.equal(mapToolToLoaderState("gmail"), "enviando-correo")
    assert.equal(mapToolToLoaderState("python_exec"), "procesando-datos")
    assert.equal(mapToolToLoaderState("code_sandbox"), "procesando-datos")
  })

  it("defaults to pensando and uses run-level terminal statuses only", () => {
    assert.equal(mapEventToLoaderState({}), "pensando")
    assert.equal(mapEventToLoaderState({ label: "Pensando…" }), "pensando")
    assert.equal(mapEventToLoaderState({ tool: "web_search", status: "running" }), "buscando-internet")
    assert.equal(mapEventToLoaderState({ tool: "web_search", status: "done" }), "buscando-internet")
    assert.equal(mapEventToLoaderState({ status: "completed" }), "completado")
    assert.equal(mapEventToLoaderState({ status: "succeeded" }), "completado")
    assert.equal(mapEventToLoaderState({ status: "error" }), "error")
    assert.equal(mapEventToLoaderState({ status: "failed" }), "error")
    assert.equal(mapEventToLoaderState({ label: "¡Listo!" }), "completado")
    assert.equal(stepIdentity({ step_id: "step-4", tool: "web_search" }), "step-4")
  })
})
