import test from "node:test"
import assert from "node:assert/strict"

import {
  buildFileOnlyPrompt,
  buildLongPasteMetadata,
  createLongPasteDocumentFile,
  detectNaturalLanguage,
  detectPastedContentKind,
  shouldCompilePastedTextAsDocument,
} from "../lib/long-paste"

test("long paste classifier ignores normal short messages", () => {
  assert.equal(shouldCompilePastedTextAsDocument("hazme un resumen de este texto"), false)
})

test("long paste classifier compiles dense pasted content into a document", () => {
  const paragraph = "La arquitectura agentic debe interpretar intención, planificar herramientas, validar evidencias y entregar artefactos profesionales con trazabilidad completa. "
  const pasted = Array.from({ length: 18 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n")

  assert.equal(shouldCompilePastedTextAsDocument(pasted), true)
})

test("long paste classifier compiles content above the MIN_LINES threshold", () => {
  const twentyLines = Array.from({ length: 20 }, (_, i) => `linea ${i + 1}`).join("\n")
  const twentyOneLines = Array.from({ length: 21 }, (_, i) => `linea ${i + 1}`).join("\n")

  assert.equal(shouldCompilePastedTextAsDocument(twentyLines), true, "20 líneas alcanzan el umbral (MIN_LINES=20)")
  assert.equal(shouldCompilePastedTextAsDocument(twentyOneLines), true, "21 líneas deben convertirse en documento")
})

test("long paste classifier ignores blank lines when counting", () => {
  // 19 non-empty lines separated by blanks → under the threshold (20).
  // Prevents accidental triggers from double-spaced short messages.
  const padded = Array.from({ length: 19 }, (_, i) => `linea ${i + 1}`).join("\n\n")
  assert.equal(shouldCompilePastedTextAsDocument(padded), false)
})

test("long paste classifier detects structural content (academic/research)", () => {
  // Academic content with strong structure but under the character threshold
  const academic = `ABSTRACT\n\nThis study examines the relationship between X and Y.\n\nINTRODUCTION\n\nThe field has grown significantly in recent years.\n\nMETHODOLOGY\n\nWe employed a mixed-methods approach.\n\nRESULTS\n\nTable 1 shows the correlation.\n\nDISCUSSION\n\nThese findings suggest...\n\nREFERENCES\n\n[1] Smith, J. (2020). Title. Journal.\n[2] Doe, A. (2021). Another study. Conference.`

  assert.equal(shouldCompilePastedTextAsDocument(academic), true, "contenido academico con estructura debe ser detectado")
})

test("long paste metadata derives a safe title and filename", () => {
  const metadata = buildLongPasteMetadata("FACULTAD DE ARQUITECTURA\n\nContenido académico extenso.", new Date("2026-04-25T15:00:00Z"))

  assert.equal(metadata.kind, "long_paste_document")
  assert.equal(metadata.title, "FACULTAD DE ARQUITECTURA")
  assert.equal(metadata.filename, "facultad-de-arquitectura-2026-04-25T15-00-00.txt")
  assert.equal(metadata.originalLineCount, 2)
})

test("file-only prompt references compiled pasted text documents", () => {
  const metadata = buildLongPasteMetadata("FACULTAD DE ARQUITECTURA\n\nContenido académico extenso.", new Date("2026-04-25T15:00:00Z"))
  const prompt = buildFileOnlyPrompt([{ longPasteMeta: metadata }])

  assert.match(prompt, /FACULTAD DE ARQUITECTURA/)
  assert.match(prompt, /documento de texto adjunto/)
})

// ─── Content-kind detection ──────────────────────────────────────────

test("content kind: detects valid JSON object payload", () => {
  const json = JSON.stringify({ user: { name: "Ada", roles: ["admin", "owner"] }, count: 42 }, null, 2)
  const detection = detectPastedContentKind(json)
  assert.equal(detection.kind, "json")
  assert.equal(detection.extension, "json")
  assert.equal(detection.mime, "application/json")
  assert.ok(detection.confidence >= 0.95, "JSON parse confidence should be high")
})

test("content kind: detects JSON array payload", () => {
  const arr = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])
  assert.equal(detectPastedContentKind(arr).kind, "json")
})

test("content kind: detects YAML configuration", () => {
  const yaml = `version: "3.9"\nservices:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n  db:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: example`
  assert.equal(detectPastedContentKind(yaml).kind, "yaml")
})

test("content kind: detects CSV with consistent column count", () => {
  const csv = `name,age,city\nAda,32,London\nGrace,40,New York\nMarie,28,Paris\nDonald,55,Boston`
  const detection = detectPastedContentKind(csv)
  assert.equal(detection.kind, "csv")
  assert.equal(detection.extension, "csv")
})

test("content kind: detects HTML pages", () => {
  const html = `<!doctype html><html><head><title>Hi</title></head><body><div class="x">hello</div></body></html>`
  assert.equal(detectPastedContentKind(html).kind, "html")
})

test("content kind: detects SQL scripts", () => {
  const sql = `SELECT id, name FROM users WHERE created_at > '2026-01-01';\nINSERT INTO audit (event) VALUES ('login');\nUPDATE users SET active = true WHERE id = 5;`
  assert.equal(detectPastedContentKind(sql).kind, "sql")
})

test("content kind: detects Python stack traces", () => {
  const trace = `Traceback (most recent call last):\n  File "/app/main.py", line 42, in handle\n    result = compute(payload)\n  File "/app/svc.py", line 17, in compute\n    return data["missing"]\nKeyError: 'missing'`
  assert.equal(detectPastedContentKind(trace).kind, "stack_trace")
})

test("content kind: detects unified diffs", () => {
  const diff = `diff --git a/foo.txt b/foo.txt\nindex 1234567..89abcde 100644\n--- a/foo.txt\n+++ b/foo.txt\n@@ -1,3 +1,3 @@\n-old line\n+new line\n unchanged\n more`
  assert.equal(detectPastedContentKind(diff).kind, "diff")
})

test("content kind: detects Dockerfiles", () => {
  const dockerfile = `FROM node:20-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm install\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]`
  assert.equal(detectPastedContentKind(dockerfile).kind, "dockerfile")
})

test("content kind: detects PEM certificates", () => {
  const pem = `-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvqoRrhEBcyZcFNpA\nwhYkx3oV4YfPfKp2oPB9aGZcYsXZDX1vOdZZSEa9NW9gq3MpWXtO2g4QwGQH\n-----END CERTIFICATE-----`
  assert.equal(detectPastedContentKind(pem).kind, "pem_certificate")
})

test("content kind: detects log files with timestamps", () => {
  const log = `2026-05-12T10:00:01Z [INFO] startup complete\n2026-05-12T10:00:02Z [INFO] listening on :3000\n2026-05-12T10:00:05Z [WARN] slow query 1240ms\n2026-05-12T10:00:09Z [ERROR] db connection lost\n2026-05-12T10:00:10Z [INFO] reconnecting...\n2026-05-12T10:00:11Z [INFO] reconnect ok`
  assert.equal(detectPastedContentKind(log).kind, "log")
})

test("content kind: detects TypeScript code", () => {
  const ts = `import { z } from "zod"\n\nexport interface User {\n  id: string\n  name: string\n}\n\nexport const userSchema = z.object({\n  id: z.string().uuid(),\n  name: z.string().min(1),\n})\n\nexport function parseUser(input: unknown): User {\n  return userSchema.parse(input)\n}`
  const detection = detectPastedContentKind(ts)
  assert.equal(detection.kind, "code")
  assert.equal(detection.language, "typescript")
  assert.equal(detection.extension, "ts")
})

test("content kind: detects Python code", () => {
  const py = `import json\n\ndef compute_total(items):\n    """Sum the price field across line items."""\n    if not items:\n        return 0\n    return sum(item["price"] for item in items)\n\nif __name__ == "__main__":\n    data = json.loads(open("items.json").read())\n    print(compute_total(data))`
  const detection = detectPastedContentKind(py)
  assert.equal(detection.kind, "code")
  assert.equal(detection.language, "python")
  assert.equal(detection.extension, "py")
})

test("content kind: prose stays as prose with .txt extension", () => {
  const prose = `La inteligencia artificial está cambiando nuestra forma de trabajar. Los modelos generativos permiten producir contenido en segundos, automatizar tareas repetitivas y descubrir patrones en grandes volúmenes de datos. Sin embargo, esta capacidad trae consigo retos éticos que debemos abordar.`
  const detection = detectPastedContentKind(prose)
  assert.equal(detection.kind, "prose")
  assert.equal(detection.extension, "txt")
})

test("content kind: detects email threads with headers", () => {
  const email = `From: alice@example.com\nTo: bob@example.com\nSubject: Project status\nDate: Mon, 12 May 2026 10:00:00 +0000\n\nHi Bob,\n\nQuick update on the project: we're on track for the May 30 launch. The deployment scripts are ready.\n\n--Alice\n\nFrom: bob@example.com\nTo: alice@example.com\nSubject: Re: Project status\n\nThanks Alice, sounds great.`
  assert.equal(detectPastedContentKind(email).kind, "email_thread")
})

test("metadata: filename extension reflects detected content kind for JSON", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: `item-${i}`,
    name: `Sample item number ${i}`,
    tags: ["alpha", "beta", "gamma"],
    metadata: { active: true, score: i * 1.5 },
  }))
  const json = JSON.stringify({ items, total: items.length }, null, 2)
  const meta = buildLongPasteMetadata(json, new Date("2026-05-12T10:00:00Z"))
  assert.equal(meta.contentKind, "json", `expected json, got ${meta.contentKind} (signals: ${meta.detectionSignals?.join(',')})`)
  assert.match(meta.filename, /\.json$/, "JSON paste should produce .json filename")
  assert.equal(meta.detectedMime, "application/json")
})

test("metadata: filename extension reflects detected content kind for code", () => {
  const py = `def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n\nif __name__ == "__main__":\n    print(factorial(10))\n    print(factorial(20))\n    print(factorial(30))\n    print(factorial(40))\n    print(factorial(50))`
  const meta = buildLongPasteMetadata(py, new Date("2026-05-12T10:00:00Z"))
  assert.equal(meta.contentKind, "code")
  assert.equal(meta.programmingLanguage, "python")
  assert.match(meta.filename, /\.py$/)
})

test("metadata: includes content hash and token estimate", () => {
  const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40)
  const meta = buildLongPasteMetadata(text)
  assert.ok(meta.contentHash && /^[0-9a-f]{8}$/.test(meta.contentHash), "8-hex hash present")
  assert.ok((meta.estimatedTokens ?? 0) > 0, "token estimate populated")
  assert.ok((meta.estimatedReadingMinutes ?? 0) >= 1, "reading minutes populated")
})

test("metadata: same input produces same content hash (idempotent)", () => {
  const a = buildLongPasteMetadata("La misma entrada produce el mismo hash siempre. ".repeat(30))
  const b = buildLongPasteMetadata("La misma entrada produce el mismo hash siempre. ".repeat(30))
  assert.equal(a.contentHash, b.contentHash)
})

test("createLongPasteDocumentFile: high-confidence kinds use detected mime on the File", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `n-${i}` }))
  const json = JSON.stringify({ items, count: items.length }, null, 2)
  const file = createLongPasteDocumentFile(json)
  assert.equal(file.type, "application/json")
  assert.match(file.name, /\.json$/)
})

test("createLongPasteDocumentFile: prose keeps text/plain mime", () => {
  const prose = `Este es un texto narrativo extendido. ${"Repite contenido para extender el cuerpo. ".repeat(40)}`
  const file = createLongPasteDocumentFile(prose)
  assert.equal(file.type, "text/plain")
  assert.match(file.name, /\.txt$/)
})

test("buildFileOnlyPrompt: mentions kind for non-prose attachments", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `entry-${i}` }))
  const json = JSON.stringify({ items, total: items.length }, null, 2)
  const meta = buildLongPasteMetadata(json)
  const prompt = buildFileOnlyPrompt([{ longPasteMeta: meta }])
  assert.match(prompt, /JSON/)
})

// ─── Natural-language detection ──────────────────────────────────────

test("natural language: detects Spanish from common stopwords", () => {
  const text = "El sistema de inteligencia artificial procesa los documentos con una precisión muy alta y devuelve resultados en segundos para los usuarios que lo necesitan."
  assert.equal(detectNaturalLanguage(text), "es")
})

test("natural language: detects English from common stopwords", () => {
  const text = "The artificial intelligence system processes the documents with very high accuracy and returns results in seconds for the users who need them."
  assert.equal(detectNaturalLanguage(text), "en")
})

test("natural language: returns undefined for short or ambiguous samples", () => {
  assert.equal(detectNaturalLanguage("hola"), undefined)
})
