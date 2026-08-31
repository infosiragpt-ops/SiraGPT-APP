import assert from "node:assert/strict"
import { describe, it } from "node:test"

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
    assert.deepEqual(composerGenerateFlags(), {})
  })
})
