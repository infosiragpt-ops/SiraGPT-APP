import { describe, expect, it } from "vitest"

import { shouldUnwrapInteractiveFence } from "@/lib/interactive-message-blocks"

describe("interactive message fences", () => {
  it("unwraps rich message blocks from markdown pre containers", () => {
    expect(shouldUnwrapInteractiveFence("language-agent-task-state")).toBe(true)
    expect(shouldUnwrapInteractiveFence("language-scientific-papers extra-class")).toBe(true)
  })

  it("keeps regular code blocks inside pre containers", () => {
    expect(shouldUnwrapInteractiveFence("language-typescript")).toBe(false)
    expect(shouldUnwrapInteractiveFence(undefined)).toBe(false)
  })
})
