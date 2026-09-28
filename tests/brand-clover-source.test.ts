import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const source = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8")

const IGNORED_DIRS = new Set(["node_modules", "siraGPT", "upstream", ".next", ".test-dist"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(abs)
  }
  return out
}

describe("Clover brand (four-leaf clover mark + green accent)", () => {
  it("ships the clover SVG asset drawn with currentColor and the web manifest in clover green", () => {
    const svg = source("public/brand/clover.svg")
    assert.match(svg, /fill="currentColor"/)
    assert.match(svg, /viewBox="0 0 512 512"/)
    assert.ok(fs.existsSync(path.join(root, "public/brand/clover-maskable-512.png")))
    const manifest = JSON.parse(source("public/manifest.webmanifest"))
    assert.equal(manifest.theme_color, "#2E7D32")
    assert.equal(manifest.background_color, "#ffffff")
    assert.ok(manifest.icons.some((i: { src: string; purpose?: string }) => i.src === "/brand/clover-maskable-512.png" && i.purpose === "maskable"))
    const icon = source("public/icon.svg")
    assert.doesNotMatch(icon, /<image/)
    assert.match(icon, /#2E7D32/)
    assert.match(source("public/sw.js"), /'\/brand\/clover\.svg'/)
  })

  it("exposes CloverMark and uses it for every logo render (sidebar, header logo, auth pages)", () => {
    const mark = source("components/brand/clover-mark.tsx")
    assert.match(mark, /export function CloverMark/)
    assert.match(mark, /export function CloverBadge/)
    assert.match(mark, /fill="currentColor"/)
    assert.match(mark, /var\(--clover-vein, #fff\)/)
    assert.match(source("components/brand/index.ts"), /export \{ CloverMark, CloverBadge \} from "\.\/clover-mark"/)
    for (const rel of [
      "components/BrandLogo.tsx",
      "components/app-sidebar.tsx",
      "app/auth/login/page.tsx",
      "app/auth/register/page.tsx",
    ]) {
      const src = source(rel)
      assert.match(src, /import \{ CloverMark \} from "@\/components\/brand"/, `${rel} imports CloverMark`)
      assert.match(src, /<CloverMark/, `${rel} renders CloverMark`)
    }
  })

  it("uses the clover green as the brand accent in both themes; the thinking glyph is monochrome", () => {
    const css = source("app/globals.css")
    assert.match(css, /--brand: #2E7D32;/)
    assert.match(css, /--brand: #66BB6A;/)
    // The thinking glyph is the foreground (black on light, white on dark), in both themes.
    assert.equal((css.match(/--think-accent: hsl\(var\(--foreground\)\);/g) || []).length, 2)
    assert.doesNotMatch(css, /--think-accent: #(2E7D32|66BB6A);/i)
    assert.match(css, /--clover-vein: #ffffff;/)
    assert.match(css, /--accent-violet: 123 46% 34%;/)
    assert.match(css, /--accent-violet: 122 39% 49%;/)
    assert.doesNotMatch(css, /--brand: #(7c5cff|5b4dff);/i)
    assert.match(source("lib/thinking-loaders.ts"), /export const CLAUDE_THINK_ACCENT = "currentColor"/)
    // The thinking glyph is the ThinkingCore (not the clover), drawn in the monochrome think accent.
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /data-brand="thinking-core"/)
    assert.doesNotMatch(asterisk, /data-brand="clover"/)
    assert.match(asterisk, /export function ClaudeAsterisk/)
    assert.match(source("components/brand/thinking-core.tsx"), /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
  })

  it("leaves no raster sira-gpt.png logo render under app/ and components/", () => {
    const offenders: string[] = []
    for (const dir of ["app", "components"]) {
      for (const file of walk(path.join(root, dir))) {
        const src = fs.readFileSync(file, "utf8")
        if (/<(Image|img)\b[^>]*src=["']\/sira-gpt\.png["']/.test(src) || /<(Image|img)\b[^>]*\n[^>]*src=["']\/sira-gpt\.png["']/.test(src)) {
          offenders.push(path.relative(root, file))
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  it("brands transactional emails and generated documents in clover green", () => {
    const email = source("backend/src/services/email.js")
    assert.doesNotMatch(email, /#667eea/i)
    assert.doesNotMatch(email, /#3498db/i)
    assert.match(email, /linear-gradient\(135deg, #2E7D32 0%, #1B5E20 100%\)/)
    const pipeline = source("backend/src/services/document-pipeline/advanced-document-pipeline.js")
    assert.match(pipeline, /buildCoverAccentPng\(accent = '2E7D32', accent2 = '66BB6A'\)/)
  })
})
