import assert from "node:assert/strict"
import { describe, it } from "node:test"

import fs from "node:fs"
import path from "node:path"

import {
  composerBlocksTools,
  composerGenerateFlags,
  isComposerPermissionId,
  readComposerPermission,
} from "../lib/chat/composer-session"

describe("composer session policy", () => {
  it("treats read and protected as tool-blocking", () => {
    assert.equal(composerBlocksTools("read"), true)
    assert.equal(composerBlocksTools("protected"), true)
    assert.equal(composerBlocksTools("full"), false)
    assert.equal(composerBlocksTools("workspace"), false)
    assert.equal(composerBlocksTools("default"), false)
  })

  it("defaults to full access without a browser store", () => {
    assert.equal(isComposerPermissionId("full"), true)
    assert.equal(isComposerPermissionId("admin"), false)
    assert.equal(readComposerPermission(), "full")
    assert.deepEqual(composerGenerateFlags(), { permission: "full" })
    assert.equal("disableAgentic" in composerGenerateFlags(), false)
  })

  it("sends the selected permission on generate and keeps full unrestricted", () => {
    const flags = composerGenerateFlags()
    assert.equal(flags.permission, "full")
    assert.equal(flags.disableAgentic, undefined)
    assert.deepEqual(composerGenerateFlags(), { permission: "full" })
  })

  it("wires permission into generate and SiraCode payloads", () => {
    const context = fs.readFileSync(path.join(process.cwd(), "lib", "chat-context-integrated.tsx"), "utf8")
    const api = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")
    const session = fs.readFileSync(path.join(process.cwd(), "lib", "chat", "composer-session.ts"), "utf8")
    const generateRoute = fs.readFileSync(path.join(process.cwd(), "backend", "src", "routes", "ai.js"), "utf8")
    assert.match(session, /permission: ComposerPermissionId/)
    assert.ok(
      (context.match(/\.\.\.composerGenerateFlags\(\)/g) || []).length >= 3,
      "every generate envelope must include composerGenerateFlags (permission)",
    )
    assert.match(api, /permission\?: string/)
    assert.match(
      generateRoute,
      /body\('permission'\)\.optional\(\)\.isString\(\)\.isIn\(\['default', 'read', 'protected', 'workspace', 'full'\]\)/,
    )
    assert.match(generateRoute, /permission: \(req\.body && \(req\.body\.permission \|\| req\.body\.toolPermission\)\) \|\| 'default'/)
  })
})
