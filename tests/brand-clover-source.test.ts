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
  it("ships the clover SVG for documents, and the atom as favicon, PWA icons and manifest (Luis, 2026-10-02)", () => {
    const svg = source("public/brand/clover.svg")
    assert.match(svg, /fill="currentColor"/)
    assert.match(svg, /viewBox="0 0 512 512"/)
    // Browser tab + PWA icons are the atom on a white tile; the clover PNGs are gone.
    const icon = source("public/icon.svg")
    assert.doesNotMatch(icon, /<image|#2E7D32/i)
    assert.match(icon, /M370 200A170 62 0 1 1 30 200A170 62 0 1 1 370 200/)
    assert.equal((icon.match(/rotate\((-90|30|150) 200 200\)/g) || []).length, 3)
    for (const rel of ["public/favicon.ico", "public/sira-gpt-192.png", "public/sira-gpt-512.png", "public/sira-gpt-180.png", "public/apple-touch-icon.png", "public/brand/atom-maskable-512.png"]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`)
    }
    assert.ok(!fs.existsSync(path.join(root, "public/brand/clover-maskable-512.png")))
    assert.ok(!fs.existsSync(path.join(root, "public/brand/clover-512.png")))
    const manifest = JSON.parse(source("public/manifest.webmanifest"))
    assert.equal(manifest.theme_color, "#ffffff")
    assert.equal(manifest.background_color, "#ffffff")
    assert.ok(manifest.icons.some((i: { src: string; purpose?: string }) => i.src === "/brand/atom-maskable-512.png" && i.purpose === "maskable"))
    assert.ok(!manifest.icons.some((i: { src: string }) => i.src.includes("clover")))
    // Cache-busted icon URLs so browsers drop the cached clover favicon.
    const layout = source("app/layout.tsx")
    assert.match(layout, /\{ url: "\/favicon\.ico\?v=atom", sizes: "any" \}/)
    assert.match(layout, /\/sira-gpt-180\.png\?v=atom/)
    assert.match(source("public/sw.js"), /'\/brand\/atom\.svg'/)
    assert.doesNotMatch(source("public/sw.js"), /clover/)
  })

  it("keeps CloverMark for the PWA/document assets and uses the atom mark for every in-app logo render", () => {
    const mark = source("components/brand/clover-mark.tsx")
    assert.match(mark, /export function CloverMark/)
    assert.match(mark, /export function CloverBadge/)
    assert.match(mark, /fill="currentColor"/)
    assert.match(mark, /var\(--clover-vein, #fff\)/)
    assert.match(source("components/brand/index.ts"), /export \{ CloverMark, CloverBadge \} from "\.\/clover-mark"/)
    assert.match(source("components/brand/index.ts"), /export \{ AtomMark \} from "\.\/atom-mark"/)
    assert.doesNotMatch(source("components/brand/index.ts"), /knot-mark/)
    // Luis (2026-10-02): the in-app brand mark is the atom — three elliptical
    // orbits (−90° / 30° / 150°) with one electron each around a solid
    // nucleus, pure vector geometry in currentColor («tinta»), each ring with
    // a dash gap centred on its electron — never a traced raster.
    const atom = source("components/brand/atom-mark.tsx")
    assert.match(atom, /export function AtomMark/)
    assert.match(atom, /data-brand="atom"/)
    assert.match(atom, /stroke="currentColor"/)
    assert.match(atom, /const ORBIT_ANGLES = \[-90, 30, 150\] as const/)
    assert.match(atom, /strokeDasharray=\{dashArray\}/)
    assert.match(atom, /r=\{w\.nucleus\} fill="currentColor"/)
    assert.doesNotMatch(atom, /<image|data:image/)
    const asset = source("public/brand/atom.svg")
    assert.match(asset, /viewBox="0 0 400 400"/)
    assert.match(asset, /stroke="currentColor"/)
    assert.match(asset, /stroke-dasharray="716\.9 52" stroke-dashoffset="742\.9"/)
    assert.equal((asset.match(/<circle cx="370" cy="200" r="13"/g) || []).length, 3)
    // The five-loop knot (2026-10-01) is gone: one in-app brand mark only.
    assert.ok(!fs.existsSync(path.join(root, "components/brand/knot-mark.tsx")))
    assert.ok(!fs.existsSync(path.join(root, "public/brand/knot.svg")))
    const css = source("app/globals.css")
    assert.doesNotMatch(css, /--knot-gap/)
    for (const rel of [
      "components/BrandLogo.tsx",
      "components/app-sidebar.tsx",
      "components/PWAInstallPrompt.tsx",
      "components/BrandCycle.tsx",
      "app/auth/login/page.tsx",
      "app/auth/register/page.tsx",
      "app/auth/forgot-password/page.tsx",
      "app/auth/reset-password/page.tsx",
      "app/auth/reset/[token]/page.tsx",
    ]) {
      const src = source(rel)
      assert.match(src, /import \{ AtomMark \} from "@\/components\/brand"/, `${rel} imports AtomMark`)
      assert.match(src, /<AtomMark/, `${rel} renders AtomMark`)
      assert.doesNotMatch(src, /<CloverMark|KnotMark/, `${rel} renders neither the clover nor the knot`)
    }
  })

  // Luis (2026-09-29): the interface is black & white — the in-app brand ink
  // is near-black on light and near-white on dark (the PWA icon, emails and
  // generated documents keep the clover green asset).
  it("uses a monochrome ink as the in-app brand accent in both themes; the thinking atom is ink only (red on error)", () => {
    const css = source("app/globals.css")
    assert.match(css, /--brand: #0A0A0A;/)
    assert.match(css, /--brand: #FAFAFA;/)
    // The thinking glyph — its three electrons — is the foreground (black on light, white on dark), in both
    // themes (Luis, 2026-10-03: monochrome; the electron colour tokens of 2026-10-02 are gone). Red only on error.
    assert.equal((css.match(/--think-accent: hsl\(var\(--foreground\)\);/g) || []).length, 2)
    assert.doesNotMatch(css, /--think-accent: #(2E7D32|66BB6A);/i)
    assert.doesNotMatch(css, /--think-electron-[abc]:/)
    assert.match(css, /--clover-vein: #ffffff;/)
    assert.match(css, /--accent-violet: 0 0% 4%;/)
    assert.match(css, /--accent-violet: 0 0% 96%;/)
    assert.doesNotMatch(css, /--brand: #(7c5cff|5b4dff);/i)
    assert.match(source("lib/thinking-loaders.ts"), /export const CLAUDE_THINK_ACCENT = "currentColor"/)
    // The thinking glyph is the ThinkingCore (the atom in motion, not the clover), drawn in the think accent.
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /data-brand="thinking-core"/)
    assert.doesNotMatch(asterisk, /data-brand="clover"/)
    assert.match(asterisk, /export function ClaudeAsterisk/)
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
    assert.match(core, /data-brand-geometry="atom"/)
    assert.doesNotMatch(core, /--think-electron-/)
    assert.match(core, /tone = "default"/)
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
