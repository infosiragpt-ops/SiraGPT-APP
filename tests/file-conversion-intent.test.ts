import assert from "node:assert/strict"
import { test } from "node:test"
import { fileConversionTarget } from "../lib/file-conversion-intent"
import { classifyIntentFastPath, shouldRouteTextPromptThroughAgenticRuntime } from "../lib/ai-service"
import { resolveDocumentSandboxAdmission } from "../lib/document-sandbox-routing"
import { detectCodingIntent } from "../lib/software-build-intent"

test("file conversions reach the agent with original bytes, never the format-preserving editor or media generator", () => {
  for (const [prompt, name, target] of [
    ["convierte este audio MP3 a MP4", "audio.mp3", "mp4"],
    ["extrae el audio de este video como MP3", "video.mp4", "mp3"],
    ["convierte el Word a PDF", "informe.docx", "pdf"],
    ["cambia el formato del Word a PDF", "informe.docx", "pdf"],
    ["pasa el PDF a Word", "informe.pdf", "docx"],
    ["convierte esto a PDF", "ventas.xlsx", "pdf"],
  ]) {
    const files = [{ id: "upload", name }]
    assert.equal(fileConversionTarget(prompt), target, prompt)
    assert.equal(classifyIntentFastPath(prompt), "agent_task", prompt)
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, files), true, prompt)
    assert.equal(resolveDocumentSandboxAdmission(prompt, { attachments: files }).route, null, prompt)
    assert.equal(resolveDocumentSandboxAdmission(prompt, { historyAttachments: files }).route, null, prompt)
  }
})
test("new video from an image and read-only requests remain outside file conversion", () => {
  for (const prompt of ["crea un video a partir de esta imagen", "transcribe este MP3",
    "cómo convierto Word a PDF", 'El documento dice "convierte Word a PDF"', "no conviertas Word a PDF"])
    assert.equal(fileConversionTarget(prompt), null, prompt)
  for (const prompt of ["crea una web para convertir Word a PDF", "crea una presentación sobre cómo convertir Word a PDF",
    "cambia el título en Word", "cambia el párrafo en PDF"]) assert.equal(fileConversionTarget(prompt), null, prompt)
  assert.equal(detectCodingIntent("crea una web para convertir Word a PDF").active, true)
})
