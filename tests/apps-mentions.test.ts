import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "path"
import { describe, it } from "node:test"

import {
  MENTION_COPY,
  buildPickerApps,
  detectAtMention,
  filterPickerApps,
  groupPickerApps,
  insertMention,
  mentionPayloadForGenerate,
  parseMentionedNames,
  resolveMentionedApps,
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
    assert.equal(resolveConnectPlan({ id: "indeed", name: "Indeed", domain: "indeed.com" }).kind, "unavailable")
    assert.equal(MENTION_COPY.connectedGroup, "Conectadas")
    assert.equal(MENTION_COPY.connectGroup, "Conectar")
  })

  it("inserts an @AppName mention over the live token", () => {
    const trigger = detectAtMention("usa @git")
    assert.equal(insertMention("usa @git", trigger, "GitHub"), "usa @GitHub ")
  })

  it("wires the picker into the /agentes composer and the generate payload", () => {
    const composer = source("components/chat-interface-enhanced.tsx")
    const api = source("lib/api.ts")
    const stream = source("backend/src/services/agentic-chat-stream.js")
    assert.match(composer, /AppsMentionPicker/)
    assert.match(composer, /detectAtMention/)
    assert.match(composer, /mentionedApps/)
    assert.match(api, /mentionedApps\?: string\[\]/)
    assert.match(stream, /mentionedAppTools/)
    assert.match(stream, /resolveMentionedApps/)
    assert.doesNotMatch(composer, /ensureComputerSession/)
  })
})
