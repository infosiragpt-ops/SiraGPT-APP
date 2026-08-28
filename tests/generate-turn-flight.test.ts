import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  addMessageFlights,
  generateStreamFlights,
  generateTurnFlightKey,
  resetGenerateTurnFlights,
} from "../lib/generate-turn-flight"

describe("generate turn single-flight", () => {
  it("builds a stable chat+turn key and ignores blanks", () => {
    assert.equal(generateTurnFlightKey("chat-1", "turn-1"), "chat-1::turn-1")
    assert.equal(generateTurnFlightKey("  ", "turn-1"), null)
    assert.equal(generateTurnFlightKey("chat-1", ""), null)
  })

  it("runs the owner once and sends extra mounts through the follower", async () => {
    resetGenerateTurnFlights()
    let owners = 0
    let followers = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const owner = generateStreamFlights.joinOrRun(
      "chat-1::turn-1",
      async () => {
        owners += 1
        await gate
        return "owned"
      },
      async () => {
        followers += 1
        return "followed"
      },
    )
    const follower = generateStreamFlights.joinOrRun(
      "chat-1::turn-1",
      async () => {
        owners += 1
        return "owned-again"
      },
      async () => {
        followers += 1
        return "followed"
      },
    )

    assert.equal(generateStreamFlights.size(), 1)
    release()
    assert.deepEqual(await Promise.all([owner, follower]), ["owned", "followed"])
    assert.equal(owners, 1)
    assert.equal(followers, 1)
    assert.equal(generateStreamFlights.size(), 0)
  })

  it("keeps addMessage flights independent from the stream registry", async () => {
    resetGenerateTurnFlights()
    await addMessageFlights.run("chat-1::turn-1", async () => "add")
    assert.equal(addMessageFlights.size(), 0)
    assert.equal(generateStreamFlights.size(), 0)
  })
})
