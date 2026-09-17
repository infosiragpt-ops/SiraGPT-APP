'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Lenovo iliagpt computer publish contract', () => {
  const readme = read('deploy/iliagpt/README.md');
  const compose = read('deploy/iliagpt/computer-orchestrator.compose.yaml');
  const handle = read('deploy/iliagpt/sessions.handle.caddy');
  const publish = read('deploy/iliagpt/publish.sh.snippet');
  const repoCaddy = read('deploy/Caddyfile');
  const orchServer = read('services/computer-orchestrator/server.js');

  test('live Caddy stays the iliagpt file; repo deploy/Caddyfile is not the gateway', () => {
    assert.match(readme, /\/home\/user\/deployments\/iliagpt\/Caddyfile/);
    assert.match(readme, /Do not.*copy `deploy\/Caddyfile`/i);
    assert.match(readme, /@sse/);
    assert.match(repoCaddy, /NOT the live iliagpt-gateway Caddyfile/);
    assert.match(repoCaddy, /\/home\/user\/deployments\/iliagpt\/Caddyfile/);
  });

  test('sessions handle is the only live Caddy edit and does not touch SSE', () => {
    const live = handle.split('\n').filter((line) => /^\s*(handle|reverse_proxy)/.test(line)).join('\n');
    assert.match(handle, /Do NOT touch @sse/);
    assert.match(live, /handle \/sessions\/\*/);
    assert.match(live, /siragpt-computer-orchestrator:8090/);
    assert.doesNotMatch(live, /encode |gzip|zstd|flush_interval|generate\*/);
    assert.doesNotMatch(live, /computer\.siragpt\.com/);
    assert.doesNotMatch(live, /computer\.chatagic\.com/);
  });

  test('Lenovo compose: hostname, docker.sock, MAX_DESKTOPS 2, public base siragpt.com', () => {
    assert.match(compose, /hostname:\s*siragpt-computer-orchestrator/);
    assert.match(compose, /container_name:\s*siragpt-computer-orchestrator/);
    assert.match(compose, /\/var\/run\/docker\.sock/);
    assert.match(compose, /AGENT_COMPUTER_MAX_DESKTOPS:\s*"2"/);
    assert.match(compose, /AGENT_COMPUTER_PUBLIC_BASE:\s*https:\/\/siragpt\.com/);
    assert.match(compose, /iliagpt-app/);
    assert.doesNotMatch(compose, /MAX_DESKTOPS:\s*"8"/);
    assert.doesNotMatch(compose, /computer\.siragpt\.com/);
  });

  test('publish.sh snippet builds and ups orch with --no-deps; no down -v', () => {
    const cmds = publish.split('\n').filter((line) => /^\s*docker compose/.test(line)).join('\n');
    assert.match(cmds, /docker compose .* build computer-orchestrator/);
    assert.match(cmds, /up -d --no-deps computer-orchestrator/);
    assert.match(publish, /\/home\/user\/deployments\/iliagpt\/compose\.yaml/);
    assert.doesNotMatch(cmds, /down\s+-v/);
    assert.doesNotMatch(cmds, /git reset --hard/);
  });

  test('orchestrator default desktop cap is 2', () => {
    assert.match(orchServer, /AGENT_COMPUTER_MAX_DESKTOPS[\s\S]{0,80}: 2/);
  });
});
