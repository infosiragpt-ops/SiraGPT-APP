import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const catalogPath = path.join(process.cwd(), "lib", "gpts-apps-catalog.ts")
const pagePath = path.join(process.cwd(), "app", "gpts", "page.tsx")
const conexionesPath = path.join(process.cwd(), "app", "conexiones", "page.tsx")
const sectionPath = path.join(process.cwd(), "components", "gpts", "gpts-apps-section.tsx")

const catalog = fs.readFileSync(catalogPath, "utf8")
const page = fs.readFileSync(pagePath, "utf8")
const conexiones = fs.readFileSync(conexionesPath, "utf8")
const section = fs.readFileSync(sectionPath, "utf8")

describe("GPTs Apps catalog", () => {
  it("keeps unique connectable apps and drops synthetic drafts", () => {
    const ids = [...catalog.matchAll(/id: "([^"]+)"/g)].map((match) => match[1])
    assert.ok(ids.length >= 300, `expected at least 300 apps, got ${ids.length}`)
    assert.equal(new Set(ids).size, ids.length)
    assert.doesNotMatch(catalog, /dashapi-publish-version/)
    assert.match(catalog, /id: "indeed"/)
    assert.match(catalog, /id: "linkedin"/)
    assert.match(catalog, /id: "github"/)
    assert.match(catalog, /id: "x"/)
    assert.match(catalog, /id: "facebook"/)
    assert.match(catalog, /id: "gumtree"/)
    assert.match(catalog, /domain: "indeed.com"/)
    assert.match(catalog, /domain: "linkedin.com"/)
    assert.match(catalog, /domain: "github.com"/)
    assert.match(catalog, /domain: "x.com"/)
    assert.match(catalog, /domain: "facebook.com"/)
    assert.match(catalog, /gptStoreAppLogoUrl/)
    assert.doesNotMatch(catalog, /google\.com\/s2\/favicons\?sz=128/)
  })

  it("keeps the Apps catalog out of /gpts (Apps has its own page)", () => {
    assert.doesNotMatch(page, /gpts-apps-section|GptsAppsSection/)
    assert.match(page, /placeholder="Buscar GPT"/)
    assert.doesNotMatch(page, /Buscar GPT y Apps/)
    assert.match(conexiones, /<GptsAppsSection /)
  })

  it("renders the Apps catalog with a connect action", () => {
    assert.match(section, /data-testid="gpts-apps-section"/)
    assert.match(section, />Apps</)
    assert.match(section, /CONNECT_COPY|connectButtonLabel/)
    assert.match(section, /connectGptStoreApp/)
    assert.match(section, /isHealthConnected/)
    assert.match(section, /\/apps\/connections/)
    assert.doesNotMatch(section, /settings\.apps\[id\]\?\.connected === true/)
    assert.match(section, /connectGptStoreApp/)
    assert.match(section, /agent-computer\/navigate/)
    assert.doesNotMatch(section, /toast\.success\(`\$\{app\.name\} conectada`\)/)
    assert.match(section, /gptStoreAppLogoUrl/)
    assert.match(section, /gptStoreAppLogoSources/)
    assert.match(section, /<img/)
    assert.match(section, /onError/)
    assert.match(section, /alt=\{\`\$\{app\.name\} logo\`\}/)
  })

  it("opens the full catalog from the sidebar Apps nav item under GPTs", () => {
    const sidebar = fs.readFileSync(path.join(process.cwd(), "components", "app-sidebar.tsx"), "utf8")
    const conexiones = fs.readFileSync(path.join(process.cwd(), "app", "conexiones", "page.tsx"), "utf8")
    const gptsAt = sidebar.indexOf('href="/gpts"')
    const appsAt = sidebar.indexOf('href="/conexiones"')
    assert.ok(gptsAt > 0 && appsAt > gptsAt, "Apps nav item must sit after GPTs")
    assert.match(sidebar, /label="Apps"/)
    assert.match(conexiones, /data-testid="connect-apps-page"/)
    assert.match(conexiones, /showAll/)
    assert.match(conexiones, /hideHeading/)
  })
})
