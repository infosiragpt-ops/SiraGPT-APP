import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const composer = readFileSync(path.join(process.cwd(), "components/chat-interface-enhanced.tsx"), "utf8")

test("picker rows flag a provider without credit as «Sin saldo» but keep it selectable", () => {
  assert.match(composer, /const noCredit = model\.billingStatus === "sin_saldo" && !isComingSoon;/)
  assert.match(composer, /data-testid="model-picker-no-credit"/)
  assert.match(composer, />\s*Sin saldo\s*</)
  assert.match(composer, /SiraGPT responde con otro modelo y te lo indica/)
  // Selectable: the row is only disabled for «Pronto» models.
  assert.match(composer, /disabled=\{isComingSoon\}/)
  assert.match(composer, /\[label, noCredit \? "Sin saldo" : "", tagline\]/)
})
