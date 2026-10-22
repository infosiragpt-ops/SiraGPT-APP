import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { formatScheduleEsPE } from "../lib/format-schedule-es-pe"
const computer = readFileSync("components/code/department-computer-pane.tsx", "utf8")
const viewer = readFileSync("components/code/ComputerViewer.tsx", "utf8")

describe("Empresas polish lock", () => {

  it("fits noVNC to the panel and defaults the right column to Computadora + Rutinas", () => {
    assert.match(computer, /resize=scale/)
    assert.match(computer, /data-novnc-fit="cover"/)
    assert.match(computer, /relative flex h-full min-h-0 w-full flex-col/)
    assert.match(viewer, /data-novnc-fit="cover"/)
    assert.match(viewer, /width: "100%", height: "100%"/)
    assert.doesNotMatch(viewer, /Idle/)
  })
})
