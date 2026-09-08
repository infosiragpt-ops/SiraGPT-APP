import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("agent computer shell · PensandoBars port", () => {
  it("ships the shell file and wraps /code mainArea", () => {
    assert.equal(existsSync("components/code/agent-computer-shell.tsx"), true)
    const shell = source("components/code/agent-computer-shell.tsx")
    const workspace = source("components/code/code-workspace.tsx")

    assert.match(shell, /data-testid="agent-computer-shell"/)
    assert.match(shell, /data-testid="agent-computer-chrome"/)
    assert.match(shell, /data-testid="agent-computer-dock-os"/)
    assert.match(shell, /data-testid="agent-computer-routines"/)
    assert.match(workspace, /import \{ AgentComputerShell \} from "\.\/agent-computer-shell"/)
    assert.match(workspace, /<AgentComputerShell(?:\s[^>]*)?>/)
    assert.match(workspace, /<\/AgentComputerShell>/)
  })

  it("uses production-main PensandoBars for starting / in-progress", () => {
    const shell = source("components/code/agent-computer-shell.tsx")
    assert.match(shell, /import \{ PensandoBars \} from "@\/components\/pensando-bars"/)
    assert.match(shell, /<PensandoBars size=\{14\}/)
    assert.match(shell, /<PensandoBars size=\{28\}/)
    assert.match(shell, /IN_PROGRESS_PHASES/)
    assert.match(shell, /"starting"/)
    assert.doesNotMatch(shell, /sunburst/i)
    assert.doesNotMatch(shell, /currentColor/)
    assert.doesNotMatch(shell, /generando-pdf|generando-word|buscando-internet/)
  })

  it("keeps the agent-computer focus action contract", () => {
    const shell = source("components/code/agent-computer-shell.tsx")
    assert.match(shell, /agent-computer\/action/)
    assert.match(shell, /JSON\.stringify\(\{[\s\S]*focus: app[\s\S]*\}\)/)
    assert.match(shell, /conversationId/)
    assert.match(shell, /authenticatedFetch/)
  })

  it("never uses forbidden boot/run chrome copy in the shell or es starting label", () => {
    const shell = source("components/code/agent-computer-shell.tsx")
    const es = JSON.parse(source("messages/es.json"))
    const en = JSON.parse(source("messages/en.json"))
    const starting = es.codex.panel.agentComputer.status.starting as string

    const bootEs = "Arranca" + "ndo"
    const runEs = "Ejecu" + "tar"
    assert.doesNotMatch(shell, new RegExp(bootEs, "i"))
    assert.doesNotMatch(shell, new RegExp(runEs, "i"))
    assert.equal(starting, "Pensando…")
    assert.doesNotMatch(starting, new RegExp(bootEs, "i"))
    assert.doesNotMatch(starting, new RegExp(runEs, "i"))
    assert.equal(en.codex.panel.agentComputer.status.starting, "Thinking…")
  })
})
