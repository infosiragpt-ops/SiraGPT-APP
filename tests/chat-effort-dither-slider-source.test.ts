import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8")

const ditherTrack = read("components", "chat", "effort-dither-track.tsx")
const effortMenu = read("components", "chat", "composer-effort-menu.tsx")
const globals = read("app", "globals.css")
const chatInterface = read("components", "chat-interface-enhanced.tsx")
const attachmentIngest = read("lib", "attachment-ingest.ts")

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = globals.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `${selector} must exist in globals.css`)
  return match![1]
}

describe("effort slider — dithered pixel-dissolve contract", () => {
  it("builds the dissolve from SVG patterns and gradient masks, never a raster asset", () => {
    assert.match(ditherTrack, /<pattern[\s\S]{0,200}patternUnits="userSpaceOnUse"/, "pixels must tile in user space so they stay square at any width")
    assert.match(ditherTrack, /<linearGradient[\s\S]{0,80}x1="0" y1="0" x2="1" y2="0"/, "each layer fades in along the x axis")
    assert.match(ditherTrack, /<mask[\s\S]{0,120}maskUnits="userSpaceOnUse"/, "masks resolve against the full track")
    assert.doesNotMatch(ditherTrack, /<image|\.png|\.jpg|\.webp|data:image/i, "the effect must be generated, not a static image")
    assert.match(ditherTrack, /shape-rendering|effort-dither-px/, "pixel rects carry the crisp-edge class")
    assert.match(ditherTrack, /mulberry32|Fisher|seed/i, "cell ordering must be seeded so SSR and client markup match")
  })

  it("mounts the dither inside the fill and renders a capsule thumb on the track", () => {
    assert.match(effortMenu, /import \{ EffortDitherTrack \} from "@\/components\/chat\/effort-dither-track"/)
    assert.match(
      effortMenu,
      /<span className="effort-track-fill">\s*<EffortDitherTrack className="effort-dither" \/>\s*<\/span>/,
      "the dither is the fill's only child so clip-path reveals it up to the thumb",
    )
    assert.match(effortMenu, /<span className="effort-thumb" data-testid="composer-effort-thumb" aria-hidden \/>/)
    assert.match(effortMenu, /data-stop=\{String\(index\)\}/, "stops expose their index so CSS can place tick marks")
  })

  it("styles a fully rounded grey→violet rail with a white capsule thumb", () => {
    const track = ruleBody(".effort-track")
    assert.match(track, /border-radius: 999px;/)
    assert.match(track, /--effort-violet: hsl\(26\d /, "the dissolve resolves to violet")
    assert.match(track, /--effort-rail: hsl\(220 10% 92%\)/, "the rail starts grey")
    assert.match(track, /--effort-x: calc\(/, "thumb centre is a single shared expression")

    const fill = ruleBody(".effort-track-fill")
    assert.match(fill, /clip-path: inset\(0 calc\(100% - var\(--effort-x\)\) 0 0\);/, "reveal is a clip, so the dissolve stays anchored to the full rail")
    assert.match(fill, /transition: clip-path/)

    const thumb = ruleBody(".effort-thumb")
    assert.match(thumb, /border-radius: 999px;/, "capsule")
    assert.match(thumb, /background: #ffffff;/, "white")
    assert.match(thumb, /border: 1px solid hsl\(220 12% 82% \/ 0\.9\);/, "very subtle hairline border")
    assert.match(thumb, /box-shadow:\s*0 1px 2px hsl\(220 25% 10% \/ 0\.14\),\s*0 3px 8px -2px hsl\(220 25% 10% \/ 0\.2\);/, "soft shadow")
    assert.match(thumb, /left: var\(--effort-x\);/)

    for (const cls of [".effort-dither {", ".effort-dither-base {", ".effort-dither-px {", ".dark .effort-track {", ".dark .effort-thumb {"]) {
      assert.ok(globals.includes(cls), `${cls} must exist`)
    }
    assert.match(globals, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.effort-track-fill,\s*\.effort-thumb,\s*\.effort-dither-twinkle,/, "reduced motion freezes fill + thumb + pixels")
    assert.ok(!globals.includes(".effort-track-fill::after {"), "the old striped neon overlay must be gone")
  })
})

describe("effort slider — living pixels", () => {
  it("twinkles only the sparse layers with position-derived delays", () => {
    assert.match(ditherTrack, /const TWINKLE_LAYERS = 3/, "dense grid + solid cap stay static")
    assert.match(
      ditherTrack,
      /className=\{twinkle \? "effort-dither-px effort-dither-twinkle" : "effort-dither-px"\}/,
    )
    assert.match(
      ditherTrack,
      /style=\{twinkle \? \{ animationDelay: `\$\{twinkleDelayS\(col, row\)\.toFixed\(2\)\}s` \} : undefined\}/,
      "delays come from grid position so the shimmer travels as a wave",
    )
    assert.match(
      ditherTrack,
      /return \(col \* 0\.35 \+ row \* 0\.13\) % TWINKLE_PERIOD_S/,
    )
  })

  it("animates opacity only, on a fixed period", () => {
    assert.match(
      globals,
      /\.effort-dither-twinkle \{\s*animation: effort-pixel-wave 3s ease-in-out infinite;/,
    )
    assert.match(
      globals,
      /@keyframes effort-pixel-wave \{\s*0%, 100% \{ opacity: 1; \}\s*50% \{ opacity: 0\.3; \}\s*\}/,
      "opacity-only keyframes: no layout thrash",
    )
  })
})

describe("composer bar — phone layout contract", () => {
  it("keeps every footer control inside the surface on 360–430 px phones", () => {
    const mobileBlock = globals.slice(globals.indexOf("/* Phone footer budget (360–430 px)"))
    assert.ok(mobileBlock.length > 0, "the phone footer budget block must exist")
    assert.match(mobileBlock, /\.composer-effort-chip > \.truncate,\s*\.composer-effort-chip \.composer-effort-caret \{\s*display: none;/, "effort collapses to its glyph on phones")
    assert.match(mobileBlock, /\.composer-input-row \.composer-model-inline \.chat-model-trigger > svg:last-child \{\s*display: none;/, "the model chevron is dropped on phones")
    assert.match(
      globals,
      /\.composer-model-inline \{[^}]*max-width: min\(46vw, max\(3\.5rem, calc\(100vw - 2 \* var\(--chat-mobile-gutter, 0\.75rem\) - 16\.1rem\)\)\) !important;/,
      "the model pill is the only control capped by the viewport budget",
    )
    assert.match(
      globals,
      /\.composer-input-row \.composer-toolbar-actions > \*:not\(\.composer-model-inline\),\s*\.composer-leading-controls > \* \{\s*flex: 0 0 auto;/,
      "icon controls never shrink — a long model name truncates instead",
    )
    assert.match(globals, /\.composer-fast-switch::before \{/, "the fast-mode knob must not use ::after (claimed by the phone tap-target expander)")
    assert.ok(!globals.includes(".composer-fast-switch::after {"))
  })
})

describe("composer attachments — any format", () => {
  it("offers every file to the OS picker and lets the client validator through", () => {
    const input = chatInterface.match(/<input\s+ref=\{fileInputRef\}[\s\S]*?\/>/)
    assert.ok(input, "the composer file input must exist")
    assert.doesNotMatch(input![0], /\baccept=/, "no restrictive accept filter — every format is offered")
    assert.match(input![0], /data-accepts-any-format="true"/)
    assert.match(input![0], /\bmultiple\b/)
    assert.doesNotMatch(attachmentIngest, /type_not_allowed|ALLOWED_MIMES|ALLOWED_EXTENSIONS|Tipo no permitido/, "the client has no type allowlist")
    for (const keep of ['code: "empty_file"', 'code: "size_exceeded"', 'code: "office_temp_lock_file"', 'code: "count_exceeded"']) {
      assert.ok(attachmentIngest.includes(keep), `${keep} must still be enforced client-side`)
    }
  })
})
