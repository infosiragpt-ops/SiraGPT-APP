import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseDeepLink, routeToHref } from "../lib/deep-links"

describe("parseDeepLink — custom scheme", () => {
  it("maps siragpt://chat/:id to /chat/:id", () => {
    const r = parseDeepLink("siragpt://chat/abc123")
    assert.ok(r)
    assert.equal(r!.path, "/chat/abc123")
    assert.equal(r!.query, "")
  })

  it("maps siragpt://artifact/:id to /artifact/:id", () => {
    const r = parseDeepLink("siragpt://artifact/xyz")
    assert.ok(r)
    assert.equal(r!.path, "/artifact/xyz")
  })

  it("treats artifacts (plural) as an alias", () => {
    const r = parseDeepLink("siragpt://artifacts/list-1")
    assert.ok(r)
    assert.equal(r!.path, "/artifact/list-1")
  })

  it("maps siragpt://document/:id to /documents/:id", () => {
    const r = parseDeepLink("siragpt://document/doc-9")
    assert.ok(r)
    assert.equal(r!.path, "/documents/doc-9")
  })

  it("maps siragpt://settings to /settings", () => {
    const r = parseDeepLink("siragpt://settings")
    assert.ok(r)
    assert.equal(r!.path, "/settings")
  })

  it("preserves query string", () => {
    const r = parseDeepLink("siragpt://chat/abc?ref=push&from=ios")
    assert.ok(r)
    assert.equal(r!.path, "/chat/abc")
    assert.equal(r!.query, "ref=push&from=ios")
  })

  it("preserves hash fragment", () => {
    const r = parseDeepLink("siragpt://chat/abc#msg-42")
    assert.ok(r)
    assert.equal(r!.hash, "msg-42")
  })

  it("supports escape hatch via ?path=", () => {
    const r = parseDeepLink("siragpt://?path=/custom/route")
    assert.ok(r)
    assert.equal(r!.path, "/custom/route")
    // path param should not leak into the query
    assert.equal(r!.query.includes("path="), false)
  })

  it("returns null for unknown hosts", () => {
    assert.equal(parseDeepLink("siragpt://totally-unknown/foo"), null)
  })
})

describe("parseDeepLink — universal links", () => {
  it("maps https://siragpt.com/chat/abc to /chat/abc", () => {
    const r = parseDeepLink("https://siragpt.com/chat/abc")
    assert.ok(r)
    assert.equal(r!.path, "/chat/abc")
  })

  it("accepts www subdomain", () => {
    const r = parseDeepLink("https://www.siragpt.com/documents/9?x=1")
    assert.ok(r)
    assert.equal(r!.path, "/documents/9")
    assert.equal(r!.query, "x=1")
  })

  it("rejects external hosts", () => {
    assert.equal(parseDeepLink("https://example.com/chat/abc"), null)
  })
})

describe("parseDeepLink — guards", () => {
  it("returns null for non-strings", () => {
    // @ts-expect-error intentional bad input
    assert.equal(parseDeepLink(null), null)
    // @ts-expect-error intentional bad input
    assert.equal(parseDeepLink(undefined), null)
  })

  it("returns null for empty strings", () => {
    assert.equal(parseDeepLink(""), null)
  })

  it("returns null for malformed URLs", () => {
    assert.equal(parseDeepLink("not a url"), null)
  })
})

describe("routeToHref", () => {
  it("composes path + query + hash", () => {
    assert.equal(
      routeToHref({ path: "/chat/abc", query: "ref=push", hash: "msg-1", raw: "" }),
      "/chat/abc?ref=push#msg-1",
    )
  })

  it("omits empty query and hash", () => {
    assert.equal(routeToHref({ path: "/chat", query: "", raw: "" }), "/chat")
  })
})
