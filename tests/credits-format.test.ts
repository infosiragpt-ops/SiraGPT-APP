import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("credits chrome", () => {
  it("formats million balances instead of dumping 1000000", () => {
    const service = source("lib/credits-service.ts")
    const badge = source("components/CreditsBadge.tsx")
    assert.match(service, /export function formatCreditBalance/)
    assert.match(service, /mill\./)
    assert.match(badge, /formatCreditBalance\(credits\.balance\)/)
    assert.doesNotMatch(badge, /<span>\{credits\.balance\}<\/span>/)
  })

  it("keeps credits off the /agentes chat canvas", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.doesNotMatch(chat, /CreditsBadge/)
  })
})
