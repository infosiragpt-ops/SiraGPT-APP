import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

function firstRule(css: string, selector: string): string {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  assert.ok(start >= 0, `missing ${selector} rule`)
  const open = css.indexOf("{", start)
  const close = css.indexOf("}", open)
  assert.ok(close > open, `unclosed ${selector} rule`)
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("chat user bubble · short-word wrap", () => {
  it("does not use overflow-wrap:anywhere on the user bubble itself", () => {
    const tsx = source("components/message-component.tsx")
    const marker = '"chat-user-bubble'
    const start = tsx.indexOf(marker)
    assert.ok(start >= 0, "missing chat-user-bubble class")
    const block = tsx.slice(start, tsx.indexOf("}>", start) + 2)

    assert.match(block, /w-max/)
    assert.doesNotMatch(block, /w-fit/)
    assert.doesNotMatch(block, /overflow-wrap:anywhere/)
    assert.doesNotMatch(block, /word-break:break-word/)
    assert.doesNotMatch(block, /break-all/)
  })

  it("sizes the bubble with max-content and wraps at word boundaries", () => {
    const css = source("app/globals.css")
    const rule = firstRule(css, ".chat-user-bubble")

    assert.match(rule, /width:\s*max-content/)
    assert.match(rule, /max-width:\s*min\(70%,\s*32rem\)/)
    assert.match(rule, /overflow-wrap:\s*break-word/)
    assert.match(rule, /word-break:\s*normal/)
    assert.match(rule, /white-space:\s*pre-wrap/)
    assert.doesNotMatch(rule, /overflow-wrap:\s*anywhere/)
    assert.doesNotMatch(rule, /word-break:\s*break-all/)
    assert.doesNotMatch(rule, /width:\s*fit-content/)
  })

  it("still allows anywhere-wrap only on URLs/code inside the bubble", () => {
    const css = source("app/globals.css")
    assert.match(
      css,
      /\.chat-user-bubble :is\(pre, code, table, blockquote, a\) \{[\s\S]*?overflow-wrap:\s*anywhere/,
    )
  })
})
