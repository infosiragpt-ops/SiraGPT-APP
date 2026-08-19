import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import * as path from "node:path"

// Anchor CJS resolution at the repo root (the runner always runs from the
// repo root) so backend requires work no matter where test-dist lives.
const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))

type Fact = { text: string; category: string; score?: number }
type LTM = {
  buildMemoryBlock: (facts: Fact[] | null | undefined) => string
  collectionFor: (userId: string | undefined | null) => string
  extractFacts: (openai: unknown, userMsg: string, assistantMsg: string) => Promise<Array<{ fact: string; category: string; confidence: number }>>
  EXTRACTION_SYSTEM_PROMPT: string
}

const ltm = cjsRequire("./backend/src/services/long-term-memory") as LTM

describe("long-term-memory · buildMemoryBlock", () => {
  it("returns empty string for empty or null input", () => {
    assert.equal(ltm.buildMemoryBlock([]), "")
    assert.equal(ltm.buildMemoryBlock(null), "")
    assert.equal(ltm.buildMemoryBlock(undefined), "")
  })

  it("formats recalled facts with category badges", () => {
    const block = ltm.buildMemoryBlock([
      { text: "Vive en La Paz, Bolivia.", category: "personal" },
      { text: "Prefiere respuestas en español.", category: "preference" },
    ])
    assert.match(block, /REMEMBERED ABOUT THE USER/)
    assert.match(block, /\[personal\] Vive en La Paz, Bolivia\./)
    assert.match(block, /\[preference\] Prefiere respuestas en español\./)
  })
})

describe("long-term-memory · collectionFor", () => {
  it("namespaces collections per user id", () => {
    assert.equal(ltm.collectionFor("u123"), "facts:u123")
    assert.equal(ltm.collectionFor("u456"), "facts:u456")
    assert.notEqual(ltm.collectionFor("u123"), ltm.collectionFor("u456"))
  })

  it("falls back to 'anon' when userId is missing", () => {
    assert.equal(ltm.collectionFor(undefined), "facts:anon")
    assert.equal(ltm.collectionFor(null), "facts:anon")
  })
})

// Scripted OpenAI double that returns whatever JSON was queued. Same
// shape as the real SDK so the service can call chat.completions.create.
class FakeOpenAI {
  constructor(private scripted: string[]) {}
  private i = 0
  chat = {
    completions: {
      create: async () => {
        const content = this.scripted[this.i++] ?? '{"facts": []}'
        return { choices: [{ message: { content } }] }
      },
    },
  }
}

describe("long-term-memory · extractFacts", () => {
  it("returns [] when the transcript is too short", async () => {
    const fake = new FakeOpenAI([])
    const out = await ltm.extractFacts(fake, "hi", "ok")
    assert.equal(out.length, 0)
  })

  it("parses JSON facts and passes through those at or above the confidence floor", async () => {
    const fake = new FakeOpenAI([JSON.stringify({
      facts: [
        { fact: "The user is a data scientist.", category: "work", confidence: 0.95 },
        { fact: "The user prefers dark mode.",   category: "preference", confidence: 0.80 },
        { fact: "Unsure maybe pineapple.",        category: "preference", confidence: 0.30 },
      ],
    })])
    const userTurn = "I've been working as a data scientist for a few years and I always use dark mode in every tool. Can you set that as a default preference?"
    const asstTurn = "Noted — I'll keep the palette dark."
    const out = await ltm.extractFacts(fake, userTurn, asstTurn)
    assert.equal(out.length, 2, "should drop the 0.30-confidence fact")
    assert.equal(out[0].fact, "The user is a data scientist.")
    assert.equal(out[0].category, "work")
    assert.equal(out[1].fact, "The user prefers dark mode.")
  })

  it("returns [] on malformed JSON instead of throwing", async () => {
    const fake = new FakeOpenAI(["this is not json { broken"])
    const out = await ltm.extractFacts(fake, "some long enough user turn here for processing", "and the assistant's reply was also reasonably long")
    assert.deepEqual(out, [])
  })

  it("caps extractions at MAX_FACTS_PER_TURN (8)", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      fact: `Fact number ${i + 1}.`,
      category: "knowledge",
      confidence: 0.9,
    }))
    const fake = new FakeOpenAI([JSON.stringify({ facts: many })])
    const out = await ltm.extractFacts(
      fake,
      "The user shared a lot of durable context in one go — enough material to warrant several memory entries.",
      "The assistant acknowledged and summarised the information for the user.",
    )
    assert.ok(out.length <= 8, `expected ≤ 8 facts, got ${out.length}`)
  })
})
