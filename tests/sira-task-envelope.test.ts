import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const taskEnvelope = require(path.join(
  process.cwd(),
  "backend/src/services/sira/task-envelope-builder.js",
))

describe("sira task envelope · token-aware request intelligence", () => {
  it("treats Excel as input context when the requested output is Word", async () => {
    const { envelope, validation, request_intelligence } = await taskEnvelope.buildEnvelope({
      text: "Crear un documento Word academico profesional basado en Excel y fuentes reales con citas APA 7 y DOI verificados",
      attachments: [{ id: "datos.xlsx", name: "datos.xlsx" }],
    })

    assert.equal(validation.ok, true)
    assert.equal(envelope.intent_analysis.primary_intent.id, "academic_document")
    assert.deepEqual(envelope.entities.requested_formats, ["docx"])
    assert.equal(envelope.output_contract.primary_output.format, "docx")
    assert.ok(envelope.tool_plan.required_tools.some((tool: any) => tool.tool_name === "create_docx"))
    assert.ok(envelope.tool_plan.required_tools.some((tool: any) => tool.tool_name === "scientific_search"))
    assert.ok(envelope.tool_plan.required_tools.some((tool: any) => tool.tool_name === "doi_validator"))
    assert.deepEqual(request_intelligence.requested_formats.map((format: any) => format.extension), [".docx"])
    assert.ok(
      envelope.workflow_graph.audit_trace.some((event: any) => event.event === "request_intelligence_completed"),
    )
  })

  it("routes questions about an uploaded Word to context understanding instead of docx generation", async () => {
    const { envelope, validation, request_intelligence } = await taskEnvelope.buildEnvelope({
      text: "cual es la primera palabra del word?",
      attachments: [
        {
          id: "rdc-rsn.docx",
          name: "RDC-RSN.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    })

    assert.equal(validation.ok, true)
    assert.equal(envelope.intent_analysis.primary_intent.id, "general_question")
    assert.equal(envelope.output_contract.primary_output.type, "text")
    assert.equal(envelope.output_contract.primary_output.format, "markdown")
    assert.ok(!envelope.tool_plan.required_tools.some((tool: any) => tool.tool_name === "create_docx"))
    assert.equal(request_intelligence.context.asks_existing_document_question, true)
  })

  it("preserves format sovereignty for explicit SVG generation", async () => {
    const { envelope, validation } = await taskEnvelope.buildEnvelope({
      text: "creame un svg de una casa minimalista con codigo vectorial valido",
    })

    assert.equal(validation.ok, true)
    assert.equal(envelope.intent_analysis.primary_intent.id, "svg_generation")
    assert.deepEqual(envelope.entities.requested_formats, ["svg"])
    assert.equal(envelope.output_contract.primary_output.format, "svg")
    assert.ok(envelope.tool_plan.required_tools.some((tool: any) => tool.tool_name === "create_svg"))
  })
})
