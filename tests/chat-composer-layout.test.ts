import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  COMPOSER_TEXTAREA_MIN_PX,
  measureComposerTextarea,
  shouldStackComposer,
} from "../lib/composer-layout"

describe("composer stacked footer layout", () => {
  it("keeps a single-line idle prompt compact", () => {
    assert.equal(
      shouldStackComposer({ scrollHeight: COMPOSER_TEXTAREA_MIN_PX }),
      false,
    )
    assert.deepEqual(
      measureComposerTextarea({
        scrollHeight: 26,
        maxHeight: 200,
      }),
      { height: 26, overflowY: "hidden", stacked: false },
    )
  })

  it("drops the toolbar to the footer once the prompt wraps or has a newline", () => {
    assert.equal(
      shouldStackComposer({ scrollHeight: 48 }),
      true,
    )
    assert.equal(
      shouldStackComposer({ scrollHeight: 26, hasExplicitNewline: true }),
      true,
    )
    assert.equal(
      shouldStackComposer({
        scrollHeight: 26,
        currentlyStacked: true,
        charCount: 80,
      }),
      true,
      "a real draft must keep the model on the footer after the textarea gets wider",
    )
    assert.equal(
      shouldStackComposer({
        scrollHeight: 26,
        currentlyStacked: true,
        charCount: 8,
      }),
      false,
      "short prompts can return to the compact idle row",
    )
  })

  it("grows with content and only scrolls after the professional max height", () => {
    assert.deepEqual(
      measureComposerTextarea({
        scrollHeight: 96,
        maxHeight: 200,
        hasExplicitNewline: true,
      }),
      { height: 96, overflowY: "hidden", stacked: true },
    )
    assert.deepEqual(
      measureComposerTextarea({
        scrollHeight: 260,
        maxHeight: 200,
      }),
      { height: 200, overflowY: "auto", stacked: true },
    )
  })
})
