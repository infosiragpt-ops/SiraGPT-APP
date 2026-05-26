import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const siraWorkflowRuntime = require(path.join(
  process.cwd(),
  "backend/src/services/sira/runtime.js",
))
const { SiraToolRegistry } = require(path.join(
  process.cwd(),
  "backend/src/services/sira/tool-registry.js",
))

describe("sira execution trace frame", () => {
  it("emits a privacy-safe runtime timeline for successful workflows", async () => {
    const registry = new SiraToolRegistry()
    registry.register({
      name: "trace_renderer",
      displayName: "Trace Renderer",
      description: "Produces a deterministic document artifact.",
      category: "document",
      riskLevel: "low",
      permissionsRequired: ["write_artifact"],
      timeoutMs: 30000,
      async execute() {
        return {
          status: "success",
          output: { secret: "do-not-log-raw-tool-output" },
          artifacts: [{
            artifact_id: "artifact.trace_renderer",
            type: "file",
            format: "docx",
            filename: "trace_renderer.docx",
            status: "ready",
            download_url: "/artifacts/trace_renderer.docx",
          }],
        }
      },
    })

    const result = await siraWorkflowRuntime.runWorkflow({
      envelope: buildEnvelope({
        requestId: "req_trace_success",
        nodes: [{
          id: "n1",
          label: "Render document",
          agent: "artifact_agent",
          tools: ["trace_renderer"],
          depends_on: [],
          status: "pending",
        }],
      }),
      registry,
      dryRun: false,
    })

    const frame = result.execution_trace_frame
    assert.equal(frame.frame_type, "execution_trace_frame")
    assert.equal(frame.request_id, "req_trace_success")
    assert.equal(frame.privacy.raw_tool_input_logged, false)
    assert.equal(frame.privacy.raw_tool_output_logged, false)
    assert.equal(frame.counters.nodes_completed, 1)
    assert.equal(frame.counters.tools_total, 1)
    assert.equal(frame.tools[0].tool_name, "trace_renderer")
    assert.equal(frame.tools[0].status, "success")
    assert.ok(frame.timeline.some((event: any) => event.type === "tool_invoked"))
    assert.equal(JSON.stringify(frame).includes("do-not-log-raw-tool-output"), false)
    assert.equal(result.summary.execution_trace.tools_with_errors, 0)
  })

  it("captures retries and attempts without raw payloads", async () => {
    let executionCount = 0
    const registry = new SiraToolRegistry()
    registry.register({
      name: "trace_flaky_renderer",
      displayName: "Trace Flaky Renderer",
      description: "Fails twice before producing an artifact.",
      category: "document",
      riskLevel: "low",
      permissionsRequired: ["write_artifact"],
      timeoutMs: 30000,
      async execute() {
        executionCount += 1
        if (executionCount < 3) {
          return {
            status: "error",
            error: { code: "file_generation_error", message: "temporary renderer failure" },
          }
        }
        return {
          status: "success",
          output: { executionCount },
          artifacts: [{
            artifact_id: "artifact.trace_flaky_renderer",
            type: "file",
            format: "docx",
            filename: "trace_flaky_renderer.docx",
            status: "ready",
            download_url: "/artifacts/trace_flaky_renderer.docx",
          }],
        }
      },
    })

    const result = await siraWorkflowRuntime.runWorkflow({
      envelope: buildEnvelope({
        requestId: "req_trace_retry",
        retryPolicy: {
          max_retries_per_node: 2,
          retry_on: ["file_generation_error"],
          backoff_ms: 0,
        },
        nodes: [{
          id: "n1",
          label: "Render with retry",
          agent: "artifact_agent",
          tools: ["trace_flaky_renderer"],
          depends_on: [],
          status: "pending",
        }],
      }),
      registry,
      dryRun: false,
      context: { resilienceSleep: async () => {} },
    })

    const frame = result.execution_trace_frame
    assert.equal(executionCount, 3)
    assert.equal(frame.counters.retries_total, 2)
    assert.equal(frame.tools[0].attempts, 3)
    assert.equal(frame.tools[0].retries, 2)
    assert.equal(frame.tools[0].retry_exhausted, false)
    assert.equal(
      frame.timeline.filter((event: any) => event.type === "tool_retry_scheduled").length,
      2,
    )
  })
})

function buildEnvelope({
  requestId,
  nodes,
  retryPolicy = {},
}: {
  requestId: string
  nodes: any[]
  retryPolicy?: Record<string, any>
}) {
  return {
    request_id: requestId,
    conversation_id: `conv_${requestId}`,
    user_id: `user_${requestId}`,
    intent_analysis: {
      primary_intent: { id: "docx_generation" },
      task_family: "artifact_creation",
    },
    workflow_graph: {
      execution_mode: "durable_multi_step",
      nodes,
      retry_policy: retryPolicy,
      audit_trace: [],
      evidence_ledger: [],
    },
    output_contract: {
      primary_output: {
        type: "file",
        format: "docx",
        filename_suggestion: `${requestId}.docx`,
        required: true,
      },
    },
    context_requirements: {
      citation_required: false,
      source_validation_required: false,
    },
    task_classification: {
      requires_code_execution: false,
    },
    safety_and_permissions: {
      overall_risk_level: "low",
      allowed_actions: ["write_artifact"],
    },
    quality_plan: {
      minimum_acceptance_score: 0.5,
      validators: [{ name: "artifact_validator" }],
    },
    model_execution_context: {
      selected_model: { provider: "test", modelId: "test-model", modality: "text" },
    },
  }
}
