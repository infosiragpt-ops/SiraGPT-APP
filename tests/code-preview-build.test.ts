import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildPreviewDocument } from "../lib/code-preview-build"

type F = Record<string, { path: string; language: string; content: string; updatedAt: number }>

function files(map: Record<string, string>): F {
  const out: F = {}
  for (const [path, content] of Object.entries(map)) {
    out[path] = { path, language: "x", content, updatedAt: 0 }
  }
  return out
}

describe("buildPreviewDocument", () => {
  it("empty workspace → empty", () => {
    const r = buildPreviewDocument(files({}), null)
    assert.equal(r.kind, "empty")
  })

  it("renders an html entry and injects the console bridge", () => {
    const r = buildPreviewDocument(files({ "index.html": "<html><head></head><body>hola</body></html>" }), null)
    assert.equal(r.kind, "html")
    assert.equal(r.entry, "index.html")
    assert.match(r.html, /hola/)
    assert.match(r.html, /sgpt-preview-console/)
  })

  it("inlines local stylesheets and scripts in html", () => {
    const r = buildPreviewDocument(
      files({
        "index.html": '<html><head><link rel="stylesheet" href="styles.css"></head><body><script src="app.js"></script></body></html>',
        "styles.css": "body{color:red}",
        "app.js": "console.log('hi')",
      }),
      "index.html",
    )
    assert.match(r.html, /body\{color:red\}/)
    assert.match(r.html, /console\.log\('hi'\)/)
    assert.doesNotMatch(r.html, /<link\b/i)
  })

  it("builds a react document from a default export and includes Babel", () => {
    const r = buildPreviewDocument(
      files({ "App.tsx": "export default function App(){ return <div>hola react</div> }" }),
      "App.tsx",
    )
    assert.equal(r.kind, "react")
    assert.match(r.html, /@babel\/standalone/)
    assert.match(r.html, /function App\(\)/)
    assert.match(r.html, /hola react/)
  })

  it("injects workspace css and inlines json imports in react mode", () => {
    const r = buildPreviewDocument(
      files({
        "App.tsx": "import data from './d.json'\nexport default function App(){ return <div>{data.n}</div> }",
        "index.css": ".brand{color:blue}",
        "d.json": '{"n":5}',
      }),
      "App.tsx",
    )
    assert.match(r.html, /\.brand\{color:blue\}/)
    assert.match(r.html, /const data = \{"n":5\}/)
  })

  it("renders markdown with marked", () => {
    const r = buildPreviewDocument(files({ "README.md": "# Hola" }), "README.md")
    assert.equal(r.kind, "markdown")
    assert.match(r.html, /marked/)
  })

  it("renders svg directly", () => {
    const r = buildPreviewDocument(files({ "logo.svg": "<svg><rect/></svg>" }), "logo.svg")
    assert.equal(r.kind, "svg")
    assert.match(r.html, /<rect\/>/)
  })

  it("renders the last defined component when there is no App/default", () => {
    const r = buildPreviewDocument(files({ "Card.tsx": "function Card(){ return <div>card</div> }" }), "Card.tsx")
    assert.equal(r.kind, "react")
    assert.match(r.html, /typeof Card !== 'undefined' && Card/)
  })

  it("server-only languages are unsupported", () => {
    const r = buildPreviewDocument(files({ "main.py": "print('hi')" }), "main.py")
    assert.equal(r.kind, "unsupported")
  })

  it("follows the active file: html wins when active even amid react files", () => {
    const r = buildPreviewDocument(
      files({ "App.tsx": "export default function App(){return null}", "page.html": "<body>page</body>" }),
      "page.html",
    )
    assert.equal(r.kind, "html")
    assert.equal(r.entry, "page.html")
  })
})
