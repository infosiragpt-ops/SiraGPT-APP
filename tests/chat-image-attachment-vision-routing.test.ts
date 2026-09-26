import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  isImageOnlyAttachmentTurn,
  shouldQueueAttachmentAgentTask,
  shouldRouteTextPromptThroughAgenticRuntime,
  shouldRouteWorkModePromptThroughAgentTask,
} from "../lib/ai-service"

// Live bug 2026-09-25: a photo of "(a+b)^2 =" + "resolver" (Grok 4.6) was
// answered with the document copy «Recibí tu archivo, pero no encontré texto
// suficiente…». Image-only turns must stay on the /api/ai/generate vision
// path; only real document attachments queue the text-only agent task.

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

const IMAGE_FILES = [
  { name: "ejercicio.png", type: "image/png" },
  { name: "ejercicio.jpg", type: "image/jpeg" },
  { name: "ejercicio.webp", type: "image/webp" },
  { name: "IMG_0001.heic", type: "" },
  { name: "foto.jpeg", mimeType: "image/jpeg" },
]
const PROMPTS = ["resolver", "qué dice", "explica", "traduce", "resuelve la ecuación"]

function caseBody(label: string): string {
  const start = source.indexOf(`case '${label}':`, source.indexOf("switch (intent) {"))
  assert.notEqual(start, -1, `missing case '${label}'`)
  const end = source.indexOf("break;", start)
  return source.slice(start, end)
}

describe("image attachments stay on the vision route", () => {
  it("image-only turns never queue the attachment agent task", () => {
    for (const file of IMAGE_FILES) {
      assert.equal(isImageOnlyAttachmentTurn([file]), true, file.name)
      assert.equal(shouldQueueAttachmentAgentTask([file]), false, file.name)
    }
    assert.equal(shouldQueueAttachmentAgentTask(IMAGE_FILES), false)
  })

  it("document attachments (and mixed turns) still queue the agent task", () => {
    assert.equal(shouldQueueAttachmentAgentTask([{ name: "escaneado.pdf", type: "application/pdf" }]), true)
    assert.equal(shouldQueueAttachmentAgentTask([{ name: "notas.docx", type: "" }, IMAGE_FILES[0]]), true)
    assert.equal(shouldQueueAttachmentAgentTask([]), false)
  })

  it("combinatorial: prompts × image types stay off the queued runtimes", () => {
    for (const prompt of PROMPTS) {
      for (const file of IMAGE_FILES) {
        assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, [file]), false, `${prompt} × ${file.name}`)
        assert.equal(shouldRouteWorkModePromptThroughAgentTask(prompt, [file]), false, `${prompt} × ${file.name}`)
        assert.equal(shouldQueueAttachmentAgentTask([file]), false, `${prompt} × ${file.name}`)
      }
    }
  })

  it("'doc' and 'ppt' intents route image-only turns to the vision pipeline", () => {
    for (const label of ["doc", "ppt"]) {
      const body = caseBody(label)
      assert.match(body, /if \(!shouldQueueAttachmentAgentTask\(filesToSend\)\) \{\s*await runContextPipeline\(intent\);/, label)
      assert.doesNotMatch(body, /filesToSend\.length === 0/, `${label} must not queue every attachment`)
    }
  })

  it("the default agentic intent branch also keeps image-only turns on the vision path", () => {
    const start = source.indexOf("default:", source.indexOf("case 'artifact':"))
    const body = source.slice(start, source.indexOf("break;", start))
    assert.match(body, /shouldRouteThroughAgenticRuntime\(intent\) && !isImageOnlyAttachmentTurn\(filesToSend\)/)
  })
})
