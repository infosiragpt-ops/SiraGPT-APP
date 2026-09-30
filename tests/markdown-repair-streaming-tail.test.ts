import { test } from "node:test"
import assert from "node:assert/strict"

import { repairStreamingTail } from "../lib/markdown/repair-streaming-tail"

test("leaves an open fenced code block untouched", () => {
  const tail = "```ts\nconst a = `x\n**b"
  assert.equal(repairStreamingTail(tail), tail)
})

test("closes an unfinished bold run", () => {
  assert.equal(repairStreamingTail("Esto es **Paso importante"), "Esto es **Paso importante**")
})

test("does not close bold that is only just opening", () => {
  assert.equal(repairStreamingTail("Texto **"), "Texto **")
})

test("drops a half-typed link", () => {
  assert.equal(repairStreamingTail("Lee la [documentación](https://exa"), "Lee la ")
  assert.equal(repairStreamingTail("Lee la [documen"), "Lee la ")
})

test("keeps a finished link", () => {
  const tail = "Lee la [documentación](https://example.com) hoy"
  assert.equal(repairStreamingTail(tail), tail)
})

test("drops a header-only table until its delimiter row arrives", () => {
  assert.equal(repairStreamingTail("Resumen:\n| Col | Col |"), "Resumen:")
})

test("keeps a table once the delimiter row exists", () => {
  const tail = "| Col | Col |\n| --- | --- |\n| a | b |"
  assert.equal(repairStreamingTail(tail), tail)
})

test("ignores markers inside complete inline code", () => {
  const tail = "Usa `a**b` así"
  assert.equal(repairStreamingTail(tail), tail)
})

test("closes an open inline code span", () => {
  assert.equal(repairStreamingTail("Ejecuta `npm run"), "Ejecuta `npm run`")
})

test("a list bullet is not treated as bold", () => {
  const tail = "* item"
  assert.equal(repairStreamingTail(tail), tail)
})

test("empty input stays empty", () => {
  assert.equal(repairStreamingTail(""), "")
})
