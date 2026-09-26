import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const pageSource = readFileSync(path.join(process.cwd(), "app/admin/connections/page.tsx"), "utf8")

function keysOf(constName: string): string[] {
  const start = pageSource.indexOf(`const ${constName}`)
  assert.ok(start >= 0, `${constName} must exist`)
  const end = pageSource.indexOf("\n]", start)
  return [...pageSource.slice(start, end).matchAll(/key: "([a-z0-9]+)"/g)].map((m) => m[1])
}

test("every connectable provider has a quick-pick chip in Add Connection", () => {
  // A provider the backend bridge supports but that is missing from QUICK_PICK
  // is invisible in the dialog (DeepSeek was: the key could not be added).
  const providers = keysOf("PROVIDERS").filter((key) => key !== "custom")
  const quickPick = new Set(keysOf("QUICK_PICK"))
  const missing = providers.filter((key) => !quickPick.has(key))
  assert.deepEqual(missing, [], `providers without a chip: ${missing.join(", ")}`)
})

test("DeepSeek chip pre-fills the official endpoint", () => {
  assert.match(pageSource, /\{ key: "deepseek", label: "DeepSeek" \}/)
  assert.match(pageSource, /deepseek: \{ url: "https:\/\/api\.deepseek\.com\/v1", authType: "Bearer", apiType: "chat_completions" \}/)
})
