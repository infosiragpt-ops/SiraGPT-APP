import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { debugFlagOn, devError, devLog, devWarn } from "../lib/dev-log"

/**
 * The dev-log helpers are tested against three input axes:
 *
 *   - `process.env.NODE_ENV` (development / production / undefined)
 *   - presence of a `window` (we run under node, so we synthesise
 *     `globalThis.window` to mimic a browser context)
 *   - `localStorage.siragptDebug` value (set / unset / "0" / "1")
 *
 * The tests stub these in `beforeEach` and restore them in
 * `afterEach` so they don't leak into later suites.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_WINDOW = (globalThis as any).window

function setLocalStorage(value: string | null) {
  ;(globalThis as any).window = {
    localStorage: {
      getItem(key: string) {
        if (key !== "siragptDebug") return null
        return value
      },
    },
  }
}

function clearWindow() {
  delete (globalThis as any).window
}

function captureConsole(method: "log" | "warn" | "error") {
  const calls: unknown[][] = []
  const original = (console as any)[method]
  ;(console as any)[method] = (...args: unknown[]) => calls.push(args)
  return {
    calls,
    restore: () => {
      ;(console as any)[method] = original
    },
  }
}

describe("dev-log · debugFlagOn", () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    if (ORIGINAL_WINDOW === undefined) clearWindow()
    else (globalThis as any).window = ORIGINAL_WINDOW
  })

  it("returns true in development regardless of localStorage", () => {
    process.env.NODE_ENV = "development"
    clearWindow()
    assert.equal(debugFlagOn(), true)
  })

  it("returns true in test (anything not 'production')", () => {
    process.env.NODE_ENV = "test"
    clearWindow()
    assert.equal(debugFlagOn(), true)
  })

  it("returns false in production when there is no window (SSR)", () => {
    process.env.NODE_ENV = "production"
    clearWindow()
    assert.equal(debugFlagOn(), false)
  })

  it("returns false in production when localStorage flag is unset", () => {
    process.env.NODE_ENV = "production"
    setLocalStorage(null)
    assert.equal(debugFlagOn(), false)
  })

  it('returns false in production when localStorage flag is "0"', () => {
    process.env.NODE_ENV = "production"
    setLocalStorage("0")
    assert.equal(debugFlagOn(), false)
  })

  it('returns true in production when localStorage flag is "1"', () => {
    process.env.NODE_ENV = "production"
    setLocalStorage("1")
    assert.equal(debugFlagOn(), true)
  })

  it("tolerates a throwing localStorage without crashing", () => {
    process.env.NODE_ENV = "production"
    ;(globalThis as any).window = {
      localStorage: {
        getItem() {
          throw new Error("DOMException: SecurityError")
        },
      },
    }
    assert.equal(debugFlagOn(), false)
  })
})

describe("dev-log · devLog / devWarn / devError", () => {
  let logCapture: ReturnType<typeof captureConsole>
  let warnCapture: ReturnType<typeof captureConsole>
  let errorCapture: ReturnType<typeof captureConsole>

  beforeEach(() => {
    logCapture = captureConsole("log")
    warnCapture = captureConsole("warn")
    errorCapture = captureConsole("error")
  })

  afterEach(() => {
    logCapture.restore()
    warnCapture.restore()
    errorCapture.restore()
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    if (ORIGINAL_WINDOW === undefined) clearWindow()
    else (globalThis as any).window = ORIGINAL_WINDOW
  })

  it("devLog forwards to console.log when the flag is on", () => {
    process.env.NODE_ENV = "development"
    devLog("hello", { ok: true })
    assert.equal(logCapture.calls.length, 1)
    assert.deepEqual(logCapture.calls[0], ["hello", { ok: true }])
  })

  it("devLog is a no-op when the flag is off", () => {
    process.env.NODE_ENV = "production"
    clearWindow()
    devLog("hidden")
    assert.equal(logCapture.calls.length, 0)
  })

  it("devWarn forwards to console.warn when the flag is on", () => {
    process.env.NODE_ENV = "development"
    devWarn("careful")
    assert.equal(warnCapture.calls.length, 1)
    assert.deepEqual(warnCapture.calls[0], ["careful"])
  })

  it("devWarn is a no-op when the flag is off", () => {
    process.env.NODE_ENV = "production"
    clearWindow()
    devWarn("hidden")
    assert.equal(warnCapture.calls.length, 0)
  })

  it("devError ALWAYS forwards to console.error (even in production)", () => {
    process.env.NODE_ENV = "production"
    clearWindow()
    devError("real error", new Error("boom"))
    assert.equal(errorCapture.calls.length, 1)
    assert.equal(errorCapture.calls[0][0], "real error")
    assert.ok(errorCapture.calls[0][1] instanceof Error)
  })
})
