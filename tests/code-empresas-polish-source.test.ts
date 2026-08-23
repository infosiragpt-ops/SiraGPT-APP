import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { formatScheduleEsPE } from "../lib/format-schedule-es-pe"

const topBar = readFileSync("components/code/workspace-top-bar.tsx", "utf8")
const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const routines = readFileSync("components/code/company-routines-panel.tsx", "utf8")
const computer = readFileSync("components/code/department-computer-pane.tsx", "utf8")
const viewer = readFileSync("components/code/ComputerViewer.tsx", "utf8")
const workspace = readFileSync("components/code/code-workspace.tsx", "utf8")

describe("Empresas polish lock", () => {
  it("removes the green Ejecutar / Arrancando play button from the top bar DOM", () => {
    assert.doesNotMatch(topBar, /workspace-header-run-stop/)
    assert.doesNotMatch(topBar, /bg-emerald-600/)
    assert.match(topBar, /workspace-header-overflow/)
    assert.match(topBar, /workspace-header-run-overflow/)
    assert.match(topBar, /data-empresas-no-run-button="1"/)
  })

  it("keeps the monitor icon and localizes Rutinas in es-PE 24h", () => {
    assert.match(topBar, /workspace-header-department-computer/)
    assert.match(routines, />Rutinas</)
    assert.doesNotMatch(routines, />Routines</)
    assert.equal(formatScheduleEsPE("57 */3 * * *"), "Cada 3 horas a las 00:57")
    assert.equal(formatScheduleEsPE("Every 3 hours at :57"), "Cada 3 horas a las 00:57")
    assert.equal(
      formatScheduleEsPE("32 9,15 * * 1-5"),
      "Lunes a viernes a las 09:32 y 15:32",
    )
    assert.equal(
      formatScheduleEsPE("Weekdays at 9:32 AM and 3:32 PM"),
      "Lunes a viernes a las 09:32 y 15:32",
    )
  })

  it("wraps department names and shows an actionable empty state", () => {
    assert.match(company, /data-dept-name-wrap="1"/)
    assert.match(company, /whitespace-normal break-words/)
    assert.match(chat, /code-chat-empty-state/)
    assert.match(chat, /code-chat-empty-department/)
    assert.match(chat, /departmentEmptySuggestions/)
  })

  it("fits noVNC to the panel and keeps the three-column computer/routines stack", () => {
    assert.match(computer, /resize=remote/)
    assert.match(computer, /data-novnc-fit="cover"/)
    assert.match(viewer, /data-novnc-fit="cover"/)
    assert.doesNotMatch(viewer, /Idle/)
    assert.match(workspace, /empresas-computer-routines/)
    assert.match(workspace, /CompanyRoutinesPanel/)
    assert.match(workspace, /DepartmentComputerPane/)
  })
})
