import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  HSTS_HEADER_VALUE,
  hstsHeaderValueFor,
  insecureCanonicalRedirectTarget,
  visitorScheme,
} from "../server/transport-security"

const env = {} as NodeJS.ProcessEnv
const headers = (values: Record<string, string>) => new Headers(values)

describe("transport security (canonical host stays on https)", () => {
  it("redirects a Cloudflare http visitor on siragpt.com to https, keeping path and query", () => {
    const target = insecureCanonicalRedirectTarget(
      {
        method: "GET",
        headers: headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"http"}' }),
        url: "http://siragpt.com/agentes/abc?x=1&y=2",
      },
      env,
    )
    assert.equal(target, "https://siragpt.com/agentes/abc?x=1&y=2")
  })

  it("uses the forwarded host and strips the port", () => {
    const target = insecureCanonicalRedirectTarget(
      {
        method: "HEAD",
        headers: headers({
          host: "iliagpt-origin:80",
          "x-forwarded-host": "www.siragpt.com",
          "cf-visitor": '{"scheme":"http"}',
        }),
        url: "http://iliagpt-origin/",
      },
      env,
    )
    assert.equal(target, "https://www.siragpt.com/")
  })

  it("leaves https visitors, foreign hosts, non-GET and non-Cloudflare requests alone", () => {
    const base = { method: "GET", url: "http://siragpt.com/" }
    assert.equal(
      insecureCanonicalRedirectTarget({ ...base, headers: headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"https"}' }) }, env),
      null,
    )
    assert.equal(
      insecureCanonicalRedirectTarget({ ...base, headers: headers({ host: "preview.example.com", "cf-visitor": '{"scheme":"http"}' }) }, env),
      null,
    )
    assert.equal(
      insecureCanonicalRedirectTarget({ ...base, method: "POST", headers: headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"http"}' }) }, env),
      null,
    )
    assert.equal(insecureCanonicalRedirectTarget({ ...base, headers: headers({ host: "siragpt.com" }) }, env), null)
    assert.equal(insecureCanonicalRedirectTarget({ ...base, headers: headers({ host: "localhost:3000" }) }, env), null)
  })

  it("trusts CF-Visitor only — the origin proxy rewrites X-Forwarded-Proto", () => {
    // Behind the tunnel every request reaches Next with X-Forwarded-Proto: http,
    // including real https visitors. That header must never trigger a redirect.
    assert.equal(
      insecureCanonicalRedirectTarget(
        { method: "GET", url: "http://siragpt.com/", headers: headers({ host: "siragpt.com", "x-forwarded-proto": "http" }) },
        env,
      ),
      null,
    )
    assert.equal(visitorScheme(headers({ "cf-visitor": "not json" })), null)
    assert.equal(visitorScheme(headers({ "cf-visitor": '{"scheme":"HTTPS"}' })), "https")
  })

  it("emits HSTS only for https responses on the canonical host", () => {
    assert.equal(hstsHeaderValueFor(headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"https"}' }), env), HSTS_HEADER_VALUE)
    assert.equal(hstsHeaderValueFor(headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"http"}' }), env), null)
    assert.equal(hstsHeaderValueFor(headers({ host: "siragpt.com" }), env), null)
    assert.equal(hstsHeaderValueFor(headers({ host: "other.example.com", "cf-visitor": '{"scheme":"https"}' }), env), null)
  })

  it("honours SIRAGPT_CANONICAL_HOSTS", () => {
    const custom = { SIRAGPT_CANONICAL_HOSTS: "app.example.com, Www.Example.com" } as NodeJS.ProcessEnv
    assert.equal(
      insecureCanonicalRedirectTarget(
        { method: "GET", url: "http://app.example.com/x", headers: headers({ host: "app.example.com", "cf-visitor": '{"scheme":"http"}' }) },
        custom,
      ),
      "https://app.example.com/x",
    )
    assert.equal(
      insecureCanonicalRedirectTarget(
        { method: "GET", url: "http://siragpt.com/x", headers: headers({ host: "siragpt.com", "cf-visitor": '{"scheme":"http"}' }) },
        custom,
      ),
      null,
    )
  })
})
