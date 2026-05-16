import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MAX_CHAT_INPUT_CHARS,
  normalizeChatInput,
  shouldWarnUser,
} from "../lib/chat-input-normalize"

// All special chars are referenced via fromCharCode so this source
// file stays plain ASCII (no embedded NULs / zero-width chars).
const ZWSP = String.fromCharCode(0x200b)
const ZWNJ = String.fromCharCode(0x200c)
const ZWJ = String.fromCharCode(0x200d)
const WJ = String.fromCharCode(0x2060)
const BOM = String.fromCharCode(0xfeff)
const LSEP = String.fromCharCode(0x2028)
const PSEP = String.fromCharCode(0x2029)
const NUL = String.fromCharCode(0x00)

describe("normalizeChatInput · pass-through", () => {
  it("returns the same text when nothing needs stripping", () => {
    const out = normalizeChatInput("hola, como estas?")
    assert.equal(out.value, "hola, como estas?")
    assert.equal(out.changed, false)
    assert.equal(out.truncated, false)
  })

  it("preserves tabs, newlines and CR — they're legitimate whitespace", () => {
    const text = "a\tb\nc\r\nd"
    const out = normalizeChatInput(text)
    assert.equal(out.value, text)
    assert.equal(out.changed, false)
  })

  it("handles nullish / non-string input as empty", () => {
    assert.equal(normalizeChatInput(undefined).value, "")
    assert.equal(normalizeChatInput(null).value, "")
    assert.equal(normalizeChatInput(123).value, "123")
  })
})

describe("normalizeChatInput · zero-width & BOM", () => {
  it("strips zero-width space / non-joiner / joiner", () => {
    const out = normalizeChatInput(`hello${ZWSP}${ZWNJ}${ZWJ}world`)
    assert.equal(out.value, "helloworld")
    assert.equal(out.changed, true)
  })

  it("strips word joiner U+2060 and BOM U+FEFF", () => {
    const out = normalizeChatInput(`${BOM}hi${WJ}!`)
    assert.equal(out.value, "hi!")
    assert.equal(out.changed, true)
  })
})

describe("normalizeChatInput · separators & NUL", () => {
  it("rewrites U+2028 / U+2029 to plain newline", () => {
    const out = normalizeChatInput(`line1${LSEP}line2${PSEP}line3`)
    assert.equal(out.value, "line1\nline2\nline3")
    assert.equal(out.changed, true)
  })

  it("strips NUL bytes entirely", () => {
    const out = normalizeChatInput(`bad${NUL}word`)
    assert.equal(out.value, "badword")
    assert.equal(out.changed, true)
  })
})

describe("normalizeChatInput · forbidden controls", () => {
  it("strips C0 controls (0x01-0x08, 0x0B-0x0C, 0x0E-0x1F)", () => {
    const out = normalizeChatInput(
      `x${String.fromCharCode(0x01)}y${String.fromCharCode(0x1f)}z`,
    )
    assert.equal(out.value, "xyz")
  })

  it("strips DEL (0x7F) and C1 controls (0x80-0x9F)", () => {
    const out = normalizeChatInput(
      `x${String.fromCharCode(0x7f)}y${String.fromCharCode(0x9f)}z`,
    )
    assert.equal(out.value, "xyz")
  })

  it("keeps 0x09 / 0x0A / 0x0D (TAB / LF / CR) intact", () => {
    const text = `\t\n\r`
    const out = normalizeChatInput(text)
    assert.equal(out.value, text)
    assert.equal(out.changed, false)
  })
})

describe("normalizeChatInput · length cap", () => {
  it("truncates when input exceeds MAX_CHAT_INPUT_CHARS", () => {
    const huge = "x".repeat(MAX_CHAT_INPUT_CHARS + 500)
    const out = normalizeChatInput(huge)
    assert.equal(out.value.length, MAX_CHAT_INPUT_CHARS)
    assert.equal(out.truncated, true)
    assert.equal(out.originalLength, MAX_CHAT_INPUT_CHARS + 500)
    assert.equal(shouldWarnUser(out), true)
  })

  it("does not truncate at exactly the cap", () => {
    const exact = "x".repeat(MAX_CHAT_INPUT_CHARS)
    const out = normalizeChatInput(exact)
    assert.equal(out.value.length, MAX_CHAT_INPUT_CHARS)
    assert.equal(out.truncated, false)
    assert.equal(shouldWarnUser(out), false)
  })
})

describe("normalizeChatInput · originalLength", () => {
  it("reports the raw string length pre-cleanup", () => {
    const out = normalizeChatInput(`abc${ZWSP}def`)
    assert.equal(out.originalLength, 7)
    assert.equal(out.value.length, 6)
  })

  it("does not truncate when zero-width strip brings length under the cap", () => {
    // 50 k raw chars total; half are ZWSP. After strip, length is 25 k,
    // well under the 100 k cap, so we should NOT truncate.
    const half = MAX_CHAT_INPUT_CHARS / 4
    const raw = (`x${ZWSP}`).repeat(half)
    const out = normalizeChatInput(raw)
    assert.equal(out.originalLength, half * 2)
    assert.equal(out.value.length, half)
    assert.equal(out.truncated, false)
    assert.equal(out.changed, true)
  })

  it("truncates on the POST-strip length, not the original byte count", () => {
    // Build something that's slightly over the cap AFTER zero-width
    // strip: cap + 10 real chars + a few ZWSPs we'll strip first.
    const meaningful = "y".repeat(MAX_CHAT_INPUT_CHARS + 10)
    const padded = `${ZWSP.repeat(50)}${meaningful}`
    const out = normalizeChatInput(padded)
    assert.equal(out.originalLength, padded.length)
    assert.equal(out.value.length, MAX_CHAT_INPUT_CHARS)
    assert.equal(out.truncated, true)
  })
})
