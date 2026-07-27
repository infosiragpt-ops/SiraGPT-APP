import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getAgentCompanySlot,
  registerAgentCompanySlot,
  subscribeAgentCompanySlot,
} from "../lib/agent-company-slot"

describe("agent-company-slot", () => {
  it("registers, notifies subscribers, and clears the dock", () => {
    const seen: Array<HTMLElement | null> = []
    const unsubscribe = subscribeAgentCompanySlot((element) => {
      seen.push(element)
    })

    assert.equal(getAgentCompanySlot(), null)
    const element = { id: "siragpt-agent-company-slot" } as unknown as HTMLElement
    registerAgentCompanySlot(element)
    assert.equal(getAgentCompanySlot(), element)
    assert.equal(seen.at(-1), element)

    registerAgentCompanySlot(null)
    assert.equal(getAgentCompanySlot(), null)
    assert.equal(seen.at(-1), null)
    unsubscribe()
  })
})
