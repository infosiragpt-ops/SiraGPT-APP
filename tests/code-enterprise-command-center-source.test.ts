import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const componentPath = "components/code/enterprise-command-center.tsx"
const source = readFileSync(componentPath, "utf8")

function sliceInterface(name: string): string {
  const start = source.indexOf(`export interface ${name}`)
  assert.notEqual(start, -1, `missing exported interface ${name}`)
  const end = source.indexOf("\n}", start)
  assert.notEqual(end, -1, `unterminated exported interface ${name}`)
  return source.slice(start, end + 2)
}

describe("enterprise command center source contract", () => {
  it("exports the requested typed operational props", () => {
    const props = sliceInterface("EnterpriseCommandCenterProps")
    for (const contract of [
      /readiness: EnterpriseReadiness/,
      /mission: string/,
      /vision: string/,
      /swarmSummary: EnterpriseSwarmSummary/,
      /departments: EnterpriseDepartment\[\]/,
      /liveEvents: EnterpriseLiveEvent\[\]/,
      /executiveSummary: EnterpriseExecutiveSummary/,
      /onStart: \(\) => void/,
      /onPause: \(\) => void/,
      /onCancel: \(\) => void/,
      /onOpen: \(target: EnterpriseCommandCenterTarget\) => void/,
    ]) {
      assert.match(props, contract)
    }
    assert.match(source, /export function EnterpriseCommandCenter\(/)
  })

  it("keeps the complete swarm and department telemetry contracts", () => {
    const swarm = sliceInterface("EnterpriseSwarmSummary")
    for (const field of ["logicalAgents", "active", "queued", "completed", "failed", "maxParallel"]) {
      assert.match(swarm, new RegExp(`${field}: number`), `missing swarm field ${field}`)
    }

    const department = sliceInterface("EnterpriseDepartment")
    for (const field of [
      "logicalAgents",
      "activeAgents",
      "queuedTasks",
      "completedTasks",
      "progress",
    ]) {
      assert.match(department, new RegExp(`${field}: number`), `missing department field ${field}`)
    }
  })

  it("renders a dense responsive command surface without nested UI cards", () => {
    assert.match(source, /data-testid="enterprise-command-center"/)
    assert.match(source, /grid grid-cols-2 border-t border-border sm:grid-cols-3 xl:grid-cols-6/)
    assert.match(source, /xl:grid-cols-\[minmax\(0,1\.45fr\)_minmax\(320px,0\.8fr\)\]/)
    assert.match(source, /min-h-11/)
    assert.doesNotMatch(source, /components\/ui\/card/)
    assert.doesNotMatch(source, /<Card(?:Content|Header|Title|Description)?\b/)
    assert.doesNotMatch(source, /\bhero\b/i)
  })

  it("provides accessible segmented navigation, state and live telemetry", () => {
    assert.match(source, /role="tablist"/)
    assert.match(source, /role="tab"/)
    assert.match(source, /aria-selected=\{selected\}/)
    assert.match(source, /onKeyDown=\{\(event\) => handleTabKeyDown\(event, tabIndex\)\}/)
    assert.match(source, /event\.key === "ArrowRight"/)
    assert.match(source, /event\.key === "ArrowLeft"/)
    assert.match(source, /role="tabpanel"/)
    assert.match(source, /aria-live="polite"/)
    assert.match(source, /aria-relevant="additions text"/)
    assert.match(source, /<time dateTime=\{event\.timestamp\}>/)
    assert.match(source, /role="progressbar"/)
    assert.match(source, /motion-reduce:animate-none/)
    assert.match(source, /role="status"/)
    assert.match(source, /eventKindLabels\[event\.kind\]/)
  })

  it("wires start, pause, cancel and contextual open actions to lucide controls", () => {
    assert.match(source, /from "lucide-react"/)
    assert.match(source, /onClick=\{onStart\}/)
    assert.match(source, /onClick=\{onPause\}/)
    assert.match(source, /onClick=\{onCancel\}/)
    assert.match(source, /onOpen\(\{ type: "readiness" \}\)/)
    assert.match(source, /onOpen\(\{ type: "department", id: department\.id \}\)/)
    assert.match(source, /onOpen\(\{ type: "event", id: event\.id \}\)/)
    assert.match(source, /aria-label="Iniciar ejecución de agentes"/)
    assert.match(source, /aria-label="Pausar ejecución de agentes"/)
    assert.match(source, /aria-label="Cancelar ejecución de agentes"/)
    for (const icon of ["Play", "Pause", "Square", "ChevronRight"]) {
      assert.match(source, new RegExp(`<${icon}\\b`), `missing lucide control ${icon}`)
    }
  })
})
