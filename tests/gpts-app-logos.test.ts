import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { GPT_STORE_APPS } from "../lib/gpts-apps-catalog"
import {
  apexLogoDomain,
  duckduckgoLogoUrl,
  gptStoreAppLogoSources,
  gptStoreAppLogoUrl,
  officialMarkPath,
} from "../lib/gpts-app-logos"

const logosDir = path.join(process.cwd(), "public", "conexiones-logos")

const linkedin = { id: "linkedin", domain: "linkedin.com" }
const indeed = { id: "indeed", domain: "indeed.com" }
const gmail = { id: "gmail", domain: "gmail.com" }
const google = { id: "google", domain: "google.com" }
const obscure = { id: "obscure-demo", domain: "steerastro.com" }

function isGoogleFavicon128(url: string) {
  return /google\.com\/s2\/favicons\?sz=128/.test(url)
}

function isProfessionalLogoUrl(url: string) {
  return (
    url.startsWith("/conexiones-logos/")
    || url.includes("logo.clearbit.com/")
    || url.includes("icons.duckduckgo.com/ip3/")
  )
}

describe("gptStoreAppLogoUrl · professional resolver", () => {
  it("returns a local mark for LinkedIn, Indeed, Gmail and Google", () => {
    assert.equal(gptStoreAppLogoUrl(linkedin), "/conexiones-logos/linkedin.svg")
    assert.equal(gptStoreAppLogoUrl(indeed), "/conexiones-logos/indeed.svg")
    assert.equal(gptStoreAppLogoUrl(gmail), "/conexiones-logos/gmail.svg")
    assert.equal(gptStoreAppLogoUrl(google), "/conexiones-logos/google.svg")
    assert.equal(officialMarkPath(gmail), "/conexiones-logos/gmail.svg")
    assert.equal(officialMarkPath({ id: "calendar", domain: "calendar.google.com" }), "/conexiones-logos/googlecalendar.svg")
    assert.equal(officialMarkPath({ id: "drive", domain: "drive.google.com" }), "/conexiones-logos/googledrive.svg")
  })

  it("does not default to the blurry Google sz=128 favicon", () => {
    for (const app of [linkedin, indeed, gmail, google, obscure]) {
      const primary = gptStoreAppLogoUrl(app)
      const sources = gptStoreAppLogoSources(app)
      assert.ok(isProfessionalLogoUrl(primary), `primary for ${app.id} should be professional, got ${primary}`)
      assert.equal(isGoogleFavicon128(primary), false)
      assert.ok(sources.length >= 2, `${app.id} should expose a fallback src`)
      assert.ok(sources.every((url) => !isGoogleFavicon128(url)))
      assert.ok(sources.every(isProfessionalLogoUrl))
    }
  })

  it("falls back to Clearbit then DuckDuckGo ip3 when no local mark exists", () => {
    const sources = gptStoreAppLogoSources(obscure)
    assert.equal(sources[0], "https://logo.clearbit.com/steerastro.com")
    assert.equal(sources[1], duckduckgoLogoUrl("steerastro.com"))
    assert.match(sources[1], /icons\.duckduckgo\.com\/ip3\/steerastro\.com\.ico/)
  })

  it("maps well-known brand domains and regional Amazon/Google apexes", () => {
    assert.equal(gptStoreAppLogoUrl({ id: "x", domain: "twitter.com" }), "/conexiones-logos/x.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "shop", domain: "amazon.es" }), "/conexiones-logos/amazon.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "maps", domain: "www.google.com.mx" }), "/conexiones-logos/google.svg")
    assert.equal(apexLogoDomain("immobilier.lefigaro.fr"), "lefigaro.fr")
    assert.equal(apexLogoDomain("carsguide.com.au"), "carsguide.com.au")
  })

  it("keeps the local SVG files for catalog and requested brands", () => {
    for (const file of ["linkedin.svg", "indeed.svg", "gmail.svg", "google.svg", "etsy.svg"]) {
      assert.ok(fs.existsSync(path.join(logosDir, file)), `missing ${file}`)
    }
  })

  it("gives every catalog app a professional primary URL and a fallback src", () => {
    assert.ok(GPT_STORE_APPS.length >= 300)
    for (const app of GPT_STORE_APPS) {
      const sources = gptStoreAppLogoSources(app)
      assert.ok(sources.length >= 2, `${app.id} needs a fallback src`)
      assert.ok(isProfessionalLogoUrl(gptStoreAppLogoUrl(app)), `${app.id} primary ${gptStoreAppLogoUrl(app)}`)
      assert.ok(sources.every((url) => !isGoogleFavicon128(url)))
    }
  })
})
