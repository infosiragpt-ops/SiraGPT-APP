import assert from "node:assert/strict"
import test from "node:test"

import {
  registerAgentCompanyPreviewSlot,
  subscribeAgentCompanyPreviewSlot,
} from "../lib/agent-company-preview-slot"

test("company preview slot notifies subscribers and unregisters cleanly", () => {
  const received: Array<HTMLElement | null> = []
  const element = { id: "company-preview" } as unknown as HTMLElement
  const unsubscribe = subscribeAgentCompanyPreviewSlot((value) => received.push(value))

  registerAgentCompanyPreviewSlot(element)
  registerAgentCompanyPreviewSlot(null)
  unsubscribe()
  registerAgentCompanyPreviewSlot(element)

  assert.deepEqual(received, [null, element, null])
  registerAgentCompanyPreviewSlot(null)
})
