import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { editPlanSchema, type EditPlan, type InputFile, type Artifact, type ValidationReport } from '../types/contracts';

const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const unitSchema = z.object({ part: z.string(), locator: z.string(), text: z.string(), kind: z.string() });
const inventorySchema = z.object({
  id: z.string(), format: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int(),
  name: z.string(), mime: z.string(), parts: z.record(z.string(), z.string()), units: z.array(unitSchema),
  warnings: z.array(z.string()), partOrder: z.array(z.string()).optional(), pages: z.number().int().optional(),
  encoding: z.string().optional(),
});
const reportSchema = z.object({
  schemaVersion: z.literal(1), passed: z.boolean(), originalSha256: z.string(), outputSha256: z.string(),
  levels: z.array(z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    passed: z.boolean(), applicable: z.boolean(), details: z.record(z.string(), z.unknown()), durationMs: z.number().nonnegative() })),
  artifactFiles: z.array(z.string()), artifactData: z.record(z.string(), z.string()), changes: z.array(z.unknown()),
});
const recipeSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(),
  expandedBytes: z.number().int().nonnegative(), scripts: z.array(z.string()).min(1), parts: z.record(z.string(), z.string()) });
const responseSchema = z.union([
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
  z.object({ ok: z.literal(true), inventories: z.array(inventorySchema) }),
  z.object({ ok: z.literal(true), report: reportSchema }),
  z.object({ ok: z.literal(true), recipe: recipeSchema }),
  z.object({ ok: z.literal(true), preflight: z.object({ schemaVersion: z.literal(1),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/), applications: z.object({
      writer: z.string().regex(/^[a-f0-9]{64}$/), calc: z.string().regex(/^[a-f0-9]{64}$/),
      impress: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict() }).strict() }),
]);

export type DocumentInventory = z.infer<typeof inventorySchema>;
export type RecipeInventory = z.infer<typeof recipeSchema>;
export interface ValidatorOptions {
  /** Immutable image reference required; no implicit pull of a mutable latest tag. */
  image: string;
  runtime?: string;
  dockerBinary?: string;
  timeoutMs?: number;
  /** Private directory mounted at the IDENTICAL absolute path in worker and Docker host. */
  stagingRoot?: string;
}
export class DocumentValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DocumentValidationError'; }
}

export function validatorContainerArguments(name: string, inputDirectory: string, artifactDirectory: string, options: ValidatorOptions): string[] {
  if (!/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(options.image)) {
    throw new DocumentValidationError('VALIDATOR_IMAGE_UNPINNED', 'La imagen del validador requiere un digest inmutable.');
  }
  if ([inputDirectory, artifactDirectory].some((directory) => !path.isAbsolute(directory) || /[\x00-\x1f\x7f,]/.test(directory))) {
    throw new DocumentValidationError('VALIDATOR_PATH_INVALID', 'Ruta temporal no válida.');
  }
  const runtime = options.runtime ?? 'runsc';
  if (runtime !== 'runsc') {
    throw new DocumentValidationError('VALIDATOR_RUNTIME_UNSAFE', 'La validación documental requiere el runtime aislado runsc.');
  }
  return ['run', '--name', name, '--pull', 'never', '--runtime', runtime,
    '--label', 'siragpt.role=doc-validation',
    '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2', '--pids-limit', '256',
    '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=262144:262144',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532,mode=0700',
    '--tmpfs', '/artifacts:rw,noexec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700',
    '--mount', `type=bind,src=${inputDirectory},dst=/inputs,readonly`,
    '--env', 'HOME=/tmp', '--env', 'LC_ALL=C.UTF-8', '--env', 'TZ=UTC',
    '-i', options.image];
}

export async function createValidatorStagingDirectory(root?: string): Promise<string> {
  if (root === undefined) return mkdtemp(path.join(tmpdir(), 'siragpt-validator-'));
  if (!path.isAbsolute(root) || root === path.parse(root).root || /[\x00-\x1f\x7f,]/.test(root) || path.normalize(root) !== root) {
    throw new DocumentValidationError('VALIDATOR_STAGING_INVALID', 'El staging debe ser una ruta absoluta privada y compartida con el host.');
  }
  const metadata = await Promise.all([lstat(root), realpath(root)]).catch(() => {
    throw new DocumentValidationError('VALIDATOR_STAGING_UNAVAILABLE', 'No está disponible el staging privado del validador.');
  });
  const [stat, canonicalRoot] = metadata;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) || canonicalRoot !== root) {
    throw new DocumentValidationError('VALIDATOR_STAGING_UNSAFE', 'El staging debe pertenecer al worker, sin enlaces ni acceso de otros usuarios.');
  }
  return mkdtemp(path.join(root, 'siragpt-validator-'));
}

async function stopContainer(binary: string, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['rm', '-f', name], { stdio: 'ignore', env: { PATH: process.env.PATH } });
    const failure = (): void => reject(new DocumentValidationError('VALIDATOR_CLEANUP_FAILED',
      `No se pudo confirmar la limpieza del validador ${name}; requiere reconciliación.`));
    const timeout = setTimeout(() => { child.kill('SIGKILL'); failure(); }, 10_000);
    child.once('error', () => { clearTimeout(timeout); failure(); });
    child.once('exit', (code) => { clearTimeout(timeout); if (code === 0) resolve(); else failure(); });
  });
}

async function runContainer(args: string[], input: unknown, options: ValidatorOptions, signal?: AbortSignal): Promise<unknown> {
  const binary = options.dockerBinary ?? 'docker';
  const name = args[args.indexOf('--name') + 1]!;
  if (signal?.aborted) throw new DocumentValidationError('E_CANCELLED', 'Validación cancelada.');
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 300_000, 1000), 600_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const fail = (code: string, message: string): void => {
        if (finished) return;
        finished = true;
        child.kill('SIGKILL');
        reject(new DocumentValidationError(code, message));
      };
      const abort = (): void => fail('E_CANCELLED', 'Validación cancelada.');
      const timer = setTimeout(() => fail('VALIDATOR_TIMEOUT', 'El validador superó su límite de tiempo.'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => {
        size += data.length;
        if (size > 32 * 1024 * 1024) { fail('VALIDATOR_OUTPUT_LIMIT', 'La salida del validador excedió el límite.'); return; }
        chunks.push(data);
      });
      // Tool output may include document text. Drain it, never forward to logs.
      child.stderr.on('data', () => undefined);
      child.once('error', () => fail('VALIDATOR_UNAVAILABLE', 'No está disponible el ejecutor aislado de validación.'));
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (finished) return;
        finished = true;
        if (code !== 0) { reject(new DocumentValidationError('VALIDATOR_RUNTIME_FAILED', 'El contenedor validador no terminó correctamente.')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new DocumentValidationError('VALIDATOR_INVALID_RESPONSE', 'El validador devolvió una respuesta inválida.')); }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    // A killed docker client does not stop its container. Remove it explicitly,
    // including on cancel, malformed output and normal completion.
    await stopContainer(binary, name);
  }
}

export function freezePlan(inputs: InputFile[], inventories: DocumentInventory[], candidate: unknown): EditPlan {
  const plan = editPlanSchema.parse(candidate);
  if (!inputs.length || plan.outputName !== inputs[0]!.name ||
      Object.keys(plan.inputHashes).length !== inputs.length || inventories.length !== inputs.length) {
    throw new DocumentValidationError('PLAN_INPUT_MISMATCH', 'El plan no identifica exactamente los archivos originales.');
  }
  for (const input of inputs) {
    const inventory = inventories.find((value) => value.id === input.id);
    if (!inventory || hash(input.data) !== input.sha256 || inventory.sha256 !== input.sha256 ||
        plan.inputHashes[input.id] !== input.sha256 || inventory.name !== input.name || inventory.format !== input.format) {
      throw new DocumentValidationError('PLAN_INPUT_MISMATCH', 'El plan no coincide con el inventario independiente.');
    }
  }
  const locators = new Set<string>();
  for (const edit of plan.edits) {
    if (edit.kind === 'text' || edit.kind === 'cell') {
      const inventory = inventories.find((value) => value.id === edit.inputId)!;
      if (edit.part === 'xl/sharedStrings.xml') throw new DocumentValidationError('SHARED_STRING_EDIT_UNSUPPORTED',
        'Las cadenas compartidas requieren validación de clonación por celda de la fase 2.');
      const unit = inventory.units.find((value) => value.part === edit.part && value.locator === edit.locator);
      const key = JSON.stringify([edit.inputId, edit.part, edit.locator]);
      if (!unit || unit.text !== edit.before || edit.before === edit.after || locators.has(key)) {
        throw new DocumentValidationError('PLAN_LOCATOR', 'Cada edición debe coincidir con una unidad exacta del original.');
      }
      locators.add(key);
    } else {
      const ids = edit.kind === 'pdf_merge' ? edit.inputIds : [edit.inputId];
      if (ids.some((id) => inventories.find((value) => value.id === id)?.format !== 'pdf')) {
        throw new DocumentValidationError('PDF_PLAN', 'Las operaciones PDF requieren originales PDF comprobados.');
      }
    }
  }
  // Clone separates this authority from the mutable model response object.
  return structuredClone(plan);
}

export class IndependentDocumentValidator {
  constructor(private readonly options: ValidatorOptions) {}

  /** Executes the real image, runsc, shared input mount and Office/PDF tools.
   * Never reaches the editor, model provider or customer documents.
   */
  async preflight(signal?: AbortSignal): Promise<void> {
    const data = Buffer.from(`SiraGPT startup probe ${randomUUID()}\n`, 'utf8');
    const input: InputFile = { id: 'startup', name: 'readiness.txt', format: 'txt',
      mime: 'text/plain', data, sha256: hash(data) };
    const { response } = await this.execute([input], { command: 'preflight' }, undefined, signal);
    if (!response.ok || !('preflight' in response) || response.preflight.inputSha256 !== input.sha256) {
      throw new DocumentValidationError('VALIDATOR_PREFLIGHT_FAILED', 'No se pudo comprobar el validador independiente.');
    }
  }

  private async execute(inputs: InputFile[], operation: Record<string, unknown>, output: Buffer | undefined, signal?: AbortSignal): Promise<{ response: z.infer<typeof responseSchema>; artifacts: Artifact[] }> {
    if (inputs.length < 1 || inputs.length > 10 || new Set(inputs.map((file) => file.id)).size !== inputs.length) {
      throw new DocumentValidationError('INPUT_LIMIT', 'Se requieren entre uno y diez archivos distintos.');
    }
    const staging = await createValidatorStagingDirectory(this.options.stagingRoot);
    const inputDirectory = path.join(staging, 'inputs');
    const artifactDirectory = path.join(staging, 'artifacts');
    try {
      await mkdir(inputDirectory, { mode: 0o755 });
      const files = [];
      for (const [index, input] of inputs.entries()) {
        if (!input.data.length || input.data.length > 50 * 1024 * 1024 || hash(input.data) !== input.sha256) {
          throw new DocumentValidationError('INPUT_HASH_OR_SIZE', 'El original no coincide con su hash o excede el límite.');
        }
        const basename = `input-${index}.${input.format}`;
        await writeFile(path.join(inputDirectory, basename), input.data, { mode: 0o444, flag: 'wx' });
        files.push({ id: input.id, path: `/inputs/${basename}`, name: input.name });
      }
      if (output) {
        if (output.length > 50 * 1024 * 1024) throw new DocumentValidationError('OUTPUT_SIZE_LIMIT', 'La salida excede el límite.');
        await writeFile(path.join(inputDirectory, 'output'), output, { mode: 0o444, flag: 'wx' });
      }
      const name = `siragpt-doc-validator-${randomUUID()}`;
      const args = validatorContainerArguments(name, inputDirectory, artifactDirectory, this.options);
      const raw = await runContainer(args, { ...operation, inputs: files, outputPath: '/inputs/output', artifactDir: '/artifacts', inlineArtifacts: true }, this.options, signal);
      const response = responseSchema.parse(raw);
      if (!response.ok) throw new DocumentValidationError(response.error.code, response.error.message);
      const artifacts: Artifact[] = [];
      let totalArtifactBytes = 0;
      const names = 'report' in response ? response.report.artifactFiles : [];
      if (names.length > 1001) throw new DocumentValidationError('ARTIFACT_LIMIT', 'Exceso de artefactos de validación.');
      for (const filename of names) {
        if (!/^(?:(?:before|after)-(?:notes-)?\d+\.png|text-diff\.json)$/.test(filename)) {
          throw new DocumentValidationError('ARTIFACT_PATH', 'Artefacto de validación inesperado.');
        }
        const encoded = 'report' in response ? response.report.artifactData[filename] : undefined;
        if (!encoded || encoded.length > 24 * 1024 * 1024 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          throw new DocumentValidationError('ARTIFACT_UNSAFE', 'Artefacto de validación inválido.');
        }
        const data = Buffer.from(encoded, 'base64');
        if (data.toString('base64') !== encoded) throw new DocumentValidationError('ARTIFACT_UNSAFE', 'Codificación de artefacto inválida.');
        totalArtifactBytes += data.length;
        if (data.length > 10 * 1024 * 1024 || totalArtifactBytes > 16 * 1024 * 1024) {
          throw new DocumentValidationError('ARTIFACT_LIMIT', 'Artefactos de validación excedieron su presupuesto total.');
        }
        artifacts.push({ name: filename, kind: filename === 'text-diff.json' ? 'text_diff' : filename.startsWith('before') ? 'thumbnail_before' : 'thumbnail_after',
          mime: filename.endsWith('.png') ? 'image/png' : 'application/json', data, sha256: hash(data) });
      }
      return { response, artifacts };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async inspect(inputs: InputFile[], signal?: AbortSignal): Promise<DocumentInventory[]> {
    const { response } = await this.execute(inputs, { command: 'inspect' }, undefined, signal);
    if (!response.ok || !('inventories' in response)) throw new DocumentValidationError('VALIDATOR_INVALID_RESPONSE', 'Falta el inventario independiente.');
    return response.inventories;
  }

  async validate(inputs: InputFile[], output: Buffer, plan: EditPlan, signal?: AbortSignal): Promise<ValidationReport> {
    const { response, artifacts } = await this.execute(inputs, { command: 'validate', plan: editPlanSchema.parse(plan) }, output, signal);
    if (!response.ok || !('report' in response)) throw new DocumentValidationError('VALIDATOR_INVALID_RESPONSE', 'Falta el reporte de validación.');
    return { passed: response.report.passed, levels: response.report.levels, originalSha256: response.report.originalSha256,
      outputSha256: response.report.outputSha256, changes: response.report.changes, artifacts };
  }

  async inspectRecipeArchive(data: Buffer, signal?: AbortSignal): Promise<RecipeInventory> {
    if (!data.length || data.length > 16 * 1024 * 1024) throw new DocumentValidationError('RECIPE_SIZE_LIMIT', 'La receta excede su límite.');
    // format only determines the private staging filename; inspect_recipe sniffs
    // the ZIP and never executes its scripts or treats it as document text.
    const input: InputFile = { id: 'recipe', name: 'recipe.zip', format: 'txt', mime: 'application/zip', data, sha256: hash(data) };
    const { response } = await this.execute([input], { command: 'inspect_recipe' }, undefined, signal);
    if (!response.ok || !('recipe' in response)) throw new DocumentValidationError('VALIDATOR_INVALID_RESPONSE', 'Falta la inspección independiente de la receta.');
    return response.recipe;
  }
}

export async function inspectRecipeArchive(data: Buffer, options: ValidatorOptions, signal?: AbortSignal): Promise<RecipeInventory> {
  return new IndependentDocumentValidator(options).inspectRecipeArchive(data, signal);
}
