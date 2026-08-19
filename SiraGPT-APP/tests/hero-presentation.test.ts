import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  pickDisplayName,
  pickGreeting,
  sampleSixFromPool,
} from "../lib/hero-presentation"

describe("hero-presentation · pickGreeting", () => {
  const mk = (hour: number) => {
    const d = new Date(2026, 0, 1, hour, 0, 0)
    return d
  }

  it("returns 'Buenos días' between 06:00 and 12:59", () => {
    assert.equal(pickGreeting(mk(6)), "Buenos días")
    assert.equal(pickGreeting(mk(10)), "Buenos días")
    assert.equal(pickGreeting(mk(12)), "Buenos días")
  })

  it("returns 'Buenas tardes' between 13:00 and 19:59", () => {
    assert.equal(pickGreeting(mk(13)), "Buenas tardes")
    assert.equal(pickGreeting(mk(17)), "Buenas tardes")
    assert.equal(pickGreeting(mk(19)), "Buenas tardes")
  })

  it("returns 'Buenas noches' before 06:00 and after 19:59", () => {
    assert.equal(pickGreeting(mk(0)), "Buenas noches")
    assert.equal(pickGreeting(mk(5)), "Buenas noches")
    assert.equal(pickGreeting(mk(20)), "Buenas noches")
    assert.equal(pickGreeting(mk(23)), "Buenas noches")
  })

  it("defaults to now() when called without args", () => {
    // We can't assert the exact value, just that the call works and
    // returns one of the four known strings.
    const greeting = pickGreeting()
    assert.ok(
      ["Buenas noches", "Buenos días", "Buenas tardes"].includes(greeting),
      `unexpected greeting: ${greeting}`,
    )
  })
})

describe("hero-presentation · pickDisplayName", () => {
  it("returns the first word of a multi-token name", () => {
    assert.equal(pickDisplayName("Juan Pérez"), "Juan")
    assert.equal(pickDisplayName("Ana María González"), "Ana")
  })

  it("returns the whole name when it's a single token within the cap", () => {
    assert.equal(pickDisplayName("Sofía"), "Sofía")
  })

  it("returns null for empty / whitespace-only / nullish input", () => {
    assert.equal(pickDisplayName(undefined), null)
    assert.equal(pickDisplayName(null), null)
    assert.equal(pickDisplayName(""), null)
    assert.equal(pickDisplayName("   "), null)
    assert.equal(pickDisplayName("\t\n"), null)
  })

  it("returns null when the first token is longer than 24 chars", () => {
    const tooLong = "Aaaaaaaaaaaaaaaaaaaaaaaaaaa" // 27 chars
    assert.equal(pickDisplayName(tooLong), null)
  })

  it("collapses any whitespace as a delimiter (tabs, newlines, multiple spaces)", () => {
    assert.equal(pickDisplayName("María\tGonzález"), "María")
    assert.equal(pickDisplayName("Pedro   López"), "Pedro")
    assert.equal(pickDisplayName("Carmen\nDíaz"), "Carmen")
  })
})

describe("hero-presentation · sampleSixFromPool", () => {
  it("returns exactly 6 elements", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
    const result = sampleSixFromPool(pool, () => 0.5)
    assert.equal(result.length, 6)
  })

  it("returns no duplicates", () => {
    const pool = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    const result = sampleSixFromPool(pool, Math.random)
    const unique = new Set(result)
    assert.equal(unique.size, 6)
  })

  it("only returns elements that were in the input pool", () => {
    const pool = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
    const result = sampleSixFromPool(pool, Math.random)
    for (const item of result) {
      assert.ok(pool.includes(item), `unexpected item: ${item}`)
    }
  })

  it("is deterministic when given a deterministic rng", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
    // Sequence-based rng: 0, 0.1, 0.2, … cycling. Same seed → same output.
    const seq = (start: number) => {
      let n = start
      return () => {
        const v = (n % 1)
        n += 0.13
        return v
      }
    }
    const first = sampleSixFromPool(pool, seq(0))
    const second = sampleSixFromPool(pool, seq(0))
    assert.deepEqual(first, second)
  })

  it("does not mutate the input pool", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h"]
    const snapshot = [...pool]
    sampleSixFromPool(pool, Math.random)
    assert.deepEqual(pool, snapshot)
  })

  it("throws on a pool smaller than 6", () => {
    assert.throws(
      () => sampleSixFromPool(["a", "b", "c"], Math.random),
      /at least 6 elements/,
    )
    assert.throws(
      () => sampleSixFromPool([], Math.random),
      /at least 6 elements/,
    )
  })

  it("works on a pool of exactly 6 (uses the whole thing in some order)", () => {
    const pool = ["a", "b", "c", "d", "e", "f"]
    const result = sampleSixFromPool(pool, Math.random)
    assert.equal(result.length, 6)
    assert.deepEqual([...result].sort(), [...pool].sort())
  })
})
