'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHROME_XVFB_CAPS,
  SessionManager,
  isProtectedName,
  containerName,
} = require('../../services/computer/orchestrator/sessions');
const {
  sessionIdForUser,
  containerNameForUser,
  volumeNameForUser,
  normalizeUserId,
  UserIdError,
} = require('../../services/computer/orchestrator/identity');
const { timingSafeEqualString, requireOrchSecret } = require('../../services/computer/orchestrator/auth');

function fakeDocker(store) {
  store.volumes = store.volumes || new Map();
  return {
    async createVolume(spec) {
      if (store.volumes.has(spec.Name)) {
        const err = new Error('volume already exists');
        err.statusCode = 409;
        throw err;
      }
      store.volumes.set(spec.Name, spec);
      return spec;
    },
    getVolume(name) {
      return {
        async remove() { store.volumes.delete(name); },
      };
    },
    async createContainer(spec) {
      if (spec.HostConfig.Privileged) throw new Error('privileged must be false');
      if (store.byName.has(spec.name)) {
        const err = new Error('Conflict. The container name is already in use');
        err.statusCode = 409;
        throw err;
      }
      const id = `cid-${store.nextId++}`;
      const rec = {
        id,
        spec,
        running: false,
        ports: {
          '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(16080 + store.nextId) }],
          '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(18080 + store.nextId) }],
          '9222/tcp': [{ HostIp: '127.0.0.1', HostPort: String(19222 + store.nextId) }],
        },
      };
      store.containers.set(id, rec);
      store.byName.set(spec.name, rec);
      return {
        async start() { rec.running = true; },
        async inspect() {
          return {
            Id: id,
            Name: `/${spec.name}`,
            State: { Running: rec.running },
            NetworkSettings: { Ports: rec.ports },
          };
        },
      };
    },
    getContainer(idOrName) {
      const rec = store.containers.get(idOrName) || store.byName.get(idOrName);
      if (!rec) {
        const missing = async () => {
          const err = new Error('no such container');
          err.statusCode = 404;
          throw err;
        };
        return { inspect: missing, start: missing, stop: async () => {}, remove: async () => {} };
      }
      return {
        async start() { rec.running = true; },
        async stop() { rec.running = false; },
        async remove() {
          store.containers.delete(rec.id);
          store.byName.delete(rec.spec.name);
        },
        async inspect() {
          return {
            Id: rec.id,
            Name: `/${rec.spec.name}`,
            State: { Running: rec.running },
            Config: { Labels: rec.spec.Labels },
            NetworkSettings: { Ports: rec.ports },
            HostConfig: rec.spec.HostConfig,
          };
        },
      };
    },
  };
}

function managerFor(store, extraEnv = {}, nowFn) {
  let now = 1_000;
  return new SessionManager({
    docker: fakeDocker(store),
    env: {
      COMPUTER_ORCH_SECRET: 'test-secret-value',
      COMPUTER_IMAGE: 'siragpt-computer:test',
      COMPUTER_NOVNC_BASE_URL: 'https://computer.siragpt.com',
      ...extraEnv,
    },
    now: nowFn || (() => now),
  });
}

test('protected webtop names are never generated or destroyed', () => {
  assert.equal(isProtectedName('sira-dpc-ceo', 'sira-dpc-'), true);
  assert.equal(isProtectedName('sira-acomp-uabc', 'sira-dpc-'), false);
  assert.equal(containerName('11111111-1111-1111-1111-111111111111', 'sira-acomp-').startsWith('sira-dpc-'), false);
  const name = containerNameForUser('user-42', 'sira-acomp-');
  assert.ok(name.startsWith('sira-acomp-u'));
  assert.equal(name.startsWith('sira-dpc-'), false);
});

test('per-user identity is deterministic and rejects unsafe ids', () => {
  const a = sessionIdForUser('user-42');
  const b = sessionIdForUser('user-42');
  const c = sessionIdForUser('user-99');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(volumeNameForUser('user-42'), `sira-acomp-ws-${require('../../services/computer/orchestrator/identity').hashUser('user-42')}`);
  assert.equal(normalizeUserId('  abc  '), 'abc');
  assert.throws(() => normalizeUserId('../etc'), UserIdError);
  assert.throws(() => normalizeUserId(''), UserIdError);
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

test('one persistent desktop per member; departments are not a key', async () => {
  const store = { containers: new Map(), byName: new Map(), nextId: 1 };
  const manager = managerFor(store);

  const first = await manager.ensure({ userId: 'member-a' });
  const again = await manager.ensure({ userId: 'member-a' });
  const otherDept = await manager.ensure({ userId: 'member-a', department: 'sales' });
  const otherUser = await manager.ensure({ userId: 'member-b' });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(first.sessionId, again.sessionId);
  assert.equal(first.sessionId, otherDept.sessionId);
  assert.notEqual(first.sessionId, otherUser.sessionId);
  assert.equal(store.containers.size, 2);
  assert.equal(first.persistent, true);
  assert.equal(first.sharedBy, 'member-department-agents');
  assert.equal(first.workspaceRoot, '/workspace');
  assert.ok(first.volumeName.startsWith('sira-acomp-ws-'));
  assert.match(first.novncWsUrl, /computer\.siragpt\.com|wss?:/);
  assert.equal(first.idleReclaim, false);
  assert.equal(first.expiresAt, null);

  const spec = [...store.containers.values()][0].spec;
  assert.equal(spec.HostConfig.Privileged, false);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.ok(spec.HostConfig.CapAdd.includes('SYS_ADMIN'));
  assert.equal(spec.HostConfig.Memory, 2 * 1024 * 1024 * 1024);
  assert.ok(!String(spec.name).startsWith('sira-dpc-'));
  assert.equal(spec.Labels.userId, 'member-a');
  assert.equal(spec.Labels['siragpt.computer'], 'user-desktop');
  assert.equal(spec.HostConfig.Mounts[0].Target, '/workspace');

  manager.stopReaper();
});

test('idle reclaim is opt-in and never touches sira-dpc-*', async () => {
  const store = { containers: new Map(), byName: new Map(), nextId: 1 };
  let now = 1_000;
  const manager = new SessionManager({
    docker: fakeDocker(store),
    env: {
      COMPUTER_ORCH_SECRET: 'test-secret-value',
      COMPUTER_TTL_MS: '1000',
      COMPUTER_IDLE_RECLAIM: '1',
      COMPUTER_IMAGE: 'siragpt-computer:test',
      COMPUTER_NOVNC_BASE_URL: 'https://computer.siragpt.com',
    },
    now: () => now,
  });

  const created = await manager.create({ userId: 'reap-user' });
  assert.equal(store.containers.size, 1);
  assert.ok(created.expiresAt);

  const volumeName = created.volumeName;
  assert.ok(store.volumes.has(volumeName));

  now = 1_000 + 2_000;
  const reaped = await manager.reapExpired();
  assert.equal(reaped.length, 1);
  assert.equal(store.containers.size, 0);
  assert.equal(manager.get(created.sessionId), null);
  // Persistent workspace survives idle reclaim.
  assert.equal(store.volumes.has(volumeName), true);

  const persistStore = { containers: new Map(), byName: new Map(), nextId: 1 };
  const persistent = managerFor(persistStore);
  await persistent.ensure({ userId: 'keep-user' });
  now = 9_999_999;
  const skipped = await persistent.reapExpired();
  assert.equal(skipped.length, 0);
  assert.equal(persistStore.containers.size, 1);

  manager.stopReaper();
  persistent.stopReaper();
});

test('adopt existing container after orchestrator restart', async () => {
  const store = { containers: new Map(), byName: new Map(), nextId: 1 };
  const first = managerFor(store);
  const created = await first.ensure({ userId: 'sticky-user' });
  first.stopReaper();

  const restarted = managerFor(store);
  const adopted = await restarted.ensure({ userId: 'sticky-user' });
  assert.equal(adopted.created, false);
  assert.equal(adopted.sessionId, created.sessionId);
  assert.equal(store.containers.size, 1);
  restarted.stopReaper();
});
