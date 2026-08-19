const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePreviewScreenshot,
  isPlaywrightAvailable,
  DEFAULT_MIN_PNG_BYTES,
} = require('../src/services/agents/preview-screenshot-validator');

// Detect once whether Chromium is on this runner. CI doesn't run
// `npx playwright install` for the backend job today, so the binary
// is missing and the validator falls back to the
// "validator_unavailable" path. We exercise both branches: the
// fast-path tests run unconditionally, the launch-Chromium tests
// only run when the binary is actually there.
let _availability;
async function available() {
  if (_availability === undefined) _availability = await isPlaywrightAvailable();
  return _availability;
}

test('validatePreviewScreenshot rejects when no input is supplied', async () => {
  const result = await validatePreviewScreenshot({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_input');
});

test('validatePreviewScreenshot fails-soft when Playwright is not installed', async () => {
  // We can't simulate "Playwright not installed" without monkey-patching
  // the require cache; instead, we assert that on runners where
  // Chromium IS missing, the validator returns ok:true with the
  // distinguishable validator_unavailable reason. On runners where
  // Chromium is present this test is a no-op (the production path
  // is exercised by the next test).
  const isAvailable = await available();
  if (isAvailable) {
    return;
  }
  const result = await validatePreviewScreenshot({
    html: '<html><body>Hola</body></html>',
  });
  assert.equal(result.ok, true, 'fail-soft should keep ok=true so the gate doesn\'t block');
  assert.equal(result.reason, 'validator_unavailable');
  assert.equal(result.validatorAvailable, false);
});

test('validatePreviewScreenshot returns >=DEFAULT_MIN_PNG_BYTES on a real-content page', async () => {
  const isAvailable = await available();
  if (!isAvailable) {
    // No Chromium on this runner — skip the launch-dependent test.
    return;
  }
  const result = await validatePreviewScreenshot({
    html: `
      <html>
        <head><style>
          body{margin:0;font-family:Arial;background:#fff;color:#000;}
          .hero{padding:40px;background:linear-gradient(45deg,#08f,#f08);color:#fff;font-size:48px;}
        </style></head>
        <body>
          <div class="hero">Documento Validado</div>
          <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.
             Pellentesque convallis, lectus eget tincidunt euismod,
             quam tellus consequat ipsum, sed accumsan augue mauris
             nec sapien. Curabitur ac nibh nec lectus tincidunt.</p>
          <ul>
            <li>Lista 1</li>
            <li>Lista 2</li>
            <li>Lista 3</li>
          </ul>
        </body>
      </html>`,
  });
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
  assert.equal(result.validatorAvailable, true);
  assert.ok(
    result.pngBytes >= DEFAULT_MIN_PNG_BYTES,
    `expected pngBytes >= ${DEFAULT_MIN_PNG_BYTES}, got ${result.pngBytes}`,
  );
  assert.ok(result.durationMs > 0, 'should report render time');
});

test('validatePreviewScreenshot flags a blank page as blank_render', async () => {
  const isAvailable = await available();
  if (!isAvailable) {
    return;
  }
  const result = await validatePreviewScreenshot({
    html: '<html><body></body></html>',
    minPngBytes: DEFAULT_MIN_PNG_BYTES,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blank_render');
  assert.ok(result.pngBytes < DEFAULT_MIN_PNG_BYTES);
});

test('validatePreviewScreenshot wraps Chromium errors as render_failed', async () => {
  const isAvailable = await available();
  if (!isAvailable) {
    return;
  }
  // Navigate to a URL that's guaranteed to fail — Playwright will
  // throw before the screenshot lands.
  const result = await validatePreviewScreenshot({
    url: 'http://127.0.0.1:1/this-port-is-closed',
    navigationTimeoutMs: 2000,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /render_failed|net::ERR_/i);
});
