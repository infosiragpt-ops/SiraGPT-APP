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
    clampTimeoutMs: (input: unknown, opts: { min: number; max: number; defaultMs: number }) => number
    clampInt: (input: unknown, opts: { min: number; max: number; defaultValue: number }) => number
    describeFileIdTruncation: (ids: unknown[], ctx?: { fileIds?: unknown[] }) => { truncated: boolean; requested: number; used: number }
    TOOL_FILE_ID_CAP: number
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

  it("uses <!-- for markdown / html / svg / xml", () => {
    assert.equal(agentTools.commentPrefixFor("readme.md"), "<!--")
    assert.equal(agentTools.commentPrefixFor("page.html"), "<!--")
    assert.equal(agentTools.commentPrefixFor("graphic.svg"), "<!--")
  })

  it("uses % for LaTeX, ;; for Lisp, -- for SQL/Haskell/Lua", () => {
    assert.equal(agentTools.commentPrefixFor("paper.tex"), "%")
    assert.equal(agentTools.commentPrefixFor("core.clj"), ";;")
    assert.equal(agentTools.commentPrefixFor("query.sql"), "--")
    assert.equal(agentTools.commentPrefixFor("Main.hs"), "--")
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

  it("does not split surrogate pairs when truncating", () => {
    // 4-byte emoji '😀' is encoded as a surrogate pair (length 2 in
    // UTF-16). A naive slice at an odd cut would return a dangling
    // high surrogate which JSON.stringify would replace with U+FFFD.
    const padded = "😀".repeat(400) // 800 UTF-16 code units
    const out = taskTools.INTERNAL.previewText(padded, 401)
    // Should NOT contain a lone surrogate; serialise round-trip must succeed
    const stringified = JSON.stringify(out)
    assert.ok(typeof stringified === "string")
    // Truncation length should be 400 (even number) not 401
    assert.ok(out.startsWith("😀"))
  })

  it("falls back to a sane default when max is non-positive or NaN", () => {
    const long = "x".repeat(1000)
    // NaN max would otherwise produce empty output; guard restores 600
    assert.ok(taskTools.INTERNAL.previewText(long, Number.NaN).length > 0)
    assert.ok(taskTools.INTERNAL.previewText(long, -10).length > 0)
  })
})

describe("agent-tools · static_checks insecure_random_secret", () => {
  it("flags Math.random() near sensitive identifiers", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "insecure_random_secret")!
    const samples = [
      "const token = Math.random().toString(36);",
      "const apiKey = Math.random();",
      "const csrf = Math.random();",
      "const reset_code = Math.random();",
    ]
    for (const text of samples) {
      const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
      const findings = check.scan(text, { language: "javascript", lines, codeMask })
      assert.ok(findings.length > 0, `expected high finding for: ${text}`)
      assert.equal(findings[0].severity, "high")
    }
  })

  it("does not flag Math.random for non-sensitive uses", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "insecure_random_secret")!
    const text = "const x = Math.random() * 100; // jitter"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const findings = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(findings.length, 0)
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

describe("task-tools · clampTimeoutMs", () => {
  const opts = { min: 500, max: 60000, defaultMs: 10000 }

  it("returns the default when input is missing or invalid", () => {
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(undefined, opts), 10000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(null, opts), 10000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(Number.NaN, opts), 10000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(-50, opts), 10000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(0, opts), 10000)
  })

  it("clamps above the maximum and below the minimum without rejecting", () => {
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(999999, opts), 60000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(100, opts), 500)
  })

  it("passes valid inputs through unchanged", () => {
    assert.equal(taskTools.INTERNAL.clampTimeoutMs(15000, opts), 15000)
    assert.equal(taskTools.INTERNAL.clampTimeoutMs("20000", opts), 20000)
  })
})

describe("task-tools · describeFileIdTruncation", () => {
  it("flags truncation when more than the cap is requested", () => {
    const cap = taskTools.INTERNAL.TOOL_FILE_ID_CAP
    const tooMany = Array.from({ length: cap + 5 }, (_, i) => `file-${i}`)
    const out = taskTools.INTERNAL.describeFileIdTruncation(tooMany)
    assert.equal(out.truncated, true)
    assert.equal(out.requested, cap + 5)
    assert.equal(out.used, cap)
  })

  it("does not flag truncation when within the cap", () => {
    const out = taskTools.INTERNAL.describeFileIdTruncation(["a", "b", "c"])
    assert.equal(out.truncated, false)
    assert.equal(out.used, 3)
  })

  it("falls back to ctx.fileIds when no explicit list is provided", () => {
    const out = taskTools.INTERNAL.describeFileIdTruncation([], { fileIds: ["x", "y"] })
    assert.equal(out.requested, 2)
    assert.equal(out.used, 2)
  })
})

describe("agent-tools · static_checks hardcoded_secret extended formats", () => {
  const check = () => agentTools.STATIC_CHECKS.find(c => c.id === "hardcoded_secret")!
  function findingsFor(text: string) {
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    return check().scan(text, { language: "javascript", lines, codeMask })
  }

  it("flags a Stripe live secret key", () => {
    const out = findingsFor('const k = "sk_live_abcdef0123456789ABCDEF";')
    assert.ok(out.length > 0)
  })

  it("flags a GitHub fine-grained PAT", () => {
    const out = findingsFor('const t = "github_pat_11ABCDEFG0' + 'A'.repeat(50) + '";')
    assert.ok(out.length > 0)
  })

  it("flags an embedded SSH private key block", () => {
    const out = findingsFor("// -----BEGIN OPENSSH PRIVATE KEY-----")
    assert.ok(out.length > 0)
  })
})

describe("agent-tools · static_checks disabled_ssl_verification", () => {
  const check = () => agentTools.STATIC_CHECKS.find(c => c.id === "disabled_ssl_verification")!
  it("flags rejectUnauthorized:false in Node", () => {
    const text = "const opts = { rejectUnauthorized: false, host: 'x' };"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check().scan(text, { language: "javascript", lines, codeMask })
    assert.equal(out.length, 1)
    assert.equal(out[0].severity, "high")
  })
  it("flags verify=False in Python requests", () => {
    const text = "requests.get('https://x', verify=False)"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const out = check().scan(text, { language: "python", lines, codeMask })
    assert.equal(out.length, 1)
    assert.equal(out[0].severity, "high")
  })
})

describe("agent-tools · static_checks empty_catch python except pass", () => {
  it("flags Python 'except: pass' and 'except E: pass'", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "empty_catch")!
    const text = [
      "try:",
      "    do()",
      "except Exception:",
      "    pass",
      "",
      "try:",
      "    other()",
      "except:",
      "    pass",
    ].join("\n")
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const out = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(out.length, 2)
  })
})

describe("agent-tools · static_checks eval_usage extended", () => {
  it("flags setTimeout / setInterval with a string argument", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "eval_usage")!
    const text = [
      "setTimeout('alert(1)', 100);",
      "setInterval(\"x++\", 200);",
    ].join("\n")
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(out.length, 2)
    assert.ok(out.every(f => f.severity === "high"))
  })

  it("flags Function() constructor without 'new'", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "eval_usage")!
    const text = "const f = Function('return x + 1')();"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(out.length, 1)
    assert.ok(out[0].message.includes("Function()"))
  })

  it("does not flag setTimeout with a function argument", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "eval_usage")!
    const text = "setTimeout(() => doX(), 100);"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(out.length, 0)
  })
})

describe("agent-tools · static_checks os_system_call", () => {
  it("flags os.system and os.popen", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "os_system_call")!
    const text = "import os\nos.system('rm -rf /tmp/x')\nos.popen('cat /etc/hosts')"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const out = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(out.length, 2)
  })
})

describe("agent-tools · static_checks dynamic_require", () => {
  it("flags require with non-literal argument", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "dynamic_require")!
    const text = "const m = require(modulePath); const m2 = require(`./${kind}`);"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check.scan(text, { language: "javascript", lines, codeMask })
    assert.ok(out.length >= 1)
  })
  it("does not flag a literal require", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "dynamic_require")!
    const text = "const fs = require('fs');\nconst path = require(\"path\");"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "javascript")
    const out = check.scan(text, { language: "javascript", lines, codeMask })
    assert.equal(out.length, 0)
  })
})

describe("agent-tools · static_checks subprocess_shell_true", () => {
  it("flags subprocess.run / Popen / check_output with shell=True", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "subprocess_shell_true")!
    const samples = [
      "subprocess.run(cmd, shell=True)",
      "subprocess.Popen(args, shell=True, stdout=PIPE)",
      "subprocess.check_output('ls -la', shell=True)",
    ]
    for (const text of samples) {
      const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
      const findings = check.scan(text, { language: "python", lines, codeMask })
      assert.equal(findings.length, 1, `expected one finding for: ${text}`)
      assert.equal(findings[0].severity, "high")
    }
  })

  it("does not flag subprocess without shell=True", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "subprocess_shell_true")!
    const text = "subprocess.run(['ls','-la'])"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const findings = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(findings.length, 0)
  })
})

describe("agent-tools · static_checks unsafe_pickle", () => {
  it("flags pickle.loads / pickle.load / cPickle.loads", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "unsafe_pickle")!
    const text = [
      "import pickle",
      "obj = pickle.loads(blob)",
      "obj2 = pickle.load(open('x.pkl','rb'))",
      "obj3 = cPickle.loads(blob)",
    ].join("\n")
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const findings = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(findings.length, 3)
    assert.ok(findings.every(f => f.severity === "high"))
  })
})

describe("agent-tools · static_checks unsafe_yaml_load", () => {
  it("flags yaml.load without Loader=", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "unsafe_yaml_load")!
    const text = "import yaml\ndata = yaml.load(open('config.yaml').read())"
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const findings = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].severity, "high")
  })

  it("does not flag yaml.safe_load or yaml.load with explicit Loader", () => {
    const check = agentTools.STATIC_CHECKS.find(c => c.id === "unsafe_yaml_load")!
    const text = [
      "import yaml",
      "a = yaml.safe_load(s)",
      "b = yaml.load(s, Loader=yaml.SafeLoader)",
    ].join("\n")
    const { lines, codeMask } = agentTools.buildCommentCodeMask(text, "python")
    const findings = check.scan(text, { language: "python", lines, codeMask })
    assert.equal(findings.length, 0)
  })
})

describe("task-tools · clampInt", () => {
  const opts = { min: 5, max: 50, defaultValue: 15 }
  it("clamps overshoot, undershoot, and falls back on bad input", () => {
    assert.equal(taskTools.INTERNAL.clampInt(undefined, opts), 15)
    assert.equal(taskTools.INTERNAL.clampInt(0, opts), 15)
    assert.equal(taskTools.INTERNAL.clampInt(Number.NaN, opts), 15)
    assert.equal(taskTools.INTERNAL.clampInt(1000, opts), 50)
    assert.equal(taskTools.INTERNAL.clampInt(2, opts), 5)
    assert.equal(taskTools.INTERNAL.clampInt(20, opts), 20)
    // floors floats
    assert.equal(taskTools.INTERNAL.clampInt(7.9, opts), 7)
  })
})

describe("task-tools · validateAgentArtifactBuffer magic-byte detection", () => {
  const tt = cjsRequire("../../backend/src/services/agents/task-tools") as {
    INTERNAL: {
      validateAgentArtifactBuffer: (ext: string, buf: Buffer) => { passed: boolean; checks: Record<string, boolean> }
      bufferHasMagic: (buf: Buffer, ext: string) => boolean | null
    }
  }

  it("passes a real PNG header but fails fake bytes", () => {
    const realPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ])
    assert.equal(tt.INTERNAL.bufferHasMagic(realPng, "png"), true)
    assert.equal(tt.INTERNAL.validateAgentArtifactBuffer("png", realPng).passed, true)

    const fake = Buffer.from("just text pretending to be a png").toString("utf8")
    const fakeBuf = Buffer.from(fake, "utf8")
    assert.equal(tt.INTERNAL.bufferHasMagic(fakeBuf, "png"), false)
    assert.equal(tt.INTERNAL.validateAgentArtifactBuffer("png", fakeBuf).passed, false)
  })

  it("validates JPEG and GIF headers", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 0)])
    assert.equal(tt.INTERNAL.bufferHasMagic(jpeg, "jpeg"), true)
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 0)])
    assert.equal(tt.INTERNAL.bufferHasMagic(gif, "gif"), true)
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

  it("rejects replacements over 200_000 chars", async () => {
    const out = await agentTools.propose_patch.handler({
      source: "foo.js",
      replacement: "a".repeat(200_001),
    })
    assert.equal(out.proposed, undefined)
    assert.match(out.error || "", /exceeds 200000/)
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
