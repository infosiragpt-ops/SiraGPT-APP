'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

const modulePath = path.resolve(__dirname, '../src/services/cowork/workspace-store.js');
const localRequire = createRequire(modulePath);
const id = 'abcdef0123456789';
const owner = 'synthetic-owner';
const bytes = Buffer.from('synthetic binary bytes\0\xff');

function fixture(t, { metadata = {}, legacy = false, absent = false, content = bytes, remoteRead, openLocal, workspaceOwner = owner } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-import-artifact-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactDir = path.join(dir, 'artifacts');
  fs.mkdirSync(artifactDir);
  const filename = 'fixture.bin';
  const binaryPath = path.join(artifactDir, `${id}-${filename}`);
  const meta = { id, filename, mime: 'application/x-fixture', ownerUserId: owner,
    ...(legacy ? {} : { storedRelPath: path.basename(binaryPath) }), ...metadata };
  fs.writeFileSync(path.join(artifactDir, `${id}.json`), JSON.stringify(meta));
  if (!absent) fs.writeFileSync(binaryPath, content);
  const calls = [];
  const created = [];
  const storage = {
    enabled: () => false,
    isRemote: ref => typeof ref === 'string' && ref.startsWith('r2:'),
    sanitizeSegment: value => value,
    async readStream(ref) {
      calls.push('remote');
      if (remoteRead) return remoteRead({ ref, binaryPath, calls });
      return { stream: Readable.from([bytes]) };
    },
  };
  const prisma = {
    coworkWorkspace: { async findFirst({ where }) {
      calls.push('owner');
      return where.id === 'workspace-a' ? { id: 'workspace-a', userId: workspaceOwner } : null;
    } },
    coworkFile: {
      async findUnique() { return null; },
      async create({ data }) { created.push(data); return { id: 'import-1', ...data }; },
    },
    async $transaction(callback) { return callback(prisma); },
  };
  const module = { exports: {} };
  const fsPromises = { ...fsp, async open(file, ...args) {
    if (String(file) === binaryPath) {
      calls.push('local');
      if (openLocal) return openLocal({ file, args, calls, binaryPath });
    }
    return fsp.open(file, ...args);
  } };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
    module, exports: module.exports,
    require: request => request === '../agents/task-tools' ? { ARTIFACT_DIR: artifactDir }
      : request === '../object-storage' ? storage
        : request === 'node:fs/promises' ? fsPromises : localRequire(request),
    process: { env: { SIRAGPT_COWORK_MAX_FILE_BYTES: '1024', COWORK_CONTENT_DIR: path.join(dir, 'content') }, cwd: () => dir },
    Buffer, console,
  }, { filename: modulePath });
  return { store: module.exports, prisma, dir, artifactDir, binaryPath, calls, created,
    run: (extra = {}) => module.exports.importAgentArtifact(prisma, { workspaceId: 'workspace-a', userId: owner, artifactId: id, ...extra }),
  };
}

async function assertImported(f, result, expected = bytes) {
  assert.equal(result.mime, 'application/x-fixture');
  assert.equal(result.artifactId, id);
  assert.equal(result.size, expected.length);
  assert.equal(result.contentHash, createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.path, 'deliverables/fixture.bin');
  assert.deepEqual(await fsp.readFile(result.storageRef), expected);
  assert.equal(f.created.length, 1);
}

test('imports the existing local artifact before trying a mirror reference', async t => {
  const f = fixture(t, { metadata: { storageRef: 'r2:fixture' } });
  await assertImported(f, await f.run());
  assert.equal(f.calls.filter(call => call === 'remote').length, 0);
  assert.ok(f.calls.includes('local'));
});

test('legacy artifacts without storedRelPath import through the existing local resolver', async t => {
  const f = fixture(t, { legacy: true });
  await assertImported(f, await f.run());
});

test('a local copy removed during offload falls back to the mirror once after ENOENT', async t => {
  const f = fixture(t, {
    metadata: { storageRef: 'r2:fixture' },
    async openLocal({ file, args }) { await fsp.unlink(file); return fsp.open(file, ...args); },
  });
  await assertImported(f, await f.run());
  assert.deepEqual(f.calls.filter(call => call === 'local' || call === 'remote'), ['local', 'remote']);
});

test('an already offloaded artifact reads the remote stream once', async t => {
  const f = fixture(t, { absent: true, metadata: { storageRef: 'r2:fixture' } });
  await assertImported(f, await f.run());
  assert.equal(f.calls.filter(call => call === 'remote').length, 1);
});

test('permission errors on existing local bytes do not fall back to the mirror', async t => {
  const f = fixture(t, {
    metadata: { storageRef: 'r2:fixture' },
    async openLocal() { const error = new Error('private path token-fixture'); error.code = 'EACCES'; throw error; },
  });
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable' && !/private|token-fixture/.test(error.message));
  assert.equal(f.calls.filter(call => call === 'remote').length, 0);
  assert.equal(f.created.length, 0);
});

test('a local artifact over the workspace size limit is rejected before reading its bytes', async t => {
  let streamCreated = false;
  const f = fixture(t, {
    content: Buffer.alloc(1025), metadata: { storageRef: 'r2:fixture' },
    async openLocal({ file, args }) {
      const handle = await fsp.open(file, ...args);
      return { stat: () => handle.stat(), close: () => handle.close(), createReadStream() { streamCreated = true; throw new Error('oversize stream must not open'); } };
    },
  });
  await assert.rejects(f.run(), error => error.code === 'workspace_file_too_large' && error.status === 413);
  assert.equal(streamCreated, false);
  assert.ok(!f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('growth after local stat is bounded and closes the file handle', async t => {
  let closed = false;
  const f = fixture(t, { async openLocal({ file, args }) {
    const handle = await fsp.open(file, ...args);
    return {
      async stat() { const stat = await handle.stat(); await fsp.appendFile(file, Buffer.alloc(2048)); return stat; },
      createReadStream(options) { assert.equal(options.end, 1024); return handle.createReadStream(options); },
      async close() { closed = true; await handle.close(); },
    };
  } });
  await assert.rejects(f.run(), error => error.code === 'workspace_file_too_large');
  assert.equal(closed, true);
  assert.equal(f.created.length, 0);
});

test('remote artifacts retain the same bounded size limit and destroy a rejected stream', async t => {
  const stream = Readable.from([Buffer.alloc(1025)]);
  const f = fixture(t, { absent: true, metadata: { storageRef: 'r2:fixture' }, async remoteRead() { return { stream }; } });
  await assert.rejects(f.run(), error => error.code === 'workspace_file_too_large');
  assert.equal(stream.destroyed, true);
  assert.equal(f.calls.filter(call => call === 'remote').length, 1);
  assert.equal(f.created.length, 0);
});

test('missing bytes remain a visible artifact_content_unavailable failure', async t => {
  const f = fixture(t, { absent: true });
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable');
  assert.equal(f.created.length, 0);
});

test('remote failures are surfaced without retries or raw storage error data', async t => {
  const f = fixture(t, { absent: true, metadata: { storageRef: 'r2:fixture' }, async remoteRead() { throw new Error('Bearer fixture-secret private-object'); } });
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable' && !/Bearer|fixture-secret|private-object/.test(error.message));
  assert.equal(f.calls.filter(call => call === 'remote').length, 1);
  assert.equal(f.created.length, 0);
});

test('wrong artifact owner cannot read or import the bytes', async t => {
  const f = fixture(t, { metadata: { ownerUserId: 'other-owner', storageRef: 'r2:fixture' } });
  await assert.rejects(f.run(), error => error.code === 'artifact_not_found');
  assert.ok(!f.calls.includes('local') && !f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('wrong workspace owner is rejected before reading binary content', async t => {
  const f = fixture(t, { workspaceOwner: 'other-owner', metadata: { storageRef: 'r2:fixture' } });
  await assert.rejects(f.run(), error => error.code === 'workspace_not_found');
  assert.ok(!f.calls.includes('local') && !f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('a storageRef outside the artifact store cannot substitute an arbitrary local file', async t => {
  const f = fixture(t, { absent: true });
  const outside = path.join(f.dir, 'untrusted.bin');
  fs.writeFileSync(outside, bytes);
  fs.writeFileSync(path.join(f.artifactDir, `${id}.json`), JSON.stringify({
    id, ownerUserId: owner, filename: 'fixture.bin', mime: 'application/x-fixture', storageRef: outside,
  }));
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable');
  assert.ok(!f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('a storedRelPath escaping the artifact root cannot cause a remote fallback', async t => {
  const f = fixture(t, { metadata: { storedRelPath: '../outside.bin', storageRef: 'r2:fixture' } });
  fs.writeFileSync(path.join(f.dir, 'outside.bin'), bytes);
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable');
  assert.ok(!f.calls.includes('local') && !f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('legacy symlinks escaping the artifact root are rejected without remote access', async t => {
  const f = fixture(t, { absent: true, legacy: true, metadata: { storageRef: 'r2:fixture' } });
  const outside = path.join(f.dir, 'outside.bin');
  fs.writeFileSync(outside, bytes);
  fs.symlinkSync(outside, f.binaryPath);
  await assert.rejects(f.run(), error => error.code === 'artifact_content_unavailable');
  assert.ok(!f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('target path traversal is rejected before binary reads and before persistence', async t => {
  const f = fixture(t, { metadata: { storageRef: 'r2:fixture' } });
  await assert.rejects(f.run({ targetPath: '../outside.bin' }), error => error.code === 'workspace_path_invalid');
  assert.ok(!f.calls.includes('local') && !f.calls.includes('remote'));
  assert.equal(f.created.length, 0);
});

test('Stop during remote reading prevents content persistence after the read resolves', async t => {
  let entered, release;
  const reading = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { absent: true, metadata: { storageRef: 'r2:fixture' }, async remoteRead() {
    entered(); await waiting; return { stream: Readable.from([bytes]) };
  } });
  const controller = new AbortController();
  const pending = f.run({ signal: controller.signal });
  await reading;
  controller.abort();
  release();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.created.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'content')), false);
});
