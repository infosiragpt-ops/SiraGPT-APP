import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  assertInvocationLaunchable, createInvocation, reconcileValidatorOrphans,
  validateInvocationContainer, validateInvocationManifest, validatePrivateStagingRoot,
  VALIDATOR_ORPHAN_GRACE_MS, type ValidatorInvocation,
} from '../src/modules/doc-sandbox/validation/lifecycle';

/** Strict unit suite: pure snapshot parsing and actual private filesystem I/O.
 * No Docker transport, database, Redis, S3, document validator or provider is
 * replaced. Snapshot contracts do not certify Docker/gVisor isolation. The
 * reconciliation cases stop before container inspection or removal is needed.
 */
const image = `sha256:${'a'.repeat(64)}`;
const past = Date.now() - VALIDATOR_ORPHAN_GRACE_MS - 700_000;
const now = 1_800_000_000_000;

async function privateRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'validator-filesystem-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' }, 'the exact test-owned directory must be removed');
  });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal(await realpath(root), root);
  return root;
}

async function fixture(t: TestContext, createdAt = past) {
  const root = await privateRoot(t);
  const directory = path.join(root, `siragpt-validator-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, 'inputs'), { mode: 0o755 });
  await writeFile(path.join(directory, 'inputs', 'input-0.txt'), 'synthetic original', { mode: 0o444 });
  const invocation = await createInvocation(directory, { image }, createdAt);
  return { root, invocation, manifest: path.join(directory, 'invocation.json') };
}

function container(invocation: ValidatorInvocation) {
  return { id: 'b'.repeat(64), name: `/${invocation.name}`, image, runtime: 'runsc', role: 'doc-validation',
    scope: invocation.scope, invocation: invocation.invocationId, user: '65532:65532', network: 'none', readonly: true,
    mounts: [{ Type: 'bind', Source: path.join(invocation.directory, 'inputs'), Destination: '/inputs', RW: false }] };
}

// Moved unchanged from the auxiliary CLI lifecycle suite; these are pure contracts.
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

test('staging root must be canonical, absolute, private and safely representable', async t => {
  const root = await privateRoot(t);
  await validatePrivateStagingRoot(root);
  for (const unsafe of ['relative', '/', `${root}/../other`, `${root}/.`, `${root},other`, `${root}\nother`, `${root}\x7f`]) {
    await assert.rejects(validatePrivateStagingRoot(unsafe), { code: 'VALIDATOR_STAGING_UNSAFE' });
  }
  await assert.rejects(validatePrivateStagingRoot(path.join(root, 'missing')), { code: 'ENOENT' });
});

test('staging root rejects real files, symlinks and group-readable directories', async t => {
  const root = await privateRoot(t);
  const file = path.join(root, 'not-a-directory');
  const target = path.join(root, 'private');
  const alias = path.join(root, 'alias');
  await writeFile(file, 'untouched', { mode: 0o600 });
  await mkdir(target, { mode: 0o700 });
  await symlink(target, alias);
  for (const unsafe of [file, alias]) {
    await assert.rejects(validatePrivateStagingRoot(unsafe), { code: 'VALIDATOR_STAGING_UNSAFE' });
  }
  await chmod(target, 0o750);
  await assert.rejects(validatePrivateStagingRoot(target), { code: 'VALIDATOR_STAGING_UNSAFE' });
  assert.equal(await readFile(file, 'utf8'), 'untouched');
});

test('invocation manifest is owner-only and exclusively created without overwriting durable bytes', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const { directory, root: recordedRoot, ...expected } = invocation;
  assert.equal(recordedRoot, root);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected);
  assert.equal((await lstat(manifest)).mode & 0o777, 0o600);
  assert.equal((await lstat(manifest)).nlink, 1);
  assert.equal(invocation.deadlineAt, now + 300_000);
  await assert.rejects(createInvocation(directory, { image }, now + 1), { code: 'EEXIST' });
  assert.deepEqual(await readFile(manifest), bytes);
});

test('invocation creation rejects mutable images and invalid directory identities before writing', async t => {
  const root = await privateRoot(t);
  const invalid = path.join(root, 'siragpt-validator-not-a-uuid');
  const valid = path.join(root, `siragpt-validator-${randomUUID()}`);
  await mkdir(invalid, { mode: 0o700 });
  await mkdir(valid, { mode: 0o700 });
  await assert.rejects(createInvocation(invalid, { image }, now), { code: 'VALIDATOR_INVOCATION_INVALID' });
  await assert.rejects(createInvocation(valid, { image: 'mutable:latest' }, now), { code: 'VALIDATOR_INVOCATION_INVALID' });
  for (const directory of [invalid, valid]) {
    await assert.rejects(lstat(path.join(directory, 'invocation.json')), { code: 'ENOENT' });
  }
});

test('launch rechecks its durable deadline and immutable handle before admitting work', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  await assertInvocationLaunchable(invocation, invocation.deadlineAt - 1);
  await assert.rejects(assertInvocationLaunchable(invocation, invocation.deadlineAt), { code: 'VALIDATOR_INVOCATION_EXPIRED' });
  for (const changed of [{ image: `sha256:${'c'.repeat(64)}` }, { deadlineAt: invocation.deadlineAt + 1 }, { invocationId: randomUUID() }]) {
    await assert.rejects(assertInvocationLaunchable({ ...invocation, ...changed }, now), { code: 'VALIDATOR_INVOCATION_EXPIRED' });
  }
  assert.deepEqual(await readFile(manifest), bytes);
});

test('launch refuses group-readable durable manifests without altering the original', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  await chmod(manifest, 0o640);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(manifest), bytes);
});

test('launch refuses a real hardlinked manifest and preserves both links', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const alias = path.join(root, 'manifest-hardlink');
  const bytes = await readFile(manifest);
  await link(manifest, alias);
  assert.equal((await lstat(manifest)).nlink, 2);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(manifest), bytes);
  assert.deepEqual(await readFile(alias), bytes);
});

test('launch refuses a real manifest symlink without reading or changing its target', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const target = path.join(root, 'manifest-original');
  const bytes = await readFile(manifest);
  await rename(manifest, target);
  await symlink(target, manifest);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'ELOOP' });
  assert.ok((await lstat(manifest)).isSymbolicLink());
  assert.deepEqual(await readFile(target), bytes);
});

test('launch rejects oversized manifest files before accepting otherwise valid JSON', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const oversized = Buffer.concat([bytes, Buffer.alloc(4097 - bytes.length, 0x20)]);
  await writeFile(manifest, oversized);
  assert.equal((await lstat(manifest)).size, 4097);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(manifest), oversized);
});

test('launch rejects malformed JSON rather than treating it as a missing invocation', async t => {
  const { invocation, manifest } = await fixture(t, now);
  await writeFile(manifest, '{"version":');
  await assert.rejects(assertInvocationLaunchable(invocation, now), SyntaxError);
  assert.equal(await readFile(manifest, 'utf8'), '{"version":');
});

test('launch refuses a non-private invocation directory and a real directory symlink', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  await chmod(invocation.directory, 0o755);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  await chmod(invocation.directory, 0o700);
  const original = path.join(root, 'original-private-directory');
  await rename(invocation.directory, original);
  await symlink(original, invocation.directory);
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(path.join(original, 'invocation.json')), bytes);
  assert.equal(await readFile(path.join(original, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});

test('a quarantined invocation cannot launch even before its original deadline', async t => {
  const { root, invocation } = await fixture(t, now);
  const directory = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  await rename(invocation.directory, directory);
  await assert.rejects(assertInvocationLaunchable({ ...invocation, directory }, now), { code: 'VALIDATOR_INVOCATION_EXPIRED' });
  assert.equal(await readFile(path.join(directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});

test('reconciliation requires a private root and leaves unrelated real entries untouched', async t => {
  await assert.rejects(reconcileValidatorOrphans({ image }, now), { code: 'VALIDATOR_STAGING_REQUIRED' });
  const root = await privateRoot(t);
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root }, now), { examined: 0, purged: 0, pending: 0 });
  const unrelated = path.join(root, 'siragpt-validator-not-a-uuid');
  await writeFile(unrelated, 'leave this file alone', { mode: 0o600 });
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root }, now), { examined: 0, purged: 0, pending: 0 });
  assert.equal(await readFile(unrelated, 'utf8'), 'leave this file alone');
});

test('reconciliation preserves active files throughout the launch deadline plus grace', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  for (const checkpoint of [now, invocation.deadlineAt, invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS - 1]) {
    assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root }, checkpoint), { examined: 1, purged: 0, pending: 0 });
  }
  assert.deepEqual(await readFile(manifest), bytes);
  assert.equal(await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});

test('reconciliation reports a recent real quarantine as pending without consuming its files', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const directory = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  await rename(invocation.directory, directory);
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root }, invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS - 1),
    { examined: 1, purged: 0, pending: 1 });
  assert.deepEqual(await readFile(path.join(directory, 'invocation.json')), bytes);
  assert.equal(await readFile(path.join(directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});

test('reconciliation preserves invalid manifests and does not follow invocation symlinks', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  await writeFile(manifest, 'invalid json');
  const outside = await privateRoot(t);
  await writeFile(path.join(outside, 'keep'), 'untouched', { mode: 0o600 });
  const alias = path.join(root, `siragpt-validator-${randomUUID()}`);
  await symlink(outside, alias);
  assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root }, now), { examined: 2, purged: 0, pending: 2 });
  assert.equal(await readFile(manifest, 'utf8'), 'invalid json');
  assert.equal(await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
  assert.ok((await lstat(alias)).isSymbolicLink());
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
});
