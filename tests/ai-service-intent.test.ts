import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  aiService,
  buildIntentAttributionGraph,
  buildProfessionalCapabilityPrompt,
  classifyIntentFastPath,
  extractRequestedVideoAspectRatio,
  extractRequestedVideoAudio,
  extractRequestedVideoDurationSeconds,
  extractRequestedVideoResolution,
  shouldAutoActivateVideoGeneration,
  shouldRouteThroughAgenticRuntime,
  shouldRouteTextPromptThroughAgenticRuntime,
  shouldRouteWorkModePromptThroughAgentTask,
  isImageAnalysisPrompt,
  isImageOnlyAttachmentTurn,
  SEMANTIC_INTENT_BUDGET_MS,
  shouldUseFastTextRoute,
  shouldAnswerFromExistingDocument,
  shouldEditExistingDocument,
  shouldUseExistingDocumentFileContext,
} from "../lib/ai-service"

describe("ai-service · deterministic intent routing", () => {
  it("keeps semantic routing outside the user's three-second critical path", () => {
    assert.ok(SEMANTIC_INTENT_BUDGET_MS <= 750)
  })

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

  it("routes whole-document transforms (translate/summarize/rewrite) over an attachment to the source-preserving agent", async () => {
    const docFile = {
      id: "file-docx-transform",
      name: "tesis.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    const history = [{ role: "USER", content: "tesis.docx", files: [docFile] }]
    for (const prompt of [
      "traduce este documento al inglés",
      "resume este documento",
      "reescribe el documento adjunto en un tono más formal",
    ]) {
      assert.equal(shouldEditExistingDocument(prompt, history), true)
      assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
    }
    // A pure format conversion still goes to document generation, not preserve-edit.
    assert.equal(shouldEditExistingDocument("pásalo a PDF", history), false)
    // Transform verb without an explicit document reference must not hijack the
    // request, even when a document happens to be attached.
    assert.equal(shouldEditExistingDocument("traduce esta frase al inglés", history), false)
    assert.equal(shouldEditExistingDocument("cambia de tema", history), false)
    // Noun forms (cambio / resumen) in read-only questions must not be mistaken
    // for transform verbs, even with a document attached.
    assert.equal(shouldEditExistingDocument("explica el cambio del documento", history), false)
    assert.equal(shouldEditExistingDocument("¿cuál es el resumen del documento?", history), false)
    // reescribir parity with the backend transformVerb: needs an explicit doc
    // noun (a bare sentence reference is not enough), and the noun "reescritura"
    // in a read-only question must not trigger an edit.
    assert.equal(shouldEditExistingDocument("reescribe esta frase", history), false)
    assert.equal(shouldEditExistingDocument("reescribe este documento en un tono formal", history), true)
    assert.equal(shouldEditExistingDocument("explica la reescritura del documento", history), false)
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

  it("does NOT re-attach a prior document to an unrelated question (que dia es hoy)", () => {
    const history = [
      {
        role: "USER",
        content: "transcribir",
        files: [
          {
            id: "file-img-prev",
            name: "captura.png",
            mimeType: "image/png",
          },
          {
            id: "file-docx-prev",
            name: "informe.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]
    // Unrelated questions must NOT drag the previously uploaded file in.
    for (const prompt of ["¿qué día es hoy?", "que dia es hoy?", "¿qué hora es?", "¿qué clima hace hoy?", "¿quién eres?"]) {
      assert.equal(shouldAnswerFromExistingDocument(prompt, history), false, prompt)
      assert.equal(shouldUseExistingDocumentFileContext(prompt, history), false, prompt)
    }
    // …but genuine document follow-ups over the same history still carry it.
    for (const prompt of ["¿de qué trata?", "dame un análisis", "cuál es el título de la investigación?"]) {
      assert.equal(shouldUseExistingDocumentFileContext(prompt, history), true, prompt)
    }
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
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, history[0].files), true)
  })

  it("routes freeform editorial changes of an uploaded Word document to the agentic document editor", async () => {
    const history = [
      {
        role: "USER",
        content: "propuesta.docx",
        files: [
          {
            id: "file-docx-edit",
            name: "propuesta.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]

    const prompt = "corrige la redacción y mejora el tono profesional"
    const graph = buildIntentAttributionGraph(prompt, history)
    assert.equal(shouldAnswerFromExistingDocument(prompt, history), false)
    assert.equal(shouldEditExistingDocument(prompt, history), true)
    assert.equal(shouldUseExistingDocumentFileContext(prompt, history), true)
    assert.equal(graph.inferredIntent, "agent_task")
    assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, history[0].files), true)

    const minimalPrompt = "aplica correcciones minimas al documento porfavor"
    assert.equal(shouldAnswerFromExistingDocument(minimalPrompt, history), false)
    assert.equal(shouldEditExistingDocument(minimalPrompt, history), true)
    assert.equal(shouldUseExistingDocumentFileContext(minimalPrompt, history), true)
    assert.equal(await aiService.classifyIntent(minimalPrompt, history), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(minimalPrompt, history[0].files), true)
  })

  it("routes consistency-matrix edits of an uploaded Word document through the durable agent task", async () => {
    const docFile = {
      id: "file-docx-matrix",
      name: "Matriz de categorizacion ACTUAL.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    const history = [{ role: "USER", content: "Matriz de categorizacion ACTUAL.docx", files: [docFile] }]

    const prompt = "agrega en el word matriz de cosistencia en base a la matriz operacional"
    assert.equal(shouldAnswerFromExistingDocument(prompt, history), false)
    assert.equal(shouldEditExistingDocument(prompt, history), true)
    assert.equal(shouldUseExistingDocumentFileContext(prompt, history), true)
    assert.equal(await aiService.classifyIntent(prompt, history), "agent_task")
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, [docFile]), true)
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

  it("routes image-only analysis turns to the vision path (plain /generate), NOT the queued agent loop", () => {
    // Regression: an image + "resolver" was sent to the queued agent-task /
    // react-agent loop, which has no vision — the model never saw the image
    // and the run stalled until the 90s stale guard. Image analysis must reach
    // the plain /api/ai/generate vision path instead.
    const img = { id: "f-img", name: "captura.png", mimeType: "image/png" }
    assert.equal(isImageOnlyAttachmentTurn([img]), true)
    // Every image-only turn goes to the vision path — even ones whose text
    // mentions "imagen" or classifies as math; the vision-less agent loop can
    // never handle an image, so it must never receive one.
    for (const prompt of ["resolver", "resuelve esta derivada", "¿qué dice esta imagen?", "transcribe la fórmula", "describe la foto", "genera un diagrama a partir de esta imagen"]) {
      assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt, [img]), false, `image turn must go to vision: ${prompt}`)
    }
    // A document attachment is unaffected: Q&A over the file still routes to
    // the queued agentic runtime (private-context retrieval).
    const doc = { id: "f-doc", name: "x.pdf", mimeType: "application/pdf" }
    assert.equal(isImageOnlyAttachmentTurn([doc]), false)
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime("¿cuál es la primera palabra del documento?", [doc]), true)
    // Whole-document transforms now run on the durable agent-task route, which
    // owns source-preserving document edits and artifact validation.
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime("resume este documento", [doc]), true)
  })

  it("image ANALYSIS questions never classify as image GENERATION", () => {
    // Regression: "describir que ves en esta imagen" + an attached photo
    // started the image GENERATOR (GPT Image 2) instead of describing the
    // image — the bare image-word pattern hijacked an understanding question.
    const analysis = [
      "describir que ves en esta imagen",
      "describe esta imagen",
      "transcribe la foto",
      "¿qué ves en la imagen?",
      "que dice la imagen",
      "extrae el texto de la captura",
      "analiza esta imagen",
      "explica la imagen",
      "what do you see in this picture",
      "transcribe this image",
    ]
    for (const prompt of analysis) {
      assert.equal(isImageAnalysisPrompt(prompt), true, `analysis: ${prompt}`)
      assert.notEqual(classifyIntentFastPath(prompt), "image", `must NOT be generation: ${prompt}`)
    }
    // Real generation prompts still classify as 'image'.
    for (const prompt of ["genera una imagen de un gato", "crea una imagen de un atardecer", "create an image of a sunset"]) {
      assert.equal(isImageAnalysisPrompt(prompt), false, `generation: ${prompt}`)
      assert.equal(classifyIntentFastPath(prompt), "image", `must stay generation: ${prompt}`)
    }
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
    const prompt =
      "implementa mejoras de este link https://transformer-circuits.pub/2025/attribution-graphs/biology.html para mejorar el software"
    const intent = await aiService.classifyIntent(prompt)
    assert.equal(intent, "agent_task")
    // Since commit 53a46aa89, no-file prompts run through the RELIABLE inline
    // /generate agentic loop (the queued agent-task path is reserved for
    // /goal and uploaded-document turns), so the queued-route gate is false…
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(prompt), false)
    // …but the prompt is still WORK: it must never fall to the plain fast
    // text route, or the inline agentic loop (web tools) would be skipped.
    assert.equal(shouldUseFastTextRoute(prompt), false)
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
    assert.equal(extractRequestedVideoAspectRatio("genera un video cuadrado de un perro"), "1:1")
    assert.equal(extractRequestedVideoAspectRatio("genera un video rectangular para youtube"), "16:9")
    assert.equal(extractRequestedVideoAspectRatio("crea un video vertical para reels"), "9:16")
    assert.equal(extractRequestedVideoAspectRatio("crea un video 21x9 cinematográfico"), "21:9")
    assert.equal(extractRequestedVideoResolution("crea un video 480p sin audio"), "480p")
    assert.equal(extractRequestedVideoResolution("crea un video en 720p con audio"), "720p")
    assert.equal(extractRequestedVideoAudio("crea un video 480p sin audio"), false)
    assert.equal(extractRequestedVideoAudio("crea un video en 720p con audio"), true)
    assert.equal(classifyIntentFastPath("qué video me recomiendas para aprender React?"), null)
    assert.equal(await aiService.classifyIntent("qué video me recomiendas para aprender React?"), "text")

    const musicPrompt = "genérame una canción de 10 segundos estilo lofi"
    assert.equal(classifyIntentFastPath(musicPrompt), "agent_task")
    assert.equal(await aiService.classifyIntent(musicPrompt), "agent_task")
    // Since commit 53a46aa89, no-file creation prompts run on the inline
    // /generate agentic loop, not the queued agent-task path — the queued
    // gate is false, but the prompt must still skip the plain fast text route.
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime("crea una canción lofi"), false)
    assert.equal(shouldUseFastTextRoute("crea una canción lofi"), false)

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

  it("keeps Trabajo conversational for greetings and durable for real work", () => {
    assert.equal(shouldRouteWorkModePromptThroughAgentTask("hola"), false)
    assert.equal(shouldRouteWorkModePromptThroughAgentTask("gracias"), false)
    assert.equal(
      shouldRouteWorkModePromptThroughAgentTask("crea un informe Word profesional con conclusiones"),
      true,
    )
    assert.equal(
      shouldRouteWorkModePromptThroughAgentTask("investiga el mercado y entrega una hoja de cálculo"),
      true,
    )
    assert.equal(
      shouldRouteWorkModePromptThroughAgentTask("edita este archivo", [
        { name: "informe.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ]),
      true,
    )
    assert.equal(
      shouldRouteWorkModePromptThroughAgentTask("describe esta imagen", [
        { name: "captura.png", mimeType: "image/png" },
      ]),
      false,
    )
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
