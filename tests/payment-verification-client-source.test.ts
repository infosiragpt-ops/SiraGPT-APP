import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const copies = [
  {
    name: "root",
    api: path.join(root, "lib", "api.ts"),
    page: path.join(root, "app", "payment", "success", "page.tsx"),
  },
  {
    name: "nested",
    api: path.join(root, "siraGPT", "lib", "api.ts"),
    page: path.join(root, "siraGPT", "app", "payment", "success", "page.tsx"),
  },
]

describe("payment verification client contract", () => {
  for (const copy of copies) {
    it(`${copy.name} client fulfills sessions through POST`, () => {
      const source = readFileSync(copy.api, "utf8")
      const method = source.match(
        /async verifyPaymentSession\(sessionId: string\)\s*\{([\s\S]*?)\n\s*\}/,
      )?.[1] || ""

      assert.match(method, /['"]\/payments\/verify-session['"]/)
      assert.match(method, /method:\s*['"]POST['"]/)
      assert.match(method, /body:\s*JSON\.stringify\(\{\s*session_id:\s*sessionId\s*\}\)/)
      assert.doesNotMatch(method, /verify-session\?session_id=/)
    })

    it(`${copy.name} success page uses the CSRF-aware API client`, () => {
      const source = readFileSync(copy.page, "utf8")

      assert.match(source, /apiClient\.verifyPaymentSession\(sessionId\)/)
      assert.doesNotMatch(source, /fetch\([^)]*payments\/verify-session/)
    })
  }
})
