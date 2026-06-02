'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const codeSandbox = require('../src/services/agents/code-sandbox');
const dockerBridge = require('../src/services/agents/hermes-docker-bridge');

test('healthCheck invokes code-sandbox.run with a single options object (not positional)', async () => {
  const origRun = codeSandbox.run;
  let captured = null;
  codeSandbox.run = async (...args) => {
    captured = args;
    return { ok: true, exitCode: 0, stdout: 'ok\n', stderr: '' };
  };
  try {
    const res = await dockerBridge.healthCheck();
    assert.equal(captured.length, 1, 'run must be called with exactly one argument');
    assert.equal(typeof captured[0], 'object');
    assert.deepEqual(
      { language: captured[0].language, source: captured[0].source },
      { language: 'python', source: 'print("ok")' },
    );
    assert.equal(res.ok, true);
    assert.equal(res.sandbox.ok, true);
    assert.equal(res.sandbox.error, null);
  } finally {
    codeSandbox.run = origRun;
  }
});

test('healthCheck reports unhealthy and surfaces stderr when the sandbox run fails', async () => {
  const origRun = codeSandbox.run;
  codeSandbox.run = async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom' });
  try {
    const res = await dockerBridge.healthCheck();
    assert.equal(res.ok, false);
    assert.equal(res.sandbox.ok, false);
    assert.match(String(res.sandbox.error), /boom/);
  } finally {
    codeSandbox.run = origRun;
  }
});

test('healthCheck captures thrown errors as sandbox.error', async () => {
  const origRun = codeSandbox.run;
  codeSandbox.run = async () => { throw new Error('exec failed'); };
  try {
    const res = await dockerBridge.healthCheck();
    assert.equal(res.ok, false);
    assert.match(String(res.sandbox.error), /exec failed/);
  } finally {
    codeSandbox.run = origRun;
  }
});

test('listBackends evaluates availability lazily against current env', () => {
  const prevDocker = process.env.SANDBOX_DOCKER;
  const prevHost = process.env.DOCKER_HOST;
  delete process.env.SANDBOX_DOCKER;
  delete process.env.DOCKER_HOST;
  try {
    let docker = dockerBridge.listBackends().find((b) => b.id === 'docker');
    assert.equal(docker.available, false);
    process.env.SANDBOX_DOCKER = '1';
    docker = dockerBridge.listBackends().find((b) => b.id === 'docker');
    assert.equal(docker.available, true, 'availability must reflect env set after module load');
  } finally {
    if (prevDocker === undefined) delete process.env.SANDBOX_DOCKER; else process.env.SANDBOX_DOCKER = prevDocker;
    if (prevHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = prevHost;
  }
});

test('planned backends are marked implemented:false; wired ones implemented:true', () => {
  const byId = Object.fromEntries(dockerBridge.listBackends().map((b) => [b.id, b]));
  assert.equal(byId.local.implemented, true);
  assert.equal(byId.docker.implemented, true);
  assert.equal(byId.ssh.implemented, true);
  assert.equal(byId.modal.implemented, false);
  assert.equal(byId.daytona.implemented, false);
  assert.equal(byId.vercel.implemented, false);
});
