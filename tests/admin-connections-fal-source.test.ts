import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const pagePath = path.join(process.cwd(), "app", "admin", "connections", "page.tsx")
const source = fs.readFileSync(pagePath, "utf8")

describe("admin connections fal.ai source contract", () => {
  it("exposes fal.ai as a first-class video provider in the connection dialog", () => {
    assert.match(source, /key: "fal", label: "fal\.ai Video API"/)
    assert.match(source, /fal: \{ url: "https:\/\/api\.fal\.ai\/v1", authType: "Key", apiType: "video" \}/)
    assert.match(source, /<SelectItem value="Key">Key<\/SelectItem>/)
    assert.match(source, /<SelectItem value="video">Video Generation<\/SelectItem>/)
  })

  it("offers a direct add fal.ai action from the connections header", () => {
    assert.match(source, /onClick=\{\(\) => openAdd\("fal"\)\}/)
    assert.match(source, /Agregar fal\.ai/)
  })
})
