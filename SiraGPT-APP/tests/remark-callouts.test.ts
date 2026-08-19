import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { CALLOUT_KINDS, remarkCallouts } from "../lib/markdown/remark-callouts"

/**
 * remark-callouts is a remark transformer. The plugin returns a
 * function that visits a tree and rewrites `containerDirective` nodes
 * with one of the 5 allowed kinds (note/warning/tip/info/caution)
 * into an <aside> with the callout-* class.
 *
 * We don't need a full mdast tree to test the transformer — we can
 * hand it a hand-built node shape and assert the in-place rewrite.
 */

function transform(node: any) {
  // remarkCallouts returns the transformer function directly. It walks
  // the tree via unist-util-visit; passing a single-node tree is fine.
  const transformer = remarkCallouts()
  transformer(node)
  return node
}

describe("remarkCallouts · allowed kinds", () => {
  for (const kind of ["note", "warning", "tip", "info", "caution"] as const) {
    it(`rewrites :::${kind} containers to <aside class="callout callout-${kind}">`, () => {
      const node = {
        type: "containerDirective",
        name: kind,
        children: [],
      }
      const out = transform({ type: "root", children: [node] })
      const rewritten = out.children[0] as any
      assert.equal(rewritten.data?.hName, "aside")
      assert.deepEqual(rewritten.data?.hProperties?.className, [
        "callout",
        `callout-${kind}`,
      ])
      assert.equal(rewritten.data?.hProperties?.role, "note")
      assert.equal(rewritten.data?.hProperties?.["data-callout-kind"], kind)
    })
  }
})

describe("remarkCallouts · rejection paths", () => {
  it("ignores unknown directive names (silent no-op, NOT throw)", () => {
    const node = {
      type: "containerDirective",
      name: "script",
      children: [],
    }
    const out = transform({ type: "root", children: [node] })
    const rewritten = out.children[0] as any
    // No hName / hProperties assigned -> stays as-is, will be dropped
    // by rehype-sanitize downstream.
    assert.equal(rewritten.data, undefined)
  })

  it("ignores leaf directives (only container :::name :::​ form is supported)", () => {
    const node = {
      type: "leafDirective",
      name: "note",
      children: [],
    }
    const out = transform({ type: "root", children: [node] })
    const rewritten = out.children[0] as any
    assert.equal(rewritten.data, undefined)
  })

  it("ignores text directives", () => {
    const node = {
      type: "textDirective",
      name: "note",
      children: [],
    }
    const out = transform({ type: "root", children: [node] })
    const rewritten = out.children[0] as any
    assert.equal(rewritten.data, undefined)
  })

  it("leaves non-directive nodes alone", () => {
    const node = { type: "paragraph", children: [{ type: "text", value: "hi" }] }
    const out = transform({ type: "root", children: [node] })
    const rewritten = out.children[0] as any
    assert.equal(rewritten.data, undefined)
    assert.equal(rewritten.type, "paragraph")
  })
})

describe("CALLOUT_KINDS export", () => {
  it("lists exactly the five supported kinds", () => {
    assert.equal(CALLOUT_KINDS.length, 5)
    assert.ok(CALLOUT_KINDS.includes("note"))
    assert.ok(CALLOUT_KINDS.includes("warning"))
    assert.ok(CALLOUT_KINDS.includes("tip"))
    assert.ok(CALLOUT_KINDS.includes("info"))
    assert.ok(CALLOUT_KINDS.includes("caution"))
  })
})
