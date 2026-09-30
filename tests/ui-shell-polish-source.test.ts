import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const source = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8")

const css = source("app/globals.css")

describe("streaming caret", () => {
  it("is scoped to the answer body's final text block, never table cells or inner list items", () => {
    assert.doesNotMatch(css, /\.streaming-message :is\(p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th\):last-child::after/)
    const caretSelector =
      /\.streaming-message \[data-sgpt-rich-copy-root\] > :nth-last-child\(2\):is\(p, h1, h2, h3, h4, h5, h6, blockquote\)::after,\s*\.streaming-message \[data-sgpt-rich-copy-root\] > :nth-last-child\(2\):is\(ul, ol\) > li:last-child::after\s*\{/g
    // Base rule + reduced-motion copy.
    assert.equal((css.match(caretSelector) || []).length, 2)
  })

  it("hides the explicit fallback caret span when the answer ends in text", () => {
    assert.match(
      css,
      /\.streaming-message \[data-sgpt-rich-copy-root\] > :is\(p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol\) \+ \.premium-caret\s*\{\s*display: none;/,
    )
  })
})

describe("reduced motion", () => {
  it("does not freeze transforms (Radix popper, dialogs and switches position with transform)", () => {
    const block = css.match(/\/\* Reduced motion \*\/\s*@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)
    assert.ok(block, "reduced-motion block must exist")
    assert.doesNotMatch(block![0], /transform:\s*none\s*!important/)
    assert.match(block![0], /animation-duration: 0\.01ms !important;/)
  })

  it("framer-motion honours the OS setting via MotionConfig", () => {
    const providers = source("components/root-providers.tsx")
    assert.match(providers, /import \{ MotionConfig \} from "framer-motion"/)
    assert.match(providers, /<MotionConfig reducedMotion="user">/)
  })
})

describe("mobile tap-target rule", () => {
  it("keeps zero specificity so Tailwind absolute/fixed overlay buttons win", () => {
    assert.match(css, /:where\(button\[aria-label\], \[role="button"\]\[aria-label\]\) \{\s*position: relative;/)
    assert.doesNotMatch(css, /^\s*button\[aria-label\],\s*\[role="button"\]\[aria-label\] \{\s*position: relative;/m)
  })
})

describe("composer controls stay monochrome and legible in dark mode", () => {
  it("stop button uses ink + ring, with a dark disc", () => {
    assert.match(css, /\.composer-stop-button \{[^}]*color: hsl\(var\(--foreground\)\) !important;/)
    assert.match(css, /\.composer-stop-button:focus-visible \{\s*outline: 2px solid hsl\(var\(--ring\) \/ 0\.45\);/)
    assert.match(css, /\.dark \.composer-stop-button::before \{ background: hsl\(0 0% 100% \/ 0\.14\); \}/)
    assert.doesNotMatch(css, /\.composer-stop-button \{[^}]*#dc2626/)
  })

  it("fast-mode on state is a neutral wash with an ink bolt", () => {
    assert.match(css, /\.composer-fast-toggle\.is-on \{\s*color: hsl\(0 0% 46%\);\s*background: hsl\(var\(--foreground\) \/ 0\.07\);/)
    assert.match(css, /\.dark \.composer-fast-toggle\.is-on \{\s*background: hsl\(0 0% 100% \/ 0\.1\);/)
    assert.match(css, /\.dark \.composer-fast-toggle\.is-on svg \{\s*color: hsl\(var\(--foreground\)\);/)
  })

  it("permission rows and toolbar chips use theme-aware hover backgrounds", () => {
    assert.match(css, /\.composer-permission-row\.is-selected \{\s*background: hsl\(var\(--accent\)\);/)
    assert.match(
      css,
      /\.dark \.composer-permission-chip:hover,[\s\S]{0,300}\.dark \.composer-context-trigger\[data-state="open"\] \{\s*background: hsl\(0 0% 100% \/ 0\.08\);/,
    )
  })
})

describe("theme boot script", () => {
  it("applies the stored next-themes class before first paint", () => {
    const layout = source("app/layout.tsx")
    assert.match(layout, /localStorage\.getItem\('theme'\)/)
    assert.match(layout, /prefers-color-scheme: dark/)
    assert.match(layout, /d\.style\.colorScheme=k/)
    assert.match(layout, /sira-theme-midnight/)
  })
})

describe("settings provider", () => {
  it("reads localStorage in the state initializer and applies vars in a layout effect", () => {
    const settings = source("lib/settings-context.tsx")
    assert.match(settings, /React\.useState<SettingsShape>\(\(\) => \{[\s\S]{0,300}localStorage\.getItem\(STORAGE_KEY\)/)
    assert.match(settings, /React\.useLayoutEffect\(\(\) => \{ applyPreviewVars\(settings\) \}, \[settings\]\)/)
  })
})

describe("dropdown menu", () => {
  it("content and sub-content scroll within the available height", () => {
    const menu = source("components/ui/dropdown-menu.tsx")
    const matches = menu.match(
      /max-h-\[var\(--radix-dropdown-menu-content-available-height\)\] min-w-\[8rem\] overflow-y-auto overflow-x-hidden/g,
    ) || []
    assert.equal(matches.length, 2)
  })
})
