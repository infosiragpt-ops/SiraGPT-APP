import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getAgentCompanySlot,
  registerAgentCompanySlot,
  subscribeAgentCompanySlot,
} from "../lib/agent-company-slot"

describe("agent-company-slot", () => {
  it("registers, notifies subscribers, and clears on null", () => {
    const seen: Array<HTMLElement | null> = []
    const unsubscribe = subscribeAgentCompanySlot((el) => {
      seen.push(el)
    })

    assert.equal(getAgentCompanySlot(), null)
    assert.equal(seen.at(-1), null)

    const el = { id: "siragpt-agent-company-slot" } as unknown as HTMLElement
    registerAgentCompanySlot(el)
    assert.equal(getAgentCompanySlot(), el)
    assert.equal(seen.at(-1), el)

    registerAgentCompanySlot(null)
    assert.equal(getAgentCompanySlot(), null)
    assert.equal(seen.at(-1), null)

    unsubscribe()
    registerAgentCompanySlot(el)
    assert.equal(seen.filter((row) => row === el).length, 1)
    registerAgentCompanySlot(null)
  })
})
