import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { localeForCountry } from "../lib/i18n/locales"
import { countryCodeFromHeaders, pickLocaleFromAcceptLanguage } from "../lib/i18n/locale-resolution"

const SUPPORTED = ["es", "en", "fr", "pt", "de", "ar"] as const

describe("pickLocaleFromAcceptLanguage", () => {
  it("returns undefined for empty input", () => {
    assert.equal(pickLocaleFromAcceptLanguage("", SUPPORTED), undefined)
  })

  it("picks an exact supported language", () => {
    assert.equal(pickLocaleFromAcceptLanguage("es", SUPPORTED), "es")
  })

  it("normalizes region tags to the base locale", () => {
    assert.equal(pickLocaleFromAcceptLanguage("es-BO,es;q=0.9,en;q=0.8", SUPPORTED), "es")
  })

  it("respects q ordering", () => {
    assert.equal(pickLocaleFromAcceptLanguage("fr;q=0.7,en;q=0.9", SUPPORTED), "en")
  })

  it("skips unsupported locales and falls through", () => {
    assert.equal(pickLocaleFromAcceptLanguage("it;q=1,en;q=0.5", SUPPORTED), "en")
  })

  it("ignores malformed q values", () => {
    assert.equal(pickLocaleFromAcceptLanguage("de;q=nope,en;q=0.8", SUPPORTED), "en")
  })

  it("handles wildcard entries by ignoring them", () => {
    assert.equal(pickLocaleFromAcceptLanguage("*,fr;q=0.9", SUPPORTED), "fr")
  })

  it("returns undefined when nothing matches", () => {
    assert.equal(pickLocaleFromAcceptLanguage("it,ja,zh", SUPPORTED), undefined)
  })
})

describe("countryCodeFromHeaders", () => {
  it("reads Vercel country headers", () => {
    assert.equal(countryCodeFromHeaders({ "x-vercel-ip-country": "bo" }), "BO")
  })

  it("reads Cloudflare country headers", () => {
    assert.equal(countryCodeFromHeaders({ "cf-ipcountry": "de" }), "DE")
  })

  it("reads CloudFront country headers", () => {
    assert.equal(countryCodeFromHeaders({ "cloudfront-viewer-country": "fr" }), "FR")
  })

  it("matches headers case-insensitively", () => {
    assert.equal(countryCodeFromHeaders({ "X-Country-Code": "us" }), "US")
  })

  it("returns undefined when no country header exists", () => {
    assert.equal(countryCodeFromHeaders({}), undefined)
  })

  it("ignores country values that are too short (< 2 chars after trim)", () => {
    // ISO 3166 alpha-2 is exactly 2 chars; we reject < 2 as malformed
    // (X-Forwarded-IP-Country sometimes shows up empty or with a single
    // char in proxy bugs).
    assert.equal(countryCodeFromHeaders({ "x-vercel-ip-country": "X" }), undefined)
    assert.equal(countryCodeFromHeaders({ "x-vercel-ip-country": "" }), undefined)
    assert.equal(countryCodeFromHeaders({ "x-vercel-ip-country": "  " }), undefined)
  })

  it("uppercases lowercase country codes from headers", () => {
    assert.equal(countryCodeFromHeaders({ "x-vercel-ip-country": "es" }), "ES")
    assert.equal(countryCodeFromHeaders({ "cf-ipcountry": "mx" }), "MX")
  })

  it("prefers x-vercel-ip-country over later candidates when multiple are set", () => {
    const headers = {
      "x-vercel-ip-country": "US",
      "cf-ipcountry": "MX",
      "x-country": "BR",
    }
    assert.equal(countryCodeFromHeaders(headers), "US")
  })
})

describe("localeForCountry", () => {
  it("maps Bolivia to Spanish", () => {
    assert.equal(localeForCountry("BO"), "es")
  })

  it("maps Brazil to Portuguese", () => {
    assert.equal(localeForCountry("BR"), "pt")
  })

  it("maps the United States to English", () => {
    assert.equal(localeForCountry("US"), "en")
  })

  it("maps Germany to German", () => {
    assert.equal(localeForCountry("DE"), "de")
  })

  it("maps Saudi Arabia to Arabic", () => {
    assert.equal(localeForCountry("SA"), "ar")
  })

  it("falls back to default locale for unknown countries", () => {
    assert.equal(localeForCountry("XX"), "es")
  })

  it("falls back to default locale for missing countries", () => {
    assert.equal(localeForCountry(undefined), "es")
  })
})
