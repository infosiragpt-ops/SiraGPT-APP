import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  aiService,
  buildProfessionalCapabilityPrompt,
  shouldRouteThroughAgenticRuntime,
  shouldAnswerFromExistingDocument,
} from "../lib/ai-service"

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

  it("does not generate a Word file when the user asks about an existing Word attachment", async () => {
    const history = [
      {
        role: "USER",
        content: "dame un resumen en un solo parrafo",
        files: [
          {
            id: "file-docx-1",
            name: "RDC-RSN.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]
    const intent = await aiService.classifyIntent("cual es la primera palabra del word ?", history)
    assert.equal(intent, "text")
    assert.equal(shouldAnswerFromExistingDocument("cual es la primera palabra del word ?", history), true)
  })

  it("still creates a Word file when Word is requested as the output format", async () => {
    const intent = await aiService.classifyIntent("hazme un Word con el resumen del documento")
    assert.equal(intent, "doc")
  })

  it("routes academic research without a file to web search", async () => {
    const intent = await aiService.classifyIntent(
      "investiga artículos científicos recientes sobre SMED y dame fuentes con DOI",
    )
    assert.equal(intent, "web_search")
  })

  it("keeps article requests without an explicit file format in chat", async () => {
    const intent = await aiService.classifyIntent(
      "dame 5 artículos científicos sobre estrategias multisensoriales sin ningún formato",
    )
    assert.equal(intent, "web_search")
  })

  it("routes article requests to the task agent only when Word or Excel is explicit", async () => {
    const wordIntent = await aiService.classifyIntent(
      "dame 5 artículos científicos sobre estrategias multisensoriales en Word",
    )
    const excelIntent = await aiService.classifyIntent(
      "dame 5 artículos científicos sobre estrategias multisensoriales en Excel",
    )
    assert.equal(wordIntent, "agent_task")
    assert.equal(excelIntent, "agent_task")
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

  it("routes realtime weather, sports and places lookups to grounded search", async () => {
    assert.equal(await aiService.classifyIntent("consulta el clima actual de La Paz"), "web_search")
    assert.equal(await aiService.classifyIntent("resultados NBA de hoy"), "web_search")
    assert.equal(await aiService.classifyIntent("busca restaurantes cerca de mi"), "web_search")
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

  it("uses the same professional fast path for offline fallback analysis", async () => {
    const intent = await aiService.analyzeIntent("crea una plantilla UPN APA 7 en Word")
    assert.equal(intent, "doc")
  })

  it("routes long-running autonomous software work to the task agent", async () => {
    const intent = await aiService.classifyIntent(
      "trabaja 2 horas revisando y autocorrigiendo mi landing page, ejecuta pruebas y entrega el informe",
    )
    assert.equal(intent, "agent_task")
  })

  it("routes plural 3D animation requests to live artifacts", async () => {
    const intent = await aiService.classifyIntent(
      "crea animaciones en 3D con Three.js para explicar una estructura molecular",
    )
    assert.equal(intent, "artifact")
  })

  it("routes exam-grade science problems to the math solver", async () => {
    const intent = await aiService.classifyIntent(
      "resuelve este examen de física con fórmulas de movimiento parabólico",
    )
    assert.equal(intent, "math")
  })

  it("routes ER and Mermaid-style technical diagrams to visualization", async () => {
    const intent = await aiService.classifyIntent(
      "crea un diagrama ER en Mermaid para un e-commerce con usuarios, pedidos y pagos",
    )
    assert.equal(intent, "viz")
  })

  it("routes product design requests explicitly mentioning Figma to figma", async () => {
    const intent = await aiService.classifyIntent(
      "diseña en Figma un user flow del onboarding de estudiantes",
    )
    assert.equal(intent, "figma")
  })

  it("routes ordinary landing page generation to webdev", async () => {
    const intent = await aiService.classifyIntent(
      "crea una landing page profesional para vender asesorías de tesis",
    )
    assert.equal(intent, "webdev")
  })

  it("routes explicit SVG creation to the document artifact pipeline", async () => {
    const intent = await aiService.classifyIntent("créame un SVG de una casa moderna")
    assert.equal(intent, "doc")
  })

  it("uses the durable agent as the offline fallback for plain explanations", async () => {
    const intent = await aiService.analyzeIntent("explícame cómo funciona React")
    assert.equal(intent, "agent_task")
  })

  it("routes normal chat, research, analysis and documents through the agentic runtime", () => {
    for (const intent of ["text", "web_search", "doc", "math", "viz", "chart", "agent_task"] as const) {
      assert.equal(shouldRouteThroughAgenticRuntime(intent), true)
    }

    for (const intent of ["gmail", "google_services", "image", "video", "figma", "artifact", "webdev", "plan"] as const) {
      assert.equal(shouldRouteThroughAgenticRuntime(intent), false)
    }
  })

  it("adds professional execution contracts without replacing the user prompt", () => {
    const prompt = "Calcula el Cronbach's alpha de esta tabla Likert"
    const enriched = buildProfessionalCapabilityPrompt("math", prompt)
    assert.ok(enriched.startsWith(prompt))
    assert.match(enriched, /LaTeX/)
    assert.match(enriched, /Python-backed verification/)
  })

  it("keeps plain text prompts unmodified when no professional contract applies", () => {
    const prompt = "hola, cómo estás"
    assert.equal(buildProfessionalCapabilityPrompt("text", prompt), prompt)
  })

  it("enforces artifact safety in the professional contract", () => {
    const enriched = buildProfessionalCapabilityPrompt("artifact", "crea un grader interactivo")
    assert.match(enriched, /no external network calls/i)
    assert.match(enriched, /Never store secrets/i)
  })
})
