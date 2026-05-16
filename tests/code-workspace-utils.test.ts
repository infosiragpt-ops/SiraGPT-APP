import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  computeLineDiff,
  defaultStarterFiles,
  isSameContent,
  languageForPath,
  normalizePath,
  parseCodeBlocks,
  workspaceExportFilename,
} from "../lib/code-workspace-utils"

describe("languageForPath", () => {
  it("maps common extensions to a canonical language id", () => {
    assert.equal(languageForPath("app.ts"), "typescript")
    assert.equal(languageForPath("app.tsx"), "typescript")
    assert.equal(languageForPath("index.html"), "html")
    assert.equal(languageForPath("style.scss"), "scss")
    assert.equal(languageForPath("Dockerfile.txt"), "plaintext")
    assert.equal(languageForPath("setup.py"), "python")
    assert.equal(languageForPath("notes.md"), "markdown")
  })

  it("returns plaintext for unknown extensions", () => {
    assert.equal(languageForPath("data.xyz"), "plaintext")
    assert.equal(languageForPath("README"), "plaintext")
  })

  it("is case-insensitive on the extension", () => {
    assert.equal(languageForPath("App.TSX"), "typescript")
    assert.equal(languageForPath("Page.JSX"), "javascript")
  })
})

describe("normalizePath", () => {
  it("returns empty string for empty / nullish input", () => {
    assert.equal(normalizePath(""), "")
    // @ts-expect-error - testing the runtime guard
    assert.equal(normalizePath(undefined), "")
  })

  it("flips Windows backslashes to forward slashes", () => {
    assert.equal(normalizePath("src\\components\\App.tsx"), "src/components/App.tsx")
  })

  it("strips a single or multiple leading slashes", () => {
    assert.equal(normalizePath("/app/page.tsx"), "app/page.tsx")
    assert.equal(normalizePath("////page.tsx"), "page.tsx")
  })

  it("trims surrounding whitespace AFTER the leading-slash strip", () => {
    // Order in the implementation: replace `\\`, strip `^/+`, then trim.
    // So a leading slash that follows whitespace is preserved — we lock
    // the existing behaviour here so any reorder shows up explicitly.
    assert.equal(normalizePath("  /a/b.ts  "), "/a/b.ts")
    // Pure trailing-whitespace input still trims cleanly.
    assert.equal(normalizePath("a/b.ts   "), "a/b.ts")
  })
})

describe("workspaceExportFilename", () => {
  it("uses the default label when none is supplied", () => {
    const name = workspaceExportFilename()
    assert.match(name, /^siragpt-code-workspace-\d{8}T\d{6}\.zip$/)
  })

  it("honours a custom label", () => {
    const name = workspaceExportFilename("my-proj")
    assert.match(name, /^my-proj-\d{8}T\d{6}\.zip$/)
  })
})

describe("parseCodeBlocks", () => {
  it("returns [] for empty / nullish input", () => {
    assert.deepEqual(parseCodeBlocks(""), [])
  })

  it("parses a fence with language only", () => {
    const out = parseCodeBlocks("```ts\nconst x = 1\n```")
    assert.equal(out.length, 1)
    assert.equal(out[0].language, "ts")
    assert.equal(out[0].path, null)
    assert.equal(out[0].content, "const x = 1")
    assert.equal(out[0].index, 0)
  })

  it("parses fence info style 1: `lang path/to/file`", () => {
    const out = parseCodeBlocks("```tsx app/code/page.tsx\nexport {}\n```")
    assert.equal(out[0].language, "tsx")
    assert.equal(out[0].path, "app/code/page.tsx")
  })

  it("parses fence info style 2: path-only info string", () => {
    const out = parseCodeBlocks("```app/code/page.tsx\nexport {}\n```")
    assert.equal(out[0].path, "app/code/page.tsx")
    // Language inferred from the path extension.
    assert.equal(out[0].language, "typescript")
  })

  it("parses fence info style 3: `// path:` first line", () => {
    const body = "// path: src/lib/utils.ts\nexport const ok = true"
    const out = parseCodeBlocks("```\n" + body + "\n```")
    assert.equal(out[0].path, "src/lib/utils.ts")
    // First line is consumed; the path-comment is no longer in content.
    assert.ok(!out[0].content.includes("// path:"))
    assert.ok(out[0].content.includes("export const ok = true"))
  })

  it("indexes multiple fenced blocks in encounter order", () => {
    const text = "```ts\na\n```\n\n```css\nb\n```"
    const out = parseCodeBlocks(text)
    assert.equal(out.length, 2)
    assert.equal(out[0].index, 0)
    assert.equal(out[1].index, 1)
    assert.equal(out[0].language, "ts")
    assert.equal(out[1].language, "css")
  })
})

describe("computeLineDiff", () => {
  it("returns all 'kept' lines for identical input", () => {
    const lines = computeLineDiff("a\nb\nc", "a\nb\nc")
    assert.equal(lines.length, 3)
    assert.ok(lines.every((l) => l.kind === "kept"))
  })

  it("flags appended lines as 'added' with new numbers", () => {
    const lines = computeLineDiff("a\nb", "a\nb\nc")
    assert.equal(lines.filter((l) => l.kind === "added").length, 1)
    const added = lines.find((l) => l.kind === "added")!
    assert.equal(added.text, "c")
    assert.equal(added.newNumber, 3)
  })

  it("flags removed lines with old numbers", () => {
    const lines = computeLineDiff("a\nb\nc", "a\nb")
    const removed = lines.find((l) => l.kind === "removed")!
    assert.equal(removed.text, "c")
    assert.equal(removed.oldNumber, 3)
  })

  it("handles a complete content swap (no shared prefix or suffix)", () => {
    const lines = computeLineDiff("foo", "bar")
    assert.equal(lines.length, 2)
    assert.equal(lines[0].kind, "removed")
    assert.equal(lines[0].text, "foo")
    assert.equal(lines[1].kind, "added")
    assert.equal(lines[1].text, "bar")
  })

  it("treats empty before/after correctly", () => {
    const onlyAdds = computeLineDiff("", "a\nb")
    assert.deepEqual(
      onlyAdds.map((l) => l.kind),
      ["added", "added"],
    )
    const onlyRemoves = computeLineDiff("a\nb", "")
    assert.deepEqual(
      onlyRemoves.map((l) => l.kind),
      ["removed", "removed"],
    )
  })
})

describe("isSameContent", () => {
  it("is true for identical strings", () => {
    assert.equal(isSameContent("abc", "abc"), true)
  })
  it("is false for any difference", () => {
    assert.equal(isSameContent("abc", "abcd"), false)
    assert.equal(isSameContent(" abc", "abc"), false)
  })
})

describe("defaultStarterFiles", () => {
  it("returns three seed files in the expected paths", () => {
    const files = defaultStarterFiles()
    const paths = files.map((f) => f.path).sort()
    assert.deepEqual(paths, ["README.md", "app.tsx", "index.html"])
  })

  it("each file carries a non-empty content and matching language", () => {
    for (const f of defaultStarterFiles()) {
      assert.ok(f.content.length > 0, `${f.path} has empty content`)
      assert.equal(f.language, languageForPath(f.path))
    }
  })
})
