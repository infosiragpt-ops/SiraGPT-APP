'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Caddy computer viewer + live SSE backup', () => {
  const caddy = fs.readFileSync(path.join(__dirname, '../../deploy/Caddyfile'), 'utf8');

  test('does not gzip/zstd text/event-stream and keeps generate flush', () => {
    assert.match(caddy, /NOT the live iliagpt-gateway Caddyfile/);
    assert.match(caddy, /\/home\/user\/deployments\/iliagpt\/Caddyfile/);
    assert.match(caddy, /not header Content-Type text\/event-stream\*/);
    assert.match(caddy, /handle \/api\/ai\/generate\*/);
    assert.match(caddy, /flush_interval -1/);
    assert.match(caddy, /X-Accel-Buffering no/);
  });

  test('serves noVNC on siragpt.com /sessions, not computer.siragpt.com', () => {
    assert.match(caddy, /handle \/sessions\/\*/);
    assert.match(caddy, /siragpt-computer-orchestrator:8090/);
    const handles = caddy.split('\n').filter((line) => /^\s*(handle|reverse_proxy|@)/.test(line)).join('\n');
    assert.doesNotMatch(handles, /computer\.siragpt\.com/);
    assert.doesNotMatch(handles, /computer\.chatagic\.com/);
  });
});
