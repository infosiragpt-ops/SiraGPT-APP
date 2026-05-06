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
  propose_patch: { handler: (args: unknown) => Promise<{ error?: string; proposed?: boolean; start_line?: number | null; end_line?: number | null }> }
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

  it("falls back to a sane default when max is non-positive or NaN", () => {
    const long = "x".repeat(1000)
    // NaN max would otherwise produce empty output; guard restores 600
    assert.ok(taskTools.INTERNAL.previewText(long, Number.NaN).length > 0)
    assert.ok(taskTools.INTERNAL.previewText(long, -10).length > 0)
  })
})

describe("agent-tools · static_checks weak_crypto", () => {
  it("flags MD5 / SHA-1 use across JS, Node, and Python", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "weak_crypto")!
    const sources = [
      { lang: "javascript", text: 'const h = crypto.createHash("md5").update(x).digest("hex");' },
      { lang: "javascript", text: 'const h = crypto.createHash("SHA-1");' },
      { lang: "python", text: 'import hashlib\nh = hashlib.md5(b"x").hexdigest()' },
      { lang: "python", text: 'h = hashlib.sha1(payload).hexdigest()' },
    ]
    for (const { lang, text } of sources) {
      const { lines, codeMask } = agentTools.buildCommentCodeMask(text, lang)
      const findings = check.scan(text, { language: lang, lines, codeMask })
      assert.ok(findings.length > 0, `expected weak_crypto finding for ${lang}: ${text}`)
    }
  })

  it("does not flag SHA-256 or other strong algorithms", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "weak_crypto")!
    const text = 'const h = crypto.createHash("sha256");'
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const findings = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(findings.length, 0)
  })
})

describe("task-tools · saveArtifact atomicity", () => {
  // We can't easily simulate a metadata write failure without mocking,
  // but we can verify that on a normal write the artifact file AND the
  // metadata sidecar both land together — closing the regression window.
  it("writes artifact + metadata sidecar atomically on success", async () => {
    const taskToolsInternal = cjsRequire("../../backend/src/services/agents/task-tools") as {
      saveArtifact: (args: { filename: string; base64: string; ownerUserId: string; chatId?: string }) => { id: string; path: string }
      INTERNAL: { metadataPathFor: (id: string) => string }
    }
    const buf = Buffer.from("hello atomic")
    const out = taskToolsInternal.saveArtifact({
      filename: "atomic.txt",
      base64: buf.toString("base64"),
      ownerUserId: "test-user",
      chatId: "test-chat",
    })
    assert.ok(fs.existsSync(out.path), "artifact file missing")
    assert.ok(fs.existsSync(taskToolsInternal.INTERNAL.metadataPathFor(out.id)), "metadata sidecar missing")
  })
})

describe("agent-tools · propose_patch range validation", () => {
  it("rejects an inverted line range with a structured error", async () => {
    const out = await agentTools.propose_patch.handler({
      source: "foo.js",
      start_line: 50,
      end_line: 10,
      replacement: "// patched",
    })
    assert.equal(out.proposed, undefined)
    assert.match(out.error || "", /invalid range/)
  })

  it("accepts a valid range and surfaces it back as numbers", async () => {
    const out = await agentTools.propose_patch.handler({
      source: "foo.js",
      start_line: 10,
      end_line: 20,
      replacement: "// patched",
    })
    assert.equal(out.proposed, true)
    assert.equal(out.start_line, 10)
    assert.equal(out.end_line, 20)
  })

  it("treats missing line numbers as null without erroring", async () => {
    const out = await agentTools.propose_patch.handler({
      source: "foo.js",
      replacement: "// patched",
    })
    assert.equal(out.proposed, true)
    assert.equal(out.start_line, null)
    assert.equal(out.end_line, null)
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
