import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  aiService,
  buildIntentAttributionGraph,
  buildProfessionalCapabilityPrompt,
  classifyIntentFastPath,
  extractRequestedVideoDurationSeconds,
  shouldAutoActivateVideoGeneration,
  shouldRouteThroughAgenticRuntime,
  shouldRouteTextPromptThroughAgenticRuntime,
  shouldUseFastTextRoute,
  shouldAnswerFromExistingDocument,
  shouldEditExistingDocument,
  shouldUseExistingDocumentFileContext,
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

  it("routes existing Word attachment questions to the durable agent, not simple chat", async () => {
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
    const prompt = "cual es la primera palabra del word ?"
    const intent = await aiService.classifyIntent(prompt, history)
    assert.equal(intent, "agent_task")
    assert.equal(shouldAnswerFromExistingDocument(prompt, history), true)
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, history[0].files), true)
  })

  it("routes document follow-up questions like title lookup through the agent runtime", async () => {
    const history = [
      {
        role: "USER",
        content: "Analiza este Word",
        files: [
          {
            id: "file-docx-title",
            name: "investigacion.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]
    const prompt = "Cuál es el título de la investigación?"
    const graph = buildIntentAttributionGraph(prompt, history)
    assert.equal(graph.inferredIntent, "agent_task")
    assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, history[0].files), true)
  })

  it("treats an attached document plus an implicit analysis prompt as agentic document chat", async () => {
    const history = [
      {
        role: "USER",
        content: "055 037 - Introducción UCV COMPLETA.docx",
        files: [
          {
            id: "file-docx-analysis",
            name: "055 037 - Introducción UCV COMPLETA.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]

    const prompt = "dame un analisis en un solo parrafo"
    assert.equal(shouldAnswerFromExistingDocument(prompt, history), true)
    assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
    assert.equal(
      shouldRouteTextPromptThroughAgenticRuntime(prompt, history[0].files),
      true,
    )
  })

  it("routes targeted edits of an uploaded Word document to the agentic document editor", async () => {
    const history = [
      {
        role: "USER",
        content: "046 016 INTRO MATRICES.docx",
        files: [
          {
            id: "file-docx-anexo",
            name: "046 016 INTRO MATRICES.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]

    const prompt = "completa el anexo 3"
    assert.equal(shouldAnswerFromExistingDocument(prompt, history), false)
    assert.equal(shouldEditExistingDocument(prompt, history), true)
    assert.equal(shouldUseExistingDocumentFileContext(prompt, history), true)
    assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
  })

  it("keeps spreadsheet data work on the agentic route when a spreadsheet is attached", () => {
    assert.equal(
      shouldRouteTextPromptThroughAgenticRuntime("analiza estos datos de ventas", [
        {
          id: "file-xlsx",
          name: "ventas.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ]),
      true,
    )
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

  it("uses recent context to route follow-up deliverable requests", async () => {
    const history = [
      {
        role: "USER",
        content: "investiga artículos científicos recientes sobre estrategias multisensoriales",
      },
    ]

    const graph = buildIntentAttributionGraph("ahora pásalo a Word con citas APA", history)
    assert.equal(graph.inferredIntent, "agent_task")
    assert.equal(graph.usedHistory, true)
    assert.ok(graph.nodes.some((node) => node.id === "history:web_search"))
    assert.ok(graph.edges.some((edge) => edge.to === "route:agent_task"))
    assert.equal(await aiService.classifyIntent("ahora pásalo a Word con citas APA", history), "agent_task")
  })

  it("routes URL-backed software improvement requests to the task agent", async () => {
    const prompt = "revisa https://transformer-circuits.pub/2025/attribution-graphs/biology.html e implementa mejoras en el software"
    const graph = buildIntentAttributionGraph(prompt)

    assert.equal(classifyIntentFastPath(prompt), "agent_task")
    assert.equal(await aiService.classifyIntent(prompt), "agent_task")
    assert.equal(graph.inferredIntent, "agent_task")
    assert.ok(graph.nodes.some((node) => node.id === "current:external-reference"))
    assert.ok(graph.nodes.some((node) => node.id === "current:implementation-action"))
    assert.ok(graph.nodes.some((node) => node.id === "current:software-target"))
  })

  it("inherits the prior concrete goal for short contextual follow-ups", async () => {
    const history = [
      {
        role: "USER",
        content: "crea un diagrama ER en Mermaid para un e-commerce con usuarios, pedidos y pagos",
      },
    ]

    const graph = buildIntentAttributionGraph("hazlo también en español", history)
    assert.equal(graph.inferredIntent, "viz")
    assert.equal(graph.usedHistory, true)
    assert.equal(await aiService.classifyIntent("hazlo también en español", history), "viz")
  })

  it("does not treat greetings as contextual follow-ups", async () => {
    const history = [
      {
        role: "USER",
        content: "investiga artículos científicos recientes sobre estrategias multisensoriales",
      },
    ]

    assert.equal(await aiService.classifyIntent("hola", history), "text")
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

  it("routes explicit /goal commands to the durable agentic runtime", async () => {
    const prompt = "/goal revisa este repositorio, corrige fallos, ejecuta pruebas y verifica el resultado"
    const intent = await aiService.classifyIntent(prompt)

    assert.equal(intent, "agent_task")
    assert.equal(classifyIntentFastPath("/goal analiza el documento y continúa hasta validar"), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime("/goal analiza el documento y continúa hasta validar"), true)
    assert.equal(shouldUseFastTextRoute("/goal analiza el documento"), false)
  })

  it("routes repository checkout and GitHub delivery requests to the task agent", async () => {
    assert.equal(
      await aiService.classifyIntent("quiero que me des este proyecto en local github.com/open-webui/open-webui"),
      "agent_task",
    )
    assert.equal(
      await aiService.classifyIntent("arregla el backend, haz commit, sube a main y vigila CI verde"),
      "agent_task",
    )
  })

  it("routes external reference plus software implementation to the task agent", async () => {
    const intent = await aiService.classifyIntent(
      "implementa mejoras de este link https://transformer-circuits.pub/2025/attribution-graphs/biology.html para mejorar el software",
    )
    assert.equal(intent, "agent_task")
    assert.equal(
      shouldRouteTextPromptThroughAgenticRuntime(
        "implementa mejoras de este link https://transformer-circuits.pub/2025/attribution-graphs/biology.html para mejorar el software",
      ),
      true,
    )
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

  it("auto-routes text-chat media creation prompts to the right generation path", async () => {
    assert.equal(classifyIntentFastPath("quiero una video de un perro"), "video")
    assert.equal(await aiService.classifyIntent("quiero una video de un perro"), "video")

    const normalChatVideoPrompt = "que un perro este volando crea un video de 10 segundos"
    assert.equal(shouldAutoActivateVideoGeneration(normalChatVideoPrompt), true)
    assert.equal(extractRequestedVideoDurationSeconds(normalChatVideoPrompt), 10)
    assert.equal(classifyIntentFastPath("qué video me recomiendas para aprender React?"), null)
    assert.equal(await aiService.classifyIntent("qué video me recomiendas para aprender React?"), "text")

    const musicPrompt = "genérame una canción de 10 segundos estilo lofi"
    assert.equal(classifyIntentFastPath(musicPrompt), "agent_task")
    assert.equal(await aiService.classifyIntent(musicPrompt), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime("crea una canción lofi"), true)

    const voicePrompt = "crea un audio narrando este texto con voz femenina"
    assert.equal(classifyIntentFastPath(voicePrompt), "agent_task")
    assert.equal(await aiService.classifyIntent(voicePrompt), "agent_task")
  })

  it("keeps non-creation music questions on the normal text path", async () => {
    assert.equal(classifyIntentFastPath("qué música me recomiendas?"), null)
    assert.equal(await aiService.classifyIntent("qué música me recomiendas?"), "text")
  })

  it("keeps plain explanations on the fast conversational route", async () => {
    const intent = await aiService.analyzeIntent("explícame cómo funciona React")
    assert.equal(intent, "text")
  })

  it("keeps lightweight chat fast and routes professional work through the agentic runtime", async () => {
    const greetingIntent = await aiService.classifyIntent("hola")
    const explanationIntent = await aiService.classifyIntent("explícame cómo funciona React")
    assert.equal(greetingIntent, "text")
    assert.equal(explanationIntent, "text")
    assert.equal(shouldRouteThroughAgenticRuntime("text"), false)

    for (const intent of ["web_search", "doc", "math", "viz", "chart", "agent_task"] as const) {
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
