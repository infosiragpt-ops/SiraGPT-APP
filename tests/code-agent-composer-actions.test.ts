import { test } from "node:test"
import assert from "node:assert/strict"

import {
  COMPOSER_QUICK_ACTIONS,
  getComposerQuickAction,
  type ComposerQuickActionId,
} from "../lib/code-agent/composer-actions"

const REQUIRED_ACTIONS: ComposerQuickActionId[] = [
  "app-from-scratch",
  "build-change",
  "plan-architecture",
  "debug-preview",
  "ask-workspace",
  "image-design",
  "skills-implementation",
  "skills-debugging",
  "skills-review",
  "mcp-workspace",
  "mcp-code-tools",
  "mcp-integrations",
]

test("composer quick actions cover every menu option with actionable prompts", () => {
  assert.deepEqual(Object.keys(COMPOSER_QUICK_ACTIONS).sort(), [...REQUIRED_ACTIONS].sort())

  for (const id of REQUIRED_ACTIONS) {
    const action = getComposerQuickAction(id)
    assert.equal(action.id, id)
    assert.ok(action.prompt.length > 40, `${id} prompt should be actionable`)
    assert.equal(action.includeContext, true, `${id} should keep workspace context on`)
    assert.ok(action.toast.length > 10, `${id} should give user feedback`)
  }
})

test("app action builds from scratch instead of acting as a passive mode switch", () => {
  const action = getComposerQuickAction("app-from-scratch")

  assert.equal(action.mode, "app")
  assert.match(action.prompt, /Construye una app web completa desde cero/i)
  assert.match(action.prompt, /preview/i)
})

test("skills submenu opens the skills tool and seeds specific agent work", () => {
  const implementation = getComposerQuickAction("skills-implementation")
  const debugging = getComposerQuickAction("skills-debugging")
  const review = getComposerQuickAction("skills-review")

  assert.equal(implementation.toolId, "skills")
  assert.equal(debugging.toolId, "skills")
  assert.equal(review.toolId, "skills")
  assert.equal(implementation.mode, "plan")
  assert.equal(debugging.mode, "debug")
  assert.equal(review.mode, "ask")
  assert.match(implementation.prompt, /skill principal/i)
  assert.match(debugging.prompt, /hip[oó]tesis/i)
  assert.match(review.prompt, /bugs, riesgos funcionales/i)
})

test("mcp submenu opens concrete workspace tools instead of only changing labels", () => {
  const workspace = getComposerQuickAction("mcp-workspace")
  const codeTools = getComposerQuickAction("mcp-code-tools")
  const integrations = getComposerQuickAction("mcp-integrations")

  assert.equal(workspace.toolId, "developer")
  assert.equal(codeTools.toolId, "workflows")
  assert.equal(integrations.toolId, "integrations")
  assert.match(workspace.prompt, /workspace local/i)
  assert.match(codeTools.prompt, /build, run, terminal/i)
  assert.match(integrations.prompt, /MCP Servers, conectores e integraciones/i)
})
