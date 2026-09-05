import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { DocumentValidationError } from './errors';

export const VALIDATOR_ORPHAN_GRACE_MS = 15 * 60_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACTIVE = new RegExp(`^siragpt-validator-(${UUID})$`);
const QUARANTINE = new RegExp(`^\\.siragpt-validator-quarantine-(${UUID})$`);
const immutableImage = /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/;
const manifestSchema = z.object({ version: z.literal(1), invocationId: z.string().regex(new RegExp(`^${UUID}$`)),
  name: z.string(), scope: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(immutableImage),
  createdAt: z.number().int().positive(), deadlineAt: z.number().int().positive(),
}).strict();
export type ValidatorInvocation = z.infer<typeof manifestSchema> & { directory: string; root: string };
export interface ValidatorLifecycleOptions { image: string; dockerBinary?: string; stagingRoot?: string; timeoutMs?: number }
export interface ValidatorReconciliation { examined: number; purged: number; pending: number }
const failure = (code: string): DocumentValidationError => new DocumentValidationError(code,
  'No se pudo confirmar la limpieza del validador aislado; los archivos privados se conservan para reconciliación.');
export const validatorScope = (root: string): string => createHash('sha256').update(root).digest('hex');
export const validatorTimeout = (options: ValidatorLifecycleOptions): number => Math.min(Math.max(options.timeoutMs ?? 300_000, 1000), 600_000);

export async function validatePrivateStagingRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root) || root === path.parse(root).root || path.normalize(root) !== root || /[\x00-\x1f\x7f,]/.test(root)) {
    throw failure('VALIDATOR_STAGING_UNSAFE');
  }
  const [stat, canonical] = await Promise.all([lstat(root), realpath(root)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) || canonical !== root) throw failure('VALIDATOR_STAGING_UNSAFE');
}
export async function createInvocation(directory: string, options: ValidatorLifecycleOptions, now = Date.now()): Promise<ValidatorInvocation> {
  const invocationId = ACTIVE.exec(path.basename(directory))?.[1];
  if (!invocationId || !immutableImage.test(options.image)) throw failure('VALIDATOR_INVOCATION_INVALID');
  const root = path.dirname(directory);
  const manifest = { version: 1 as const, invocationId, name: `siragpt-doc-validator-${invocationId}`,
    scope: validatorScope(root), image: options.image, createdAt: now, deadlineAt: now + validatorTimeout(options) };
  await writeFile(path.join(directory, 'invocation.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  return { ...manifest, directory, root };
}
export function validateInvocationManifest(raw: unknown, directory: string, root: string): ValidatorInvocation {
  const parsed = manifestSchema.safeParse(raw);
  const directoryId = (ACTIVE.exec(path.basename(directory)) || QUARANTINE.exec(path.basename(directory)))?.[1];
  if (!parsed.success || directoryId !== parsed.data.invocationId || path.dirname(directory) !== root ||
      parsed.data.scope !== validatorScope(root) || parsed.data.name !== `siragpt-doc-validator-${parsed.data.invocationId}` ||
      parsed.data.deadlineAt - parsed.data.createdAt < 1000 || parsed.data.deadlineAt - parsed.data.createdAt > 600_000) {
    throw failure('VALIDATOR_MANIFEST_INVALID');
  }
  return { ...parsed.data, root, directory };
}
async function readInvocation(directory: string, root: string): Promise<ValidatorInvocation> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) throw failure('VALIDATOR_MANIFEST_INVALID');
  const fd = await open(path.join(directory, 'invocation.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await fd.stat();
    if (!metadata.isFile() || metadata.size > 4096 || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())) throw failure('VALIDATOR_MANIFEST_INVALID');
    return validateInvocationManifest(JSON.parse(await fd.readFile('utf8')) as unknown, directory, root);
  } finally { await fd.close(); }
}
/** Rechecked immediately before Docker. A quarantined or expired invocation cannot launch. */
export async function assertInvocationLaunchable(invocation: ValidatorInvocation, now = Date.now()): Promise<void> {
  const current = await readInvocation(invocation.directory, invocation.root);
  if (current.invocationId !== invocation.invocationId || current.image !== invocation.image || current.deadlineAt !== invocation.deadlineAt ||
      now >= current.deadlineAt || !ACTIVE.test(path.basename(current.directory))) throw failure('VALIDATOR_INVOCATION_EXPIRED');
}
function dockerCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    const buffers: Buffer[] = []; let bytes = 0; let finished = false;
    const fail = (): void => { if (finished) return; finished = true; child.kill('SIGKILL'); reject(failure('VALIDATOR_CLEANUP_UNAVAILABLE')); };
    const timeout = setTimeout(fail, 10_000);
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) fail(); else buffers.push(data); });
    child.stderr.on('data', () => undefined);
    child.once('error', fail);
    child.once('close', code => { clearTimeout(timeout); if (finished) return; finished = true;
      if (code !== 0) reject(failure('VALIDATOR_CLEANUP_UNAVAILABLE')); else resolve(Buffer.concat(buffers).toString('utf8').trim()); });
  });
}
const snapshotSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), image: z.string(), runtime: z.string(),
  role: z.string().nullable(), scope: z.string().nullable(), invocation: z.string().nullable(), user: z.string(),
  network: z.string(), readonly: z.boolean(), mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(),
    Destination: z.string(), RW: z.boolean().optional() }).passthrough()),
}).strict();
export function validateInvocationContainer(raw: unknown, invocation: ValidatorInvocation): string {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw failure('VALIDATOR_CONTAINER_IDENTITY_MISMATCH');
  const c = parsed.data; const binds = c.mounts.filter(mount => mount.Type === 'bind');
  const source = path.join(invocation.root, `siragpt-validator-${invocation.invocationId}`, 'inputs');
  if (c.name !== `/${invocation.name}` || c.image !== invocation.image || c.runtime !== 'runsc' ||
      c.role !== 'doc-validation' || c.scope !== invocation.scope || c.invocation !== invocation.invocationId ||
      c.user !== '65532:65532' || c.network !== 'none' || !c.readonly || binds.length !== 1 ||
      binds[0]?.Source !== source || binds[0]?.Destination !== '/inputs' || binds[0]?.RW !== false) {
    throw failure('VALIDATOR_CONTAINER_IDENTITY_MISMATCH');
  }
  return c.id;
}
async function matchingContainerIds(invocation: ValidatorInvocation, binary: string): Promise<string[]> {
  // An exact name lookup also notices a collision with altered/missing labels.
  const output = await dockerCommand(binary, ['ps', '-a', '--no-trunc', '--filter', `name=^/${invocation.name}$`, '--format', '{{.ID}}']);
  const ids = output.split('\n').filter(Boolean);
  if (ids.length > 1 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw failure('VALIDATOR_CONTAINER_IDENTITY_MISMATCH');
  return ids;
}
async function removeAndConfirmContainer(invocation: ValidatorInvocation, binary: string): Promise<void> {
  const ids = await matchingContainerIds(invocation, binary);
  for (const id of ids) {
    const output = await dockerCommand(binary, ['inspect', '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"runtime":{{json .HostConfig.Runtime}},"role":{{json (index .Config.Labels "siragpt.role")}},"scope":{{json (index .Config.Labels "siragpt.validation.scope")}},"invocation":{{json (index .Config.Labels "siragpt.validation.invocation")}},"user":{{json .Config.User}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}}}', id]);
    if (validateInvocationContainer(JSON.parse(output) as unknown, invocation) !== id) throw failure('VALIDATOR_CONTAINER_IDENTITY_MISMATCH');
    await dockerCommand(binary, ['rm', '-f', id]);
  }
  if ((await matchingContainerIds(invocation, binary)).length !== 0) throw failure('VALIDATOR_CLEANUP_NOT_CONFIRMED');
}
async function quarantineInvocation(invocation: ValidatorInvocation): Promise<ValidatorInvocation> {
  const target = path.join(invocation.root, `.siragpt-validator-quarantine-${invocation.invocationId}`);
  if (invocation.directory !== target) {
    await rename(invocation.directory, target);
  }
  return readInvocation(target, invocation.root);
}
/** Successful Docker completion permits immediate cleanup. A killed/unknown
 * launch retains its quarantine through the deadline + grace, even after one
 * successful absence check. New workers can then retry using this manifest.
 */
export async function cleanupInvocation(invocation: ValidatorInvocation, options: ValidatorLifecycleOptions,
  launchSettled: boolean, now = Date.now()): Promise<boolean> {
  const quarantined = await quarantineInvocation(invocation);
  await removeAndConfirmContainer(quarantined, options.dockerBinary ?? 'docker');
  if (!launchSettled && now < quarantined.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS) return false;
  // Only the exact invocation directory is removable; never a root or prefix.
  const final = await readInvocation(quarantined.directory, quarantined.root);
  if (final.invocationId !== quarantined.invocationId || final.scope !== quarantined.scope || final.image !== quarantined.image) {
    throw failure('VALIDATOR_MANIFEST_CHANGED');
  }
  await rm(quarantined.directory, { recursive: true, force: false });
  return true;
}
export async function reconcileValidatorOrphans(options: ValidatorLifecycleOptions, now = Date.now()): Promise<ValidatorReconciliation> {
  if (!options.stagingRoot) throw failure('VALIDATOR_STAGING_REQUIRED');
  await validatePrivateStagingRoot(options.stagingRoot);
  const result = { examined: 0, purged: 0, pending: 0 };
  const entries = await readdir(options.stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!ACTIVE.test(entry.name) && !QUARANTINE.test(entry.name)) continue;
    result.examined += 1;
    try {
      const invocation = await readInvocation(path.join(options.stagingRoot, entry.name), options.stagingRoot);
      if (now < invocation.deadlineAt + VALIDATOR_ORPHAN_GRACE_MS) {
        // Active invocations may still belong to a live worker. Quarantine,
        // however, records an uncertain launch and must keep admission closed
        // until the grace period and confirmed cleanup have both completed.
        if (QUARANTINE.test(entry.name)) result.pending += 1;
        continue;
      }
      if (await cleanupInvocation(invocation, options, false, now)) result.purged += 1;
      else result.pending += 1;
    } catch { result.pending += 1; }
  }
  return result;
}

export const newValidatorInvocationId = (): string => randomUUID();
