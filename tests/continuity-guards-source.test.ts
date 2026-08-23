import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  CODE_CHROME_LOCK,
  CODE_FORBIDDEN_DESKTOP_NAV_LABELS,
  CODE_FORBIDDEN_TOPBAR_ACTIONS,
  CODE_KEPT_SURFACES,
} from "../lib/code-chrome-lock"
import {
  ACTIVOS_HEADER_TITLE,
  ACTIVOS_QUICK_OFF_ARIA,
  ACTIVOS_DIALOG_TITLE,
} from "../lib/admin-activos-lock"
import {
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  FORBIDDEN_GENERATE_PROVIDER_RE,
  isAllowedGenerationModel,
} from "../lib/generation-model-lock"

describe("continuity guards", () => {
  it("keeps the Activos passthrough (allowlist ∪ isActive) in the catalog SSOT", () => {
    const catalog = readFileSync("backend/src/services/visible-model-catalog.js", "utf8")
    const admin = readFileSync("app/admin/models/page.tsx", "utf8")
    assert.match(catalog, /activar = visible/)
    assert.match(catalog, /const passthrough = \[\]/)
    assert.match(catalog, /isActive === false/)
    assert.match(admin, new RegExp(ACTIVOS_DIALOG_TITLE))
    assert.match(admin, new RegExp(`title="${ACTIVOS_HEADER_TITLE}"`))
    assert.match(admin, new RegExp(`aria-label="${ACTIVOS_QUICK_OFF_ARIA}"`))
    assert.match(admin, /activosOpen/)
  })

  it("locks generate pickers to DeepSeek Flash/Pro and rejects OpenRouter", () => {
    assert.equal(isAllowedGenerationModel("deepseek-v4-flash", "DeepSeek"), true)
    assert.equal(isAllowedGenerationModel("deepseek-v4-pro", "DeepSeek"), true)
    assert.equal(isAllowedGenerationModel("openai/gpt-4o-mini", "OpenRouter"), false)
    assert.ok(FORBIDDEN_GENERATE_PROVIDER_RE.test("OpenRouter"))
    assert.equal(DEEPSEEK_FLASH, "deepseek-v4-flash")
    assert.equal(DEEPSEEK_PRO, "deepseek-v4-pro")
    const chat = readFileSync("lib/chat/catalog-model.ts", "utf8")
    const code = readFileSync("lib/code-agent/model-policy.ts", "utf8")
    assert.match(chat, /generation-model-lock/)
    assert.match(code, /generation-model-lock/)
  })

  it("keeps OpenSpec instruction skills on disk", () => {
    const names = [
      "openspec-apply-change",
      "openspec-archive-change",
      "openspec-explore",
      "openspec-propose",
      "openspec-sync-specs",
      "openspec-update-change",
    ]
    for (const name of names) {
      assert.match(readFileSync(`backend/src/skills/${name}/SKILL.md`, "utf8"), /^description:/m)
    }
    assert.match(
      readFileSync("backend/src/services/agent-runner/skills/index.js", "utf8"),
      /openspecSkillsRoot/,
    )
  })

  it("keeps the Pensando stepper wired in chat", () => {
    const trace = readFileSync("components/thinking-trace.tsx", "utf8")
    const placeholder = readFileSync("components/thinking-placeholder.tsx", "utf8")
    const message = readFileSync("components/message-component.tsx", "utf8")
    assert.match(trace, /ClaudeThinkingTimeline/)
    assert.match(placeholder, /Pensando/)
    assert.match(message, /ThinkingPlaceholder/)
    assert.match(message, /ThinkingTrace/)
  })

  it("anchors the /code chrome lock SSOT", () => {
    assert.equal(CODE_CHROME_LOCK.showForbiddenCompanyNav, false)
    assert.equal(CODE_CHROME_LOCK.showRunPublishButtons, false)
    assert.deepEqual([...CODE_FORBIDDEN_DESKTOP_NAV_LABELS], ["Panel", "Controlar", "Archivos", "Recursos"])
    assert.deepEqual([...CODE_FORBIDDEN_TOPBAR_ACTIONS], ["Ejecutar", "Publicar"])
    assert.ok(CODE_KEPT_SURFACES.includes("Routines"))
    assert.ok(CODE_KEPT_SURFACES.includes("Computadora"))
  })

  it("keeps EmptyChat null on mobile and useResolvedMobile on /code", () => {
    const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
    const mobile = readFileSync("hooks/use-mobile.tsx", "utf8")
    assert.match(chat, /useResolvedMobile/)
    assert.match(chat, /isMobileGrok \? null/)
    assert.match(mobile, /export function useResolvedMobile/)
  })

  it("keeps the doc-engine hook, SDIE flag, ChunkLoad helper, and ACS mounts", () => {
    const edit = readFileSync("backend/src/services/source-preserving-document-edit.js", "utf8")
    const index = readFileSync("backend/index.js", "utf8")
    const sdie = readFileSync("backend/src/services/sdie/flags.js", "utf8")
    const codeError = readFileSync("app/code/error.tsx", "utf8")
    const caddy = readFileSync("deploy/Caddyfile", "utf8")
    assert.match(edit, /tryDocEngineAfterSelection/)
    assert.match(index, /\/api\/documents/)
    assert.match(index, /\/api\/agent-computer/)
    assert.match(sdie, /FEATURE_SDIE_V2/)
    assert.match(codeError, /maybeReloadStaleClientBundle/)
    assert.match(caddy, /\/agent-computer/)
  })

  it("runs the CI assert script successfully against this tree", () => {
    execFileSync("node", ["scripts/assert-continuity-guards.js"], { stdio: "pipe" })
    execFileSync("bash", ["scripts/reapply-code-ui-lock.sh", "--check"], { stdio: "pipe" })
  })
})
