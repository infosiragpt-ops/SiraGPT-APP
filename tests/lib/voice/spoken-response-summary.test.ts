import { describe, expect, it } from "vitest"
import { buildSpokenResponseSummary } from "@/lib/voice/spoken-response-summary"

describe("buildSpokenResponseSummary", () => {
  it("keeps short answers complete", () => {
    expect(buildSpokenResponseSummary("La migración terminó correctamente.")).toBe(
      "La migración terminó correctamente.",
    )
  })

  it("extracts a bounded summary from long structured answers", () => {
    const response = [
      "# Resultado",
      "La aplicación quedó compilada y las pruebas críticas finalizaron correctamente.",
      "",
      "## Cambios",
      "- Añadí persistencia durable para las tareas.",
      "- Incorporé el tablero de actividad en vivo.",
      "- Protegí las publicaciones externas con aprobación.",
      "- Este cuarto punto no debe entrar en el resumen.",
      "",
      "La siguiente revisión debe validar la interfaz en producción.",
      "Texto adicional ".repeat(80),
    ].join("\n")

    const spoken = buildSpokenResponseSummary(response)
    expect(spoken).toContain("Resumen de la respuesta")
    expect(spoken).toContain("persistencia durable")
    expect(spoken).toContain("tablero de actividad")
    expect(spoken).toContain("aprobación")
    expect(spoken).not.toContain("cuarto punto")
    expect(spoken.length).toBeLessThanOrEqual(640)
  })

  it("removes code, markdown links and raw URLs", () => {
    const response = `${"Contexto real. ".repeat(60)}

- Revisa [la evidencia](https://example.com/evidencia).
- Consulta https://example.com/secreto.

\`\`\`ts
const secret = "never speak this";
\`\`\`

La implementación está lista para revisar.`
    const spoken = buildSpokenResponseSummary(response)
    expect(spoken).not.toContain("secret")
    expect(spoken).not.toContain("https://")
    expect(spoken).toContain("evidencia")
  })

  it("is deterministic and does not fabricate an empty summary", () => {
    const input = "Una respuesta suficientemente corta."
    expect(buildSpokenResponseSummary(input)).toBe(buildSpokenResponseSummary(input))
    expect(buildSpokenResponseSummary("")).toBe("")
  })
})
