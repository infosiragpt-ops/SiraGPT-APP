import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { awaitCancellableChatStep } from "../lib/chat/turn-cancellation"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

for (const preparation of ["delete", "edit"] as const) {
  describe(`${preparation} regeneration Stop fence`, () => {
    it("does not start generation when Stop arrives during the preparation await", async () => {
      const controller = new AbortController()
      const slowPreparation = deferred<void>()
      let generateCalls = 0

      const turn = (async () => {
        await awaitCancellableChatStep({
          signal: controller.signal,
          run: () => slowPreparation.promise,
        })
        generateCalls += 1
      })()

      controller.abort()
      slowPreparation.resolve()

      await assert.rejects(turn, (error: any) => error?.name === "AbortError")
      assert.equal(generateCalls, 0)
    })
  })
}
