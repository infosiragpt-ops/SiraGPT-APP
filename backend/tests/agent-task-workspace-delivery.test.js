'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

const source = path.resolve(__dirname, '../src/services/agents/agent-task-workspace-delivery.js');
const storeSource = path.resolve(__dirname, '../src/services/cowork/workspace-store.js');
const req = createRequire(source);
const csv = Buffer.from('id,product,units\n' + Array.from({ length: 12 }, (_, i) => `${i + 1},test_product_${i + 1},${i + 1}\n`).join(''));
const id = 'abcdef0123456789';
const secondId = '0123456789abcdef';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, { chatOwner = 'user-a', artifactOwner = 'user-a', filename = 'qa.csv', failCreate = false, storeWrap } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactDir = path.join(dir, 'artifacts');
  fs.mkdirSync(artifactDir);
  for (const [artifactId, name] of [[id, filename], [secondId, 'second.csv']]) {
    const rel = `${artifactId}.csv`;
    fs.writeFileSync(path.join(artifactDir, rel), csv);
    fs.writeFileSync(path.join(artifactDir, `${artifactId}.json`), JSON.stringify({ id: artifactId, filename: name,
      ownerUserId: artifactOwner, mime: 'text/csv', sizeBytes: csv.length, storedRelPath: rel }));
  }
  const events = [], queries = [], rows = new Map();
  let transactions = 0, versions = 0;
  const prisma = {
    chat: { findFirst: async ({ where }) => {
      queries.push(where);
      return where.id === 'chat-a' && where.userId === chatOwner ? { id: 'chat-a', title: 'QA', coworkWorkspaceId: 'workspace-a' } : null;
    } },
    coworkWorkspace: { findFirst: async ({ where }) => where.id === 'workspace-a' && where.userId === 'user-a'
      ? { id: 'workspace-a', userId: 'user-a' } : null },
    coworkFile: {
      findUnique: async ({ where, select }) => {
        const row = where.workspaceId_path ? rows.get(where.workspaceId_path.path) : [...rows.values()].find(r => r.id === where.id);
        return row ? select ? { currentVersion: row.currentVersion } : row : null;
      },
      create: async ({ data }) => {
        if (failCreate) throw new Error('Bearer database-secret Cookie=session-secret');
        const row = { ...data, id: `file-${rows.size + 1}` };
        rows.set(row.path, row); versions += 1; return row;
      },
      updateMany: async () => { throw new Error('Replay must not mutate a version'); },
    },
    coworkFileVersion: { create: async () => { throw new Error('Replay must not append a version'); } },
    $transaction: async fn => { transactions += 1; return fn(prisma); },
  };
  const storeModule = { exports: {} };
  const localReq = createRequire(storeSource);
  vm.runInNewContext(fs.readFileSync(storeSource, 'utf8'), {
    module: storeModule, exports: storeModule.exports, Buffer, console,
    process: { env: { COWORK_CONTENT_DIR: path.join(dir, 'content') }, cwd: () => dir },
    require: name => name === '../agents/task-tools' ? { ARTIFACT_DIR: artifactDir }
      : name === '../object-storage' ? { enabled: () => false, isRemote: () => false, sanitizeSegment: value => value } : localReq(name),
  }, { filename: storeSource });
  const store = storeWrap ? storeWrap(storeModule.exports) : storeModule.exports;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports,
    require: name => name === '../cowork/workspace-store' ? store : req(name) }, { filename: source });
  const base = { prisma, userId: 'user-a', chatId: 'chat-a', artifacts: [{ id, filename: '../../model-path.csv' }],
    finalMarkdown: 'Guardado en el workspace.', stoppedReason: 'finalized', emit: event => events.push(event) };
  return { events, queries, rows, stats: () => ({ transactions, versions }), run: patch => module.exports.finalizeWorkspaceDelivery({ ...base, ...patch }) };
}

test('accepted CSV is imported byte-for-byte under canonical metadata and replay adds no version', async t => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.stoppedReason, 'finalized');
  assert.equal(first.workspaceDelivery.status, 'completed');
  const file = f.rows.get('deliverables/qa.csv');
  assert.equal(file.mime, 'text/csv');
  assert.equal(file.currentVersion, 1);
  assert.equal(file.contentHash, hash(csv));
  assert.deepEqual(fs.readFileSync(file.storageRef), csv);
  assert.equal(f.events[0].file.artifactId, id);
  assert.equal(f.events[0].file.version, 1);
  const second = await f.run();
  assert.equal(second.workspaceDelivery.status, 'completed');
  assert.equal(f.rows.size, 1);
  assert.deepEqual(f.stats(), { transactions: 2, versions: 1 });
});

test('a foreign chat fails closed before an artifact can be imported', async t => {
  const f = fixture(t, { chatOwner: 'other-owner' });
  const result = await f.run();
  assert.equal(result.stoppedReason, 'control_plane_error:workspace_delivery_failed');
  assert.equal(f.rows.size, 0);
  assert.equal(f.stats().transactions, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.queries)), [{ id: 'chat-a', userId: 'user-a' }]);
});

test('artifact ownership and path containment still reject invalid sources', async t => {
  for (const options of [{ artifactOwner: 'other-owner' }, { filename: '../../outside.csv' }]) {
    const f = fixture(t, options);
    assert.equal((await f.run()).workspaceDelivery.status, 'failed');
    assert.equal(f.rows.size, 0);
  }
});

test('database failure never advertises saved content or leaks error details', async t => {
  const f = fixture(t, { failCreate: true });
  const result = await f.run();
  assert.equal(result.workspaceDelivery.status, 'failed');
  assert.match(result.finalMarkdown, /no pude guardarlo/);
  assert.doesNotMatch(JSON.stringify([result, f.events]), /database-secret|session-secret|Bearer|Cookie|Guardado en el workspace/);
  assert.equal(f.rows.size, 0);
  assert.equal(f.events.some(e => e.type === 'cowork_file_changed'), false);
});

test('already rejected, cancelled, empty or chatless turns never import', async t => {
  const f = fixture(t);
  for (const patch of [{ stoppedReason: 'verification_failed' }, { stoppedReason: 'aborted' }, { artifacts: [] }, { chatId: null }]) {
    const result = await f.run(patch);
    assert.equal(result.workspaceDelivery, null);
  }
  assert.equal(f.queries.length, 0);
  assert.equal(f.rows.size, 0);
});

test('cancellation before lookup performs no I/O', async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.stoppedReason, 'aborted');
  assert.equal(f.queries.length, 0);
  assert.equal(f.rows.size, 0);
});

test('cancellation after lookup stops before reading or saving the artifact', async t => {
  const controller = new AbortController();
  const f = fixture(t, { storeWrap: store => ({ ...store, ensureWorkspaceForChat: async (...args) => {
    const value = await store.ensureWorkspaceForChat(...args); controller.abort(); return value;
  } }) });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.stoppedReason, 'aborted');
  assert.equal(f.rows.size, 0);
});

test('cancel between files preserves only the actual completed import and reports cancellation', async t => {
  const controller = new AbortController();
  const f = fixture(t, { storeWrap: store => ({ ...store, importAgentArtifact: async (...args) => {
    const value = await store.importAgentArtifact(...args); controller.abort(); return value;
  } }) });
  const result = await f.run({ signal: controller.signal, artifacts: [{ id }, { id: secondId }] });
  assert.equal(result.stoppedReason, 'aborted');
  assert.equal(result.workspaceDelivery.imported, 1);
  assert.equal(f.rows.size, 1);
  assert.equal(f.events.filter(e => e.type === 'cowork_file_changed').length, 1);
});

test('partial batch failure is visible and does not claim transactionality for the batch', async t => {
  const f = fixture(t, { storeWrap: store => ({ ...store, importAgentArtifact: async (db, args) => {
    if (args.artifactId === secondId) throw new Error('private second file failure');
    return store.importAgentArtifact(db, args);
  } }) });
  const result = await f.run({ artifacts: [{ id }, { id: secondId }] });
  assert.equal(result.stoppedReason, 'control_plane_error:workspace_delivery_failed');
  assert.equal(result.workspaceDelivery.imported, 1);
  assert.equal(f.rows.size, 1);
  assert.equal(f.events.filter(e => e.type === 'cowork_file_changed').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private second/);
});
