import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const runtime = require(path.join(
  process.cwd(),
  "backend/src/services/agent-runtime",
))
const siraEngine = require(path.join(
  process.cwd(),
  "backend/src/services/sira/engine.js",
))
const { createDefaultRegistry, SiraToolRegistry } = require(path.join(
  process.cwd(),
  "backend/src/services/sira/tool-registry.js",
))
const siraWorkflowRuntime = require(path.join(
  process.cwd(),
  "backend/src/services/sira/runtime.js",
))

describe("agent-runtime · langchain-inspired runnable contract", () => {
  it("composes runnables and emits trace events", async () => {
    const trace = runtime.createTrace({ metadata: { test: "sequence" } })
    const pipeline = runtime.sequence("math.pipeline", [
      runtime.runnable("add_one", async (value: number) => value + 1),
      runtime.runnable("double", async (value: number) => value * 2),
    ])

    const result = await pipeline.invoke(2, { trace })
    const snapshot = trace.finish("completed")

    assert.equal(result, 6)
    assert.ok(snapshot.events.some((event: any) => event.type === "runnable.start" && event.payload.name === "add_one"))
    assert.ok(snapshot.events.some((event: any) => event.type === "runnable.end" && event.payload.name === "double"))
  })

  it("retries failing runnables before surfacing a successful result", async () => {
    let attempts = 0
    const flaky = runtime.runnable("flaky", async () => {
      attempts += 1
      if (attempts < 2) throw new Error("temporary")
      return "ok"
    }).withRetry({ maxRetries: 2, backoffMs: 1 })

    assert.equal(await flaky.invoke("input"), "ok")
    assert.equal(attempts, 2)
  })

  it("falls back to an alternative runnable when the primary fails", async () => {
    const primary = runtime.runnable("primary", async () => {
      throw new Error("primary unavailable")
    })
    const fallback = runtime.runnable("fallback", async () => "fallback result")

    assert.equal(await primary.withFallbacks([fallback]).invoke({}), "fallback result")
  })
})

describe("agent-runtime · multimodal content blocks", () => {
  it("preserves user text and uploaded image/document blocks", () => {
    const blocks = runtime.buildContentBlocks({
      text: "transcribir porfavor",
      attachments: [
        { id: "img1", filename: "captura.png", mime_type: "image/png", path: "/tmp/captura.png" },
        { id: "doc1", filename: "tesis.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ],
    })

    assert.deepEqual(blocks.map((block: any) => block.type), ["text", "image", "document"])
    assert.equal(blocks[0].text, "transcribir porfavor")
    assert.equal(runtime.summarizeContentBlocks(blocks).has_file_context, true)
  })

  it("validates simple JSON schemas for structured outputs", () => {
    const parsed = runtime.parseWithSchema('{"primary_intent":"docx_generation","confidence":0.93}', {
      type: "object",
      required: ["primary_intent", "confidence"],
      properties: {
        primary_intent: { type: "string" },
        confidence: { type: "number" },
      },
    })

    assert.equal(parsed.primary_intent, "docx_generation")
  })
})

describe("sira engine · agent runtime integration", () => {
  it("returns runtime trace, selected tools and content summary with every contract", async () => {
    const result = await siraEngine.runUserMessage({
      text: "crea una ppt sobre marketing",
      attachments: [],
      dryRun: true,
    })

    assert.equal(result.ok, true)
    assert.equal(result.agent_runtime.ok, true)
    assert.equal(result.agent_runtime.content_summary.has_text, true)
    assert.ok(result.agent_runtime.runtime_graph.nodes.length > 0)
    assert.ok(result.agent_runtime.selected_tools.some((tool: any) => tool.name.includes("ppt") || tool.name.includes("slide")))
    assert.ok(result.agent_runtime.runtime_validation_reports.some((report: any) => report.name === "format_sovereignty_policy"))
    assert.ok(Array.isArray(result.agent_runtime.release_preflight.reports))
    assert.ok(result.agent_runtime.trace_events.some((event: any) => event.type === "contract.validated"))
    assert.ok(result.agent_runtime.trace_events.some((event: any) => event.type === "release.preflight"))
  })

  it("keeps required tools and caps optional tools through middleware", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea una ppt sobre marketing",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.tool_plan.optional_tools = Array.from({ length: 12 }, (_, index) => ({
      tool_name: `optional_tool_${index}`,
      reason: "stress optional budget",
    }))

    const result = await runtime.runCiraAgentRuntime({
      text: "crea una ppt sobre marketing",
      envelope,
      registry: createDefaultRegistry(),
      runtimeOptions: { maxTools: 3 },
    })

    const requiredCount = envelope.tool_plan.required_tools.length
    assert.equal(result.ok, true)
    assert.equal(result.selected_tools.filter((tool: any) => tool.required).length, requiredCount)
    assert.ok(result.selected_tools.length <= Math.max(requiredCount, 3))
    assert.ok(result.runtime_validation_reports.some((report: any) => report.code === "tool_selection_budget_applied"))
  })

  it("blocks release when requested format and output contract diverge", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea una ppt sobre marketing",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.entities.requested_formats = ["pptx"]
    envelope.output_contract.primary_output.format = "docx"
    envelope.output_contract.primary_output.filename_suggestion = "wrong.docx"

    const result = await runtime.runCiraAgentRuntime({
      text: "crea una ppt sobre marketing",
      envelope,
      registry: createDefaultRegistry(),
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, "blocked")
    assert.equal(result.release_preflight.ready, false)
    assert.ok(result.release_preflight.violations.some((violation: any) => violation.code === "format_sovereignty_failed"))
    assert.ok(result.format_sovereignty.violations.some((violation: any) => violation.code === "primary_format_mismatch"))
  })

  it("blocks release when the execution graph is not a valid DAG", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea un excel para ventas",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.workflow_graph.nodes = [
      { id: "a", label: "A", agent: "planner", tools: [], depends_on: ["b"], status: "pending" },
      { id: "b", label: "B", agent: "planner", tools: [], depends_on: ["a"], status: "pending" },
      { id: "c", label: "C", agent: "planner", tools: [], depends_on: ["missing"], status: "pending" },
    ]

    const result = await runtime.runCiraAgentRuntime({
      text: "crea un excel para ventas",
      envelope,
      registry: createDefaultRegistry(),
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, "blocked")
    assert.ok(result.release_preflight.violations.some((violation: any) => violation.code === "dag_integrity_failed"))
    const dagReport = result.runtime_validation_reports.find((report: any) => report.name === "dag_integrity_policy")
    assert.equal(dagReport.status, "failed")
    assert.ok(dagReport.details.cycles.length > 0)
    assert.ok(dagReport.details.missing_dependencies.length > 0)
  })

  it("blocks high-impact side-effect tools unless a human explicitly approves them", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea una landing profesional y publica una vista previa",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.tool_plan.required_tools = [{
      tool_name: "create_preview_url",
      reason: "Public preview requires backend authorization.",
      priority: "critical",
    }]
    envelope.tool_plan.optional_tools = []
    envelope.workflow_graph.nodes = [{
      id: "tool.create_preview_url",
      label: "Create Preview Url",
      agent: "artifact_agent",
      tools: ["create_preview_url"],
      depends_on: [],
      status: "pending",
    }]
    envelope.workflow_graph.tool_calls = [{
      node_id: "tool.create_preview_url",
      tool_name: "create_preview_url",
      status: "planned",
    }]

    const result = await runtime.runCiraAgentRuntime({
      text: "crea una landing profesional y publica una vista previa",
      envelope,
      registry: createDefaultRegistry(),
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, "blocked")
    assert.equal(result.tool_policy.blocked_required_tools, 1)
    assert.ok(result.policy_blocked_tools.some((tool: any) => tool.name === "create_preview_url"))
    assert.ok(result.release_preflight.violations.some((violation: any) => violation.code === "tool_runtime_policy_blocked"))
    const policyReport = result.runtime_validation_reports.find((report: any) => report.name === "tool_runtime_policy")
    assert.equal(policyReport.status, "failed")
  })

  it("authorizes high-impact tools only with explicit approval and side-effect opt-in", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea una landing profesional y publica una vista previa",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.tool_plan.required_tools = [{
      tool_name: "create_preview_url",
      reason: "Approved publish preview.",
      priority: "critical",
    }]
    envelope.tool_plan.optional_tools = []
    envelope.workflow_graph.nodes = [{
      id: "tool.create_preview_url",
      label: "Create Preview Url",
      agent: "artifact_agent",
      tools: ["create_preview_url"],
      depends_on: [],
      status: "pending",
    }]
    envelope.workflow_graph.tool_calls = [{
      node_id: "tool.create_preview_url",
      tool_name: "create_preview_url",
      status: "planned",
    }]

    const result = await runtime.runCiraAgentRuntime({
      text: "crea una landing profesional y publica una vista previa",
      envelope,
      registry: createDefaultRegistry(),
      runtimeOptions: {
        toolPolicyProfile: "interactive",
        humanApproved: true,
        allowExternalSideEffects: true,
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.tool_policy.blocked_required_tools, 0)
    assert.ok(!result.release_preflight.violations.some((violation: any) => violation.code === "tool_runtime_policy_blocked"))
    const policyReport = result.runtime_validation_reports.find((report: any) => report.name === "tool_runtime_policy")
    assert.equal(policyReport.status, "passed")
  })

  it("enforces the same tool policy inside the concrete workflow executor", async () => {
    const base = await siraEngine.runUserMessage({
      text: "crea una landing profesional y publica una vista previa",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.workflow_graph.nodes = [{
      id: "tool.create_preview_url",
      label: "Create Preview Url",
      agent: "artifact_agent",
      tools: ["create_preview_url"],
      depends_on: [],
      status: "pending",
    }]

    const result = await siraWorkflowRuntime.runWorkflow({
      envelope,
      registry: createDefaultRegistry(),
      dryRun: false,
    })

    const denied = result.tool_results.find((toolResult: any) => toolResult.tool === "create_preview_url")
    assert.equal(denied.status, "error")
    assert.equal(denied.error.code, "tool_policy_denied")
    assert.ok(result.audit_trace.some((event: any) => event.event === "tool_policy_denied"))
  })

  it("deduplicates repeated side-effecting tool invocations in the concrete workflow executor", async () => {
    let executionCount = 0
    const registry = new SiraToolRegistry()
    registry.register({
      name: "write_once",
      displayName: "Write Once",
      description: "Creates a deterministic artifact once per idempotency key.",
      category: "document",
      riskLevel: "low",
      permissionsRequired: ["write_artifact"],
      timeoutMs: 30000,
      async execute(input: any) {
        executionCount += 1
        return {
          status: "success",
          output: { executionCount, input },
          artifacts: [{
            artifact_id: "artifact.write_once",
            type: "file",
            format: "docx",
            filename: "write_once.docx",
            status: "ready",
            download_url: "/artifacts/write_once.docx",
          }],
          metadata: { executor: "test" },
        }
      },
    })
    const base = await siraEngine.runUserMessage({
      text: "crea un documento word profesional",
      attachments: [],
      dryRun: true,
    })
    const envelope = structuredClone(base.envelope)
    envelope.workflow_graph.idempotency_key = "test:write-once"
    envelope.workflow_graph.nodes = [
      {
        id: "n1",
        label: "Write once",
        agent: "artifact_agent",
        tools: ["write_once"],
        depends_on: [],
        status: "pending",
      },
      {
        id: "n2",
        label: "Write once duplicate",
        agent: "artifact_agent",
        tools: ["write_once"],
        depends_on: ["n1"],
        status: "pending",
      },
    ]

    const result = await siraWorkflowRuntime.runWorkflow({
      envelope,
      registry,
      toolArgs: { write_once: { title: "same input" } },
      dryRun: false,
    })

    assert.equal(executionCount, 1)
    assert.equal(result.tool_results.length, 2)
    assert.equal(result.tool_results[0].metadata.idempotency.cache_hit, false)
    assert.equal(result.tool_results[1].metadata.idempotency.cache_hit, true)
    assert.equal(result.tool_results[1].metadata.idempotency.deduped_from_node, "n1")
    assert.equal(result.summary.idempotency_guard.guarded_invocations, 1)
    assert.ok(result.audit_trace.some((event: any) => event.event === "tool_deduplicated"))
  })
})
