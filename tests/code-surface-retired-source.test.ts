import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

const CHROME_FILES = [
  "components/app-sidebar.tsx",
  "components/settings/settings-panel.tsx",
  "components/keyboard-shortcuts.tsx",
  "components/code/chat-empresa-fab.tsx",
  "components/sidebar/sidebar-folders-dropdown.tsx",
  "app/not-found.tsx",
  "app/code/error.tsx",
] as const

describe("retired /code product surface", () => {
  it("removes every user-facing href or navigation to /code from chrome", () => {
    for (const file of CHROME_FILES) {
      const src = source(file)
      assert.doesNotMatch(src, /href=['"`]\/code(?:\/|\?|'|"|`)/, `${file} must not link to /code`)
      assert.doesNotMatch(src, /go\(['"`]\/code/, `${file} must not command-palette to /code`)
      assert.doesNotMatch(src, /router\.(push|replace)\([`'"]\/code/, `${file} must not router-navigate to /code`)
      assert.doesNotMatch(src, /location\.(href|assign|replace)\([^)]*\/code/, `${file} must not hard-nav to /code`)
    }
  })

  it("keeps Empresas in the sidebar header and drops the code icon plus sidebar.code control", () => {
    const sidebar = source("components/app-sidebar.tsx")
    const headerStart = sidebar.indexOf('aria-label="Modo de la barra lateral"')
    assert.ok(headerStart > 0, "missing sidebar mode tablist")
    const header = sidebar.slice(headerStart, headerStart + 1800)
    assert.match(header, /aria-label="Empresas"/)
    assert.match(header, />Empresas</)
    assert.doesNotMatch(header, /<Code2/)
    assert.doesNotMatch(header, /href=['"`]\/code/)
    assert.doesNotMatch(sidebar, /t\(["']code["']\)/)
    assert.doesNotMatch(sidebar, /navigate\(mode === "code" \? "\/code"/)
    assert.doesNotMatch(sidebar, /['"]\/code['"]/)
  })

  it("redirects /code to /agentes from middleware, next.config, and the page module", () => {
    const mw = source("middleware.ts")
    const config = source("next.config.mjs")
    const page = source("app/code/page.tsx")
    assert.match(mw, /pathname === '\/code' \|\| pathname\.startsWith\('\/code\/'\)/)
    assert.match(mw, /url\.pathname = '\/agentes'/)
    assert.match(mw, /NextResponse\.redirect\(url, 307\)/)
    assert.match(config, /source: '\/code'/)
    assert.match(config, /destination: '\/agentes'/)
    assert.match(config, /source: '\/code\/:path\*'/)
    assert.match(page, /redirect\(/)
    assert.match(page, /chatSearchToAgentsHome/)
    assert.doesNotMatch(page, /CodeWorkspaceProvider|function CodeWorkspaceGate/)
  })

  it("keeps Spotify OAuth on /agentes and social callbacks off /code", () => {
    const policy = source("backend/src/config/oauth-url-policy.js")
    const policyTest = source("backend/tests/oauth-url-policy.test.js")
    const platforms = source("backend/src/services/social-company/platforms.js")
    assert.match(policy, /\/agentes/)
    assert.match(policyTest, /\/agentes\?spotify_connected=true/)
    assert.doesNotMatch(policyTest, /\/chat\?spotify_connected=true/)
    assert.match(platforms, /new URL\('\/agentes'/)
    assert.doesNotMatch(platforms, /new URL\('\/code'/)
  })
})
