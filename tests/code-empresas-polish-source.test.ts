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
const preview = readFileSync("components/code/preview-pane.tsx", "utf8")

describe("Empresas polish lock", () => {
  it("removes the green Ejecutar / Arrancando play button from Empresas chrome DOM", () => {
    assert.doesNotMatch(topBar, /workspace-header-run-stop/)
    assert.doesNotMatch(topBar, /bg-emerald-600/)
    assert.doesNotMatch(preview, /bg-emerald-600/)
    assert.doesNotMatch(preview, /Ejecutar repo/)
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

  it("wraps department names and keeps useful launch starters", () => {
    assert.match(company, /data-dept-name-wrap="1"/)
    assert.match(company, /data-dept-name-1280="wrap"/)
    assert.match(company, /whitespace-normal break-words/)
    assert.match(company, /overflow-wrap:anywhere/)
    assert.match(company, /min-w-0 flex-1 whitespace-normal/)
    assert.match(company, /xl:whitespace-normal xl:overflow-visible/)
    const wrapAt = company.indexOf('data-dept-name-wrap="1"')
    assert.notEqual(wrapAt, -1)
    const nameClass = company.slice(Math.max(0, wrapAt - 320), wrapAt)
    assert.doesNotMatch(nameClass, /truncate/)
    assert.match(chat, /code-chat-empty-state/)
    assert.match(chat, /code-chat-empty-department/)
    assert.match(chat, /code-chat-empty-launch/)
    assert.match(chat, /¿Qué quieres lanzar\?/)
    assert.match(chat, /departmentEmptySuggestions/)
    assert.match(chat, /CODE_AUTONOMOUS_STARTERS\.map/)
    assert.doesNotMatch(chat, /CODE_AUTONOMOUS_STARTERS\.slice/)
    assert.match(chat, /<EmptyChat/)
    assert.match(chat, /departmentId=\{bardNav\?\.departmentId\}/)
  })

  it("fits noVNC to the panel and defaults the right column to Computadora + Rutinas", () => {
    assert.match(computer, /resize=scale/)
    assert.match(computer, /data-novnc-fit="cover"/)
    assert.match(computer, /relative flex h-full min-h-0 w-full flex-col/)
    assert.match(viewer, /data-novnc-fit="cover"/)
    assert.match(viewer, /width: "100%", height: "100%"/)
    assert.doesNotMatch(viewer, /Idle/)
    assert.match(workspace, /empresas-computer-routines/)
    assert.match(workspace, /data-empresas-right-column/)
    assert.match(workspace, /empresas-preview-underlay/)
    assert.match(workspace, /CompanyRoutinesPanel/)
    assert.match(workspace, /DepartmentComputerPane/)
    assert.match(workspace, /const \[computerOpen, setComputerOpen\] = React\.useState\(true\)/)
  })

  it("labels the six Empresas top-bar icons and keeps Ejecutar out of chrome", () => {
    assert.match(topBar, /data-empresas-topbar-icons="6"/)
    assert.match(topBar, /workspace-header-notifications/)
    assert.match(topBar, /workspace-header-split/)
    assert.match(topBar, /aria-label=\{chatOpen \? "Ocultar el panel de chat" : "Mostrar el panel de chat"\}/)
    assert.match(topBar, /title=\{chatOpen \? "Ocultar el panel de chat" : "Mostrar el panel de chat"\}/)
    assert.match(topBar, /aria-label="Nueva pestaña"/)
    assert.match(topBar, /title="Nueva pestaña"/)
    assert.match(topBar, /aria-label="Invitar al equipo"/)
    assert.match(topBar, /title="Invitar al equipo"/)
    assert.match(topBar, /aria-label="Buscar"/)
    assert.match(topBar, /title="Buscar"/)
    assert.match(topBar, /aria-label="Más acciones"/)
    assert.match(topBar, /title="Más acciones"/)
    assert.doesNotMatch(topBar, /workspace-header-run-stop/)
  })
})
