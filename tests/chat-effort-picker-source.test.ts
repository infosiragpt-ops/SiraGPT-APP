import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const read = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8")

const chatInterface = read("components", "chat-interface-enhanced.tsx")
const effortLib = read("lib", "chat", "composer-effort.ts")
const submenu = read("components", "chat", "composer-effort-submenu.tsx")
const fastToggle = read("components", "chat", "composer-fast-mode-toggle.tsx")
const globals = read("app", "globals.css")
const orchestrator = read("backend", "src", "services", "reasoning-orchestrator.js")

describe("composer effort (foot of the model menu) source contract", () => {
  it("offers five levels, all normalized by the backend compute planner", () => {
    const values = [...effortLib.matchAll(/\{ value: "([^"]+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]])
    assert.deepEqual(values, [
      ["Bajo", "Bajo"],
      ["Medio", "Medio"],
      ["Alto", "Alto"],
      ["Extra", "Extra"],
      ["Max", "Máx"],
    ])
    const aliasBlock = orchestrator.match(/const EFFORT_ALIASES = Object\.freeze\(\{([\s\S]*?)\}\)/)
    assert.ok(aliasBlock, "backend EFFORT_ALIASES must exist")
    for (const [value] of values) {
      assert.match(
        aliasBlock![1],
        new RegExp(`(^|[\\s{,'])${value.toLowerCase()}'?:`, "i"),
        `backend must normalize "${value}" — a level the planner ignores is a lie`,
      )
    }
    assert.match(orchestrator, /extra: 'xhigh'/, "Extra sits between Alto and Máx")
    assert.match(orchestrator, /function thinkingLevelForEffort\(level\)/, "effort also drives the provider knob")
  })

  it("marks Medio as the default and Máx as heavier usage, with the approved help copy", () => {
    assert.match(effortLib, /value: "Medio", label: "Medio", isDefault: true/)
    assert.match(effortLib, /value: "Max", label: "Máx", heavyUsage: true/)
    assert.ok(
      effortLib.includes("Un mayor esfuerzo significa respuestas más completas, pero lleva más tiempo y consume tus límites más rápido."),
    )
    assert.match(submenu, /Predeterminado/)
    assert.match(submenu, /Mayor uso/)
    assert.match(submenu, /role="menuitemradio"/)
    assert.match(submenu, /aria-checked=\{isActive\}/)
    assert.match(submenu, /<Check/, "the active level carries a check, never color alone")
  })

  it("renders the effort row at the foot of the model menu, not on the toolbar", () => {
    assert.match(
      chatInterface,
      /<div className="model-picker-footer">\s*<ComposerEffortSubmenu\s+selectedEffort=\{selectedEffort\}\s+setSelectedEffort=\{setSelectedEffort\}/,
    )
    assert.match(chatInterface, /modelSupportsComposerEffort\(selectedModelData\)/, "decision/media models hide the row")
    assert.doesNotMatch(chatInterface, /<ComposerEffortMenu/, "the old toolbar slider popover is gone")
    assert.doesNotMatch(globals, /\.effort-track \{|\.effort-dither-core \{/, "no stale slider CSS")
    assert.match(submenu, /DropdownMenuSubTrigger/)
    assert.match(submenu, /data-testid="composer-effort-trigger"/)
  })

  it("keeps the memoized selector from freezing effort updates", () => {
    const comparator = chatInterface.match(
      /function areNavbarModelSelectorPropsEqual\(prev: any, next: any\) \{([\s\S]*?)\n\}/,
    )
    assert.ok(comparator, "comparator must exist")
    assert.match(comparator![1], /prev\.selectedEffort === next\.selectedEffort/)
    assert.match(comparator![1], /prev\.setSelectedEffort === next\.setSelectedEffort/)
    assert.match(
      chatInterface,
      /<NavbarModelSelector[\s\S]{0,600}selectedEffort=\{selectedEffort\}[\s\S]{0,80}setSelectedEffort=\{setSelectedEffort\}/,
    )
  })

  it("leaves the lightning as a plain fast-mode switch", () => {
    assert.match(chatInterface, /\{!isMediaToolActive && <ComposerFastModeToggle \/>\}/)
    assert.match(fastToggle, /aria-pressed=\{fast\}/)
    assert.match(fastToggle, /writeComposerFastMode\(next\)/)
    assert.doesNotMatch(fastToggle, /Popover/, "one click toggles; no popover")
  })

  it("keeps the effort choice flowing to the generate payload and migrates old values", () => {
    const context = read("lib", "chat-context-integrated.tsx")
    const sends = context.match(/reasoningEffort: selectedEffort/g) || []
    assert.ok(sends.length >= 3, "every generate call must carry reasoningEffort")
    assert.match(effortLib, /COMPOSER_EFFORT_STORAGE_KEY = "sira:composer:effort"/, "the choice must persist across reloads")
    assert.match(context, /migrateStoredComposerEffort\(saved, scale\)/)
    assert.match(effortLib, /if \(raw === "Extra"\) return "Alto"/, "old High keeps meaning High")
  })
})
