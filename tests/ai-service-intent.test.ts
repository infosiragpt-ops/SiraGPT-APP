import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { aiService } from "../lib/ai-service"

describe("ai-service · deterministic intent routing", () => {
  it("routes research plus a deliverable file to the long-running agent", async () => {
    const intent = await aiService.classifyIntent(
      "investiga 30 artículos científicos sobre ansiedad adolescente y dame un Word con citas APA",
    )
    assert.equal(intent, "agent_task")
  })

  it("does not preempt compound Excel analysis with the simple doc path", async () => {
    const intent = await aiService.classifyIntent(
      "busca fuentes de mercado, analiza los datos y entrégame un Excel con tablas",
    )
    assert.equal(intent, "agent_task")
  })

  it("keeps a simple document request on the lightweight doc generator", async () => {
    const intent = await aiService.classifyIntent("crea un documento Word vacío")
    assert.equal(intent, "doc")
  })

  it("routes academic research without a file to web search", async () => {
    const intent = await aiService.classifyIntent(
      "investiga artículos científicos recientes sobre SMED y dame fuentes con DOI",
    )
    assert.equal(intent, "web_search")
  })

  it("routes statistics and science computation to the math solver", async () => {
    const intent = await aiService.classifyIntent(
      "Calcula el Cronbach's alpha de estas respuestas Likert: [[4,5,3],[5,5,4],[4,4,3]]",
    )
    assert.equal(intent, "math")
  })

  it("routes professional charts and diagrams to the visualization pipeline", async () => {
    const intent = await aiService.classifyIntent(
      "crea un diagrama de Pareto y un histograma con estos datos",
    )
    assert.equal(intent, "viz")
  })

  it("routes live calculators and 3D interactives to artifacts", async () => {
    const intent = await aiService.classifyIntent(
      "crea una calculadora interactiva de Cronbach con animación 3D",
    )
    assert.equal(intent, "artifact")
  })

  it("keeps Google Drive searches on connectors instead of web search", async () => {
    const intent = await aiService.classifyIntent("busca mi carpeta de tesis en Google Drive")
    assert.equal(intent, "google_services")
  })
})
