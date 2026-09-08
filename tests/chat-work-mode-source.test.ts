import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = fs.readFileSync(
  path.join(process.cwd(), "components/chat-interface-enhanced.tsx"),
  "utf8",
)

describe("chat Trabajo mode source contract", () => {
  it("keeps legacy mode state removable without exposing a new menu entry", () => {
    assert.match(source, /const WORK_MODE_STORAGE_KEY = 'sira:chat:work-mode'/)
    assert.match(source, /window\.localStorage\.setItem\(WORK_MODE_STORAGE_KEY/)
    assert.match(source, /<span>Trabajo<\/span>/)
    assert.match(source, /aria-label="Cerrar modo Trabajo"/)

    const plusMenuStart = source.indexOf('className="chat-tools-menu liquid-menu-surface"')
    const plusMenuEnd = source.indexOf("</DropdownMenuContent>", plusMenuStart)
    assert.notEqual(plusMenuStart, -1, "missing plus tools menu start")
    assert.notEqual(plusMenuEnd, -1, "missing plus tools menu end")

    const plusMenu = source.slice(plusMenuStart, plusMenuEnd)
    assert.doesNotMatch(
      plusMenu,
      /Trabajo activo|Planifica, ejecuta y entrega archivos|setIsWorkModeActive\(!isWorkModeActive\)/,
      "the retired Trabajo action must not be shown in the plus menu",
    )
  })

  it("routes substantive work through the durable agent without hijacking dedicated tools", () => {
    assert.match(source, /shouldUseWorkModeAgent = isWorkModeActive/)
    assert.match(source, /!hasDedicatedConnector/)
    assert.match(source, /!hasMediaGenerator/)
    assert.match(source, /shouldRouteWorkModePromptThroughAgentTask\(msg, filesToSend\)/)
    assert.match(source, /shouldStartAgenticLoopImmediately = shouldUseWorkModeAgent/)
  })
})
