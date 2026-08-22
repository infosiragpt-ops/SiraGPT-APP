/**
 * Tests for the subagent tier system (Improvement 3).
 * Verifies that depth/parallelism limits are configurable by plan tier.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  getSubagentLimits,
  type SubagentTier,
  type SubagentLimits,
} from "../lib/code-agent/subagent"

// ---- tier limits -----------------------------------------------------------

test("starter tier: depth 1, parallel 4", () => {
  const limits = getSubagentLimits("starter")
  assert.equal(limits.maxDepth, 1)
  assert.equal(limits.maxParallel, 4)
})

test("standard tier: depth 2, parallel 6", () => {
  const limits = getSubagentLimits("standard")
  assert.equal(limits.maxDepth, 2)
  assert.equal(limits.maxParallel, 6)
})

test("complex tier: depth 3, parallel 12", () => {
  const limits = getSubagentLimits("complex")
  assert.equal(limits.maxDepth, 3)
  assert.equal(limits.maxParallel, 12)
})

test("no tier returns default limits (backward compatible)", () => {
  const limits = getSubagentLimits(undefined)
  assert.equal(limits.maxDepth, 1)
  assert.equal(limits.maxParallel, 6)
})

test("unknown tier falls back to standard", () => {
  const limits = getSubagentLimits("nonexistent" as SubagentTier)
  assert.equal(limits.maxDepth, 2)
  assert.equal(limits.maxParallel, 6)
})

// ---- tier progression ------------------------------------------------------

test("complex tier allows more depth than starter", () => {
  const starter = getSubagentLimits("starter")
  const complex = getSubagentLimits("complex")
  assert.ok(complex.maxDepth > starter.maxDepth)
  assert.ok(complex.maxParallel > starter.maxParallel)
})

test("standard tier is between starter and complex", () => {
  const starter = getSubagentLimits("starter")
  const standard = getSubagentLimits("standard")
  const complex = getSubagentLimits("complex")
  assert.ok(standard.maxDepth >= starter.maxDepth)
  assert.ok(standard.maxDepth <= complex.maxDepth)
  assert.ok(standard.maxParallel >= starter.maxParallel)
  assert.ok(standard.maxParallel <= complex.maxParallel)
})
