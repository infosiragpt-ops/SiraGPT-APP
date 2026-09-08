import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  collectActionLabels,
  COMPUTER_USE_VIEWPORT,
  mapContainedImageClick,
  normalizeBrowserUrl,
} from "../lib/chat/browser-controller"

describe("browser controller helpers", () => {
  it("maps a click on a contained screenshot back to the 1024x768 viewport", () => {
    const container = { left: 100, top: 50, width: 512, height: 384 }
    const click = mapContainedImageClick(
      { clientX: 100 + 256, clientY: 50 + 192 },
      container,
      COMPUTER_USE_VIEWPORT,
    )
    assert.deepEqual(click, { x: 512, y: 384 })
  })

  it("ignores clicks on letterbox margins", () => {
    const container = { left: 0, top: 0, width: 1024, height: 900 }
    const miss = mapContainedImageClick({ clientX: 10, clientY: 10 }, container)
    assert.equal(miss, null)
  })

  it("normalizes URLs and action labels from WS payloads", () => {
    assert.equal(normalizeBrowserUrl(" https://siragpt.com/chat "), "https://siragpt.com/chat")
    assert.equal(normalizeBrowserUrl("  "), null)
    assert.deepEqual(
      collectActionLabels({ labels: ["click", "type"] }),
      ["click", "type"],
    )
    assert.deepEqual(
      collectActionLabels({ actions: [{ type: "scroll" }, { type: "wait" }] }),
      ["scroll", "wait"],
    )
  })
})
