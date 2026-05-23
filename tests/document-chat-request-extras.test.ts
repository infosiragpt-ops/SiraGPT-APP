import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildDocumentChatRequest,
  detectDocumentChatComplexity,
  detectDocumentChatFormat,
  detectDocumentChatTemplate,
} from "../lib/document-chat-request"

/**
 * Extras on top of the base document-chat-request suite. Covers
 * detector branches the existing 4 tests don't, plus the request-
 * builder's normalisation rules.
 */

describe("detectDocumentChatFormat · per-format detection", () => {
  it("returns 'xlsx' for spreadsheet wording", () => {
    assert.equal(detectDocumentChatFormat("Hazme un excel con ventas"), "xlsx")
    assert.equal(detectDocumentChatFormat("Necesito una hoja de cálculo"), "xlsx")
    assert.equal(detectDocumentChatFormat("Dashboard de KPIs"), "xlsx")
  })

  it("returns 'pptx' for slide-deck wording", () => {
    assert.equal(detectDocumentChatFormat("Hazme una presentación"), "pptx")
    assert.equal(detectDocumentChatFormat("Una ppt sobre ventas"), "pptx")
    assert.equal(detectDocumentChatFormat("10 diapositivas"), "pptx")
  })

  it("returns 'pdf' / 'csv' / 'html' / 'md' when explicitly named", () => {
    assert.equal(detectDocumentChatFormat("Genera un PDF"), "pdf")
    assert.equal(detectDocumentChatFormat("Exporta como csv"), "csv")
    assert.equal(detectDocumentChatFormat("Quiero una página html"), "html")
    assert.equal(detectDocumentChatFormat("formato markdown"), "md")
  })

  it("falls back to 'docx' when no signal matches", () => {
    assert.equal(detectDocumentChatFormat("Resume este texto"), "docx")
    assert.equal(detectDocumentChatFormat(""), "docx")
  })

  it("normalises accents (NFD strip) before matching", () => {
    // "presentación" with accents must still match the pptx pattern.
    assert.equal(detectDocumentChatFormat("Presentación ejecutiva"), "pptx")
  })
})

describe("detectDocumentChatTemplate · per-template", () => {
  it("returns 'academic' for thesis / APA / research wording", () => {
    assert.equal(detectDocumentChatTemplate("Hazme una tesis"), "academic")
    assert.equal(detectDocumentChatTemplate("APA 7 sobre X"), "academic")
    assert.equal(detectDocumentChatTemplate("Marco teórico"), "academic")
  })

  it("returns 'legal' for contract / clause wording", () => {
    assert.equal(detectDocumentChatTemplate("Redacta un contrato"), "legal")
    assert.equal(detectDocumentChatTemplate("Cláusula de confidencialidad"), "legal")
  })

  it("returns 'business' for ventas / mercado / KPI wording", () => {
    // The regex uses word-boundary anchors, so stems like "financier"
    // do NOT match "financiero" inside Spanish text. Use exact tokens.
    assert.equal(detectDocumentChatTemplate("Reporte de ventas"), "business")
    assert.equal(detectDocumentChatTemplate("KPI mensual"), "business")
    assert.equal(detectDocumentChatTemplate("Propuesta comercial"), "business")
  })

  it("returns 'education' for course / class wording", () => {
    assert.equal(detectDocumentChatTemplate("Plan de curso"), "education")
    assert.equal(detectDocumentChatTemplate("Rúbrica de examen"), "education")
  })

  it("falls back to 'premium' when no template signal matches", () => {
    // "Resume este texto" avoids the academic regex (which catches
    // "artículos") and any other template signal.
    assert.equal(detectDocumentChatTemplate("Resume este texto"), "premium")
    assert.equal(detectDocumentChatTemplate(""), "premium")
  })
})

describe("detectDocumentChatComplexity · range bounds", () => {
  it("returns 'stress' for extreme-complexity wording", () => {
    assert.equal(detectDocumentChatComplexity("100 páginas de análisis"), "stress")
    assert.equal(detectDocumentChatComplexity("mil registros"), "stress")
    assert.equal(detectDocumentChatComplexity("alta complejidad"), "stress")
  })

  it("returns 'high' when files are attached, even for short prompts", () => {
    assert.equal(detectDocumentChatComplexity("Resume", ["file-1"]), "high")
  })

  it("returns 'high' for tesis / APA / dashboard / gráficos wording", () => {
    assert.equal(detectDocumentChatComplexity("Tesis con anexos"), "high")
    assert.equal(detectDocumentChatComplexity("Dashboard con gráficos"), "high")
    assert.equal(detectDocumentChatComplexity("Contrato con cláusulas"), "high")
  })

  it("returns 'simple' for explicit short-form wording", () => {
    assert.equal(detectDocumentChatComplexity("Un chiste"), "simple")
    assert.equal(detectDocumentChatComplexity("Resumen breve"), "simple")
    assert.equal(detectDocumentChatComplexity("Algo rápido"), "simple")
  })

  it("defaults to 'standard' when no complexity signal", () => {
    assert.equal(detectDocumentChatComplexity("Una carta de presentación"), "standard")
    assert.equal(detectDocumentChatComplexity(""), "standard")
  })
})

describe("buildDocumentChatRequest · request shape", () => {
  it("trims the prompt and mirrors it to displayPrompt", () => {
    const req = buildDocumentChatRequest({ prompt: "  Hola  " })
    assert.equal(req.prompt, "Hola")
    assert.equal(req.displayPrompt, "Hola")
  })

  it("includes detected format / template / complexity", () => {
    const req = buildDocumentChatRequest({ prompt: "Hazme una tesis APA" })
    assert.equal(req.format, "docx")
    assert.equal(req.template, "academic")
    assert.equal(req.complexity, "high")
  })

  it("de-duplicates and filters falsy fileIds", () => {
    const req = buildDocumentChatRequest({
      prompt: "doc",
      fileIds: ["a", "a", "", "b"],
    })
    assert.deepEqual(req.files, ["a", "b"])
  })

  it("omits `files` entirely when no fileIds survive", () => {
    const req = buildDocumentChatRequest({
      prompt: "doc",
      fileIds: ["", null as unknown as string],
    })
    assert.equal(req.files, undefined)
  })

  it("passes through chatId and model unchanged", () => {
    const req = buildDocumentChatRequest({
      prompt: "doc",
      chatId: "chat-1",
      model: "gpt-4o",
    })
    assert.equal(req.chatId, "chat-1")
    assert.equal(req.model, "gpt-4o")
  })
})
