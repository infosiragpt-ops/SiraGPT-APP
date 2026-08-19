import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const { reviewCode } = require(path.join(
  process.cwd(),
  "backend/src/services/software-engineering/code-review.js",
))

describe("software-engineering code review thresholds", () => {
  it("honors explicit zero threshold overrides", () => {
    const source = [
      "function handler() {",
      "  // TODO: remove before shipping",
      "  return 1",
      "}",
    ].join("\n")

    const report = reviewCode({
      source,
      language: "javascript",
      thresholds: {
        fileLength: 0,
        nesting: 0,
        complexity: 0,
        lineLength: 0,
        todoDensity: 0,
      },
    })

    const codes = report.findings.map((finding: any) => finding.code)
    assert.ok(codes.includes("file_too_long"))
    assert.ok(codes.includes("deep_nesting"))
    assert.ok(codes.includes("high_complexity"))
    assert.ok(codes.includes("many_long_lines"))
    assert.ok(codes.includes("todo_density_high"))
  })
})
