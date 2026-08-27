import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { GPT_STORE_APPS } from "../lib/gpts-apps-catalog"
import {
  apexLogoDomain,
  generatedBrandTileUrl,
  gptStoreAppLogoSources,
  gptStoreAppLogoUrl,
  isLikelyInventedDomain,
  officialCatalogLogoSources,
  officialCatalogLogoUrl,
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
    || url.startsWith("data:image/svg+xml")
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
    assert.equal(officialMarkPath({ id: "onedrive", domain: "onedrive.live.com" }), "/conexiones-logos/onedrive.svg")
    assert.equal(officialMarkPath({ id: "onedrive", domain: "" }), "/conexiones-logos/onedrive.svg")
    assert.equal(officialMarkPath({ id: "google-drive", domain: "drive.google.com" }), "/conexiones-logos/googledrive.svg")
    assert.equal(officialMarkPath({ id: "google-drive", domain: "" }), "/conexiones-logos/googledrive.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "onedrive", domain: "onedrive.live.com", name: "OneDrive" }), "/conexiones-logos/onedrive.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "google-drive", domain: "drive.google.com", name: "Google Drive" }), "/conexiones-logos/googledrive.svg")
  })

  it("does not default to the blurry Google sz=128 favicon", () => {
    for (const app of [linkedin, indeed, gmail, google, obscure]) {
      const primary = gptStoreAppLogoUrl(app)
      const sources = gptStoreAppLogoSources(app)
      assert.ok(isProfessionalLogoUrl(primary), `primary for ${app.id} should be professional, got ${primary}`)
      assert.equal(isGoogleFavicon128(primary), false)
      assert.ok(sources.length >= 1, `${app.id} should expose a logo src`)
      assert.ok(sources.every((url) => !isGoogleFavicon128(url)))
      assert.ok(sources.every(isProfessionalLogoUrl))
    }
  })

  it("uses a generated SVG — not Clearbit or a favicon — when no official mark exists", () => {
    const sources = gptStoreAppLogoSources({ ...obscure, name: "Steer Astro", category: "Astrología" })
    assert.equal(sources[0], generatedBrandTileUrl({ ...obscure, name: "Steer Astro", category: "Astrología" }))
    assert.match(sources[0], /^data:image\/svg\+xml/)
    assert.equal(sources.some((url) => url.includes("clearbit") || url.includes("s2/favicons")), false)
  })

  it("uses a generated local SVG for invented GPT-store domains so tiles are never blank", () => {
    const invented = {
      id: "astro-scope-destiny-matrix",
      domain: "astro-scope-destiny-matrix.com",
      name: "Astro Scope Destiny Matrix",
    }
    assert.equal(isLikelyInventedDomain(invented.domain), true)
    assert.equal(isLikelyInventedDomain("idealista.com"), false)
    assert.equal(gptStoreAppLogoUrl({ id: "idealista", domain: "idealista.com" }), "/conexiones-logos/idealista.svg")
    const sources = gptStoreAppLogoSources(invented)
    assert.equal(sources[0], generatedBrandTileUrl(invented))
    assert.match(sources[0], /^data:image\/svg\+xml/)
    assert.match(decodeURIComponent(sources[0]), /<svg /)
    assert.match(decodeURIComponent(sources[0]), />AS</)
    assert.equal(sources.some((url) => url.includes("clearbit") || url.includes("duckduckgo")), false)
  })

  it("maps well-known brand domains and regional Amazon/Google apexes", () => {
    assert.equal(gptStoreAppLogoUrl({ id: "x", domain: "twitter.com" }), "/conexiones-logos/x.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "shop", domain: "amazon.es" }), "/conexiones-logos/amazon.svg")
    assert.equal(gptStoreAppLogoUrl({ id: "maps", domain: "www.google.com.mx" }), "/conexiones-logos/google.svg")
    assert.equal(apexLogoDomain("immobilier.lefigaro.fr"), "lefigaro.fr")
    assert.equal(apexLogoDomain("carsguide.com.au"), "carsguide.com.au")
  })

  it("keeps the local SVG files for catalog and requested brands", () => {
    for (const file of ["linkedin.svg", "indeed.svg", "gmail.svg", "google.svg", "etsy.svg", "idealista.svg", "redfin.svg", "autoscout24.svg", "autotrader.svg", "onedrive.svg", "googledrive.svg"]) {
      assert.ok(fs.existsSync(path.join(logosDir, file)), `missing ${file}`)
    }
  })

  it("prefers an explicit catalog logo/icon and keeps official-only sources separate", () => {
    const withLogo = { id: "custom", domain: "example.com", logo: "/owned/custom.svg" }
    assert.equal(officialCatalogLogoUrl(withLogo), "/owned/custom.svg")
    assert.deepEqual(officialCatalogLogoSources(withLogo), ["/owned/custom.svg"])
    assert.equal(gptStoreAppLogoSources(withLogo)[0], "/owned/custom.svg")
    assert.equal(officialCatalogLogoUrl({ id: "github", domain: "github.com" }), "/conexiones-logos/github.svg")
    assert.equal(officialCatalogLogoUrl({ id: "x", domain: "x.com" }), "/conexiones-logos/x.svg")
    assert.equal(officialCatalogLogoUrl({ id: "facebook", domain: "facebook.com" }), "/conexiones-logos/facebook.svg")
    assert.equal(officialCatalogLogoUrl({
      id: "astro-scope-destiny-matrix",
      domain: "astro-scope-destiny-matrix.com",
    }), null)
  })

  it("gives every catalog app a professional primary URL and a fallback src", () => {
    assert.ok(GPT_STORE_APPS.length >= 300)
    for (const app of GPT_STORE_APPS) {
      const sources = gptStoreAppLogoSources(app)
      const primary = gptStoreAppLogoUrl(app)
      assert.ok(isProfessionalLogoUrl(primary), `${app.id} primary ${primary}`)
      assert.ok(sources.every((url) => !isGoogleFavicon128(url)))
      // Invented GPT-store hosts only get the generated SVG (it never 404s).
      // Real or official-mark apps keep a second src for AppLogo onError.
      if (officialMarkPath(app)) {
        assert.ok(sources.length >= 2, `${app.id} needs a fallback src`)
        assert.match(sources[0], /^\/conexiones-logos\//)
      } else {
        assert.match(sources[0], /^data:image\/svg\+xml/)
      }
    }
  })
})
