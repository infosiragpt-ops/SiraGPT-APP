import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceAround(marker: string, before = 800, after = 800): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, `missing marker: ${marker}`)
  return source.slice(Math.max(0, index - before), index + marker.length + after)
}

describe("custom GPT chat menu ownership contract", () => {
  it("hides edit/configuration actions unless the current user owns the GPT", () => {
    assert.match(
      source,
      /const isCustomGptOwner = Boolean\(user\?\.id && customGptCreatorId && customGptCreatorId === user\.id\)/,
      "the GPT menu must derive ownership from backend creator metadata"
    )

    assert.match(
      sliceAround("Configurar GPT..."),
      /isCustomGptOwner && \([\s\S]*Configurar GPT\.\.\./,
      "the model submenu Configure GPT action must be owner-only"
    )

    assert.match(
      sliceAround("Configuración de privacidad"),
      /isCustomGptOwner && \([\s\S]*Configuración de privacidad/,
      "privacy configuration must be owner-only"
    )

    assert.match(
      sliceAround(">Configurar</Button>"),
      /isCustomGptOwner && customGpt\?\.id && <Button/,
      "the about dialog configure button must be owner-only"
    )
  })

  it("renders uploaded GPT icons through the backend image resolver", () => {
    assert.match(
      source,
      /import \{ resolveGptIconImageUrl \} from "@\/lib\/gpt-icon-url"/,
      "the chat bar should reuse the GPT icon resolver"
    )
    assert.match(
      source,
      /const customGptIconSrc = resolveGptIconImageUrl\(customGptIcon,/,
      "the active GPT icon should resolve /uploads/gpt-icons URLs as images"
    )
  })
})
