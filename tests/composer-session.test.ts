import assert from "node:assert/strict"
import { describe, it } from "node:test"

import fs from "node:fs"
import path from "node:path"

import {
  composerBlocksTools,
  composerDisablesAgentic,
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

  it("defaults to the agent policy without a browser store", () => {
    assert.equal(isComposerPermissionId("default"), true)
    assert.equal(isComposerPermissionId("admin"), false)
    assert.equal(readComposerPermission(), "default")
    assert.deepEqual(composerGenerateFlags(), { permission: "default" })
    assert.equal("disableAgentic" in composerGenerateFlags(), false)
  })

  it("sends the selected permission on generate and keeps default unrestricted", () => {
    const flags = composerGenerateFlags()
    assert.equal(flags.permission, "default")
    assert.equal(flags.disableAgentic, undefined)
    assert.deepEqual(composerGenerateFlags(), { permission: "default" })
  })

  it("keeps the agentic loop on for Protegido so writes can ask the reviewer", () => {
    assert.equal(composerBlocksTools("protected"), true)
    assert.equal(composerDisablesAgentic("protected"), false)
    assert.equal(composerDisablesAgentic("read"), true)
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
