import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "path"
import { describe, it } from "node:test"

import {
  FIRST_PARTY_LOGO_BY_ID,
  MENTION_COPY,
  buildPickerApps,
  detectAtMention,
  filterPickerApps,
  groupPickerApps,
  insertMention,
  mentionAppLogoSources,
  mentionPayloadForGenerate,
  parseMentionedNames,
  resolveMentionAppLogo,
  resolveMentionedApps,
  toPickerApp,
} from "../lib/apps-mentions"
import { resolveConnectPlan } from "../lib/gpts-apps-connect"

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8")
}

describe("apps @ mentions", () => {
  it("opens a mention after whitespace and ignores emails", () => {
    assert.deepEqual(detectAtMention("@"), { start: 0, query: "" })
    assert.deepEqual(detectAtMention("hola @git"), { start: 5, query: "git" })
    assert.equal(detectAtMention("luis@siragpt.com"), null)
    assert.equal(detectAtMention("hola @github revisa"), null)
    assert.deepEqual(detectAtMention("mira @", 6), { start: 5, query: "" })
  })

  it("parses @App tokens and builds a generate payload without tokens", () => {
    const text = "Revisa @GitHub y luego @X por menciones"
    assert.deepEqual(parseMentionedNames(text), ["GitHub", "X"])
    const payload = resolveMentionedApps(text, [], { github: "connected", x: "connected" })
    assert.deepEqual(payload.connectedAppIds.sort(), ["github", "x"])
    assert.deepEqual(mentionPayloadForGenerate(text, ["linkedin"]).mentionedApps.sort(), [
      "github",
      "linkedin",
      "x",
    ])
    assert.doesNotMatch(JSON.stringify(payload), /token|gho_|Bearer /i)
  })

  it("groups Conectadas first and keeps catalog apps unavailable to connect", () => {
    const apps = buildPickerApps({ x: "connected", github: "expired" })
    const grouped = groupPickerApps(filterPickerApps(apps, ""))
    assert.equal(grouped.connected[0]?.id, "x")
    assert.ok(grouped.connect.some((app) => app.id === "github"))
    assert.ok(grouped.connect.some((app) => app.id === "linkedin"))
    const indeed = grouped.unavailable.find((app) => app.id === "indeed")
    assert.ok(indeed)
    assert.equal(indeed.status, "unavailable")
    assert.equal(resolveConnectPlan({ id: "indeed", name: "Indeed", domain: "indeed.com" }).kind, "computer")
    assert.ok(grouped.connect.some((app) => app.id === "facebook"))
    assert.ok(grouped.connect.some((app) => app.id === "onedrive"))
    assert.ok(grouped.connect.some((app) => app.id === "google-drive"))
    const drivePayload = resolveMentionedApps("@OneDrive y @gdrive y @Google-Drive")
    assert.deepEqual(drivePayload.mentionedApps.sort(), ["google-drive", "onedrive"])
    assert.ok(drivePayload.needsConnect.some((app) => app.id === "onedrive"))
    assert.equal(resolveConnectPlan({ id: "onedrive", name: "OneDrive", domain: "onedrive.live.com" }).kind, "oauth")
    assert.equal(resolveConnectPlan({ id: "google-drive", name: "Google Drive", domain: "drive.google.com" }).kind, "oauth")
    const facebook = buildPickerApps({ facebook: "connected" }).find((app) => app.id === "facebook")
    assert.equal(facebook?.status, "connect")
    assert.equal(MENTION_COPY.connectedGroup, "Conectadas")
    assert.equal(MENTION_COPY.connectGroup, "Conectar")
  })

  it("inserts an @AppName mention over the live token", () => {
    const trigger = detectAtMention("usa @git")
    assert.equal(insertMention("usa @git", trigger, "GitHub"), "usa @GitHub ")
  })

  it("wires the picker into the /agentes composer and the generate payload", () => {
    const composer = source("components/chat-interface-enhanced.tsx")
    const surface = source("components/chat/ChatComposerSurface.tsx")
    const api = source("lib/api.ts")
    const stream = source("backend/src/services/agentic-chat-stream.js")
    assert.match(surface, /mentionMenu/)
    assert.match(surface, /slashMenu/)
    assert.match(composer, /AppsMentionPicker/)
    assert.match(composer, /detectAtMention/)
    assert.match(composer, /mentionedApps/)
    assert.match(composer, /mentionMenu=/)
    assert.match(composer, /\/apps\/connections/)
    assert.doesNotMatch(composer, /probe=0/)
    assert.match(api, /mentionedApps\?: string\[\]/)
    assert.match(stream, /mentionedAppTools/)
    assert.match(stream, /resolveMentionedApps/)
    assert.doesNotMatch(composer, /ensureComputerSession/)
    assert.doesNotMatch(composer, /agent-computer\/navigate/)
  })

  it("passes official catalog logos through the picker rows", () => {
    const apps = buildPickerApps()
    for (const id of ["github", "linkedin", "x", "facebook"] as const) {
      const row = apps.find((app) => app.id === id)
      assert.ok(row, `missing picker row ${id}`)
      assert.equal(row.logo, FIRST_PARTY_LOGO_BY_ID[id])
      assert.ok(row.logoSources.includes(FIRST_PARTY_LOGO_BY_ID[id]))
    }
    const indeed = apps.find((app) => app.id === "indeed")
    assert.equal(indeed?.logo, "/conexiones-logos/indeed.svg")
    const invented = toPickerApp({
      id: "astro-scope-destiny-matrix",
      name: "Astro Scope Destiny Matrix",
      description: "Destiny Matrix by birth date",
      category: "Astrología",
      domain: "astro-scope-destiny-matrix.com",
    })
    assert.equal(invented.logo, null)
    assert.deepEqual(invented.logoSources, [])
    assert.equal(
      resolveMentionAppLogo({ id: "github", domain: "" }),
      "/conexiones-logos/github.svg",
    )
    assert.deepEqual(
      mentionAppLogoSources({ id: "linkedin", logo: "/custom/linkedin.png" }),
      ["/custom/linkedin.png", "/conexiones-logos/linkedin.svg"],
    )

    const picker = source("components/AppsMentionPicker.tsx")
    assert.match(picker, /app\.logoSources/)
    assert.match(picker, /data-testid=\{`apps-mention-logo-\$\{app\.id\}`\}/)
    assert.match(picker, /alt=\{\`\$\{app\.name\} logo`\}/)
    assert.match(picker, /<img/)
    assert.match(picker, /statusLabel\(app\.status\)/)
    assert.doesNotMatch(picker, /generatedBrandTileUrl/)
  })
})
