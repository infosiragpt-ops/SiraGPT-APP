import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const integrationStack = require(path.join(
  process.cwd(),
  "backend/src/services/ai-product-os/integration-stack.js",
))

describe("AI Product OS integration stack", () => {
  it("exposes a broad backend-only capability registry without UI coupling", () => {
    const stack = integrationStack.createIntegrationStack()
    const integrity = stack.integrity()
    const status = stack.status()

    assert.equal(integrity.ok, true)
    assert.ok(integrity.layer_count >= 26)
    assert.ok(integrity.library_count >= 180)
    assert.equal(status.layers.length, integrity.layer_count)

    const ids = status.layers.map((layer: any) => layer.id)
    for (const expected of [
      "model-gateway",
      "agent-sdk",
      "orchestration",
      "rag",
      "document",
      "docx-generation",
      "spreadsheet-generation",
      "presentation-generation",
      "pdf-generation",
      "browser",
      "database",
      "fullstack-web-builder",
      "security-governance",
      "observability",
    ]) {
      assert.ok(ids.includes(expected), `missing layer ${expected}`)
    }
  })

  it("resolves academic document work into RAG, DOCX, PDF, citation and validation layers", () => {
    const stack = integrationStack.createIntegrationStack()
    const plan = stack.resolveExecutionStack({
      primaryIntent: "professional_document_generation",
      secondaryIntents: ["scientific_research", "doi_validation"],
      outputFormats: ["docx", "pdf"],
      requiredTools: ["web_search", "doi_validator", "citation_formatter", "docx_renderer", "pdf_renderer"],
    })
    const ids = plan.layers.map((layer: any) => layer.id)

    for (const expected of [
      "model-gateway",
      "structured-outputs",
      "rag",
      "document",
      "docx-generation",
      "pdf-generation",
      "scientific-typesetting",
      "mcp",
      "eval",
      "observability",
    ]) {
      assert.ok(ids.includes(expected), `missing layer ${expected}`)
    }
    assert.ok(plan.validation_gates.includes("citation_grounding"))
    assert.equal(plan.release_gate.never_fake_citations, true)
  })

  it("resolves web app generation into builder, sandbox, security and cloud-native layers", () => {
    const stack = integrationStack.createIntegrationStack()
    const plan = stack.resolveExecutionStack({
      primaryIntent: "web_app_generation",
      outputFormats: ["zip"],
      requiredTools: ["code_project_generator", "run_frontend_build", "playwright_tester"],
      requiresCode: true,
    })
    const ids = plan.layers.map((layer: any) => layer.id)

    for (const expected of [
      "fullstack-web-builder",
      "sandbox",
      "security-governance",
      "cloud-native",
      "eval",
    ]) {
      assert.ok(ids.includes(expected), `missing layer ${expected}`)
    }
    assert.ok(plan.security_gates.includes("secret_scan"))
    assert.ok(plan.validation_gates.includes("build_passes"))
  })

  it("reports installed artifact dependencies instead of claiming unavailable tools", () => {
    const stack = integrationStack.createIntegrationStack()
    const readiness = stack.dependencyReadiness({
      primaryIntent: "professional_document_generation",
      secondaryIntents: ["scientific_research"],
      outputFormats: ["docx", "pdf"],
      requiredTools: ["docx_renderer", "pdf_renderer"],
    })

    const docxLayer = readiness.layers.find((layer: any) => layer.id === "docx-generation")
    const pdfLayer = readiness.layers.find((layer: any) => layer.id === "pdf-generation")
    assert.ok(docxLayer, "docx readiness layer missing")
    assert.ok(pdfLayer, "pdf readiness layer missing")

    const docxLib = docxLayer.libraries.find((library: any) => library.id === "docx")
    const mammothLib = docxLayer.libraries.find((library: any) => library.id === "mammoth")
    const pdfLib = pdfLayer.libraries.find((library: any) => library.id === "pdf-lib")

    assert.equal(docxLib.status, "ready")
    assert.equal(mammothLib.status, "ready")
    assert.equal(pdfLib.status, "ready")
    assert.equal(readiness.release_gate.never_claim_missing_tools, true)
    assert.equal(readiness.release_gate.do_not_expose_secret_values, true)
    assert.ok(readiness.summary.package_files_detected >= 1)
  })

  it("checks builder dependencies for web app tasks without touching frontend UI", () => {
    const stack = integrationStack.createIntegrationStack()
    const readiness = stack.dependencyReadiness({
      primaryIntent: "web_app_generation",
      outputFormats: ["zip"],
      requiredTools: ["run_frontend_build", "playwright_tester"],
      requiresCode: true,
    })
    const builder = readiness.layers.find((layer: any) => layer.id === "fullstack-web-builder")
    assert.ok(builder, "builder readiness layer missing")

    for (const expected of ["nextjs", "react", "tailwindcss", "playwright", "eslint"]) {
      const library = builder.libraries.find((item: any) => item.id === expected)
      assert.ok(library, `missing builder library ${expected}`)
      assert.equal(library.status, "ready", `${expected} should be detected from package manifests`)
    }
    assert.equal(readiness.release_gate.ready_for_dry_run, true)
  })

  it("can resolve directly from a Cira envelope shape", () => {
    const stack = integrationStack.createIntegrationStack()
    const plan = stack.resolveExecutionStack({
      envelope: {
        request_id: "req_test",
        intent_analysis: {
          primary_intent: { id: "spreadsheet_analysis" },
          secondary_intents: [{ id: "market_research" }],
          task_family: "data",
        },
        task_classification: {
          requires_external_research: true,
          requires_file_processing: true,
        },
        output_contract: {
          primary_output: { format: "xlsx" },
          secondary_outputs: [{ format: "pdf" }],
        },
        tool_plan: {
          required_tools: [
            { tool_name: "spreadsheet_reader" },
            { tool_name: "market_research" },
            { tool_name: "pdf_renderer" },
          ],
        },
        workflow_graph: {
          nodes: [
            { tools: ["spreadsheet_reader"] },
            { tools: ["market_research"] },
          ],
        },
        context_requirements: { needs_web_search: true },
      },
    })
    const ids = plan.layers.map((layer: any) => layer.id)

    assert.equal(plan.request_id, "req_test")
    assert.ok(ids.includes("spreadsheet-generation"))
    assert.ok(ids.includes("bi-studio"))
    assert.ok(ids.includes("data-pipelines"))
    assert.ok(ids.includes("rag"))
    assert.ok(ids.includes("pdf-generation"))
  })
})
