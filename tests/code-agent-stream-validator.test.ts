/**
 * Tests for the post-stream validator (Improvement 2).
 * Deterministic checks for broken fences, invalid JSON, unclosed JSX, truncation.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  validateStreamedFile,
  validateStreamedFiles,
  MAX_STREAM_RETRIES,
} from "../lib/code-agent/stream-validator"

// ---- valid content passes --------------------------------------------------

test("valid TSX file passes validation", () => {
  const result = validateStreamedFile("app/page.tsx", "export default function Page() {\n  return <div>Hello</div>\n}")
  assert.equal(result.valid, true)
  assert.equal(result.retryInstruction, undefined)
})

test("valid JSON file passes validation", () => {
  const result = validateStreamedFile("data.json", '{"name":"test","version":"1.0"}')
  assert.equal(result.valid, true)
})

test("valid TS file passes validation", () => {
  const result = validateStreamedFile("lib/utils.ts", "export function add(a: number, b: number) { return a + b }")
  assert.equal(result.valid, true)
})

test("empty file fails with retry instruction", () => {
  const result = validateStreamedFile("app/page.tsx", "")
  assert.equal(result.valid, false)
  assert.ok(result.retryInstruction)
  assert.match(result.issue!, /vacío/i)
})

// ---- code fence balancing --------------------------------------------------

test("unclosed code fence fails", () => {
  const content = "Here is the code:\n```tsx\nexport default function Page() { return <div/> }\n"
  const result = validateStreamedFile("app/page.tsx", content)
  assert.equal(result.valid, false)
  assert.ok(result.retryInstruction)
  assert.match(result.retryInstruction!, /fence/i)
})

test("balanced code fences pass", () => {
  const content = "Here is the code:\n```tsx\nexport default function Page() { return <div/> }\n```\nDone."
  const result = validateStreamedFile("app/page.tsx", content)
  assert.equal(result.valid, true)
})

// ---- JSON validation -------------------------------------------------------

test("truncated JSON fails", () => {
  const result = validateStreamedFile("data.json", '{"name":"test","version":')
  assert.equal(result.valid, false)
  assert.ok(result.retryInstruction)
  assert.match(result.retryInstruction!, /JSON/i)
})

test("invalid JSON fails with parse error", () => {
  const result = validateStreamedFile("data.json", '{"name": test}')
  assert.equal(result.valid, false)
  assert.ok(result.retryInstruction)
})

test("valid JSON array passes", () => {
  const result = validateStreamedFile("items.json", '[1, 2, 3]')
  assert.equal(result.valid, true)
})

// ---- JSX tag validation ----------------------------------------------------

test("unclosed JSX component tag fails", () => {
  const content = "export default function Page() {\n  return <Card><Header>Hello</Card>\n}"
  const result = validateStreamedFile("app/page.tsx", content)
  assert.equal(result.valid, false)
  assert.ok(result.retryInstruction)
  assert.match(result.retryInstruction!, /JSX/i)
})

test("self-closing JSX tags pass", () => {
  const content = "export default function Page() {\n  return <div><Card /><Button /></div>\n}"
  const result = validateStreamedFile("app/page.tsx", content)
  assert.equal(result.valid, true)
})

// ---- truncation detection --------------------------------------------------

test("content ending with comma is flagged as truncated", () => {
  const result = validateStreamedFile("lib/utils.ts", "const x = 1,")
  assert.equal(result.valid, false)
  assert.match(result.issue!, /truncado/i)
})

test("content ending with open brace is flagged as truncated", () => {
  const result = validateStreamedFile("lib/utils.ts", "function foo() {")
  assert.equal(result.valid, false)
  assert.match(result.issue!, /truncado/i)
})

test("content ending with unclosed string is flagged as truncated", () => {
  const result = validateStreamedFile("lib/utils.ts", 'const x = "hello" + "')
  assert.equal(result.valid, false)
  assert.match(result.issue!, /string/i)
})

test("content ending naturally passes", () => {
  const result = validateStreamedFile("lib/utils.ts", "export const x = 1\n")
  assert.equal(result.valid, true)
})

// ---- batch validation ------------------------------------------------------

test("validateStreamedFiles returns first failure", () => {
  const files = [
    { path: "app/page.tsx", content: "export default function Page() { return <div/> }" },
    { path: "data.json", content: '{"broken":' },
  ]
  const result = validateStreamedFiles(files)
  assert.equal(result.valid, false)
  assert.match(result.issue!, /JSON/i)
})

test("validateStreamedFiles passes when all files are valid", () => {
  const files = [
    { path: "app/page.tsx", content: "export default function Page() { return <div/> }" },
    { path: "lib/utils.ts", content: "export const x = 1" },
  ]
  const result = validateStreamedFiles(files)
  assert.equal(result.valid, true)
})

test("MAX_STREAM_RETRIES is 2", () => {
  assert.equal(MAX_STREAM_RETRIES, 2)
})
