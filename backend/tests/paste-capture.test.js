const { describe, test } = require("node:test")
const assert = require("node:assert/strict")

function countWords(text) {
  return (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+(?:[''.-][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+)*/g) || []).length
}

function countSentences(text) {
  return (text.match(/[.!?。！？]\s+/g) || []).length + (/[.!?。！？]$/.test(text) ? 1 : 0)
}

function fnv1aHash(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function normalizePastedText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
}

function looksLikeJson(text) {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false
  try { JSON.parse(trimmed); return true } catch { return false }
}

function looksLikeCsv(text) {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 3) return false
  const commaCounts = lines.map(line => (line.match(/,/g) || []).length)
  const firstCommas = commaCounts[0]
  if (firstCommas < 1) return false
  const consistent = commaCounts.filter(n => Math.abs(n - firstCommas) <= 1).length
  return consistent / commaCounts.length >= 0.85
}

function looksLikeYaml(text) {
  const lines = text.split("\n").slice(0, 200)
  const nonEmpty = lines.filter(line => line.trim() && !line.trim().startsWith("#"))
  if (nonEmpty.length < 3) return false
  const keyValueLines = nonEmpty.filter(line => /^\s*[\w.-]+\s*:(\s+|$)/.test(line)).length
  const sentenceLines = nonEmpty.filter(line => /[.!?]\s*$/.test(line.trim())).length
  if (sentenceLines > nonEmpty.length * 0.6) return false
  return keyValueLines >= 3 && (keyValueLines / nonEmpty.length >= 0.4)
}

function looksLikeDockerfile(text) {
  const lines = text.split("\n").filter(l => l.trim() && !l.trim().startsWith("#")).slice(0, 100)
  if (lines.length < 2) return false
  const dockerVerbs = lines.filter(l => /^\s*(FROM|RUN|CMD|COPY|ADD|ENV|EXPOSE|WORKDIR|VOLUME|ARG|LABEL|ENTRYPOINT|HEALTHCHECK|SHELL|USER|ONBUILD|STOPSIGNAL)\s+/i.test(l)).length
  return /^FROM\s+\S+/im.test(text) && dockerVerbs >= 2
}

function looksLikeDiff(text) {
  if (/^diff --git\s+/m.test(text)) return true
  const lines = text.split("\n").slice(0, 200)
  const hunkHeaders = lines.filter(line => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)).length
  return hunkHeaders >= 1
}

function looksLikeStackTrace(text) {
  if (/Traceback \(most recent call last\):/.test(text) && /File\s+"[^"]+",\s+line\s+\d+/.test(text)) return true
  const lines = text.split("\n").slice(0, 100)
  const atFrames = lines.filter(line => /^\s*at\s+[\w.<>$]+\s*(?:\([^)]+:\d+:\d+\))?/.test(line)).length
  return atFrames >= 3
}

function looksLikeLog(text) {
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 200)
  if (lines.length < 5) return false
  const matchers = [
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
    /^\[(?:DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\]/i,
    /^(?:DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\s*[:[]/i,
  ]
  const matchingLines = lines.filter(line => matchers.some(re => re.test(line))).length
  return matchingLines / lines.length >= 0.5
}

function looksLikeLatex(text) {
  if (/\\documentclass\b/.test(text)) return true
  if (/\\begin\{document\}/.test(text)) return true
  const beginEnd = (text.match(/\\begin\{[\w*]+\}/g) || []).length
  const macros = (text.match(/\\(?:section|subsection|chapter|paragraph|emph|textbf|textit|cite|ref|label|item|usepackage|newcommand|renewcommand|frac|sqrt|sum|int)\b/g) || []).length
  return beginEnd >= 2 || macros >= 5
}

function looksLikeBibtex(text) {
  const entries = (text.match(/@(?:article|book|inproceedings|proceedings|incollection|inbook|conference|manual|techreport|phdthesis|mastersthesis|misc|unpublished|booklet)\s*\{[^,}]+,/gi) || []).length
  return entries >= 1
}

function looksLikeHtml(text) {
  const trimmed = text.trim()
  if (!/^<(?:!doctype\s+html|html|body|div|head|section|article)[\s>]/i.test(trimmed) && !/<\/(?:html|body|head|div|section|p|span)\s*>/i.test(trimmed)) return false
  return /<\/\w+>/.test(trimmed)
}

function looksLikeXml(text) {
  const trimmed = text.trim()
  if (/<\?xml\s/i.test(trimmed)) return true
  if (!/^<\w+[\s>]/i.test(trimmed)) return false
  if (looksLikeHtml(trimmed)) return false
  return /<\/\w+>/.test(trimmed) && /\sxmlns(?::\w+)?\s*=/.test(trimmed)
}

function detectContentKind(text) {
  if (looksLikeJson(text)) return { kind: "json", confidence: 0.99 }
  if (looksLikeDockerfile(text)) return { kind: "dockerfile", confidence: 0.95 }
  if (looksLikeDiff(text)) return { kind: "diff", confidence: 0.95 }
  if (looksLikeStackTrace(text)) return { kind: "stack_trace", confidence: 0.9 }
  if (looksLikeBibtex(text)) return { kind: "bibtex", confidence: 0.95 }
  if (looksLikeLatex(text)) return { kind: "latex", confidence: 0.9 }
  if (looksLikeXml(text)) return { kind: "xml", confidence: 0.92 }
  if (looksLikeHtml(text)) return { kind: "html", confidence: 0.9 }
  if (looksLikeYaml(text)) return { kind: "yaml", confidence: 0.85 }
  if (looksLikeCsv(text)) return { kind: "csv", confidence: 0.88 }
  if (looksLikeLog(text)) return { kind: "log", confidence: 0.82 }
  return { kind: "prose", confidence: 0.6 }
}

function analyzePastedContent(rawText) {
  const normalizedText = normalizePastedText(rawText)
  const detection = detectContentKind(normalizedText)
  const charCount = normalizedText.length
  const wordCount = countWords(normalizedText)
  const lineCount = normalizedText.split("\n").filter(l => l.trim().length > 0).length
  const contentHash = fnv1aHash(normalizedText)
  const isLongPaste =
    charCount >= 1200 || wordCount >= 200 || lineCount >= 20 ||
    (charCount >= 80 && detection.kind !== "prose" && detection.confidence >= 0.72) ||
    (charCount >= 180 && (wordCount >= 35 || lineCount >= 3))
  return {
    contentKind: detection.kind,
    charCount,
    wordCount,
    lineCount,
    contentHash,
    isLongPaste,
    suggestedAction: isLongPaste || (detection.kind !== "prose" && detection.confidence >= 0.72)
      ? "attach_document"
      : "insert_text",
  }
}

describe("paste-capture", () => {
  describe("normalizePastedText", () => {
    test("normalizes CRLF to LF", () => {
      assert.ok(!normalizePastedText("a\r\nb\r\nc").includes("\r"))
    })
    test("normalizes non-breaking spaces", () => {
      assert.ok(!normalizePastedText("hello\u00a0world").includes("\u00a0"))
    })
    test("trims whitespace", () => {
      assert.equal(normalizePastedText("  hello  "), "hello")
    })
    test("handles empty string", () => {
      assert.equal(normalizePastedText(""), "")
    })
  })

  describe("countWords", () => {
    test("counts Spanish words", () => {
      assert.equal(countWords("Hola mundo esto es una prueba"), 6)
    })
    test("returns 0 for empty string", () => {
      assert.equal(countWords(""), 0)
    })
    test("handles accented characters", () => {
      assert.equal(countWords("árbol número"), 2)
    })
  })

  describe("countSentences", () => {
    test("counts period-terminated sentences", () => {
      assert.ok(countSentences("Primera oración. Segunda oración. Tercera oración.") >= 3)
    })
    test("returns 0 for no sentences", () => {
      assert.equal(countSentences("hello world"), 0)
    })
  })

  describe("fnv1aHash", () => {
    test("is deterministic", () => {
      assert.equal(fnv1aHash("test"), fnv1aHash("test"))
    })
    test("differs for different content", () => {
      assert.notEqual(fnv1aHash("a"), fnv1aHash("b"))
    })
  })

  describe("detectContentKind", () => {
    test("detects JSON", () => {
      assert.equal(detectContentKind('{"hello": "world"}').kind, "json")
    })
    test("detects CSV", () => {
      assert.equal(detectContentKind("a,b\n1,2\n3,4\n5,6").kind, "csv")
    })
    test("detects YAML", () => {
      assert.equal(detectContentKind("name: test\nport: 3000\nenabled: true\nfeatures:\n  - auth\n  - logs").kind, "yaml")
    })
    test("detects Dockerfile", () => {
      assert.equal(detectContentKind("FROM node:20-alpine\nRUN npm install -g pnpm\nCOPY . /app").kind, "dockerfile")
    })
    test("detects diff", () => {
      assert.equal(detectContentKind("diff --git a/f.ts b/f.ts\n@@ -1 +1,2 @@\n+new line").kind, "diff")
    })
    test("detects stack trace", () => {
      assert.equal(detectContentKind("Traceback (most recent call last):\n  File \"app.py\", line 42, in handler\n    result = do_work()").kind, "stack_trace")
    })
    test("detects log", () => {
      const log = [
        "2026-05-18 10:00:01 [INFO] Server started on port 3000",
        "2026-05-18 10:00:02 [INFO] Connected to database",
        "2026-05-18 10:00:03 [WARN] Slow query detected (1200ms)",
        "2026-05-18 10:00:04 [ERROR] Connection timeout",
        "2026-05-18 10:00:05 [DEBUG] Retrying connection",
      ].join("\n")
      assert.equal(detectContentKind(log).kind, "log")
    })
    test("detects LaTeX", () => {
      assert.equal(detectContentKind("\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}").kind, "latex")
    })
    test("detects BibTeX", () => {
      assert.equal(detectContentKind("@article{key, author={Smith}, title={Test}, year={2024}}").kind, "bibtex")
    })
    test("detects HTML", () => {
      assert.equal(detectContentKind("<!DOCTYPE html>\n<html><body><h1>Hello</h1></body></html>").kind, "html")
    })
    test("detects XML", () => {
      assert.equal(detectContentKind('<?xml version="1.0"?>\n<root xmlns="http://example.com"><item>test</item></root>').kind, "xml")
    })
    test("falls back to prose", () => {
      assert.equal(detectContentKind("Hello world, this is just some text.").kind, "prose")
    })
  })

  describe("analyzePastedContent", () => {
    test("short prose → insert_text", () => {
      const r = analyzePastedContent("Hola mundo")
      assert.equal(r.suggestedAction, "insert_text")
      assert.equal(r.isLongPaste, false)
    })
    test("JSON → attach_document", () => {
      const big = {}
      for (let i = 0; i < 20; i++) big[`field_${i}`] = "value ".repeat(50)
      const r = analyzePastedContent(JSON.stringify(big, null, 2))
      assert.equal(r.suggestedAction, "attach_document")
      assert.equal(r.contentKind, "json")
    })
    test("long prose → attach_document", () => {
      const r = analyzePastedContent("Este es un documento extenso. ".repeat(100))
      assert.equal(r.suggestedAction, "attach_document")
      assert.equal(r.isLongPaste, true)
    })
    test("computes char/word/line count", () => {
      const r = analyzePastedContent("line1\nline2\nline3")
      assert.ok(r.charCount > 0)
      assert.ok(r.wordCount >= 3)
      assert.equal(r.lineCount, 3)
    })
    test("content hash is deterministic", () => {
      const r1 = analyzePastedContent("same content")
      const r2 = analyzePastedContent("same content")
      assert.equal(r1.contentHash, r2.contentHash)
    })
    test("different content → different hash", () => {
      const r1 = analyzePastedContent("content A")
      const r2 = analyzePastedContent("content B")
      assert.notEqual(r1.contentHash, r2.contentHash)
    })
  })
})
