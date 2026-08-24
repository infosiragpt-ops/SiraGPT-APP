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
  it("renders user text as an inline span, not a block prose <p>", () => {
    const tsx = source("components/message-component.tsx")
    const marker = '"chat-user-bubble'
    const start = tsx.indexOf(marker)
    assert.ok(start >= 0, "missing chat-user-bubble class")
    const block = tsx.slice(start, tsx.indexOf("}>", start) + 2)

    assert.doesNotMatch(block, /w-fit/)
    assert.doesNotMatch(block, /overflow-wrap:anywhere/)
    assert.doesNotMatch(block, /word-break:break-word/)
    assert.doesNotMatch(block, /break-all/)
    assert.match(tsx, /chat-user-bubble-inner/)
    assert.match(tsx, /<span className="chat-user-bubble-inner">/)
  })

  it("sizes the bubble as inline-block so short words stay on one line", () => {
    const css = source("app/globals.css")
    const rule = firstRule(css, ".chat-user-bubble")

    assert.match(rule, /display:\s*inline-block/)
    assert.match(rule, /width:\s*auto/)
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
