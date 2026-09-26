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

  it("trims surrounding whitespace", () => {
    assert.equal(normalizePath("  a/b.ts  "), "a/b.ts")
    assert.equal(normalizePath("a/b.ts   "), "a/b.ts")
  })

  it("resolves `.` and `..` segments inside the root (Zip Slip guard)", () => {
    assert.equal(normalizePath("src/./a.ts"), "src/a.ts")
    assert.equal(normalizePath("src/../a.ts"), "a.ts")
    assert.equal(normalizePath("a/b/../../c.ts"), "c.ts")
  })

  it("drops leftover `..` so no key can escape the workspace root", () => {
    assert.equal(normalizePath("../../../../.zshrc"), ".zshrc")
    assert.equal(normalizePath("..\\..\\etc\\passwd"), "etc/passwd")
    assert.equal(normalizePath(".."), "")
    assert.equal(normalizePath("a/../../.."), "")
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

  it("rejects prose after the language in style 1 (no phantom apply targets)", () => {
    // Regression: the tail used to be taken as a path verbatim.
    const out = parseCodeBlocks("```ts aquí va la explicación\nconst x = 1\n```")
    assert.equal(out.length, 1)
    assert.equal(out[0].language, "ts")
    assert.equal(out[0].path, null)
  })

  it("normalises `..` out of inferred paths", () => {
    const out = parseCodeBlocks("```\n// path: ../../../secrets.env\nexport {}\n```")
    // The traversal segments are resolved inside the workspace root;
    // the file cannot land outside it.
    assert.equal(out[0].path, "secrets.env")
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

  it("supports `# path:` first-line style (shell-comment syntax)", () => {
    // Style 3 alternate: # path: ... for shell / python / yaml blocks
    // where // would be illegal.
    const body = "# path: scripts/deploy.sh\necho hello"
    const out = parseCodeBlocks("```bash\n" + body + "\n```")
    assert.equal(out[0].path, "scripts/deploy.sh")
    assert.ok(out[0].content.includes("echo hello"))
    assert.ok(!out[0].content.includes("# path:"))
  })

  it("returns content with the trailing newlines trimmed", () => {
    // The fence parser strips trailing \n+ from .content so callers
    // don't have to.
    const out = parseCodeBlocks("```\nhello\n\n\n```")
    assert.equal(out[0].content, "hello")
  })

  it("keeps nested ``` blocks inside a file block (README with bash examples)", () => {
    // Regression: the old regex closed the README at the FIRST ```
    // (the inner bash closer), truncating the file and turning the
    // leftover into phantom blocks.
    const text = [
      "```md README.md",
      "# Mi proyecto",
      "",
      "Instalación:",
      "",
      "```bash",
      "npm install",
      "```",
      "",
      "Y luego arranca el dev server.",
      "```",
      "",
      "```json package.json",
      '{ "name": "demo" }',
      "```",
    ].join("\n")
    const out = parseCodeBlocks(text)
    assert.equal(out.length, 2)
    assert.equal(out[0].path, "README.md")
    assert.ok(out[0].content.includes("```bash"))
    assert.ok(out[0].content.includes("npm install"))
    assert.ok(out[0].content.includes("Y luego arranca el dev server."))
    assert.equal(out[1].path, "package.json")
    assert.equal(out[1].content, '{ "name": "demo" }')
  })

  it("handles multiple nested blocks inside one markdown file", () => {
    const text = [
      "```md docs/guide.md",
      "```sh",
      "echo uno",
      "```",
      "middle",
      "```ts",
      "const dos = 2",
      "```",
      "```",
    ].join("\n")
    const out = parseCodeBlocks(text)
    assert.equal(out.length, 1)
    assert.equal(out[0].path, "docs/guide.md")
    assert.ok(out[0].content.includes("echo uno"))
    assert.ok(out[0].content.includes("const dos = 2"))
    assert.ok(out[0].content.includes("middle"))
  })

  it("supports 4-backtick outer fences: inner ``` never close the file", () => {
    const text = [
      "````md README.md",
      "# Hola",
      "```bash",
      "npm run dev",
      "```",
      "````",
      "```ts app.ts",
      "export {}",
      "```",
    ].join("\n")
    const out = parseCodeBlocks(text)
    assert.equal(out.length, 2)
    assert.equal(out[0].path, "README.md")
    assert.ok(out[0].content.includes("```bash"))
    assert.equal(out[1].path, "app.ts")
    assert.equal(out[1].content, "export {}")
  })

  it("drops an unclosed trailing block (streaming-partial safety)", () => {
    // Matches the previous regex behaviour: a fence still streaming in
    // must not produce a partial file.
    assert.deepEqual(parseCodeBlocks("```ts app.ts\nconst partial = 1"), [])
    const mixed = parseCodeBlocks("```ts a.ts\nok\n```\n```json b.json\n{ \"trunc")
    assert.equal(mixed.length, 1)
    assert.equal(mixed[0].path, "a.ts")
  })

  it("parses filepath / File / filename= comments and a heading above the fence", () => {
    const filepath = parseCodeBlocks("```tsx\n// filepath: src/App.tsx\nexport default function App() { return null }\n```")
    assert.equal(filepath[0].path, "src/App.tsx")
    assert.ok(filepath[0].content.includes("export default"))
    assert.ok(!filepath[0].content.includes("filepath"))

    const fileLabel = parseCodeBlocks("```ts\n// File: lib/math.ts\nexport const n = 1\n```")
    assert.equal(fileLabel[0].path, "lib/math.ts")

    const named = parseCodeBlocks("```tsx filename=components/Hero.tsx\nexport function Hero() { return null }\n```")
    assert.equal(named[0].path, "components/Hero.tsx")

    const heading = parseCodeBlocks("### `pages/index.tsx`\n```tsx\nexport default function Page() { return null }\n```")
    assert.equal(heading[0].path, "pages/index.tsx")
  })

  it("still closes plain language-only blocks at the first bare ```", () => {
    const out = parseCodeBlocks("```ts\nconst x = 1\n```\ntexto suelto\n```css\nb {}\n```")
    assert.equal(out.length, 2)
    assert.equal(out[0].content, "const x = 1")
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

  it("matches an edited line in the middle instead of remove-all/add-all", () => {
    // Regression for the old prefix/suffix-only diff: one changed line
    // mid-file used to render every middle line as removed + added.
    const before = ["l1", "l2", "old", "l4", "l5"].join("\n")
    const after = ["l1", "l2", "new", "l4", "l5"].join("\n")
    const lines = computeLineDiff(before, after)
    assert.deepEqual(
      lines.map((l) => l.kind),
      ["kept", "kept", "removed", "added", "kept", "kept"],
    )
    assert.equal(lines[2].text, "old")
    assert.equal(lines[2].oldNumber, 3)
    assert.equal(lines[3].text, "new")
    assert.equal(lines[3].newNumber, 3)
  })

  it("keeps unchanged interior lines when the tail changes (LCS pairing)", () => {
    const before = ["fn a() {}", "fn b() {}", "fn c() {}"].join("\n")
    const after = ["fn a() {}", "// b removed", "fn c() {}"].join("\n")
    const lines = computeLineDiff(before, after)
    assert.equal(lines.filter((l) => l.kind === "kept" && l.text === "fn c() {}").length, 1)
    assert.equal(lines.filter((l) => l.kind === "removed").length, 1)
    assert.equal(lines.filter((l) => l.kind === "added").length, 1)
  })

  it("falls back to coarse remove/add beyond the DP cell budget", () => {
    // 3000 × 3000 = 9M cells > MAX_DIFF_CELLS: must not hang or OOM,
    // and must still produce a well-formed diff with correct counts.
    const n = 3000
    const before = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n")
    const after = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n")
    const lines = computeLineDiff(before, after)
    assert.equal(lines.length, 2 * n)
    assert.equal(lines.filter((l) => l.kind === "removed").length, n)
    assert.equal(lines.filter((l) => l.kind === "added").length, n)
  })

  it("preserves old/new line numbering through an LCS diff", () => {
    const lines = computeLineDiff("a\nX\nb\nc", "a\nY\nZ\nb\nc")
    assert.deepEqual(
      lines.map((l) => [l.kind, l.oldNumber ?? null, l.newNumber ?? null]),
      [
        ["kept", 1, 1],
        ["removed", 2, null],
        ["added", null, 2],
        ["added", null, 3],
        ["kept", 3, 4],
        ["kept", 4, 5],
      ],
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
