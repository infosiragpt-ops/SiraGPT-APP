import assert from "node:assert/strict"
import test from "node:test"
// THROWAWAY (PR #820): proves a failing root test still blocks the required check. Reverted next commit.
test("ci gate probe must fail", () => { assert.equal(1, 2) })
