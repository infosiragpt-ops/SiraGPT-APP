import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildPreviewDocument, projectNeedsDevServer } from "../lib/code-preview-build"

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

  it("escapes a literal </script> inside markdown so the inline script is not terminated early", () => {
    const md = "# Doc\n\n```html\n</script>\n```\n"
    const r = buildPreviewDocument(files({ "README.md": md }), "README.md")
    assert.equal(r.kind, "markdown")
    // Isolate the marked.parse(...) inline payload that embeds the raw markdown.
    const m = r.html.match(/marked\.parse\((".*?")\)/)
    assert.ok(m, "expected a marked.parse(...) call with a JSON string payload")
    const payload = m![1]
    // The doc's literal </script> must be escaped inside the payload, never raw —
    // a raw </script would terminate the inline <script> element early.
    assert.doesNotMatch(payload, /<\/script/i)
    assert.match(payload, /<\\\/script/)
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

  it("does not treat a plain TypeScript utility file as a blank React screen", () => {
    const r = buildPreviewDocument(
      files({ "control-ui-chunking.ts": "export function chunk(items: string[]) { return items.join(',') }" }),
      "control-ui-chunking.ts",
    )
    assert.equal(r.kind, "unsupported")
    assert.equal(r.entry, "control-ui-chunking.ts")
    assert.match(r.html, /no es una pantalla web renderizable/i)
  })

  it("server-only languages are unsupported", () => {
    const r = buildPreviewDocument(files({ "main.py": "print('hi')" }), "main.py")
    assert.equal(r.kind, "unsupported")
  })

  it("shims css-module imports so styles.x resolves and injects the css", () => {
    const r = buildPreviewDocument(
      files({
        "App.tsx": "import styles from './App.module.css'\nexport default function App(){ return <div className={styles.title}>hi</div> }",
        "App.module.css": ".title{color:red}",
      }),
      "App.tsx",
    )
    assert.equal(r.kind, "react")
    assert.match(r.html, /const styles = new Proxy/)
    assert.match(r.html, /\.title\{color:red\}/)
  })

  it("follows the active file: html wins when active even amid react files", () => {
    const r = buildPreviewDocument(
      files({ "App.tsx": "export default function App(){return null}", "page.html": "<body>page</body>" }),
      "page.html",
    )
    assert.equal(r.kind, "html")
    assert.equal(r.entry, "page.html")
  })

  it("a Vite project routes to ▶ Ejecutar instead of a blank srcdoc render", () => {
    const vite = files({
      "package.json": '{"devDependencies":{"vite":"^7.1.0"}}',
      "index.html": '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      "src/main.tsx": "import App from './App'",
      "src/App.tsx": "export default function App(){ return <div>landing</div> }",
    })
    const r = buildPreviewDocument(vite, "index.html")
    assert.equal(r.kind, "unsupported")
    assert.equal(r.entry, "index.html")
    assert.match(r.html, /Ejecutar/)
  })

  it("a Vite project keeps the project entry in the preview bar when a source file is active", () => {
    const vite = files({
      "package.json": '{"devDependencies":{"vite":"^7.1.0"}}',
      "index.html": '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      "src/control-ui-chunking.ts": "export const chunk = 2",
      "src/main.tsx": "import App from './App'",
      "src/App.tsx": "export default function App(){ return <div>landing</div> }",
    })
    const r = buildPreviewDocument(vite, "src/control-ui-chunking.ts")
    assert.equal(r.kind, "unsupported")
    assert.equal(r.entry, "index.html")
    assert.match(r.html, /dev server/)
  })

  it("markdown/svg files still preview inside a Vite project", () => {
    const vite = files({
      "package.json": '{"devDependencies":{"vite":"^7.1.0"}}',
      "README.md": "# Hola",
    })
    const r = buildPreviewDocument(vite, "README.md")
    assert.equal(r.kind, "markdown")
  })

  it("a package.json without a bundler keeps the static preview path", () => {
    const plain = files({
      "package.json": '{"dependencies":{"lodash":"^4.0.0"}}',
      "index.html": "<html><body>hola</body></html>",
    })
    const r = buildPreviewDocument(plain, null)
    assert.equal(r.kind, "html")
  })

  it("a bundler index.html whose entry has no leading slash still routes to ▶ Ejecutar", () => {
    const vite = files({
      "package.json": '{"devDependencies":{"vite":"^7.1.0"}}',
      "index.html": '<html><body><div id="root"></div><script type="module" src="src/main.tsx"></script></body></html>',
      "src/main.tsx": "import App from './App'",
    })
    const r = buildPreviewDocument(vite, "index.html")
    assert.equal(r.kind, "unsupported")
    assert.match(r.html, /Ejecutar/)
  })

  it("a self-contained index.html previews instantly even alongside a Next package.json (deterministic builder output)", () => {
    const builderApp = files({
      "package.json": '{"dependencies":{"next":"^14.0.0","react":"^18.0.0"}}',
      "app/page.tsx": "export default function Page(){ return <div>app</div> }",
      "index.html":
        '<!doctype html><html lang="es"><head>' +
        '<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>' +
        '<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>' +
        "</head><body><div id=\"root\"></div>" +
        '<script>window.__APP__ = {"name":"Mi App"};</script>' +
        '<script>ReactDOM.createRoot(document.getElementById("root")).render(React.createElement("h1", null, "Hola"));</script>' +
        "</body></html>",
    })
    const r = buildPreviewDocument(builderApp, "index.html")
    assert.equal(r.kind, "html")
    assert.equal(r.entry, "index.html")
    assert.match(r.html, /Hola/)
  })

  it("auto-runs a real generated Next app even when it includes an instant index.html preview", () => {
    const builderApp = files({
      "package.json": '{"scripts":{"dev":"next dev"},"dependencies":{"next":"^14.0.0","react":"^18.0.0"}}',
      "app/page.tsx": "export default function Page(){ return <div>app</div> }",
      "app/api/customers/route.ts": "export async function GET(){ return Response.json([]) }",
      "prisma/schema.prisma": "model Customer { id String @id }",
      "index.html":
        '<!doctype html><html lang="es"><head>' +
        '<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>' +
        '<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>' +
        "</head><body><div id=\"root\"></div>" +
        '<script>ReactDOM.createRoot(document.getElementById("root")).render(React.createElement("h1", null, "Hola"));</script>' +
        "</body></html>",
    })

    assert.equal(projectNeedsDevServer(builderApp), true)
  })

  it("does not auto-run a bundler package that only has a self-contained HTML document", () => {
    const staticOnly = files({
      "package.json": '{"dependencies":{"vite":"^7.1.0","react":"^18.0.0"}}',
      "index.html":
        '<!doctype html><html lang="es"><body><div id="root"></div>' +
        '<script>document.getElementById("root").textContent = "Hola"</script>' +
        "</body></html>",
    })

    assert.equal(projectNeedsDevServer(staticOnly), false)
  })
})
