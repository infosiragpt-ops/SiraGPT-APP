import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceAfter(marker: string): string {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing marker: ${marker}`)
  return source.slice(start)
}

describe("mobile model selector source contract", () => {
  it("keeps the default phone model picker static so iOS does not zoom or open the keyboard", () => {
    const defaultSelector = sliceAfter("// Default model selector for regular chats")
    const contentStart = defaultSelector.indexOf("<DropdownMenuContent")
    const contentEnd = defaultSelector.indexOf("</DropdownMenuContent>", contentStart)
    assert.notEqual(contentStart, -1, "missing default model picker content")
    assert.notEqual(contentEnd, -1, "missing default model picker content end")
    const content = defaultSelector.slice(contentStart, contentEnd)

    assert.doesNotMatch(
      content,
      /autoFocus/,
      "the model search input must not autofocus; autofocus opens the iOS keyboard and zooms the viewport"
    )
    assert.match(
      content,
      /className="[^"]*sm:hidden[^"]*"[^>]*>[\s\S]*Modelos de IA/,
      "phone layout should render a static mobile header instead of focusing a search field"
    )
    assert.match(
      content,
      /className="[^"]*hidden[^"]*sm:block[^"]*"[\s\S]*placeholder="Buscar modelos"/,
      "the searchable input should be desktop/tablet-only, leaving phones as a simple static list"
    )
    assert.match(
      content,
      /className="[^"]*text-base[^"]*sm:text-\[13px\][^"]*"/,
      "when search is visible on larger screens, its font must stay at least 16px before sm to avoid iOS input zoom"
    )
  })
})
