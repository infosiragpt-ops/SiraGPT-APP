import test from "node:test"
import assert from "node:assert/strict"
import { isAgentComputerEnabled } from "../lib/agent-computer-flag"

test("agent computer viewer stays off unless the flag is explicit", () => {
  assert.equal(isAgentComputerEnabled({}), false)
  assert.equal(isAgentComputerEnabled({ SIRAGPT_AGENT_COMPUTER: "" }), false)
  assert.equal(isAgentComputerEnabled({ NEXT_PUBLIC_AGENT_COMPUTER: "0" }), false)
  assert.equal(isAgentComputerEnabled({ NEXT_PUBLIC_AGENT_COMPUTER: "1" }), true)
  assert.equal(isAgentComputerEnabled({ SIRAGPT_AGENT_COMPUTER: "1" }), true)
})
