import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8")
const start = css.indexOf("Professional finish v3")
const block = start >= 0 ? css.slice(start) : ""

/**
 * The system-wide finish (2026-10-03) is one additive block at the END of
 * globals.css: token-driven, monochrome, scoped so the composer contract,
 * the brand marks and the code palette stay untouched.
 */
describe("professional finish v3", () => {
  it("exists once, last in the file, and reaches every planned surface", () => {
    assert.ok(start > 0, "block present")
    assert.equal(css.indexOf("Professional finish v3", start + 1), -1, "declared once")
    assert.match(block, /@layer base \{[\s\S]*?text-rendering: optimizeLegibility;/)
    assert.match(block, /:where\(h1, h2, h3, h4, h5, h6\) \{\s*text-wrap: balance;/)
    assert.match(block, /\.chat-assistant-message \.prose :where\(:not\(pre\) > code\):not\(:where\(\.not-prose \*\)\) \{/)
    assert.match(block, /\.chat-assistant-message \.prose :where\(table\):not\(:where\(\.not-prose \*\)\) \{[\s\S]*?font-variant-numeric: tabular-nums;/)
    assert.match(block, /\.chat-user-bubble \{\s*box-shadow:\s*inset 0 1px 0 hsl\(0 0% 100% \/ 0\.55\),/)
    assert.match(block, /\[data-sidebar="menu-button"\]\[data-active="true"\],/)
    assert.match(block, /\.animate-pulse\.rounded-md\.bg-muted \{\s*animation: sira-skeleton-sweep/)
    assert.match(block, /@keyframes sira-skeleton-sweep/)
  })

  it("stays monochrome and token-driven: no chromatic literals, no new colour tokens", () => {
    const literals = block.match(/#[0-9a-f]{3,8}\b|rgb\(|rgba\(/gi) || []
    assert.deepEqual(literals, [])
    const hues = block.match(/hsl\(\s*(\d+)\s/g) || []
    for (const h of hues) assert.match(h, /hsl\(\s*0\s/, `only hue 0 in ${h}`)
    assert.match(block, /var\(--shadow-lg\)/)
    assert.match(block, /var\(--shadow-xl\)/)
    assert.match(block, /var\(--ease-out-smooth/)
  })

  it("never touches the composer surface, the brand marks or the code palette", () => {
    assert.doesNotMatch(block, /\.composer-surface\s*\{/)
    assert.doesNotMatch(block, /\.composer-surface:focus-within/)
    assert.doesNotMatch(block, /\.chat-code-block|--code-bg|--code-fg/)
    assert.doesNotMatch(block, /\.sidebar-brand|\.atom|--think-/)
    // The text-field focus contour explicitly excludes the composer and the
    // celeste rename field.
    assert.match(block, /:not\(\.composer-surface \*\):not\(\.composer-input-row \*\):not\(\.chat-title-input--celeste\)/)
  })

  it("keeps the base-layer motion defaults overridable and honours reduced motion", () => {
    assert.match(block, /@layer base \{[\s\S]*?:where\(button, \[role="button"\], \[role="menuitem"\], \[role="option"\], \[role="tab"\], a\[href\]\) \{\s*transition-property:/)
    assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-pulse\.rounded-md\.bg-muted \{\s*animation: none;/)
    // Tooltips keep their own elevation: the popper rule excludes them.
    assert.match(block, /:not\(\[data-state="delayed-open"\]\):not\(\[data-state="instant-open"\]\)/)
  })
})
