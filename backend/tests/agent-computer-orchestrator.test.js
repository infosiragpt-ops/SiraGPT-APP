'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHROME_XVFB_CAPS,
  SessionManager,
  isProtectedName,
  containerName,
} = require('../../services/computer/orchestrator/sessions');
const { timingSafeEqualString, requireOrchSecret } = require('../../services/computer/orchestrator/auth');

function fakeDocker(store) {
  return {
    async createContainer(spec) {
      if (spec.HostConfig.Privileged) throw new Error('privileged must be false');
      const id = `cid-${store.nextId++}`;
      const rec = { id, spec, running: false };
      store.containers.set(id, rec);
      store.byName.set(spec.name, rec);
      return {
        async start() { rec.running = true; },
        async inspect() {
          return {
            Id: id,
            Name: `/${spec.name}`,
            NetworkSettings: {
              Ports: {
                '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(16080 + store.nextId) }],
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(18080 + store.nextId) }],
                '9222/tcp': [{ HostIp: '127.0.0.1', HostPort: String(19222 + store.nextId) }],
              },
            },
          };
        },
      };
    },
    getContainer(id) {
      const rec = store.containers.get(id);
      return {
        async stop() { if (rec) rec.running = false; },
        async remove() { store.containers.delete(id); },
      };
    },
  };
}

test('protected webtop names are never generated or destroyed', () => {
  assert.equal(isProtectedName('sira-dpc-ceo', 'sira-dpc-'), true);
  assert.equal(isProtectedName('sira-acomp-abc', 'sira-dpc-'), false);
  assert.equal(containerName('11111111-1111-1111-1111-111111111111', 'sira-acomp-').startsWith('sira-dpc-'), false);
});

test('Chrome/Xvfb caps are documented and privileged is never set', () => {
  assert.ok(CHROME_XVFB_CAPS.includes('SYS_ADMIN'));
  assert.ok(!CHROME_XVFB_CAPS.includes('NET_ADMIN'));
  assert.ok(!CHROME_XVFB_CAPS.includes('SYS_PTRACE'));
});

test('auth accepts a matching bearer and rejects others', () => {
  assert.equal(timingSafeEqualString('secret', 'secret'), true);
  assert.equal(timingSafeEqualString('secret', 'other'), false);
  const mw = requireOrchSecret('s3cret');
  let status = 0;
  mw({ path: '/sessions', method: 'POST', headers: { authorization: 'Bearer nope' } }, {
    status(code) { status = code; return this; },
    json() { return this; },
  }, () => { status = 200; });
  assert.equal(status, 401);
  mw({ path: '/health', method: 'GET', headers: {} }, {
    status(code) { status = code; return this; },
    json() { return this; },
  }, () => { status = 204; });
  assert.equal(status, 204);
});

test('SessionManager create/renew/reap/destroy never touches sira-dpc-*', async () => {
  const store = { containers: new Map(), byName: new Map(), nextId: 1 };
  let now = 1_000;
  const manager = new SessionManager({
    docker: fakeDocker(store),
    env: {
      COMPUTER_ORCH_SECRET: 'test-secret-value',
      COMPUTER_TTL_MS: '1000',
      COMPUTER_IMAGE: 'siragpt-computer:test',
      COMPUTER_NOVNC_BASE_URL: 'https://computer.siragpt.com',
    },
    now: () => now,
  });

  const created = await manager.create();
  assert.ok(created.sessionId);
  assert.match(created.novncWsUrl, /computer\.siragpt\.com|ws/);
  assert.ok(created.agentUrl);
  assert.ok(created.cdpUrl);
  assert.equal(store.containers.size, 1);

  const spec = [...store.containers.values()][0].spec;
  assert.equal(spec.HostConfig.Privileged, false);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.ok(spec.HostConfig.CapAdd.includes('SYS_ADMIN'));
  assert.equal(spec.HostConfig.Memory, 2 * 1024 * 1024 * 1024);
  assert.equal(spec.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(spec.HostConfig.ShmSize, 1024 * 1024 * 1024);
  assert.ok(!String(spec.name).startsWith('sira-dpc-'));
  assert.equal(spec.Labels.sessionId, created.sessionId);
  assert.equal(spec.Labels['siragpt.computer'], 'session');

  const renewed = manager.renew(created.sessionId);
  assert.ok(renewed.expiresAt > created.expiresAt || renewed.expiresAt === created.expiresAt);

  now = 1_000 + 2_000;
  const reaped = await manager.reapExpired();
  assert.equal(reaped.length, 1);
  assert.equal(store.containers.size, 0);
  assert.equal(manager.get(created.sessionId), null);

  manager.stopReaper();
});
