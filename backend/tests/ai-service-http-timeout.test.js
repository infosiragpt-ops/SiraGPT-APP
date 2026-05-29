'use strict';

// Verifies that the direct OpenAI REST calls in ai-service.js (made through
// axios, not the OpenAI SDK client) carry a bounded timeout so a stalled
// connection cannot hang the request indefinitely.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const axios = require('axios');
const service = require('../src/services/ai-service');

describe('ai-service direct OpenAI HTTP calls — bounded timeout', () => {
  test('exposes a sane, clamped default timeout constant', () => {
    const t = service.OPENAI_HTTP_TIMEOUT_MS;
    assert.equal(typeof t, 'number');
    assert.ok(Number.isFinite(t));
    assert.ok(t >= 1_000 && t <= 600_000, `timeout ${t} out of [1s, 10min]`);
  });

  test('uploadFileToContainer passes timeout to axios.post', async (t) => {
    let captured = null;
    t.mock.method(axios, 'post', async (_url, _form, config) => {
      captured = config;
      return { data: { id: 'file_test' } };
    });

    // Real temp file so fs.createReadStream() inside the method succeeds.
    const tmp = path.join(os.tmpdir(), `sira-ai-svc-timeout-${process.pid}.txt`);
    fs.writeFileSync(tmp, 'hello');
    try {
      const result = await service.uploadFileToContainer(tmp, 'container_abc');
      assert.deepEqual(result, { id: 'file_test' });
      assert.ok(captured, 'axios.post should have been called');
      assert.equal(captured.timeout, service.OPENAI_HTTP_TIMEOUT_MS);
      assert.ok(captured.timeout > 0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
