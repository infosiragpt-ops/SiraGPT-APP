import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const cjsRequire = createRequire(__filename)

// Use a per-process temp artifact dir so verify_artifact tests don't
// touch the real uploads/ folder. AGENT_ARTIFACT_DIR is read at module
// load time inside task-tools.js, so we set it before requiring.
const tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-artifacts-"))
process.env.AGENT_ARTIFACT_DIR = tmpArtifactDir

const taskTools = cjsRequire("../../backend/src/services/agents/task-tools") as {
  EXTENSION_TO_MIME: Record<string, string>
  ARTIFACT_DIR: string
  INTERNAL: {
    verifyArtifact: { execute: (args: { artifactId: string }, ctx?: unknown) => Promise<{ ok: boolean; error?: string; sizeBytes?: number; filename?: string }> }
    metadataPathFor: (id: string) => string
    previewText: (s: unknown, max?: number) => string
    sanitizeArtifactFilename: (s: string) => string
  }
}

const agentTools = cjsRequire("../../backend/src/services/agents/agent-tools") as {
  STATIC_CHECKS: Array<{
    id: string
    scan: (text: string, ctx: { language: string; lines: string[]; codeMask: boolean[] }) => Array<{ severity: string; line: number; message: string }>
  }>
  buildCommentCodeMask: (text: string, language: string) => { lines: string[]; codeMask: boolean[] }
  commentPrefixFor: (source: string) => string
  formatChunkSeparator: (prefix: string, title: string) => string
}

describe("task-tools · EXTENSION_TO_MIME coverage", () => {
  it("maps the common web/image/video extensions that were previously missing", () => {
    const mimes = taskTools.EXTENSION_TO_MIME
    assert.equal(mimes.html, "text/html")
    assert.equal(mimes.htm, "text/html")
    assert.equal(mimes.xml, "application/xml")
    assert.equal(mimes.png, "image/png")
    assert.equal(mimes.jpg, "image/jpeg")
    assert.equal(mimes.jpeg, "image/jpeg")
    assert.equal(mimes.webp, "image/webp")
    assert.equal(mimes.mp4, "video/mp4")
    assert.equal(mimes.mp3, "audio/mpeg")
    assert.equal(mimes.zip, "application/zip")
  })

  it("preserves the existing office/document mappings", () => {
    const mimes = taskTools.EXTENSION_TO_MIME
    assert.equal(mimes.xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert.equal(mimes.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    assert.equal(mimes.pdf, "application/pdf")
    assert.equal(mimes.csv, "text/csv")
  })
})

describe("task-tools · verify_artifact lookup", () => {
  it("returns a structured error when the artifact id is unknown without scanning thousands of files", async () => {
    const result = await taskTools.INTERNAL.verifyArtifact.execute({ artifactId: "deadbeef00000000" })
    assert.equal(result.ok, false)
    assert.match(result.error || "", /not found/)
  })

  it("locates an artifact via its metadata sidecar without iterating the directory", async () => {
    // Plant an artifact that uses ONLY the metadata fast path. We
    // intentionally also create a decoy file that starts with the same
    // id prefix to prove the lookup respects the metadata filename
    // rather than picking the first readdir match.
    const id = "abc1234567890def"
    const filename = "report.txt"
    const stored = `${id}-${filename}`
    fs.writeFileSync(path.join(tmpArtifactDir, stored), "hello world\n")
    fs.writeFileSync(path.join(tmpArtifactDir, `${id}-decoy.bin`), "xx")
    fs.writeFileSync(taskTools.INTERNAL.metadataPathFor(id), JSON.stringify({
      id,
      filename,
      format: "txt",
      mime: "text/plain",
      sizeBytes: 12,
      validation: null,
      createdAt: new Date().toISOString(),
    }))

    const result = await taskTools.INTERNAL.verifyArtifact.execute({ artifactId: id })
    // The verifier shells out to python; in environments without python
    // the result.ok may be false but filename + size should still come
    // from the JS-side fallbacks.
    assert.equal(result.filename, filename)
    assert.ok((result.sizeBytes ?? 0) > 0)
  })
})

describe("task-tools · sanitizeArtifactFilename", () => {
  it("preserves the extension when truncating very long filenames", () => {
    const long = "a".repeat(200) + ".xlsx"
    const out = taskTools.INTERNAL.sanitizeArtifactFilename(long)
    assert.ok(out.endsWith(".xlsx"), `expected .xlsx preserved, got ${out}`)
    assert.ok(out.length <= 120)
  })

  it("replaces unsafe characters and falls back to 'artifact'", () => {
    assert.equal(taskTools.INTERNAL.sanitizeArtifactFilename(""), "artifact")
    assert.equal(taskTools.INTERNAL.sanitizeArtifactFilename("hi there/../etc.docx"), "hi_there_.._etc.docx")
  })
})

describe("agent-tools · commentPrefixFor JSON handling", () => {
  it("returns an empty prefix for JSON files so chunk separators don't break JSON", () => {
    assert.equal(agentTools.commentPrefixFor("data.json"), "")
    assert.equal(agentTools.formatChunkSeparator("", "chunk-1"), "")
  })

  it("still uses // for unknown extensions", () => {
    assert.equal(agentTools.commentPrefixFor("foo.go"), "//")
    assert.equal(agentTools.commentPrefixFor("foo"), "//")
  })

  it("uses # for python", () => {
    assert.equal(agentTools.commentPrefixFor("script.py"), "#")
  })
})

describe("task-tools · previewText resilience", () => {
  it("survives circular references without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    const out = taskTools.INTERNAL.previewText(obj, 200)
    assert.equal(typeof out, "string")
    assert.ok(out.length > 0)
  })

  it("falls back to String() for bigint / undefined values", () => {
    assert.equal(taskTools.INTERNAL.previewText(BigInt(7)), "7")
    assert.equal(taskTools.INTERNAL.previewText(undefined), "undefined")
  })
})

describe("agent-tools · static_checks console_log expansions", () => {
  function runConsoleCheck(text: string, language: string) {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "console_log")!
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, language)
    return check.scan(text, { language, lines, codeMask })
  }

  it("flags python breakpoint() and pdb.set_trace() leftovers", () => {
    const py = [
      "def go():",
      "    breakpoint()",
      "    import pdb; pdb.set_trace()",
      "    return 1",
    ].join("\n")
    const findings = runConsoleCheck(py, "python")
    const messages = findings.map(f => f.message)
    assert.ok(messages.some(m => m.includes("breakpoint()")), `expected breakpoint() finding, got ${JSON.stringify(messages)}`)
    assert.ok(messages.some(m => m.includes("pdb.set_trace()")), `expected pdb.set_trace finding, got ${JSON.stringify(messages)}`)
  })

  it("flags inline `debugger;` statements that aren't on their own line", () => {
    const js = [
      "function f(x) {",
      "  if (x) { debugger; return x; }",
      "}",
    ].join("\n")
    const findings = runConsoleCheck(js, "javascript")
    assert.ok(findings.some(f => f.message.includes("debugger")), `expected inline debugger finding, got ${JSON.stringify(findings)}`)
  })

  it("flags innerHTML / dangerouslySetInnerHTML / document.write as unsafe", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "unsafe_innerhtml")!
    const code = [
      "function render(el, html) {",
      "  el.innerHTML = html;",
      "  document.write(html);",
      "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
      "}",
    ].join("\n")
    const { lines, codeMask } = agentTools.buildCommentCodeMask(code, "javascript")
    const findings = check.scan(code, { language: "javascript", lines, codeMask })
    assert.ok(findings.length >= 3, `expected 3+ unsafe sinks, got ${JSON.stringify(findings)}`)
    assert.ok(findings.every(f => f.severity === "warn"))
  })

  it("does not flag debugger inside string literals or comments", () => {
    const js = [
      "// debugger;",
      'const s = "debugger;"',
      "function ok() { return 1; }",
    ].join("\n")
    const findings = runConsoleCheck(js, "javascript")
    assert.equal(findings.length, 0, `expected no findings, got ${JSON.stringify(findings)}`)
  })
})
