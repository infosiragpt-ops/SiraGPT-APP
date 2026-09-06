import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertInvocationLaunchable, cleanupInvocation, createInvocation, reconcileValidatorOrphans,
  validateInvocationContainer, validateInvocationManifest, validatePrivateStagingRoot,
  VALIDATOR_ORPHAN_GRACE_MS, type ValidatorInvocation,
} from '../src/modules/doc-sandbox/validation/lifecycle';
import { createValidatorStagingDirectory, IndependentDocumentValidator, inspectRecipeArchive } from '../src/modules/doc-sandbox/validation/index';
import type { EditPlan, InputFile } from '../src/modules/doc-sandbox/types/contracts';
import { DocumentValidationError } from '../src/modules/doc-sandbox/validation/errors';

/** Strict unit suite: pure snapshot parsing and actual private filesystem I/O.
 * No Docker transport, database, Redis, S3, document validator or provider is
 * replaced. Snapshot contracts do not certify Docker/gVisor isolation.
 * Cleanup failure cases additionally exercise actual spawn ENOENT against an
 * absent path inside the private fixture, never a substitute Docker executable.
 * They retain quarantine, not proof of container inspection or removal.
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

test('cancellation during the real manifest read cannot admit a validator launch', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const controller = new AbortController();
  assert.equal(controller.signal.aborted, false);
  // readInvocation has already started its real asynchronous lstat. No timer,
  // filesystem replacement or Docker transport is needed to hit this window.
  const admission = assertInvocationLaunchable(invocation, now, controller.signal);
  controller.abort(new Error('synthetic cancellation reason must stay private'));
  await assert.rejects(admission, { name: 'DocumentValidationError', code: 'E_CANCELLED', message: 'Validación cancelada.' });
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await readFile(manifest), bytes);
  assert.equal(await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});

test('an already cancelled admission returns the stable cancellation code without exposing its reason', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const signal = AbortSignal.abort(new Error('synthetic private abort reason'));
  await assert.rejects(assertInvocationLaunchable(invocation, now, signal),
    { name: 'DocumentValidationError', code: 'E_CANCELLED', message: 'Validación cancelada.' });
  assert.deepEqual(await readFile(manifest), bytes);
});

test('a live abort signal preserves manifest identity and expiration errors', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const signal = new AbortController().signal;
  const bytes = await readFile(manifest);
  await assertInvocationLaunchable(invocation, now, signal);
  await assert.rejects(assertInvocationLaunchable(invocation, invocation.deadlineAt, signal),
    { code: 'VALIDATOR_INVOCATION_EXPIRED' });
  await chmod(manifest, 0o640);
  await assert.rejects(assertInvocationLaunchable(invocation, now, signal),
    { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(manifest), bytes);
  assert.equal(signal.aborted, false);
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

for (const launchSettled of [true, false]) {
  test(`cleanup spawn ENOENT preserves the exact private quarantine (launchSettled=${launchSettled})`, async t => {
    const { root, invocation, manifest } = await fixture(t, now);
    const manifestBytes = await readFile(manifest);
    const originalBytes = await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'));
    const neighbor = path.join(root, 'unrelated-private-original.txt');
    await writeFile(neighbor, 'unrelated synthetic original', { mode: 0o600 });
    const dockerBinary = path.join(root, 'absent-docker-executable');
    await assert.rejects(lstat(dockerBinary), { code: 'ENOENT' });
    const quarantine = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
    const rejectsUnavailable = (error: unknown): boolean => {
      assert.ok(error instanceof DocumentValidationError);
      assert.equal(error.code, 'VALIDATOR_CLEANUP_UNAVAILABLE');
      assert.equal(error.message.includes(root), false, 'The private filesystem path must not reach the public error');
      assert.equal(error.message.includes('ENOENT'), false, 'The raw spawn error must remain private');
      return true;
    };
    await assert.rejects(cleanupInvocation(invocation, { image, dockerBinary }, launchSettled, now), rejectsUnavailable);
    await assert.rejects(lstat(invocation.directory), { code: 'ENOENT' });
    assert.equal((await lstat(quarantine)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(quarantine, 'invocation.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(path.join(quarantine, 'invocation.json')), manifestBytes);
    assert.deepEqual(await readFile(path.join(quarantine, 'inputs', 'input-0.txt')), originalBytes);

    // A retry reads the real quarantined manifest and cannot create another
    // generation, report successful removal or make the invocation launchable.
    const retained = validateInvocationManifest(JSON.parse(manifestBytes.toString('utf8')), quarantine, root);
    await assert.rejects(cleanupInvocation(retained, { image, dockerBinary }, launchSettled, now), rejectsUnavailable);
    await assert.rejects(assertInvocationLaunchable(retained, now), { code: 'VALIDATOR_INVOCATION_EXPIRED' });
    assert.deepEqual((await readdir(root)).sort(), [path.basename(quarantine), path.basename(neighbor)].sort());
    assert.deepEqual(await readFile(path.join(quarantine, 'invocation.json')), manifestBytes);
    assert.deepEqual(await readFile(path.join(quarantine, 'inputs', 'input-0.txt')), originalBytes);
    assert.equal(await readFile(neighbor, 'utf8'), 'unrelated synthetic original');
    await assert.rejects(lstat(dockerBinary), { code: 'ENOENT' });
  });
}

test('reconciliation spawn ENOENT keeps an expired invocation pending across retries', async t => {
  const { root, invocation, manifest } = await fixture(t, now);
  const manifestBytes = await readFile(manifest);
  const originalBytes = await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'));
  const neighbor = path.join(root, 'unrelated-private-original.txt');
  await writeFile(neighbor, 'untouched neighbor', { mode: 0o600 });
  const dockerBinary = path.join(root, 'absent-docker-executable');
  await assert.rejects(lstat(dockerBinary), { code: 'ENOENT' });
  const quarantine = path.join(root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  for (const checkpoint of [invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS,
    invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS + 1]) {
    assert.deepEqual(await reconcileValidatorOrphans({ image, stagingRoot: root, dockerBinary }, checkpoint),
      { examined: 1, purged: 0, pending: 1 });
    await assert.rejects(lstat(invocation.directory), { code: 'ENOENT' });
    assert.deepEqual((await readdir(root)).sort(), [path.basename(quarantine), path.basename(neighbor)].sort());
    assert.equal((await lstat(quarantine)).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(path.join(quarantine, 'invocation.json')), manifestBytes);
    assert.deepEqual(await readFile(path.join(quarantine, 'inputs', 'input-0.txt')), originalBytes);
    assert.equal(await readFile(neighbor, 'utf8'), 'untouched neighbor');
  }
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

test('concurrent staging allocation creates ten distinct private directories under the exact root', async t => {
  const root = await privateRoot(t);
  const directories = await Promise.all(Array.from({ length: 10 }, () => createValidatorStagingDirectory(root)));
  assert.equal(new Set(directories).size, 10);
  for (const directory of directories) {
    assert.equal(path.dirname(directory), root);
    assert.match(path.basename(directory), /^siragpt-validator-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(await realpath(directory), directory);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(directory), []);
  }
  assert.deepEqual((await readdir(root)).sort(), directories.map(directory => path.basename(directory)).sort());
});

test('default staging is canonical and private and its exact directory is removable', async t => {
  const directory = await createValidatorStagingDirectory();
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  });
  assert.equal(path.dirname(directory), await realpath(tmpdir()));
  assert.equal(await realpath(directory), directory);
  assert.match(path.basename(directory), /^siragpt-validator-[0-9a-f-]{36}$/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), []);
});

test('staging allocation refuses files and ancestor symlinks without creating a child', async t => {
  const root = await privateRoot(t);
  const file = path.join(root, 'file');
  await writeFile(file, 'unchanged', { mode: 0o600 });
  await assert.rejects(createValidatorStagingDirectory(file), { code: 'VALIDATOR_STAGING_UNSAFE' });
  const privateDirectory = path.join(root, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const alias = path.join(root, 'alias');
  await symlink(root, alias);
  await assert.rejects(createValidatorStagingDirectory(path.join(alias, 'private')), { code: 'VALIDATOR_STAGING_UNSAFE' });
  assert.deepEqual(await readdir(privateDirectory), []);
  assert.equal(await readFile(file, 'utf8'), 'unchanged');
});

test('concurrent invocation creation has exactly one winner and retains that winner manifest', async t => {
  const root = await privateRoot(t);
  const directory = await createValidatorStagingDirectory(root);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => createInvocation(directory, { image }, now + index)));
  const winners = results.filter((result): result is PromiseFulfilledResult<ValidatorInvocation> => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.equal((result.reason as NodeJS.ErrnoException).code, 'EEXIST');
  }
  const { directory: winnerDirectory, root: winnerRoot, ...manifest } = winners[0]!.value;
  assert.equal(winnerDirectory, directory);
  assert.equal(winnerRoot, root);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'invocation.json'), 'utf8')), manifest);
  assert.equal((await lstat(path.join(directory, 'invocation.json'))).mode & 0o777, 0o600);
});

test('durable invocation lifetimes enforce both timeout bounds without altering input options', async t => {
  const root = await privateRoot(t);
  for (const [timeoutMs, duration] of [[-1, 1000], [0, 1000], [1000, 1000], [300_000, 300_000], [600_000, 600_000], [600_001, 600_000]]) {
    const directory = await createValidatorStagingDirectory(root);
    const options = { image, timeoutMs };
    const invocation = await createInvocation(directory, options, now);
    assert.equal(invocation.deadlineAt - invocation.createdAt, duration);
    assert.equal(options.timeoutMs, timeoutMs);
    await assertInvocationLaunchable(invocation, invocation.deadlineAt - 1);
    await assert.rejects(assertInvocationLaunchable(invocation, invocation.deadlineAt), { code: 'VALIDATOR_INVOCATION_EXPIRED' });
  }
});

test('manifest byte budget accepts exactly 4096 bytes but refuses a directory in place of the file', async t => {
  const { invocation, manifest } = await fixture(t, now);
  const bytes = await readFile(manifest);
  const padded = Buffer.concat([bytes, Buffer.alloc(4096 - bytes.length, 0x20)]);
  await writeFile(manifest, padded);
  await assertInvocationLaunchable(invocation, now);
  assert.deepEqual(await readFile(manifest), padded);
  const retained = path.join(invocation.directory, 'retained-manifest');
  await rename(manifest, retained);
  await mkdir(manifest, { mode: 0o700 });
  await assert.rejects(assertInvocationLaunchable(invocation, now), { code: 'VALIDATOR_MANIFEST_INVALID' });
  assert.deepEqual(await readFile(retained), padded);
});

function original(id = 'one', data = Buffer.from('synthetic private original')): InputFile {
  return { id, name: `${id}.txt`, format: 'txt', mime: 'text/plain', data,
    sha256: createHash('sha256').update(data).digest('hex') };
}

function noChangePlan(input: InputFile): EditPlan {
  return { schemaVersion: 1, mode: 'preserve', outputName: input.name,
    inputHashes: { [input.id]: input.sha256 }, edits: [], notPossible: [] };
}

// These tests exercise the actual validator's pre-launch guards and filesystem
// cleanup. They do not return fabricated inventories/reports or run a container.
test('input count and duplicate IDs fail before any staging directory is created', async t => {
  const root = await privateRoot(t);
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  const file = original();
  for (const files of [[], [file, { ...file }], Array.from({ length: 11 }, (_, index) => original(`file-${index}`))]) {
    await assert.rejects(validator.inspect(files), { code: 'INPUT_LIMIT' });
    assert.deepEqual(await readdir(root), []);
  }
});

test('empty and hash-mismatched originals are rejected and their private staging is removed', async t => {
  const root = await privateRoot(t);
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  const valid = original();
  for (const file of [original('empty', Buffer.alloc(0)), { ...valid, sha256: '0'.repeat(64) }]) {
    const bytes = Buffer.from(file.data);
    await assert.rejects(validator.inspect([file]), { code: 'INPUT_HASH_OR_SIZE' });
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(file.data, bytes);
  }
});

test('an original larger than 50 MiB fails before document processing and leaves no staging', async t => {
  const root = await privateRoot(t);
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  const file = original('oversized', Buffer.alloc(50 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(validator.inspect([file]), { code: 'INPUT_HASH_OR_SIZE' });
  assert.deepEqual(await readdir(root), []);
  assert.equal(createHash('sha256').update(file.data).digest('hex'), file.sha256);
});

test('failure after staging an earlier input removes only its invocation and preserves neighboring originals', async t => {
  const root = await privateRoot(t);
  const sentinel = path.join(root, 'do-not-delete');
  await writeFile(sentinel, 'neighbor original', { mode: 0o600 });
  const first = original('first');
  const second = { ...original('second'), sha256: '0'.repeat(64) };
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  await assert.rejects(validator.inspect([first, second]), { code: 'INPUT_HASH_OR_SIZE' });
  assert.deepEqual(await readdir(root), ['do-not-delete']);
  assert.equal(await readFile(sentinel, 'utf8'), 'neighbor original');
  for (const file of [first, second]) assert.equal(file.data.toString('utf8'), 'synthetic private original');
});

test('pre-launch runtime rejection cannot use an original display name as a filesystem path', async t => {
  const root = await privateRoot(t);
  const sentinel = path.join(root, 'keep.txt');
  await writeFile(sentinel, 'outside the invocation', { mode: 0o600 });
  const validator = new IndependentDocumentValidator({ image, runtime: 'runc', stagingRoot: root });
  const file = { ...original(), name: '../../keep.txt' };
  await assert.rejects(validator.inspect([file]), { code: 'VALIDATOR_RUNTIME_UNSAFE' });
  assert.deepEqual(await readdir(root), ['keep.txt']);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside the invocation');
  assert.equal(createHash('sha256').update(file.data).digest('hex'), file.sha256);
});

test('an oversized output is refused before launch and preserves the original', async t => {
  const root = await privateRoot(t);
  const file = original();
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  await assert.rejects(validator.validate([file], Buffer.alloc(50 * 1024 * 1024 + 1), noChangePlan(file)), { code: 'OUTPUT_SIZE_LIMIT' });
  assert.deepEqual(await readdir(root), []);
  assert.equal(createHash('sha256').update(file.data).digest('hex'), file.sha256);
});

test('valid-sized output still requires the safe runtime and is removed after pre-launch rejection', async t => {
  const root = await privateRoot(t);
  const file = original();
  const validator = new IndependentDocumentValidator({ image, runtime: 'runc', stagingRoot: root });
  const output = Buffer.from(file.data);
  await assert.rejects(validator.validate([file], output, noChangePlan(file)), { code: 'VALIDATOR_RUNTIME_UNSAFE' });
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(output, file.data);
});

test('recipe byte limits reject empty and oversized buffers before staging through both public entrypoints', async t => {
  const root = await privateRoot(t);
  const options = { image, stagingRoot: root };
  const validator = new IndependentDocumentValidator(options);
  await assert.rejects(validator.inspectRecipeArchive(Buffer.alloc(0)), { code: 'RECIPE_SIZE_LIMIT' });
  await assert.rejects(inspectRecipeArchive(Buffer.alloc(16 * 1024 * 1024 + 1), options), { code: 'RECIPE_SIZE_LIMIT' });
  assert.deepEqual(await readdir(root), []);
});

test('preflight refuses unreadable orphan metadata and does not manufacture readiness', async t => {
  const { root, invocation, manifest } = await fixture(t);
  await writeFile(manifest, 'invalid json');
  const validator = new IndependentDocumentValidator({ image, stagingRoot: root });
  assert.deepEqual(await validator.reconcileOrphans(), { examined: 1, purged: 0, pending: 1 });
  await assert.rejects(validator.preflight(), { code: 'VALIDATOR_CLEANUP_PENDING' });
  assert.deepEqual(await readdir(root), [path.basename(invocation.directory)]);
  assert.equal(await readFile(manifest, 'utf8'), 'invalid json');
  assert.equal(await readFile(path.join(invocation.directory, 'inputs', 'input-0.txt'), 'utf8'), 'synthetic original');
});
