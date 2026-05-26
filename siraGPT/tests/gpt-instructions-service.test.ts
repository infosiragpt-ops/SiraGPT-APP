import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  GPTInstructionsService,
  gptInstructionsService,
  predefinedInstructions,
} from "../lib/gpt-instructions-service"

describe("predefinedInstructions catalog", () => {
  it("has at least 8 entries", () => {
    assert.ok(predefinedInstructions.length >= 8)
  })

  it("every entry has the required fields populated", () => {
    for (const inst of predefinedInstructions) {
      assert.ok(inst.id, "id missing")
      assert.ok(inst.title, "title missing")
      assert.ok(inst.instruction, "instruction missing")
      assert.ok(inst.category, "category missing")
    }
  })

  it("ids are unique across the catalog", () => {
    const ids = predefinedInstructions.map((i) => i.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe("GPTInstructionsService · query helpers", () => {
  const svc = new GPTInstructionsService()

  it("getInstructions returns the full predefined list", () => {
    assert.equal(svc.getInstructions().length, predefinedInstructions.length)
  })

  it("getInstructionsByCategory filters by exact category", () => {
    const analysis = svc.getInstructionsByCategory("Analysis")
    assert.ok(analysis.length >= 2) // Document Summarization, Data Analysis
    for (const inst of analysis) {
      assert.equal(inst.category, "Analysis")
    }
  })

  it("getInstructionsByCategory returns [] for unknown category", () => {
    assert.deepEqual(svc.getInstructionsByCategory("Nonexistent"), [])
  })

  it("getCategories returns a de-duplicated category list", () => {
    const cats = svc.getCategories()
    // Each predefined category exactly once.
    assert.equal(new Set(cats).size, cats.length)
    assert.ok(cats.includes("Analysis"))
    assert.ok(cats.includes("Development"))
  })
})

describe("GPTInstructionsService · generateCustomInstruction", () => {
  const svc = new GPTInstructionsService()

  it("embeds the supplied context and task in the prompt", () => {
    const out = svc.generateCustomInstruction("a report on Q1", "find anomalies")
    assert.match(out, /"a report on Q1"/)
    assert.match(out, /"find anomalies"/)
  })

  it("handles empty context / task without throwing", () => {
    assert.doesNotThrow(() => svc.generateCustomInstruction("", ""))
    const out = svc.generateCustomInstruction("", "")
    assert.ok(out.includes(`""`))
  })
})

describe("gptInstructionsService singleton", () => {
  it("is an instance of GPTInstructionsService", () => {
    assert.ok(gptInstructionsService instanceof GPTInstructionsService)
  })

  it("getInstructions on the singleton matches the catalog length", () => {
    assert.equal(
      gptInstructionsService.getInstructions().length,
      predefinedInstructions.length,
    )
  })
})
