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

test("long paste classifier ignores short padded prompts", () => {
  const padded = "hazme un resumen\n\npor favor"
  assert.equal(shouldCompilePastedTextAsDocument(padded), false)
})

test("long paste classifier compiles short informational paste as a document", () => {
  const pasted = [
    "Cliente: ACME. Riesgo principal: renovacion pendiente antes del 30/06/2026.",
    "Monto afectado: USD 24,500. Responsable: equipo legal.",
    "Siguiente accion: revisar clausula 8 y preparar respuesta formal.",
  ].join("\n")
  assert.equal(shouldCompilePastedTextAsDocument(pasted), true)
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

test("metadata: filename preserves detected code kind with upload-safe extension", () => {
  const py = `def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n\nif __name__ == "__main__":\n    print(factorial(10))\n    print(factorial(20))\n    print(factorial(30))\n    print(factorial(40))\n    print(factorial(50))`
  const meta = buildLongPasteMetadata(py, new Date("2026-05-12T10:00:00Z"))
  assert.equal(meta.contentKind, "code")
  assert.equal(meta.programmingLanguage, "python")
  assert.match(meta.filename, /\.py\.txt$/)
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

test("natural language: detects German from common stopwords", () => {
  const text = "Das künstliche Intelligenzsystem verarbeitet die Dokumente mit sehr hoher Genauigkeit und liefert Ergebnisse in Sekunden für die Benutzer, die sie benötigen."
  assert.equal(detectNaturalLanguage(text), "de")
})

test("natural language: detects Russian via Cyrillic script", () => {
  const text = "Система искусственного интеллекта обрабатывает документы с очень высокой точностью и возвращает результаты за секунды."
  assert.equal(detectNaturalLanguage(text), "ru")
})

test("natural language: detects Japanese via hiragana/katakana", () => {
  const text = "人工知能システムは、非常に高い精度で文書を処理し、必要なユーザーに数秒で結果を返します。これはとても便利です。"
  assert.equal(detectNaturalLanguage(text), "ja")
})

test("natural language: detects Korean via Hangul", () => {
  const text = "인공 지능 시스템은 매우 높은 정확도로 문서를 처리하고 필요한 사용자에게 몇 초 만에 결과를 반환합니다. 이것은 매우 유용합니다."
  assert.equal(detectNaturalLanguage(text), "ko")
})

test("natural language: detects Chinese via CJK ideographs without kana", () => {
  const text = "人工智能系统以非常高的准确度处理文档，并在几秒钟内为需要的用户返回结果。这非常有用，对于研究人员特别重要。"
  assert.equal(detectNaturalLanguage(text), "zh")
})

// ─── New content kinds ───────────────────────────────────────────────

test("content kind: detects JSON Lines (JSONL)", () => {
  const jsonl = [
    JSON.stringify({ id: 1, name: "Ada" }),
    JSON.stringify({ id: 2, name: "Bob" }),
    JSON.stringify({ id: 3, name: "Cleo" }),
    JSON.stringify({ id: 4, name: "Dee" }),
  ].join("\n")
  const d = detectPastedContentKind(jsonl)
  assert.equal(d.kind, "jsonl")
  assert.equal(d.extension, "jsonl")
})

test("content kind: detects Jupyter notebook ahead of plain JSON", () => {
  const notebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" } },
    cells: [
      { cell_type: "code", source: ["print('hello')"], outputs: [] },
      { cell_type: "markdown", source: ["# Title"] },
    ],
  })
  const d = detectPastedContentKind(notebook)
  assert.equal(d.kind, "jupyter_notebook")
  assert.equal(d.extension, "ipynb")
})

test("content kind: detects Mermaid diagram", () => {
  const mmd = `sequenceDiagram\n    participant Alice\n    participant Bob\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi`
  const d = detectPastedContentKind(mmd)
  assert.equal(d.kind, "mermaid_diagram")
})

test("content kind: detects flowchart Mermaid", () => {
  const mmd = `flowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[OK]\n    B -->|No| D[Fail]`
  const d = detectPastedContentKind(mmd)
  assert.equal(d.kind, "mermaid_diagram")
})

test("content kind: detects OpenAPI spec (YAML)", () => {
  const yaml = `openapi: 3.0.3
info:
  title: Sira API
  version: 1.0.0
paths:
  /users:
    get:
      summary: List users
      responses:
        '200':
          description: ok`
  const d = detectPastedContentKind(yaml)
  assert.equal(d.kind, "openapi_spec")
})

test("content kind: detects Kubernetes manifest", () => {
  const k8s = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: nginx:1.27
        ports:
        - containerPort: 80`
  const d = detectPastedContentKind(k8s)
  assert.equal(d.kind, "kubernetes_manifest")
})

test("content kind: detects GraphQL schema", () => {
  const gql = `type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  author: User!
}

type Query {
  users: [User!]!
  post(id: ID!): Post
}`
  const d = detectPastedContentKind(gql)
  assert.equal(d.kind, "graphql_schema")
  assert.equal(d.extension, "graphql")
})

test("content kind: detects BibTeX bibliography", () => {
  const bib = `@article{smith2020attention,
  title={Attention is all you need},
  author={Smith, John and Doe, Jane},
  journal={NeurIPS},
  year={2020}
}

@book{knuth1973art,
  title={The Art of Computer Programming},
  author={Knuth, Donald E.},
  year={1973},
  publisher={Addison-Wesley}
}`
  const d = detectPastedContentKind(bib)
  assert.equal(d.kind, "bibtex")
  assert.equal(d.extension, "bib")
})

test("content kind: detects LaTeX documents", () => {
  const tex = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Introduction}
We propose a new method for $f(x) = \\sqrt{x^2 + 1}$.
\\end{document}`
  const d = detectPastedContentKind(tex)
  assert.equal(d.kind, "latex")
})

test("content kind: detects Makefile", () => {
  const make = `CC=gcc
CFLAGS=-Wall -O2

.PHONY: all clean

all: app

app: main.o util.o
\tgcc -o app main.o util.o

main.o: main.c
\tgcc -c main.c

clean:
\trm -f *.o app`
  const d = detectPastedContentKind(make)
  assert.equal(d.kind, "makefile")
})

test("content kind: detects .env files", () => {
  const env = `# App config
DATABASE_URL=postgres://user:pass@localhost:5432/mydb
REDIS_URL=redis://localhost:6379
JWT_SECRET=supersecret
NODE_ENV=production
PORT=3000`
  const d = detectPastedContentKind(env)
  assert.equal(d.kind, "env_file")
})

test("content kind: still treats plain JSON as JSON when not a notebook", () => {
  // Regression — ensure new jupyter detector doesn't false-positive on JSON
  // without nbformat/cells keys.
  const json = JSON.stringify({ users: [{ id: 1 }, { id: 2 }] }, null, 2)
  assert.equal(detectPastedContentKind(json).kind, "json")
})

// ─── New programming languages ───────────────────────────────────────

test("content kind: detects Scala code", () => {
  const scala = `object HelloWorld extends App {
  case class User(name: String, age: Int)
  trait Greeter {
    def greet(u: User): String = s"Hello, \${u.name}!"
  }
  val u = User("Ada", 36)
  println(new Greeter {}.greet(u))
}`
  const d = detectPastedContentKind(scala)
  assert.equal(d.kind, "code")
  assert.equal(d.language, "scala")
  assert.equal(d.extension, "scala")
})

test("content kind: detects Elixir code", () => {
  const elixir = `defmodule Sira.Greeter do
  @spec greet(String.t()) :: String.t()
  def greet(name) do
    "Hello, " <> name <> "!"
  end

  def loud(name), do: String.upcase(greet(name))
end`
  const d = detectPastedContentKind(elixir)
  assert.equal(d.kind, "code")
  assert.equal(d.language, "elixir")
})

test("content kind: detects Solidity code", () => {
  const sol = `pragma solidity ^0.8.20;

contract Token {
    mapping(address => uint256) public balances;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address to, uint256 amount) public {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }
}`
  const d = detectPastedContentKind(sol)
  assert.equal(d.kind, "code")
  assert.equal(d.language, "solidity")
})

test("content kind: detects Lua code", () => {
  const lua = `local M = {}

function M.greet(name)
  return "Hello, " .. name
end

function M.shout(name)
  return string.upper(M.greet(name))
end

return M`
  const d = detectPastedContentKind(lua)
  assert.equal(d.kind, "code")
  assert.equal(d.language, "lua")
})

test("content kind: detects R code", () => {
  const r = `library(ggplot2)
library(dplyr)

data <- read.csv("data.csv")
summary_data <- data %>% group_by(category) %>% summarise(mean_val = mean(value))

ggplot(summary_data, aes(x = category, y = mean_val)) + geom_bar(stat = "identity")`
  const d = detectPastedContentKind(r)
  assert.equal(d.kind, "code")
  assert.equal(d.language, "r")
})
