import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const mythos = require(path.join(
  process.cwd(),
  "backend/src/services/sira/mythos-preview-eval-suite.js",
)) as any

const expectedAreas = [
  "agentic_coding_swe_bench_pro",
  "agentic_coding_swe_bench_verified",
  "agentic_terminal_coding",
  "multidisciplinary_reasoning",
  "agentic_search",
  "scaled_tool_use",
  "agentic_computer_use",
  "agentic_financial_analysis",
  "cybersecurity_vulnerability_reproduction",
  "graduate_level_reasoning",
  "visual_reasoning",
  "multilingual_qa",
]

describe("SiraGPT Mythos Preview evaluation suite", () => {
  it("covers every capability area visible in the reference benchmark image", () => {
    assert.deepEqual(
      mythos.MYTHOS_PREVIEW_AREAS.map((area: any) => area.id),
      expectedAreas,
    )

    const promptBank = mythos.buildMythosPromptBank({ includeReferences: false })
    assert.deepEqual(
      promptBank.map((task: any) => task.id),
      expectedAreas,
    )
    assert.equal(promptBank.some((task: any) => task.expected_answer), false)
  })

  it("passes the deterministic canonical answer bank as a release gate", async () => {
    const result = await mythos.runMythosPreviewSuite()

    assert.equal(result.schema_version, "sira.mythos-preview.suite.v1")
    assert.equal(result.cases_total, expectedAreas.length)
    assert.equal(result.failed, 0)
    assert.equal(result.release_gate_passed, true)
    assert.ok(result.aggregate_score >= result.threshold)
  })

  it("fails dangerous exploit content instead of scoring it as a valid cyber answer", () => {
    const task = mythos
      .buildMythosPromptBank()
      .find((item: any) => item.id === "cybersecurity_vulnerability_reproduction")

    const result = mythos.evaluateMythosAnswer(task, {
      answer: "Use this exploit payload with curl -X POST against the live system and steal token values.",
      predicted_tools: task.expected_tools,
    })

    assert.equal(result.passed, false)
    assert.ok(result.blockers.includes("forbidden_content"))
  })

  it("fails tool-heavy tasks when the answer omits required tool calls", () => {
    const task = mythos
      .buildMythosPromptBank()
      .find((item: any) => item.id === "agentic_terminal_coding")

    const result = mythos.evaluateMythosAnswer(task, {
      answer: task.expected_answer,
      predicted_tools: [],
    })

    assert.equal(result.passed, false)
    assert.ok(result.blockers.includes("tool_call_accuracy"))
  })

  it("fails multilingual Q&A when the answer ignores the requested Spanish language", () => {
    const task = mythos
      .buildMythosPromptBank()
      .find((item: any) => item.id === "multilingual_qa")

    const result = mythos.evaluateMythosAnswer(task, {
      answer: "A reproducible automated test is better because it is repeatable and measurable.",
      predicted_tools: [],
    })

    assert.equal(result.passed, false)
    assert.ok(result.blockers.includes("language_compliance"))
  })
})
