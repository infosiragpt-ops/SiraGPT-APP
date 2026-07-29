import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildSelectedElementPrompt,
  extractInstructionFromComposer,
  selectedElementChipLabel,
  type CodePreviewSelectionDetail,
} from "../lib/code-preview-selection"

const sample: CodePreviewSelectionDetail = {
  selectionMethod: "dom",
  selector: "button.cta",
  tagName: "button",
  text: "Empezar gratis",
  className: "cta primary",
  id: "hero-cta",
  parent: {
    selector: "section.hero",
    tagName: "section",
    text: "Hero",
  },
  rect: { x: 12, y: 40, width: 160, height: 44 },
  previewKind: "html",
  entry: "index.html",
  activePath: "index.html",
}

describe("code-preview-selection helpers", () => {
  it("builds a chip label from selector + visible text", () => {
    assert.equal(selectedElementChipLabel(sample), 'button.cta · “Empezar gratis”')
    assert.equal(
      selectedElementChipLabel({ tagName: "div", selector: "div.card" }),
      "div.card",
    )
  })

  it("keeps free-form composer text and peels prior selection dumps", () => {
    assert.equal(extractInstructionFromComposer("hazlo azul"), "hazlo azul")

    const dumped = buildSelectedElementPrompt(sample, "hazlo más grande")
    assert.match(dumped, /selector CSS: button\.cta/)
    assert.match(dumped, /Cambio solicitado por el usuario:\nhazlo más grande/)
    assert.equal(extractInstructionFromComposer(dumped), "hazlo más grande")
  })

  it("requires a user instruction section even when empty", () => {
    const dumped = buildSelectedElementPrompt(sample, "   ")
    assert.match(dumped, /Cambio solicitado:\n/)
    assert.equal(extractInstructionFromComposer(dumped), "")
  })
})
