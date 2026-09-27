'use strict';
// THROWAWAY (PR #820): proves a failing backend test in the 7-bucket layout still blocks. Reverted next commit.
const test = require('node:test');
const assert = require('node:assert/strict');
test('ci gate probe must fail (backend)', () => { assert.equal(1, 2); });
