'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const hostRunner = require('../src/services/code/host-runner');
const workspaceRunner = require('../src/services/github/workspace-runner.service');

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('host code runner uses same-origin proxy URLs in production', () => {
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PROXY_URLS: undefined }, () => {
    assert.equal(hostRunner.useProxyUrls(), true);
    assert.equal(hostRunner.publicDevUrl('run 123', 4311), '/api/code-runner/run123/proxy/');
  });
});

test('host code runner keeps localhost URLs when proxy mode is disabled', () => {
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PROXY_URLS: '0' }, () => {
    assert.equal(hostRunner.useProxyUrls(), false);
    assert.equal(hostRunner.publicDevUrl('run-abc', 4311), 'http://localhost:4311');
  });
});

test('github workspace runner emits proxy URL and Vite base path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runner-test-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '^7.0.0' } }),
    );
    withEnv({ NODE_ENV: 'production', SIRAGPT_WORKSPACE_RUN_PROXY_URLS: undefined }, () => {
      assert.equal(workspaceRunner.useProxyUrls(), true);
      assert.equal(workspaceRunner.publicPreviewUrl('conn_1', 4300), '/api/github/connected/conn_1/proxy/');
      const plan = workspaceRunner.detectRunPlan(dir, 4300, 'conn_1');
      assert.equal(plan.kind, 'node');
      assert.equal(plan.framework, 'vite');
      assert.match(plan.command, /--base "\/api\/github\/connected\/conn_1\/proxy\/"/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
