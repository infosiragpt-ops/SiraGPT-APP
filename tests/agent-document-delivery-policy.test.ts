import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import * as path from "node:path"

// Anchor CJS resolution at the repo root (the runner always runs from the
// repo root) so backend requires work no matter where test-dist lives.
const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))

const policyModule = cjsRequire("./backend/src/services/agents/document-delivery-policy") as {
  buildDocumentDeliveryPolicy: (args: { goal?: string; displayGoal?: string; files?: string[]; requestedFormat?: string | null }) => {
    mode: string
    format: string
    autoGenerate: boolean
  }
  detectFormat: (text: string, requestedFormat?: string | null) => string
}

const vancouverModule = cjsRequire("./backend/src/services/agents/vancouver-table-document") as {
  isVancouverMatrixWordRequest: (goal: string) => boolean
  INTERNAL: {
    matrixTableScore: (table: string[][]) => number
    mapMatrixTableToRows: (table: string[][]) => Array<{
      title: string
      authors: string
      year: string
      design: string
      sampling: string
      sampleSize: string
      origin: string
      occupation: string
      instrument: string
    }>
  }
}

describe("DocumentDeliveryPolicy", () => {
  it("prioriza Word cuando el usuario pide una tabla dentro de un documento Word", () => {
    const prompt = "(TÍTULO DEL ARTÍCULO AUTORES AÑO DE PUBLICACIÓN DISEÑO DE INVESTIGACIÓN MUESTREO N PROCEDENCIA OCUPACIÓN INSTRUMENTO) los resultados del word lo quiere asi como esta estructurada tabla en un word en vancouver"

    assert.equal(policyModule.detectFormat(prompt), "docx")

    const policy = policyModule.buildDocumentDeliveryPolicy({
      goal: prompt,
      files: ["file_1"],
    })
    assert.equal(policy.format, "docx")
    assert.equal(policy.mode, "doc_required")
    assert.equal(policy.autoGenerate, true)
  })

  it("mantiene Excel para solicitudes explicitamente Excel", () => {
    assert.equal(
      policyModule.detectFormat("crea una tabla comparativa en Excel con KPIs y formulas"),
      "xlsx",
    )
  })

  it("detecta la ruta deterministica de matriz Vancouver en Word", () => {
    assert.equal(
      vancouverModule.isVancouverMatrixWordRequest("estructura los resultados en una tabla en Word en Vancouver"),
      true,
    )
    assert.equal(
      vancouverModule.isVancouverMatrixWordRequest("estructura los resultados en una tabla en Excel"),
      false,
    )
  })

  it("convierte una tabla nativa de Word a columnas Vancouver", () => {
    const sourceTable = [
      [
        "Nº",
        "Autor(es) y año",
        "Título del estudio",
        "País",
        "Muestra / Población",
        "Enfoque / Tipo de estudio",
        "Principales resultados o hallazgos",
        "Vacíos o limitaciones identificadas",
      ],
      [
        "1",
        "Betit et al. (2025)",
        "The Impact of a Simulated Intrauterine Device",
        "Estados Unidos",
        "57 estudiantes preclínicos",
        "Pre-post intervención",
        "Clínica simulada mejora significativamente conocimiento y disposición.",
        "Muestra reducida.",
      ],
    ]

    assert.ok(vancouverModule.INTERNAL.matrixTableScore(sourceTable) >= 6)
    const [row] = vancouverModule.INTERNAL.mapMatrixTableToRows(sourceTable)

    assert.equal(row.title, "The Impact of a Simulated Intrauterine Device")
    assert.equal(row.authors, "Betit et al.")
    assert.equal(row.year, "2025")
    assert.equal(row.design, "Pre-post intervención")
    assert.equal(row.sampleSize, "57")
    assert.equal(row.origin, "Estados Unidos")
  })
})
