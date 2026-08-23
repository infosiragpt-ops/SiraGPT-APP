import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  LOADER_LABELS,
  LOADER_STATES,
  isLoaderState,
  isTerminalLoaderState,
  loaderIconSrc,
  loaderLabel,
  loaderSrc,
  mapEventToLoaderState,
  mapToolToLoaderState,
  stepIdentity,
} from "../lib/thinking-loaders"

const repoRoot = join(__dirname, "..", "..")

describe("thinking-loaders · kit catalog", () => {
  it("exposes 19 loader states including terminal check/X", () => {
    assert.equal(LOADER_STATES.length, 19)
    assert.ok(isLoaderState("pensando"))
    assert.ok(isLoaderState("puntitos"))
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
    assert.equal(loaderLabel("pensando", "Buscando “clima”…"), "Buscando “clima”…")
    assert.equal(loaderLabel("pensando", "   "), "Pensando…")
  })

  it("ships kit SVGs with shared bounce and terminal states without bars", () => {
    for (const state of LOADER_STATES) {
      const full = join(repoRoot, "public", "loaders", `${state}.svg`)
      const icon = join(repoRoot, "public", "loaders", "icons", `${state}.svg`)
      assert.equal(existsSync(full), true, full)
      assert.equal(existsSync(icon), true, icon)
      const svg = readFileSync(full, "utf8")
      if (state === "completado" || state === "error") {
        assert.doesNotMatch(svg, /animateTransform/)
      } else {
        assert.match(svg, /width="4" height="10"/)
        assert.match(svg, /dur="0.6s"/)
        assert.match(svg, /begin="0s"/)
        assert.match(svg, /begin="0.2s"/)
        assert.match(svg, /begin="0.4s"/)
        assert.match(svg, /#38BDF8/)
      }
    }
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
