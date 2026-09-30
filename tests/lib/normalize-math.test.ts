import { describe, expect, it } from "vitest"

import { normalizeMathDelimiters } from "@/lib/markdown/normalize-math"

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( ... \\) to $ ... $", () => {
    expect(normalizeMathDelimiters("La energía es \\(E = mc^2\\) fin.")).toBe(
      "La energía es $E = mc^2$ fin.",
    )
  })

  it("converts a whole-line display \\[ ... \\] to a $$ block on its own lines", () => {
    expect(normalizeMathDelimiters("\\[\\int_0^1 x^2\\,dx\\]")).toBe(
      "$$\n\\int_0^1 x^2\\,dx\n$$",
    )
  })

  it("keeps the indentation of a display block inside a list item", () => {
    expect(normalizeMathDelimiters("- item\n  \\[x^2\\]")).toBe("- item\n  $$\n  x^2\n  $$")
  })

  it("turns a whole-line $$ ... $$ into a display block", () => {
    expect(normalizeMathDelimiters("$$E=mc^2$$")).toBe("$$\nE=mc^2\n$$")
  })

  it("keeps a mid-sentence \\[ ... \\] on the same line", () => {
    expect(normalizeMathDelimiters("a \\[x\\] b")).toBe("a $$x$$ b")
  })

  it("is idempotent on display block output", () => {
    const once = normalizeMathDelimiters("\\[\\int_0^1 x^2\\,dx\\]")
    expect(normalizeMathDelimiters(once)).toBe(once)
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

  describe("currency dollars", () => {
    it("escapes prices so they do not open inline math", () => {
      expect(normalizeMathDelimiters("El plan Pro cuesta $10 al mes y el anterior $5")).toBe(
        "El plan Pro cuesta \\$10 al mes y el anterior \\$5",
      )
      expect(normalizeMathDelimiters("$10 y $20")).toBe("\\$10 y \\$20")
      expect(normalizeMathDelimiters("de $10-$20 al mes")).toBe("de \\$10-\\$20 al mes")
    })

    it("leaves real dollar math alone", () => {
      expect(normalizeMathDelimiters("Sea $2x$ y $3 + 4$ ok")).toBe("Sea $2x$ y $3 + 4$ ok")
      expect(normalizeMathDelimiters("$1$ y $2$")).toBe("$1$ y $2$")
      expect(normalizeMathDelimiters("Vale \\(5\\) y cuesta $5")).toBe("Vale $5$ y cuesta \\$5")
    })

    it("does not touch prices inside inline code", () => {
      expect(normalizeMathDelimiters("`$10 y $20`")).toBe("`$10 y $20`")
    })

    it("is idempotent", () => {
      const once = normalizeMathDelimiters("El plan Pro cuesta $10 al mes y el anterior $5")
      expect(normalizeMathDelimiters(once)).toBe(once)
    })

    it("keeps converted \\( … \\) math with a digit and trailing space on a second pass", () => {
      const once = normalizeMathDelimiters("Sea \\(5 \\times 3 \\) ok")
      expect(once).toBe("Sea $5 \\times 3$ ok")
      expect(normalizeMathDelimiters(once)).toBe(once)
    })
  })
})
