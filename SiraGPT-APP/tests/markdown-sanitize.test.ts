import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { markdownRehypePlugins } from "../lib/markdown-sanitize"

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: markdownRehypePlugins,
      },
      markdown,
    ),
  )
}

test("markdown sanitizer strips executable raw HTML", () => {
  const html = renderMarkdown(
    '<script>alert("x")</script><img src="x" onerror="alert(1)" /><a href="javascript:alert(1)" onclick="alert(2)">bad</a>',
  )

  assert.equal(html.includes("<script"), false)
  assert.equal(html.includes("onerror"), false)
  assert.equal(html.includes("onclick"), false)
  assert.equal(html.includes("javascript:"), false)
})

test("markdown sanitizer preserves controlled agentic search badge markup", () => {
  const html = renderMarkdown(
    '<button type="button" class="agentic-search-status" role="status" aria-live="polite" data-search-activity-id="msg-ai-123" aria-label="Abrir actividad">' +
      '<span class="agentic-search-status__head">' +
      '<span class="agentic-search-status__bars" aria-hidden="true"><span></span><span></span><span></span></span>' +
      '<span class="agentic-search-status__label">Buscando fuentes</span>' +
      '<span class="agentic-search-status__counter">12/50 fuentes</span>' +
      '<span class="agentic-search-status__elapsed">8s</span>' +
      '<span class="agentic-search-status__hint">Actividad</span>' +
      "</span>" +
      '<progress class="agentic-search-status__progress" value="42" max="100">42%</progress>' +
      '<span class="agentic-search-status__chips" aria-hidden="true"><span class="agentic-search-status__chip"><b>OpenAlex</b><i>12</i></span></span>' +
      "</button>",
  )

  assert.match(html, /class="agentic-search-status"/)
  assert.match(html, /data-search-activity-id="msg-ai-123"/)
  assert.match(html, /<progress class="agentic-search-status__progress" value="42" max="100">42%<\/progress>/)
  assert.equal(html.includes("style="), false)
})

test("markdown sanitizer keeps code language and math rendering", () => {
  const html = renderMarkdown("```ts\nconst ok: boolean = true\n```\n\nInline math: $x^2$")

  assert.match(html, /class="language-ts"/)
  assert.match(html, /katex/)
})
