import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const pagePath = path.join(process.cwd(), "app", "admin", "connections", "page.tsx")
const source = fs.readFileSync(pagePath, "utf8")

describe("admin connections Meta provider", () => {
  it("lists Meta in the available-providers quick pick", () => {
    assert.match(source, /\{ key: "meta", label: "Meta" \}/)
    assert.match(source, /\{ key: "meta", label: "Meta Model API" \}/)
  })

  it("pre-fills Meta Model API as OpenAI-compatible chat completions", () => {
    assert.match(source, /https:\/\/api\.meta\.ai\/v1/)
    assert.match(
      source,
      /meta: \{ url: "https:\/\/api\.meta\.ai\/v1", authType: "Bearer", apiType: "chat_completions" \}/,
    )
  })

  it("infers Meta from first-party Meta / Llama API hosts", () => {
    assert.match(source, /api\.meta\.ai/)
    assert.match(source, /llama-api\.meta\.com/)
    assert.match(source, /return "meta"/)
  })
})
