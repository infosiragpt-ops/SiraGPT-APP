import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const globalsPath = path.join(process.cwd(), "app", "globals.css")
const viewportHookPath = path.join(process.cwd(), "hooks", "use-visual-viewport-css-vars.ts")

const globals = fs.readFileSync(globalsPath, "utf8")
const viewportHook = fs.readFileSync(viewportHookPath, "utf8")

/** Extract the full `{ ... }` block (brace-balanced) opening after `start`. */
function cssBlockAt(source: string, start: number): string {
  const open = source.indexOf("{", start)
  assert.notEqual(open, -1, "expected a CSS block to open after the matched selector")
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail("unbalanced braces while extracting CSS block")
}

describe("mobile keyboard composer source contract", () => {
  it("marks the visual viewport target when the keyboard is open", () => {
    assert.match(
      viewportHook,
      /KEYBOARD_OPEN_HEIGHT_PX\s*=\s*120/,
      "keyboard-open detection should ignore small Safari toolbar changes"
    )
    assert.match(
      viewportHook,
      /target\.dataset\[`\$\{prefix\}Keyboard`\]\s*=/,
      "viewport sync should expose a data attribute for CSS keyboard overrides"
    )
  })

  it("treats pinch-/double-tap-zoom as not-a-keyboard (scale-aware)", () => {
    // visualViewport.scale > 1 means the user zoomed in, not that an
    // on-screen keyboard appeared. The metrics reader must fall back to the
    // layout viewport and report keyboardHeight 0 while zoomed, otherwise the
    // shell collapses to the zoomed region and the composer disappears.
    assert.match(
      viewportHook,
      /visualViewport\?\.scale/,
      "viewport metrics must read visualViewport.scale to detect zoom"
    )
    assert.match(
      viewportHook,
      /const\s+zoomed\s*=\s*scale\s*>\s*1/,
      "viewport metrics must flag the zoomed state from scale"
    )
    assert.match(
      viewportHook,
      /keyboardHeight\s*=\s*zoomed[\s\S]*?\?\s*0/,
      "keyboardHeight must be forced to 0 while zoomed"
    )
  })

  it("removes the iOS Safari toolbar clearance while the keyboard is open", () => {
    // Since the iOS keyboard fix (a8cd955b1, 2026-06-01) the first
    // `[data-chat-keyboard="open"]` rule is the position:fixed composer dock,
    // so locate the clearance override structurally instead of assuming the
    // first selector hit is the override.
    const iosClearanceIndex = globals.indexOf("@supports (-webkit-touch-callout: none)")
    assert.notEqual(iosClearanceIndex, -1, "missing iOS Safari clearance block")

    const iosBlock = cssBlockAt(globals, iosClearanceIndex)

    assert.match(
      iosBlock,
      /\.chat-viewport\s*\{[^}]*--chat-mobile-bottom-clearance:/,
      "iOS block should reserve Safari toolbar clearance while the keyboard is closed"
    )

    // Keyboard open on iOS: the composer dock flips to position:fixed so it
    // pins to the visual viewport instead of flying to the top (Safari's
    // sticky-inside-overflow:hidden bug — a8cd955b1).
    assert.match(
      iosBlock,
      /\.chat-viewport\[data-chat-keyboard="open"\]\s+\.chat-composer-dock\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*0/,
      "keyboard-open composer dock must pin to the visual viewport bottom (position: fixed)"
    )

    const clearanceOverride =
      /\.chat-viewport\[data-chat-keyboard="open"\]\s*\{[^}]*--chat-mobile-bottom-clearance:\s*max\(env\(safe-area-inset-bottom,\s*0px\),\s*0\.25rem\)/

    assert.match(
      iosBlock,
      clearanceOverride,
      "keyboard-open composer should stay close to the visual viewport bottom on iOS"
    )

    // The same keyboard-open override also lives outside the iOS-only gate so
    // Android Chrome drops the toolbar clearance too (b98c9bb69).
    const afterIosBlock = globals.slice(iosClearanceIndex + iosBlock.length)
    assert.match(
      afterIosBlock,
      clearanceOverride,
      "keyboard-open clearance override should also apply outside the iOS-only gate"
    )
  })
})
