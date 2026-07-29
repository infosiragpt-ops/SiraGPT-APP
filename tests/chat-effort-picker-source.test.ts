import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)
const globals = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8")
const orchestrator = fs.readFileSync(
  path.join(process.cwd(), "backend", "src", "services", "reasoning-orchestrator.js"),
  "utf8",
)

describe("composer effort picker source contract", () => {
  it("offers only levels the backend compute planner accepts", () => {
    const levelsBlock = chatInterface.match(/const EFFORT_LEVELS = \[([\s\S]*?)\] as const/)
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

  it("renders the effort section inside the model dropdown and wires the context state", () => {
    assert.match(
      chatInterface,
      /<EffortSection\s+selectedEffort=\{selectedEffort\}\s+setSelectedEffort=\{setSelectedEffort\}/,
      "the dropdown must render the effort slider",
    )
    assert.match(
      chatInterface,
      /<NavbarModelSelector[\s\S]{0,600}selectedEffort=\{selectedEffort\}[\s\S]{0,80}setSelectedEffort=\{setSelectedEffort\}/,
      "the composer call site must pass both effort props",
    )
  })

  it("supports real dragging, not just stop clicks", () => {
    // Anchor the end at the next top-level declaration: the component's typed
    // destructure closes with "\n}" too, which a lazy match stops at.
    const section = chatInterface.match(
      /function EffortSection\(([\s\S]*?)\nfunction areNavbarModelSelectorPropsEqual/,
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
    assert.match(
      globals,
      /\.effort-track \{[\s\S]{0,400}touch-action: none/,
      "touch drags must move the thumb, not scroll the dropdown"
    )
  })

  it("ships the effort styles in the curated stylesheet", () => {
    for (const cls of [".effort-section", ".effort-track-fill", ".effort-stop-active", ".effort-caption"]) {
      assert.ok(globals.includes(`${cls} {`), `${cls} must exist in globals.css`)
    }
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
