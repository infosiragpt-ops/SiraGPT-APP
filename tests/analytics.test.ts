import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { identify, reset, track } from "../lib/analytics"

/**
 * analytics is a thin façade over posthog-js. The contract:
 *
 *   - When posthog-js is not installed (or not yet __loaded), every
 *     export is a silent no-op. NEVER throw.
 *   - When it is installed, calls forward verbatim.
 *   - If the SDK throws, we swallow — analytics must not break the chat.
 *
 * We install a minimal posthog stub on globalThis.window before each
 * test that needs it and clean up afterwards.
 */

type Captured = { event: string; props?: any }

function setLoadedPosthog() {
  const captures: Captured[] = []
  const idents: { id: string; traits?: any }[] = []
  let resets = 0
  ;(globalThis as any).window = {
    posthog: {
      __loaded: true,
      capture: (event: string, props?: any) => {
        captures.push({ event, props })
      },
      identify: (id: string, traits?: any) => {
        idents.push({ id, traits })
      },
      reset: () => {
        resets++
      },
    },
  }
  return {
    captures,
    idents,
    get resets() {
      return resets
    },
  }
}

function setUnloadedPosthog() {
  ;(globalThis as any).window = {
    posthog: {
      __loaded: false,
      capture: () => {
        throw new Error("must not be called pre-load")
      },
      identify: () => {
        throw new Error("must not be called pre-load")
      },
      reset: () => {
        throw new Error("must not be called pre-load")
      },
    },
  }
}

function setThrowingPosthog() {
  ;(globalThis as any).window = {
    posthog: {
      __loaded: true,
      capture: () => {
        throw new Error("SDK boom")
      },
      identify: () => {
        throw new Error("SDK boom")
      },
      reset: () => {
        throw new Error("SDK boom")
      },
    },
  }
}

function clearWindow() {
  delete (globalThis as any).window
}

describe("analytics · SSR / SDK-absent safety", () => {
  afterEach(clearWindow)

  it("track is a no-op when window is undefined", () => {
    clearWindow()
    assert.doesNotThrow(() => track("chat.message_sent", { has_text: true }))
  })

  it("identify / reset are no-ops when window is undefined", () => {
    clearWindow()
    assert.doesNotThrow(() => identify("u1"))
    assert.doesNotThrow(() => reset())
  })

  it("track is a no-op when posthog has not yet __loaded", () => {
    setUnloadedPosthog()
    // capture would throw if it were called.
    assert.doesNotThrow(() => track("chat.message_sent"))
  })
})

describe("analytics · happy-path forwarding", () => {
  let posthog: ReturnType<typeof setLoadedPosthog>

  beforeEach(() => {
    posthog = setLoadedPosthog()
  })

  afterEach(clearWindow)

  it("track forwards the event name and properties verbatim", () => {
    track("chat.message_sent", { text_length: 5, has_text: true })
    assert.equal(posthog.captures.length, 1)
    assert.equal(posthog.captures[0].event, "chat.message_sent")
    assert.deepEqual(posthog.captures[0].props, { text_length: 5, has_text: true })
  })

  it("track works without a properties object", () => {
    track("model.selected")
    assert.equal(posthog.captures.length, 1)
    assert.equal(posthog.captures[0].event, "model.selected")
    assert.equal(posthog.captures[0].props, undefined)
  })

  it("identify forwards id + traits", () => {
    identify("u1", { plan: "pro" })
    assert.equal(posthog.idents.length, 1)
    assert.equal(posthog.idents[0].id, "u1")
    assert.deepEqual(posthog.idents[0].traits, { plan: "pro" })
  })

  it("identify does NOT call the SDK when id is empty", () => {
    identify("")
    assert.equal(posthog.idents.length, 0)
  })

  it("reset calls posthog.reset", () => {
    reset()
    assert.equal(posthog.resets, 1)
  })
})

describe("analytics · failure isolation", () => {
  beforeEach(setThrowingPosthog)
  afterEach(clearWindow)

  it("track swallows a thrown SDK error", () => {
    assert.doesNotThrow(() => track("chat.message_sent"))
  })

  it("identify swallows a thrown SDK error", () => {
    assert.doesNotThrow(() => identify("u1", { plan: "free" }))
  })

  it("reset swallows a thrown SDK error", () => {
    assert.doesNotThrow(() => reset())
  })
})
