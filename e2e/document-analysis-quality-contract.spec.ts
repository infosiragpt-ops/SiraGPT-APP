import { expect, test } from "@playwright/test"

const policy = require("../backend/src/services/document-analysis-quality")

const files = [
  { id: "docx-1", name: "TESIS 2 - JESSICA PATINO - 15JUN2026.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { id: "pdf-1", name: "articulo.pdf", mimeType: "application/pdf" },
  { id: "xlsx-1", name: "resultados.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { id: "txt-1", name: "notas.txt", mimeType: "text/plain" },
  "file-id-from-agent-task",
]

const prompts = [
  "dame un resumen en un solo parrafo",
  "dame un analisis en un solo parrafo",
  "resume este documento",
  "analiza el documento adjunto",
  "explica de que trata el archivo",
  "identifica el objetivo del estudio",
  "extrae los resultados principales",
  "dime las conclusiones",
  "cual es el metodo de investigacion",
  "que muestra usa la tesis",
  "identifica el instrumento aplicado",
  "dame autor ano objetivo metodo resultados y conclusiones",
  "cita este documento en APA 7",
  "cita este articulo en Vancouver",
  "haz una sintesis critica del PDF",
  "interpreta los hallazgos",
  "dime que dice el documento",
  "resume la metodologia y resultados",
  "analiza los anexos y conclusiones",
  "dame una evaluacion academica",
  "explica los resultados de la tabla",
  "identifica limitaciones del estudio",
  "dame el tema central y objetivos",
  "resume el marco teorico",
  "analiza las recomendaciones",
  "cuantas recomendaciones principales lista el informe",
  "suma el total de norte y sur",
  "cual es el valor del marcador de la hoja",
  "calcula el promedio trimestral de sur",
  "del contrato dime el proveedor y del informe el uptime",
  "multiplica ese importe por 2",
  "cual es el importe del contrato y el presupuesto de marketing del acta",
]

test.describe("document analysis quality contract", () => {
  let caseNo = 0

  for (const prompt of prompts) {
    for (const file of files) {
      caseNo += 1
      const fileLabel = typeof file === "string" ? file : file.name

      test(`case ${caseNo}: deep contract for "${prompt}" with ${fileLabel}`, async () => {
        const activeFiles = [file]

        expect(policy.isDocumentAnalysisRequest(prompt, activeFiles)).toBe(true)

        const block = policy.buildPromptBlock({
          prompt,
          files: activeFiles,
          language: "es",
          source: "playwright-e2e",
        })

        expect(block).toContain("CONTRATO DE ANALISIS DOCUMENTAL PROFUNDO")
        expect(block).toContain("inicio/titulo/problema")
        expect(block).toContain("resultados, conclusiones")

        const upgraded = policy.upgradeComputeForDocumentAnalysis(
          { mode: "direct", samples: 1, reasoningEffort: "low", reflection: false },
          { prompt, files: activeFiles },
        )

        expect(upgraded.compute.mode).toBe("self_consistency")
        expect(upgraded.compute.samples).toBeGreaterThanOrEqual(3)
        expect(upgraded.compute.reasoningEffort).toBe("high")
        expect(upgraded.compute.reflection).toBe(true)
      })
    }
  }

  test("does not activate for image-only evidence", async () => {
    const image = { id: "img-1", name: "captura.png", mimeType: "image/png" }

    expect(policy.isDocumentAnalysisRequest("analiza esta imagen", [image])).toBe(false)
    expect(policy.buildPromptBlock({ prompt: "analiza esta imagen", files: [image] })).toBe("")
  })

  test("marker lookups require literal identifiers instead of totals", async () => {
    const block = policy.buildPromptBlock({
      prompt: "cual es el valor del marcador de la hoja",
      files: [{ name: "ventas_2025.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
      language: "es",
      source: "playwright-e2e",
    })

    expect(block).toContain("valor literal")
    expect(block).toContain("no lo sustituyas por totales")
  })

  test("spreadsheet arithmetic requires final computed value first", async () => {
    const block = policy.buildPromptBlock({
      prompt: "suma el total de norte y sur",
      files: [{ name: "ventas_2025.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
      language: "es",
      source: "playwright-e2e",
    })

    expect(block).toContain("valor final calculado")
    expect(block).toContain("no respondas solo copiando filas")
  })

  test("multi-document field lookup covers every requested file", async () => {
    const block = policy.buildPromptBlock({
      prompt: "del contrato dime el proveedor y del informe el uptime",
      files: [
        { name: "contrato_servicios.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        { name: "informe_seguridad.pdf", mimeType: "application/pdf" },
      ],
      language: "es",
      source: "playwright-e2e",
    })

    expect(block).toContain("Solicitud multi-documento")
    expect(block).toContain("no omitiste ningun archivo")
  })

  test("follow-up numeric references require recent-turn resolution", async () => {
    const block = policy.buildPromptBlock({
      prompt: "multiplica ese importe por 2. Solo el numero",
      files: [{ name: "contrato_servicios.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
      language: "es",
      source: "playwright-e2e",
    })

    expect(block).toContain("resuelve pronombres")
    expect(block).toContain("digitos simples sin separadores de miles")
  })
})
