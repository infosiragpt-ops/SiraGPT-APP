import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { share, canShare } from "../lib/native/share"
import { writeText, readText } from "../lib/native/clipboard"

type Globals = Record<string, unknown>

function reset() {
  const g = globalThis as Globals
  delete g.window
  delete g.navigator
  delete g.document
  delete g.Capacitor
}

describe("lib/native/share", () => {
  beforeEach(reset)
  afterEach(reset)

  it("falls back to clipboard when no share is available", async () => {
    let copied = ""
    const g = globalThis as Globals
    g.navigator = {
      clipboard: {
        writeText: async (v: string) => {
          copied = v
        },
      },
    }
    const r = await share({ title: "t", url: "https://x" })
    assert.equal(r.ok, true)
    assert.equal(r.via, "clipboard")
    assert.match(copied, /https:\/\/x/)
  })

  it("uses navigator.share when available", async () => {
    let shared: unknown = null
    const g = globalThis as Globals
    g.navigator = {
      share: async (data: unknown) => {
        shared = data
      },
    }
    const r = await share({ title: "hello", url: "https://y" })
    assert.equal(r.ok, true)
    assert.equal(r.via, "web-share")
    assert.deepEqual(shared, { title: "hello", text: undefined, url: "https://y" })
  })

  it("canShare returns false when nothing is available", async () => {
    assert.equal(await canShare(), false)
  })

  it("canShare returns true when clipboard exists", async () => {
    const g = globalThis as Globals
    g.navigator = { clipboard: { writeText: async () => {} } }
    assert.equal(await canShare(), true)
  })
})

describe("lib/native/clipboard", () => {
  beforeEach(reset)
  afterEach(reset)

  it("writes via navigator.clipboard when available", async () => {
    let copied = ""
    const g = globalThis as Globals
    g.navigator = {
      clipboard: {
        writeText: async (v: string) => {
          copied = v
        },
      },
    }
    const r = await writeText("hi")
    assert.equal(r.ok, true)
    assert.equal(r.via, "web")
    assert.equal(copied, "hi")
  })

  it("falls back without console noise when clipboard permission is denied", async () => {
    const g = globalThis as Globals
    g.navigator = {
      clipboard: {
        writeText: async () => {
          const err = new Error("Failed to execute 'writeText' on 'Clipboard': Write permission denied.")
          err.name = "NotAllowedError"
          throw err
        },
      },
    }
    const originalWarn = console.warn
    const warnings: unknown[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const r = await writeText("hi")
      assert.equal(r.ok, false)
      assert.equal(r.via, "noop")
      assert.equal(warnings.length, 0)
    } finally {
      console.warn = originalWarn
    }
  })

  it("reads via navigator.clipboard when available", async () => {
    const g = globalThis as Globals
    g.navigator = { clipboard: { readText: async () => "stored" } }
    const r = await readText()
    assert.equal(r.ok, true)
    assert.equal(r.value, "stored")
  })

  it("returns noop result when no clipboard mechanism exists", async () => {
    const r = await readText()
    assert.equal(r.ok, false)
    assert.equal(r.via, "noop")
  })
})
