import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)
const effortMenu = fs.readFileSync(
  path.join(process.cwd(), "components", "chat", "composer-effort-menu.tsx"),
  "utf8",
)
const contextMenu = fs.readFileSync(
  path.join(process.cwd(), "components", "chat", "composer-context-menu.tsx"),
  "utf8",
)
const globals = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8")
const orchestrator = fs.readFileSync(
  path.join(process.cwd(), "backend", "src", "services", "reasoning-orchestrator.js"),
  "utf8",
)

describe("composer effort picker source contract", () => {
  it("shows only the lightning icon while retaining the accessible effort name", () => {
    const trigger = effortMenu.match(/<PopoverTrigger asChild>([\s\S]*?)<\/PopoverTrigger>/)?.[1]
    assert.ok(trigger, "the existing effort trigger must remain")
    assert.match(trigger, /aria-label=\{`Esfuerzo: \$\{active\.label\}`\}/)
    assert.match(trigger, /title=\{`\$\{active\.label\}/)
    assert.match(trigger, /<Zap\b[^>]*aria-hidden="true"/)
    assert.doesNotMatch(trigger, /<span\b|composer-effort-caret/, "no visible label or caret beside the bolt")
    assert.match(globals, /\.composer-effort-chip \{\s*order: 30;\s*width: 2rem;\s*max-width: 2rem;\s*padding: 0;\s*justify-content: center;\s*gap: 0;/)
  })

  it("offers only levels the backend compute planner accepts", () => {
    const levelsBlock = effortMenu.match(/export const EFFORT_LEVELS = \[([\s\S]*?)\] as const/)
    assert.ok(levelsBlock, "EFFORT_LEVELS must exist")
    const values = [...levelsBlock![1].matchAll(/value: "([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(values, ["Bajo", "Medio", "Extra", "Max"])

    const aliasBlock = orchestrator.match(/const EFFORT_ALIASES = Object\.freeze\(\{([\s\S]*?)\}\)/)
    assert.ok(aliasBlock, "backend EFFORT_ALIASES must exist")
    for (const value of values) {
      assert.match(
        aliasBlock![1],
        new RegExp(`(^|[\\s{,'])${value.toLowerCase()}'?:`, "i"),
        `backend must normalize "${value}" — a slider stop the planner ignores is a lie`,
      )
    }
  })

  it("keeps the memoized selector from freezing effort updates", () => {
    const comparator = chatInterface.match(
      /function areNavbarModelSelectorPropsEqual\(prev: any, next: any\) \{([\s\S]*?)\n\}/,
    )
    assert.ok(comparator, "comparator must exist")
    assert.match(
      comparator![1],
      /prev\.selectedEffort === next\.selectedEffort/,
      "memo must compare selectedEffort or the slider renders stale state",
    )
    assert.match(comparator![1], /prev\.setSelectedEffort === next\.setSelectedEffort/)
  })

  it("renders the effort menu on the composer toolbar and wires the context state", () => {
    assert.match(
      chatInterface,
      /<ComposerEffortMenu\s+selectedEffort=\{selectedEffort\}\s+setSelectedEffort=\{setSelectedEffort\}/,
      "the composer toolbar must render the effort menu",
    )
    assert.match(
      chatInterface,
      /<NavbarModelSelector[\s\S]{0,600}selectedEffort=\{selectedEffort\}[\s\S]{0,80}setSelectedEffort=\{setSelectedEffort\}/,
      "the composer call site must pass both effort props",
    )
  })

  it("keeps context and effort as separate one-trigger popovers", () => {
    assert.match(
      chatInterface,
      /<ComposerContextMenu\s+messages=\{currentChat\?\.messages \|\| \[\]\}\s+selectedModel=\{currentChat\?\.model \|\| selectedModel\}\s+availableModels=\{availableModels\}/,
      "the context popover must receive the active chat and selected model",
    )
    assert.equal((contextMenu.match(/<PopoverTrigger asChild>/g) || []).length, 1)
    assert.equal((effortMenu.match(/<PopoverTrigger asChild>/g) || []).length, 1)
    assert.match(contextMenu, /data-testid="composer-context-trigger"/)
    assert.match(effortMenu, /data-testid="composer-effort-chip"/)
    assert.doesNotMatch(effortMenu, /composer-context-trigger|composer-effort-ring/)
  })

  it("uses the exact four labels and copy from the approved effort reference", () => {
    const labels = [...effortMenu.matchAll(/value: "([^"]+)", label: "([^"]+)"/g)]
      .map((match) => [match[1], match[2]])
    assert.deepEqual(labels, [
      ["Bajo", "Low"],
      ["Medio", "Medium"],
      ["Extra", "High"],
      ["Max", "Extra high"],
    ])
    for (const copy of ["Esfuerzo", "Más rápido", "Más inteligente", "Modo rápido", "Respuestas más rápidas, mayor uso de los límites."]) {
      assert.ok(effortMenu.includes(copy), `missing approved effort copy: ${copy}`)
    }
    assert.doesNotMatch(effortMenu, /effort-caption|caption:/, "the compact reference has no descriptive caption")
    assert.match(effortMenu, /<span className="effort-title" id=\{titleId\}>Esfuerzo<\/span>/, "the title labels the slider")
    assert.match(effortMenu, /<span className="effort-level" id=\{valueId\}>\{active\.label\}<\/span>/, "the header names the level in text — never color alone (WCAG 1.4.1)")
  })

  it("supports real dragging, not just stop clicks", () => {
    const section = effortMenu.match(
      /export function EffortSection\(([\s\S]*?)\nexport function ComposerEffortMenu/,
    )
    assert.ok(section, "EffortSection must exist")
    assert.match(section![1], /onPointerDown=/, "the track must start drags on pointer down")
    assert.match(section![1], /onPointerMove=/, "the track must follow pointer moves")
    assert.match(
      section![1],
      /setPointerCapture/,
      "pointer capture keeps the drag alive when the cursor leaves the track"
    )
    assert.match(
      section![1],
      /indexFromPointer/,
      "any x on the track must map to the nearest stop"
    )
    assert.match(section![1], /aria-labelledby=\{\s*`\$\{titleId\} \$\{valueId\}`\s*\}/, "title + value name the slider, never a bare number")
    assert.match(section![1], /aria-orientation="horizontal"/)
    assert.match(section![1], /PageUp/, "PageUp jumps forward")
    assert.match(section![1], /PageDown/, "PageDown jumps back")
    assert.match(section![1], /className="effort-ticks"/, "discrete step marks under the rail")
    assert.match(section![1], /className="effort-bubble"/, "value bubble follows the thumb while dragging")
    assert.match(section![1], /data-dragging=\{dragging \? "true" : undefined\}/)
    assert.match(
      globals,
      /\.effort-track \{[\s\S]{0,520}overflow: hidden/,
      "neon fill and glow must stay clipped inside the track",
    )
    assert.match(effortMenu, /data-effort=\{String\(activeIndex\)\}/)
    assert.match(effortMenu, /className="effort-track-fill"/)
    assert.match(
      globals,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,220}\.effort-track-fill/,
      "reduced motion must keep a static fill without flicker",
    )
  })

  it("ships the effort styles in the curated stylesheet", () => {
    for (const cls of [".effort-section", ".effort-track-line", ".effort-stop-active", ".effort-ends"]) {
      assert.ok(globals.includes(`${cls} {`), `${cls} must exist in globals.css`)
    }
    assert.ok(!globals.includes(".effort-caption {"), "the removed caption must not keep stale layout CSS")
    assert.match(
      globals,
      /\.effort-track:focus-visible \{[\s\S]{0,120}outline: 2px solid/,
      "keyboard focus on the slider must be visible",
    )
  })

  it("keeps the effort choice flowing to the generate payload", () => {
    const context = fs.readFileSync(
      path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
      "utf8",
    )
    const sends = context.match(/reasoningEffort: selectedEffort/g) || []
    assert.ok(sends.length >= 3, "every generate call must carry reasoningEffort")
    assert.match(context, /sira:composer:effort/, "the choice must persist across reloads")
  })
})
