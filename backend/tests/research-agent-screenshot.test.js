'use strict';

// Regression — an oversized page screenshot must be DROPPED, not byte-truncated.
//
// A PNG is a chunked binary format (IHDR/IDAT/IEND + CRCs); slicing it to N
// bytes yields an undecodable image. research-agent fed that corrupt base64 to
// the vision model, wasting the call on garbage. The oversize branch now nulls
// the screenshot. The capture path runs only under real Playwright (no offline
// injection point in createBrowserSession), so this guards the source wiring,
// like ai-generate-chat-idor-guard.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'research-agent.js'), 'utf8');

test('oversized screenshots are dropped, not base64-encoded from a sliced PNG', () => {
  assert.ok(
    !/png\.slice\([^)]*\)\.toString\(\s*'base64'\s*\)/.test(src),
    'must not base64-encode a byte-sliced (corrupt) PNG',
  );
});

test('the oversize-screenshot branch nulls the screenshot', () => {
  assert.match(
    src,
    /screenshotBase64 = null;[\s\S]{0,120}screenshot_too_large/,
    'oversize branch must drop the screenshot with a too_large marker',
  );
});
