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

describe("effort slider — left→right pixel-dissolve contract", () => {
  it("builds the dissolve from SVG patterns and left→right ramp masks, never a raster asset", () => {
    assert.match(ditherTrack, /<pattern[\s\S]{0,200}patternUnits="userSpaceOnUse"/, "pixels must tile in user space so they stay square at any width")
    assert.match(ditherTrack, /<linearGradient[\s\S]{0,80}x1="0" y1="0" x2="1" y2="0"/, "each layer fades in along the x axis")
    assert.match(ditherTrack, /function rampStops\(/, "ramp windows fade in and stay opaque: density grows toward the active stop")
    assert.match(ditherTrack, /\[from, 0\],\s*\[to, 1\],/, "each ramp goes transparent → opaque and holds")
    assert.match(ditherTrack, /<mask[\s\S]{0,120}maskUnits="userSpaceOnUse"/, "masks resolve against the full track")
    assert.doesNotMatch(ditherTrack, /<image|\.png|\.jpg|\.webp|data:image/i, "the effect must be generated, not a static image")
    assert.match(ditherTrack, /shape-rendering|effort-dither-px/, "pixel rects carry the crisp-edge class")
    assert.match(ditherTrack, /mulberry32|Fisher|seed/i, "cell ordering must be seeded so SSR and client markup match")
    assert.match(ditherTrack, /psparkle/, "a dedicated white-sparkle pattern glints in the dense zone")
    assert.match(ditherTrack, /msparkle/, "the sparkles are masked to the dense right zone")
  })

  it("mounts the dither inside the fill and ships no visible dial", () => {
    assert.match(effortMenu, /import \{ EffortDitherTrack \} from "@\/components\/chat\/effort-dither-track"/)
    assert.match(
      effortMenu,
      /<span className="effort-track-fill">\s*<EffortDitherTrack className="effort-dither" \/>\s*<span className="effort-sheen" aria-hidden \/>\s*<\/span>/,
      "the dither is the fill's only child so the reveal uncovers it up to the active stop",
    )
    assert.doesNotMatch(effortMenu, /effort-thumb/, "no dial: the cloud's cut position, header readout and ticks carry the value")
    assert.match(effortMenu, /data-stop=\{String\(index\)\}/, "stops expose their index so CSS can place tick marks")
  })

  it("styles a thin pale capsule rail with a feathered mask reveal", () => {
    const section = ruleBody(".effort-section")
    assert.match(section, /--effort-violet: hsl\(25\d /, "the dissolve resolves to violet")
    assert.match(section, /--effort-rail: hsl\(257 62% 93%\)/, "both rail ends stay pale lavender")
    assert.match(section, /--effort-rail-h: 1rem;/, "thin rail")

    const track = ruleBody(".effort-track")
    assert.match(track, /border-radius: 999px;/)
    assert.match(track, /cursor: grab;/)
    assert.match(track, /--effort-index: 0;/)
    assert.match(track, /--effort-x: calc\(/, "x must be declared on the track: var(--effort-index) substitutes at declaration scope, so section-level x froze the fill at stop 0")
    assert.match(track, /transition: --effort-x 220ms/, "the reveal position itself animates so the cloud glides between stops")
    assert.match(globals, /@property --effort-x \{\s*syntax: "<length-percentage>";/, "registered custom property: without it the reveal would snap discretely")

    const fill = ruleBody(".effort-track-fill")
    assert.match(fill, /mask-image: linear-gradient\(90deg, #fff calc\(var\(--effort-x\) - 28px\), transparent var\(--effort-x\)\);/, "reveal is a feathered mask, so the cloud dissolves instead of cutting")
    assert.doesNotMatch(fill, /clip-path/, "the old hard clip is gone")

    assert.ok(!globals.includes(".effort-thumb"), "no dial CSS may linger")
    assert.ok(!globals.includes(".effort-stop::after"), "no stop dots may linger")

    for (const cls of [".effort-dither {", ".effort-dither-base {", ".effort-dither-px {", ".effort-dither-core {", ".effort-dither-spark {", ".dark .effort-section {"]) {
      assert.ok(globals.includes(cls), `${cls} must exist`)
    }
    assert.ok(!globals.includes(".dark .effort-thumb {"), "no dark-mode dial CSS may linger")
    assert.match(globals, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.effort-track,\s*\.effort-track-fill,\s*\.effort-dither-twinkle,\s*\.effort-sheen,/, "reduced motion freezes track + fill + pixels + sheen")
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

  it("beats like a heart: scale + opacity around each pixel's own centre", () => {
    assert.match(
      globals,
      /\.effort-dither-twinkle \{[^}]*transform-box: fill-box;[^}]*transform-origin: center;[^}]*animation: effort-pixel-wave 2\.4s ease-in-out infinite;/,
    )
    assert.match(
      globals,
      /@keyframes effort-pixel-wave \{\s*0%\s*\{ opacity: 0\.85; transform: scale\(1\); \}\s*10%\s*\{ opacity: 1;\s*transform: scale\(1\.5\); \}\s*20%/,
      "lub at 10%",
    )
    assert.match(
      globals,
      /30%\s*\{ opacity: 1;\s*transform: scale\(1\.32\); \}\s*42%/,
      "dub at 30%, then rest — no layout properties, GPU-cheap",
    )
  })
})

describe("effort slider — interaction sheen", () => {
  it("mounts a pointer-transparent sheen inside the clipped fill", () => {
    assert.match(effortMenu, /<span className="effort-sheen" aria-hidden \/>/)
  })

  it("sweeps light during interaction and stays still at rest", () => {
    assert.match(
      globals,
      /\.effort-sheen \{\s*position: absolute;\s*inset: 0;\s*display: block;\s*border-radius: inherit;\s*pointer-events: none;/,
    )
    assert.match(
      globals,
      /background-size: 250% 100%;\s*background-repeat: no-repeat;\s*animation: effort-sheen-sweep 5\.6s linear infinite;/,
      "oversized gradient: percentage positions stay responsive at any rail width",
    )
    assert.match(ruleBody(".effort-sheen"), /animation-play-state: paused;/, "no perpetual motion at rest")
    assert.match(globals, /:is\(:hover, :focus-visible, \[data-dragging="true"\]\):not\(\[data-disabled="true"\]\)/, "motion requires an enabled interactive state")
    assert.match(
      globals,
      /@keyframes effort-sheen-sweep \{\s*from \{ background-position: 120% 0; \}\s*to \{ background-position: -20% 0; \}\s*\}/,
      "the band travels the full rail, left to right, then loops",
    )
  })
})

describe("composer bar — phone layout contract", () => {
  it("keeps every footer control inside the surface on 360–430 px phones", () => {
    const mobileBlock = globals.slice(globals.indexOf("/* Phone footer budget (360–430 px)"))
    assert.ok(mobileBlock.length > 0, "the phone footer budget block must exist")
    assert.doesNotMatch(effortMenu, /<span className="truncate">/, "the bar shows just the bolt — no text label")
    assert.doesNotMatch(effortMenu, /composer-effort-caret/, "no caret next to the bolt")
    assert.match(
      globals,
      /\.composer-permission-chip,\s*\.composer-effort-chip \{\s*width: 2rem;\s*max-width: 2rem;\s*padding: 0;\s*justify-content: center;\s*gap: 0;/,
      "effort is icon-only like the permission chip",
    )
    assert.match(effortMenu, /aria-label=\{`Esfuerzo: \$\{active\.label\}`\}/, "the bolt still names the level for assistive tech")
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
