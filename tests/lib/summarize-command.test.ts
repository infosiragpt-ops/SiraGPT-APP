import { describe, expect, it } from "vitest"
import { summarizeCommandPrompt } from "@/lib/chat/summarize-command"

describe("/summarize normal turn routing", () => {
  it("targets attachments instead of an unrelated historical answer", () => {
    const prompt = summarizeCommandPrompt("en tres puntos", 2, [{ role: "ASSISTANT", content: "unrelated" }])
    expect(prompt).toContain("documentos adjuntos")
    expect(prompt).toContain("en tres puntos")
    expect(prompt).not.toContain("unrelated")
    expect(prompt).toContain("sin crear ni modificar archivos")
  })
  it("summarizes the last useful message and ignores internal placeholders", () => {
    expect(summarizeCommandPrompt("", 0, [
      { role: "ASSISTANT", content: "Respuesta extensa" },
      { role: "TOOL", content: "internals" },
      { role: "ASSISTANT", content: "[GENERATING_IMAGE]" },
    ])).toContain("Respuesta extensa")
  })
  it("does not silently summarize nothing on an empty chat", () => {
    expect(summarizeCommandPrompt("", 0)).toBeNull()
  })
})
