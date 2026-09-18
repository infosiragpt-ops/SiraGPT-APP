import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"

import { markdownRehypePlugins, markdownRemarkPlugins } from "../lib/markdown-sanitize"
import { demoteOverlongHeadings } from "../lib/markdown/remark-demote-overlong-headings"

const render = (md: string) =>
  renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins, rehypePlugins: markdownRehypePlugins }, md))

const longParagraph = "Factores asociados a la automedicación en usuarios de una botica de El Milagro, 2027. El estudio analizó a 220 usuarios de una botica en El Milagro (Trujillo) durante 2027 para identificar factores asociados a la automedicación. Los factores asociados fueron el bajo nivel educativo (OR 2.4), la falta de tiempo para acudir al médico (OR 1.9) y la recomendación de familiares (OR 1.7)."

test("a paragraph-length line wrapped in heading syntax renders as a paragraph", () => {
  const html = render(`## ${longParagraph}`)
  assert.doesNotMatch(html, /<h[1-6]/)
  assert.match(html, /<p>Factores asociados/)
})

test("real headings keep their level and their anchor", () => {
  const html = render("## Resultados\n\nTexto normal.")
  assert.match(html, /<h2[^>]*>/)
  assert.match(html, /<p>Texto normal\.<\/p>/)
})

test("demoteOverlongHeadings is pure and reports how many nodes it changed", () => {
  const tree = { type: "root", children: [
    { type: "heading", depth: 1, children: [{ type: "text", value: "x".repeat(200) }] },
    { type: "heading", depth: 2, children: [{ type: "text", value: "Corto" }] },
    { type: "blockquote", children: [{ type: "heading", depth: 3, children: [{ type: "text", value: "y".repeat(161) }] }] },
  ] }
  assert.equal(demoteOverlongHeadings(tree as any), 2)
  assert.equal((tree.children[0] as any).type, "paragraph")
  assert.equal((tree.children[1] as any).type, "heading")
  assert.equal(((tree.children[2] as any).children[0] as any).type, "paragraph")
})
