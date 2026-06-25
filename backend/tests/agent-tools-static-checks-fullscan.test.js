'use strict';

// Regression — static_checks must scan the WHOLE source, not just the first
// 40_000 chars.
//
// When called without inline `content`, static_checks read the file from the
// collection via read_file, whose public max_chars is hard-capped at 40_000
// (Math.min(..., 40000)). Although static_checks asked for 200_000 chars, the
// clamp silently truncated to 40k, so any vulnerability past the first 40k
// (weak crypto, eval, unsafe_html, TLS-disabled, …) was never detected on large
// files. The fix reconstructs the source directly from the chunks up to the
// scan's own 200k ceiling.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/services/agents/agent-tools');
const rag = require('../src/services/rag-service');

test('static_checks scans past the 40k read_file clamp', async () => {
  // 4000 lines of benign code (~52k chars) push the eval well past both the
  // 40_000-char mark (~3076 lines) and the old clamp.
  const filler = 'const a = 1;\n'.repeat(4000);
  assert.ok(filler.length > 40000, 'filler must exceed the 40k clamp');
  const content = filler + 'const r = eval(userInput);\n'; // eval on line 4001

  const orig = rag.getBySource;
  rag.getBySource = async () => [{ text: content, title: null }];
  try {
    const out = await tools.static_checks.handler({ source: 'big.js' }, { userId: 'u', collection: 'c' });
    const evalHits = out.findings.filter((f) => f.rule === 'eval_usage');
    assert.equal(evalHits.length, 1, 'eval past the 40k mark must be detected');
    assert.equal(evalHits[0].line, 4001, 'the finding is on the real line, past the old 40k cut');
    assert.equal(evalHits[0].severity, 'high');
  } finally {
    rag.getBySource = orig;
  }
});

test('static_checks honours its own 200k scan ceiling (truncates beyond)', async () => {
  // >200k chars → scanned content is capped and flagged as truncated.
  const big = 'const a = 1;\n'.repeat(20000); // ~260k chars
  assert.ok(big.length > 200000);
  const orig = rag.getBySource;
  rag.getBySource = async () => [{ text: big, title: null }];
  try {
    const out = await tools.static_checks.handler({ source: 'huge.js' }, { userId: 'u', collection: 'c' });
    assert.equal(out.inputTruncated, true, 'content beyond 200k is marked truncated');
    assert.ok(out.scannedChars <= 200000, 'scanned no more than the 200k ceiling');
  } finally {
    rag.getBySource = orig;
  }
});
