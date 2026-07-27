import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "app", "gpts", "create", "page.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceAround(marker: string, before = 300, after = 700): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, `missing marker: ${marker}`)
  return source.slice(Math.max(0, index - before), index + marker.length + after)
}

describe("GPT builder layout and capabilities", () => {
  it("keeps the desktop preview fixed while configuration owns vertical scrolling", () => {
    assert.match(
      sliceAround('aria-label="Campos de configuración del GPT"'),
      /lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain/,
    )
    assert.match(
      sliceAround("RIGHT — Vista previa"),
      /lg:h-full lg:min-h-0 lg:overflow-hidden lg:flex-col/,
    )
    assert.match(source, /lg:h-full lg:min-h-0 lg:overflow-hidden/)
  })

  it("exposes Docs and Skills as persisted GPT capabilities", () => {
    assert.match(source, /key: "documents"[\s\S]{0,120}label: "Docs"/)
    assert.match(source, /key: "skillsEnabled"[\s\S]{0,120}label: "Skills"/)
    assert.match(source, /documents: gpt\.capabilities\?\.documents \?\? true/)
    assert.match(source, /skillsEnabled: gpt\.capabilities\?\.skillsEnabled \?\? true/)
  })
})
