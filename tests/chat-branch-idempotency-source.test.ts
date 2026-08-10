import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

describe("chat branch turn identity contract", () => {
  it("sanitizes each copied message instead of forwarding the source metadata unchanged", () => {
    const start = source.indexOf("const branchMessage = React.useCallback")
    const end = source.indexOf("// Complete chat share functionality", start)
    assert.ok(start >= 0 && end > start, "branchMessage source block must exist")
    const branchSource = source.slice(start, end)

    assert.match(
      branchSource,
      /for \(const m of slice\)[\s\S]*metadata: serializeBranchedMessageMetadata\(m\.metadata\)/,
    )
    assert.doesNotMatch(
      branchSource,
      /metadata: typeof m\.metadata === ["']string["'] \? m\.metadata/,
      "a branch must never replay the original turn idempotency key",
    )
  })
})
