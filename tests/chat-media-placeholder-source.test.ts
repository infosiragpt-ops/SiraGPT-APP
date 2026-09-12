import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

/**
 * Source contract for the duplicate-placeholder fix: the send flow appends a
 * generic empty assistant bubble for every turn, and the image/video handlers
 * append their own typed card. Before handing off to those handlers the
 * generic bubble must be removed, otherwise the post-generation merge keeps
 * the surplus local card as an orphan (blank "Generando" that never ends).
 */
const source = readFileSync("components/chat-interface-enhanced.tsx", "utf8")

describe("send flow — one local placeholder per media turn", () => {
  it("defines the drop helper on the generic placeholder id", () => {
    assert.match(source, /const dropGenericAssistantPlaceholder = \(\) => \{[\s\S]{0,400}m\?\.id !== assistantPlaceholder\.id/)
  })

  it("drops the generic bubble before every image and video hand-off (fast path + classified path)", () => {
    const imageCalls = source.match(/dropGenericAssistantPlaceholder\(\);\s*\n\s*await handleImageGeneration\(/g) || []
    const videoCalls = source.match(/dropGenericAssistantPlaceholder\(\);\s*\n\s*await handleVideoGeneration\(/g) || []
    assert.equal(imageCalls.length, 2, "image: chip fast path + classified 'image' case")
    assert.equal(videoCalls.length, 2, "video: chip fast path + classified 'video' case")
  })

  it("never calls handleImageGeneration from the send flow without dropping the bubble first", () => {
    const sendStart = source.indexOf("const dropGenericAssistantPlaceholder = () => {")
    const sendEnd = source.indexOf("const handleImageGeneration = async (")
    const body = source.slice(sendStart, sendEnd)
    const total = (body.match(/await handleImageGeneration\(/g) || []).length
    const guarded = (body.match(/dropGenericAssistantPlaceholder\(\);\s*\n\s*await handleImageGeneration\(/g) || []).length
    assert.equal(total, guarded)
  })
})
