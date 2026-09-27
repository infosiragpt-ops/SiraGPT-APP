import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { markdownRehypePlugins, markdownRemarkPlugins } from "../lib/markdown-sanitize"

// Prod 2026-09-27: «a las 16:44 … a las 14:30» rendered as «a las 16» plus a
// stray block — remark-directive read «:44» / «:30» as text directives.
function render(md: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins, rehypePlugins: markdownRehypePlugins }, md),
  )
}

test("times, ratios and verse references keep their colon in chat markdown", () => {
  for (const [md, expected] of [
    ["El sismo ocurrió a las 16:44 y la réplica a las 14:30.", "El sismo ocurrió a las 16:44 y la réplica a las 14:30."],
    ["Horario: 9:00 a 18:00 (lunes a viernes).", "Horario: 9:00 a 18:00 (lunes a viernes)."],
    ["Hora de Lima: 16:44h, actualizado 14:30hrs.", "Hora de Lima: 16:44h, actualizado 14:30hrs."],
    ["Perú ganó 2:1 y la proporción es 3:2.", "Perú ganó 2:1 y la proporción es 3:2."],
    ["Juan 3:16 y Salmos 23:1-4.", "Juan 3:16 y Salmos 23:1-4."],
    ["Usa std::vector y el puerto 8080:80.", "Usa std::vector y el puerto 8080:80."],
  ] as const) {
    const html = render(md)
    assert.equal(html, `<p>${expected}</p>`, md)
  }
})

test("times inside lists and bold keep the paragraph intact", () => {
  const html = render("- **Tránsito**: cierre a las 16:44 en la Vía Expresa; reapertura a las 14:30.")
  assert.equal(html, "<ul>\n<li><strong>Tránsito</strong>: cierre a las 16:44 en la Vía Expresa; reapertura a las 14:30.</li>\n</ul>")
})

test("callout containers are left to the callout transform and a leaf directive line stays text", () => {
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins as any)
  const tree: any = processor.runSync(processor.parse(":::note\nDato importante a las 16:44.\n:::"))
  const callout = tree.children[0]
  assert.equal(callout.type, "containerDirective")
  assert.equal(callout.data?.hName, "aside")
  assert.equal(callout.children[0].children.map((c: any) => c.value).join(""), "Dato importante a las 16:44.")
  assert.equal(render("::44"), "<p>::44</p>")
})
