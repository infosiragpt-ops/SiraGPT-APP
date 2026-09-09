import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildDocumentChatRequest,
  detectDocumentChatComplexity,
  detectDocumentChatFormat,
  detectDocumentChatTemplate,
  pickLastArtifactId,
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
    assert.equal(detectDocumentChatFormat("crea esto como SVG"), "svg")
    assert.equal(detectDocumentChatFormat("devuélvelo como Markdown"), "md")
    assert.equal(detectDocumentChatFormat("crea un CSV válido"), "csv")
  })

  it("does not default a website ask to Word", () => {
    assert.equal(detectDocumentChatFormat("créame una web de ventas"), "html")
    assert.equal(detectDocumentChatFormat("crea un sitio web"), "html")
    assert.equal(detectDocumentChatFormat("rédactame un informe de ventas en Word"), "docx")
  })

  it("does not turn documents about software into HTML", () => {
    for (const prompt of ["crea un informe sobre esta app", "crea un manual de usuario para mi software"]) {
      assert.equal(detectDocumentChatFormat(prompt), "docx", prompt)
    }
  })

  it("keeps software builds when a document is only an earlier reference", () => {
    for (const prompt of [
      "Usa este manual como referencia y crea una app para reservas",
      "A partir del informe, crea una app de ventas",
    ]) {
      assert.equal(detectDocumentChatFormat(prompt), "html", prompt)
    }
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

  it("adds an execution policy that requires edited files, not prose suggestions", () => {
    const request = buildDocumentChatRequest({
      prompt: "aplica correcciones minimas y agrega el anexo 3",
      chatId: "chat_1",
      fileIds: ["file_docx"],
    })

    assert.equal(request.displayPrompt, "aplica correcciones minimas y agrega el anexo 3")
    assert.deepEqual(request.files, ["file_docx"])
    assert.match(request.prompt, /return the downloadable file/i)
    assert.match(request.prompt, /do not stop at prose suggestions/i)
    assert.match(request.prompt, /consolidate them into one edited output file/i)
  })

  it("Word path stays docx and forwards lastArtifactId on follow-up", () => {
    const request = buildDocumentChatRequest({
      prompt: "ponlas rosadas y agrega un anexo en el Word",
      chatId: "chat_1",
      lastArtifactId: "art_docx_1",
    })

    assert.equal(request.format, "docx")
    assert.equal(request.lastArtifactId, "art_docx_1")
    assert.equal(request.displayPrompt, "ponlas rosadas y agrega un anexo en el Word")
  })

  it("pickLastArtifactId reads the latest assistant artifact, not an older one", () => {
    const id = pickLastArtifactId([
      { role: "ASSISTANT", artifacts: [{ id: "art_old" }] },
      { role: "ASSISTANT", files: [{ artifactId: "art_word", filename: "informe.docx" }] },
    ])
    assert.equal(id, "art_word")
  })
})
