import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

// Real-world failure this contract prevents: a build request misrouted
// through a non-build mode streamed 14 file cards into chat, applied
// nothing ("Aplicar — Nada que aplicar"), and left the preview blank.

const panel = fs.readFileSync(
  path.join(process.cwd(), "components", "code", "ai-code-chat-panel.tsx"),
  "utf8",
)

describe("code chat apply-gate source contract", () => {
  it("applies generated files in every mode that is not explicitly read-only", () => {
    assert.match(
      panel,
      /override\?\.autoApply \?\? \(promptMode !== "ask" && promptMode !== "plan" && promptMode !== "image"\)/,
      "the apply gate must be a read-only blocklist, not an app|build allowlist",
    )
    assert.doesNotMatch(
      panel,
      /override\?\.autoApply \?\? \(promptMode === "app" \|\| promptMode === "build"\)/,
      "the old allowlist gate must not come back",
    )
  })

  it("does not apply streamed files that fail structural validation", () => {
    const applyBlock = panel.indexOf("if (b.path) applyBlock(b.path, b.content)")
    const reject = panel.indexOf("if (!streamCheck.valid && override?.spokenKind !== \"debug\")")
    const rejectedAssign = panel.indexOf("rejectedStream = streamCheck")
    const applyElse = panel.indexOf("} else {", reject)
    assert.ok(reject >= 0 && rejectedAssign > reject, "a failed stream must be recorded as rejected")
    assert.ok(applyElse > rejectedAssign && applyBlock > applyElse, "applyBlock must sit in the valid branch")
    assert.match(panel, /Validación bloqueó la aplicación/)
    assert.match(panel, /status: lastVerdict\.ok \? "completed" : "blocked"/)
    assert.match(panel, /promptResult\?\.rejected/)
    assert.match(panel, /lastAppliedFilesRef\.current/)
  })

  it("degrades every non-conversational silent-model turn to the Codex engine", () => {
    assert.match(
      panel,
      /emptyModel && \(override\?\.autoApply \?\? !conversational\) && codexAvailable/,
      "a default-mode build whose model went silent must fall back to Codex, not die with a bare error",
    )
  })
})
