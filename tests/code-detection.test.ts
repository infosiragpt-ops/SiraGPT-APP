import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  combineWebCode,
  detectCodeType,
  detectFramework,
  hasWebDevelopmentCode,
  parseCodeFromContent,
} from "../lib/code-detection"

/**
 * code-detection drives the live-preview surface. It needs to:
 *
 *   1. Classify raw snippets into html / css / javascript / text.
 *   2. Walk a chat message, pull out fenced code blocks, and decide
 *      whether the message has "web code" worth previewing.
 *   3. NOT misclassify non-web languages (python, ts, etc.) as web
 *      just because they happen to contain `<` or `{`.
 *
 * Each suite below pins down one of those concerns.
 */

describe("detectCodeType", () => {
  it("returns 'text' for empty input", () => {
    assert.equal(detectCodeType(""), "text")
  })

  it("classifies obvious HTML", () => {
    assert.equal(detectCodeType("<!DOCTYPE html><html><body><h1>Hi</h1></body></html>"), "html")
    assert.equal(detectCodeType('<div class="x">hi</div>'), "html")
  })

  it("classifies CSS rules", () => {
    assert.equal(detectCodeType(".btn { color: red; }"), "css")
    assert.equal(detectCodeType("@media (max-width: 600px) { body { font-size: 14px; } }"), "css")
  })

  it("classifies JavaScript via document.* patterns (no curlies)", () => {
    // detectCodeType evaluates CSS before JS, so any snippet that
    // contains `{...}` would be misclassified as CSS. The existing
    // contract is "JS only when no curly braces", which we lock in
    // here so the regression is visible if it ever shifts.
    assert.equal(detectCodeType("document.querySelector('.btn')"), "javascript")
    assert.equal(
      detectCodeType("window.addEventListener('load', myInit)"),
      "javascript",
    )
  })

  it("known limitation: a JS function body is misread as CSS due to `{...}`", () => {
    // Pin the existing behaviour so any future tightening of the
    // heuristics shows up here intentionally rather than as a surprise.
    assert.equal(
      detectCodeType("function add(a, b) { return a + b; }"),
      "css",
    )
  })
})

describe("hasWebDevelopmentCode", () => {
  it("returns false for plain prose", () => {
    assert.equal(hasWebDevelopmentCode("Hola, no hay código aquí."), false)
  })

  it("returns true when the message has a fenced HTML block", () => {
    const content = "Aquí está:\n```html\n<div>hi</div>\n```"
    assert.equal(hasWebDevelopmentCode(content), true)
  })

  it("returns true for a fenced CSS block", () => {
    const content = "```css\n.box { color: red; }\n```"
    assert.equal(hasWebDevelopmentCode(content), true)
  })

  it("returns false for a fenced Python block, even when it contains HTML-looking strings", () => {
    const content = '```python\nprint("<div>hi</div>")\n```'
    assert.equal(hasWebDevelopmentCode(content), false)
  })
})

describe("parseCodeFromContent", () => {
  it("returns an empty result when there is no code at all", () => {
    const out = parseCodeFromContent("Solo texto plano sin código.")
    assert.equal(out.hasWebCode, false)
    assert.equal(out.html, "")
    assert.equal(out.css, "")
    assert.equal(out.js, "")
    assert.equal(out.files.length, 0)
  })

  it("separates html / css / js blocks", () => {
    const message = [
      "```html",
      "<button id=\"go\">Go</button>",
      "```",
      "```css",
      "#go { color: red; }",
      "```",
      "```js",
      "document.querySelector('#go').onclick = () => alert('hi');",
      "```",
    ].join("\n")
    const out = parseCodeFromContent(message)
    assert.ok(out.html.includes("<button"))
    assert.ok(out.css.includes("#go"))
    assert.ok(out.js.includes("alert"))
    assert.equal(out.hasWebCode, true)
    assert.equal(out.hasNonWebCode, false)
  })

  it("marks hasNonWebCode when there is a python block (and only python)", () => {
    const message = "```python\ndef hi():\n    print('hi')\n```"
    const out = parseCodeFromContent(message)
    assert.equal(out.hasWebCode, false)
    assert.equal(out.hasNonWebCode, true)
  })

  it("preserves a complete HTML document under combinedCode", () => {
    const html =
      "<!DOCTYPE html>\n<html>\n<head><title>T</title></head>\n<body>hi</body>\n</html>"
    const message = "```html\n" + html + "\n```"
    const out = parseCodeFromContent(message)
    assert.equal(out.hasWebCode, true)
    assert.ok(out.combinedCode && out.combinedCode.includes("<!DOCTYPE html>"))
  })

  it("populates result.files entries with detected filenames + language", () => {
    const message = "```ts\n// path: src/utils.ts\nexport const x = 1\n```"
    const out = parseCodeFromContent(message)
    assert.ok(out.files.length >= 1)
    const f = out.files[0]
    assert.equal(f.language, "ts")
    // The filename should include the path hint somewhere.
    assert.ok(f.name)
  })

  it("generates a default filename when no path hint exists", () => {
    const message = "```python\ndef hi():\n  pass\n```"
    const out = parseCodeFromContent(message)
    assert.equal(out.files.length, 1)
    assert.equal(out.files[0].language, "python")
    assert.ok(out.files[0].name)
  })

  it("extracts a complete HTML document embedded inside a Python block", () => {
    // Non-web-block path: extractCompleteHtmlFromText pulls a full
    // doc out of a triple-quoted Python string.
    const py = [
      'def render():',
      '    return """<!DOCTYPE html><html><head></head><body>hi</body></html>"""',
    ].join('\n')
    const message = "```python\n" + py + "\n```"
    const out = parseCodeFromContent(message)
    assert.equal(out.hasNonWebCode, true)
    assert.ok(out.combinedCode && out.combinedCode.includes("<!DOCTYPE html>"))
  })
})

describe("combineWebCode", () => {
  it("produces a valid HTML5 skeleton that includes all three slots", () => {
    const html = "<h1>Hello</h1>"
    const css = ".x { color: red; }"
    const js = "console.log('hi')"
    const out = combineWebCode(html, css, js, "My Page")
    assert.ok(out.startsWith("<!DOCTYPE html>"))
    assert.ok(out.includes("<title>My Page</title>"))
    assert.ok(out.includes(".x { color: red; }"))
    assert.ok(out.includes("<h1>Hello</h1>"))
    assert.ok(out.includes("console.log('hi')"))
  })

  it("uses the default title when none is supplied", () => {
    const out = combineWebCode("", "", "")
    assert.ok(out.includes("<title>Generated Website</title>"))
  })
})

describe("detectFramework", () => {
  it("identifies React via the canonical import pattern", () => {
    assert.equal(
      detectFramework("import React, { useState } from 'react'"),
      "react",
    )
  })

  it("identifies Vue via <template> + Vue. patterns", () => {
    assert.equal(detectFramework("<template><div>hi</div></template>"), "vue")
  })

  it("identifies Angular via @Component decorator", () => {
    assert.equal(detectFramework("@Component({ selector: 'app' })"), "angular")
  })

  it("returns null when no framework matches", () => {
    assert.equal(detectFramework("plain text only"), null)
  })

  it("identifies 'vanilla' via DOM API usage", () => {
    // The FRAMEWORK_PATTERNS object is iterated in declaration order;
    // react/vue/angular come first, vanilla last — so a snippet that
    // only uses DOM APIs falls through to vanilla.
    assert.equal(
      detectFramework("document.getElementById('x').addEventListener('click', fn)"),
      "vanilla",
    )
  })

  it("prefers react over vanilla when both signals are present", () => {
    // React import wins over DOM-API usage because react is iterated first.
    assert.equal(
      detectFramework(
        "import React from 'react'; document.querySelector('.x')",
      ),
      "react",
    )
  })
})
