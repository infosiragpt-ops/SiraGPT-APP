import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { htmlToMd, mdToHtml } from "../lib/markdown-html"

/**
 * markdown-html is the round-trip layer between saved markdown and the
 * Tiptap editor's HTML. These tests pin the configured rules so a
 * future swap of marked/turndown surfaces breaking changes clearly.
 */

describe("mdToHtml", () => {
  it("returns '' for empty input", () => {
    assert.equal(mdToHtml(""), "")
  })

  it("converts ATX headings to <hN>", () => {
    const html = mdToHtml("# Title\n\n## Sub")
    assert.match(html, /<h1>Title<\/h1>/)
    assert.match(html, /<h2>Sub<\/h2>/)
  })

  it("does NOT emit <br> on single newlines (breaks: false)", () => {
    const html = mdToHtml("line one\nline two")
    assert.equal(html.includes("<br>"), false)
  })

  it("renders fenced code blocks as <pre><code>", () => {
    const html = mdToHtml("```ts\nconst x = 1\n```")
    assert.match(html, /<pre>/)
    assert.match(html, /<code/)
    assert.ok(html.includes("const x = 1"))
  })

  it("renders inline links and bold/italic", () => {
    const html = mdToHtml(
      "[link](https://example.com) and **bold** and _italic_",
    )
    assert.match(html, /<a href="https:\/\/example.com">link<\/a>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<em>italic<\/em>/)
  })
})

describe("htmlToMd", () => {
  it("returns '' for empty input", () => {
    assert.equal(htmlToMd(""), "")
  })

  it("emits ATX headings, not Setext", () => {
    const md = htmlToMd("<h1>T</h1>")
    assert.match(md, /^# T/)
    assert.equal(md.includes("==="), false)
  })

  it("emits `-` for bullet lists (configured marker)", () => {
    // turndown emits `- ` with extra whitespace padding by default
    // (e.g. "-   one"). Match the marker, not the exact spacing.
    const md = htmlToMd("<ul><li>one</li><li>two</li></ul>")
    assert.match(md, /^-\s+one/m)
    assert.match(md, /^-\s+two/m)
  })

  it("emits fenced code blocks for <pre><code class='language-X'>", () => {
    const md = htmlToMd(
      '<pre><code class="language-ts">const x = 1</code></pre>',
    )
    assert.match(md, /^```ts/m)
    assert.ok(md.includes("const x = 1"))
  })

  it("emits inline link syntax with the literal href", () => {
    const md = htmlToMd('<a href="https://example.com">site</a>')
    assert.match(md, /\[site\]\(https:\/\/example.com\)/)
  })

  it("emits _italic_ via the configured emDelimiter", () => {
    const md = htmlToMd("<em>italic</em>")
    assert.match(md, /_italic_/)
  })

  it("emits **bold** (strong stays double-asterisk)", () => {
    const md = htmlToMd("<strong>bold</strong>")
    assert.match(md, /\*\*bold\*\*/)
  })
})

describe("htmlToMd · custom taskItem rule", () => {
  it("serialises an unchecked Tiptap task item to `- [ ]`", () => {
    const md = htmlToMd(
      '<ul><li data-type="taskItem" data-checked="false">todo</li></ul>',
    )
    assert.match(md, /^- \[ \] todo$/m)
  })

  it("serialises a checked Tiptap task item to `- [x]`", () => {
    const md = htmlToMd(
      '<ul><li data-type="taskItem" data-checked="true">done</li></ul>',
    )
    assert.match(md, /^- \[x\] done$/m)
  })
})

describe("round-trip stability", () => {
  it("mdToHtml -> htmlToMd preserves headings", () => {
    const input = "# Heading"
    const out = htmlToMd(mdToHtml(input))
    assert.match(out, /^# Heading$/m)
  })

  it("mdToHtml -> htmlToMd preserves bullet lists", () => {
    const input = "- one\n- two"
    const out = htmlToMd(mdToHtml(input))
    assert.match(out, /^-\s+one$/m)
    assert.match(out, /^-\s+two$/m)
  })

  it("mdToHtml -> htmlToMd preserves links", () => {
    const input = "[site](https://example.com)"
    const out = htmlToMd(mdToHtml(input))
    assert.match(out, /\[site\]\(https:\/\/example\.com\)/)
  })
})
