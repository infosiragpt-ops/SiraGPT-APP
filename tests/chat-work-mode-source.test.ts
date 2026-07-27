import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = fs.readFileSync(
  path.join(process.cwd(), "components/chat-interface-enhanced.tsx"),
  "utf8",
)

describe("chat Trabajo mode source contract", () => {
  it("persists the mode and exposes a visible removable status", () => {
    assert.match(source, /const WORK_MODE_STORAGE_KEY = 'sira:chat:work-mode'/)
    assert.match(source, /window\.localStorage\.setItem\(WORK_MODE_STORAGE_KEY/)
    assert.match(source, /Trabajo activo/)
    assert.match(source, /aria-label="Cerrar modo Trabajo"/)
  })

  it("routes substantive work through the durable agent without hijacking dedicated tools", () => {
    assert.match(source, /shouldUseWorkModeAgent = isWorkModeActive/)
    assert.match(source, /!hasDedicatedConnector/)
    assert.match(source, /!hasMediaGenerator/)
    assert.match(source, /shouldRouteWorkModePromptThroughAgentTask\(msg, filesToSend\)/)
    assert.match(source, /shouldStartAgenticLoopImmediately = shouldUseWorkModeAgent/)
  })
})
