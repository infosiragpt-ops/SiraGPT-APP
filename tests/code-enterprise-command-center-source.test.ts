import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const componentPath = "components/code/enterprise-command-center.tsx"
const source = readFileSync(componentPath, "utf8")
const companyPanelSource = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const previewPaneSource = readFileSync("components/code/preview-pane.tsx", "utf8")

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
    for (const field of [
      "logicalAgents",
      "planned",
      "active",
      "queued",
      "blocked",
      "completed",
      "failed",
      "cancelled",
      "maxParallel",
    ]) {
      assert.match(swarm, new RegExp(`${field}: number`), `missing swarm field ${field}`)
    }

    const department = sliceInterface("EnterpriseDepartment")
    for (const field of [
      "logicalAgents",
      "plannedTasks",
      "activeAgents",
      "queuedTasks",
      "blockedTasks",
      "failedTasks",
      "cancelledTasks",
      "completedTasks",
      "progress",
    ]) {
      assert.match(department, new RegExp(`${field}: number`), `missing department field ${field}`)
    }
  })

  it("renders a dense responsive command surface without nested UI cards", () => {
    assert.match(source, /data-testid="enterprise-command-center"/)
    assert.match(source, /grid grid-cols-2 border-t border-border sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9/)
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
    assert.match(source, /aria-label=\{resumable \? "Reanudar ejecución de agentes" : "Iniciar ejecución de agentes"\}/)
    assert.match(source, /aria-label="Pausar ejecución de agentes"/)
    assert.match(source, /aria-label="Cancelar ejecución de agentes"/)
    for (const icon of ["Play", "Pause", "Square", "ChevronRight"]) {
      assert.match(source, new RegExp(`<${icon}\\b`), `missing lucide control ${icon}`)
    }
  })

  it("keeps queued, approval, partial-completion, cancelling, cancelled and planned states explicit", () => {
    assert.match(source, /\| "queued"/)
    assert.match(source, /\| "waiting_approval"/)
    assert.match(source, /\| "completed_with_errors"/)
    assert.match(source, /\| "cancelling"/)
    assert.match(source, /\| "cancelled"/)
    assert.match(source, /\| "planned"/)
    assert.match(source, /readiness\.runState === "queued"/)
    assert.match(source, /readiness\.runState === "waiting_approval"/)
    assert.match(source, /readiness\.runState === "completed_with_errors"/)
    assert.match(source, /readiness\.runState === "cancelled"/)
    assert.match(source, /\{resumable \? "Reanudar" : "Iniciar"\}/)
  })

  it("does not invent active work or fallback parallel capacity", () => {
    assert.doesNotMatch(companyPanelSource, /return proactiveState\.enabled \? "running" : "idle"/)
    assert.doesNotMatch(companyPanelSource, /maxParallel: Math\.max\(8, active\)/)
    assert.match(companyPanelSource, /maxParallel: active/)
    assert.match(companyPanelSource, /plannedTasks: 0/)
    assert.match(companyPanelSource, /status: enterpriseDepartmentStatus\(statuses\)/)
  })

  it("stops the runner that owns the preview instead of crossing runtime boundaries", () => {
    assert.match(previewPaneSource, /previewOwnerRef = React\.useRef<PreviewRuntimeLease \| null>/)
    assert.match(previewPaneSource, /transitionPreviewRuntimeOwner\(previous, owner, PREVIEW_RUNTIME_STOPS\)/)
    assert.match(previewPaneSource, /stopPreviewRuntimeOwnerKeepalive\(lease\.owner\)/)
    assert.match(previewPaneSource, /stopPreviewRuntimeOwner\(lease\.owner, PREVIEW_RUNTIME_STOPS\)/)
    assert.doesNotMatch(previewPaneSource, /getActiveCodexProject\(\)[\s\S]{0,120}stopPreview/)
  })

  it("keeps the company footer and control board aligned with durable run states", () => {
    assert.match(companyPanelSource, /operationState=\{commandCenter\?\.readiness\.runState \?\? enterpriseRunState\(codexRuns\)\}/)
    assert.match(companyPanelSource, /operationState === "queued"\s*\? "EN COLA"/)
    assert.match(companyPanelSource, /operationState === "waiting_approval"\s*\? "APROBACIÓN"/)
    assert.match(companyPanelSource, /operationState === "completed_with_errors"\s*\? "CON ERRORES"/)
    assert.match(companyPanelSource, /role="status"/)
    assert.match(companyPanelSource, /data-testid=\{`agent-company-operation-state-/)
    assert.match(companyPanelSource, /data-testid=\{`agent-company-proactive-toggle-/)
    assert.match(companyPanelSource, /disabled=\{proactiveBusy \|\| proactiveBlockedByOperation\}/)
    assert.match(companyPanelSource, /if \(!hasSwarm && activeRun\)/)
    assert.match(companyPanelSource, /const blockedTasks = 0/)
    assert.doesNotMatch(companyPanelSource, /snapshot\.activeAgents > 0 \? "EN EJECUCIÓN"/)
    assert.match(companyPanelSource, /const runningRows = rowsForStatus\("running"\)/)
    assert.match(companyPanelSource, /const queuedRows = rowsForStatus\("queued"\)/)
    assert.match(companyPanelSource, /const approvalRows = rowsForStatus\("waiting_approval"\)/)
    assert.match(companyPanelSource, /statuses\.includes\("waiting_approval"\)\) return "waiting_approval"/)
    assert.match(companyPanelSource, /const failedRows = rowsForStatus\("error"\)/)
    assert.match(companyPanelSource, /const completedRows = rowsForStatus\("done"\)/)
    assert.match(companyPanelSource, /const cancelledRows = rowsForStatus\("cancelled"\)/)
    assert.doesNotMatch(companyPanelSource, /label: "En ejecución",\s*rows: orderedRuns\.filter\(\(run\) => codeRunIsActive\(run\)\)/)
  })
})
