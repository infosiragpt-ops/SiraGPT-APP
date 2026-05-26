import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sanitizeFetchHeaders, sanitizeFetchInit } from "../lib/fetch-sanitize"

/**
 * fetch-sanitize is the last line of defence between caller-supplied
 * headers/init and the global fetch — anything weird (forbidden CR/LF,
 * Symbol keys, malformed Headers instances) should be stripped here so
 * the request never hits the network with a forged header.
 */

describe("sanitizeFetchHeaders · input shapes", () => {
  it("returns undefined for null / undefined input", () => {
    assert.equal(sanitizeFetchHeaders(null), undefined)
    assert.equal(sanitizeFetchHeaders(undefined), undefined)
  })

  it("returns a plain object for a Headers instance", () => {
    const headers = new Headers({ Authorization: "Bearer x", "X-Trace-Id": "abc" })
    const out = sanitizeFetchHeaders(headers)
    assert.equal(typeof out, "object")
    // Headers normalises to lowercase keys.
    assert.equal(out!.authorization, "Bearer x")
    assert.equal(out!["x-trace-id"], "abc")
  })

  it("accepts an array of [name, value] tuples", () => {
    const out = sanitizeFetchHeaders([
      ["Content-Type", "application/json"],
      ["X-Req-Id", "42"],
    ])
    assert.equal(out!["Content-Type"], "application/json")
    assert.equal(out!["X-Req-Id"], "42")
  })

  it("accepts a plain object", () => {
    const out = sanitizeFetchHeaders({ "X-Foo": "bar", Accept: "*/*" })
    assert.equal(out!["X-Foo"], "bar")
    assert.equal(out!.Accept, "*/*")
  })
})

describe("sanitizeFetchHeaders · rejects forbidden chars / shapes", () => {
  it("drops a header whose value contains CR or LF (header-injection guard)", () => {
    const out = sanitizeFetchHeaders({
      "X-Safe": "ok",
      "X-Injected": "value\r\nEvil-Header: pwn",
    })
    assert.equal(out!["X-Safe"], "ok")
    assert.equal(Object.prototype.hasOwnProperty.call(out!, "X-Injected"), false)
  })

  it("drops a header whose name contains a NUL byte", () => {
    const badKey = `X-${String.fromCharCode(0x00)}-Bad`
    const out = sanitizeFetchHeaders({ [badKey]: "v", "X-Good": "v2" })
    assert.equal(out!["X-Good"], "v2")
    assert.equal(Object.prototype.hasOwnProperty.call(out!, badKey), false)
  })

  it("ignores Symbol-keyed entries", () => {
    const sym = Symbol("X-Symbol")
    const headers = { "X-Real": "1", [sym]: "2" } as any
    const out = sanitizeFetchHeaders(headers)
    assert.equal(out!["X-Real"], "1")
    assert.equal(Object.getOwnPropertySymbols(out!).length, 0)
  })

  it("ignores null / undefined values", () => {
    const out = sanitizeFetchHeaders({ "X-Real": "v", "X-Empty": null, "X-Missing": undefined } as any)
    assert.equal(out!["X-Real"], "v")
    assert.equal(Object.prototype.hasOwnProperty.call(out!, "X-Empty"), false)
    assert.equal(Object.prototype.hasOwnProperty.call(out!, "X-Missing"), false)
  })

  it("coerces non-string values to strings before validation", () => {
    const out = sanitizeFetchHeaders({ "X-Number": 42, "X-Bool": true } as any)
    assert.equal(out!["X-Number"], "42")
    assert.equal(out!["X-Bool"], "true")
  })
})

describe("sanitizeFetchInit", () => {
  it("returns {} for nullish input", () => {
    assert.deepEqual(sanitizeFetchInit(null), {})
    assert.deepEqual(sanitizeFetchInit(undefined), {})
  })

  it("returns {} for an array (caller passed the wrong shape)", () => {
    assert.deepEqual(sanitizeFetchInit([] as any), {})
  })

  it("strips Symbol-keyed properties (SDK metadata) from init", () => {
    const sym = Symbol("internal-tag")
    const init: any = { method: "POST", body: "x", [sym]: "leak-me" }
    const out = sanitizeFetchInit(init) as any
    assert.equal(out.method, "POST")
    assert.equal(out.body, "x")
    assert.equal(Object.getOwnPropertySymbols(out).length, 0)
  })

  it("sanitises nested headers", () => {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "X-Good": "yes",
        "X-Bad": "value\r\nInjected: true",
      },
    }
    const out = sanitizeFetchInit(init)
    const headers = out.headers as Record<string, string>
    assert.equal(headers["X-Good"], "yes")
    assert.equal(Object.prototype.hasOwnProperty.call(headers, "X-Bad"), false)
  })

  it("preserves other init fields verbatim (method, body, signal, credentials)", () => {
    const controller = new AbortController()
    const init: RequestInit = {
      method: "PATCH",
      body: JSON.stringify({ ok: true }),
      credentials: "include",
      signal: controller.signal,
    }
    const out = sanitizeFetchInit(init)
    assert.equal(out.method, "PATCH")
    assert.equal(out.body, '{"ok":true}')
    assert.equal(out.credentials, "include")
    assert.equal(out.signal, controller.signal)
  })
})
