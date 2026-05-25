import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const {
  buildUserIntentAttributionGraph,
  renderUserIntentAttributionGraphBlock,
} = require(path.join(
  process.cwd(),
  "backend/src/services/agents/user-intent-attribution-graph.js",
))

describe("user intent attribution graph", () => {
  it("traces a follow-up request back to standing thread goals", () => {
    const graph = buildUserIntentAttributionGraph({
      history: [
        { role: "user", content: "Implementa mejoras en el backend del software sin tocar la interfaz" },
        { role: "assistant", content: "Voy a revisar el backend y correr pruebas." },
      ],
      currentPrompt: "mejóralo con lo anterior y ejecuta tests",
    })

    assert.equal(graph.resolution.depends_on_thread, true)
    assert.equal(graph.resolution.target, "software implementation")
    assert.ok(graph.nodes.some((node: any) => node.id === "followup_reference"))
    assert.ok(graph.top_paths.some((path: any) => path.path.join(" ").includes("Implementa mejoras")))
  })

  it("preserves inhibitory constraints such as no file and no search", () => {
    const graph = buildUserIntentAttributionGraph({
      currentPrompt: "dame el resumen solo texto sin internet, no crees archivo",
    })

    assert.equal(graph.resolution.target, "chat answer")
    assert.ok(graph.resolution.constraints.includes("text-only / no file"))
    assert.ok(graph.resolution.constraints.includes("no external search"))
    assert.ok(graph.edges.some((edge: any) => edge.kind === "inhibits" && edge.to === "text_only"))
    assert.ok(graph.edges.some((edge: any) => edge.kind === "inhibits" && edge.to === "no_search"))
  })

  it("renders a compact prompt block for system-context injection", () => {
    const graph = buildUserIntentAttributionGraph({
      currentPrompt: "busca fuentes reales y crea un Word profesional",
      files: [{ name: "datos.xlsx" }],
    })
    const block = renderUserIntentAttributionGraphBlock(graph)

    assert.match(block, /USER INTENT ATTRIBUTION GRAPH/)
    assert.match(block, /Likely target: document/)
    assert.match(block, /attachment: datos\.xlsx/)
  })

  it("blocks attachment summaries when extracted text is unavailable", () => {
    const graph = buildUserIntentAttributionGraph({
      currentPrompt: "dame un resumen de este documento en 3 parrafos",
      files: [{ name: "avance.docx" }],
    })
    const block = renderUserIntentAttributionGraphBlock(graph)

    assert.equal(graph.resolution.attachment_grounded, true)
    assert.equal(graph.resolution.attachment_text_available, false)
    assert.ok(graph.resolution.constraints.some((item: string) => item.includes("do not answer from filename only")))
    assert.ok(graph.edges.some((edge: any) => edge.kind === "blocks"))
    assert.match(block, /must fetch or extract attachment text before answering/)
  })

  it("grounds attachment summaries when extracted text is present", () => {
    const graph = buildUserIntentAttributionGraph({
      currentPrompt: "dame un resumen de este documento en 3 parrafos",
      files: [{ name: "avance.docx", extractedText: "Uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince." }],
    })

    assert.equal(graph.resolution.attachment_grounded, true)
    assert.equal(graph.resolution.attachment_text_available, true)
    assert.ok(graph.edges.some((edge: any) => edge.kind === "grounds"))
  })
})
