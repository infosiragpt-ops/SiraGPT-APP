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
  it("renders user text in a p inside a testable bubble, never w-min/break-all", () => {
    const tsx = source("components/message-component.tsx")
    const marker = '"chat-user-bubble'
    const start = tsx.indexOf(marker)
    assert.ok(start >= 0, "missing chat-user-bubble class")
    const block = tsx.slice(start, tsx.indexOf("}>", start) + 2)

    assert.match(tsx, /data-testid="user-message"/)
    assert.match(tsx, /<p className="chat-user-bubble-inner">/)
    assert.doesNotMatch(block, /w-fit/)
    assert.doesNotMatch(block, /w-min/)
    assert.doesNotMatch(block, /max-w-min/)
    assert.doesNotMatch(block, /break-all/)
    assert.doesNotMatch(block, /overflow-wrap:anywhere/)
    assert.doesNotMatch(tsx, /writing-mode:vertical/)
  })

  it("sizes the bubble with max-content, min 44px, horizontal writing mode", () => {
    const css = source("app/globals.css")
    const bubble = firstRule(css, ".chat-user-bubble")
    const text = firstRule(css, ".chat-user-bubble-inner")
    const row = firstRule(css, ".msg--user")
    const stack = firstRule(css, ".msg--user .msg-user-stack")

    assert.match(row, /width:\s*100%/)
    assert.match(row, /min-width:\s*0/)
    assert.match(stack, /width:\s*100%/)
    assert.match(stack, /align-self:\s*stretch/)

    assert.match(bubble, /width:\s*max-content/)
    assert.match(bubble, /min-width:\s*44px/)
    assert.match(bubble, /max-width:\s*min\(80%,\s*720px\)/)
    assert.match(bubble, /flex:\s*0 0 auto/)
    assert.match(bubble, /writing-mode:\s*horizontal-tb/)
    assert.match(bubble, /word-break:\s*normal/)
    assert.match(bubble, /overflow-wrap:\s*break-word/)
    assert.doesNotMatch(bubble, /width:\s*auto/)
    assert.doesNotMatch(bubble, /width:\s*min-content/)
    assert.doesNotMatch(bubble, /width:\s*fit-content/)
    assert.doesNotMatch(bubble, /overflow-wrap:\s*anywhere/)
    assert.doesNotMatch(bubble, /word-break:\s*break-all/)
    assert.doesNotMatch(bubble, /writing-mode:\s*vertical/)

    assert.match(text, /white-space:\s*pre-wrap/)
    assert.match(text, /word-break:\s*normal/)
    assert.match(text, /overflow-wrap:\s*break-word/)
    assert.match(text, /writing-mode:\s*horizontal-tb/)
  })

  it("still allows anywhere-wrap only on URLs/code inside the bubble", () => {
    const css = source("app/globals.css")
    assert.match(
      css,
      /\.chat-user-bubble :is\(pre, code, table, blockquote, a\) \{[\s\S]*?overflow-wrap:\s*anywhere/,
    )
  })
})
