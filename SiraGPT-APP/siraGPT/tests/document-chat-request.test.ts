import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildDocumentChatRequest,
  detectDocumentChatComplexity,
  detectDocumentChatFormat,
  detectDocumentChatTemplate,
} from "../lib/document-chat-request"

describe("document chat request · clean prompt contract", () => {
  it("sends the user's clean prompt to the document pipeline, not an internal contract", () => {
    const prompt = "Creame en un word un chiste"
    const request = buildDocumentChatRequest({ prompt, chatId: "chat_1", model: "deepseek-v4-pro" })

    assert.equal(request.prompt, prompt)
    assert.equal(request.displayPrompt, prompt)
    assert.equal(request.format, "docx")
    assert.equal(request.template, "premium")
    assert.equal(request.complexity, "simple")
    assert.doesNotMatch(request.prompt, /professional execution contract/i)
    assert.doesNotMatch(JSON.stringify(request), /Generate a polished downloadable file/i)
  })

  it("detects office formats explicitly from the user's wording", () => {
    assert.equal(detectDocumentChatFormat("genera un Excel con fórmulas y dashboard"), "xlsx")
    assert.equal(detectDocumentChatFormat("crea una presentación PPT de inteligencia artificial"), "pptx")
    assert.equal(detectDocumentChatFormat("exporta este contrato a PDF"), "pdf")
    assert.equal(detectDocumentChatFormat("devuélvelo como Markdown"), "md")
    assert.equal(detectDocumentChatFormat("crea un CSV válido"), "csv")
  })

  it("classifies templates and complexity without UI involvement", () => {
    assert.equal(detectDocumentChatTemplate("tesis APA 7 con referencias"), "academic")
    assert.equal(detectDocumentChatTemplate("contrato legal de servicios"), "legal")
    assert.equal(detectDocumentChatTemplate("dashboard financiero ejecutivo"), "business")
    assert.equal(detectDocumentChatComplexity("documento breve"), "simple")
    assert.equal(detectDocumentChatComplexity("tesis extensa con anexos e índice"), "high")
    assert.equal(detectDocumentChatComplexity("documento extremadamente complejo de estrés"), "stress")
  })

  it("passes attached file ids as traceable backend inputs", () => {
    const request = buildDocumentChatRequest({
      prompt: "resume este documento en Word",
      chatId: "chat_1",
      fileIds: ["file_a", "file_a", "file_b"],
    })

    assert.deepEqual(request.files, ["file_a", "file_b"])
    assert.equal(request.complexity, "high")
  })
})
