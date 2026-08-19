import { describe, expect, it } from "vitest"

import { normalizeMathDelimiters } from "@/lib/markdown/normalize-math"

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( ... \\) to $ ... $", () => {
    expect(normalizeMathDelimiters("La energía es \\(E = mc^2\\) fin.")).toBe(
      "La energía es $E = mc^2$ fin.",
    )
  })

  it("converts display \\[ ... \\] to $$ ... $$", () => {
    expect(normalizeMathDelimiters("\\[\\int_0^1 x^2\\,dx\\]")).toBe(
      "$$\\int_0^1 x^2\\,dx$$",
    )
  })

  it("converts multiple inline expressions in one string", () => {
    expect(normalizeMathDelimiters("Sea \\(x\\) y \\(y = x^2\\).")).toBe(
      "Sea $x$ y $y = x^2$.",
    )
  })

  it("leaves $-delimited math untouched", () => {
    const input = "Inline $a^2+b^2=c^2$ and $$E=mc^2$$ ok."
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it("is a no-op when there are no bracket delimiters", () => {
    const input = "Texto normal sin matemáticas."
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it("does not touch bracket delimiters inside inline code", () => {
    const input = "Llama a `f\\(x\\)` en el código."
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it("does not touch bracket delimiters inside fenced code blocks", () => {
    const input = "```python\ndef f\\(x\\): return x\n```"
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it("converts math outside code while preserving code inside the same string", () => {
    const input = "Fórmula \\(a+b\\) y código `f\\(x\\)` juntos."
    expect(normalizeMathDelimiters(input)).toBe(
      "Fórmula $a+b$ y código `f\\(x\\)` juntos.",
    )
  })

  it("is idempotent", () => {
    const once = normalizeMathDelimiters("Energía \\(E=mc^2\\) fin.")
    expect(normalizeMathDelimiters(once)).toBe(once)
  })
})
