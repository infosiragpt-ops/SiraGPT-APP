#!/usr/bin/env node
/**
 * Extract the deterministic /code Vite landing scaffold to a directory so it
 * can be boot-tested outside the app (docs/code/plan.md · verification B):
 *
 *   npx tsc -p tests/tsconfig.json
 *   node scripts/extract-code-scaffold.cjs /tmp/scaffold-check
 *   cd /tmp/scaffold-check && npm install && npm run build && npx tsc --noEmit
 *
 * Requires the compiled test tier (.test-dist) — run the tsc step first.
 */
const fs = require("node:fs")
const path = require("node:path")

const target = process.argv[2] || ".scaffold-check"
const { buildViteLandingFiles } = require(path.join(__dirname, "..", ".test-dist", "lib", "code-agent", "vite-scaffold.js"))

const ctx = {
  goal: "landing",
  productType: process.argv[3] || "cafetería de especialidad",
  brand: process.argv[4] || "Café Aurora",
  styleAudience: process.argv[5] || "premium oscuro",
}

const files = buildViteLandingFiles(ctx)
for (const f of files) {
  const out = path.join(target, f.path)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, f.content)
}
console.log(`[extract-code-scaffold] wrote ${files.length} files to ${target}`)
