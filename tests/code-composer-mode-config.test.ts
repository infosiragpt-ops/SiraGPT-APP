import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  COMPOSER_MODE_INSTRUCTION,
  COMPOSER_MODE_LABEL,
  COMPOSER_PLACEHOLDER,
} from "../lib/code-agent/composer-mode-config"
import { APPS_RUNTIME_STACK } from "../lib/code-agent/apps-mode-contract"
import type { ComposerMode } from "../lib/code-agent/types"

const MODES: readonly ComposerMode[] = ["app", "build", "deps", "plan", "debug", "ask", "image"]

describe("code composer mode configuration", () => {
  it("defines label, placeholder, and instruction for every supported mode", () => {
    for (const mode of MODES) {
      assert.ok(COMPOSER_MODE_LABEL[mode])
      assert.ok(COMPOSER_PLACEHOLDER[mode])
      assert.ok(COMPOSER_MODE_INSTRUCTION[mode])
    }
  })

  it("keeps App mode aligned with the executable APPS stream contract", () => {
    const instruction = COMPOSER_MODE_INSTRUCTION.app
    assert.match(instruction, /SOFTWARE FULL-STACK profesional/)
    assert.ok(instruction.includes(APPS_RUNTIME_STACK.frontend))
    assert.ok(instruction.includes(APPS_RUNTIME_STACK.api))
    assert.ok(instruction.includes(APPS_RUNTIME_STACK.database))
    assert.match(instruction, /package\.json/)
    assert.match(instruction, /tipos\/tests\/build/)
  })

  it("keeps Ask and Plan explicitly read-only", () => {
    assert.match(COMPOSER_MODE_INSTRUCTION.ask, /NO modifiques ni generes archivos/)
    assert.match(COMPOSER_MODE_INSTRUCTION.plan, /no cambies archivos/)
  })
})
