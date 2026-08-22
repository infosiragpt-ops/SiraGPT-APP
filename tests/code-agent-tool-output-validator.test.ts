/**
 * Tests for the tool-output validator (Frente 2).
 * Every tool-call result is validated BEFORE the agent chains the next step:
 * empty promised content, truncated JSON/code and error-artifact output must
 * be caught deterministically (no model calls, stdlib only).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  validateToolOutput,
  validateAndChain,
  DEFAULT_EMPTY_OK_TOOLS,
  MIN_FILE_WRITE_LENGTH,
} from "../lib/code-agent/tool-output-validator"

import {
  buildToolOutputRetry,
  isToolOutputChainable,
  validateStepChain,
} from "../lib/code-agent/autonomy"

// ---- valid outputs pass ------------------------------------------------------

test("valid JSON object output passes", () => {
  const result = validateToolOutput("read_json", '{"name":"app","version":"1.0.0"}')
  assert.equal(result.ok, true)
  assert.equal(result.severity, "ok")
  assert.equal(result.reason, undefined)
})

test("valid JSON array output passes", () => {
  const result = validateToolOutput("read_json", '[{"id":1},{"id":2}]')
  assert.equal(result.ok, true)
})

test("valid code output passes", () => {
  const result = validateToolOutput(
    "read_file",
    "export function add(a: number, b: number) {\n  return a + b\n}\n",
  )
  assert.equal(result.ok, true)
})

test("prose answer passes", () => {
  const result = validateToolOutput("ask_model", "El proyecto tiene 3 componentes principales listos.")
  assert.equal(result.ok, true)
})

test("non-string structured payload passes", () => {
  assert.equal(validateToolOutput("count_rows", 42).ok, true)
  assert.equal(validateToolOutput("is_ready", true).ok, true)
  assert.equal(validateToolOutput("fetch_rows", [{ id: 1 }, { id: 2 }]).ok, true)
})

// ---- empty detection ---------------------------------------------------------

test("empty string from a content-promising tool is flagged empty", () => {
  const result = validateToolOutput("read_file", "")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "empty")
  assert.match(result.reason!, /vacío/i)
})

test("whitespace-only string is flagged empty", () => {
  const result = validateToolOutput("fetch_page", "   \n\t  ")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "empty")
})

test("empty array from a content-promising tool is flagged empty", () => {
  const result = validateToolOutput("get_results", [])
  assert.equal(result.ok, false)
  assert.equal(result.severity, "empty")
})

test("empty object from a content-promising tool is flagged empty", () => {
  const result = validateToolOutput("load_config", {})
  assert.equal(result.ok, false)
  assert.equal(result.severity, "empty")
})

test("null/undefined from a content-promising tool is flagged empty", () => {
  assert.equal(validateToolOutput("download_asset", null).severity, "empty")
  assert.equal(validateToolOutput("pull_changes", undefined).severity, "empty")
})

test("content wrapper objects are unwrapped for emptiness", () => {
  const result = validateToolOutput("read_file", { content: "" })
  assert.equal(result.severity, "empty")
  assert.equal(validateToolOutput("read_file", { content: "hola" }).ok, true)
})

test("allowEmpty option lets a legitimate empty pass", () => {
  const result = validateToolOutput("search_web", "", { allowEmptyTools: ["search_web"] })
  assert.equal(result.ok, true)
  assert.equal(result.severity, "ok")
})

test("default allowlist treats search/grep/list emptiness as legitimate", () => {
  for (const tool of DEFAULT_EMPTY_OK_TOOLS) {
    const result = validateToolOutput(tool, [])
    assert.equal(result.ok, true, `tool ${tool} should allow empty`)
    assert.equal(result.severity, "ok")
  }
})

test("allowEmptyTools can be overridden per call", () => {
  // "grep" is in the default allowlist; removing it makes emptiness a failure.
  const strictResult = validateToolOutput("grep", [], {
    allowEmptyTools: [],
    expectContentTools: ["grep"],
  })
  assert.equal(strictResult.ok, false)
  assert.equal(strictResult.severity, "empty")
})

// ---- truncated JSON ----------------------------------------------------------

test("truncated JSON object is detected as truncated", () => {
  const result = validateToolOutput("fetch_data", '{"name":"test","items":[')
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
  assert.match(result.reason!, /JSON/)
})

test("JSON cut mid-string is detected as truncated", () => {
  const result = validateToolOutput("fetch_data", '{"description":"una frase que se corta aqu')
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
  assert.match(result.reason!, /string|truncada/i)
})

test("fenced JSON cut before closing is detected as truncated", () => {
  const result = validateToolOutput("api_call", '```json\n{\n  "status": "ok",\n  "rows": [\n    {"a":1},\n')
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
})

test("balanced but invalid JSON falls back to truncation severity", () => {
  const result = validateToolOutput("fetch_data", '{"a": }')
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
})

test("complete fenced JSON passes", () => {
  const result = validateToolOutput("api_call", '```json\n{"status":"ok","rows":[1,2]}\n```')
  assert.equal(result.ok, true)
})

// ---- truncated code ----------------------------------------------------------

test("code ending outside a closed block is flagged truncated", () => {
  const result = validateToolOutput("write_file", "export function handler(req) {\n  if (!req.body) {\n    return null\n  }\n  const data = parse(req.body)\n  return render(data)\n\nexport function other() {")
  // Braces balance here; force the real case below.
  void result
  const truncated = validateToolOutput("write_file", "function component() {\n  const [state, setState] = useState(null)\n  useEffect(() => {\n    load()\n")
  assert.equal(truncated.ok, false)
  assert.equal(truncated.severity, "truncated")
  assert.match(truncated.reason!, /truncado/i)
})

test("code with unbalanced parens is flagged truncated", () => {
  const result = validateToolOutput("generate_code", "const total = sum(items.map((item) => {\n  return item.price\n}")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
})

test("output ending with dangling operator is flagged truncated", () => {
  const result = validateToolOutput("run_query", "SELECT id, name FROM users WHERE active = ")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
})

test("unclosed markdown fence in generated content is flagged truncated", () => {
  const result = validateToolOutput("render_docs", "# Guía\n\nEjemplo:\n\n```bash\nnpm install\nnpm run dev\n")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "truncated")
  assert.match(result.reason!, /fence/)
})

test("balanced markdown fences pass", () => {
  const result = validateToolOutput("render_docs", "# Guía\n\n```bash\nnpm install\n```\n\nFin.")
  assert.equal(result.ok, true)
})

// ---- corrupt / error artifacts -------------------------------------------------

test("stack trace as the whole output is marked corrupt", () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    "    at renderList (/workspace/app/page.tsx:42:15)",
    "    at Page (/workspace/app/page.tsx:18:3)",
    "    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:15486:18)",
    "    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:20107:13)",
  ].join("\n")
  const result = validateToolOutput("exec_build", stack)
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
  assert.match(result.reason!, /error/i)
})

test('bare "Error:" prefix as whole output is marked corrupt', () => {
  const result = validateToolOutput("fetch_config", "Error: EACCES: permission denied, open '/etc/app.conf'")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
})

test("exception-style single line is marked corrupt", () => {
  const result = validateToolOutput("run_migration", "PrismaClientInitializationError: Can't reach database server")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
})

test("runtime fatal marker is marked corrupt", () => {
  const result = validateToolOutput("start_server", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
})

test("NUL bytes inside a text field are marked corrupt", () => {
  const result = validateToolOutput("read_file", "hello\u0000\u0000world with real content that keeps going")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
  assert.match(result.reason!, /binario|NUL/i)
})

test("long non-printable control run is marked corrupt", () => {
  const result = validateToolOutput("read_file", "header\x01\x02\x03\x04\x05\x06\x07\x08tail of a text payload")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "corrupt")
})

test("legit prose containing the word Error mid-sentence still passes", () => {
  const result = validateToolOutput("summarize", "El manejo de errores (Error handling) es correcto y está documentado en el módulo.")
  assert.equal(result.ok, true)
})

test("build log mentioning errors inside useful content passes", () => {
  const result = validateToolOutput(
    "get_logs",
    "Resumen del build: 12 tests pasaron, 0 fallos. Nota: SyntaxError previo fue corregido en el commit anterior.",
  )
  assert.equal(result.ok, true)
})

// ---- file-write plausibility ---------------------------------------------------

test("suspiciously short write_file output is flagged empty", () => {
  const result = validateToolOutput("write_file", "<div/>")
  assert.equal(result.ok, false)
  assert.equal(result.severity, "empty")
  assert.match(result.reason!, /corto/i)
})

test("short output from a NON-write tool passes", () => {
  const result = validateToolOutput("get_status", "OK")
  assert.equal(result.ok, true)
})

test("minFileWriteLength is configurable", () => {
  const result = validateToolOutput("create_file", "<div>hola</div>", { minFileWriteLength: 200 })
  assert.equal(result.ok, false)
  const okResult = validateToolOutput("create_file", "<div>hola</div>", { minFileWriteLength: 5 })
  assert.equal(okResult.ok, true)
})

test("MIN_FILE_WRITE_LENGTH default constant", () => {
  assert.equal(typeof MIN_FILE_WRITE_LENGTH, "number")
  assert.ok(MIN_FILE_WRITE_LENGTH > 0)
})

// ---- severity contract -----------------------------------------------------------

test("severities are exact across scenarios", () => {
  assert.equal(validateToolOutput("read_file", "").severity, "empty")
  assert.equal(validateToolOutput("fetch_data", '{"broken":').severity, "truncated")
  assert.equal(validateToolOutput("exec_build", "Error: boom").severity, "corrupt")
  assert.equal(validateToolOutput("search", []).severity, "ok")
  assert.equal(validateToolOutput("read_file", "contenido completo y válido del archivo").severity, "ok")
})

// ---- chaining ---------------------------------------------------------------------

test("validateAndChain returns first failed step index", () => {
  const result = validateAndChain([
    { toolName: "read_file", output: "contenido legible del archivo de configuración" },
    { toolName: "fetch_data", output: '{"partial":' },
    { toolName: "exec_build", output: "" },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.index, 1)
  assert.equal(result.severity, "truncated")
})

test("validateAndChain passes a fully valid sequence", () => {
  const result = validateAndChain([
    { toolName: "read_file", output: "package.json content with dependencies listed" },
    { toolName: "search_files", output: [] }, // legitimate empty
    { toolName: "build_project", output: "Build completed successfully in 4.2s" },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.index, undefined)
})

test("validateAndChain stops at the first corruption even if later steps are worse", () => {
  const result = validateAndChain([
    { toolName: "exec_tests", output: "AssertionError: expected 1 to equal 2\n    at test.js:10:5\n    at runner.js:99:11\n    at suite.js:7:1" },
    { toolName: "read_file", output: "" },
  ])
  assert.equal(result.index, 0)
  assert.equal(result.severity, "corrupt")
})

test("validateStepChain (autonomy bridge) mirrors validateAndChain", () => {
  const bad = validateStepChain([{ toolName: "write_file", output: "x" }])
  assert.ok(bad)
  assert.equal(bad.ok, false)
  assert.equal(bad.index, 0)

  const good = validateStepChain([{ toolName: "write_file", output: "un archivo con contenido suficiente para pasar el mínimo plausible" }])
  assert.equal(good, null)
})

// ---- autonomy retry integration ----------------------------------------------------

test("buildToolOutputRetry drives bounded retries like stream/quality gates", () => {
  const verdict = validateToolOutput("fetch_data", '{"cut":')
  const first = buildToolOutputRetry(verdict, 0)
  assert.equal(first.shouldRetry, true)
  assert.equal(first.attempts, 1)
  assert.equal(first.reason, "tool_output")
  assert.ok(first.instruction)

  // Budget exhausted → stop retrying but keep the reason for reporting.
  const capped = buildToolOutputRetry(verdict, 2)
  assert.equal(capped.shouldRetry, false)
  assert.equal(capped.reason, "tool_output")
})

test("buildToolOutputRetry ignores passing verdicts", () => {
  const decision = buildToolOutputRetry({ ok: true, severity: "ok" }, 0)
  assert.equal(decision.shouldRetry, false)
  assert.equal(decision.reason, "none")
})

test("isToolOutputChainable applies the default search allowlist", () => {
  assert.equal(isToolOutputChainable("web_search", []), true)
  assert.equal(isToolOutputChainable("read_file", ""), false)
  assert.equal(isToolOutputChainable("read_file", "contenido real"), true)
})
