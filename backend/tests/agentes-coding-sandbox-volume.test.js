'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createCodingSandbox,
  CodingSandboxError,
  resolveDriverName,
  driverPersistsFiles,
} = require('../src/services/agentes-coding/coding-sandbox');
const {
  createMapFs,
  createSessionVolume,
  resolveDataDir,
  sanitizeSessionId,
} = require('../src/services/agentes-coding/coding-sandbox/volume');
const { assertSafeBindMount, buildDockerRunArgs } = require('../src/services/agentes-coding/coding-sandbox/docker-local');
const { resolveLimits, dockerLimitArgs } = require('../src/services/agentes-coding/coding-sandbox/limits');

const ON = { AGENTES_CODING_V2: '1' };
const DATA_DIR = '/agentes-coding-data';

function stubDocker() {
  return {
    async exec(args) {
      if (args[0] === 'run' || args[0] === 'rm' || args[0] === 'exec') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function make(extra = {}) {
  const fs = extra.fs || createMapFs();
  return {
    fs,
    sb: createCodingSandbox({
      env: { ...ON, ...(extra.env || {}) },
      autoGc: false,
      now: extra.now,
      driver: extra.driver || 'volume',
      docker: extra.docker || stubDocker(),
      fs,
      dataDir: extra.dataDir || DATA_DIR,
    }),
  };
}

function expectCode(fn, code) {
  return fn().then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (err) => {
      assert.ok(err instanceof CodingSandboxError, err && err.stack);
      assert.equal(err.code, code);
    },
  );
}

test('volume aliases resolve and persist files; memory does not', () => {
  assert.equal(resolveDriverName({}, 'disk'), 'volume');
  assert.equal(driverPersistsFiles('volume'), true);
  assert.equal(driverPersistsFiles('docker'), true);
  assert.equal(driverPersistsFiles('memory'), false);
});

test('volume driver write survives a new adapter instance (restart)', async () => {
  const fs = createMapFs();
  const first = make({ fs, driver: 'volume' });
  const session = await first.sb.createSession({ id: 'csb_volrestart', userId: 'u1' });
  await first.sb.writeFile(session.id, 'src/app.ts', 'export const n = 1;\n');

  const second = make({ fs, driver: 'volume' });
  const buf = await second.sb.readFile('csb_volrestart', 'src/app.ts');
  assert.equal(buf.toString('utf8'), 'export const n = 1;\n');
  const listed = await second.sb.listFiles('csb_volrestart');
  assert.deepEqual(listed.map((f) => f.path), ['src/app.ts']);
  const live = second.sb.getSession('csb_volrestart');
  assert.equal(live.userId, 'u1');
  assert.equal(live.driver, 'volume');
});

test('docker driver write survives restart via bind-mounted volume', async () => {
  const fs = createMapFs();
  const first = make({ fs, driver: 'docker' });
  const session = await first.sb.createSession({ id: 'csb_dockrestart', userId: 'u2' });
  await first.sb.writeFile(session.id, 'hello.txt', 'hola-durable');

  const second = make({ fs, driver: 'docker' });
  const buf = await second.sb.readFile('csb_dockrestart', 'hello.txt');
  assert.equal(buf.toString('utf8'), 'hola-durable');
  const reattached = await second.sb.recreateSession({ id: 'csb_dockrestart', userId: 'u2' });
  assert.equal(reattached.id, 'csb_dockrestart');
  assert.ok(reattached.containerName.startsWith('sira-csb-'));
});

test('memory driver stays ephemeral across adapter instances', async () => {
  const first = createCodingSandbox({ env: ON, autoGc: false, driver: 'memory' });
  const session = await first.createSession({ id: 'csb_memonly' });
  await first.writeFile(session.id, 'gone.txt', 'temp');

  const second = createCodingSandbox({ env: ON, autoGc: false, driver: 'memory' });
  await expectCode(() => second.readFile('csb_memonly', 'gone.txt'), 'E_SESSION_NOT_FOUND');
  assert.equal(second.getSession('csb_memonly'), null);
});

test('destroy removes the persisted volume', async () => {
  const fs = createMapFs();
  const first = make({ fs, driver: 'volume' });
  const session = await first.sb.createSession({ id: 'csb_dropme' });
  await first.sb.writeFile(session.id, 'a.txt', 'x');
  await first.sb.destroy(session.id);

  const second = make({ fs, driver: 'volume' });
  await expectCode(() => second.sb.readFile('csb_dropme', 'a.txt'), 'E_SESSION_NOT_FOUND');
  const volume = createSessionVolume({ fs, dataDir: DATA_DIR });
  assert.equal(volume.exists('csb_dropme'), false);
});

test('path escape is still denied on the volume driver', async () => {
  const { sb } = make({ driver: 'volume' });
  const session = await sb.createSession();
  await expectCode(() => sb.readFile(session.id, '../etc/passwd'), 'E_PATH_ESCAPE');
  await expectCode(() => sb.writeFile(session.id, '/etc/passwd', 'x'), 'E_PATH_ESCAPE');
  await expectCode(() => sb.writeFile(session.id, 'foo\\bar', 'x'), 'E_PATH_ESCAPE');
  assert.throws(() => sanitizeSessionId('../etc'), (e) => e.code === 'E_PATH_ESCAPE');
});

test('flag off is unchanged for volume and docker', async () => {
  const fs = createMapFs();
  const off = createCodingSandbox({
    env: {},
    autoGc: false,
    driver: 'volume',
    fs,
    dataDir: DATA_DIR,
  });
  await expectCode(() => off.createSession(), 'E_FLAG_OFF');
  await expectCode(() => off.recreateSession({ id: 'csb_x' }), 'E_FLAG_OFF');
  const dockerOff = createCodingSandbox({
    env: { AGENTES_CODING_V2: '0' },
    autoGc: false,
    driver: 'docker',
    docker: stubDocker(),
    fs,
    dataDir: DATA_DIR,
  });
  await expectCode(() => dockerOff.createSession(), 'E_FLAG_OFF');
});

test('volume file-count and byte caps are E_QUOTA', async () => {
  const { sb } = make({
    driver: 'volume',
    env: {
      AGENTES_CODING_SANDBOX_MAX_VOLUME_FILES: '1',
      AGENTES_CODING_SANDBOX_MAX_VOLUME_BYTES: '8',
    },
  });
  const session = await sb.createSession();
  await sb.writeFile(session.id, 'one.txt', '1234');
  await expectCode(() => sb.writeFile(session.id, 'two.txt', 'x'), 'E_QUOTA');
});

test('docker run argv bind-mounts the session workspace and stays jailed', () => {
  const limits = resolveLimits({}, ON);
  const hostWs = path.join(DATA_DIR, 'csb_bind', 'workspace');
  const args = buildDockerRunArgs({
    name: 'sira-csb-csb_bind',
    image: 'siragpt-coding-sandbox:dev',
    limits,
    networkArgs: ['--network', 'none'],
    workspaceBind: hostWs,
  });
  assert.ok(args.includes('-v'));
  assert.ok(args.includes(`${hostWs}:/workspace:rw`));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.includes('--privileged'));
  const tmpfsOnly = dockerLimitArgs(limits);
  assert.ok(tmpfsOnly.includes('--tmpfs'));
  assert.throws(
    () => assertSafeBindMount('/etc/passwd', DATA_DIR),
    (e) => e.code === 'E_NETWORK_DENIED',
  );
  assert.throws(
    () => assertSafeBindMount(path.join(DATA_DIR, '..', 'escape'), DATA_DIR),
    (e) => e.code === 'E_NETWORK_DENIED',
  );
});

test('createSession with the same id after restart reattaches instead of wiping files', async () => {
  const fs = createMapFs();
  const first = make({ fs, driver: 'volume' });
  await first.sb.createSession({ id: 'csb_same', userId: 'owner' });
  await first.sb.writeFile('csb_same', 'keep.md', '# stay');

  const second = make({ fs, driver: 'volume' });
  const session = await second.sb.createSession({ id: 'csb_same', userId: 'owner' });
  assert.equal(session.id, 'csb_same');
  const buf = await second.sb.readFile('csb_same', 'keep.md');
  assert.equal(buf.toString('utf8'), '# stay');
});

test('default data dir is under tmp and rejects system roots', () => {
  const resolved = resolveDataDir({});
  assert.match(resolved, /siragpt-agentes-coding/);
  assert.throws(() => resolveDataDir({ AGENTES_CODING_SANDBOX_DATA_DIR: '/etc' }), (e) => e.code === 'E_PARAMS');
  assert.throws(() => resolveDataDir({ AGENTES_CODING_SANDBOX_DATA_DIR: '/' }), (e) => e.code === 'E_PARAMS');
});
