import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

function assertDemoPrecedesBackendWildcard(caddy: string, siteStart: string) {
  const start = caddy.indexOf(siteStart)
  assert.ok(start >= 0, `missing Caddy site block: ${siteStart}`)

  const nextSite = caddy.indexOf("\n}\n", start)
  const site = caddy.slice(start, nextSite)
  const demoRoute = site.indexOf("handle /api/demo")
  const backendWildcard = site.indexOf("handle /api/*")

  assert.ok(demoRoute >= 0, `${siteStart} must route /api/demo`)
  assert.ok(backendWildcard >= 0, `${siteStart} must keep the backend API wildcard`)
  assert.ok(demoRoute < backendWildcard, "/api/demo must be matched before /api/*")
  assert.match(site.slice(demoRoute, backendWildcard), /reverse_proxy frontend:3000/)
}

test("public demo route reaches its Next.js handler instead of the backend 404", () => {
  const caddy = read("deploy/Caddyfile")
  const route = read("app/api/demo/route.ts")

  assert.match(route, /export async function POST/)
  assert.match(route, /CACHED_RESULTS/)
  assertDemoPrecedesBackendWildcard(caddy, "siragpt.com, www.siragpt.com, office.siragpt.com {")
  assertDemoPrecedesBackendWildcard(caddy, "https:// {")
})
