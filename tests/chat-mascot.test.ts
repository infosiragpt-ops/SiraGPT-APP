import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MASCOT_GRID,
  MASCOT_PALETTES,
  MASCOT_SPECIES,
  getChatMascot,
  mascotRects,
} from "../lib/chat-mascot"

describe("chat mascot generator", () => {
  it("keeps a 12×12 original sprite set with 12 palettes", () => {
    assert.equal(MASCOT_GRID, 12)
    assert.equal(MASCOT_SPECIES.length, 16)
    assert.equal(MASCOT_PALETTES.length, 12)
    assert.equal(new Set(MASCOT_SPECIES).size, MASCOT_SPECIES.length)
    assert.equal(new Set(MASCOT_PALETTES.map((palette) => palette.name)).size, MASCOT_PALETTES.length)
  })

  it("is deterministic for the same chat id", () => {
    const a = getChatMascot("chat-abc")
    const b = getChatMascot("chat-abc")
    assert.equal(a.species, b.species)
    assert.equal(a.palette.name, b.palette.name)
    assert.equal(a.flipped, b.flipped)
    assert.deepEqual(a.pixels, b.pixels)
  })

  it("varies across many chat ids", () => {
    const keys = Array.from({ length: 64 }, (_, i) => `chat-${i}`)
    const signatures = new Set(
      keys.map((id) => {
        const spec = getChatMascot(id)
        return `${spec.species}:${spec.palette.name}:${spec.flipped ? 1 : 0}`
      }),
    )
    assert.ok(signatures.size >= 24, `expected diverse mascots, got ${signatures.size}`)
  })

  it("only emits in-gamut pixels and at least one body pixel", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 48; i += 1) {
      const spec = getChatMascot(`probe-${i}`)
      seen.add(spec.species)
      let body = 0
      assert.equal(spec.pixels.length, MASCOT_GRID)
      for (const row of spec.pixels) {
        assert.equal(row.length, MASCOT_GRID)
        for (const value of row) {
          assert.ok(value >= 0 && value <= 7)
          if (value === 2) body += 1
        }
      }
      assert.ok(body >= 8, `${spec.species} should have a readable body`)
    }
    assert.ok(seen.size >= 8, `expected several species in the probe set, got ${seen.size}`)
  })

  it("packs rects that cover every non-transparent pixel once", () => {
    const spec = getChatMascot("rect-cover")
    const rects = mascotRects(spec)
    assert.ok(rects.length > 0)
    const covered = spec.pixels.map((row) => row.map(() => 0))
    for (const rect of rects) {
      assert.match(rect.color, /^#[0-9A-Fa-f]{6}$/)
      for (let dy = 0; dy < rect.h; dy += 1) {
        for (let dx = 0; dx < rect.w; dx += 1) {
          covered[rect.y + dy][rect.x + dx] += 1
        }
      }
    }
    for (let y = 0; y < MASCOT_GRID; y += 1) {
      for (let x = 0; x < MASCOT_GRID; x += 1) {
        const value = spec.pixels[y][x]
        if (value === 0) {
          assert.equal(covered[y][x], 0)
        } else {
          assert.equal(covered[y][x], 1)
        }
      }
    }
  })
})
