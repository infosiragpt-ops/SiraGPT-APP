import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  decideEmptyGenerateStreamAction,
  shouldPollPersistedTurnOnStreamClose,
} from "../lib/generate-stream-complete"
import { shouldRecoverPersistedGenerate } from "../lib/recover-persisted-turn"

describe("generate stream close recovers a persisted turn immediately", () => {
  it("treats contentless [DONE] as complete, not a 5× reconnect", () => {
    assert.equal(
      decideEmptyGenerateStreamAction({
        seenDone: true,
        hasDeliveredAnyContent: false,
        persistedAssistant: null,
        hasResumeCursor: true,
      }),
      "close",
    )
    assert.equal(
      decideEmptyGenerateStreamAction({
        seenDone: true,
        hasDeliveredAnyContent: false,
        persistedAssistant: true,
      }),
      "recover",
    )
  })

  it("recovers when the server already persisted and the client painted nothing", () => {
    assert.equal(
      decideEmptyGenerateStreamAction({
        seenDone: false,
        hasDeliveredAnyContent: false,
        persistedAssistant: true,
        hasResumeCursor: true,
      }),
      "recover",
    )
    assert.equal(
      shouldPollPersistedTurnOnStreamClose({
        deliveredContent: "",
        seenDone: true,
        streamFailed: false,
      }),
      true,
    )
    assert.equal(
      shouldPollPersistedTurnOnStreamClose({
        deliveredContent: "Hola, Luis.",
        seenDone: true,
        streamFailed: false,
      }),
      false,
    )
  })

  it("keeps CSRF reconnect and cursor resume when persist is not ready", () => {
    assert.equal(
      decideEmptyGenerateStreamAction({
        seenDone: false,
        hasDeliveredAnyContent: false,
        persistedAssistant: false,
        hasResumeCursor: true,
      }),
      "retry",
    )
    assert.equal(
      decideEmptyGenerateStreamAction({
        seenDone: false,
        hasDeliveredAnyContent: false,
        persistedAssistant: null,
        hasResumeCursor: false,
      }),
      "retry",
    )
  })

  it("does not recover a fail-closed 503 / connection_unavailable", () => {
    assert.equal(
      shouldRecoverPersistedGenerate({ status: 503, code: "connection_unavailable" }),
      false,
    )
    assert.equal(
      shouldPollPersistedTurnOnStreamClose({
        deliveredContent: "",
        streamFailed: true,
      }),
      false,
    )
  })
})
