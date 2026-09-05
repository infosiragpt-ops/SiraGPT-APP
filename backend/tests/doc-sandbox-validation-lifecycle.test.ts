import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertInvocationLaunchable, cleanupInvocation, createInvocation, reconcileValidatorOrphans, validateInvocationContainer,
  validateInvocationManifest, VALIDATOR_ORPHAN_GRACE_MS, type ValidatorInvocation } from '../src/modules/doc-sandbox/validation/lifecycle';

const image = `sha256:${'a'.repeat(64)}`;
const past = Date.now() - VALIDATOR_ORPHAN_GRACE_MS - 700_000;
async function fixture(t: TestContext, createdAt = past) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-lifecycle-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, `siragpt-validator-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, 'inputs'), { mode: 0o755 });
  await writeFile(path.join(directory, 'inputs', 'input-0.txt'), 'synthetic original', { mode: 0o444 });
  const invocation = await createInvocation(directory, { image }, createdAt);
  return { root, invocation };
}
function container(invocation: ValidatorInvocation) {
  return { id: 'b'.repeat(64), name: `/${invocation.name}`, image, runtime: 'runsc', role: 'doc-validation',
    scope: invocation.scope, invocation: invocation.invocationId, user: '65532:65532', network: 'none', readonly: true,
    mounts: [{ Type: 'bind', Source: path.join(invocation.directory, 'inputs'), Destination: '/inputs', RW: false }] };
}
/** Controlled CLI transport, not proof of Docker, gVisor or document fidelity. */
async function fakeDocker(root: string, row: ReturnType<typeof container> | null, failAfterRemoval = false) {
  const state = path.join(root, 'docker-state.json');
  await writeFile(state, JSON.stringify({ row, calls: [], removed: false, failAfterRemoval }));
  const binary = path.join(root, 'docker-fixture.cjs');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),file=${JSON.stringify(state)},data=JSON.parse(fs.readFileSync(file,'utf8')),args=process.argv.slice(2);
data.calls.push(args); fs.writeFileSync(file,JSON.stringify(data));
if(args[0]==='ps'){if(data.failAfterRemoval&&data.removed)process.exit(1); if(data.row)fs.writeSync(1,data.row.id+'\\n');}
else if(args[0]==='inspect'){if(!data.row||args.at(-1)!==data.row.id)process.exit(1);fs.writeSync(1,JSON.stringify(data.row)+'\\n');}
else if(args[0]==='rm'){if(!data.row||args.at(-1)!==data.row.id)process.exit(1);data.row=null;data.removed=true;fs.writeFileSync(file,JSON.stringify(data));}
else process.exit(1);
`, { mode: 0o700 });
  return { binary, state };
}

test('private manifest rejects wrong scope, name, expiry and sibling path', async t => {
  const { root, invocation } = await fixture(t);
  const raw = JSON.parse(await readFile(path.join(invocation.directory, 'invocation.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(validateInvocationManifest(raw, invocation.directory, root).invocationId, invocation.invocationId);
  for (const changed of [{ scope: 'c'.repeat(64) }, { name: 'iliagpt-backend' }, { deadlineAt: past + 700_000 }, { extra: true }]) {
    assert.throws(() => validateInvocationManifest({ ...raw, ...changed }, invocation.directory, root));
  }
  assert.throws(() => validateInvocationManifest(raw, invocation.directory, path.dirname(root)));
});
test('container removal requires exact scope, invocation, image, runtime and readonly mount', async t => {
  const { invocation } = await fixture(t); const row = container(invocation);
  assert.equal(validateInvocationContainer(row, invocation), row.id);
  for (const changed of [{ scope: 'c'.repeat(64) }, { invocation: randomUUID() }, { image: 'mutable:latest' }, { runtime: 'runc' },
    { name: '/iliagpt-backend' }, { network: 'bridge' }, { readonly: false }, { user: '0:0' },
    { mounts: [{ ...row.mounts[0], RW: true }] }, { mounts: [{ ...row.mounts[0], Source: '/unrelated' }] },
    { mounts: [...row.mounts, { Type: 'bind', Source: '/elsewhere', Destination: '/other', RW: false }] }]) {
    assert.throws(() => validateInvocationContainer({ ...row, ...changed }, invocation));
  }
});
test('expired invocation is quarantined before verified full-ID removal and proven absence', async t => {
  const { root, invocation } = await fixture(t); const { binary, state } = await fakeDocker(root, container(invocation));
  const result = await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary });
  assert.deepEqual(result, { examined: 1, purged: 1, pending: 0 });
  await assert.rejects(readFile(path.join(invocation.directory, 'inputs', 'input-0.txt')), { code: 'ENOENT' });
  const commands = JSON.parse(await readFile(state, 'utf8')) as { calls: string[][] };
  assert.deepEqual(commands.calls.find(args => args[0] === 'rm'), ['rm', '-f', 'b'.repeat(64)], JSON.stringify(commands));
  assert.equal(commands.calls.at(-1)?.[0], 'ps');
  await assert.rejects(assertInvocationLaunchable(invocation));
});
test('live deadline skips cleanup and a symlink cannot redirect deletion outside staging', async t => {
  const { root, invocation } = await fixture(t, Date.now()); const { binary, state } = await fakeDocker(root, container(invocation));
  const external = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-external-test-'));
  t.after(async () => { await rm(external, { recursive: true, force: true }); });
  await writeFile(path.join(external, 'keep'), 'untouched');
  await symlink(external, path.join(root, `siragpt-validator-${randomUUID()}`));
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary }), { examined: 2, purged: 0, pending: 1 });
  assert.equal(await readFile(path.join(external, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(JSON.parse(await readFile(state, 'utf8')).calls, []);
  await assertInvocationLaunchable(invocation);
});
test('Docker failure keeps quarantine manifest and original bytes recoverable', async t => {
  const { root, invocation } = await fixture(t);
  const result = await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: path.join(root, 'missing-docker') });
  assert.deepEqual(result, { examined: 1, purged: 0, pending: 1 });
  const retained = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  assert.equal(await readFile(path.join(retained, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
  assert.ok(await readFile(path.join(retained, 'invocation.json')));
});
test('tampered container identity is preserved and prevents staging purge', async t => {
  const { root, invocation } = await fixture(t);
  const { binary, state } = await fakeDocker(root, { ...container(invocation), role: 'other-stack' });
  assert.equal((await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary })).pending, 1);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).calls.some((args: string[]) => args[0] === 'rm'), false);
});
test('rm success without a successful absence check does not certify or purge', async t => {
  const { root, invocation } = await fixture(t); const { binary } = await fakeDocker(root, container(invocation), true);
  assert.equal((await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary })).pending, 1);
  const retained = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  assert.equal(await readFile(path.join(retained, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});
test('uncertain launch keeps its tombstone until deadline plus grace despite observed absence', async t => {
  const { root, invocation } = await fixture(t, Date.now()); const { binary } = await fakeDocker(root, null);
  assert.equal(await cleanupInvocation(invocation, { image, dockerBinary: binary }, false), false);
  await assert.rejects(assertInvocationLaunchable(invocation));
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary }),
    { examined: 1, purged: 0, pending: 1 }, 'quarantine must keep admission closed during its grace period');
  assert.equal((await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary: binary },
    invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS + 1)).purged, 1);
});
test('normal settled launch may purge immediately only after confirmed absence', async t => {
  const { root, invocation } = await fixture(t, Date.now()); const { binary } = await fakeDocker(root, null);
  assert.equal(await cleanupInvocation(invocation, { image, dockerBinary: binary }, true), true);
  await assert.rejects(readFile(path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`, 'invocation.json')), { code: 'ENOENT' });
});
