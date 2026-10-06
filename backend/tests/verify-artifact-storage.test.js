'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');

const modulePath = path.resolve(__dirname, '../src/services/agents/task-tools.js');
const localRequire = createRequire(modulePath);
const sandbox = localRequire('./code-sandbox');
const id = 'abcdef0123456789';
const bytes = Buffer.from('id,valor\n1,10\n2,20\n');

function fixture(t, { local = false, metadata = {}, readStream, run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-verify-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = 'registros.csv';
  const storedRelPath = `group/${id}-${filename}`;
  const meta = { id, filename, format: 'csv', ownerUserId: 'owner-a', chatId: 'chat-a',
    sizeBytes: bytes.length, storedRelPath, storageRef: `r2:agent-artifacts/${storedRelPath}`,
    validation: { passed: true }, ...metadata };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta));
  if (local) {
    fs.mkdirSync(path.join(dir, 'group'));
    fs.writeFileSync(path.join(dir, storedRelPath), bytes);
  }
  const calls = [];
  const inspectedPaths = [];
  const tempDirs = [];
  const objectStorage = {
    isRemote: ref => String(ref).startsWith('r2:'),
    async readStream(ref) {
      calls.push(ref);
      return readStream ? readStream(ref) : { stream: Readable.from([bytes]), contentLength: bytes.length };
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(modulePath),
    require: request => request === 'fs' ? { ...fs, promises: { ...fs.promises,
      async mkdtemp(...args) { const temp = await fs.promises.mkdtemp(...args); tempDirs.push(temp); return temp; },
    } } : request === '../object-storage' ? objectStorage
      : request === './code-sandbox' ? { ...sandbox, async run(options) {
        const match = /\npath = (.+)\n/.exec(options.source);
        if (match) inspectedPaths.push(JSON.parse(match[1]));
        return run ? run(options) : sandbox.run(options);
      } } : localRequire(request),
    process: { env: { AGENT_ARTIFACT_DIR: dir }, cwd: () => dir },
    Buffer, console, AbortSignal, setTimeout, clearTimeout,
  }, { filename: modulePath });
  return { dir, meta, calls, inspectedPaths, tempDirs, tools: mod.exports,
    verify: (ctx = {}, args = { artifactId: id }) => mod.exports.INTERNAL.verifyArtifact.execute(args, {
      userId: 'owner-a', chatId: 'chat-a', ...ctx,
    }) };
}

test('verify_artifact rereads an offloaded CSV through the canonical materializer', async t => {
  const f = fixture(t);
  const result = await f.verify();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.artifactId, id);
  assert.equal(result.filename, 'registros.csv');
  assert.equal(result.ext, 'csv');
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.lineCount, 3);
  assert.deepEqual(Array.from(result.columns), ['id', 'valor']);
  assert.equal(result.firstDataRow, '1,10');
  assert.equal(f.calls.length, 1);
  assert.equal(f.inspectedPaths.length, 1);
  assert.equal(fs.existsSync(f.inspectedPaths[0]), false, 'hydrated bytes must be removed');
  assert.equal(fs.existsSync(path.join(f.dir, `${id}.json`)), true);
});

function assertCleaned(f) {
  for (const dir of f.tempDirs) assert.equal(fs.existsSync(dir), false, 'temporary artifact directory must be removed');
}

test('verify_artifact retains local grouped-file precedence and canonical artifactId', async t => {
  const f = fixture(t, { local: true });
  const result = await f.verify();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.filename, 'registros.csv');
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.inspectedPaths[0]), true, 'local source remains owned by artifact storage');
  const wrongArgument = await f.verify({}, { id });
  assert.equal(wrongArgument.ok, false);
  assert.equal(wrongArgument.error, 'invalid artifact id');
});

test('verify_artifact cannot hydrate another owner or ownerless metadata', async t => {
  for (const ownerUserId of ['owner-b', null]) {
    const f = fixture(t, { metadata: { ownerUserId } });
    const result = await f.verify();
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.inspectedPaths.length, 0);
  }
  const f = fixture(t);
  assert.equal((await f.verify({ userId: undefined })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('remote read errors stay structured and do not disclose storage internals', async t => {
  const f = fixture(t, { readStream: async () => { throw new Error('private-storage-location?secret=do-not-disclose'); } });
  const result = await f.verify();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARTIFACT_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private-storage|secret|do-not-disclose/);
  assert.equal(f.calls.length, 1);
  assertCleaned(f);
});

test('a storage reference cannot hydrate an arbitrary local path', async t => {
  const f = fixture(t, { metadata: { storageRef: '/private/fixture-not-an-artifact' } });
  assert.equal((await f.verify()).code, 'ARTIFACT_READ_FAILED');
  assert.equal(f.calls.length, 0);
});

test('declared oversized remote and local artifacts fail before verification', async t => {
  const remote = fixture(t, { metadata: { sizeBytes: 100 * 1024 * 1024 + 1 } });
  assert.equal((await remote.verify()).code, 'ARTIFACT_SIZE_LIMIT');
  assert.equal(remote.calls.length, 0);
  const local = fixture(t, { local: true });
  fs.truncateSync(path.join(local.dir, local.meta.storedRelPath), 100 * 1024 * 1024 + 1);
  assert.equal((await local.verify()).code, 'ARTIFACT_SIZE_LIMIT');
  assert.equal(local.inspectedPaths.length, 0);
});

test('remote content length is checked before creating a temporary file', async t => {
  const stream = Readable.from([bytes]);
  const f = fixture(t, { readStream: async () => ({ stream, contentLength: 100 * 1024 * 1024 + 1 }) });
  assert.equal((await f.verify()).code, 'ARTIFACT_SIZE_LIMIT');
  assert.equal(stream.destroyed, true);
  assert.equal(f.tempDirs.length, 0);
});

test('unknown-length remote streams are bounded by bytes actually received', async t => {
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  const stream = Readable.from((async function* () {
    for (let i = 0; i < 101; i++) yield chunk;
  })());
  const f = fixture(t, { readStream: async () => ({ stream }) });
  const result = await f.verify();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARTIFACT_SIZE_LIMIT');
  assert.equal(stream.destroyed, true);
  assert.equal(f.inspectedPaths.length, 0);
  assert.equal(f.tempDirs.length, 1);
  assertCleaned(f);
});

test('a stream failing after partial bytes removes its temporary file', async t => {
  const stream = Readable.from((async function* () { yield bytes; throw new Error('private read failed'); })());
  const f = fixture(t, { readStream: async () => ({ stream }) });
  assert.equal((await f.verify()).code, 'ARTIFACT_READ_FAILED');
  assert.equal(stream.destroyed, true);
  assertCleaned(f);
});

test('a verifier exception still removes hydrated bytes', async t => {
  const f = fixture(t, { run: async () => { throw new Error('private verifier path'); } });
  assert.equal((await f.verify()).code, 'ARTIFACT_READ_FAILED');
  assert.equal(f.inspectedPaths.length, 1);
  assertCleaned(f);
});

test('already-cancelled verification does not request remote bytes', async t => {
  const f = fixture(t);
  assert.equal((await f.verify({ signal: AbortSignal.abort() })).code, 'ARTIFACT_READ_CANCELLED');
  assert.equal(f.calls.length, 0);
  assertCleaned(f);
});

test('cancellation while awaiting headers closes a late remote response', async t => {
  const controller = new AbortController();
  let release;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { readStream: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const pending = f.verify({ signal: controller.signal });
  await requested;
  controller.abort();
  assert.equal((await pending).code, 'ARTIFACT_READ_CANCELLED');
  const stream = Readable.from([bytes]);
  release({ stream });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
  assertCleaned(f);
});
