import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const frontend = readFileSync("lib/code-agent-company.ts", "utf8")
const backend = readFileSync("backend/src/services/codex/company-departments.js", "utf8")

function idsIn(source: string, quote: '"' | "'"): string[] {
  const start = source.indexOf(quote === '"' ? "AGENT_COMPANY_DEPARTMENTS" : "BUILT_IN_DEPARTMENTS")
  const end = source.indexOf("] as const", start)
  const blockEnd = end === -1 ? source.indexOf("])", start) + 2 : end
  const block = source.slice(start, blockEnd)
  const re = quote === '"' ? /id:\s*"([a-z0-9-]+)"/g : /id:\s*'([a-z0-9-]+)'/g
  return [...block.matchAll(re)].map((m) => m[1])
}

describe("agent company department catalog", () => {
  it("has unique ids on the frontend and backend catalogs", () => {
    const frontIds = idsIn(frontend, '"')
    const backIds = idsIn(backend, "'")
    assert.ok(frontIds.length >= 10, "frontend catalog should list the built-in fleet")
    assert.equal(new Set(frontIds).size, frontIds.length, `duplicate frontend ids: ${frontIds}`)
    assert.equal(new Set(backIds).size, backIds.length, `duplicate backend ids: ${backIds}`)
    assert.deepEqual([...frontIds].sort(), [...backIds].sort())
    assert.ok(!frontIds.includes("customer-success") || frontIds.filter((id) => id === "customer-success").length === 1)
  })
})
