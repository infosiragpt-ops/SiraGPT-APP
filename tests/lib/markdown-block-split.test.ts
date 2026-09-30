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
