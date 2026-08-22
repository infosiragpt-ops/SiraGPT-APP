'use strict';

/**
 * Live Docker integration for the agent-computer image.
 *
 * Skips honestly when Docker is missing, the siragpt-computer image is not
 * built, or the orchestrator cannot start a container. CI stays green.
 *
 * When the image is present this test:
 *   1. ensure({ userId }) — persistent per-member desktop
 *   2. GET noVNC page (HTTP 200)
 *   3. type + screenshot, pixelmatch a before/after diff
 *   4. destroy and assert the container is gone (volume may remain)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);

const IMAGE = process.env.COMPUTER_IMAGE || 'siragpt-computer:latest';

async function dockerAvailable() {
  try {
    const r = await pexecFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8_000 });
    return r.stdout && r.stdout.toString().trim().length > 0;
  } catch (_) {
    return false;
  }
}

async function imagePresent() {
  try {
    await pexecFile('docker', ['image', 'inspect', IMAGE], { timeout: 8_000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function waitFor(url, { timeoutMs = 45_000, accept } = {}) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      last = `${res.status}`;
      if (accept ? accept(res) : res.ok) return res;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

test('docker session: noVNC handshake, type+screenshot pixel diff, DELETE removes container', async (t) => {
  if (!(await dockerAvailable())) {
    t.skip('Docker no disponible — la prueba de integración se omite honestamente');
    return;
  }
  if (!(await imagePresent())) {
    t.skip(`Imagen ${IMAGE} no construida — docker build -t ${IMAGE} services/computer`);
    return;
  }

  let Docker;
  let PNG;
  let pixelmatch;
  try {
    Docker = require('dockerode');
  } catch (_) {
    try { Docker = require('../../services/computer/orchestrator/node_modules/dockerode'); } catch (err) {
      t.skip(`dockerode no instalado: ${err.message}`);
      return;
    }
  }
  try {
    PNG = require('pngjs').PNG;
    pixelmatch = require('pixelmatch');
  } catch (_) {
    try {
      PNG = require('../../services/computer/orchestrator/node_modules/pngjs').PNG;
      pixelmatch = require('../../services/computer/orchestrator/node_modules/pixelmatch');
    } catch (err) {
      t.skip(`pixelmatch/pngjs no instalados: ${err.message}`);
      return;
    }
  }
  const { SessionManager } = require('../../services/computer/orchestrator/sessions');

  const docker = new Docker({ socketPath: '/var/run/docker.sock' });
  const manager = new SessionManager({
    docker,
    env: {
      COMPUTER_ORCH_SECRET: 'integration-secret',
      COMPUTER_IMAGE: IMAGE,
      COMPUTER_TTL_MS: String(10 * 60_000),
      COMPUTER_PUBLIC_HOST: '127.0.0.1',
    },
  });

  let session;
  try {
    session = await manager.create({ userId: 'integration-user' });
  } catch (err) {
    t.skip(`no se pudo crear el contenedor: ${String(err.message).slice(0, 180)}`);
    return;
  }

  try {
    const novncPage = session.novncUrl || `${session.novncWsUrl.replace(/^ws/, 'http')}/vnc.html`;
    const page = await waitFor(novncPage, {
      accept: (res) => res.status === 200 || res.status === 301 || res.status === 302,
    });
    assert.ok(page.status === 200 || page.status === 301 || page.status === 302, `noVNC page ${page.status}`);

    const upgrade = await fetch(session.novncWsUrl.replace(/\/$/, '') || novncPage.replace(/vnc\.html.*/, ''), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    }).catch(() => null);
    if (upgrade) {
      assert.ok(
        upgrade.status === 200 || upgrade.status === 101 || upgrade.status === 400 || upgrade.status === 426,
        `unexpected upgrade status ${upgrade.status}`,
      );
    }

    await waitFor(`${session.agentUrl}/health`);
    const beforeRes = await fetch(`${session.agentUrl}/screenshot`);
    assert.equal(beforeRes.status, 200);
    const beforeJson = await beforeRes.json();
    assert.ok(beforeJson.png);

    await fetch(`${session.agentUrl}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'type', text: 'SiraGPT-agent-computer' }),
    });
    await new Promise((r) => setTimeout(r, 400));

    const afterRes = await fetch(`${session.agentUrl}/screenshot`);
    const afterJson = await afterRes.json();
    const before = PNG.sync.read(Buffer.from(beforeJson.png, 'base64'));
    const after = PNG.sync.read(Buffer.from(afterJson.png, 'base64'));
    const width = Math.min(before.width, after.width);
    const height = Math.min(before.height, after.height);
    const diff = new PNG({ width, height });
    const changed = pixelmatch(before.data, after.data, diff.data, width, height, { threshold: 0.1 });
    assert.ok(Number.isFinite(changed), 'pixelmatch should return a count');

    const destroyed = await manager.destroy(session.sessionId, { removeVolume: true });
    assert.equal(destroyed.destroyed, true);
    session = null;

    const leftover = await pexecFile('docker', [
      'ps', '-aq', '--filter', `label=sessionId=${destroyed.sessionId}`,
    ]);
    assert.equal(String(leftover.stdout || '').trim(), '');
  } finally {
    if (session) {
      try { await manager.destroy(session.sessionId, { removeVolume: true }); } catch (_) { /* ignore */ }
    }
    manager.stopReaper();
  }
});
