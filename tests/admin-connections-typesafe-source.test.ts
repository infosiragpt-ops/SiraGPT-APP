import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const pagePath = path.join(process.cwd(), "app", "admin", "connections", "page.tsx")
const source = fs.readFileSync(pagePath, "utf8")

describe("admin connections TypeSafe provider", () => {
  it("lists TypeSafe in the available-providers list and quick pick", () => {
    assert.match(source, /\{ key: "typesafe", label: "TypeSafe" \}/)
    assert.match(source, /\{ key: "typesafe", label: "TypeSafe AI API \(Jev, decisiones\)" \}/)
  })

  it("pre-fills the TypeSafe API host with Bearer auth", () => {
    assert.match(
      source,
      /typesafe: \{ url: "https:\/\/api\.typesafe\.ai\/v1", authType: "Bearer", apiType: "chat_completions" \}/,
    )
  })

  it("infers TypeSafe from the api.typesafe.ai host", () => {
    assert.match(source, /typesafe\.ai/)
    assert.match(source, /return "typesafe"/)
  })
})

describe("model icons TypeSafe provider", () => {
  const iconsSource = fs.readFileSync(path.join(process.cwd(), "lib", "model-icons.ts"), "utf8")
  const providerSource = fs.readFileSync(path.join(process.cwd(), "components", "icon-provider.tsx"), "utf8")

  it("groups typesafe/jev models under TypeSafe with their own logo", () => {
    assert.match(iconsSource, /"TypeSafe",/)
    assert.match(iconsSource, /return "TypeSafeLogo"/)
    assert.match(providerSource, /TypeSafeLogo: \{ type: 'png', imagePath: '\/icons\/typesafe\.svg', preserveColor: true \}/)
    assert.ok(fs.existsSync(path.join(process.cwd(), "public", "icons", "typesafe.svg")))
  })
})
