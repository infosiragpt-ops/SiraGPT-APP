import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const catalogPath = path.join(process.cwd(), "lib", "gpts-apps-catalog.ts")
const pagePath = path.join(process.cwd(), "app", "gpts", "page.tsx")
const sectionPath = path.join(process.cwd(), "components", "gpts", "gpts-apps-section.tsx")

const catalog = fs.readFileSync(catalogPath, "utf8")
const page = fs.readFileSync(pagePath, "utf8")
const section = fs.readFileSync(sectionPath, "utf8")

describe("GPTs Apps catalog", () => {
  it("keeps unique connectable apps and drops synthetic drafts", () => {
    const ids = [...catalog.matchAll(/id: "([^"]+)"/g)].map((match) => match[1])
    assert.ok(ids.length >= 300, `expected at least 300 apps, got ${ids.length}`)
    assert.equal(new Set(ids).size, ids.length)
    assert.doesNotMatch(catalog, /dashapi-publish-version/)
    assert.match(catalog, /id: "indeed"/)
    assert.match(catalog, /id: "linkedin"/)
    assert.match(catalog, /id: "gumtree"/)
    assert.match(catalog, /domain: "indeed.com"/)
    assert.match(catalog, /domain: "linkedin.com"/)
    assert.match(catalog, /gptStoreAppLogoUrl/)
  })

  it("renders Apps at the foot of /gpts with a connect action", () => {
    assert.match(page, /from "@\/components\/gpts\/gpts-apps-section"/)
    assert.match(page, /<GptsAppsSection searchQuery=\{debouncedSearchQuery\} \/>/)
    assert.match(page, /placeholder="Buscar GPT y Apps"/)
    assert.match(section, /data-testid="gpts-apps-section"/)
    assert.match(section, />Apps</)
    assert.match(section, /Conectar/)
    assert.match(section, /settings\.apps\[id\]\?\.connected === true/)
    assert.match(section, /gptStoreAppLogoUrl/)
    assert.match(section, /alt=\{\`\$\{app\.name\} logo\`\}/)
  })

  it("opens the full catalog from the sidebar Apps tab", () => {
    const conexiones = fs.readFileSync(path.join(process.cwd(), "app", "conexiones", "page.tsx"), "utf8")
    assert.match(conexiones, /data-testid="connect-apps-page"/)
    assert.match(conexiones, /showAll/)
    assert.match(conexiones, /hideHeading/)
  })
})
