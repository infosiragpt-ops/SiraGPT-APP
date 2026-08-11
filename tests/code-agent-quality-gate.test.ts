/**
 * Tests for the post-generation quality gate (Improvement 4).
 * Verifies deterministic checks for missing imports, a11y, structure, lint.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { runQualityGate, type QualityIssue } from "../lib/code-agent/quality-gate"

// ---- passing files ---------------------------------------------------------

test("clean TSX file passes quality gate", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'import { useState } from "react"\n\nexport default function Page() {\n  const [x, setX] = useState(0)\n  return <div>{x}</div>\n}',
    },
  ])
  assert.equal(result.passed, true)
  assert.equal(result.issues.length, 0)
})

test("clean TS file passes quality gate", () => {
  const result = runQualityGate([
    {
      path: "lib/utils.ts",
      content: "export function add(a: number, b: number) { return a + b }",
    },
  ])
  assert.equal(result.passed, true)
})

// ---- missing React hook imports --------------------------------------------

test("missing useState import is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() {\n  const [x, setX] = useState(0)\n  return <div>{x}</div>\n}',
    },
  ])
  assert.equal(result.passed, false)
  const issue = result.issues.find((i) => i.rule === "missing-import-useState")
  assert.ok(issue)
  assert.equal(issue!.severity, "error")
})

test("missing useEffect import is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() {\n  useEffect(() => {}, [])\n  return <div/>\n}',
    },
  ])
  assert.equal(result.passed, false)
  assert.ok(result.issues.find((i) => i.rule === "missing-import-useEffect"))
})

test("missing useRef import is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() {\n  const ref = useRef(null)\n  return <div ref={ref}/>\n}',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "missing-import-useRef"))
})

test("missing useCallback import is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() {\n  const fn = useCallback(() => {}, [])\n  return <div/>\n}',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "missing-import-useCallback"))
})

test("missing useMemo import is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() {\n  const val = useMemo(() => 42, [])\n  return <div>{val}</div>\n}',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "missing-import-useMemo"))
})

test("hooks imported from react are not flagged", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'import { useState, useEffect, useRef, useCallback, useMemo } from "react"\nexport default function Page() {\n  const [x] = useState(0)\n  const ref = useRef(null)\n  const fn = useCallback(() => {}, [])\n  const val = useMemo(() => 42, [])\n  useEffect(() => {}, [])\n  return <div ref={ref}>{val}{x}</div>\n}',
    },
  ])
  assert.equal(result.issues.filter((i) => i.rule.startsWith("missing-import")).length, 0)
  assert.equal(result.passed, true)
})

// ---- missing default export ------------------------------------------------

test("page.tsx without default export is detected", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export function Page() { return <div/> }',
    },
  ])
  assert.equal(result.passed, false)
  assert.ok(result.issues.find((i) => i.rule === "missing-default-export"))
})

test("layout.tsx without default export is detected", () => {
  const result = runQualityGate([
    {
      path: "app/layout.tsx",
      content: 'export function Layout({ children }) { return <div>{children}</div> }',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "missing-default-export"))
})

test("page.tsx with default export passes", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() { return <div/> }',
    },
  ])
  assert.equal(result.issues.find((i) => i.rule === "missing-default-export"), undefined)
})

test("non-page TSX without default export is not flagged", () => {
  const result = runQualityGate([
    {
      path: "components/Button.tsx",
      content: 'export function Button() { return <button/> }',
    },
  ])
  assert.equal(result.issues.find((i) => i.rule === "missing-default-export"), undefined)
})

// ---- accessibility ---------------------------------------------------------

test("img without alt attribute is flagged", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() { return <img src="/hero.png" /> }',
    },
  ])
  const altIssue = result.issues.find((i) => i.rule === "a11y-img-missing-alt")
  assert.ok(altIssue)
  assert.equal(altIssue!.severity, "warning")
})

test("img with alt attribute passes", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() { return <img src="/hero.png" alt="Hero" /> }',
    },
  ])
  assert.equal(result.issues.find((i) => i.rule === "a11y-img-missing-alt"), undefined)
})

test("empty button without aria-label is flagged", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() { return <button className="btn"></button> }',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "a11y-button-no-label"))
})

test("empty button with aria-label passes", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export default function Page() { return <button aria-label="Close" onClick={() => {}}></button> }',
    },
  ])
  assert.equal(result.issues.find((i) => i.rule === "a11y-button-no-label"), undefined)
})

// ---- console.log -----------------------------------------------------------

test("console.log in production code is flagged", () => {
  const result = runQualityGate([
    {
      path: "lib/utils.ts",
      content: 'export function foo() { console.log("debug") }',
    },
  ])
  assert.ok(result.issues.find((i) => i.rule === "no-console-log"))
})

test("console.log in test files is not flagged", () => {
  const result = runQualityGate([
    {
      path: "tests/utils.test.ts",
      content: 'console.log("test debug")',
    },
  ])
  assert.equal(result.issues.find((i) => i.rule === "no-console-log"), undefined)
})

// ---- retry instruction -----------------------------------------------------

test("retry instruction is generated when issues exist", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export function Page() { const [x] = useState(0); return <img src="/x.png" /> }',
    },
  ])
  assert.ok(result.retryInstruction)
  assert.match(result.retryInstruction!, /Corrige/)
})

test("retry instruction is undefined when no issues", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'import { useState } from "react"\nexport default function Page() {\n  const [x] = useState(0)\n  return <div>{x}</div>\n}',
    },
  ])
  assert.equal(result.retryInstruction, undefined)
})

// ---- multi-file -----------------------------------------------------------

test("quality gate aggregates issues across multiple files", () => {
  const result = runQualityGate([
    {
      path: "app/page.tsx",
      content: 'export function Page() { return <img src="/x.png" /> }',
    },
    {
      path: "lib/utils.ts",
      content: 'console.log("debug")',
    },
  ])
  assert.ok(result.issues.length >= 2)
  assert.ok(result.issues.some((i) => i.filePath === "app/page.tsx"))
  assert.ok(result.issues.some((i) => i.filePath === "lib/utils.ts"))
})
