import { describe, expect, it } from "vitest"

import { splitStableHead } from "@/lib/markdown-block-split"

const intro = "Estos son los pasos que debes seguir para configurar el proyecto:"

describe("splitStableHead", () => {
  it("cuts on a blank line followed by a column-0 block", () => {
    const content = `${intro}\n\nSegundo párrafo en curso`
    const { head, tail } = splitStableHead(content)
    expect(head).toBe(`${intro}\n`)
    expect(tail).toBe("Segundo párrafo en curso")
  })

  it("does not cut before an indented list continuation", () => {
    const content = `${intro}\n\n1. **Paso**\n\n   Explicación del paso`
    const { head, tail } = splitStableHead(content)
    expect(head).toBe(`${intro}\n`)
    expect(tail).toBe("1. **Paso**\n\n   Explicación del paso")
  })

  it("does not cut before a 4-space nested bullet", () => {
    const content = `${intro}\n\n- Elemento\n\n    - sub`
    const { tail } = splitStableHead(content)
    expect(tail.startsWith("- Elemento")).toBe(true)
  })

  it("waits for the next non-blank line before cutting on a trailing blank", () => {
    const content = `${intro}\n\n- Elemento con texto suficiente\n\n`
    const { tail } = splitStableHead(content)
    expect(tail.startsWith("- Elemento")).toBe(true)
  })

  it("never cuts inside a fenced code block", () => {
    const content = `${intro}\n\n\`\`\`js\nconst a = 1\n\nconst b = 2\n\`\`\``
    const { tail } = splitStableHead(content)
    expect(tail.startsWith("```js")).toBe(true)
  })
})


describe("streaming markdown structural integrity", () => {
  it("keeps a display equation with blank lines in one parser", () => {
    const equation = "$$\nx = 1\n\ny = 2\n$$"
    const { head, tail } = splitStableHead(`${intro}\n\n${equation}`)
    expect(head).toBe(`${intro}\n`)
    expect(tail).toBe(equation)
  })

  it("does not close a fence on a marker followed by code", () => {
    const code = "```text\n```still code\n\nmore code\n```"
    const { tail } = splitStableHead(`${intro}\n\n${code}`)
    expect(tail).toBe(code)
  })

  it("keeps blank-separated items in one loose list", () => {
    const list = "1. Primer elemento\n\n2. Segundo elemento"
    expect(splitStableHead(`${intro}\n\n${list}`).tail).toBe(list)
  })

  it("keeps reference links and their definitions in the same parser", () => {
    const content = `${intro}\n\nConsulta [documentación][manual].\n\n[manual]: https://example.com/docs`
    expect(splitStableHead(content)).toEqual({ head: "", tail: content })
  })
})
